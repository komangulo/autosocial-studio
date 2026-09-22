CORRECCION DE LA RUTA DE yt-dlp

Este ZIP es un paquete de reemplazo para AutoSocial Studio. No es el proyecto
completo: contiene los archivos corregidos que debes copiar sobre tu proyecto.

CAMBIO REALIZADO

La aplicacion ya no depende de la carpeta desde la que se inicia Node. Si
YTDLP_PATH en .env es relativo, se interpreta desde la raiz del proyecto.
Ademas, autodownload/watcher.js usa el mismo resolvedor de rutas.

COMO INSTALARLO

1. Cierra AutoSocial Studio.
2. Extrae este ZIP dentro de:
   C:\Users\msi\Downloads\autosocial-studio
3. Acepta reemplazar los archivos existentes y conserva las carpetas src,
   autodownload y web.
4. Comprueba que exista:
   C:\Users\msi\Downloads\autosocial-studio\autodownload\yt-dlp.exe
5. Inicia la herramienta normalmente.

CONFIGURACION RECOMENDADA

Puedes eliminar YTDLP_PATH del archivo .env para usar automaticamente
autodownload/yt-dlp.exe. Si prefieres conservarlo, usa esta ruta relativa:

YTDLP_PATH=autodownload/yt-dlp.exe

No incluyas tiktok-cookies.txt, .env ni credenciales en un ZIP que vayas a
compartir.
