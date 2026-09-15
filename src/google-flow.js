const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { chromium } = require("playwright");
const { config } = require("./config");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");

const PROMPT_INPUT_SELECTORS = [
  'div[role="textbox"][data-slate-editor="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'textarea:not([name="g-recaptcha-response"])',
  'textarea[aria-label*="prompt" i]',
];
const SUBMIT_BUTTON_SELECTORS = [
  "button:has(.google-symbols:text-is('arrow_forward'))",
  "button:has(mat-icon:text-is('arrow_forward'))",
  "button:has(i:text-is('arrow_forward'))",
];
const VIDEO_SETTINGS_SELECTORS = [
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_16_9'))",
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_9_16'))",
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_square'))",
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_portrait'))",
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_landscape'))",
  "button[aria-haspopup='menu']:has(.google-symbols:text-is('crop_original'))",
  "button.settings-trigger-button:not([hidden])",
];
const VIDEO_OPTION_SELECTORS = [
  "[role='tab'][id$='-trigger-VIDEO']",
  "[role='tab'][aria-controls$='-content-VIDEO']",
  "[role='menu'] [role='tab']:has(.google-symbols:text-is('play_circle'))",
  "[role='menu'] [role='tab']:has(.google-symbols:text-is('videocam'))",
  ".cdk-overlay-pane:visible [role='radio']:has(.google-symbols:text-is('videocam'))",
];
const PORTRAIT_ASPECT_SELECTORS = [
  "[role='tab'][id$='-trigger-PORTRAIT']",
  "[role='tab'][aria-controls$='-content-PORTRAIT']",
  "[role='menu'] [role='tab']:has(.google-symbols:text-is('crop_9_16'))",
  ".cdk-overlay-pane:visible [role='radio']:has(.google-symbols:text-is('crop_9_16'))",
  "[role='menu'] [role='radio']:has(.google-symbols:text-is('crop_9_16'))",
];
const AGENT_CHAT_CLOSE_SELECTORS = [
  "flow-agent-panel button:has(.google-symbols:text-is('close'))",
  "div:has(button:has(.google-symbols:text-is('edit_square'))) button:has(.google-symbols:text-is('close'))",
];
const execFileAsync = promisify(execFile);

let loginContext = null;
let loginAccountId = null;
const accountLocks = new Map();
const debugContexts = new Map();

async function closeDebugContext(accountId) {
  const entry = debugContexts.get(accountId);
  if (!entry) return false;
  debugContexts.delete(accountId);
  clearTimeout(entry.timer);
  await entry.context.close().catch(() => {});
  return true;
}

function retainDebugContext(accountId, context) {
  const holdMs = Math.max(0, Math.min(Number(config.flowFailureHoldMs) || 0, 5 * 60 * 1000));
  if (!holdMs || config.headless) return false;
  const timer = setTimeout(() => closeDebugContext(accountId).catch(() => {}), holdMs);
  timer.unref?.();
  debugContexts.set(accountId, { context, timer });
  context.once("close", () => {
    const entry = debugContexts.get(accountId);
    if (entry?.context === context) {
      clearTimeout(entry.timer);
      debugContexts.delete(accountId);
    }
  });
  return true;
}

