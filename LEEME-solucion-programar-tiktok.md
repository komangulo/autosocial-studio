# Solución: «Programar todo en TikTok» usa el perfil seleccionado

## Qué arregla

Al pulsar **«Programar todo en TikTok ahora»** desde el perfil de una cuenta
(por ejemplo *kim tae jin*), la app programaba con la cuenta activa global en
lugar de la cuenta que estabas viendo, y el vídeo acababa en **otro** perfil de
TikTok (por ejemplo *amo dominante*).

Con este arreglo, «Programar todo» usa **siempre la cuenta seleccionada en el
desplegable**, que es la de su cola y su sesión.

## Cómo se instala (un solo comando)

1. Copia `solucion-programar-tiktok.js` a la carpeta del proyecto
   (`C:\Users\msi\Downloads\autosocial-studio`).
2. En Git Bash, en esa carpeta:

   ```bash
   node solucion-programar-tiktok.js
   npm run dashboard
   ```

Luego, en el navegador, recarga con **Ctrl+Shift+R**.

> Es tolerante: detecta lo que ya tengas aplicado (de intentos anteriores) y solo
> corrige lo que falta o está incoherente. **No toca `index.html` ni la interfaz**
> (eso fue lo que rompió el dashboard antes). Es idempotente: ejecutarlo dos veces
> no duplica nada.

## Cómo se revierte

```bash
node solucion-programar-tiktok.js --revert
```

Restaura los 3 archivos desde sus copias `*.bak-PROGRAMAR-TIKTOK-CUENTA-*`.

## Qué archivos toca

| Archivo | Cambio |
|---|---|
| `src/dashboard-server.js` | El router de programación recibe el validador de cuentas. |
| `src/autoclone/index.js` | «Programar» usa la cuenta del `accountId` enviado (validada). |
| `web/autopost.js` | Envía la cuenta seleccionada en «Programar» y «Programar todo». |

## Cómo comprobar que funciona

1. En el desplegable de la cabecera elige *kim tae jin*.
2. Ve a **TikTok** y pulsa «Programar todo»: debe usar el perfil de *kim tae jin*
   (su cola y su sesión), no el de otra cuenta.
3. Repite con *Amo dominante* y comprueba que usa el suyo.
