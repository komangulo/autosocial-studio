const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright");
const { DateTime } = require("luxon");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
  requireAccount,
} = require("./account-manager");
const {
  openOnboardingTabs,
  waitForTempMailCredentials,
} = require("./temp-mail");

let loginSessionContext = null;
let loginSessionAccountId = null;
let tempMailSetupPage = null;
let tempMailCaptureHandler = null;
let tempMailSetupState = {
  accountId: null,
  open: false,
  stage: "idle",
  message: "No temporary email setup is running.",
  email: "",
  startedAt: null,
  completedAt: null,
};

/**
 * // MARKER: TIKTOK-PROFILE-RELEASE-v1
 * Abre el perfil persistente de la cuenta esperando a que Chrome lo libere.
 * Windows no suelta el --user-data-dir de inmediato tras cerrarse: si se lanza
 * otro proceso sobre el mismo perfil, falla con exitCode=21. Aqui limpiamos
 * candados huerfanos y reintentamos; si sigue ocupado de verdad, abortamos con
 * un mensaje claro en vez de dejar caer todo el lote.
 */
async function openContextWithRetry(accountId, maxMs = 30000) {
  const fsSync = require("fs");
  const profileDir = await getPlatformProfileDir("tiktok", accountId);
  await fs.mkdir(profileDir, { recursive: true });

  const options = {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  const tryLaunch = async (opts) => chromium.launchPersistentContext(profileDir, opts);

  const deadline = Date.now() + maxMs;
  let announced = false;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fsSync.rmSync(path.join(profileDir, lock), { force: true });
      } catch {
        // En Windows el candado puede estar en uso: no es fatal, lo ignora.
      }
    }
    try {
      return await tryLaunch(options);
    } catch (error) {
      lastError = error;
      // Un navegador del sistema puede salvar el caso de Chromium no instalado.
      const candidates = process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
      const chrome = candidates.find((c) => c && fsSync.existsSync(c));
      if (chrome) {
        try {
          return await tryLaunch({ ...options, executablePath: chrome });
        } catch (error2) {
          lastError = error2;
        }
      }
      if (!announced) {
        console.log("El perfil de TikTok esta ocupado; esperando a que Chrome lo libere...");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new Error(
    "No se pudo abrir el perfil de TikTok: sigue en uso por otro proceso. " +
    "Cierra TODAS las ventanas de Chrome (taskkill /F /IM chrome.exe /T) " +
    "y vuelve a lanzar la subida. Detalle: " +
    (lastError ? lastError.message : "desconocido")
  );
}

async function openPersistentContext(accountId) {
  const profileDir = await getPlatformProfileDir("tiktok", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  const options = {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launchPersistentContext(profileDir, options);
  } catch (error) {
    // Fall back to a system Chrome/Chromium when Playwright's bundled browser
    // is not installed, so login still opens a real window.
    const fsSync = require("fs");
    const candidates = process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
    const chrome = candidates.find((candidate) => candidate && fsSync.existsSync(candidate));
    if (!chrome) throw error;
    return chromium.launchPersistentContext(profileDir, { ...options, executablePath: chrome });
  }
}

async function gotoUploadPage(page) {
  await page.goto(config.uploadPageUrl, { waitUntil: "domcontentloaded" });
}

async function setVideoFile(page, videoPath) {
  // MARKER: TIKTOK-UPLOAD-ROBUST-v1
  const absolute = path.resolve(videoPath);
  const deadline = Date.now() + 120000;

  const isLoginWall = async () => {
    try {
      const url = page.url();
      return /\/login|\/signup|accounts\.tiktok|tiktok\.com\/login/i.test(url);
    } catch { return false; }
  };

  const findInput = async () => {
    const selectors = [
      'input[type="file"][accept*="video" i]',
      'input[type="file"][accept*=".mp4" i]',
      'input[type="file"][accept*="mp4" i]',
      'input[type="file"]',
    ];
    // Busca en la pagina principal y tambien dentro de iframes (TikTok Studio
    // puede montar el cargador en un frame aparte).
    const scopes = [page];
    for (const frame of page.frames ? page.frames() : []) {
      if (frame && frame !== page.mainFrame?.()) scopes.push(frame);
    }
    for (const scope of scopes) {
      for (const selector of selectors) {
        const locator = scope.locator(selector).first();
        if (await locator.count().catch(() => 0) > 0) return locator;
      }
    }
    return null;
  };

  let reloaded = false;
  let lastError = null;
  while (Date.now() < deadline) {
    if (await isLoginWall()) {
      throw new Error(
        "La sesion de TikTok no esta activa (TikTok pidio iniciar sesion). " +
        "Abre el login de TikTok para esta cuenta, inicia sesion y vuelve a intentarlo."
      );
    }

    const input = await findInput();
    if (input) {
      try {
        await input.waitFor({ state: "attached", timeout: 5000 });
        await input.setInputFiles(absolute);
        console.log(`TikTok upload file selected: ${absolute}`);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 2500 }),
        (async () => {
          const trigger = page
            .getByRole("button", { name: /select|upload|choose|subir|seleccionar|elegir/i })
            .first();
          if (await trigger.count().catch(() => 0) > 0) {
            await trigger.click({ timeout: 2000 }).catch(() => {});
          }
        })(),
      ]);
      await chooser.setFiles(absolute);
      console.log(`TikTok upload file selected via file chooser: ${absolute}`);
      return;
    } catch {
      // Sin dialogo; seguimos esperando.
    }

    if (!reloaded && Date.now() > deadline - 95000) {
      reloaded = true;
      console.log("TikTok: no aparecio el input de video; recargando la pagina una vez...");
      await gotoUploadPage(page).catch(() => {});
    }

    await page.waitForTimeout(1000);
  }

  const hint = lastError ? ` Ultimo detalle: ${lastError.message}` : "";
  throw new Error(
    "No se encontro el campo de subida de video de TikTok tras esperar 2 minutos." + hint +
    " Comprueba que la sesion de TikTok esta iniciada y que la pagina de subida carga bien."
  );
}

/** Upload and confirm a custom TikTok cover when Auto Clone provided one. */
async function setTikTokCover(page, coverPath) {
  if (!coverPath) return false;
  const absoluteCoverPath = path.resolve(coverPath);
  const editCandidates = [
    page.getByRole("button", { name: /^(edit cover|editar portada)$/i }).first(),
    page.locator('button:has-text("Edit cover"), button:has-text("Editar portada")').first(),
    page.locator('[role="button"]:has-text("Edit cover"), [role="button"]:has-text("Editar portada")').first(),
  ];
  let editButton = null;
  for (const candidate of editCandidates) {
    if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
      editButton = candidate;
      break;
    }
  }
  if (!editButton) throw new Error("No se encontró el botón Edit cover de TikTok.");
  await editButton.click({ timeout: 10000 });
  await page.waitForTimeout(500);

  const dialogCandidates = [
    page.locator('[role="dialog"]:visible').last(),
    page.locator('[class*="modal" i]:visible').last(),
  ];
  let scope = page;
  for (const candidate of dialogCandidates) {
    if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
      scope = candidate;
      break;
    }
  }

  const uploadCandidates = [
    scope.getByRole("button", { name: /^(upload cover|subir portada|select a file|seleccionar archivo)$/i }).first(),
    scope.locator('button:has-text("Upload cover"), button:has-text("Subir portada"), button:has-text("Select a file")').first(),
    scope.locator('[role="button"]:has-text("Upload cover"), [role="button"]:has-text("Subir portada")').first(),
  ];
  for (const candidate of uploadCandidates) {
    if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
      await candidate.click({ timeout: 10000 });
      await page.waitForTimeout(300);
      break;
    }
  }

  const fileInputs = page.locator('input[type="file"]');
  let imageInput = null;
  for (let index = await fileInputs.count() - 1; index >= 0; index -= 1) {
    const candidate = fileInputs.nth(index);
    const accept = String(await candidate.getAttribute("accept").catch(() => "") || "").toLowerCase();
    if (accept.includes("video")) continue;
    if (accept.includes("image") || !accept) {
      imageInput = candidate;
      break;
    }
  }
  if (!imageInput) throw new Error("No se encontró el campo para subir la portada de TikTok.");
  await imageInput.setInputFiles(absoluteCoverPath);
  await page.waitForTimeout(700);

  const confirmCandidates = [
    scope.getByRole("button", { name: /^(confirm|done|apply|save|confirmar|listo|guardar)$/i }).first(),
    scope.locator('button:has-text("Confirm"), button:has-text("Done"), button:has-text("Apply"), button:has-text("Confirmar"), button:has-text("Listo")').first(),
  ];
  let confirmButton = null;
  for (const candidate of confirmCandidates) {
    if (await candidate.count() > 0 && await candidate.isVisible().catch(() => false)) {
      confirmButton = candidate;
      break;
    }
  }
  if (!confirmButton) throw new Error("No se encontró el botón para confirmar la portada de TikTok.");
  await confirmButton.click({ timeout: 10000 });
  await page.waitForTimeout(500);
  return true;
}

async function setCaption(page, caption) {
  if (!caption) {
    return;
  }

  const candidates = [
    'div[contenteditable="true"]',
    'textarea[placeholder*="caption" i]',
    'textarea',
  ];

  for (const selector of candidates) {
    const target = page.locator(selector).first();
    const count = await target.count();
    if (count === 0) {
      continue;
    }

    try {
      await target.click({ timeout: 8000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await target.type(caption, { delay: 10 });
      return;
    } catch {
      // Try the next candidate selector.
    }
  }

  throw new Error("Could not find caption input field.");
}

/**
 * Fill TikTok's "Location" field. The real form has a search box placeholder
 * "Search locations"; typing a name opens a suggestion list and we click the
 * matching option. `location` is a single string such as "Madrid, Spain".
 */
async function setLocation(page, location) {
  const rawQuery = String(location || "").trim();
  if (!rawQuery) return false;
  // TikTok a veces sugiere "MadridMadrid, Spain" al buscar "Madrid, Spain":
  // se teclea la ciudad y su propio nombre vuelve duplicado. Enviar solo la
  // ciudad evita la duplicacion; el pais lo resuelve la propia sugerencia.
  const query = rawQuery.includes(",") ? rawQuery.split(",")[0].trim() : rawQuery;

  // Open the location search box.
  const searchCandidates = [
    'input[placeholder*="search location" i]',
    'input[placeholder*="location" i]',
    '[role="dialog"] input[type="text"]',
  ];

  let box = null;
  for (const selector of searchCandidates) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
      box = candidate;
      break;
    }
  }
  if (!box) {
    console.log("Location field not found; skipping location.");
    return false;
  }

  try {
    await box.click({ timeout: 8000 });
    await box.fill("");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await box.type(query, { delay: 40 });
    await page.waitForTimeout(1200);

    // Prefer an option whose text matches the requested place, else the first one.
    const chosen = await page.evaluate((wanted) => {
      const norm = (v) => (v || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wantedNorm = norm(wanted);
      // TikTok may localize the country ("Madrid, Spain" vs "Madrid, Espana").
      const aliases = { spain: "espa", espana: "espa", es: "espa" };
      const wantedParts = wantedNorm.split(",").map((p) => p.trim()).filter(Boolean)
        .map((p) => aliases[p] || p);
      const optionSelectors = [
        '[role="option"]',
        '[role="listbox"] li',
        'li[class*="option" i]',
        '[class*="suggest" i] li',
        '[class*="option" i]',
      ];
      const seen = new Set();
      const options = [];
      for (const selector of optionSelectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (el.offsetParent === null) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (seen.has(el)) continue;
          seen.add(el);
          options.push(el);
        }
      }
      const pick = options.find((el) => norm(el.textContent) === wantedNorm)
        || options.find((el) => norm(el.textContent).includes(wantedNorm))
        || options.find((el) => {
          const text = norm(el.textContent);
          return wantedParts.length > 0 && wantedParts.every((p) => text.includes(p));
        })
        || options.find((el) => {
          // Last resort: match the first word (the city), keep country flexible.
          const city = wantedParts[0];
          return city && norm(el.textContent).startsWith(city);
        })
        || options[0];
      if (!pick) return null;
      const rect = pick.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (pick.textContent || "").trim() };
    }, query);

    if (!chosen) {
      console.log(`No location suggestion found for "${query}".`);
      return false;
    }
    await page.mouse.click(chosen.x, chosen.y);
    await page.waitForTimeout(800);
    console.log(`Location set to "${chosen.text}" (requested "${query}").`);
    return true;
  } catch (error) {
    console.log(`Location step failed softly: ${error.message}`);
    return false;
  }
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  if (total === 0) {
    return false;
  }

  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) {
      continue;
    }

    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(250);
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // Continue to next candidate.
      }
    }
  }

  return false;
}