async function openPersistentContext(accountId) {
  await closeDebugContext(accountId);
  const profileDir = await getPlatformProfileDir("google-flow", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  const options = {
    headless: config.headless,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try { return await chromium.launchPersistentContext(profileDir, options); }
  catch (error) {
    const candidates = process.platform === "win32"
      ? [path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"), path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe")]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
    const chrome = candidates.find((candidate) => candidate && require("fs").existsSync(candidate));
    if (!chrome) throw error;
    return chromium.launchPersistentContext(profileDir, { ...options, executablePath: chrome });
  }
}

async function startLoginSession() {
  const account = await getActiveAccount();
  await closeDebugContext(account.id);
  if (loginContext && loginAccountId !== account.id) {
    await loginContext.close().catch(() => {});
    loginContext = null;
    loginAccountId = null;
  }
  if (loginContext) return { ok: true, alreadyOpen: true };

  loginContext = await openPersistentContext(account.id);
  loginAccountId = account.id;
  const page = loginContext.pages()[0] || await loginContext.newPage();
  const context = loginContext;
  context.on("close", () => {
    if (loginContext === context) {
      loginContext = null;
      loginAccountId = null;
    }
  });
  await page.goto(config.googleFlowUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  return { ok: true, alreadyOpen: false, url: page.url(), accountId: account.id };
}

async function getSessionStatus() {
  const account = await getActiveAccount();
  return {
    accountId: account.id,
    open: (Boolean(loginContext) && loginAccountId === account.id) || debugContexts.has(account.id),
    saved: await hasSavedPlatformSession("google-flow", account.id),
  };
}

async function closeLoginSession() {
  const account = await getActiveAccount();
  const debugClosed = await closeDebugContext(account.id);
  if (!loginContext) return { ok: true, alreadyClosed: !debugClosed };
  const context = loginContext;
  loginContext = null;
  loginAccountId = null;
  await context.close().catch(() => {});
  return { ok: true, alreadyClosed: false };
}

async function visibleCandidates(locator, limit = 20) {
  const matches = [];
  let count = 0;
  try { count = Math.min(await locator.count(), limit); } catch { return matches; }
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (await candidate.isVisible()) matches.push(candidate);
    } catch {}
  }
  return matches;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const matches = await visibleCandidates(locator);
    if (matches.length) return matches[0];
  }
  return null;
}

async function firstActionable(locators) {
  for (const locator of locators) {
    const matches = await visibleCandidates(locator);
    for (const candidate of matches) {
      try {
        if (await candidate.isEnabled()) return candidate;
      } catch {}
    }
  }
  return null;
}

async function waitForActionable(locators, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await firstActionable(locators);
    if (candidate) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function clickFirst(locators) {
  const locator = await firstActionable(locators);
  if (!locator) return false;
  await locator.click({ timeout: 5000 });
  return true;
}

async function selectRequiredChoice(page, option, errorMessage) {
  const selected = async () => {
    const [checked, tabSelected, state] = await Promise.all([
      option.getAttribute("aria-checked"),
      option.getAttribute("aria-selected"),
      option.getAttribute("data-state"),
    ]);
    return checked === "true" || tabSelected === "true" || state === "active" || state === "checked";
  };
  if (!(await selected())) await option.click({ timeout: 5000 });
  const role = await option.getAttribute("role");
  if (role !== "radio" && role !== "tab") return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await selected()) return;
    await page.waitForTimeout(250);
  }
  throw new Error(errorMessage);
}

function promptLocators(page) {
  return PROMPT_INPUT_SELECTORS.map((selector) => page.locator(selector));
}

async function locatePromptInput(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prompt = await firstVisible(promptLocators(page));
    if (prompt) return prompt;
    await page.waitForTimeout(300);
  }
  return null;
}

async function dismissBlockingDialog(page) {
  const dialog = await firstVisible([page.locator("[role='dialog']")]);
  if (!dialog) return false;
  const close = await firstActionable([
    dialog.locator("button:has(.google-symbols:text-is('close'))"),
    dialog.getByRole("button", { name: /close|dismiss|cerrar/i }),
  ]);
  if (close) {
    await close.click({ timeout: 3000 }).catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(500);
  return true;
}

async function ensureEditor(page) {
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error("Google Flow login is required. Open the Flow login window from the dashboard once.");
  }
  await clickFirst([
    page.getByRole("button", { name: /create with google flow|try (in )?google flow|crear con google flow/i }),
    page.getByRole("link", { name: /create with google flow|try (in )?google flow|crear con google flow/i }),
  ]).catch(() => false);
  await page.waitForTimeout(1200);
  if (/accounts\.google\.com/.test(page.url())) {
    throw new Error("Google Flow login expired. Open the Flow login window and sign in again.");
  }

  await dismissBlockingDialog(page).catch(() => false);
  let prompt = await locatePromptInput(page, 5000);
  if (prompt) return prompt;

  const created = await clickFirst([
    page.getByRole("button", { name: /new project|create project|nuevo proyecto|crear proyecto/i }),
    page.getByRole("link", { name: /new project|create project|nuevo proyecto|crear proyecto/i }),
  ]);
  if (created) await page.waitForTimeout(2000);
  await dismissBlockingDialog(page).catch(() => false);
  prompt = await locatePromptInput(page, 20000);
  if (!prompt) {
    throw new Error(`Google Flow prompt editor was not detected at ${page.url()}. The browser will remain open for inspection.`);
  }
  return prompt;
}

