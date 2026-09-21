# TikTok: un solo navegador para todo el lote

## El problema que arregla

En tu prueba de 10 vídeos, los 10 entraron **a la vez**. Cada uno abrió su propio
Chrome sobre el **mismo perfil** (`--user-data-dir=...\.profiles\kim-tae-jin\tiktok`).
Chrome no admite dos procesos con el mismo perfil: el primero gana y los otros 9
mueren con `exitCode=21`. Resultado: se subió 1 y el resumen dijo "10 programados".

## Qué hace ahora

1. **Un solo navegador** para todo el lote: se abre al empezar y se cierra cuando
   termina el último vídeo.
2. **Uno detrás de otro**: no empieza el siguiente hasta que el anterior devuelve
   `succeeded`/`failed`.
3. **Si el navegador muere a mitad**, se reabre solo y el lote continúa.
4. **Resumen honesto**: dice publicados y fallidos reales, no "programados".

## Instalación

1. Copia `instalar-tiktok-un-navegador.js` a la raíz del proyecto (junto a `package.json`).
2. Ejecuta:

       node instalar-tiktok-un-navegador.js

3. Verás `3 cambios aplicados`. Reinicia el dashboard:

       node src/dashboard-server.js

Es idempotente: si lo ejecutas otra vez, dice `2 ya presentes, 0 errores`.
Hace copia de seguridad en `src/tiktok-uploader.js.tiktok-un-navegador-backup`.

## Cómo lanzar el lote de la cola

Desde el proyecto:

    const { uploadTikTokQueueInOneBrowser } = require("./src/tiktok-batch");
    const r = await uploadTikTokQueueInOneBrowser({ accountId: "kim-tae-jin" });
    console.log(r.posted + " publicados, " + r.failed + " fallidos");

La función devuelve `{ total, posted, failed, results }` con el resultado real de
cada vídeo. También acepta `onProgress(state, nombre, resultado)` para ir pintando
el avance.

## Si algo falla

Tu `tiktok-uploader.js` es recuperable siempre copiando el `.tiktok-un-navegador-backup`
encima. Mándame el error exacto y lo ajusto.
