#!/usr/bin/env node
/*
 * ARREGLO: los dias/fecha no se aplican al programar en TikTok
 * -----------------------------------------------------------
 * Diagnostico (con el HTML real del calendario de TikTok):
 *
 *  1) El calendario de TikTok NO tiene boton "mes siguiente". El mes/anio se
 *     cambia haciendo clic en el titulo del calendario (elemento
 *     ".month-header-wrapper" con ".month-title" y ".year-title").
 *     El codigo viejo buscaba un boton "[class*='next']" que en esa pantalla
 *     es un boton DESHABILITADO de una lista de miniaturas (data-nav="next"
 *     disabled). Resultado: 15 intentos sin avanzar de mes y la fecha se
 *     quedaba en el dia de hoy -> los dias marcados NUNCA se aplicaban.
 *
 *  2) Las celdas de dia son "div.day" (los nombres de la semana son
 *     ".day-header"). El codigo viejo las buscaba de forma generica.
 *
 * Esta es la causa real de que "no ponga el dia".
 *
 * Este script reemplaza SOLO la funcion setTikTokDate por una version que:
 *   - abre el calendario y lee el mes/anio del titulo .month-title / .year-title
 *   - cambia de mes clicando ese titulo (dropdown real de TikTok)
 *   - selecciona el dia en .days-wrapper .day
 *
 * NO toca la interfaz ni nada mas. Idempotente. Con --revert.
 *
 * Uso:
 *   node arreglar-dias-tiktok.js
 *   node arreglar-dias-tiktok.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "ARREGLO-DIAS-TIKTOK-CALENDARIO";
const REL = "src/tiktok-uploader.js";

function log(m) { console.log(`[${MARK}] ${m}`); }
const full = (rel) => path.resolve(ROOT, rel);

const START = "async function setTikTokDate(page, control, value) {";
const NEXT = "async function controlApplied(page, index, value) {";

const NEW_FN = `// // MARKER: TIKTOK-CALENDAR-MONTH-HEADER-v1
async function setTikTokDate(page, control, value) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(value || "").trim());
  if (!match) return false;
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]); // 1-12
  const targetDay = String(Number(match[3]));

  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const monthFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
    await page.waitForTimeout(800);
    return p;
  };

  // Lee el mes/anio que muestra el calendario.
  const readHeader = () => page.evaluate((monthNames) => {
    const title = document.querySelector(".month-title");
    const year = document.querySelector(".year-title");
    if (!title) return null;
    const m = monthNames.findIndex((name) => new RegExp("^" + name + "$", "i").test((title.textContent || "").trim()));
    if (m < 0) return null;
    const y = year ? Number((year.textContent || "").replace(/[^0-9]/g, "")) : null;
    return { month: m + 1, year: y };
  }, monthNames);

  // Clic en una celda de dia del calendario.
  const clickDay = async (day) => {
    const point = await page.evaluate(({ wanted }) => {
      const cells = [...document.querySelectorAll(".days-wrapper .day, .calendar-wrapper .day")]
        .filter((el) => {
          if (el.offsetParent === null) return false;
          if (el.classList.contains("day-header")) return false;
          return (el.textContent || "").trim() === wanted;
        });
      if (!cells.length) return null;
      const usable = cells.find((el) => !/(disabled|outside|other|prev|next)/i.test(el.className)) || cells[0];
      if (usable.offsetParent === null) return null;
      const rect = usable.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, { wanted: day }).catch(() => null);
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(400);
    return true;
  };

  // Cambiar de mes usando el desplegable del titulo (NO hay flecha "next").
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
  };

  let header = null;
  for (let openTry = 0; openTry < 3; openTry += 1) {
    header = await readHeader();
    if (header) break;
    const opened = await openCalendar();
    await debugLog("  date: open attempt " + (openTry + 1) + " at (" + opened.x + "," + opened.y + ")");
  }
  if (!header) {
    await debugLog("  date: calendar did not open (.month-title missing)");
    await dumpScheduleDiagnostics(page, "date-calendar");
    return false;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    header = await readHeader();
    await debugLog("  date: iteration " + (attempt + 1) + " header=" + JSON.stringify(header));
    if (!header) { await openCalendar(); continue; }
    if (header.year === targetYear && header.month === targetMonth) {
      const clicked = await clickDay(targetDay);
      await debugLog("  date: clicked day " + targetDay + " -> " + clicked);
      if (clicked) return true;
      break;
    }
    const changed = await changeMonth();
    await debugLog("  date: changeMonth -> " + changed);
    if (!changed) await openCalendar();
    await page.waitForTimeout(400);
  }

  const clicked = await clickDay(targetDay);
  await debugLog("  date: fallback click day=" + targetDay + " -> " + clicked);
  if (!clicked) await dumpScheduleDiagnostics(page, "date-calendar");
  await page.waitForTimeout(400);
  return clicked;
}

`;

function apply() {
  const f = full(REL);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${REL}. Ejecuta desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");

  if (text.includes("TIKTOK-CALENDAR-MONTH-HEADER-v1")) {
    log("ya estaba aplicado. Sin cambios.");
    return;
  }
  const startIdx = text.indexOf(START);
  const nextIdx = text.indexOf(NEXT);
  if (startIdx < 0 || nextIdx < 0 || nextIdx < startIdx) {
    throw new Error("No encuentro la funcion setTikTokDate original. Avisa a tu asistente.");
  }
  // Solo reemplaza si la funcion original es la de siempre (contiene clickNextMonth).
  const original = text.slice(startIdx, nextIdx);
  if (!original.includes("clickNextMonth")) {
    throw new Error("setTikTokDate parece modificada; no la toco. Avisa a tu asistente.");
  }

  const backup = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, backup);

  text = text.slice(0, startIdx) + NEW_FN + text.slice(nextIdx);
  fs.writeFileSync(f, text, "utf8");
  log(`reemplazada setTikTokDate en ${REL}`);
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
