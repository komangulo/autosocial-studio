@echo off
REM ============================================================
REM  AutoSocial Studio - ARRANQUE ESTABLE (Windows)
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
if not exist "studio-ui\dist\index.html" (
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
if exist "scripts\run-dashboard.js" (
  node scripts\run-dashboard.js
) else (
  node src\dashboard-server.js
)

echo.
echo [AVISO] El dashboard se ha detenido.
pause
