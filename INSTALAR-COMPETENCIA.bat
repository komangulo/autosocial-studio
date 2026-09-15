@echo off
REM ============================================================
REM  AutoSocial Studio - Modulo Competencia / Modelado
REM  Instalador para Windows
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   AutoSocial Studio - Instalacion del modulo Competencia
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se ha encontrado Node.js.
  echo Instala Node.js 18 o superior desde https://nodejs.org
  echo y vuelve a ejecutar este instalador.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo [OK] Node.js detectado: %NODEVER%

echo.
echo [1/3] Instalando dependencias de Node...
call npm install
if errorlevel 1 (
  echo [ERROR] Fallo npm install. Revisa tu conexion o permisos.
  pause
  exit /b 1
)

echo.
echo [2/3] Comprobando herramientas externas...
where yt-dlp >nul 2>nul
if errorlevel 1 (
  if exist "autodownload\yt-dlp.exe" (
    echo [OK] yt-dlp encontrado en autodownload\yt-dlp.exe
  ) else (
    echo [AVISO] yt-dlp no esta en el PATH ni en autodownload\.
    echo        Descargalo desde https://github.com/yt-dlp/yt-dlp/releases
    echo        y colocalo en la carpeta autodownload\yt-dlp.exe
  )
) else (
  echo [OK] yt-dlp encontrado en el PATH.
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [AVISO] ffmpeg no esta en el PATH.
  echo        Necesario para analizar fotogramas de los videos.
  echo        Descarga desde https://www.gyan.dev/ffmpeg/builds/ y anade la carpeta bin al PATH.
) else (
  echo [OK] ffmpeg encontrado en el PATH.
)

echo.
echo [3/3] Construyendo la interfaz (tapiz React)...
call npm run build:studio
if errorlevel 1 (
  echo [AVISO] El build del tapiz fallo. El modulo Competencia no depende de el,
  echo        pero el panel HeliosGen podria no cargar.
)

echo.
echo ============================================================
echo   Instalacion completada.
echo.
echo   Para arrancar el dashboard ejecuta:  npm start
echo   Luego abre:  http://localhost:3028
echo   Ve a la pestana "Competencia" en la barra lateral.
echo.
echo   Lo primero: pulsa "Configurar API Gemini" y pega tu
echo   API key gratuita de Google AI Studio.
echo ============================================================
echo.
pause
