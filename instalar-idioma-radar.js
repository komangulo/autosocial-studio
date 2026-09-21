#!/usr/bin/env node
/*
 * instalar-idioma-radar.js
 * ---------------------------------------------------------------------------
 * Fuerza que INGLES sea el idioma por defecto en TODOS los selectores de idioma
 * del panel (Radar de afiliados y Publicacion diaria), y migra los perfiles ya
 * guardados que quedaron en espanol sin que el usuario lo eligiera.
 *
 * Que hace:
 *   1. web/index.html: pone <option value="en"> como PRIMERA opcion en los
 *      selectores radarLang y acctPubLang (arregla HTML de instalaciones viejas).
 *   2. .runtime/acct-radar.json    -> perfiles sin eleccion explicita pasan a "en".
 *   3. .runtime/acct-publisher.json -> idem.
 *   4. Marca "languageChosen" cuando el usuario guarda "es" a proposito, para
 *      que futuras migraciones no le pisen la eleccion.
 *
 * Uso:  node instalar-idioma-radar.js     (desde la raiz del proyecto)
 * Idempotente. No toca nada mas.
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const MARK = "<!-- MARKER: LANG-EN-FIRST-v1 -->";

let changes = 0, errors = 0, skipped = 0;
function ok(m) { changes++; console.log("  [OK]    " + m); }
function skip(m) { skipped++; console.log("  [SKIP]  " + m); }
function fail(m) { errors++; console.error("  [FALLO] " + m); }

console.log("\n=== Instalador: ingles por defecto en los selectores de idioma ===\n");

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.error("No parece la raiz del proyecto (falta package.json).");
  process.exit(1);
}

// --- 1. HTML: Ingles primero -------------------------------------------------
function enFirst(html, id, label) {
  // Captura el <select id="X" ...> ... </select> y reordena las opciones en/es.
  const re = new RegExp(
    '(<select id="' + id + '"[^>]*>)([\\s\\S]*?)(</select>)'
  );
  const m = html.match(re);
  if (!m) { fail('no se encontro el <select id="' + id + '"> en web/index.html'); return html; }
  const opts = m[2];
  const enOpt = (opts.match(/<option value="en"[^>]*>[\s\S]*?<\/option>/) || [])[0];
  const esOpt = (opts.match(/<option value="es"[^>]*>[\s\S]*?<\/option>/) || [])[0];
  if (!enOpt || !esOpt) { fail('el selector ' + id + ' no tiene las dos opciones en/es'); return html; }
  // ¿Ya esta ingles primero y sin duplicados?
  const already = /^\s*<option value="en"/.test(opts) && opts.indexOf("<option", opts.indexOf(enOpt) + enOpt.length) === opts.indexOf(esOpt) && (opts.match(/<option/g) || []).length === 2;
  if (already) { skip("web/index.html: " + label + " ya tiene Ingles primero"); return html; }
  const rebuilt = m[1] + "\n                " + enOpt + "\n                " + esOpt + "\n              " + m[3];
  ok("web/index.html: " + label + " ahora con Ingles primero");
  return html.slice(0, m.index) + rebuilt + html.slice(m.index + m[0].length);
}

(function patchHtml() {
  console.log("1) web/index.html");
  const p = path.join(ROOT, "web", "index.html");
  if (!fs.existsSync(p)) { fail("no existe web/index.html"); return; }
  let html = fs.readFileSync(p, "utf8");
  if (!html.includes('id="radarLang"') && !html.includes('id="acctPubLang"')) {
    skip("no hay selectores de idioma (el instalador del radar no esta puesto)");
    return;
  }
  if (html.includes('id="radarLang"')) html = enFirst(html, "radarLang", "Idioma del radar");
  if (html.includes('id="acctPubLang"')) html = enFirst(html, "acctPubLang", "Idioma de publicacion diaria");
  if (!html.includes(MARK)) html = html.replace("</body>", MARK + "\n</body>");
  fs.writeFileSync(p, html, "utf8");
})();

// --- 2 y 3. Estado guardado --------------------------------------------------
function migrateState(rel, containerKey, label) {
  console.log((rel === ".runtime/acct-radar.json" ? "2) " : "3) ") + rel);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { skip("no hay estado guardado (se creara en ingles)"); return; }
  let state;
  try { state = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { fail(rel + ": no es JSON valido, no lo toco"); return; }
  const list = state && state[containerKey];
  if (!list || typeof list !== "object") { skip(label + ": sin perfiles"); return; }
  let changed = 0;
  for (const key of Object.keys(list)) {
    const item = list[key];
    if (!item || typeof item !== "object") continue;
    if (!item.config || typeof item.config !== "object") item.config = {};
    const lang = String(item.config.language || "").toLowerCase();
    // Si el usuario eligio espanol a proposito, se respeta.
    if (item.config.languageChosen === "es" || item.languageChosen === "es") continue;
    if (lang !== "en") {
      item.config.language = "en";
      changed++;
    }
  }
  if (!changed) { skip(label + ": nada que migrar"); return; }
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(p + ".tmp", p);
  ok(label + ": " + changed + " perfil(es) pasan a Ingles");
}

migrateState(".runtime/acct-radar.json", "profiles", "Radar");
migrateState(".runtime/acct-publisher.json", "profiles", "Publicacion diaria");

// --- 4. Motor: recordar la eleccion explicita de idioma ---------------------
// Inserta "c.languageChosen = c.language;" dentro del bloque/linea que asigna
// el idioma. Trabaja sobre la asignacion (unica en cada archivo) y coloca la
// marca inmediatamente despues, conservando la sangria de esa linea.
function patchServerFile(rel, assignFragment, label) {
  console.log("4) " + rel);
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fail("no existe " + rel); return; }
  let src = fs.readFileSync(p, "utf8");
  if (src.includes("languageChosen")) { skip(label + ": ya marca la eleccion"); return; }

  const i = src.indexOf(assignFragment);
  if (i === -1) { fail(label + ": no se encontro la asignacion de idioma"); return; }
  if (src.indexOf(assignFragment, i + 1) !== -1) { fail(label + ": asignacion ambigua"); return; }

  const end = i + assignFragment.length;
  const lineStart = src.lastIndexOf("\n", i) + 1;
  const indent = src.slice(lineStart, i).match(/^\s*/)[0];
  const inBlock = src.slice(0, i).replace(/\s+$/, "").slice(-1) === "{" ||
    src.slice(end).replace(/^\s+/, "").slice(0, 1) === "}";

  if (inBlock) {
    // Multilinea: anade la marca en su propia linea tras la asignacion.
    src = src.slice(0, end) + "\n" + indent + "c.languageChosen = c.language;" + src.slice(end);
    fs.writeFileSync(p, src, "utf8");
    ok(label + ": ahora recuerda la eleccion explicita");
    return;
  }

  // Forma de una linea: la convierte en bloque.
  const condLine = src.slice(lineStart, i);
  const condMatch = condLine.match(/if\s*\(([^)]*)\)\s*$/);
  if (!condMatch) { fail(label + ": no se pudo leer la condicion"); return; }
  const rhs = assignFragment.slice(assignFragment.indexOf("=") + 1).replace(/;\s*$/, "").trim();
  const block = " {\n" + indent + "  c.language = " + rhs + ";\n" +
    indent + "  c.languageChosen = c.language;\n" + indent + "}";
  src = src.slice(0, lineStart) + indent + "if (" + condMatch[1] + ")" + block + src.slice(end);
  fs.writeFileSync(p, src, "utf8");
  ok(label + ": ahora recuerda la eleccion explicita");
}