function normalizeUiText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getPublishCandidateScore(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  const text = normalizeUiText(info?.text || info?.ariaLabel);
  if (!text || info?.disabled || info?.inNavigation) {
    return -1;
  }

  const tagName = normalizeUiText(info?.tagName);
  const role = normalizeUiText(info?.role);
  if (!["button", "a"].includes(tagName) && role !== "button") {
    return -1;
  }

  const href = normalizeUiText(info?.href);
  if (href && /\/(post|posts|analytics|comment|home|inspiration|monetization|academy|sound|feedback)(\/|$|\?)/i.test(href)) {
    return -1;
  }

  if (text === "posts") {
    return -1;
  }

  const labels = publishTerms.map(normalizeUiText).filter(Boolean);
  const exactMatch = labels.includes(text);
  const nonAmbiguousMatch = labels
    .filter((label) => label !== "post")
    .some((label) => text.includes(label));
  if (!exactMatch && !nonAmbiguousMatch) {
    return -1;
  }

  const rect = info?.rect || {};
  const viewportWidth = Number(info?.viewportWidth) || 0;
  const viewportHeight = Number(info?.viewportHeight) || 0;
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  const right = Number(rect.right) || left + width;
  const mainContentBoundary = viewportWidth >= 900 ? Math.min(300, viewportWidth * 0.25) : 0;

  if (viewportWidth >= 900 && right <= mainContentBoundary) {
    return -1;
  }

  const isBottomAction = viewportHeight > 0 && top >= viewportHeight * 0.5;
  const isCtaSized = width >= 80 && height >= 28;
  const className = normalizeUiText(info?.className);
  const hasPublishCue = /\b(post|publish|submit)\b/.test(className);

  if (text === "post" && viewportHeight >= 600 && !isBottomAction && !hasPublishCue) {
    return -1;
  }

  let score = 0;
  if (exactMatch) score += 30;
  if (nonAmbiguousMatch) score += 20;
  if (tagName === "button") score += 20;
  if (normalizeUiText(info?.type) === "submit") score += 20;
  if (hasPublishCue) score += 20;
  if (isCtaSized) score += 15;
  if (isBottomAction) score += 60;
  if (viewportWidth >= 900 && left >= mainContentBoundary) score += 20;
  score += Math.min(20, Math.max(0, top / 40));

  return score;
}

function isLikelyPublishCandidateInfo(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  return getPublishCandidateScore(info, publishTerms) >= 0;
}

async function getPublishCandidateInfo(candidate) {
  return candidate.evaluate((el) => {
    const clickable = el.closest("button, [role='button'], a") || el;
    const rect = clickable.getBoundingClientRect();
    const className = (clickable.className || "").toString();
    const dataAttributes = Array.from(clickable.attributes || [])
      .filter((attr) => attr.name.startsWith("data-"))
      .map((attr) => `${attr.name}=${attr.value}`)
      .join(" ");
    const inNavigation = Boolean(
      clickable.closest(
        [
          "nav",
          "aside",
          "[role='navigation']",
          "[role='menu']",
          "[role='menubar']",
          "[class*='sidebar' i]",
          "[class*='side-bar' i]",
          "[class*='sidenav' i]",
          "[class*='side-nav' i]",
          "[class*='side_nav' i]",
          "[class*='menu' i]",
          "[class*='navigation' i]",
          "[class*='nav-item' i]",
          "[class*='nav_item' i]",
          "[data-e2e*='nav' i]",
          "[data-e2e*='side' i]",
          "[data-testid*='nav' i]",
          "[data-testid*='side' i]",
        ].join(", ")
      )
    );
    const anchor = clickable.closest("a");
    return {
      ariaLabel: clickable.getAttribute("aria-label") || "",
      className,
      dataAttributes,
      disabled: Boolean(clickable.disabled) || clickable.getAttribute("aria-disabled") === "true",
      href: anchor ? anchor.getAttribute("href") || "" : "",
      inNavigation,
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      role: clickable.getAttribute("role") || "",
      tagName: clickable.tagName,
      type: clickable.getAttribute("type") || "",
      text: clickable.textContent || "",
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

async function clickFirstLikelyPublishLocator(page, locator, publishTerms = uiLabels.terms("tiktokPublish")) {
  const total = await locator.count();
  if (total === 0) {
    return false;
  }

  const candidates = [];
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const info = await getPublishCandidateInfo(candidate).catch(() => null);
    const score = getPublishCandidateScore(info, publishTerms);
    if (score < 0) {
      continue;
    }

    candidates.push({ candidate, info, score });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (Number(b.info?.rect?.top) || 0) - (Number(a.info?.rect?.top) || 0);
  });

  for (const entry of candidates) {
    const { candidate, info, score } = entry;

    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(250);
      await candidate.click({ timeout: 5000 });
      const rect = info?.rect || {};
      console.log(
        `Publish candidate clicked: "${normalizeUiText(info?.text || info?.ariaLabel)}" score=${score.toFixed(1)} ` +
          `rect=${Math.round(Number(rect.left) || 0)},${Math.round(Number(rect.top) || 0)},` +
          `${Math.round(Number(rect.width) || 0)}x${Math.round(Number(rect.height) || 0)}`
      );
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        const rect = info?.rect || {};
        console.log(
          `Publish candidate force-clicked: "${normalizeUiText(info?.text || info?.ariaLabel)}" score=${score.toFixed(1)} ` +
            `rect=${Math.round(Number(rect.left) || 0)},${Math.round(Number(rect.top) || 0)},` +
            `${Math.round(Number(rect.width) || 0)}x${Math.round(Number(rect.height) || 0)}`
        );
        return true;
      } catch {
        // Continue to next candidate.
      }
    }
  }

  return false;
}

async function addDefaultSound(page, source) {
  if (source === "instant-post") {
    console.log("Skipping auto-add sound: Post triggered via Instant Post (video already has sound).");
    return;
  }

  if (!config.autoAddSound) {
    console.log("Auto-add sound disabled by config.");
    return;
  }

  const query = (config.defaultSoundQuery || "").trim();
  if (!query) {
    console.log("Auto-add sound enabled, but DEFAULT_SOUND_QUERY is empty; skipping sound change.");
    return;
  }

  console.log(`Adding sound flow started${query ? `: ${query}` : ""}`);

  async function clickUploadEditorSoundsButton() {
    // Strict targeting for the editor action row under the preview.
    const rowPattern = uiLabels.pattern("tiktokEdit");
    const soundsPattern = uiLabels.pattern("tiktokSounds");
    const textPattern = uiLabels.pattern("tiktokText");

    const rowCandidates = page
      .locator("div, section")
      .filter({ hasText: rowPattern })
      .filter({ hasText: soundsPattern })
      .filter({ hasText: textPattern });

    const rowCount = await rowCandidates.count();
    for (let i = 0; i < rowCount; i += 1) {
      const row = rowCandidates.nth(i);
      const rowVisible = await row.isVisible().catch(() => false);
      if (!rowVisible) {
        continue;
      }

      const box = await row.boundingBox().catch(() => null);
      if (!box) {
        continue;
      }

      // Keep only right-side rows near the phone preview area.
      if (box.x < 520) {
        continue;
      }

      const exactSounds = row.locator(
        uiLabels.textSelector("button", "tiktokSounds") +
          ", " +
          uiLabels.textSelector('[role="button"]', "tiktokSounds")
      );
      const clickedExact = await clickFirstVisibleEnabledLocator(page, exactSounds);
      if (clickedExact) {
        console.log("Sound panel open strategy: strict editor row");
        return true;
      }

      const looseSounds = row.locator("button, [role='button'], div").filter({
        hasText: soundsPattern,
      });
      const clickedLoose = await clickFirstVisibleEnabledLocator(page, looseSounds);
      if (clickedLoose) {
        console.log("Sound panel open strategy: editor row fallback");
        return true;
      }
    }

    // Last resort: right-side clickable element named Sounds/Audio, never nav/aside.
    const soundLabels = uiLabels.terms("tiktokSounds").map((term) => term.toLowerCase());
    const clicked = await page.evaluate((labels) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const el of nodes) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (!labels.includes(text)) {
          continue;
        }
        if (el.closest("nav, aside, [role='navigation']")) {
          continue;
        }
        if (!isVisible(el)) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        // Stronger right-side lock so it cannot hit left menu.
        if (rect.left < window.innerWidth * 0.65) {
          continue;
        }

        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      }

      return false;
    }, soundLabels);

    if (clicked) {
      console.log("Sound panel open strategy: right-side hard fallback");
      return true;
    }

    return false;
  }

  const previousUrl = page.url();
  const opened = await clickUploadEditorSoundsButton();

  if (!opened) {
    console.log("Could not open sound panel; continuing without sound change.");
    return;
  }

  await page.waitForTimeout(700);
  // Guard: if wrong control caused navigation, jump back to upload page and skip sound.
  if (!page.url().includes("/upload")) {
    console.log(`Sounds click navigated away (${page.url()}); returning to upload page.`);
    await gotoUploadPage(page);
    await page.waitForTimeout(1000);
    return;
  }

  if (page.url() !== previousUrl) {
    console.log(`Upload page URL changed after sounds click: ${page.url()}`);
  }

  await page.waitForTimeout(1000);

  let added = false;

  // The "Use this sound" button in the sound panel is the ArrowLeftRight icon button.
  // The PlusBold icon button is typically disabled. We target both but prefer ArrowLeftRight.
  const useButtonSelector = [
    'button:has([data-testid="ArrowLeftRight"])',
    'button:has([data-icon="ArrowLeftRight"])',
  ].join(", ");

  // Step 1: try direct row match first (avoids flaky input focus/autocomplete issues).
  const queryPattern = new RegExp(escapeRegExp(query), "i");
  const directRow = page
    .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
    .filter({ hasText: queryPattern });
  const directUse = directRow.locator(useButtonSelector);
  added = await clickFirstVisibleEnabledLocator(page, directUse);
  if (added) {
    console.log(`Sound used directly from visible "${query}" row (ArrowLeftRight).`);
    await page.waitForTimeout(1500);
  }

  // Step 2: fallback to search when direct row is unavailable.
  if (!added) {
    const soundSearchInput = page.getByPlaceholder(uiLabels.pattern("tiktokSearchSounds")).first();
    const inputVisible = await soundSearchInput.isVisible().catch(() => false);

    if (!inputVisible) {
      console.log("Sound search input not visible; skipping search.");
    } else {
      const queryPrefix = query.split(/\s+/).slice(0, 2).join(" ");
      const searchQueries = Array.from(new Set([query, queryPrefix].filter(Boolean)));

      for (const currentQuery of searchQueries) {
        await soundSearchInput.click({ timeout: 3000 });
        await page.waitForTimeout(300);

        await soundSearchInput.evaluate((el) => {
          el.focus();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(200);

        await page.keyboard.type(currentQuery, { delay: 30 });
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);

        const typedValue = await soundSearchInput.inputValue().catch(() => "");
        console.log(`Sound search typed: "${typedValue}" (wanted: "${currentQuery}")`);

        const rows = page
          .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
          .filter({ hasText: new RegExp(escapeRegExp(currentQuery), "i") });
        const rowCount = await rows.count();
        if (rowCount === 0) {
          console.log(`No rows found for "${currentQuery}".`);
          continue;
        }

        const maxRowsToTry = Math.min(rowCount, 5);
        for (let i = 0; i < maxRowsToTry; i += 1) {
          const row = rows.nth(i);
          const rowVisible = await row.isVisible().catch(() => false);
          if (!rowVisible) continue;

          const addStrategies = [
            row.locator(useButtonSelector),
            row.locator(".MusicPanelMusicItem__operation button").first(),
          ];

          for (const locator of addStrategies) {
            added = await clickFirstVisibleEnabledLocator(page, locator);
            if (added) {
              console.log(`Sound "${currentQuery}" applied via use-button.`);
              await page.waitForTimeout(1500);
              break;
            }
          }
          if (added) break;
        }
        if (added) break;
      }
    }
  }

  // Step 3: hard fallback - click first enabled use-button in the panel.
  if (!added) {
    const firstUse = page.locator(
      `.MusicPanelMusicItem__operation ${useButtonSelector}`
    );
    added = await clickFirstVisibleEnabledLocator(page, firstUse);
    if (added) {
      console.log("Sound applied via first visible ArrowLeftRight fallback.");
      await page.waitForTimeout(1500);
    }
  }

  if (!added) {
    throw new Error(`Could not click use-button for sound "${query}".`);
  }

  // Step 4: Click "Save" to confirm the sound selection.
  // The sound panel is an overlay; the Publish button may be visible behind it,
  // so we must NOT rely on publishVisible to decide if we are done.
  let saved = false;
  const saveLocator = page.locator("button.Button__root--type-primary, button").filter({
    hasText: uiLabels.pattern("tiktokSave"),
  });

  // Retry a few times with waits; the button may need a moment after the sound loads.
  for (let attempt = 0; attempt < 5; attempt++) {
    saved = await clickFirstVisibleEnabledLocator(page, saveLocator);
    if (saved) {
      console.log(`Sound saved via Save (attempt ${attempt + 1}).`);
      break;
    }
    console.log(`Save not ready yet, waiting... (attempt ${attempt + 1}/5)`);
    await page.waitForTimeout(1500);
  }

  if (!saved) {
    // Last resort: try clicking via page.evaluate to force-find and click the button.
    const saveTerms = uiLabels.terms("tiktokSave").map((term) => term.toLowerCase());
    saved = await page.evaluate((labels) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const saveBtn = buttons.find(
        (b) =>
          labels.includes((b.textContent || "").trim().toLowerCase())
      );
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.scrollIntoView();
        saveBtn.click();
        return true;
      }
      return false;
    }, saveTerms);
    if (saved) {
      console.log("Sound saved via evaluate fallback.");
    }
  }

  if (!saved) {
    // Check if the panel actually closed on its own.
    const soundSearchStillVisible = await page
      .getByPlaceholder(uiLabels.pattern("tiktokSearchSounds"))
      .first()
      .isVisible()
      .catch(() => false);
    const cancelVisible = await page
      .locator("button")
      .filter({ hasText: uiLabels.pattern("tiktokCancel") })
      .first()
      .isVisible()
      .catch(() => false);

    if (!soundSearchStillVisible && !cancelVisible) {
      console.log("Sound panel closed on its own after applying sound.");
      await page.waitForTimeout(800);
      return;
    }

    console.log(
      "WARNING: Could not click Save. Trying Cancel to avoid stuck panel."
    );
    await clickFirstVisibleEnabledLocator(
      page,
      page.locator("button").filter({ hasText: uiLabels.pattern("tiktokCancel") })
    );
    throw new Error("Could not click Save in sound editor.");
  }

  await page.waitForTimeout(1500);
}