function videoSettingsLocators(page) {
  return VIDEO_SETTINGS_SELECTORS.map((selector) => page.locator(selector));
}

async function mediaSettingsVisible(page) {
  return Boolean(await firstVisible(videoSettingsLocators(page)));
}

async function exitAgentMode(page) {
  if (await mediaSettingsVisible(page)) return false;
  let acted = false;
  for (let attempt = 0; attempt < 3 && !(await mediaSettingsVisible(page)); attempt += 1) {
    const panelClose = await firstActionable(AGENT_CHAT_CLOSE_SELECTORS.map((selector) => page.locator(selector)));
    if (panelClose) {
      await panelClose.click({ timeout: 5000 });
      acted = true;
      await page.waitForTimeout(500);
    }

    const activeChip = await firstActionable([
      page.locator("button.agent-mode-chip[aria-pressed='true']"),
    ]);
    if (activeChip) {
      await activeChip.click({ timeout: 5000 });
      acted = true;
      await page.waitForTimeout(1000);
      continue;
    }

    const legacyAgentToggle = await firstActionable([
      page.locator(
        "div:has(div[role='textbox'][data-slate-editor='true']):has(button:has(.google-symbols:text-is('arrow_forward'))) button:has(span.content)"
      ),
    ]);
    if (legacyAgentToggle) {
      await legacyAgentToggle.click({ timeout: 5000 });
      acted = true;
      await page.waitForTimeout(1000);
      continue;
    }
    break;
  }
  return acted;
}

async function closeGenerationOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const overlays = page.locator(".cdk-overlay-pane:visible, [role='menu']:visible").filter({
      has: page.locator("[role='radiogroup'], [role='menuitem'], [role='tablist']"),
    });
    if (!(await overlays.count())) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
}

async function selectVideoMode(page) {
  await dismissBlockingDialog(page).catch(() => false);
  await exitAgentMode(page);
  const trigger = await waitForActionable(videoSettingsLocators(page), 10000);
  if (trigger) {
    await trigger.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const radioPane = page.locator(".cdk-overlay-pane:visible").filter({
      has: page.locator("[role='radiogroup']"),
    }).last();
    const videoOption = await waitForActionable([
      radioPane.locator("[role='radio']:has(.google-symbols:text-is('videocam'))"),
      ...VIDEO_OPTION_SELECTORS.map((selector) => page.locator(selector)),
      page.getByRole("tab", { name: /^video$|^v.deo$/i }),
      page.getByRole("menuitemradio", { name: /^video$|^v.deo$/i }),
      page.getByRole("option", { name: /^video$|^v.deo$/i }),
      page.getByRole("menuitem", { name: /^video$|^v.deo$/i }),
    ], 8000);
    if (!videoOption) throw new Error("Google Flow opened generation settings but the Video option was not detected.");
    await selectRequiredChoice(page, videoOption, "Google Flow Video mode did not remain selected after the click.");

    const portraitOption = await waitForActionable([
      ...PORTRAIT_ASPECT_SELECTORS.map((selector) => page.locator(selector)),
      page.getByRole("tab", { name: /9\s*:\s*16|portrait|vertical/i }),
      page.getByRole("radio", { name: /9\s*:\s*16|portrait|vertical/i }),
    ], 8000);
    if (!portraitOption) {
      throw new Error("Google Flow 9:16 portrait controls were not detected. Generation was stopped to prevent a horizontal TikTok video.");
    }
    await selectRequiredChoice(page, portraitOption, "Google Flow did not keep the 9:16 portrait aspect selected.");

    const oneOutput = await firstVisible([
      radioPane.locator("[role='radio']").filter({ hasText: /^(x1|1x)$/i }),
      page.locator("[role='tab']:visible").filter({ hasText: /^(x1|1x)$/i }),
    ]);
    if (oneOutput) {
      await selectRequiredChoice(page, oneOutput, "Google Flow output count did not remain set to one video per prompt.");
    }
    await closeGenerationOverlays(page);
    await page.waitForTimeout(750);
    return true;
  }

  const directVideo = await firstActionable([
    page.getByRole("button", { name: /^video$|video generation|generation type.*video/i }),
    page.getByRole("tab", { name: /^video$|^v.deo$/i }),
  ]);
  if (directVideo) {
    await directVideo.click({ timeout: 5000 });
    await page.waitForTimeout(800);
    const portraitOption = await waitForActionable([
      ...PORTRAIT_ASPECT_SELECTORS.map((selector) => page.locator(selector)),
      page.getByRole("tab", { name: /9\s*:\s*16|portrait|vertical/i }),
      page.getByRole("radio", { name: /9\s*:\s*16|portrait|vertical/i }),
    ], 5000);
    if (!portraitOption) {
      throw new Error("Google Flow 9:16 portrait controls were not detected. Generation was stopped to prevent a horizontal TikTok video.");
    }
    await selectRequiredChoice(page, portraitOption, "Google Flow did not keep the 9:16 portrait aspect selected.");
    await closeGenerationOverlays(page);
    return true;
  }

  throw new Error(
    "Google Flow video controls are unavailable. Turn off Agent mode in the prompt box, close any welcome dialog, and retry while this browser remains open."
  );
}

