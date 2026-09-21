#!/usr/bin/env node
/*
 * instalar-idioma.js
 * ---------------------------------------------------------------------------
 * Arregla que X Autopilot genere SIEMPRE en espanol aunque el panel diga otra
 * cosa. Ahora el motor respeta el idioma elegido y por defecto es INGLES.
 *
 * Que hace:
 *   1. Reemplaza src/x-autopilot.js por el motor v3 (idioma configurable).
 *   2. Anade un selector "Idioma de los posts" (Ingles / Espanol) al panel de
 *      X Autopilot en web/index.html.
 *   3. Conecta ese selector en web/app.js (registro, carga, guardado).
 *   4. Migra el estado guardado: perfiles viejos sin idioma pasan a ingles
 *      UNA sola vez. Si eliges espanol a proposito, se respeta.
 *
 * Uso:  node instalar-idioma.js        (desde la raiz del proyecto)
 *
 * Es idempotente: ejecutarlo dos veces no cambia nada la segunda vez.
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const MARK = {
  engine: "// MARKER: XAP-ENGINE-v3",
  html: "<!-- MARKER: XAP-LANG-UI-v1 -->",
  jsEls: "// MARKER: XAP-LANG-ELS-v1",
  jsLoad: "// MARKER: XAP-LANG-PAYLOAD-v1",
  jsRender: "// MARKER: XAP-LANG-RENDER-v1",
  jsDirty: "/* MARKER: XAP-LANG-DIRTY-v1 */",
};

let changes = 0;
let errors = 0;
let skipped = 0;

function ok(msg) { changes++; console.log("  [OK]    " + msg); }
function skip(msg) { skipped++; console.log("  [SKIP]  " + msg); }
function fail(msg) { errors++; console.error("  [FALLO] " + msg); }

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
function write(rel, content) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}
function readAsset(name) {
  const p = path.join(__dirname, "assets", name);
  if (!fs.existsSync(p)) throw new Error("Falta el asset: " + p);
  return fs.readFileSync(p, "utf8");
}
function replaceOnce(text, needle, replacement, label) {
  const i = text.indexOf(needle);
  if (i === -1) { fail(label + ": no se encontro el ancla"); return null; }
  if (text.indexOf(needle, i + needle.length) !== -1) {
    fail(label + ": ancla ambigua (aparece mas de una vez)"); return null;
  }
  return text.slice(0, i) + replacement + text.slice(i + needle.length);
}

console.log("\n=== Instalador: idioma de X Autopilot ===\n");