async function disableShortContentCheck(page) {
  const labelPattern =
    uiLabels.pattern("tiktokShortContentCheck");
  const section = page
    .locator("section, div, li, form")
    .filter({ hasText: labelPattern })
    .first();

  if ((await section.count()) === 0) {
    console.log("Short content check toggle not found; continuing.");
    return;
  }

  async function readSwitchState(candidate) {
    return candidate.evaluate((el) => {
      const ariaChecked = (el.getAttribute("aria-checked") || "").toLowerCase();
      if (ariaChecked === "true") {
        return true;
      }
      if (ariaChecked === "false") {
        return false;
      }

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        return el.checked;
      }

      const className = (el.className || "").toString().toLowerCase();
      if (
        className.includes("checked") ||
        className.includes("active") ||
        className.includes("enabled") ||
        className.includes("on")
      ) {
        return true;
      }
      if (
        className.includes("disabled") ||
        className.includes("inactive") ||
        className.includes("off")
      ) {
        return false;
      }

      return null;
    });
  }

  const switchCandidates = [
    section.locator('[role="switch"]'),
    section.locator('button[aria-checked], button[class*="switch" i], button[class*="toggle" i]'),
    section.locator('input[type="checkbox"]'),
  ];

  for (const pool of switchCandidates) {
    const count = await pool.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = pool.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
      const before = await readSwitchState(candidate).catch(() => null);
      if (before === false) {
        console.log("Short content check already disabled.");
        return;
      }

      await candidate.click({ timeout: 3000, force: true }).catch(() => { });
      await page.waitForTimeout(800);
      const after = await readSwitchState(candidate).catch(() => null);

      if (after === false || (before === true && after !== true)) {
        console.log("Short content check disabled.");
        return;
      }
    }
  }

  console.log("Short content check toggle found but could not be switched off.");
}

/**
 * Mark (or clear) the "AI-generated content" disclosure. TikTok sometimes hides
 * it behind "More options"; we open that first if the toggle is not visible.
 * This is best-effort: a missing checkbox never fails the upload.
 */
async function setAiGeneratedDisclosure(page, enabled) {
  if (!enabled) return false;

  const labelPattern = uiLabels.pattern("tiktokAiGenerated");
  const hasToggle = () =>
    page.locator('[role="switch"], input[type="checkbox"]').filter({ hasText: labelPattern }).count().catch(() => 0);

  let toggle = page
    .locator('[role="switch"], input[type="checkbox"], label')
    .filter({ hasText: labelPattern })
    .first();

  if ((await toggle.count().catch(() => 0)) === 0) {
    // Try to reveal advanced options.
    const morePattern = uiLabels.pattern("tiktokAdvancedSettings");
    const moreBtn = page
      .getByRole("button", { name: morePattern })
      .first();
    if ((await moreBtn.count().catch(() => 0)) > 0) {
      await moreBtn.click({ timeout: 3000 }).catch(() => { });
      await page.waitForTimeout(800);
    }
    toggle = page
      .locator('[role="switch"], input[type="checkbox"], label')
      .filter({ hasText: labelPattern })
      .first();
  }

  if ((await toggle.count().catch(() => 0)) === 0) {
    console.log("AI-generated disclosure toggle not found; continuing.");
    return false;
  }

  const readState = (el) =>
    el.evaluate((node) => {
      if (node instanceof HTMLInputElement && node.type === "checkbox") return node.checked;
      const aria = (node.getAttribute("aria-checked") || "").toLowerCase();
      if (aria === "true") return true;
      if (aria === "false") return false;
      return null;
    });

  const current = await readState(toggle).catch(() => null);
  if (current === true) {
    console.log("AI-generated disclosure already enabled.");
    return true;
  }

  await toggle.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
  await toggle.click({ timeout: 3000, force: true }).catch(() => { });
  await page.waitForTimeout(600);
  const after = await readState(toggle).catch(() => null);
  if (after === true || (current !== true && after !== false)) {
    console.log("AI-generated disclosure enabled.");
    return true;
  }
  console.log("AI-generated disclosure found but could not be toggled.");
  return false;
}