async function addReference(page, promptInput, referencePath) {
  if (!referencePath) return;
  await fs.access(referencePath);
  const root = promptInput.locator("xpath=ancestor::*[self::flow-prompt-box or self::flow-creative-agent-prompt-box or self::form][1]");
  const scoped = await root.count() ? root : page;
  let inputs = scoped.locator('input[type="file"][accept*="image" i], input[type="file"]');
  if (!(await inputs.count())) inputs = page.locator('input[type="file"][accept*="image" i]');
  if (!(await inputs.count())) throw new Error("Google Flow reference-image control was not detected.");
  await inputs.first().setInputFiles(referencePath);
  await page.waitForTimeout(1500);
}

async function fillPromptInput(page, promptInput, text) {
  await promptInput.click({ timeout: 5000 });
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await page.keyboard.press(selectAll);
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
  await page.waitForTimeout(500);
  const actual = await promptInput.evaluate((element) => {
    if ("value" in element) return String(element.value || "");
    return String(element.innerText || element.textContent || "");
  });
  const normalizedActual = actual.replace(/\s+/g, " ").trim();
  const normalizedExpected = text.replace(/\s+/g, " ").trim();
  if (!normalizedActual || !normalizedActual.includes(normalizedExpected.slice(0, 120))) {
    throw new Error("Google Flow prompt editor did not accept the generated prompt.");
  }
}

async function submitPrompt(page, promptInput) {
  const button = await waitForActionable([
    ...SUBMIT_BUTTON_SELECTORS.map((selector) => page.locator(selector)),
    page.getByRole("button", { name: /^(create|generate|crear|generar)$/i }),
  ], 10000);
  if (button) {
    await button.click({ timeout: 5000 });
    return "button";
  }
  await promptInput.press("Enter");
  return "enter";
}

