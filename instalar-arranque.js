#!/usr/bin/env node
/*
 * instalar-arranque.js
 * ------------------------------------------------------------
 * Soluciona el crash de better-sqlite3 en Node 24 y deja un
 * ARRANCAR.bat que siempre usa el lanzador correcto.
 *
 * Uso:
 *   1. Copia este archivo a la raiz de autosocial-studio.
 *   2. Ejecuta:  node instalar-arranque.js
 *   3. A partir de ahi: doble clic en ARRANCAR.bat
 *
 * Idempotente: se puede ejecutar tantas veces como quieras.
 * No borra nada tuyo. Solo crea ARRANCAR.bat y comprueba el entorno.
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const MARKER = "AutoSocial Studio - ARRANQUE ESTABLE"; // marcador unico
const TARGET = path.join(ROOT, "ARRANCAR.bat");

function log(msg) {
  console.log(msg);
}
function ok(msg) {
  console.log("  [OK]   " + msg);
}
function info(msg) {
  console.log("  [info] " + msg);
}
function warn(msg) {
  console.log("  [AVISO] " + msg);
}
function fail(msg) {
  console.error("  [ERROR] " + msg);
}

function die(msg) {
  fail(msg);
  process.exit(1);
}

// --- 0. Comprobar que estamos en la raiz del proyecto ---------
log("");
log("============================================================");
log("  AutoSocial Studio - Instalador de arranque estable");
log("============================================================");
log("");

const pkgPath = path.join(ROOT, "package.json");
if (!fs.existsSync(pkgPath)) {
  die(
    "No encuentro package.json en esta carpeta:\n" +
      "         " +
      ROOT +
      "\n" +
      "         Copia instalar-arranque.js a la raiz de autosocial-studio\n" +
      "         (donde esta package.json) y vuelve a ejecutarlo."
  );
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (e) {
  die("package.json no es JSON valido: " + e.message);
}
if (!pkg.name || pkg.name !== "autosocial-studio") {
  warn(
    "El package.json dice \"" +
      (pkg.name || "?") +
      "\", no \"autosocial-studio\". Sigo, pero comprueba la carpeta."
  );
}
ok("Proyecto encontrado: " + ROOT);

// --- 1. Estado de Node ----------------------------------------
log("");
log("[1/4] Comprobando Node.js...");

const nodeVer = process.versions.node;
const abi = process.versions.modules;
const major = Number(nodeVer.split(".")[0]);

info("Node " + nodeVer + "  (ABI " + abi + ")");
info("Ejecutable: " + process.execPath);

if (major === 24) {
  warn(
    "Node 24 es el que provoca el crash. El lanzador lo compensa con\n" +
      "         banderas de compatibilidad, pero la opcion mas solida es Node 20."
  );
} else if (major >= 18) {
  ok("Version de Node compatible.");
} else {
  warn("Se recomienda Node 18 o superior.");
}

// --- 2. better-sqlite3 presente y cargable? -------------------
log("");
log("[2/4] Comprobando better-sqlite3...");

const modDir = path.join(ROOT, "node_modules", "better-sqlite3");
if (!fs.existsSync(modDir)) {
  warn(
    "No esta instalado (no hay node_modules/better-sqlite3).\n" +
      "         Ejecuta primero:  npm install"
  );
} else {
  const probe = spawnSync(
    process.execPath,
    ["-e", "require('better-sqlite3')"],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (probe.status === 0) {
    ok("Carga correctamente con este Node.");
  } else {
    warn(
      "No carga con este Node (" +
        major +
        ").\n" +
        "         El ARRANCAR.bat intentara recompilarlo automaticamente.\n" +
        "         Si aun asi falla, instala Node 20 LTS:\n" +
        "           https://nodejs.org/en/download"
    );
  }
}

// --- 3. Comprobar el lanzador correcto ------------------------
log("");
log("[3/4] Comprobando scripts/run-dashboard.js...");

const launcher = path.join(ROOT, "scripts", "run-dashboard.js");
if (fs.existsSync(launcher)) {
  ok("Lanzador encontrado (aplica las banderas anti-crash).");
} else {
  warn(
    "No existe scripts/run-dashboard.js.\n" +
      "         Tu version del proyecto es anterior al arreglo.\n" +
      "         ARRANCAR.bat arrancara directamente el dashboard; si el crash\n" +
      "         persiste, actualiza el repositorio con:  git pull"
  );
}

// --- 4. Escribir ARRANCAR.bat ---------------------------------
log("");
log("[4/4] Instalando ARRANCAR.bat...");

const BAT = `@echo off
REM ============================================================
REM  ${MARKER} (Windows)
REM  Evita el crash de better-sqlite3 en Node 24.
REM
REM  Uso normal:  doble clic en este archivo.
REM  Para parar:  cierra la ventana o pulsa Ctrl+C.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   AutoSocial Studio - Arranque estable
echo ============================================================
echo.

REM --- 1. Localizar Node -------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encuentra Node.js en el PATH.
  echo         Instala Node.js desde https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
for /f "tokens=*" %%v in ('node -p "process.versions.modules"') do set NODEABI=%%v
echo [OK] Node.js detectado: %NODEVER%  ^(ABI %NODEABI%^)

echo %NODEABI% | findstr /b "137" >nul
if not errorlevel 1 (
  echo [AVISO] Node 24 detectado. El lanzador aplica banderas de
  echo         compatibilidad para better-sqlite3 automaticamente.
)

REM --- 3. Dependencias instaladas? ----------------------------
if not exist "node_modules" (
  echo.
  echo [1/3] No hay node_modules. Instalando dependencias ^(puede tardar^)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Fallo npm install. Revisa tu conexion o permisos.
    pause
    exit /b 1
  )
) else (
  echo [1/3] Dependencias ya instaladas.
)

REM --- 4. El modulo nativo carga? -----------------------------
node -e "try{require('better-sqlite3');process.exit(0)}catch(e){process.exit(9)}" >nul 2>nul
if errorlevel 1 (
  echo.
  echo [2/3] better-sqlite3 no carga con este Node. Recompilando...
  call npm rebuild better-sqlite3
  node -e "try{require('better-sqlite3');process.exit(0)}catch(e){process.exit(9)}" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [ERROR] better-sqlite3 sigue sin cargar con %NODEVER%.
    echo.
    echo   Opcion A ^(recomendada^): instala Node 20 LTS desde
    echo     https://nodejs.org/en/download  y vuelve a ejecutar
    echo     este archivo.
    echo.
    echo   Opcion B: actualiza la libreria con
    echo     npm install better-sqlite3@^12
    echo     ^(la v12 si trae binarios para Node 24^)
    echo.
    echo   Diagnostico completo:  npm run doctor
    pause
    exit /b 1
  )
  echo [OK] Recompilado correctamente.
) else (
  echo [2/3] better-sqlite3 carga correctamente.
)

REM --- 5. Interfaz compilada? ---------------------------------
if not exist "studio-ui\\dist\\index.html" (
  echo [3/3] Compilando la interfaz ^(solo la primera vez^)...
  call npm run build:studio
  if errorlevel 1 (
    echo [AVISO] El build de la interfaz fallo. La app arrancara igual,
    echo         pero algunas pestanas podrian no cargar.
  )
) else (
  echo [3/3] Interfaz ya compilada.
)

REM --- 6. Arrancar con el lanzador correcto -------------------
echo.
echo ============================================================
echo   Arrancando el dashboard...
echo   Abre  http://localhost:3028  en tu navegador.
echo   NO cierres esta ventana mientras uses la app.
echo ============================================================
echo.

REM Se usa run-dashboard.js y NO "npm start", porque npm ejecuta
REM prestart -^> vite build, que carga Node sin las banderas de
REM compatibilidad y vuelve a provocar el crash de better-sqlite3.
if exist "scripts\\run-dashboard.js" (
  node scripts\\run-dashboard.js
) else (
  node src\\dashboard-server.js
)

echo.
echo [AVISO] El dashboard se ha detenido.
pause
`;

let action = "creado";
if (fs.existsSync(TARGET)) {
  const current = fs.readFileSync(TARGET, "utf8");
  if (current.includes(MARKER)) {
    action = "actualizado";
  } else {
    const backup = TARGET + ".backup-" + Date.now();
    fs.copyFileSync(TARGET, backup);
    warn(
      "Ya existia un ARRANCAR.bat distinto. Guardado como:\n" +
        "         " +
        path.basename(backup)
    );
    action = "reemplazado (se guardo copia del anterior)";
  }
}

try {
  fs.writeFileSync(TARGET, BAT, "utf8");
} catch (e) {
  die("No pude escribir ARRANCAR.bat: " + e.message);
}

ok("ARRANCAR.bat " + action + ".");

// --- Resumen --------------------------------------------------
log("");
log("============================================================");
log("  Listo.");
log("");
log("  Arranca la app con doble clic en:");
log("      ARRANCAR.bat");
log("");
log("  Este archivo hace, en orden: comprobar Node, recompilar");
log("  better-sqlite3 si hace falta, compilar la interfaz una vez");
log("  y lanzar el dashboard con las banderas anti-crash.");
log("");
log("  Por que no basta con 'npm start':");
log("  npm ejecuta prestart -> vite build, que arranca Node SIN las");
log("  banderas de compatibilidad. Ahora ya no dependes de eso.");
log("============================================================");
log("");
