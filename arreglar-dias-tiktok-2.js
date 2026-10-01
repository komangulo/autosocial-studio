#!/usr/bin/env node
/*
 * ARREGLO 2 (combinado)
 * ---------------------
 * A) Baja la espera del escaneo de TikTok a 10 segundos (antes: minimo 60s y
 *    hasta 10 min). Asi el flujo NO se queda pillado esperando "Checking in
 *    progress..." y continua igualmente con la programacion.
 *
 * B) Hace MUCHO mas robusto el cambio de mes del calendario. El intento anterior
 *    (clic solo en el titulo) devolvia siempre false. Este parche prueba varias
 *    vias en orden, incluida la flecha que SI existe dentro del header del
 *    calendario, y pulsa las flechas aunque esten deshabilitadas.
 *
 * NO toca la interfaz. Idempotente. Con --revert.
 *
 * Uso:
 *   node arreglar-dias-tiktok-2.js
 *   node arreglar-dias-tiktok-2.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "ARREGLO-DIAS-TIKTOK-2";
const REL = "src/tiktok-uploader.js";

function log(m) { console.log(`[${MARK}] ${m}`); }
const full = (rel) => path.resolve(ROOT, rel);

// ---- A) espera del escaneo a 10s -----------------------------------------
const WAIT_OLD = "  const deadline = Date.now() + Math.max(60000, Number(maxMs) || 600000);";
const WAIT_NEW = "  // // MARKER: TIKTOK-WAIT-10S-v1: maximo 10s esperando el escaneo; luego se continua.\n  const deadline = Date.now() + Math.min(Number(maxMs) || 10000, 10000);";
const WAIT_MSG_OLD = `  console.log(
    "TikTok: la verificacion sigue en curso; se CONTINUA igualmente con la programacion (no bloqueante)."
  );`;
const WAIT_MSG_NEW = `  console.log(
    "TikTok: el escaneo sigue en curso; se CONTINUA igualmente con la programacion (no bloqueante)."
  );`;

// ---- B) changeMonth robusto ------------------------------------------------
const OLD_CHANGE = `  // Cambiar de mes usando el desplegable del titulo (NO hay flecha "next").
  const changeMonth = async () => {
    const headerPoint = await page.evaluate(() => {
      const wrapper = document.querySelector(".month-header-wrapper") || document.querySelector(".month-title");
      if (!wrapper || wrapper.offsetParent === null) return null;
      const rect = wrapper.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).catch(() => null);
    if (!headerPoint) return false;
    await page.mouse.click(headerPoint.x, headerPoint.y);
    await page.waitForTimeout(600);

    const monthPoint = await page.evaluate(({ monthName }) => {
      const wantedLower = monthName.toLowerCase();
      const candidates = [...document.querySelectorAll("div, span, td, button, li")]
        .filter((el) => el.offsetParent !== null && el.children.length === 0)
        .filter((el) => (el.textContent || "").trim().toLowerCase() === wantedLower);
      const cell = candidates.find((el) => !el.classList.contains("month-title")) || candidates[0];
      if (!cell) return null;
      const rect = cell.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, { monthName: monthFull[targetMonth - 1] }).catch(() => null);
    if (monthPoint) {
      await page.mouse.click(monthPoint.x, monthPoint.y);
      await page.waitForTimeout(500);
      return true;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    return false;
  };`;

const NEW_CHANGE = `  // Cambiar de mes. TikTok NO usa flechas "next": el header .month-header-wrapper
  // abre un desplegable. Probamos varias vias en orden hasta que el mes cambie.
  const confirmMonth = (before) => page.evaluate((beforeVal) => {
    const title = document.querySelector(".month-title");
    const year = document.querySelector(".year-title");
    if (!title) return false;
    const now = ((title.textContent || "").trim()) + "/" + ((year ? year.textContent : "") || "").trim();
    return now !== beforeVal;
  }, before).catch(() => false);

  const headerLabel = () => page.evaluate(() => {
    const title = document.querySelector(".month-title");
    const year = document.querySelector(".year-title");
    if (!title) return "";
    return ((title.textContent || "").trim()) + "/" + ((year ? year.textContent : "") || "").trim();
  }).catch(() => "");

  const changeMonth = async () => {
    const before = await headerLabel();
    const monthName = monthFull[targetMonth - 1];

    // 1) Abrir el desplegable clicando el header completo.
    const headerPoint = await page.evaluate(() => {
      const wrapper = document.querySelector(".month-header-wrapper") || document.querySelector(".month-title");
      if (!wrapper || wrapper.offsetParent === null) return null;
      const rect = wrapper.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).catch(() => null);
    if (headerPoint) {
      await page.mouse.click(headerPoint.x, headerPoint.y);
      await page.waitForTimeout(700);
    }

    // 2) Elegir el mes en el desplegable si aparece.
    const monthPoint = await page.evaluate(({ monthName }) => {
      const wantedLower = monthName.toLowerCase();
      const candidates = [...document.querySelectorAll("div, span, td, button, li")]
        .filter((el) => el.offsetParent !== null && el.children.length === 0)
        .filter((el) => (el.textContent || "").trim().toLowerCase() === wantedLower);
      const cell = candidates.find((el) => !el.classList.contains("month-title")) || candidates[0];
      if (!cell) return null;
      const rect = cell.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, { monthName }).catch(() => null);
    if (monthPoint) {
      await page.mouse.click(monthPoint.x, monthPoint.y);
      await page.waitForTimeout(500);
      if (await confirmMonth(before)) return true;
    }

    // 3) Flechas dentro del PROPIO header del calendario (aunque esten deshabilitadas).
    const arrowPoint = await page.evaluate(({ ahead }) => {
      const scope = document.querySelector(".calendar-wrapper") || document.querySelector(".month-header-wrapper") || document;
      const all = [...scope.querySelectorAll("button, span, svg, [class*='arrow' i], [class*='next' i], [class*='prev' i]")];
      // Elegir la flecha "adelante" (derecha) si vamos hacia delante; si no, la de atras.
      const pick = all.filter((el) => el.offsetParent !== null);
      const forward = pick.filter((el) => {
        const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
        const label = (el.getAttribute && (el.getAttribute("aria-label") || "")) || "";
        return /next|right|forward/i.test(String(cls)) || /next|forward|adelante|siguiente/i.test(label);
      });
      const backward = pick.filter((el) => {
        const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || "";
        const label = (el.getAttribute && (el.getAttribute("aria-label") || "")) || "";
        return /prev|left|back/i.test(String(cls)) || /previ|back|atras/i.test(label);
      });
      const list = ahead ? forward : backward;
      const el = list.find((x) => x.getBoundingClientRect().width > 0) || list[0];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, { ahead: true }).catch(() => null);
    if (arrowPoint) {
      await page.mouse.click(arrowPoint.x, arrowPoint.y);
      await page.waitForTimeout(600);
      if (await confirmMonth(before)) return true;
    }

    // 4) Teclado: abrir el calendario y usar PageDown (avanza mes en muchos pickers).
    await page.keyboard.press("PageDown").catch(() => {});
    await page.waitForTimeout(500);
    if (await confirmMonth(before)) return true;

    return false;
  };`;

function apply() {
  const f = full(REL);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${REL}. Ejecuta desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");
  const backup = `${f}.bak-${MARK}-${Date.now()}`;

  let changed = false;

  // A) espera 10s
  if (!text.includes("TIKTOK-WAIT-10S-v1")) {
    if (!text.includes(WAIT_OLD)) {
      // ya podria estar cambiado por otra version; avisamos solo si tampoco tiene el marker
      throw new Error("No encuentro la linea de espera de escaneo original. Avisa a tu asistente.");
    }
    fs.copyFileSync(f, backup);
    text = text.replace(WAIT_OLD, WAIT_NEW);
    text = text.replace(WAIT_MSG_OLD, WAIT_MSG_NEW);
    log("espera del escaneo bajada a 10s");
    changed = true;
  } else {
    log("espera 10s ya aplicada");
  }

  // B) changeMonth robusto (solo si ya se aplico el arreglo del calendario v1)
  if (text.includes("TIKTOK-CALENDAR-MONTH-HEADER-v1")) {
    if (!text.includes("TIKTOK-CALENDAR-CHANGE-MONTH-v2")) {
      if (!text.includes(OLD_CHANGE)) {
        throw new Error("No encuentro el changeMonth del arreglo anterior. Avisa a tu asistente.");
      }
      if (!changed) fs.copyFileSync(f, backup);
      text = text.replace(OLD_CHANGE, NEW_CHANGE.replace(
        "  // Cambiar de mes. TikTok NO usa",
        "  // // MARKER: TIKTOK-CALENDAR-CHANGE-MONTH-v2\n  // Cambiar de mes. TikTok NO usa"
      ));
      log("changeMonth reforzado");
      changed = true;
    } else {
      log("changeMonth v2 ya aplicado");
    }
  } else {
    log("AVISO: primero ejecuta arreglar-dias-tiktok.js (calendario v1). Solo aplique la espera.");
  }

  if (!changed) { log("Sin cambios."); return; }
  fs.writeFileSync(f, text, "utf8");
  log(`backup: ${path.basename(backup)}`);
  log("Listo. Reinicia el dashboard (npm run dashboard).");
}

function revert() {
  const dir = path.dirname(full(REL));
  const baks = fs.readdirSync(dir).filter((x) => x.startsWith(`${path.basename(REL)}.bak-${MARK}-`)).sort();
  if (!baks.length) { log("Nada que revertir."); return; }
  fs.copyFileSync(path.resolve(dir, baks[baks.length - 1]), full(REL));
  log(`revertido ${REL} desde ${baks[baks.length - 1]}`);
}

if (REVERT) revert(); else apply();
