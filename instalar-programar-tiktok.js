#!/usr/bin/env node
/**
 * instalar-programar-tiktok.js
 * ---------------------------------------------------------------------------
 * Arregla el error:
 *   "Could not fill the schedule date/time ... Checking in progress. This will
 *    take about 10 minutes. Longer videos may take more time."
 *
 * La fecha/hora SI se fija bien (el log dice match=true). El problema es que
 * readTikTokScheduleError() busca por TODA la pagina cualquier texto que
 * contenga "minut", y el aviso NORMAL de TikTok mientras procesa el video
 * ("Checking in progress... about 10 minutes") coincide. El codigo lo toma como
 * error de programacion, aborta, y por eso la subida "no termina".
 *
 * Este parche:
 *   1. Ignora los avisos de procesado normales al buscar errores de programacion.
 *   2. Si la fecha/hora ya cuadran (match=true) y lo unico que aparece es el
 *      aviso de procesado, se da por BUENO y se continua.
 *
 * Idempotente. Uso:  node instalar-programar-tiktok.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "tiktok-uploader.js");
const MARKER = "// MARKER: TIKTOK-SCHEDULE-PROCESSING-v1";

const results = [];
function ok(m) { results.push(["OK", m]); }
function skip(m) { results.push(["SKIP", m]); }
function fail(m) { results.push(["FAIL", m]); }

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(TARGET)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// --- 1. readTikTokScheduleError: ignorar avisos de procesado ----------------
const OLD_READ_ERROR = `async function readTikTokScheduleError(page) {
  return page.evaluate(() => {
    const patterns = [/at least/i, /15\\s*minut/i, /minut/i, /invalid/i, /must be/i, /no puede/i, /al menos/i];
    const candidates = [...document.querySelectorAll("[class*='error' i], [class*='Error'], [role='alert'], [class*='helper' i], span, div, p")]
      .filter((element) => element.offsetParent !== null && element.children.length === 0);
    for (const element of candidates) {
      const text = (element.textContent || "").trim();
      if (!text || text.length > 120) continue;
      if (patterns.some((pattern) => pattern.test(text))) return text;
    }
    return "";
  }).catch(() => "");
}`;

const NEW_READ_ERROR = `async function readTikTokScheduleError(page) {
  ${MARKER}
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
    const patterns = [/at least/i, /15\\s*minut/i, /minut/i, /invalid/i, /must be/i, /no puede/i, /al menos/i];
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
}`;

// --- 2. Al leer el error tras el match, ignorar el aviso de procesado --------
const OLD_AFTER_MATCH = `    // TikTok shows inline validation such as "Schedule at least 15 minutes in
    // advance". If the chosen time is too close, move forward and retry.
    lastError = await readTikTokScheduleError(page);
    if (!lastError) {
      return { timeValue, dateValue };
    }`;

const NEW_AFTER_MATCH = `    // TikTok shows inline validation such as "Schedule at least 15 minutes in
    // advance". If the chosen time is too close, move forward and retry.
    lastError = await readTikTokScheduleError(page);
    if (!lastError) {
      return { timeValue, dateValue };
    }
    // ${MARKER}: la fecha/hora ya cuadraban. Si lo unico que hay es el aviso de
    // que TikTok esta procesando el video, NO es un error de programacion:
    // dar por bueno y continuar (antes abortaba aqui y "no terminaba de subir").
    if (/checking in progress|this will take about|longer videos may take|may take more time|processing|comprobando/i.test(lastError)) {
      console.log(\`TikTok esta procesando el video (\${lastError}); se da por buena la programacion.\`);
      return { timeValue, dateValue };
    }`;

// --- Aplicar ----------------------------------------------------------------
let text = fs.readFileSync(TARGET, "utf8");

if (text.includes(MARKER)) {
  skip("src/tiktok-uploader.js ya tiene el parche de programacion");
} else {
  let applied = 0;

  if (text.includes(OLD_READ_ERROR)) {
    text = text.replace(OLD_READ_ERROR, NEW_READ_ERROR);
    applied += 1;
    ok("readTikTokScheduleError: ignora los avisos de video en procesamiento");
  } else {
    fail("No se encontro el bloque readTikTokScheduleError original.");
  }

  if (text.includes(OLD_AFTER_MATCH)) {
    text = text.replace(OLD_AFTER_MATCH, NEW_AFTER_MATCH);
    applied += 1;
    ok("setNativeSchedule: si la fecha cuadra y solo hay aviso de procesado, continua");
  } else {
    fail("No se encontro el bloque de lectura de error tras el match.");
  }

  if (applied > 0) {
    const backup = `${TARGET}.tiktok-schedule-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, text, "utf8");
  }
}

console.log("\n=== AutoSocial Studio - Arreglo de programacion de TikTok ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const skips = results.filter(([s]) => s === "SKIP").length;
const changes = results.filter(([s]) => s === "OK").length;
console.log(`\n${changes} cambios aplicados, ${skips} ya presentes, ${failures.length} errores.`);
if (failures.length) {
  console.error("\nRevisa los errores de arriba: puede que otro parche ya cambiara ese bloque.");
  process.exitCode = 1;
} else {
  console.log("Reinicia el dashboard (node src/dashboard-server.js) y vuelve a intentar la subida.");
}