async function clickFirstVisibleButton(page, nameRegex, timeout = 3000) {
  const button = page.getByRole("button", { name: nameRegex }).first();
  if ((await button.count()) === 0) {
    return false;
  }
  try {
    await button.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * // MARKER: TIKTOK-RESTRICTED-MODAL-v1
 * Cierra el modal "Content may be restricted" (la X es un div con SVG, sin
 * texto ni aria-label, por eso el codigo anterior no la encontraba).
 */
/**
 * // MARKER: TIKTOK-RESTRICTED-MODAL-v3
 * Cierra el modal "Content may be restricted" / "El contenido puede estar
 * restringido", que aparece tras pulsar Publicar y bloquea el boton.
 *
 * v3: detecta el dialogo por su TEXTO (antes exigia encontrar el boton de
 * cierre, y si TikTok lo pintaba distinto la funcion decia "no hay popup" y el
 * video nunca se publicaba). Cierra con varias estrategias y VERIFICA que se
 * cerro. Devuelve true solo si el popup ya no esta.
 */
/**
 * // MARKER: TIKTOK-RESTRICTED-MODAL-v3
 * Espera a que el boton Publicar/Programar vuelva a estar visible y habilitado
 * tras cerrar el popup: TikTok lo deja tapado o desactivado unos instantes y un
 * click inmediato no hace nada.
 */
async function waitForPublishClickable(page, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const pattern = /^(post|publicar|publish|schedule|programar)$/i;
        const buttons = [
          ...document.querySelectorAll("button, [role='button'], [class*='Btn']"),
        ];
        for (const b of buttons) {
          const label = (b.innerText || b.textContent || "").trim();
          if (!pattern.test(label)) continue;
          const box = b.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function dismissRestrictedContentModal(page) {
  const findOpenModal = () =>
    page.evaluate(() => {
      const titlePattern = /content may be restricted|el contenido puede estar restringido|puede estar restringido|contenido restringido/i;
      const reasons = [
        /unoriginal|low-quality|qr code|poco original|baja calidad|codigo qr/i,
        /violation reason|motivo de la infraccion/i,
      ];
      const visible = (el) =>
        el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
      const candidates = [
        ...document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Modal" i]'
        ),
      ].filter(visible);

      for (const d of candidates) {
        const body = (d.innerText || "").trim();
        if (!body) continue;
        // El modal de subida NO es el de restriccion: tiene los controles de
        // programacion.
        if (/when to post|schedule|subir|postSchedule/i.test(body)) continue;
        if (!(titlePattern.test(body) || reasons.some((p) => p.test(body)))) continue;
        return { text: body.slice(0, 120) };
      }
      return null;
    });

  let closedAny = false;
  for (let pass = 0; pass < 5; pass += 1) {
    let open = null;
    try {
      open = await findOpenModal();
    } catch {
      open = null;
    }
    if (!open) break;

    let clicked = false;

    // 1) El boton real: .common-modal-close (con su SVG).
    const closeByClass = page
      .locator(".common-modal-close, [class*='common-modal-close']")
      .first();
    if ((await closeByClass.count().catch(() => 0)) > 0) {
      await closeByClass.click({ timeout: 1500, force: true }).catch(() => {});
      clicked = true;
    }

    // 2) El icono interno.
    if (!clicked) {
      const icon = page
        .locator(".common-modal-close-icon, [class*='common-modal-close-icon']")
        .first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 3) Cualquier aria-label/close del dialogo.
    if (!clicked) {
      const ariaClose = page
        .locator("[aria-label*='close' i], [aria-label*='cerrar' i], [class*='close' i]")
        .first();
      if ((await ariaClose.count().catch(() => 0)) > 0) {
        await ariaClose.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 4) Escape (cierra modales nativos).
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => {});
      clicked = true;
    }

    // 5) JS directo sobre el DOM (ultimo recurso).
    if (!clicked) {
      const didClick = await page
        .evaluate(() => {
          const nodes = [
            ...document.querySelectorAll(
              ".common-modal-close, [class*='common-modal-close'], [class*='close' i]"
            ),
          ];
          for (const node of nodes) {
            if (node && typeof node.click === "function") {
              node.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      clicked = Boolean(didClick);
    }

    if (!clicked) break;
    closedAny = true;
    await page.waitForTimeout(500);
  }

  // Verificar: si el modal sigue ahi, la X no funciono.
  let stillOpen = null;
  try {
    stillOpen = await findOpenModal();
  } catch {
    stillOpen = null;
  }
  if (closedAny && stillOpen) {
    console.log(
      "TikTok: el popup restringido sigue abierto tras intentar cerrarlo (la X no respondio)."
    );
    return false;
  }

  if (closedAny) {
    console.log("TikTok: cerrado el popup de contenido restringido; reintentando publicar.");
  }
  return closedAny;
}

async function dismissInterferingOverlays(page) {
  // Only dismiss *secondary* hint/consent dialogs. Never click a button whose
  // label means Cancel/Exit/Continue: on the upload modal those are the dialog's
  // own leave/next buttons and clicking one closes or advances the editor we are
  // about to schedule from. Match exact short labels only to avoid "ok" matching
  // "Book"/"Look"/"TikTok".
  const dismissTerms = ["got it", "later", "not now", "skip", "ok", "allow", "enable"];

  for (let pass = 0; pass < 3; pass += 1) {
    const clicked = await page.evaluate((dismissTerms) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const dialogs = [...document.querySelectorAll("[role='dialog'], [class*='modal' i]")]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
      // Skip the main upload modal: it contains the scheduling controls.
      const isUploadModal = (el) => /when to post|schedule|subir|postSchedule/i.test(el.textContent || "");
      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
        .filter((el) => !/(cancel|salir|exit|cerrar|close|discard|continue|next|siguiente)/i.test(normalize(el.textContent)));
      for (const button of buttons) {
        if (!dismissTerms.includes(normalize(button.textContent))) continue;
        const box = button.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        // If it sits inside the upload modal, it is not a secondary hint.
        const dialog = dialogs.find((d) => d.contains(button));
        if (dialog && isUploadModal(dialog)) continue;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    }, dismissTerms).catch(() => null);

    if (!clicked) break;
    await page.mouse.click(clicked.x, clicked.y).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
}

async function tryClickPublishButton(page) {
  // Strategy 1: exact text buttons (most reliable on TikTok Studio)
  const exactSelectors = [
    uiLabels.textSelector("button", "tiktokPublish"),
    uiLabels.textSelector('[role="button"]', "tiktokPublish"),
  ];

  for (const selector of exactSelectors) {
    const locator = page.locator(selector);
    const clicked = await clickFirstLikelyPublishLocator(page, locator);
    if (clicked) {
      console.log(`Publish click strategy: exact selector ${selector}`);
      return true;
    }
  }

  // Strategy 2: role-based labels.
  const roleTexts = [
    uiLabels.pattern("tiktokPublish"),
  ];

  for (const textPattern of roleTexts) {
    const button = page.getByRole("button", { name: textPattern });
    const clicked = await clickFirstLikelyPublishLocator(page, button);
    if (clicked) {
      console.log(`Publish click strategy: role ${textPattern}`);
      return true;
    }
  }

  // Strategy 3: CSS selectors for the red publish button
  const cssSelectors = [
    'button[class*="publish" i]',
    'button[class*="post-btn" i]',
    'button[class*="submit" i]',
    'div[class*="publish" i] button',
    'div[class*="btn-post" i]',
  ];

  for (const selector of cssSelectors) {
    const el = page.locator(selector);
    const clicked = await clickFirstLikelyPublishLocator(page, el);
    if (clicked) {
      console.log(`Publish click strategy: css ${selector}`);
      return true;
    }
  }

  // Strategy 4: find by visible text content (any clickable element)
  const textLabels = uiLabels.terms("tiktokPublish");

  for (const label of textLabels) {
    const el = page.locator(`text="${label}"`);
    const clicked = await clickFirstLikelyPublishLocator(page, el);
    if (clicked) {
      console.log(`Publish click strategy: text ${label}`);
      return true;
    }
  }

  // Strategy 5: brute-force - find any likely submit element by text.
  const publishTerms = uiLabels.terms("tiktokPublish").map((term) => term.toLowerCase());
  const clicked = await page.evaluate((labels) => {
    const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
    const normalizedLabels = labels.map(normalize).filter(Boolean);
    const isPublishText = (text) => {
      const exactMatch = normalizedLabels.includes(text);
      const nonAmbiguousMatch = normalizedLabels
        .filter((label) => label !== "post")
        .some((label) => text.includes(label));
      return exactMatch || nonAmbiguousMatch;
    };
    const isLikelyCandidate = (btn) => {
      const text = normalize(btn.textContent || btn.getAttribute("aria-label"));
      if (!text || text === "posts" || !isPublishText(text)) {
        return false;
      }
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        return false;
      }
      if (
        btn.closest(
          "nav, aside, [role='navigation'], [class*='sidebar' i], [class*='side-bar' i], [class*='sidenav' i], [class*='side-nav' i], [class*='menu' i]"
        )
      ) {
        return false;
      }
      const anchor = btn.closest("a");
      const href = normalize(anchor ? anchor.getAttribute("href") : "");
      if (href && /\/(post|posts|analytics|comment|home|inspiration|monetization|academy|sound|feedback)(\/|$|\?)/i.test(href)) {
        return false;
      }
      const rect = btn.getBoundingClientRect();
      const mainContentBoundary = window.innerWidth >= 900 ? Math.min(300, window.innerWidth * 0.25) : 0;
      if (window.innerWidth >= 900 && rect.right <= mainContentBoundary) {
        return false;
      }
      const className = normalize(btn.className || "");
      const hasPublishCue = /\b(post|publish|submit)\b/.test(className);
      if (text === "post" && window.innerHeight >= 600 && rect.top < window.innerHeight * 0.5 && !hasPublishCue) {
        return false;
      }
      return true;
    };
    const scoreCandidate = (btn) => {
      const text = normalize(btn.textContent || btn.getAttribute("aria-label"));
      const rect = btn.getBoundingClientRect();
      const className = normalize(btn.className || "");
      let score = 0;
      if (normalizedLabels.includes(text)) score += 30;
      if (btn.tagName.toLowerCase() === "button") score += 20;
      if (normalize(btn.getAttribute("type")) === "submit") score += 20;
      if (/\b(post|publish|submit)\b/.test(className)) score += 20;
      if (rect.width >= 80 && rect.height >= 28) score += 15;
      if (window.innerHeight > 0 && rect.top >= window.innerHeight * 0.5) score += 60;
      if (window.innerWidth >= 900 && rect.left >= Math.min(300, window.innerWidth * 0.25)) score += 20;
      score += Math.min(20, Math.max(0, rect.top / 40));
      return score;
    };

    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    const candidates = buttons
      .filter(isLikelyCandidate)
      .map((btn) => ({ btn, score: scoreCandidate(btn), top: btn.getBoundingClientRect().top }))
      .sort((a, b) => b.score - a.score || b.top - a.top);
    if (candidates.length > 0) {
      candidates[0].btn.scrollIntoView({ block: "center" });
      candidates[0].btn.click();
      return true;
    }
    return false;
  }, publishTerms);
  if (clicked) {
    console.log("Publish click strategy: DOM evaluate fallback");
  }

  return clicked;
}

async function clickPublish(page) {
  await dismissInterferingOverlays(page);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await scrollToBottom(page);
    await page.waitForTimeout(500);

    const clicked = await tryClickPublishButton(page);
    if (clicked) {
      console.log(`Publish button clicked on attempt ${attempt + 1}.`);
      return;
    }

    await dismissInterferingOverlays(page);
    await page.waitForTimeout(2000);
  }

  throw new Error("Could not find an enabled Publish/Post button after 6 attempts.");
}

/**
 * Click TikTok's final confirmation button. When scheduling it is the big red
 * button with data-e2e="post_video_button" whose label is "Schedule".
 */
async function clickScheduleButton(page) {
  await dismissInterferingOverlays(page);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await scrollToBottom(page);
    await page.waitForTimeout(500);

    // Resolve the button, scroll it into view, then read the FINAL coordinates and
    // click with a real mouse event. React ignores synthetic element.click() here,
    // and coordinates must be read after scrolling or the click lands elsewhere.
    const scored = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, [role='button']")].filter(
        (element) => element.offsetParent !== null && element.getAttribute("aria-disabled") !== "true"
      );

      const byE2e = buttons.find((button) => (button.getAttribute("data-e2e") || "").includes("post_video_button"));
      const target = byE2e || buttons.find((button) => {
        const text = (button.textContent || "").trim().toLowerCase();
        return text === "schedule" && !button.disabled;
      });

      if (!target) return null;
      target.scrollIntoView({ block: "center" });
      return true;
    });

    if (!scored) {
      await dismissInterferingOverlays(page);
      await page.waitForTimeout(2000);
      continue;
    }

    await page.waitForTimeout(300);
    const point = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, [role='button']")].filter(
        (element) => element.offsetParent !== null && element.getAttribute("aria-disabled") !== "true"
      );
      const byE2e = buttons.find((button) => (button.getAttribute("data-e2e") || "").includes("post_video_button"));
      const target = byE2e || buttons.find((button) => {
        const text = (button.textContent || "").trim().toLowerCase();
        return text === "schedule" && !button.disabled;
      });
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (target.textContent || "").trim() };
    });

    if (point) {
      await page.mouse.click(point.x, point.y);
      console.log(`Schedule button clicked on attempt ${attempt + 1} (text="${point.text}").`);
      return;
    }

    await dismissInterferingOverlays(page);
    await page.waitForTimeout(2000);
  }

  throw new Error("Could not find an enabled Schedule button after 6 attempts.");
}

function formatScheduleDate(date, timezone) {
  const dt = timezone ? DateTime.fromJSDate(date).setZone(timezone) : DateTime.fromJSDate(date);
  return dt.toFormat("yyyy-LL-dd");
}

function formatScheduleTime(date, timezone) {
  const dt = timezone ? DateTime.fromJSDate(date).setZone(timezone) : DateTime.fromJSDate(date);
  return dt.toFormat("HH:mm");
}

/**
 * Switch the TikTok upload form from "Now" to "Schedule" and fill in the
 * exact date and time. TikTok's Web Studio exposes a radio group
 * (When to post: Now / Schedule) plus two select-like dropdowns.
 */
/**
 * // MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1
 * Comprueba que el radio "Schedule" de "When to post" esta activo. Si esta en
 * "Now", lo activa. Evita llegar a programar con el formulario en "Now"
 * (que es lo que hacia que no se pusiera la fecha/hora).
 */
async function ensureScheduleRadioOn(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await page.evaluate(() => {
      const radio = document.querySelector(
        "input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']"
      );
      if (!radio) return "missing";
      const on = radio.checked || radio.getAttribute("aria-checked") === "true";
      return on ? "on" : "off";
    }).catch(() => "missing");

    if (state === "on") return true;
    if (state === "missing") {
      await page.waitForTimeout(700);
      continue;
    }
    // Esta en "Now": activar Schedule.
    await page.evaluate(() => {
      const radio = document.querySelector(
        "input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']"
      );
      if (!radio) return;
      radio.click();
      if (!(radio.checked || radio.getAttribute("aria-checked") === "true")) {
        const wrap = radio.closest("label, [role='radio']") || radio.parentElement || radio;
        wrap.click();
      }
    }).catch(() => {});
    await page.waitForTimeout(900);
  }
  console.log("Aviso: no se pudo confirmar que el radio Schedule este activo; se intentara programar igual.");
  return false;
}

async function enableScheduleMode(page) {
  await dismissInterferingOverlays(page);

  const scheduleTerms = uiLabels.terms("tiktokSchedule");
  const clicked = await page.evaluate((terms) => {
    const normalize = (value) => (value || "").trim().toLowerCase();
    const matches = (value) => terms.some((term) => normalize(value) === term);

    // Prefer actual radio inputs / radio roles near a "schedule" label, and
    // never click a submit-style button (the red "Schedule" action).
    // TikTok uses <input type="radio" name="postSchedule" value="schedule">
    // wrapped in a span with no <label>, so also match the value/name.
    const radios = [...document.querySelectorAll("input[type='radio'], [role='radio']")];
    for (const radio of radios) {
      const value = (radio.getAttribute("value") || "").trim();
      const name = (radio.getAttribute("name") || "").trim();
      const aria = (radio.getAttribute("aria-label") || "").trim();
      const isSchedule = /^schedule$/i.test(value) ||
        (/postschedul/i.test(name) && /schedule/i.test(value));
      const container = radio.closest("label") || radio.parentElement || radio;
      const text = (container.textContent || aria || "").trim();
      const matchesLabel = matches(text) || (text && /schedule/i.test(text));
      if (!isSchedule && !matchesLabel) continue;

      // A hidden radio still toggles with .click(); the visible wrapper often
      // has no handler, so click the input first and the wrapper as fallback.
      radio.click();
      if (!(radio.checked || radio.getAttribute("aria-checked") === "true")) {
        (radio.closest("label") || radio.parentElement || radio).click();
      }
      return isSchedule ? "radio-value" : "radio";
    }

    // Fallback: a label whose text is exactly the schedule term, but not a button.
    const labels = [...document.querySelectorAll("label, span, div")].filter((element) => {
      if (element.closest("button")) return false;
      if (element.tagName.toLowerCase() === "button") return false;
      return matches(element.textContent) && element.offsetParent !== null;
    });
    for (const element of labels) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      element.click();
      return "label";
    }
    return null;
  }, scheduleTerms);

  if (!clicked) {
    await dumpScheduleDiagnostics(page, "no-schedule-option");
    throw new Error("Could not find the Schedule option in TikTok's 'When to post' section.");
  }
  console.log(`Schedule mode enabled via ${clicked}.`);

  // Confirm the radio actually switched on; retry by clicking the wrapper span.
  const confirmed = await page.evaluate(() => {
    const radio = document.querySelector("input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']");
    if (!radio) return true;
    return radio.checked || radio.getAttribute("aria-checked") === "true";
  }).catch(() => true);

  if (!confirmed) {
    await page.evaluate(() => {
      const radio = document.querySelector("input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']");
      if (!radio) return;
      const wrapper = radio.closest("label, [role='radio']") || radio.parentElement || radio;
      wrapper.click();
      radio.click();
    }).catch(() => {});
    await page.waitForTimeout(800);
    console.log("Schedule radio needed a second click.");
  }

  await page.waitForTimeout(1500);
}

