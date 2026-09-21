#!/usr/bin/env node
/**
 * instalar-espera-procesado-tiktok.js
 * ---------------------------------------------------------------------------
 * Arregla que la subida NO termine nunca: el video se sube, se rellenan titulo,
 * caption, hashtags y ubicacion, pero al programar la fecha/hora falla con:
 *
 *   "Could not fill the schedule date/time ... Checking in progress. This will
 *    take about 10 minutes. Longer videos may take more time."
 *
 * Y por eso NO aparece ni en publicaciones ni en drafts: se aborta ANTES de
 * pulsar el boton final de programar/publicar.
 *
 * Causa: TikTok bloquea/ignora el selector de fecha/hora mientras el video
 * sigue procesandose. El codigo intenta programar de inmediato, no lo consigue
 * y aborta.
 *
 * Este parche:
 *   1. Espera a que TikTok TERMINE de procesar (desaparezca "Checking in progress")
 *      antes de tocar la programacion. Tope configurable (por defecto 20 min).
 *   2. Si aun asi el selector esta bloqueado, reintenta programar varias veces.
 *   3. Arregla la ubicacion duplicada ("MadridMadrid, Spain"): pide solo la
 *      ciudad si el texto trae ", Pais", para que TikTok sugiera el valor limpio.
 *
 * Idempotente. Uso:  node instalar-espera-procesado-tiktok.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "tiktok-uploader.js");
const MARKER = "// MARKER: TIKTOK-WAIT-PROCESSING-v1";

const results = [];
function ok(m) { results.push(["OK", m]); }
function skip(m) { results.push(["SKIP", m]); }
function fail(m) { results.push(["FAIL", m]); }

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(TARGET)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// --- 1. Esposa de procesado + programación robusta --------------------------
// Reemplazamos el bloque de programacion dentro de uploadVideo.
const OLD_BLOCK = `    if (scheduleMode) {
      await onPhase?.("schedule-setting");
      const { timeValue, dateValue } = await setNativeSchedule(page, scheduledAt, scheduleTimezone);
      console.log(\`TikTok schedule set to \${dateValue} \${timeValue}.\`);
    }`;

const NEW_BLOCK = `    if (scheduleMode) {
      // ${MARKER}
      // TikTok no deja fijar fecha/hora mientras procesa el video. Esperamos a
      // que termine ("Checking in progress" desaparece) antes de programar.
      await waitForVideoProcessing(page);
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
          console.log(\`Programacion intento \${attempt + 1} fallido: \${error.message}\`);
          await waitForVideoProcessing(page, 120000).catch(() => {});
          await page.waitForTimeout(5000);
        }
      }
      if (!scheduleResult) {
        throw scheduleError || new Error("No se pudo programar la fecha/hora.");
      }
      const { timeValue, dateValue } = scheduleResult;
      console.log(\`TikTok schedule set to \${dateValue} \${timeValue}.\`);
    }`;

// --- 2. Insertar waitForVideoProcessing antes de setNativeSchedule ----------
const ANCHOR = `async function setNativeSchedule(page, scheduledAt, timezone) {`;

const WAIT_FN = `/**
 * ${MARKER}
 * Espera a que TikTok termine de procesar el video. Mientras procesa, muestra
 * "Checking in progress..." y bloquea el selector de programacion.
 * Devuelve true si termino; false si se agoto el tiempo (no lanza).
 */
async function waitForVideoProcessing(page, maxMs = 1200000) {
  const deadline = Date.now() + Math.max(60000, Number(maxMs) || 1200000);
  const check = async () => {
    try {
      return await page.evaluate(() => {
        const patterns = [
          /checking in progress/i,
          /this will take about/i,
          /longer videos may take/i,
          /may take more time/i,
          /comprobando/i,
          /tardar[a]? aproximadamente/i,
          /uploading/i,
          /subiendo/i,
        ];
        const elements = [...document.querySelectorAll("span, div, p, [role='alert']")]
          .filter((el) => el.offsetParent !== null && el.children.length === 0);
        for (const el of elements) {
          const text = (el.textContent || "").trim();
          if (!text || text.length > 200) continue;
          if (patterns.some((p) => p.test(text))) return text;
        }
        return "";
      });
    } catch {
      return "";
    }
  };

  const first = await check();
  if (!first) return true; // ya había terminado (o no aparece el aviso)

  console.log(\`TikTok procesando el video ("\${first.slice(0, 80)}"); esperando a que termine...\`);
  let waited = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    waited += 5000;
    const still = await check();
    if (!still) {
      console.log("TikTok termino de procesar el video.");
      return true;
    }
    if (waited % 60000 === 0) {
      console.log(\`  ...sigue procesando (\${Math.round(waited / 1000)}s)\`);
    }
  }
  console.log("TikTok seguia procesando tras el tiempo maximo; se intentara programar igual.");
  return false;
}

${ANCHOR}`;

// --- 3. Ubicación: no enviar "Ciudad, Pais" para evitar "MadridMadrid, Spain" -
const OLD_LOCATION_QUERY = `  const query = String(location || "").trim();
  if (!query) return false;`;

const NEW_LOCATION_QUERY = `  const rawQuery = String(location || "").trim();
  if (!rawQuery) return false;
  // TikTok a veces sugiere "MadridMadrid, Spain" al buscar "Madrid, Spain":
  // se teclea la ciudad y su propio nombre vuelve duplicado. Enviar solo la
  // ciudad evita la duplicacion; el pais lo resuelve la propia sugerencia.
  const query = rawQuery.includes(",") ? rawQuery.split(",")[0].trim() : rawQuery;`;

// --- Aplicar ----------------------------------------------------------------
let text = fs.readFileSync(TARGET, "utf8");

if (text.includes(MARKER)) {
  skip("src/tiktok-uploader.js ya tiene el parche de espera de procesado");
} else {
  let applied = 0;

  if (text.includes(OLD_BLOCK)) {
    text = text.replace(OLD_BLOCK, NEW_BLOCK);
    applied += 1;
    ok("uploadVideo: espera procesado + reintentos de programacion");
  } else {
    fail("No se encontro el bloque de programacion original en uploadVideo.");
  }

  if (text.includes(ANCHOR) && !text.includes("async function waitForVideoProcessing")) {
    text = text.replace(ANCHOR, WAIT_FN);
    applied += 1;
    ok("waitForVideoProcessing anadida");
  } else {
    fail("No se encontro setNativeSchedule para insertar el esperador.");
  }

  if (text.includes(OLD_LOCATION_QUERY)) {
    text = text.replace(OLD_LOCATION_QUERY, NEW_LOCATION_QUERY);
    applied += 1;
    ok("setLocation: evita la ubicacion duplicada (MadridMadrid, Spain)");
  } else {
    fail("No se encontro el bloque de setLocation original.");
  }

  if (applied > 0) {
    const backup = `${TARGET}.tiktok-processing-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, text, "utf8");
  }
}

console.log("\n=== AutoSocial Studio - Espera de procesado + ubicacion (TikTok) ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const skips = results.filter(([s]) => s === "SKIP").length;
const changes = results.filter(([s]) => s === "OK").length;
console.log(`\n${changes} cambios aplicados, ${skips} ya presentes, ${failures.length} errores.`);
if (failures.length) {
  console.error("\nRevisa los errores: puede que un parche anterior ya cambiara ese bloque.");
  process.exitCode = 1;
} else {
  console.log("Reinicia el dashboard (node src/dashboard-server.js) y vuelve a intentar la subida.");
}
