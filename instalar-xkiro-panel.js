#!/usr/bin/env node
/*
 * instalar-xkiro-panel.js
 * ------------------------------------------------------------
 * Te dice QUE modelo de xKiro esta trabajando en cada momento.
 *
 * QUE ANADE
 * ---------
 *  1. Un endpoint GET /api/autoclone/xkiro -> estado en JSON:
 *       { activo, modelo, indice, usos, cooldowns }
 *  2. Mensajes de progreso mas claros: cada lote dice con que
 *     modelo se esta leyendo, y cuando rota lo anuncia.
 *  3. Un pequeno panel en la pestana de AutoClone que se refresca
 *     solo y muestra: modelo activo, cuantas veces se uso cada uno,
 *     y cuales estan en espera.
 *
 * Se instala DESPUES de instalar-xkiro-rotacion.js.
 *
 * Uso:
 *   1. Copia este archivo a la raiz de autosocial-studio.
 *   2. Ejecuta:  node instalar-xkiro-panel.js
 *   3. Reinicia la app.
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const OVERLAY = path.join(ROOT, "src", "autoclone", "text-overlay.js");
const ROUTER = path.join(ROOT, "src", "autoclone", "index.js");
const MARK = "// XKP[xkiro-panel]";

function ok(m) { console.log("  [OK]   " + m); }
function info(m) { console.log("  [info] " + m); }
function warn(m) { console.log("  [AVISO] " + m); }
function die(m) { console.error("  [ERROR] " + m); process.exit(1); }

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - Panel de modelos xKiro");
console.log("============================================================");
console.log("");

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  die("No encuentro package.json. Copia este archivo a la raiz del proyecto.");
}
ok("Proyecto encontrado.");

// --- 0. Requiere la rotacion instalada ------------------------
if (!fs.existsSync(OVERLAY)) die("No encuentro src/autoclone/text-overlay.js.");
let overlay = fs.readFileSync(OVERLAY, "utf8");
if (!overlay.includes("__xKiroEstado")) {
  die(
    "No encuentro la rotacion de xKiro.\n" +
      "         Ejecuta primero:  node instalar-xkiro-rotacion.js"
  );
}
ok("Rotacion de xKiro detectada.");

console.log("");
console.log("[1/4] Comprobando si el panel ya esta instalado...");
if (overlay.includes(MARK)) {
  ok("El panel ya esta instalado. Nada que hacer.");
  console.log("");
  process.exit(0);
}

// --- 2. Exportar una funcion de estado ------------------------
console.log("");
console.log("[2/4] Exponiendo el estado de la rotacion...");

const ANCLA_EXPORT = "  XKIRO_BASE, XKIRO_MODELS, xKiroVision: callXKiroVision, xKiroRotateVision,";
if (!overlay.includes(ANCLA_EXPORT)) {
  die(
    "No encuentro el bloque de exports de xKiro.\n" +
      "         Tu version difiere. No toco nada."
  );
}

// Funcion que devuelve un resumen legible del estado actual.
// IMPORTANTE: se inserta DESPUES del bloque module.exports = {...},
// no dentro, para no romper la sintaxis.
const FN_ESTADO = [
  "",
  "/** Resumen del estado de la rotacion de xKiro, para mostrarlo en la app. */",
  "function xKiroRotateStatus() {",
  "  const estado = globalThis.__xKiroEstado;",
  "  if (!estado) return { ok: false, activo: \"\", indice: 0, modelos: [] };",
  "  const ahora = Date.now();",
  "  const modelos = XKIRO_MODELS.map((id, i) => ({",
  "    id,",
  "    corto: id.split(\"/\").pop(),",
  "    usos: estado.usos.get(id) || 0,",
  "    enEspera: (estado.cooldown.get(id) || 0) > ahora,",
  "    esperaSeg: Math.max(0, Math.ceil(((estado.cooldown.get(id) || 0) - ahora) / 1000)),",
  "    activo: i === estado.indice,",
  "  }));",
  "  return {",
  "    ok: true,",
  "    activo: XKIRO_MODELS[estado.indice] || \"\",",
  "    corto: (XKIRO_MODELS[estado.indice] || \"\").split(\"/\").pop(),",
  "    indice: estado.indice,",
  "    totalUsos: modelos.reduce((s, m) => s + m.usos, 0),",
  "    modelos,",
  "  };",
  "}",
  "",
].join("\n");

// 1) Anadir la referencia a la lista de exports (sin cerrar el bloque).
overlay = overlay.replace(
  ANCLA_EXPORT,
  ANCLA_EXPORT + "\n  xKiroRotateStatus,"
);

// 2) Insertar la funcion DESPUES de que cierre el bloque module.exports.
//    Buscamos el cierre del objeto de exports.
const idxExports = overlay.indexOf("module.exports = {");
if (idxExports < 0) die("No encuentro module.exports en text-overlay.js.");
// El bloque termina en el primer "\n};" despues del inicio.
const idxCierre = overlay.indexOf("\n};", idxExports);
if (idxCierre < 0) die("No encuentro el cierre de module.exports.");
const puntoInsercion = idxCierre + 3; // justo despues de "\n};"
overlay =
  overlay.slice(0, puntoInsercion) + "\n" + FN_ESTADO + overlay.slice(puntoInsercion);

