@echo off
REM ============================================================
REM  AndroidClone - Arrancar la aplicacion de escritorio
REM  Uso: doble clic (modo desarrollo, requiere npm install)
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se ha encontrado Node.js.
  echo Instala Node.js 18+ desde https://nodejs.org y reintenta.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [INFO] Instalando dependencias la primera vez...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Fallo npm install.
    pause
    exit /b 1
  )
)

echo Arrancando AndroidClone...
call npm run desktop