async function collectFlowMedia(page) {
  return page.evaluate(() => {
    const media = [];
    const videos = Array.from(document.querySelectorAll("video"));
    for (let videoIndex = 0; videoIndex < videos.length; videoIndex += 1) {
      const video = videos[videoIndex];
      const urls = [
        video.getAttribute("src"),
        video.getAttribute("poster"),
        video.currentSrc,
        ...Array.from(video.querySelectorAll("source[src]")).map((source) => source.getAttribute("src")),
      ].filter(Boolean);
      let uuid = "";
      let stableUrl = "";
      for (const raw of urls) {
        try {
          const parsed = new URL(raw, location.href);
          const name = parsed.searchParams.get("name");
          const uuidMatch = `${name || ""} ${parsed.pathname}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (uuidMatch) uuid = uuidMatch[0];
          if (!stableUrl) stableUrl = `${parsed.origin}${parsed.pathname}`;
          if (uuid) break;
        } catch {}
      }
      const identity = uuid ? `uuid:${uuid}` : (stableUrl ? `media:${stableUrl}` : "");
      if (identity) media.push({ identity, uuid, stableUrl, videoIndex, tag: "video" });
    }
    return media.filter((item, index, values) => values.findIndex((other) => other.identity === item.identity) === index);
  });
}

async function waitForNewMedia(page, baseline, timeoutMs) {
  const existing = new Set(baseline.map((item) => item.identity));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await collectFlowMedia(page);
    const created = current.find((item) => !existing.has(item.identity));
    if (created) return created;
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/generation failed|could not generate|something went wrong|no se pudo generar|error al generar/i.test(bodyText)) {
      throw new Error("Google Flow reported that video generation failed.");
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("Google Flow did not expose a new video result within 15 minutes.");
}

async function findMediaElement(page, media) {
  const videos = page.locator("video");
  const count = await videos.count();
  for (let index = 0; index < count; index += 1) {
    const video = videos.nth(index);
    const identity = await video.evaluate((element) => {
      const urls = [
        element.getAttribute("src"),
        element.getAttribute("poster"),
        element.currentSrc,
        ...Array.from(element.querySelectorAll("source[src]")).map((source) => source.getAttribute("src")),
      ].filter(Boolean);
      let uuid = "";
      let stableUrl = "";
      for (const raw of urls) {
        try {
          const parsed = new URL(raw, location.href);
          const name = parsed.searchParams.get("name");
          const uuidMatch = `${name || ""} ${parsed.pathname}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (uuidMatch) uuid = uuidMatch[0];
          if (!stableUrl) stableUrl = `${parsed.origin}${parsed.pathname}`;
          if (uuid) break;
        } catch {}
      }
      return uuid ? `uuid:${uuid}` : (stableUrl ? `media:${stableUrl}` : "");
    }).catch(() => "");
    if (identity === media.identity) return video;
  }
  return null;
}

function assertNineSixteenDimensions(dimensions) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!width || !height) {
    throw new Error("The downloaded Flow video dimensions could not be verified as 9:16 portrait.");
  }
  const ratio = width / height;
  if (width >= height || (width * 16) !== (height * 9)) {
    throw new Error(`Flow produced ${width}x${height}, not 9:16 portrait. The video was saved for review but was not sent to TikTok.`);
  }
  return { width, height, ratio };
}

async function validateDownloadedVideo(filePath) {
  const handle = await fs.open(filePath, "r");
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const isIsoMedia = header.subarray(4, 8).toString("ascii") === "ftyp";
  const isWebM = header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isIsoMedia && !isWebM) throw new Error("Flow downloaded a file that is not an MP4/MOV or WebM video.");

  let stdout;
  try {
    ({ stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height",
      "-of", "json",
      filePath,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("FFprobe is required to verify that the downloaded Flow video is readable and exactly 9:16 portrait. Install FFmpeg and add ffprobe to PATH.");
    }
    throw new Error(`FFprobe could not validate the Flow video: ${error.message}`);
  }
  let probe;
  try { probe = JSON.parse(stdout); } catch { throw new Error("FFprobe returned an invalid response for the Flow video."); }
  const stream = probe?.streams?.[0];
  if (!stream?.codec_name || !Number(stream.width) || !Number(stream.height)) {
    throw new Error("The downloaded Flow file does not contain a readable video stream.");
  }
  return { container: isWebM ? "webm" : "iso-media", stream };
}

