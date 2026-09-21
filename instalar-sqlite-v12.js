#!/usr/bin/env node
/*
 * instalar-sqlite-v12.js
 * ------------------------------------------------------------
 * Solucion DE RAIZ del crash "Assertion failed: (env) != nullptr"
 * que aparece al usar AutoClone con Node 24.
 *
 * POR QUE PASA
 * ------------
 * package.json fija:   "better-sqlite3": "^11.10.0"
 *
 * La v11 SOLO publica binarios hasta NODE_MODULE_VERSION (ABI) 131.
 * Node 24 usa el ABI 137. No hay binario que descargar, asi que npm
 * compila desde cero, y el resultado revienta al liberar el modulo
 * nativo (RemoveEnvironmentCleanupHook, hooks.cc:142).
 *
 * La v12 anadio Node 24 a su matriz de compilacion (PR #1371) y
 * corrigio la deteccion de ABI con node-abi 4.9.0 (PR #1385).
 *
 * QUE HACE ESTE INSTALADOR
 * ------------------------
 *  1. Sube better-sqlite3 a ^12 en package.json (con backup).
 *  2. Ajusta allowScripts al nuevo numero de version.
 *  3. Sube el minimo de Node a >=20 (la v12 ya no soporta Node 18).
 *  4. Te dice exactamente que ejecutar despues.
 *
 * NO ejecuta npm install por su cuenta: eso lo haces tu, para que
 * veas la salida y no se toque nada sin tu control.
 *
 * Uso:
 *   Copia este archivo a la raiz de autosocial-studio.
 *   node instalar-sqlite-v12.js
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const PKG = path.join(ROOT, "package.json");

const NUEVA_VERSION = "^12.10.0"; // v12 con soporte solido de Node 24

function ok(m) { console.log("  [OK]   " + m); }
function info(m) { console.log("  [info] " + m); }
function warn(m) { console.log("  [AVISO] " + m); }
function die(m) { console.error("  [ERROR] " + m); process.exit(1); }

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - better-sqlite3 v12 (Node 24)");
console.log("============================================================");
console.log("");

// --- 0. Raiz correcta? ----------------------------------------
if (!fs.existsSync(PKG)) {
  die(
    "No encuentro package.json en esta carpeta:\n" +
      "         " + ROOT + "\n" +
      "         Copia instalar-sqlite-v12.js a la raiz de autosocial-studio."
  );
}

// --- 1. Leer package.json -------------------------------------
console.log("[1/5] Leyendo package.json...");

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
} catch (e) {
  die("package.json no es JSON valido: " + e.message);
}
if (!pkg.dependencies) die("package.json no tiene dependencias.");
ok("Leido correctamente.");

// --- 2. Estado actual -----------------------------------------
console.log("");
console.log("[2/5] Comprobando better-sqlite3...");

const actual = pkg.dependencies["better-sqlite3"];
if (!actual) {
  die("No encuentro better-sqlite3 en dependencies.");
}
info("Version declarada: " + actual);

const nodeAbi = process.versions.modules;
const nodeMajor = Number(process.versions.node.split(".")[0]);
info("Node actual: v" + process.versions.node + "  (ABI " + nodeAbi + ")");

const yaEsV12 = /^\^?1[2-9]\./.test(actual);
if (yaEsV12) {
  ok("Ya esta en v12 o superior. package.json no necesita cambios.");
}

// --- 3. Aplicar cambios ---------------------------------------
console.log("");
console.log("[3/5] Aplicando cambios en package.json...");

const cambios = [];

if (!yaEsV12) {
  pkg.dependencies["better-sqlite3"] = NUEVA_VERSION;
  cambios.push(`better-sqlite3: ${actual}  ->  ${NUEVA_VERSION}`);
} else {
  info("better-sqlite3: sin cambios (ya es v12+).");
}

// allowScripts: la clave lleva la version exacta pegada.
if (pkg.allowScripts) {
  const claves = Object.keys(pkg.allowScripts);
  const clavesSqlite = claves.filter((k) => k.startsWith("better-sqlite3"));
  const yaCorrecto =
    clavesSqlite.length === 1 && clavesSqlite[0] === "better-sqlite3@12.10.0";
  if (yaCorrecto) {
    info("allowScripts: ya apunta a better-sqlite3@12.10.0. Sin cambios.");
  } else if (clavesSqlite.length > 0) {
    for (const k of clavesSqlite) {
      delete pkg.allowScripts[k];
    }
    pkg.allowScripts["better-sqlite3@12.10.0"] = true;
    cambios.push(
      `allowScripts: "${clavesSqlite.join('", "')}"  ->  "better-sqlite3@12.10.0"`
    );
  } else {
    pkg.allowScripts["better-sqlite3@12.10.0"] = true;
    cambios.push('allowScripts: anadido "better-sqlite3@12.10.0"');
  }
} else {
  info("No hay bloque allowScripts (no hace falta crearlo).");
}

// engines: v12 ya no soporta Node 18.
if (pkg.engines && pkg.engines.node === ">=18") {
  pkg.engines.node = ">=20";
  cambios.push('engines.node: ">=18"  ->  ">=20"');
} else if (pkg.engines) {
  info('engines.node ya es "' + pkg.engines.node + '". Sin cambios.');
}

if (cambios.length === 0) {
  ok("Nada que cambiar en package.json.");
} else {
  const backup = PKG + ".backup-" + Date.now();
  // (la copia se crea solo si hay cambios reales)
  try {
    fs.copyFileSync(PKG, backup);
  } catch (e) {
    die("No pude crear copia de seguridad: " + e.message);
  }
  info("Copia de seguridad: " + path.basename(backup));

  const tmp = PKG + ".tmp-" + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, PKG);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    die("No pude escribir package.json: " + e.message);
  }
  for (const c of cambios) ok(c);
}

// --- 4. Comprobar el resultado --------------------------------
console.log("");
console.log("[4/5] Verificando package.json...");

let comprobado;
try {
  comprobado = JSON.parse(fs.readFileSync(PKG, "utf8"));
} catch (e) {
  die("package.json quedo invalido: " + e.message);
}
if (!comprobado.dependencies["better-sqlite3"]) {
  die("La dependencia desaparecio. Restaura el .backup-*");
}
ok(
  "better-sqlite3 = " +
    comprobado.dependencies["better-sqlite3"] +
    "  |  JSON valido."
);

// --- 5. Estado de node_modules --------------------------------
console.log("");
console.log("[5/5] Comprobando la instalacion actual...");

const modDir = path.join(ROOT, "node_modules", "better-sqlite3");
let modVersion = null;
if (fs.existsSync(modDir)) {
  try {
    modVersion = JSON.parse(
      fs.readFileSync(path.join(modDir, "package.json"), "utf8")
    ).version;
  } catch (_) {}
}
if (modVersion) {
  info("node_modules tiene instalada la v" + modVersion + ".");
  if (!/^1[2-9]\./.test(modVersion)) {
    warn(
      "Sigue siendo la v11: hay que reinstalar. Ejecuta los pasos de abajo."
    );
  } else {
    ok("La instalada ya es v12. Todo en orden.");
  }
} else {
  info("No hay node_modules/better-sqlite3 instalado todavia.");
}

// --- Siguientes pasos -----------------------------------------
console.log("");
console.log("============================================================");
console.log("  AHORA EJECUTA ESTOS DOS COMANDOS, EN ESTA CARPETA:");
console.log("");
console.log("    npm install");
console.log("");
console.log("  Si npm install termina sin errores, arranca la app:");
console.log("");
console.log("    npm run dashboard      (o ARRANCAR.bat)");
console.log("");
console.log("  PRUEBA: abre AutoClone y usa la funcion que fallaba.");
console.log("  Debe dejar de aparecer 'Assertion failed: (env) != nullptr'.");
console.log("");
console.log("  Si npm install falla por compilacion en Windows, necesita");
console.log("  Visual Studio Build Tools (C++). Alternativa sin compilar:");
console.log("     usa Node 20 LTS, que ya trae binarios de la v11 y v12.");
console.log("");
console.log("  Para deshacer: restaura package.json.backup-*");
console.log("============================================================");
console.log("");
