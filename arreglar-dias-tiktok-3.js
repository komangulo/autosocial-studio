#!/usr/bin/env node
/*
 * ARREGLO DEFINITIVO del calendario de programacion de TikTok
 * -----------------------------------------------------------
 * Estructura REAL (vista en la captura y el HTML de TikTok Studio):
 *
 *   <div class="month-header-wrapper">
 *     <span class="arrow"><svg></svg></span>          <-- MES ANTERIOR  (NO es button)
 *     <span class="title-wrapper">
 *       <span class="month-title">September</span> / <span class="year-title">2026</span>
 *     </span>
 *     <span class="arrow"><svg></svg></span>          <-- MES SIGUIENTE (NO es button)
 *   </div>
 *   <div class="days-wrapper">
 *     <div class="day-span-container"><span class="day">30</span></div>   <-- de otro mes (gris)
 *     ...
 *     <div class="day-span-container"><span class="day valid">30</span></div>        <-- del mes actual
 *     <div class="day-span-container"><span class="day selected valid">29</span></div>
 *   </div>
 *
 * Dos causas del fallo:
 *  1) Las flechas de mes son <span class="arrow">, NO botones ni [class*=next].
 *     El codigo anterior las ignoraba -> nunca cambiaba de mes.
 *  2) Los numeros del dia se repiten entre meses (un "30" de agosto y otro de
 *     septiembre; un "1" de septiembre y otro de octubre). Hay que elegir el
 *     del mes actual, que es el que tiene clase "valid" (o "selected").
 *
 * Este script reescribe setTikTokDate con la logica correcta.
 * NO toca la interfaz. Idempotente. Con --revert.
 *
 * Uso:
 *   node arreglar-dias-tiktok-3.js
 *   node arreglar-dias-tiktok-3.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "ARREGLO-DIAS-TIKTOK-3";
const REL = "src/tiktok-uploader.js";

function log(m) { console.log(`[${MARK}] ${m}`); }
const full = (rel) => path.resolve(ROOT, rel);

const NEW_FN = `// // MARKER: TIKTOK-CALENDAR-ARROWS-v3
async function setTikTokDate(page, control, value) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(value || "").trim());
  if (!match) return false;
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]); // 1-12
  const targetDay = String(Number(match[3]));

  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  // Abrir el calendario clicando el campo de fecha (coordenadas leidas en vivo).
  const openCalendar = async () => {
    const point = await page.evaluate(() => {
      const fields = [...document.querySelectorAll("input.TUXTextInputCore-input, input[readonly]")]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
      const field = fields.find((el) => /^\\d{4}-\\d{2}-\\d{2}$/.test(String(el.value || "").trim())) || fields[fields.length - 1];
      if (!field) return null;
      field.scrollIntoView({ block: "center" });
      const rect = field.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }).catch(() => null);
    const p = point || { x: control.x, y: control.y };
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(700);
    return p;
  };

  // Lee mes/anio del titulo del calendario.
  const readHeader = () => page.evaluate((monthNames) => {
    const title = document.querySelector(".month-title");
    const year = document.querySelector(".year-title");
    if (!title) return null;
    const m = monthNames.findIndex((name) => new RegExp("^" + name + "$", "i").test((title.textContent || "").trim()));
    if (m < 0) return null;
    const y = year ? Number((year.textContent || "").replace(/[^0-9]/g, "")) : null;
    return { month: m + 1, year: y };
  }, monthNames).catch(() => null);

  // Pulsa la flecha de mes: index 0 = anterior, 1 = siguiente.
  // Las flechas son <span class="arrow"> dentro de .month-header-wrapper.
  const pressArrow = (next) => page.evaluate(({ goNext }) => {
    const header = document.querySelector(".month-header-wrapper");
    if (!header) return false;
    const arrows = [...header.querySelectorAll("span.arrow, .arrow")]
      .filter((el) => el.offsetParent !== null);
    const arrow = goNext ? arrows[arrows.length - 1] : arrows[0];
    if (!arrow) return false;
    const rect = arrow.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, { goNext: next }).then(async (point) => {
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(450);
    return true;
  }).catch(() => false);

  // Clic en una celda de dia DEL MES ACTUAL. Los dias del mes en curso llevan
  // la clase "valid" (y "selected" si esta elegido); los de meses vecinos no.
  const clickDay = async (day) => {
    const point = await page.evaluate(({ wanted }) => {
      const cells = [...document.querySelectorAll(".days-wrapper .day")]
        .filter((el) => el.offsetParent !== null && (el.textContent || "").trim() === wanted);
      if (!cells.length) return null;
      // El del mes actual es el que tiene "valid" (o "selected").
      const inMonth = cells.find((el) => /(^|\\s)(valid|selected)(\\s|$)/.test(el.className));
      const chosen = inMonth || cells[cells.length - 1];
      const rect = chosen.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, { wanted: day }).catch(() => null);
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(400);
    return true;
  };

  // Asegurar calendario abierto.
  let header = await readHeader();
  for (let openTry = 0; !header && openTry < 3; openTry += 1) {
    const opened = await openCalendar();
    await debugLog("  date: open attempt " + (openTry + 1) + " at (" + opened.x + "," + opened.y + ")");
    header = await readHeader();
  }
  if (!header) {
    await debugLog("  date: calendar did not open (.month-title missing)");
    await dumpScheduleDiagnostics(page, "date-calendar");
    return false;
  }

  // Navegar hasta el mes objetivo pulsando flechas.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    header = await readHeader();
    await debugLog("  date: iteration " + (attempt + 1) + " header=" + JSON.stringify(header));
    if (!header) { await openCalendar(); continue; }
    if (header.year === targetYear && header.month === targetMonth) break;
    const ahead = header.year < targetYear || (header.year === targetYear && header.month < targetMonth);
    const pressed = await pressArrow(ahead);
    await debugLog("  date: arrow " + (ahead ? "next" : "prev") + " -> " + pressed);
    if (!pressed) break;
  }

  // Elegir el dia.
  header = await readHeader();
  if (header && header.year === targetYear && header.month === targetMonth) {
    const clicked = await clickDay(targetDay);
    await debugLog("  date: clicked day " + targetDay + " -> " + clicked);
    if (clicked) return true;
  }

  const clicked = await clickDay(targetDay);
  await debugLog("  date: fallback click day=" + targetDay + " -> " + clicked);
  if (!clicked) await dumpScheduleDiagnostics(page, "date-calendar");
  await page.waitForTimeout(400);
  return clicked;
}

`;

const START = "async function setTikTokDate(page, control, value) {";
const NEXT = "async function controlApplied(page, index, value) {";

function apply() {
  const f = full(REL);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${REL}. Ejecuta desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");

  if (text.includes("TIKTOK-CALENDAR-ARROWS-v3")) {
    log("ya estaba aplicado. Sin cambios.");
    return;
  }
  const startIdx = text.indexOf(START);
  const nextIdx = text.indexOf(NEXT);
  if (startIdx < 0 || nextIdx < 0 || nextIdx < startIdx) {
    throw new Error("No encuentro setTikTokDate / controlApplied. Avisa a tu asistente.");
  }
  const backup = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, backup);

  text = text.slice(0, startIdx) + NEW_FN + text.slice(nextIdx);
  fs.writeFileSync(f, text, "utf8");
  log(`reemplazada setTikTokDate (flechas span.arrow + dia del mes actual) en ${REL}`);
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
