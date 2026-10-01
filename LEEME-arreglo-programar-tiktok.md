# Arreglo: «Programar todo en TikTok» usa el perfil seleccionado

## Qué problema resuelve

Al pulsar **«Programar todo en TikTok ahora»** desde el perfil de una cuenta
(por ejemplo *kim tae jin*), la app usaba la cuenta activa global en lugar de la
cuenta que estabas viendo. Resultado: programaba/publicaba con **otro** perfil de
TikTok (por ejemplo *amo dominante*).

Con este arreglo, «Programar todo» usa **siempre la cuenta seleccionada en el
desplegable**, que es la misma para la que ves su cola y su sesión.

## Qué cambia (mínimo, sin tocar la interfaz)

| Archivo | Cambio |
|---|---|
| `web/autopost.js` | Envía la cuenta seleccionada en «Programar» y «Programar todo». |
| `src/autoclone/index.js` | Usa esa cuenta (validada) en lugar de la global. |
| `src/dashboard-server.js` | Pasa el validador de cuentas al módulo de programación. |

No se modifica `index.html`, ni la tabla de cuentas, ni se añaden columnas ni
botones. Cero cambios visuales.

## Cómo se instala

1. Copia `arreglo-programar-tiktok.js` a la carpeta del proyecto
   (`C:\Users\msi\Downloads\autosocial-studio`).
2. En Git Bash, en esa carpeta:

   ```bash
   node arreglo-programar-tiktok.js
   npm run dashboard
   ```

Es **idempotente** (ejecutarlo dos veces no duplica nada) y crea copias de
seguridad (`*.bak-PROGRAMAR-TIKTOK-CUENTA-*`) antes de tocar cada archivo.

## Cómo se revierte

```bash
node arreglo-programar-tiktok.js --revert
```

## Cómo comprobar que funciona

1. En el desplegable de la cabecera elige, por ejemplo, *kim tae jin*.
2. Ve a **TikTok** y comprueba que el perfil de TikTok que se abre al programar
   es el de esa cuenta (no el de otra).
3. Repite con otra cuenta (p. ej. *Amo dominante*): debe usar su propio perfil.

## Nota sobre el diagnóstico

Pasando el diagnóstico de solo lectura (`diag-cuentas-tiktok.js`) salió que
**todos los perfiles tienen su sesión correcta**:

```
amo-dominante  -> @amo.dominante.madrid.01   ✅
kim-tae-jin    -> @kim.tae.jiin              ✅
asialowcost    -> @asialowcost               ✅
kitty-miau     -> @kitty__miau               ✅
series-y-dramas-> @minidramas.tv             ✅
reviews        -> @philippines.daily.vlog    ✅
erick-techwired-> (no logueado)              ✅
default        -> @kim.tae.jiin              ⚠️  (carpeta legacy compartida)
```

El cruce principal lo causaba el botón de programar (este arreglo). Además, la
cuenta **`default`** usa una carpeta antigua **compartida** (`.profile`) donde hay
una sesión de *kim tae jin*; como no usas `default`, se puede dejar o eliminar,
pero conviene no usarla para TikTok.
