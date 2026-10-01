# Arreglo: cuentas de TikTok independientes

## Qué problema resuelve

Al pulsar **«Programar todo»** en TikTok desde el perfil de una cuenta (por ejemplo
*Quinta de Gym*), el sistema usaba la **cuenta activa global** (la del desplegable de la
cabecera) en lugar de la cuenta que estabas viendo. Si esa cuenta activa apuntaba a otra
(*ASL Low Cost*), se programaba/publicaba con la sesión equivocada: **se mezclaban las
cuentas**.

Este parche hace que TikTok use **siempre la cuenta seleccionada**, y que cada cuenta
tenga su sesión, su perfil de navegador y su cola **totalmente separados**:

- `login` de TikTok → se abre en el perfil de la cuenta seleccionada.
- Estado de sesión («Sesión guardada» / «Sin sesión») → refleja **esa** cuenta.
- `Programar todo`, programar y previsualizar → usan **esa** cuenta.
- Al cambiar de cuenta en el desplegable, la pestaña se refresca con la nueva cuenta.

Cada cuenta mantiene su carpeta propia: `.profiles/<cuenta>/tiktok`.

## Cómo se instala

1. Copia el archivo `instalar-aislar-cuentas-tiktok.js` a la **carpeta del proyecto**
   (`C:\Users\msi\Downloads\autosocial-studio`).
2. Abre Git Bash en esa carpeta y ejecuta:

   ```bash
   node instalar-aislar-cuentas-tiktok.js
   ```

3. Cierra el dashboard si estaba abierto y vuelve a arrancarlo:

   ```bash
   npm run dashboard
   ```

Listo. El instalador es **idempotente**: si lo ejecutas otra vez, no duplica nada. Antes de
modificar cada archivo crea una copia de seguridad con la extensión
`.bak-AISLAR-CUENTAS-TIKTOK-<fecha>`.

## Cómo se revierte

```bash
node instalar-aislar-cuentas-tiktok.js --revert
```

Restaura los 4 archivos desde la última copia de seguridad.

## Qué archivos toca

| Archivo | Cambio |
|---|---|
| `src/tiktok-uploader.js` | El login y el estado de sesión aceptan la cuenta indicada. |
| `src/dashboard-server.js` | `/api/tiktok/login` y `/status` respetan `?accountId`. |
| `src/autoclone/index.js` | Programar / «Programar todo» usan la cuenta del `accountId` (validada). |
| `web/autopost.js` | Envía la cuenta seleccionada en todas las llamadas y reacciona al cambio de cuenta. |

## Comprobar que funciona

1. En el desplegable de la cabecera elige *Quinta de Gym*.
2. Ve a **TikTok / Auto Post**: el badge de cuenta debe mostrar *Quinta de Gym* y el estado
   de sesión debe ser el suyo (no el de otra).
3. Pulsa **«Programar todo»**: se usará el perfil `.profiles/quinta-de-gym/tiktok`.
4. Cambia a *ASL Low Cost* en el desplegable: el badge y la sesión cambian a la de ASL.

Si una cuenta aparece como «Sin sesión», inicia sesión con «Iniciar sesión en TikTok»
estando **esa** cuenta seleccionada; la sesión se guardará en su perfil aislado.

## Nota

Sigue siendo **una sola instancia** del dashboard (un solo servidor), pero cada cuenta usa su
propia sesión de TikTok de forma estricta. No hay varios servidores ni varios navegadores a
la vez: solo se publica en la cuenta seleccionada en cada momento, que es lo estable y lo que
evita el cruce de cuentas.
