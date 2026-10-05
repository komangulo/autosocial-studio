# Calentador TikTok: auto-scroll del "Para ti" (por cuenta)

## Qué hace

Añade a la página **TikTok / Auto Post** una barra:

```
Calentamiento automatico   [Parado]        [ Iniciar calentamiento ]  [ Parar ]
```

Al pulsar **Iniciar calentamiento** sobre la cuenta que tengas seleccionada:
- abre **su** perfil de TikTok (`.profiles/<cuenta>/tiktok`) en Chromium **invisible** (headless),
- entra to **"Para ti"** y baja de vídeo automáticamente **cada 4 segundos**
  (con un poco de aleatorio para que el ritmo no sea robótico),
- sigue hasta que pulses **Parar** (que además es instantáneo: no hay que esperar).

Solo hace **scroll pasivo**: no da likes, no comenta, no abre perfiles, no toca tu ratón
y **no usa extensiones**. Cada cuenta corre aislada —su perfil, su proceso, su estado— y
puedes tener varias calentando a la vez, cada una desde su propio botón.

## Cómo se instala

1. Copia `instalar-calentador-tiktok.js` a la carpeta del proyecto
   (`C:\Users\msi\Downloads\autosocial-studio`).
2. Cierra el dashboard si estaba abierto. En Git Bash, en esa carpeta:

   ```bash
   node instalar-calentador-tiktok.js
   npm run dashboard
   ```

3. En el navegador, recarga con **Ctrl+Shift+R** y ve a **TikTok / Auto Post**.

Es **idempotente** (ejecutarlo dos veces no duplica nada) y crea copias de seguridad
`*.bak-WARMER-TIKTOK-<fecha>` de cada archivo que toca.

> Requiere Playwright (ya lo usa tu app). Si el navegador no está descargado:
> `npx playwright install chromium`. El botón te avisará en el estado si falta.

## Cómo se usa

1. Elige la cuenta en el **desplegable de la cabecera**.
2. En **TikTok / Auto Post**, pulsa **Iniciar calentamiento**.
   El estado muestra: `Calentando · N videos · MM:SS`.
3. Pulsa **Parar** cuando quieras (o cambia de cuenta y calienta la siguiente).

Nota: la sesión ya debe estar iniciada en esa cuenta (es la misma que usa «Programar todo»).
Si una cuenta no tiene sesión, el scroll no sirve: inicia sesión primero.

## Cómo se revierte

```bash
node instalar-calentador-tiktok.js --revert
```

Restaura los archivos desde sus copias de seguridad y elimina `src/tiktok-warmer.js`.

## Qué archivos toca

| Archivo | Cambio |
|---|---|
| `src/tiktok-warmer.js` | **Nuevo**: motor de calentamiento (Playwright headless + scroll cada 4 s). |
| `src/dashboard-server.js` | Crea el motor y expone `/api/tiktok/warm/start｜stop｜status`. Para todo al cerrar. |
| `web/autopost.js` | Barra con los botones **Iniciar calentamiento** / **Parar** y su estado. |

No toca `index.html` ni el diseño: la barra la inyecta `web/autopost.js` en la vista de TikTok.

## Detalles técnicos

- **4 s** entre bajadas, con ±1,2 s aleatorios (siempre positivo, mínimo 0,5 s) para un
  patrón humano.
- Chromium arranca con `--disable-blink-features=AutomationControlled`,
  `--autoplay-policy=no-user-gesture-required` y `--mute-audio` (silencio, sin audio).
- El vídeo se deja reproduciendo en cada bajada para que el tiempo de visionado cuente.
- Limpia candados huérfanos (`SingletonLock`/`Cookie`/`Socket`) antes de abrir el perfil,
  para que un cierre brusco previo no bloquee el arranque.
- El proceso es inmune a carreras: pulsar **Parar** durante la carga cierra igual.

## Comprobar que funciona

1. `node instalar-calentador-tiktok.js` → `npm run dashboard` → Ctrl+Shift+R.
2. Elige *Quinta de Gym* (por ejemplo) y entra en **TikTok / Auto Post**.
3. Pulsa **Iniciar calentamiento**: el estado pasa a `Calentando · 1 videos · 00:04…` y sigue subiendo.
4. Abre el Administrador de tareas: verás un `chrome.exe` de Playwright. Al pulsar **Parar**,
   desaparece en menos de un segundo.
5. Repite con otra cuenta: se abre en **su** perfil y no interfiere con la primera.
