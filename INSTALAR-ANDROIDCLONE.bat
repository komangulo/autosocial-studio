@echo off
REM ============================================================
REM  AutoSocial Studio - Modulo AndroidClone
REM  Instalador para Windows
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   AutoSocial Studio - Instalacion del modulo AndroidClone
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
echo [1/6] Instalando dependencias de Node...
call npm install
if errorlevel 1 (
  echo [ERROR] Fallo npm install. Revisa tu conexion o permisos.
  pause
  exit /b 1
)

echo.
echo [2/6] Comprobando yt-dlp...
where yt-dlp >nul 2>nul
if errorlevel 1 (
  if exist "autodownload\yt-dlp.exe" (
    echo [OK] yt-dlp encontrado en autodownload\yt-dlp.exe
  ) else (
    echo [AVISO] yt-dlp no esta en el PATH ni en autodownload\.
    echo        Ejecuta DESCARGAR-YTDLP.bat en esta misma carpeta.
  )
) else (
  echo [OK] yt-dlp encontrado en el PATH.
)

echo.
echo [3/6] Comprobando ffmpeg / ffprobe...
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [AVISO] ffmpeg no esta en el PATH.
  echo        Necesario para extraer fotogramas.
  echo        Descarga desde https://www.gyan.dev/ffmpeg/builds/ y anade la carpeta bin al PATH.
) else (
  echo [OK] ffmpeg encontrado.
)

echo.
echo [4/6] Comprobando Java JDK 17...
where java >nul 2>nul
if errorlevel 1 (
  echo [AVISO] Java no esta en el PATH.
  echo        Necesario para compilar el APK (fase 6).
  echo        Instala Temurin JDK 17 desde https://adoptium.net
) else (
  for /f "tokens=*" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do echo [OK] %%v
)

echo.
echo [5/6] Comprobando Android SDK...
if defined ANDROID_HOME (
  echo [OK] ANDROID_HOME = %ANDROID_HOME%
) else (
  if defined ANDROID_SDK_ROOT (
    echo [OK] ANDROID_SDK_ROOT = %ANDROID_SDK_ROOT%
  ) else (
    echo [AVISO] No hay ANDROID_HOME ni ANDROID_SDK_ROOT definidos.
    echo        Instala Android cmdline-tools y define la variable de entorno.
    echo        Sin SDK podras generar el proyecto (fases 1-5), pero no compilar el APK.
  )
)

echo.
echo [6/6] Construyendo la interfaz del dashboard...
call npm run build:studio
if errorlevel 1 (
  echo [AVISO] El build de la interfaz fallo. El modulo AndroidClone no depende de el,
  echo        pero otras pestanas podrian no cargar.
)

echo.
echo ============================================================
echo   Instalacion completada.
echo.
echo   MODO ESCRITORIO (recomendado):
echo     Doble clic en ANDROIDCLONE.bat
echo     Se abre una ventana propia, sin navegador.
echo
echo   CREAR EL EJECUTABLE (instalador .exe):
echo     npm run dist:win
echo     El instalador queda en:  dist-desktop\AndroidClone-Setup-*.exe
echo
echo   MODO DASHBOARD (navegador):
echo     npm start   y abre  http://localhost:3028
echo
echo   Dentro de la app: "Comprobar dependencias" para
echo   instalar JDK, Android SDK, FFmpeg y yt-dlp.
echo ============================================================
echo.
pause
