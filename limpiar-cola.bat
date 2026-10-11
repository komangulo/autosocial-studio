@echo off
REM ============================================================
REM limpiar-cola.bat
REM Borra los trabajos de TikTok (pendientes/procesando/reservados)
REM SOLO de: capybluh y madrid-nueva-modelo, y cancela sus jobs.
REM Copia este .bat a la RAIZ de tu proyecto y haz doble clic.
REM ============================================================
setlocal
cd /d "%~dp0"

echo Proyecto: %CD%
echo.
echo AVISO: cierra la app ANTES de continuar.
pause

for %%c in (capybluh madrid-nueva-modelo) do (
  echo --- Cuenta %%c ---
  if exist "queue\%%c\tiktok\pending\"     del /q "queue\%%c\tiktok\pending\*" 2>nul
  if exist "queue\%%c\tiktok\processing\"  rmdir /s /q "queue\%%c\tiktok\processing" 2>nul
  if exist "queue\%%c\tiktok\scheduled\"   rmdir /s /q "queue\%%c\tiktok\scheduled" 2>nul
  if exist "queue\%%c\tiktok\posted\"      del /q "queue\%%c\tiktok\posted\*" 2>nul
  if exist "queue\%%c\tiktok\failed\"      del /q "queue\%%c\tiktok\failed\*" 2>nul
  mkdir "queue\%%c\tiktok\pending" 2>nul
  mkdir "queue\%%c\tiktok\processing" 2>nul
  mkdir "queue\%%c\tiktok\scheduled" 2>nul
)

echo.
echo Estado de la cola tras limpiar:
for %%c in (capybluh madrid-nueva-modelo) do (
  echo Cuenta %%c:
  dir /b "queue\%%c\tiktok\pending" 2>nul | find /c /v "" 
  echo   (numero de pendientes arriba)
)

echo.
echo NOTA: los "jobs" guardados en .runtime\autonomous-state.json NO se
echo cancelan con este .bat (es mas facil hacerlo con el script de Bash
echo limpiar-cola.sh, que si los cancela). Si no usas Bash, avisame.
echo.
pause
