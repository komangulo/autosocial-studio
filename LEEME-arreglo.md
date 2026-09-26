# Arreglo de TikTok que no programa (cuenta nueva)

Dos scripts. Ejecuta primero el 1, y luego el 2.

## 1) Limpiar el estado roto de la cuenta  (OBLIGATORIO)

Desde la carpeta del proyecto (donde está `package.json`), con el dashboard CERRADO:

```bat
node reparar-cola-tiktok.js <cuenta> --dry
node reparar-cola-tiktok.js <cuenta>
```

Ejemplo para la cuenta del log:

```bat
node reparar-cola-tiktok.js series-y-dramas --dry
node reparar-cola-tiktok.js series-y-dramas
```

Qué hace (con copia de seguridad en `.runtime/reparacion-<cuenta>-...`):
- Mueve los `.meta.json` huérfanos de `pending` (sin vídeo) a la copia.
- Quita del store los jobs cancelados/fallidos de esa cuenta (desbloquea reintentos).
- Borra el flag de pausa `.runtime/autonomous-worker.paused`.

## 2) Parches de código  (OBLIGATORIO)

```bat
node aplicar-parches-tiktok.js --dry
node aplicar-parches-tiktok.js
```

Corrige 8 cosas:
- P1: un job cancelado ya no bloquea volver a programar el mismo vídeo.
- P2: el resumen cuenta "publicado" de verdad, no lo meramente encolado.
- P3: cancelar no mancha la lista de fallidos.
- P4: el drenaje informa de cuántos jobs quedaron cancelados.
- P5: la subida ya no se queda parada esperando el "Content check lite" de TikTok: espera 15 s como máximo y continúa igual.
- P6: usa de verdad el navegador compartido del lote y elimina la espera de 25 s
  por vídeo (`Holding browser for 25000ms`).
- P7: **el temporizador y el botón «Programar todo» ya no chocan.** Era la causa
  de los `exitCode=21` / «el perfil sigue en uso por otro proceso», que tumbaba
  el lote tras el primer vídeo.
- P8: **pulsa el segundo botón «Post now».** Cuando TikTok aún está verificando el
  vídeo y pulsas «Publicar/Programar», aparece un popup con «Post now» que hay que
  confirmar; el código no lo pulsaba y el flujo se quedaba pensando. Ahora lo
  detecta (también «Publicar ahora») y lo pulsa.

Deshacer en cualquier momento:

```bat
node aplicar-parches-tiktok.js --revert
```

Es idempotente: si ya aplicaste parches antes, detecta cuáles están y solo añade
los que falten.

## 3) Volver a programar

1. Reinicia el dashboard (`npm run dashboard`).
2. **Cierra todas las ventanas de Chrome** antes de empezar (restos de intentos
   fallidos pueden tener el perfil bloqueado).
3. Entra en TikTok → comprueba que `scheduled/processing/posted/failed` están vacíos.
4. Confirma que la sesión de TikTok de la cuenta sigue válida.
5. Pulsa «Programar todo en TikTok ahora» y **no pulses «Parar»** a mitad.

## Qué demonstraba tu log

La subida SÍ funcionaba: `Publish API success: 200 .../web/project/post/v1/` y
`TikTok schedule set to 2026-09-27 09:30.`

Pero después:
- `Holding browser for 25000ms (post-finalization)` → 25 s por vídeo abriendo y
  cerrando un Chrome. P6 lo corrige.
- `exitCode=21 ... .profiles\series-y-dramas\tiktok` y «sigue en uso por otro
  proceso» → **dos Chrome sobre el mismo perfil a la vez**. P7 lo corrige: el
  temporizador del worker y el drenaje manual competían por el mismo carril.
- `Content check lite` seguía en curso; ahora la espera es corta y **continúa**.
  Recuerda: para PROGRAMAR no hace falta que termine la verificación; TikTok
  acepta la programación igual (lo demuestra tu propio log con el 200).

## Requisitos
- Copia los dos `.js` a la raíz del proyecto (junto a `package.json`).
- Node 18+ (ya lo tienes).