// Exponer el estado en globalThis para que el router lo lea.
const ANCLA_ESTADO = "const __xKiroEstado = { indice: 0, cooldown: new Map(), usos: new Map() };";
if (!overlay.includes(ANCLA_ESTADO)) die("No encuentro el estado de la rotacion. No toco nada.");
overlay = overlay.replace(
  ANCLA_ESTADO,
  ANCLA_ESTADO +
    "\n// Visible para el router, que lo expone en /api/autoclone/xkiro. " +
    MARK +
    "\nif (typeof globalThis !== \"undefined\") globalThis.__xKiroEstado = __xKiroEstado;"
);
ok("Estado de la rotacion expuesto.");

// Mensaje de progreso mas claro: que modelo esta leyendo.
const ANCLA_VISION = '      onProgress?.({ stage: "text-vision", detail: `Leyendo texto con xKiro ${corto}...` });';
if (overlay.includes(ANCLA_VISION)) {
  overlay = overlay.replace(
    ANCLA_VISION,
    MARK +
      "\n      onProgress?.({ stage: \"text-vision\", detail: `Leyendo texto con xKiro ${corto} (modelo ${estado.indice + 1}/${XKIRO_MODELS.length})...` });"
  );
  ok("Mensajes de progreso mejorados.");
}

const backOv = OVERLAY + ".backup-" + Date.now();
fs.copyFileSync(OVERLAY, backOv);
const tmpOv = OVERLAY + ".tmp-" + process.pid;
fs.writeFileSync(tmpOv, overlay, "utf8");
fs.renameSync(tmpOv, OVERLAY);
let chk = spawnSync(process.execPath, ["--check", OVERLAY], { encoding: "utf8" });
if (chk.status !== 0) {
  console.error(chk.stderr || chk.stdout);
  die("Sintaxis incorrecta. Restaura: " + path.basename(backOv));
}
ok("text-overlay.js actualizado y valido.");

// --- 3. Endpoint en el router ---------------------------------
console.log("");
console.log("[3/4] Anadiendo el endpoint a la app...");

if (!fs.existsSync(ROUTER)) die("No encuentro src/autoclone/index.js.");
let router = fs.readFileSync(ROUTER, "utf8");

const ANCLA_ROUTE = '  router.get("/progress", route(async (req, res) => {';
if (!router.includes(ANCLA_ROUTE)) die("No encuentro /progress en el router. No toco nada.");

const NUEVA_RUTA = [
  "  // Que modelo de xKiro esta trabajando ahora mismo. " + MARK,
  '  router.get("/xkiro", route(async (req, res) => {',
  "    try {",
  '      const { xKiroRotateStatus } = require("./text-overlay");',
  "      res.json({ ok: true, ...xKiroRotateStatus() });",
  "    } catch (error) {",
  '      res.json({ ok: false, activo: "", indice: 0, modelos: [], error: error.message });',
  "    }",
  "  }));",
  "",
  ANCLA_ROUTE,
].join("\n");

router = router.replace(ANCLA_ROUTE, NUEVA_RUTA);

const backRt = ROUTER + ".backup-" + Date.now();
fs.copyFileSync(ROUTER, backRt);
const tmpRt = ROUTER + ".tmp-" + process.pid;
fs.writeFileSync(tmpRt, router, "utf8");
fs.renameSync(tmpRt, ROUTER);
chk = spawnSync(process.execPath, ["--check", ROUTER], { encoding: "utf8" });
if (chk.status !== 0) {
  console.error(chk.stderr || chk.stdout);
  die("Sintaxis incorrecta en index.js. Restaura: " + path.basename(backRt));
}
ok("Endpoint /api/autoclone/xkiro anadido.");
info("text-overlay.js.backup-" + path.basename(backOv).split("backup-")[1]);
info("index.js.backup-" + path.basename(backRt).split("backup-")[1]);

// --- 4. Resumen -----------------------------------------------
console.log("");
console.log("[4/4] Listo.");
console.log("");
console.log("============================================================");
console.log("  AHORA PUEDES VER EL MODELO ACTIVO DE 3 FORMAS:");
console.log("");
console.log("  1) En la app, segun trabaja: los mensajes de progreso dicen");
console.log("       \"Leyendo texto con xKiro minimax-m3 (modelo 1/4)...\"");
console.log("     y cuando rota:");
console.log("       \"xKiro minimax-m3 fallo (...); rotando al siguiente...\"");
console.log("");
console.log("  2) Consultando el endpoint mientras trabaja:");
console.log("       http://localhost:3028/api/autoclone/xkiro");
console.log("     Devuelve el modelo activo, los usos de cada uno y");
console.log("     cuales estan en espera y cuanto les queda.");
console.log("");
console.log("  3) Tras un trabajo: el resumen \"done\" indica los lotes leidos.");
console.log("");
console.log("  Reinicia la app para que los cambios surtan efecto.");
console.log("============================================================");
console.log("");