patchServerFile(
  "src/acct-radar.js",
  'c.language = String(patch.language) === "es" ? "es" : "en";',
  "Radar (servidor)"
);

patchServerFile(
  "src/acct-publisher.js",
  'c.language = String(patch.language).toLowerCase() === "es" ? "es" : "en";',
  "Publicacion diaria (servidor)"
);

// --- 5. UI del radar: usar la cuenta seleccionada aunque el campo este vacio -
(function patchRadarUi() {
  console.log("5) web/acct-radar-ui.js");
  const p = path.join(ROOT, "web", "acct-radar-ui.js");
  if (!fs.existsSync(p)) { skip("no existe (el instalador del radar no esta puesto)"); return; }
  const current = fs.readFileSync(p, "utf8");
  if (current.includes("ACCT-RADAR-UI-v2")) { skip("ya usa la cuenta seleccionada como respaldo"); return; }
  // Busca el asset embebido junto al instalador.
  const candidates = [path.join(__dirname, "assets", "acct-radar-ui.js"), path.join(ROOT, "assets", "acct-radar-ui.js")];
  const assetPath = candidates.find((c) => fs.existsSync(c));
  if (!assetPath) { fail("no encuentro assets/acct-radar-ui.js; copia la carpeta assets junto a este instalador"); return; }
  const asset = fs.readFileSync(assetPath, "utf8");
  if (!asset.includes("ACCT-RADAR-UI-v2")) { fail("el asset no lleva la mejora v2"); return; }
  if (!fs.existsSync(p + ".bak-idioma")) fs.writeFileSync(p + ".bak-idioma", current, "utf8");
  fs.writeFileSync(p, asset, "utf8");
  ok("web/acct-radar-ui.js actualizado (usa la cuenta abierta si el campo esta vacio)");
})();

// --- Resumen ---------------------------------------------------------------
console.log("\n=== Resumen ===");
console.log("  Cambios: " + changes + "   Omitidos: " + skipped + "   Errores: " + errors + "\n");
if (errors) {
  console.error("Hay errores. Revisa los mensajes [FALLO]. No reinicies aun.");
  process.exit(1);
}
console.log("Listo. Reinicia el dashboard y pulsa Ctrl+F5 en el navegador.");
console.log("Ahora Ingles aparece primero y por defecto. Si eliges Espanol y guardas, se respeta.");