async function pickScheduleDropdownValue(page, index, value) {
  const found = await findScheduleControls(page);
  const control = found[index];
  if (!control) return false;

  return setControlValue(page, control, value);
}

/**
 * Locate the two controls of TikTok's "When to post -> Schedule" section: the
 * one showing a time (e.g. "20:05") and the one showing a date (e.g.
 * "2026-09-12"). Returns descriptors that survive the picker opening with an
 * index so we can re-resolve them afterwards.
 */
async function findScheduleControls(page) {
  return page.evaluate(() => {
    const timePattern = /^\d{1,2}:\d{2}$/;
    const datePattern = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/;

    const isVisible = (element) => element && element.offsetParent !== null;

    // The visible value of a control: <select> shows the selected option,
    // inputs show .value, other elements show their text.
    const visibleText = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === "select") {
        const option = element.options?.[element.selectedIndex];
        return (option?.textContent || element.value || "").trim();
      }
      if (tag === "input") {
        return (element.value || element.getAttribute("placeholder") || element.getAttribute("aria-label") || "").trim();
      }
      return (element.textContent || element.getAttribute("aria-label") || "").trim();
    };

    const selector = "input, select, [role='combobox'], [role='textbox'], button, [tabindex]";
    const all = [...document.querySelectorAll(selector)];

    const controls = all
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, rect, text: visibleText(element) };
      })
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);

    // Prefer controls whose *value* matches the pattern, then controls that
    // contain the pattern in placeholder/label text.
    const timeControls = controls.filter((item) => timePattern.test(item.text));
    const dateControls = controls.filter((item) => datePattern.test(item.text));

    const describe = (item, kind) => ({
      kind,
      index: all.indexOf(item.element),
      x: Math.round(item.rect.x + item.rect.width / 2),
      y: Math.round(item.rect.y + item.rect.height / 2),
      text: item.text,
      tag: item.element.tagName.toLowerCase(),
      role: item.element.getAttribute("role") || "",
      readonly: Boolean(item.element.readOnly),
    });

    const ordered = [];
    if (timeControls[0]) ordered.push(describe(timeControls[0], "time"));
    if (dateControls[0]) ordered.push(describe(dateControls[0], "date"));
    return ordered;
  });
}

async function resolveControlByIndex(page, index) {
  return page.evaluateHandle((wanted) => {
    const all = [...document.querySelectorAll("input, select, [role='combobox'], [role='textbox'], button, [tabindex]")];
    return all[wanted] || null;
  }, index);
}

async function setControlValue(page, control, value) {
  console.log(`Schedule control ${control.kind}: tag=${control.tag} role=${control.role} text="${control.text}"`);

  const verify = () => controlApplied(page, control.index, value);

  // TikTok's schedule fields are read-only TUX text inputs; writing to them via
  // the native setter never sticks and the focus/blur can close the picker that
  // a later step tries to open. For these, go straight to the real picker.
  if (control.kind === "time" || control.kind === "date") {
    const setByPicker = control.kind === "time"
      ? await setTikTokTime(page, control, value)
      : await setTikTokDate(page, control, value);
    if (setByPicker && await verify()) return true;
    // Fall through to the generic strategies below if the picker path failed.
  }

  // Strategy A: set the value directly via the native React setter. Only meaningful
  // for editable inputs; on read-only fields it is a no-op, so skip it there.
  if (!control.readonly) {
    const setDirect = await page.evaluate((wanted) => {
      const selector = "input, select, [role='combobox'], [role='textbox'], button, [tabindex]";
      const element = document.querySelectorAll(selector)[wanted.index];
      if (!element || element.tagName.toLowerCase() !== "input") return false;
      if (element.readOnly) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(element, wanted.value); else element.value = wanted.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { index: control.index, value });
    if (setDirect) {
      await page.waitForTimeout(500);
      if (await verify()) {
        await debugLog(`  ${control.kind}: set directly via native setter`);
        return true;
      }
    }
  }

  // Strategy B: TikTok's read-only text inputs. Click to open the picker panel,
  // then click the matching option inside it.
  if (control.kind === "time") {
    if (await setTikTokTime(page, control, value)) return true;
  }
  if (control.kind === "date") {
    if (await setTikTokDate(page, control, value)) return true;
  }

  // Strategy C: native <select> (some TikTok variants use one).
  if (control.tag === "select") {
    const handle = await resolveControlByIndex(page, control.index);
    const element = handle.asElement();
    if (element) {
      const ok = await element
        .selectOption({ label: value })
        .then(() => true)
        .catch(async () => element.selectOption(value).then(() => true).catch(() => false));
      if (ok && await verify()) return true;
    }
  }

  // Strategy D: focus, remove readonly, and type the value with the keyboard.
  try {
    await page.evaluate((index) => {
      const selector = "input, select, [role='combobox'], [role='textbox'], button, [tabindex]";
      const element = document.querySelectorAll(selector)[index];
      if (element && element.tagName.toLowerCase() === "input") element.removeAttribute("readonly");
    }, control.index).catch(() => {});
    await page.mouse.click(control.x, control.y);
    await page.waitForTimeout(400);
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(value, { delay: 60 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(400);
    if (await verify()) return true;
  } catch (error) {
    console.log(`Type strategy failed for ${control.kind}: ${error.message}`);
  }

  console.log(`Could not set ${control.kind} to ${value}.`);
  return false;
}

/** Parse "HH:MM" into its two-option (hours, minutes) halves. */
function splitTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  return { hour: String(match[1]).padStart(2, "0"), minute: match[2] };
}

/** Set TikTok's custom time picker (hour + minute scroll columns). */
async function setTikTokTime(page, control, value) {
  const parts = splitTime(value);
  if (!parts) return false;

  const panelState = () => page.evaluate(() => {
    const panel = document.querySelector(".tiktok-timepicker-time-picker-container");
    if (!panel) return { found: false, visible: false };
    // TikTok keeps the picker mounted but hidden via this class until it opens.
    const hidden = panel.classList.contains("tiktok-timepicker-invisible");
    const rect = panel.getBoundingClientRect();
    return {
      found: true,
      visible: !hidden && panel.offsetParent !== null && rect.width > 0 && rect.height > 0,
      text: (panel.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    };
  }).catch(() => ({ found: false, visible: false }));

  // Read the field's live centre. The layout can shift after a picker opens, so
  // never reuse stale coordinates captured at the start.
  const fieldPoint = async () => page.evaluate(() => {
    const fields = [...document.querySelectorAll("input.TUXTextInputCore-input, input[readonly]")]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    // Prefer a field whose value looks like a time (HH:MM).
    const field = fields.find((el) => /^\d{1,2}:\d{2}$/.test(String(el.value || "").trim())) || fields[0];
    if (!field) return null;
    const rect = field.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }).catch(() => null);

  // Always click the time field to open the real picker. Relying on a DOM probe
  // is unsafe because TikTok keeps hidden copies of the picker mounted, which
  // made the old panelOpen() report "open" while the visible picker was closed.
  const openPanel = async () => {
    let state = await panelState();
    if (state.visible) return state;
    const point = (await fieldPoint()) || { x: control.x, y: control.y };
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(700);
    state = await panelState();
    return state;
  };

  const closePanel = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    let state = await panelState();
    if (state.visible) {
      // Click a point safely OUTSIDE the open panel (its own rect), never a blind
      // offset that could land on another control such as "Exit".
      const outside = await page.evaluate(() => {
        const panel = [...document.querySelectorAll(".tiktok-timepicker-time-picker-container")]
          .find((el) => !el.classList.contains("tiktok-timepicker-invisible") && el.offsetParent !== null);
        const rect = panel ? panel.getBoundingClientRect() : null;
        const x = rect ? Math.max(5, rect.x - 40) : 5;
        const y = rect ? Math.max(5, rect.y - 40) : 5;
        return { x, y };
      }).catch(() => null);
      if (outside) await page.mouse.click(outside.x, outside.y).catch(() => {});
      await page.waitForTimeout(300);
      state = await panelState();
    }
    if (state.visible) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    }
    return !(await panelState()).visible;
  };

  // Click an option with a real mouse click: React listens on pointer events and
  // ignores synthetic element.click() for these rows.
  const clickOption = async (column, wanted, snapToFive) => {
    const target = await page.evaluate(({ column, wanted, snapToFive }) => {
      const panels = [...document.querySelectorAll(".tiktok-timepicker-time-picker-container")];
      const panel = panels.find((element) => {
        if (element.classList.contains("tiktok-timepicker-invisible")) return false;
        const rect = element.getBoundingClientRect();
        return element.offsetParent !== null && rect.width > 0 && rect.height > 0;
      });
      if (!panel) return null;
      const options = [...panel.querySelectorAll(".tiktok-timepicker-option-text")]
        .filter((el) => el.classList.contains(`tiktok-timepicker-${column}`));
      let candidate = options.find((el) => (el.textContent || "").trim() === wanted);
      if (!candidate && snapToFive) {
        candidate = options
          .map((el) => ({ el, n: parseInt(el.textContent, 10) }))
          .filter((item) => Number.isFinite(item.n))
          .sort((a, b) => Math.abs(a.n - Number(wanted)) - Math.abs(b.n - Number(wanted)))[0]?.el;
      }
      if (!candidate) return null;
      candidate.scrollIntoView({ block: "center" });
      // TikTok's handler is on the option text itself; clicking a parent row at
      // its centre can land on empty padding and be ignored.
      const rect = candidate.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: (candidate.textContent || "").trim() };
    }, { column, wanted, snapToFive }).catch(() => null);

    if (!target) return false;
    // Give the scroll a frame to settle before clicking the freshly read point.
    await page.waitForTimeout(150);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(450);
    return true;
  };

  const opened = await openPanel();
  if (!opened?.visible) {
    await debugLog(`  time: panel did not open (state=${JSON.stringify(opened)})`);
    return false;
  }

  // Re-open between the two columns: picking an hour can close the picker.
  let hourOk = await clickOption("left", parts.hour, false);
  let state = await panelState();
  if (!state.visible) {
    await openPanel();
  }
  // Retry the hour once if the picker stayed open but nothing was chosen.
  if (!hourOk || !state.visible) {
    await openPanel();
    hourOk = await clickOption("left", parts.hour, false) || hourOk;
  }
  await page.waitForTimeout(250);

  state = await panelState();
  if (!state.visible) {
    await openPanel();
  }
  let minuteOk = await clickOption("right", parts.minute, true);
  if (!minuteOk) {
    await openPanel();
    minuteOk = await clickOption("right", parts.minute, true);
  }
  await page.waitForTimeout(400);

  const closed = await closePanel();
  await debugLog(`  time: hour ${parts.hour} ok=${hourOk}, minute ${parts.minute} ok=${minuteOk}, panelClosed=${closed}`);
  return hourOk && minuteOk;
}

