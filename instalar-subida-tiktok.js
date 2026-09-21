#!/usr/bin/env node
/**
 * instalar-subida-tiktok.js
 * ---------------------------------------------------------------------------
 * Arregla el error "No se encontró el campo de subida de vídeo de TikTok"
 * que ocurre en la subida automatica (autopost / AutonomousWorker).
 *
 * Que hace:
 *   1. Sustituye setVideoFile para que ESPERE de verdad a que TikTok monte el
 *      input de archivo (hasta 2 minutos), detecte si la sesion caduco, use el
 *      dialogo nativo de archivos como respaldo y recargue una vez si hace falta.
 *   2. Sustituye waitForUploadReady para esperar por ESTADO (editor montado),
 *      no por un tiempo fijo.
 *
 * Es idempotente: si ya esta aplicado, no hace nada.
 * Uso:  node instalar-subida-tiktok.js   (desde la raiz de AutoSocial Studio)
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "tiktok-uploader.js");
const MARKER = "// MARKER: TIKTOK-UPLOAD-ROBUST-v1";

const results = [];
function ok(m) { results.push(["OK", m]); }
function skip(m) { results.push(["SKIP", m]); }
function fail(m) { results.push(["FAIL", m]); }

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(TARGET)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// --- Fragmentos (deben coincidir EXACTAMENTE con el archivo original) -------
const OLD_SET_VIDEO_FILE = `async function setVideoFile(page, videoPath) {
  const candidates = [
    page.locator('input[type="file"][accept*="video" i]').first(),
    page.locator('input[type="file"][accept*=".mp4" i]').first(),
    page.locator('input[type="file"]').first(),
  ];
  for (const fileInput of candidates) {
    if (await fileInput.count() === 0) continue;
    await fileInput.waitFor({ state: "attached", timeout: 120000 });
    await fileInput.setInputFiles(videoPath);
    console.log(\`TikTok upload file selected: \${path.resolve(videoPath)}\`);
    return;
  }
  throw new Error("No se encontró el campo de subida de vídeo de TikTok.");
}`;

const NEW_SET_VIDEO_FILE = `async function setVideoFile(page, videoPath) {
  ${MARKER}
  const absolute = path.resolve(videoPath);
  const deadline = Date.now() + 120000;

  const isLoginWall = async () => {
    try {
      const url = page.url();
      return /\\/login|\\/signup|accounts\\.tiktok|tiktok\\.com\\/login/i.test(url);
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
        console.log(\`TikTok upload file selected: \${absolute}\`);
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
      console.log(\`TikTok upload file selected via file chooser: \${absolute}\`);
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

  const hint = lastError ? \` Ultimo detalle: \${lastError.message}\` : "";
  throw new Error(
    "No se encontro el campo de subida de video de TikTok tras esperar 2 minutos." + hint +
    " Comprueba que la sesion de TikTok esta iniciada y que la pagina de subida carga bien."
  );
}`;

const OLD_WAIT_READY = `async function waitForUploadReady(page) {
  await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
}`;

const NEW_WAIT_READY = `async function waitForUploadReady(page) {
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
}`;

// --- Aplicar ----------------------------------------------------------------
let text = fs.readFileSync(TARGET, "utf8");

if (text.includes(MARKER)) {
  skip("src/tiktok-uploader.js ya tiene el parche de subida");
} else {
  let applied = 0;

  if (text.includes(OLD_SET_VIDEO_FILE)) {
    text = text.replace(OLD_SET_VIDEO_FILE, NEW_SET_VIDEO_FILE);
    applied += 1;
    ok("setVideoFile reemplazado (espera real + deteccion de login + file chooser)");
  } else {
    fail("No se encontro el bloque setVideoFile original (el archivo ya fue modificado).");
  }

  if (text.includes(OLD_WAIT_READY)) {
    text = text.replace(OLD_WAIT_READY, NEW_WAIT_READY);
    applied += 1;
    ok("waitForUploadReady reemplazado (espera por estado del editor)");
  } else {
    fail("No se encontro el bloque waitForUploadReady original (el archivo ya fue modificado).");
  }

  if (applied > 0) {
    const backup = `${TARGET}.tiktok-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, text, "utf8");
  }
}

// --- Resumen ----------------------------------------------------------------
console.log("\n=== AutoSocial Studio - Arreglo de subida de TikTok ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const skips = results.filter(([s]) => s === "SKIP").length;
const changes = results.filter(([s]) => s === "OK").length;
console.log(`\n${changes} cambios aplicados, ${skips} ya presentes, ${failures.length} errores.`);
if (failures.length) {
  console.error("\nRevisa los errores de arriba. Puede que ya hayas aplicado otro parche que cambio ese bloque.");
  process.exitCode = 1;
} else {
  console.log("Reinicia el dashboard (node src/dashboard-server.js) y vuelve a intentar la subida.");
}