// --- 0. Comprobaciones previas --------------------------------------------
if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.error("No parece la raiz del proyecto (falta package.json). Ejecuta el instalador desde la raiz.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "src"))) {
  console.error("No existe la carpeta src/. Ejecuta el instalador desde la raiz del proyecto.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "web", "index.html")) || !fs.existsSync(path.join(ROOT, "web", "app.js"))) {
  console.error("No encuentro web/index.html o web/app.js. Ejecuta el instalador desde la raiz.");
  process.exit(1);
}
console.log("Raiz detectada: " + ROOT + "\n");

// --- 1. Motor --------------------------------------------------------------
(function patchEngine() {
  console.log("1) src/x-autopilot.js");
  const current = read("src/x-autopilot.js");
  if (current && current.includes(MARK.engine)) { skip("el motor ya tiene el idioma (v3)"); return; }
  const engine = readAsset("x-autopilot.js");
  if (!engine.includes(MARK.engine)) { fail("el asset del motor no lleva su marca; abortando esta parte"); return; }
  if (current) {
    const bak = "src/x-autopilot.js.bak-idioma";
    if (!fs.existsSync(path.join(ROOT, bak))) write(bak, current);
  }
  write("src/x-autopilot.js", engine);
  ok("motor reemplazado (idioma configurable, ingles por defecto, migracion unica)");
})();

// --- 2. Selector en el panel ----------------------------------------------
(function patchHtml() {
  console.log("2) web/index.html");
  let text = read("web/index.html");
  if (text == null) { fail("no se pudo leer web/index.html"); return; }
  if (text.includes(MARK.html)) { skip("el selector de idioma ya existe"); return; }

  const anchor = '<div class="form-group" style="margin-top:16px"><label>Prompt maestro</label>';
  if (!text.includes(anchor)) { fail("no se encontro el ancla del Prompt maestro"); return; }

  const field = `${MARK.html}
            <div class="form-group" style="margin-top:16px"><label>Idioma de los posts</label><select id="xLanguage" class="control-input" style="max-width:220px;"><option value="en">Ingles</option><option value="es">Espanol</option></select></div>
            `;
  const out = replaceOnce(text, anchor, field + anchor, "selector de idioma");
  if (out == null) return;
  write("web/index.html", out);
  ok("selector 'Idioma de los posts' anadido al panel de X Autopilot");
})();

// --- 3. Conexion en app.js -------------------------------------------------
(function patchAppJs() {
  console.log("3) web/app.js");
  let text = read("web/app.js");
  if (text == null) { fail("no se pudo leer web/app.js"); return; }

  // 3a. Registro del elemento (this.els)
  if (!text.includes(MARK.jsEls)) {
    const elsAnchor = 'xMasterPrompt: document.getElementById("xMasterPrompt"),';
    if (text.includes(elsAnchor)) {
      const out = replaceOnce(
        text,
        elsAnchor,
        `${elsAnchor} ${MARK.jsEls} xLanguage: document.getElementById("xLanguage"),`,
        "registro de xLanguage"
      );
      if (out != null) { text = out; ok("app.js: xLanguage registrado en this.els"); }
    } else {
      fail("app.js: no se encontro el registro de xMasterPrompt en this.els");
    }
  } else { skip("app.js: registro de xLanguage ya presente"); }

  // 3b. Dirty tracking (para no bloquear el guardado)
  if (!text.includes(MARK.jsDirty)) {
    const dirtyAnchor = '"xSearchTopic", "xMasterPrompt",';
    if (text.includes(dirtyAnchor)) {
      const out = replaceOnce(
        text,
        dirtyAnchor,
        `"xSearchTopic", ${MARK.jsDirty} "xLanguage", "xMasterPrompt",`,
        "dirty tracking de xLanguage"
      );
      if (out != null) { text = out; ok("app.js: xLanguage en el dirty-tracking"); }
    } else {
      fail("app.js: no se encontro la lista de dirty-tracking");
    }
  } else { skip("app.js: dirty-tracking de xLanguage ya presente"); }

  // 3c. Enviar el idioma en el payload de guardado
  if (!text.includes(MARK.jsLoad)) {
    const saveAnchor = 'postingMode: this.els.xPostingMode?.value || "simulation", masterPrompt: this.els.xMasterPrompt?.value || "",';
    if (text.includes(saveAnchor)) {
      const out = replaceOnce(
        text,
        saveAnchor,
        `${saveAnchor} ${MARK.jsLoad} language: this.els.xLanguage?.value === "es" ? "es" : "en",`,
        "payload de idioma"
      );
      if (out != null) { text = out; ok("app.js: el guardado envia 'language'"); }
    } else {
      fail("app.js: no se encontro el payload de saveXConfig (masterPrompt)");
    }
  } else { skip("app.js: el guardado ya envia 'language'"); }

  // 3d. Reflejar el idioma guardado al cargar el panel
  if (!text.includes(MARK.jsRender)) {
    const loadAnchor = 'setValue(this.els.xMasterPrompt, config.masterPrompt, "xMasterPrompt");';
    if (text.includes(loadAnchor)) {
      const out = replaceOnce(
        text,
        loadAnchor,
        `${loadAnchor} setValue(this.els.xLanguage, config.language === "es" ? "es" : "en", "xLanguage"); ${MARK.jsRender}`,
        "carga de idioma"
      );
      if (out != null) { text = out; ok("app.js: el panel muestra el idioma guardado"); }
    } else {
      fail("app.js: no se encontro la carga de xMasterPrompt");
    }
  } else { skip("app.js: la carga de idioma ya esta presente"); }

  write("web/app.js", text);
})();

// --- 4. Migracion del estado guardado -------------------------------------
(function migrateState() {
  console.log("4) x-autopilot-state.json");
  const p = path.join(ROOT, "x-autopilot-state.json");
  if (!fs.existsSync(p)) { skip("no hay estado guardado (se creara al arrancar, en ingles)"); return; }
  let state;
  try { state = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { fail("el estado existe pero no es JSON valido; no lo toco"); return; }
  const accounts = (state && state.accounts) || {};
  let changed = 0;
  for (const key of Object.keys(accounts)) {
    const acc = accounts[key];
    if (!acc || typeof acc !== "object") continue;
    if (acc.languageMigrated) continue;
    acc.languageMigrated = true;
    if (!acc.config || typeof acc.config !== "object") acc.config = {};
    if (acc.config.language !== "es" && acc.config.language !== "en") {
      acc.config.language = "en";
      changed++;
    }
  }
  if (!changed) { skip("ningun perfil necesitaba migracion"); return; }
  fs.writeFileSync(p + ".tmp", JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(p + ".tmp", p);
  ok(`${changed} perfil(es) guardados pasan a ingles (una sola vez)`);
})();

// --- Resumen ---------------------------------------------------------------
console.log("\n=== Resumen ===");
console.log(`  Cambios: ${changes}   Omitidos: ${skipped}   Errores: ${errors}\n`);
if (errors) {
  console.error("Hay errores. NO reinicies aun: revisa los mensajes [FALLO] de arriba.");
  process.exit(1);
}
console.log("Listo. Ahora:");
console.log("  1. Reinicia el dashboard (npm start o el .bat que uses).");
console.log("  2. En el navegador, Ctrl+F5 para recargar sin cache.");
console.log("  3. En X Autopilot veras 'Idioma de los posts'. Por defecto: Ingles.");