/** Set TikTok's custom calendar picker by navigating to the month and day. */
async function setTikTokDate(page, control, value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return false;
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]); // 1-12
  const targetDay = String(Number(match[3]));

  // Read the date field's live centre: the layout can shift while the timepicker
  // closes, so stale coordinates would click the wrong control.
  const datePoint = await page.evaluate(() => {
    const fields = [...document.querySelectorAll("input.TUXTextInputCore-input, input[readonly]")]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    // Prefer a field whose value looks like a date (YYYY-MM-DD).
    const field = fields.find((el) => /^\d{4}-\d{2}-\d{2}$/.test(String(el.value || "").trim())) || fields[fields.length - 1];
    if (!field) return null;
    field.scrollIntoView({ block: "center" });
    const rect = field.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }).catch(() => null);

  const point = datePoint || { x: control.x, y: control.y };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(900);
  await debugLog(`  date: clicked field at (${point.x},${point.y}); state=${JSON.stringify(await describeScheduleState(page))}`);

  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  // The calendar is whichever visible overlay contains a grid of day numbers.
  // TikTok keeps other overlays (like the location search) with numeric text in
  // the DOM, so we require a real month name + a plausible year and reject
  // location/search panels.
  const findCalendar = () => page.evaluate((monthNames) => {
    const visible = [...document.querySelectorAll("div")].filter((element) => {
      if (element.offsetParent === null) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 120 && rect.height > 120;
    });
    // Score panels by how many 1..31 numbers they contain.
    let best = null;
    for (const panel of visible) {
      const text = (panel.textContent || "").toLowerCase();
      if (/location|ubicaci|search|buscar/i.test(text)) continue;
      const numbers = [...panel.querySelectorAll("span, div, td, button")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => (el.textContent || "").trim())
        .filter((entry) => /^\d{1,2}$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 31);
      const uniqueDays = new Set(numbers);
      if (uniqueDays.size < 20) continue;
      const monthIndex = monthNames.findIndex((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
      const yearMatch = text.match(/(20\d{2})/);
      const year = yearMatch ? Number(yearMatch[1]) : null;
      // A real calendar header shows a month name; without it this is not a calendar.
      if (monthIndex < 0) continue;
      if (year !== null && (year < 2020 || year > 2035)) continue;
      const headerValue = panel.querySelector("input, [class*='month' i], [class*='header' i], header");
      const score = uniqueDays.size;
      if (!best || score > best.score) {
        best = {
          score,
          month: monthIndex + 1,
          year,
          header: headerValue ? (headerValue.textContent || headerValue.value || "").trim() : "",
        };
      }
    }
    return best;
  }, monthNames);

  const clickDay = (day) => page.evaluate(({ wanted, monthNames }) => {
    const visible = [...document.querySelectorAll("div")].filter((element) => {
      if (element.offsetParent === null) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 120 && rect.height > 120;
    });
    // Pick the same panel findCalendar would: a real month header, no location text.
    let target = null;
    let bestScore = 0;
    for (const panel of visible) {
      const text = (panel.textContent || "").toLowerCase();
      if (/location|ubicaci|search|buscar/i.test(text)) continue;
      const monthIndex = monthNames.findIndex((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
      if (monthIndex < 0) continue;
      const yearMatch = text.match(/(20\d{2})/);
      const year = yearMatch ? Number(yearMatch[1]) : null;
      if (year !== null && (year < 2020 || year > 2035)) continue;
      const numbers = new Set(
        [...panel.querySelectorAll("span, div, td, button")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => (el.textContent || "").trim())
          .filter((entry) => /^\d{1,2}$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 31)
      );
      if (numbers.size < 20) continue;
      if (numbers.size > bestScore) { bestScore = numbers.size; target = panel; }
    }
    if (!target) return null;
    const cells = [...target.querySelectorAll("td, button, [class*='day' i], [class*='cell' i], span, div")]
      .filter((el) => el.offsetParent !== null && (el.textContent || "").trim() === wanted);
    // Prefer the most deeply nested element (the day cell, not its container).
    const sorted = cells.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length);
    const cell = sorted[0];
    if (!cell || /(disabled|outside|other|prev|next)-?/i.test(cell.className)) return null;
    const row = cell.closest("[class*='day' i], td, button") || cell;
    const rect = row.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, { wanted: day, monthNames }).then(async (point) => {
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    return true;
  });

  const clickNextMonth = () => page.evaluate(() => {
    const selectors = [
      "[class*='next' i]",
      "button[aria-label*='next' i]",
      "[data-testid*='next' i]",
      "[data-icon*='right' i]",
      "[aria-label*='next' i]",
    ];
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...document.querySelectorAll(selector));
    }
    const button = candidates.find((el) => el.offsetParent !== null && !el.disabled);
    if (button) { button.click(); return true; }
    return false;
  });

  // Make sure the calendar actually opened before scanning for the month/day.
  // A close animation or reflow can swallow the first click; retry a few times
  // with freshly read coordinates.
  for (let openTry = 0; openTry < 3; openTry += 1) {
    const header = await findCalendar();
    if (header && header.month && header.year) break;
    const fresh = await page.evaluate(() => {
      const fields = [...document.querySelectorAll("input.TUXTextInputCore-input, input[readonly]")]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
      const field = fields.find((el) => /^\d{4}-\d{2}-\d{2}$/.test(String(el.value || "").trim())) || fields[fields.length - 1];
      if (!field) return null;
      const rect = field.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).catch(() => null);
    if (!fresh) break;
    await page.mouse.click(fresh.x, fresh.y);
    await page.waitForTimeout(700);
    await debugLog(`  date: reopen attempt ${openTry + 1} at (${fresh.x},${fresh.y})`);
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const header = await findCalendar();
    await debugLog(`  date: iteration ${attempt + 1} header=${JSON.stringify(header)}`);
    if (header && header.month && header.year) {
      const sameMonth = header.year === targetYear && header.month === targetMonth;
      const ahead = header.year > targetYear || (header.year === targetYear && header.month > targetMonth);
      if (sameMonth) {
        if (await clickDay(targetDay)) { await page.waitForTimeout(500); await debugLog(`  date: clicked day ${targetDay}`); return true; }
        break;
      }
      if (ahead) break; // overshot; give up rather than guess
    }
    const advanced = await clickNextMonth();
    await debugLog(`  date: next-month clicked=${advanced}`);
    if (!advanced) break;
    await page.waitForTimeout(500);
  }

  // Fallback: click the day cell anywhere in a visible picker.
  const clicked = await clickDay(targetDay);
  await debugLog(`  date: fallback click day=${targetDay} -> ${clicked}`);
  if (!clicked) {
    // Save the open calendar so we can wire the exact selectors next time.
    await dumpScheduleDiagnostics(page, "date-calendar");
  }
  await page.waitForTimeout(500);
  return clicked;
}

async function controlApplied(page, index, value) {
  return page.evaluate((wanted) => {
    const normalize = (v) => (v || "").replace(/\s+/g, "").toLowerCase();
    const target = normalize(wanted.value);
    const selector = "input, select, [role='combobox'], [role='textbox'], button, [tabindex]";
    const element = document.querySelectorAll(selector)[wanted.index];
    if (element) {
      const tag = element.tagName.toLowerCase();
      let text = "";
      if (tag === "select") text = element.options?.[element.selectedIndex]?.textContent || element.value || "";
      else if (tag === "input") text = element.value || "";
      else text = element.textContent || "";
      if (normalize(text).includes(target)) return true;
    }
    // The schedule form re-renders between attempts, so the stored index can go
    // stale. Fall back to matching any visible input whose value equals the target.
    const timePattern = /^\d{1,2}:\d{2}$/;
    const datePattern = /\d{4}-\d{2}-\d{2}/;
    const isPattern = timePattern.test(wanted.value) || datePattern.test(wanted.value);
    if (isPattern) {
      return [...document.querySelectorAll("input")].some(
        (input) => input.offsetParent !== null && normalize(input.value) === target
      );
    }
    return false;
  }, { index, value });
}

async function dumpScheduleDiagnostics(page, tag) {
  try {
    const fs = require("fs/promises");
    const filePath = path.resolve(config.projectRoot, `last-schedule-${tag}.html`);
    const html = await page.content();
    await fs.writeFile(filePath, html, "utf8");
    await page
      .screenshot({ path: path.resolve(config.projectRoot, `last-schedule-${tag}.png`), fullPage: true })
      .catch(() => {});
    console.log(`Schedule diagnostics saved to ${filePath}`);
  } catch (error) {
    console.log(`Could not save schedule diagnostics: ${error.message}`);
  }
}

/** Append a line to a debug log in the project folder. */
async function debugLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(`[schedule-debug] ${message}`);
  try {
    const fs = require("fs/promises");
    await fs.appendFile(path.resolve(config.projectRoot, "schedule-debug.log"), line, "utf8");
  } catch {
    /* logging must never break the flow */
  }
}

async function resetDebugLog() {
  try {
    const fs = require("fs/promises");
    await fs.writeFile(path.resolve(config.projectRoot, "schedule-debug.log"), "", "utf8");
  } catch {
    /* ignore */
  }
}

/** Describe the currently visible schedule area for the log. */
async function describeScheduleState(page) {
  return page.evaluate(() => {
    const visible = (element) => element && element.offsetParent !== null;
    const valueOf = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === "input" || tag === "select") return (element.value || "").trim();
      return (element.textContent || "").trim().slice(0, 40);
    };
    const inputs = [...document.querySelectorAll("input")]
      .filter((element) => visible(element) && element.type !== "radio")
      .map((element) => ({ tag: element.tagName.toLowerCase(), value: valueOf(element), readonly: Boolean(element.readOnly) }));

    const panels = {
      timepicker: (() => {
        const picker = document.querySelector(".tiktok-timepicker-time-picker-container");
        if (!picker || picker.classList.contains("tiktok-timepicker-invisible")) return false;
        return picker.offsetParent !== null;
      })(),
      calendar: [...document.querySelectorAll("div")].some((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 120) return false;
        const text = (element.textContent || "").toLowerCase();
        if (/location|ubicaci|search|buscar/i.test(text)) return false;
        const hasMonth = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].some((name) => text.includes(name));
        if (!hasMonth) return false;
        const numbers = [...element.querySelectorAll("span,div,td,button")]
          .filter((el) => visible(el))
          .map((el) => (el.textContent || "").trim())
          .filter((entry) => /^\d{1,2}$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 31);
        return new Set(numbers).size >= 20;
      }),
    };

    const radio = document.querySelector("input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']");
    return {
      inputs,
      panels,
      scheduleRadioChecked: radio ? (radio.checked || radio.getAttribute("aria-checked") === "true") : null,
    };
  }).catch((error) => ({ error: error.message }));
}

/**
 * // MARKER: TIKTOK-WAIT-PROCESSING-v1
 * Espera a que TikTok termine de procesar el video. Mientras procesa, muestra
 * "Checking in progress..." y bloquea el selector de programacion.
 * Devuelve true si termino; false si se agoto el tiempo (no lanza).
 */