async function downloadVideoAsset(page, media, targetPath) {
  const mediaElement = await findMediaElement(page, media);
  if (!mediaElement) throw new Error("The newly generated Flow asset could not be located for download.");
  await mediaElement.scrollIntoViewIfNeeded();
  await mediaElement.hover();
  await page.waitForTimeout(500);
  let scope = mediaElement.locator("xpath=ancestor::*[self::article or self::li or @role='gridcell'][1]");
  if (!(await scope.count())) scope = mediaElement.locator("xpath=ancestor::div[.//button][1]");
  if (!(await scope.count())) scope = page;

  const more = await firstActionable([
    scope.locator("button:has(.google-symbols:text-is('more_vert'))"),
    scope.getByRole("button", { name: /more|options|m.s opciones/i }),
  ]);
  if (!more) throw new Error("Flow result menu was not found for the new video.");
  await more.click({ timeout: 5000 });
  await page.waitForTimeout(300);

  const downloadItem = await waitForActionable([
    page.locator("[role='menu']:visible button:has(.google-symbols:text-is('download'))"),
    page.locator("[role='menuitem']:visible:has(.google-symbols:text-is('download'))"),
    page.getByRole("menuitem", { name: /^download|^descargar/i }),
    page.getByRole("button", { name: /^download|^descargar/i }),
  ], 5000);
  if (!downloadItem) throw new Error("Flow download command was not found.");

  let downloadPromise = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await downloadItem.click({ timeout: 5000 });
  let download = await downloadPromise;
  if (!download) {
    const quality = await waitForActionable([
      page.getByRole("menuitem", { name: /1080p|720p|original|video/i }),
      page.getByRole("button", { name: /1080p|720p|original|video/i }),
      page.getByText(/1080p|720p|original/i, { exact: true }),
    ], 5000);
    if (!quality) throw new Error("Flow download quality option was not found.");
    downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await quality.click({ timeout: 5000 });
    download = await downloadPromise;
  }
  await download.saveAs(targetPath);
  const stat = await fs.stat(targetPath);
  if (stat.size < 1024) throw new Error("Downloaded Flow video is empty or incomplete.");
  let validation;
  try {
    validation = await validateDownloadedVideo(targetPath);
    assertNineSixteenDimensions(validation.stream);
  } catch (error) {
    error.downloadedFile = targetPath;
    throw error;
  }
  if (validation.container === "webm" && path.extname(targetPath).toLowerCase() !== ".webm") {
    const webmPath = targetPath.replace(/\.[^.]+$/, ".webm");
    await fs.rename(targetPath, webmPath);
    return webmPath;
  }
  return targetPath;
}

async function captureFlowDiagnostics(page, outputDir, error) {
  const stamp = Date.now();
  const wantedScreenshotPath = path.join(outputDir, `flow-error-${stamp}.png`);
  const wantedReportPath = path.join(outputDir, `flow-error-${stamp}.json`);
  let screenshotPath = null;
  let reportPath = null;
  try {
    await page.screenshot({ path: wantedScreenshotPath, fullPage: true });
    screenshotPath = wantedScreenshotPath;
  } catch {}
  const report = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    buttons: Array.from(document.querySelectorAll("button")).slice(0, 100).map((button) => ({
      text: String(button.innerText || button.textContent || "").trim().slice(0, 160),
      ariaLabel: button.getAttribute("aria-label"),
      disabled: Boolean(button.disabled),
      hidden: Boolean(button.hidden),
      pressed: button.getAttribute("aria-pressed"),
    })),
    editors: Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')).slice(0, 30).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      placeholder: element.getAttribute("placeholder") || element.getAttribute("data-placeholder"),
      slate: element.getAttribute("data-slate-editor"),
      visible: Boolean(element.getClientRects().length),
    })),
    symbols: Array.from(document.querySelectorAll(".google-symbols")).map((element) => String(element.textContent || "").trim()).filter(Boolean).slice(0, 200),
  })).catch(() => ({ url: page.url() }));
  report.error = String(error?.message || error || "Unknown Flow error");
  report.capturedAt = new Date().toISOString();
  try {
    await fs.writeFile(wantedReportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
    reportPath = wantedReportPath;
  } catch {}
  return { screenshotPath, reportPath };
}