async function waitForVideoProcessing(page, maxMs = 600000) {
  // MARKER: TIKTOK-WAIT-READY-BY-STATE-v2
  // Espera por ESTADO real del editor, no por texto suelto ("uploading" da
  // falsos positivos y bloquea 20 min). Listo cuando:
  //   - aparece "Uploaded" (verde) en la ficha del video, o
  //   - ya no hay barra/aviso de subida activo y el caption existe.
  const isReady = async () => {
    try {
      return await page.evaluate(() => {
        const visible = (el) => el && el.offsetParent !== null;
        const txt = (document.body.innerText || "");
        const badTexts = [
          /checking in progress/i,
          /this will take about/i,
          /longer videos may take/i,
          /may take more time/i,
          /comprobando/i,
          /tardar[a]? aproximadamente/i,
        ];
        // 1. Si hay aviso explicito de procesado, NO esta listo.
        const leaves = [...document.querySelectorAll("span, div, p, [role='alert']")]
          .filter((el) => visible(el) && el.children.length === 0);
        for (const el of leaves) {
          const t = (el.textContent || "").trim();
          if (!t || t.length > 200) continue;
          if (badTexts.some((p) => p.test(t))) return false;
        }
        // 2. Senal positiva: "Uploaded" visible y sin "Uploading".
        const uploaded = /\buploaded\b/i.test(txt);
        const uploading = /\buploading\b|subiendo\.\.\./i.test(txt);
        if (uploaded && !uploading) return true;
        // 3. Si existe el input de caption y no hay aviso, damos por listo.
        const caption =
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('[data-e2e="caption-input"]');
        if (caption && !uploading) return true;
        return false;
      });
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + Math.max(60000, Number(maxMs) || 600000);
  let waited = 0;
  while (Date.now() < deadline) {
    if (await isReady()) {
      if (waited > 0) console.log("TikTok: video listo (Uploaded).");
      return true;
    }
    await page.waitForTimeout(3000);
    waited += 3000;
    if (waited % 60000 === 0) {
      console.log(`  ...TikTok sigue procesando (${Math.round(waited / 1000)}s)`);
    }
  }
  console.log("TikTok: no se confirmo el fin del procesado; se intenta programar igual.");
  return false;
}

async function setNativeSchedule(page, scheduledAt, timezone) {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid schedule date.");
  }

  await resetDebugLog();
  await debugLog(`setNativeSchedule target=${date.toISOString()} tz=${timezone || "(server local)"}`);

  await enableScheduleMode(page);
  await debugLog(`schedule mode enabled; state=${JSON.stringify(await describeScheduleState(page))}`);

  // Wait for the date/time controls to render after switching to Schedule.
  let controls = [];
  for (let attempt = 0; attempt < 10 && controls.length < 2; attempt += 1) {
    controls = await findScheduleControls(page);
    if (controls.length >= 2) break;
    await page.waitForTimeout(700);
  }
  await debugLog(`found ${controls.length} control(s): ${JSON.stringify(controls)}`);

  if (!controls.length) {
    await dumpScheduleDiagnostics(page, "no-controls");
    throw new Error(
      "Schedule mode was selected, but the time/date controls were not found. " +
      "TikTok's form may have changed; check the time and date dropdowns manually."
    );
  }

  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Re-locate the controls every attempt: opening a picker changes the DOM.
    const currentControls = await findScheduleControls(page);
    const controls2 = currentControls.length ? currentControls : controls;
    const timeValue = formatScheduleTime(date, timezone);
    const dateValue = formatScheduleDate(date, timezone);
    await debugLog(`attempt ${attempt + 1}: want time=${timeValue} date=${dateValue}; controls=${JSON.stringify(controls2)}`);

    const results = {};
    for (const control of controls2) {
      const value = control.kind === "time" ? timeValue : dateValue;
      results[control.kind] = await setControlValue(page, control, value);
      await debugLog(`  after ${control.kind}: ok=${results[control.kind]}; state=${JSON.stringify(await describeScheduleState(page))}`);
    }

    await page.waitForTimeout(900);

    // Read back the actual input values; only accept when they really match.
    const actual = await readScheduleInputValues(page);
    const reallySet = actual.time === timeValue && actual.date === dateValue;
    await debugLog(`attempt ${attempt + 1} readback: time=${actual.time} date=${actual.date} match=${reallySet}`);
    if (!reallySet) {
      lastError = `inputs did not stick (want time=${timeValue} date=${dateValue}, got time=${actual.time} date=${actual.date})`;
      // Close any lingering picker before retrying.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    // TikTok shows inline validation such as "Schedule at least 15 minutes in
    // advance". If the chosen time is too close, move forward and retry.
    lastError = await readTikTokScheduleError(page);
    if (!lastError) {
      return { timeValue, dateValue };
    }
    // // MARKER: TIKTOK-SCHEDULE-PROCESSING-v1: la fecha/hora ya cuadraban. Si lo unico que hay es el aviso de
    // que TikTok esta procesando el video, NO es un error de programacion:
    // dar por bueno y continuar (antes abortaba aqui y "no terminaba de subir").
    if (/checking in progress|this will take about|longer videos may take|may take more time|processing|comprobando/i.test(lastError)) {
      console.log(`TikTok esta procesando el video (${lastError}); se da por buena la programacion.`);
      return { timeValue, dateValue };
    }

    if (/15\s*minut|at least/i.test(lastError)) {
      date.setMinutes(date.getMinutes() + 20);
      console.log(`TikTok rejected the time (${lastError}); retrying at ${formatScheduleDate(date, timezone)} ${formatScheduleTime(date, timezone)}.`);
      continue;
    }

    // Unknown inline error: stop rather than guess.
    break;
  }

  await dumpScheduleDiagnostics(page, "fill-failed");
  throw new Error(`Could not fill the schedule date/time (time=${formatScheduleTime(date, timezone)}, date=${formatScheduleDate(date, timezone)}): ${lastError || "unknown reason"}.`);
}

/** Read the current values of the time and date inputs. */
async function readScheduleInputValues(page) {
  return page.evaluate(() => {
    const timePattern = /^\d{1,2}:\d{2}$/;
    const datePattern = /\d{4}-\d{2}-\d{2}/;
    const inputs = [...document.querySelectorAll("input")].filter(
      (element) => element.offsetParent !== null && element.type !== "radio"
    );
    let time = "";
    let date = "";
    for (const input of inputs) {
      const value = (input.value || "").trim();
      if (!time && timePattern.test(value)) time = value;
      if (!date && datePattern.test(value)) date = value;
    }
    return { time, date };
  }).catch(() => ({ time: "", date: "" }));
}

/** Read an inline validation error shown near the schedule controls. */
async function readTikTokScheduleError(page) {
  // MARKER: TIKTOK-SCHEDULE-PROCESSING-v1
  return page.evaluate(() => {
    // Avisos NORMALES de TikTok mientras procesa el video. NO son errores de la
    // fecha/hora y no deben abortar la programacion.
    const processingNoise = [
      /checking in progress/i,
      /this will take about/i,
      /longer videos may take/i,
      /may take more time/i,
      /processing/i,
      /comprobando/i,
      /tardar[a]? aproximadamente/i,
    ];
    const patterns = [/at least/i, /15\s*minut/i, /minut/i, /invalid/i, /must be/i, /no puede/i, /al menos/i];
    const candidates = [...document.querySelectorAll("[class*='error' i], [class*='Error'], [role='alert'], [class*='helper' i], span, div, p")]
      .filter((element) => element.offsetParent !== null && element.children.length === 0);
    for (const element of candidates) {
      const text = (element.textContent || "").trim();
      if (!text || text.length > 120) continue;
      // Ignora los avisos de procesado antes de comprobar patrones de error.
      if (processingNoise.some((pattern) => pattern.test(text))) continue;
      if (patterns.some((pattern) => pattern.test(text))) return text;
    }
    return "";
  }).catch(() => "");
}

function hasScheduleConfirmationCue(text) {
  return uiLabels.pattern("tiktokPublished").test(text || "");
}

function hasSuccessCueText(text) {
  const successPatterns = [
    uiLabels.pattern("tiktokPublished"),
  ];

  return successPatterns.some((pattern) => pattern.test(text));
}

function hasFailureCueText(text) {
  const failurePatterns = [
    uiLabels.pattern("tiktokFailed"),
  ];

  return failurePatterns.some((pattern) => pattern.test(text));
}

function isLikelyPublishApiResponse(response) {
  const url = response.url().toLowerCase();
  const method = response.request().method().toUpperCase();

  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return false;
  }

  const urlPatterns = [
    "/publish",
    "/post",
    "/aweme",
    "/upload",
    "/creator",
    "/studio",
    "/web/project",
    "/web/post",
  ];

  return urlPatterns.some((pattern) => url.includes(pattern));
}

function createPublishResponseTracker(page) {
  let publishApiSuccess = false;
  let publishApiFailure = null;

  const responseHandler = (response) => {
    if (!isLikelyPublishApiResponse(response)) {
      return;
    }

    const status = response.status();
    const url = response.url();

    if (status >= 200 && status < 300) {
      publishApiSuccess = true;
      console.log(`Publish API success: ${status} ${url}`);
      return;
    }

    if (status >= 400) {
      publishApiFailure = `Publish API returned ${status}: ${url}`;
      console.log(publishApiFailure);
    }
  };

  page.on("response", responseHandler);

  return {
    dispose() {
      page.off("response", responseHandler);
    },
    failure() {
      return publishApiFailure;
    },
    success() {
      return publishApiSuccess;
    },
  };
}

async function trySecondaryPublishConfirm(page) {
  const confirmTerms = uiLabels
    .terms("tiktokConfirm")
    .filter((term) => normalizeUiText(term) !== "post");
  const confirmPattern = new RegExp(confirmTerms.map(escapeRegExp).join("|"), "i");
  const scopedConfirmLocator = page
    .locator(
      [
        "[role='dialog']",
        "[aria-modal='true']",
        "[class*='modal' i]",
        "[class*='dialog' i]",
        "[class*='popover' i]",
        "[class*='drawer' i]",
      ].join(", ")
    )
    .locator("button, [role='button']")
    .filter({ hasText: confirmPattern });
  const scopedClicked = await clickFirstLikelyPublishLocator(
    page,
    scopedConfirmLocator,
    confirmTerms
  );
  if (scopedClicked) {
    await page.waitForTimeout(500);
    return true;
  }

  const confirmLocator = page.getByRole("button", {
    name: confirmPattern,
  });
  const clicked = await clickFirstLikelyPublishLocator(
    page,
    confirmLocator,
    confirmTerms
  );
  if (clicked) {
    await page.waitForTimeout(500);
    return true;
  }

  return false;
}

async function waitForPublishConfirmation(page, responseTracker) {
  const startedUrl = page.url();
  const tracker = responseTracker || createPublishResponseTracker(page);
  const ownsTracker = !responseTracker;
  let primaryRetryCount = 0;

  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await dismissInterferingOverlays(page);

      // MARKER: TIKTOK-RESTRICTED-MODAL-v3
      // El popup "Content may be restricted" aparece al pulsar Publicar y
      // tapa el boton. Hay que cerrarlo Y volver a pulsar Publicar, siempre
      // (no solo mientras queden reintentos). Tras cerrarlo, el boton tarda
      // unos instantes en volver a estar clickable.
      if (await dismissRestrictedContentModal(page)) {
        await page.waitForTimeout(700);
        const publishReady = await waitForPublishClickable(page, 8000);
        const reclicked = await tryClickPublishButton(page);
        console.log(
          reclicked
            ? "Popup restringido cerrado y Publicar pulsado de nuevo."
            : publishReady
              ? "Popup restringido cerrado; el boton esta listo pero no consegui pulsarlo."
              : "Popup restringido cerrado, pero el boton Publicar no volvio a estar disponible."
        );
        if (reclicked) {
          primaryRetryCount = 0;
          await page.waitForTimeout(1500);
          continue;
        }
      }

      // MARKER: TIKTOK-RESTRICTED-MODAL-v2
      // El popup "Content may be restricted" aparece al pulsar Publicar y
      // tapa el boton. Hay que cerrarlo Y volver a pulsar Publicar, siempre
      // (no solo mientras queden reintentos).
      if (await dismissRestrictedContentModal(page)) {
        await page.waitForTimeout(700);
        const reclicked = await tryClickPublishButton(page);
        console.log(
          reclicked
            ? "Popup restringido cerrado y Publicar pulsado de nuevo."
            : "Popup restringido cerrado, pero no encontre el boton Publicar."
        );
        if (reclicked) {
          primaryRetryCount = 0;
          await page.waitForTimeout(1500);
          continue;
        }
      }

      const bodyText = await page
        .locator("body")
        .innerText()
        .then((value) => value || "")
        .catch(() => "");
      if (hasFailureCueText(bodyText)) {
        return {
          ok: false,
          reason: "TikTok displayed an error after publish click.",
        };
      }

      const publishApiFailure = tracker.failure();
      if (publishApiFailure) {
        return {
          ok: false,
          reason: publishApiFailure,
        };
      }

      if (tracker.success()) {
        return {
          ok: true,
          reason: "Publish API call succeeded.",
        };
      }

      if (hasSuccessCueText(bodyText)) {
        return {
          ok: true,
          reason: "Success confirmation text found.",
        };
      }

      await trySecondaryPublishConfirm(page);

      if (
        primaryRetryCount < 2 &&
        attempt > 0 &&
        attempt % 5 === 0 &&
        page.url().includes("/upload")
      ) {
        console.log("No publish confirmation yet; retrying the primary TikTok Post button.");
        // // MARKER: TIKTOK-RESTRICTED-MODAL-v1: cerrar el modal de contenido restringido antes de reintentar.
        const retried = await tryClickPublishButton(page);
        if (retried) {
          primaryRetryCount += 1;
          await page.waitForTimeout(1000);
        }
      }

      const urlChanged = page.url() !== startedUrl;
      if (urlChanged && !page.url().includes("/upload")) {
        return {
          ok: true,
          reason: `Navigation changed to ${page.url()}.`,
        };
      }

      await page.waitForTimeout(2000);
    }

    return {
      ok: false,
      reason: "No reliable publish confirmation observed within timeout.",
    };
  } finally {
    if (ownsTracker) {
      tracker.dispose();
    }
  }
}

async function waitForUploadReady(page) {
  const deadline = Date.now() + 180000;
  const editorSelectors = [
    'div[contenteditable="true"]',
    'textarea[placeholder*="caption" i]',
    '[data-e2e="video-upload"]',
    '[data-e2e="caption-input"]',
  ];
  while (Date.now() < deadline) {
    for (const selector of editorSelectors) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0) > 0) {
        await page.waitForTimeout(1500);
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
}

async function holdBrowserBeforeClose(page, holdMs, reason) {
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    return;
  }

  console.log(`Holding browser for ${holdMs}ms (${reason}).`);
  await page.waitForTimeout(holdMs).catch(() => { });
}

async function closeCurrentLoginContext() {
  if (!loginSessionContext) return false;
  const context = loginSessionContext;
  const accountId = loginSessionAccountId;
  // Save the session cookies for yt-dlp BEFORE closing: Playwright hands them
  // to us directly, so no DPAPI decryption is involved. Best effort only.
  if (accountId) {
    try {
      const jar = require("./cookie-jar");
      const saved = await jar.saveCookiesFromContext(context, accountId);
      if (saved.ok) {
        console.log(`Saved ${saved.count} cookies for account ${accountId}.`);
      } else {
        console.log(`Could not save cookies for ${accountId}: ${saved.error}`);
      }
    } catch (error) {
      console.log(`Could not save cookies for ${accountId}: ${error.message}`);
    }
  }
  loginSessionContext = null;
  loginSessionAccountId = null;
  tempMailSetupPage = null;
  tempMailCaptureHandler = null;
  await context.close().catch(() => { });
  return true;
} // CK[dump]

async function openLoginContextForAccount(accountId) {
  await requireAccount(accountId);
  if (loginSessionContext && loginSessionAccountId !== accountId) {
    await closeCurrentLoginContext();
  }
  if (loginSessionContext) {
    return { context: loginSessionContext, alreadyOpen: true };
  }

  const context = await openPersistentContext(accountId);
  loginSessionContext = context;
  loginSessionAccountId = accountId;
  context.on("close", () => {
    if (loginSessionContext === context) {
      loginSessionContext = null;
      loginSessionAccountId = null;
      tempMailSetupPage = null;
      tempMailCaptureHandler = null;
      tempMailSetupState = {
        ...tempMailSetupState,
        open: false,
        stage: tempMailSetupState.stage === "ready" ? "ready" : "closed",
        message: tempMailSetupState.stage === "ready"
          ? "Temporary email saved. The Chromium window is closed."
          : "The Chromium setup window was closed.",
      };
    }
  });
  return { context, alreadyOpen: false };
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);
  if (alreadyOpen) {
    return { ok: true, alreadyOpen: true };
  }

  const page = context.pages()[0] || (await context.newPage());
  await gotoUploadPage(page);
  return { ok: true, alreadyOpen: false, url: page.url() };
}

/**
 * Dashboard login: respond immediately and open the window in the background,
 * so a slow or failing browser launch never tears down the request.
 * Errors are exposed through getLoginSessionStatus().
 */
let loginLaunchState = { launching: false, error: "" };

function startDashboardLoginSessionDetached() {
  loginLaunchState = { launching: true, error: "" };
  void (async () => {
    try {
      const activeAccount = await getActiveAccount();
      const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);
      if (alreadyOpen) { loginLaunchState = { launching: false, error: "" }; return; }
      const page = context.pages()[0] || (await context.newPage());
      await gotoUploadPage(page);
      loginLaunchState = { launching: false, error: "" };
    } catch (error) {
      loginLaunchState = { launching: false, error: error.message };
      console.error(`[tiktok-login] ${error.stack || error.message}`);
    }
  })();
  return { ok: true, opening: true, message: "Abriendo Chromium..." };
}

async function captureTempMailForAccount(accountId) {
  if (!tempMailSetupPage || tempMailSetupPage.isClosed()) {
    tempMailSetupPage = loginSessionContext?.pages()
      .find((page) => page.url().includes("eztempmail.com")) || null;
  }
  if (!tempMailSetupPage || tempMailSetupPage.isClosed()) {
    throw new Error("The EZ Temp Mail tab is not open.");
  }
  tempMailSetupState = {
    ...tempMailSetupState,
    open: true,
    stage: "capturing-email",
    message: "Waiting for EZ Temp Mail to provide the mailbox and recovery key.",
  };
  const credentials = await waitForTempMailCredentials(tempMailSetupPage);
  if (typeof tempMailCaptureHandler !== "function") {
    throw new Error("The local credential vault is not connected to this setup session.");
  }
  await tempMailCaptureHandler(credentials);
  tempMailSetupState = {
    ...tempMailSetupState,
    accountId,
    open: true,
    stage: "ready",
    message: "Temporary email and recovery data saved in the encrypted local vault.",
    email: credentials.email,
    completedAt: new Date().toISOString(),
  };
  return credentials;
}

async function startTempMailSetupSession({ accountId, onCaptured }) {
  const account = await requireAccount(accountId);
  if (
    tempMailSetupState.accountId === account.id &&
    ["opening-browser", "capturing-email"].includes(tempMailSetupState.stage)
  ) {
    return { ok: true, alreadyOpen: true, status: getTempMailSetupStatus() };
  }

  const { context } = await openLoginContextForAccount(account.id);
  tempMailCaptureHandler = onCaptured;
  tempMailSetupState = {
    accountId: account.id,
    open: true,
    stage: "opening-browser",
    message: "Opening EZ Temp Mail and TikTok in two Chromium tabs.",
    email: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  void (async () => {
    try {
      const tabs = await openOnboardingTabs(context, {
        onTempMailPage: (page) => {
          tempMailSetupPage = page;
        },
      });
      tempMailSetupPage = tabs.tempMailPage;
      await captureTempMailForAccount(account.id);
    } catch (error) {
      tempMailSetupState = {
        ...tempMailSetupState,
        open: Boolean(loginSessionContext) && loginSessionAccountId === account.id,
        stage: "needs-attention",
        message: `${error.message} Complete any visible browser check, then use Retry capture.`,
      };
    }
  })();

  return { ok: true, alreadyOpen: false, status: getTempMailSetupStatus() };
}

async function retryTempMailCapture() {
  const accountId = tempMailSetupState.accountId;
  if (!accountId) throw new Error("No temporary email setup has been started.");
  if (["opening-browser", "capturing-email"].includes(tempMailSetupState.stage)) {
    return { ok: true, alreadyRunning: true, status: getTempMailSetupStatus() };
  }
  void captureTempMailForAccount(accountId).catch((error) => {
    tempMailSetupState = {
      ...tempMailSetupState,
      stage: "needs-attention",
      message: `${error.message} Complete any visible browser check, then use Retry capture.`,
    };
  });
  return { ok: true, alreadyRunning: false, status: getTempMailSetupStatus() };
}

function getTempMailSetupStatus() {
  return { ...tempMailSetupState };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("tiktok", activeAccount.id);
  return {
    open: Boolean(loginSessionContext) && loginSessionAccountId === activeAccount.id,
    saved,
    launching: loginLaunchState.launching,
    error: loginLaunchState.error,
  };
}

async function closeLoginSession() {
  const closed = await closeCurrentLoginContext();
  if (!closed) {
    return { ok: true, alreadyClosed: true };
  }
  tempMailSetupState = {
    ...tempMailSetupState,
    open: false,
    stage: tempMailSetupState.stage === "ready" ? "ready" : "closed",
    message: tempMailSetupState.stage === "ready"
      ? "Temporary email saved. The Chromium window is closed."
      : "The Chromium setup window was closed.",
  };
  return { ok: true, alreadyClosed: false };
}

async function startLoginSessionCli() {
  const result = await startLoginSession();

  console.log("");
  console.log("Log in to TikTok in the opened browser window.");
  console.log("After login is complete, press Ctrl+C in this terminal.");
  console.log("Your session will be reused for future automated posts.");
  console.log("");

  if (result.alreadyOpen) {
    return;
  }

  await new Promise(() => {
    // Keep process alive until manual interruption.
  });
}

async function uploadVideo({ videoPath, coverPath, caption, source, accountId, onPhase, scheduledAt, scheduleTimezone, location, aiGenerated, page: sharedPage, context: sharedContext, reuseBrowser}) {
  const absoluteVideoPath = path.resolve(videoPath);
  // MARKER: TIKTOK-REUSE-BROWSER-v1
  // Con reuseBrowser la pagina y el contexto vienen del lote (un solo
  // navegador para todos los videos) y NO se cierran aqui.
  const ownsBrowser = !(reuseBrowser && sharedPage && sharedContext);
  const context = ownsBrowser
    ? await openContextWithRetry(accountId)
    : sharedContext;
  const page = ownsBrowser
    ? context.pages()[0] || (await context.newPage())
    : sharedPage;
  let closeHoldMs = 0;
  let publishResponseTracker = null;
  const scheduleMode = Boolean(scheduledAt);
  let lastScheduleError = null; // MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1

  try {
    await onPhase?.("browser-started");
    await gotoUploadPage(page);
    await setVideoFile(page, absoluteVideoPath);
    await waitForUploadReady(page);
    if (coverPath) {
      await onPhase?.("cover-setting");
      await setTikTokCover(page, coverPath);
    }
    await setCaption(page, caption || config.defaultCaption);
    if (location) {
      await setLocation(page, location).catch((error) => {
        console.log(`Location step failed softly: ${error.message}`);
      });
    }
    await addDefaultSound(page, source).catch((error) => {
      console.log(`Sound step failed softly: ${error.message}`);
    });
    await disableShortContentCheck(page);
    if (aiGenerated) {
      await setAiGeneratedDisclosure(page, true).catch((error) => {
        console.log(`AI disclosure step failed softly: ${error.message}`);
      });
    }

    if (scheduleMode) {
      // MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1
      // Espera por estado (no por texto) antes de tocar la programacion.
      await waitForVideoProcessing(page);
      // Asegura que el radio "Schedule" quedo activo antes de programar.
      await ensureScheduleRadioOn(page);
      await onPhase?.("schedule-setting");
      let scheduleResult = null;
      let scheduleError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          scheduleResult = await setNativeSchedule(page, scheduledAt, scheduleTimezone);
          break;
        } catch (error) {
          scheduleError = error;
          // Si sigue procesando o el selector no responde, espera y reintenta.
          console.log(`Programacion intento ${attempt + 1} fallido: ${error.message}`);
          await waitForVideoProcessing(page, 120000).catch(() => {});
          await page.waitForTimeout(5000);
        }
      }
      if (!scheduleResult) {
        lastScheduleError = scheduleError || new Error("No se pudo programar la fecha/hora.");
        throw lastScheduleError;
      }
      const { timeValue, dateValue } = scheduleResult;
      console.log(`TikTok schedule set to ${dateValue} ${timeValue}.`);
    }

    publishResponseTracker = createPublishResponseTracker(page);
    await onPhase?.(scheduleMode ? "schedule-clicking" : "publish-clicking");
    await (scheduleMode ? clickScheduleButton(page) : clickPublish(page));
    await onPhase?.(scheduleMode ? "schedule-submitted" : "publish-submitted");
    const confirmation = await waitForPublishConfirmation(page, publishResponseTracker);
    if (!confirmation.ok) {
      throw new Error(`${scheduleMode ? "Schedule" : "Publish"} verification failed: ${confirmation.reason}`);
    }
    await onPhase?.(scheduleMode ? "schedule-confirmed" : "publish-confirmed");

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-success.png"
    );
    await page
      .screenshot({ path: successScreenshotPath, fullPage: true })
      .catch(() => { });

    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return { ok: true, scheduled: scheduleMode };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    if (publishResponseTracker) {
      publishResponseTracker.dispose();
    }
    // MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1
    // Si fallo la PROGRAMACION, no cerrar: deja la ventana abierta para ver
    // el motivo y guarda la captura. En publicacion normal si se cierra.
    const failedSchedule = Boolean(lastScheduleError);
    if (ownsBrowser && !(scheduleMode && failedSchedule && config.keepBrowserOnScheduleFail !== false)) {
      await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
      await context.close();
    } else if (scheduleMode && failedSchedule) {
      console.log("Programacion fallida: se deja el navegador ABIERTO para revisarlo.");
    } else if (!ownsBrowser) {
      // Navegador compartido: nunca lo cierra el uploader.
    }
  }
}

module.exports = {
  startLoginSession: startLoginSessionCli,
  startDashboardLoginSession: startDashboardLoginSessionDetached,
  startTempMailSetupSession,
  retryTempMailCapture,
  getTempMailSetupStatus,
  getLoginSessionStatus,
  closeLoginSession,
  uploadVideo,
  openContextWithRetry,
  _private: {
    ensureScheduleRadioOn,
    dismissRestrictedContentModal,
    getPublishCandidateScore,
    isLikelyPublishCandidateInfo,
    formatScheduleDate,
    formatScheduleTime,
    splitTime,
    setNativeSchedule,
    readTikTokScheduleError,
    findScheduleControls,
    setTikTokTime,
    setTikTokDate,
    setAiGeneratedDisclosure,
    setTikTokCover,
  },
};