async function runGeneration({ accountId, prompts, referenceImage, outputDir, onProgress }) {
  const useOpenContext = loginContext && loginAccountId === accountId;
  const context = useOpenContext ? loginContext : await openPersistentContext(accountId);
  const page = context.pages()[0] || await context.newPage();
  await fs.mkdir(outputDir, { recursive: true });
  const outputStat = await fs.lstat(outputDir);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("Google Flow output path must be a real directory.");
  }
  let failed = false;
  const files = [];
  const persistedFiles = [];
  const reportProgress = (progress) => onProgress?.({
    ...progress,
    downloadedFiles: [...files],
    persistedFiles: Array.from(new Set([...files, ...persistedFiles])),
  });
  try {
    await reportProgress({ stage: "opening-flow", current: 0, total: prompts.length });
    await page.goto(config.googleFlowUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await ensureEditor(page);
    await reportProgress({ stage: "configuring-video", current: 0, total: prompts.length });
    await selectVideoMode(page);
    let promptInput = await locatePromptInput(page, 10000);
    if (!promptInput) throw new Error("Google Flow prompt editor disappeared after selecting Video mode.");
    await addReference(page, promptInput, referenceImage);

    for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
      promptInput = await locatePromptInput(page, 10000);
      if (!promptInput) throw new Error("Google Flow prompt editor was not detected before submission.");
      const baseline = await collectFlowMedia(page);
      await reportProgress({ stage: "entering-prompt", current: promptIndex, total: prompts.length });
      await fillPromptInput(page, promptInput, prompts[promptIndex]);
      await reportProgress({ stage: "submitting", current: promptIndex, total: prompts.length });
      await submitPrompt(page, promptInput);
      await reportProgress({ stage: "generating", current: promptIndex, total: prompts.length });
      const createdMedia = await waitForNewMedia(page, baseline, 15 * 60 * 1000);
      const target = path.join(outputDir, `flow-${Date.now()}-${promptIndex + 1}.mp4`);
      await reportProgress({ stage: "downloading", current: promptIndex, total: prompts.length });
      let downloadedFile;
      try {
        downloadedFile = await downloadVideoAsset(page, createdMedia, target);
      } catch (error) {
        if (error.downloadedFile) {
          persistedFiles.push(error.downloadedFile);
          await reportProgress({ stage: "download-rejected", current: promptIndex, total: prompts.length });
        }
        throw error;
      }
      files.push(downloadedFile);
      await reportProgress({
        stage: "downloaded",
        current: promptIndex + 1,
        total: prompts.length,
        downloadedFiles: [...files],
      });
    }
    return files;
  } catch (error) {
    failed = true;
    error.completedFiles = [...files];
    error.persistedFiles = Array.from(new Set([...files, ...persistedFiles]));
    const diagnostics = await captureFlowDiagnostics(page, outputDir, error);
    error.diagnostics = diagnostics;
    const available = [diagnostics.reportPath, diagnostics.screenshotPath].filter(Boolean);
    if (available.length) {
      const relative = available.map((filePath) => path.relative(config.projectRoot, filePath)).join(", ");
      error.message = `${error.message} Diagnostics: ${relative}.`;
    }
    if (!useOpenContext && !config.headless && config.flowFailureHoldMs > 0) {
      error.message = `${error.message} The Flow browser will remain open temporarily for inspection.`;
    }
    throw error;
  } finally {
    if (!useOpenContext) {
      if (!(failed && retainDebugContext(accountId, context))) {
        await context.close().catch(() => {});
      }
    }
  }
}

function normalizePrompts(values) {
  if (!Array.isArray(values) || !values.length || values.length > 3) {
    throw new Error("Google Flow requires between one and three prompts.");
  }
  const prompts = values.map((value) => String(value || "").trim());
  if (prompts.some((value) => !value)) throw new Error("Every Google Flow prompt must contain text.");
  const unique = new Set(prompts.map((value) => value.toLocaleLowerCase()));
  if (unique.size !== prompts.length) throw new Error("Every Google Flow video requires a different prompt.");
  return prompts;
}

async function generateVideos(options = {}) {
  const accountId = String(options.accountId || "");
  const prompts = normalizePrompts(options.prompts);
  if (!accountId) throw new Error("A Google Flow account is required.");
  if (!options.outputDir) throw new Error("A Flow output directory is required.");
  if (accountLocks.has(accountId)) throw new Error("Google Flow is already running for this account.");

  const promise = runGeneration({ ...options, accountId, prompts });
  accountLocks.set(accountId, promise);
  try {
    return await promise;
  } finally {
    accountLocks.delete(accountId);
  }
}

module.exports = {
  PROMPT_INPUT_SELECTORS,
  SUBMIT_BUTTON_SELECTORS,
  VIDEO_SETTINGS_SELECTORS,
  VIDEO_OPTION_SELECTORS,
  PORTRAIT_ASPECT_SELECTORS,
  assertNineSixteenDimensions,
  validateDownloadedVideo,
  startLoginSession,
  getSessionStatus,
  closeLoginSession,
  generateVideos,
  ensureEditor,
  normalizePrompts,
  collectFlowMedia,
  selectVideoMode,
  fillPromptInput,
  submitPrompt,
};
