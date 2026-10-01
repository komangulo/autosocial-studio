# Arreglo: cada cuenta de TikTok, su propia sesión (detección automática)

## Qué problema resuelve

AutoSocial Studio guardaba la sesión de TikTok en la carpeta de cada cuenta
(`.profiles/<cuenta>/tiktok`), pero **nunca comprobaba de qué usuario eran esas
cookies**. Si un perfil tenía guardada la sesión de **otra** cuenta de TikTok, la
app publicaba con la cuenta equivocada sin enterarse: las cuentas se "mezclaban".

Este arreglo hace que la app **detecte automáticamente el @usuario de TikTok** que
hay realmente en cada perfil y lo compare con la cuenta. Si no coincide, **no
publica** y te avisa.

Vale para **todas las cuentas, presentes y futuras**: cualquier perfil que crees
queda cubierto automáticamente.

## Qué hace exactamente

1. **Detección automática del @usuario** de TikTok logueado en el perfil (por la
   API interna de TikTok, por el enlace del perfil y, si falla, por cookies). No
   tienes que escribir nada.
2. **Memoria por cuenta** del @ detectado, para no volver a preguntarlo cada vez.
3. **Validación antes de publicar** («Programar todo»): si el @ del perfil no
   coincide con el de la cuenta, se **bloquea** con un mensaje claro:
   *"Sesión de TikTok equivocada en esta cuenta. Esta cuenta tiene la sesión de
   @X pero debería ser @Y. Abre «Iniciar sesión en TikTok» con ESA cuenta o usa
   «Cerrar sesión de esta cuenta»."*
4. **Botones en Management → Accounts**, uno por cuenta:
   - **Detectar @**: lee y guarda el usuario de TikTok de esa cuenta.
   - **Cerrar sesión**: borra la sesión **solo** de esa cuenta (no toca las demás)
     para que vuelvas a iniciar sesión con la correcta.
5. Se muestra el **@ detectado** de cada cuenta en la tabla de cuentas.

## Cómo se instala

1. Copia `instalar-identidad-tiktok.js` a la carpeta del proyecto
   (`C:\Users\msi\Downloads\autosocial-studio`).
2. En Git Bash, en esa carpeta:

   ```bash
   node instalar-identidad-tiktok.js
   npm run dashboard
   ```

Es **idempotente** (ejecutarlo dos veces no duplica nada) y crea copias de
seguridad de cada archivo antes de tocarlo.

> Si antes instalaste el arreglo `aislar-cuentas-tiktok`, **no pasa nada**: este
> se aplica encima y conviven. El orden no importa.

## Cómo se revierte

```bash
node instalar-identidad-tiktok.js --revert
```

Restaura los archivos desde sus copias de seguridad y elimina el módulo nuevo.
Si tenías el otro parche, sigue funcionando igual.

## Cómo arreglar las cuentas que YA están cruzadas

1. Ve a **Management → Accounts**.
2. En la cuenta afectada (p. ej. *Quinta de Gym*), pulsa **Detectar @** para ver qué
   cuenta de TikTok tiene dentro.
3. Si no es la correcta, pulsa **Cerrar sesión** (solo borra la de esa cuenta).
4. Ve a **TikTok → Iniciar sesión en TikTok** con esa cuenta seleccionada e inicia
   sesión con la cuenta correcta.
5. Pulsa **Detectar @** otra vez para confirmar que ya es la buena.

A partir de ahí, «Programar todo» no volverá a publicar en una cuenta equivocada:
si detecta un cruce, para y avisa.

## Qué archivos toca

| Archivo | Cambio |
|---|---|
| `src/tiktok-identity.js` | **Nuevo**: detecta y compara el @usuario de TikTok. |
| `src/tiktok-uploader.js` | Detecta el @, valida antes de publicar y ofrece reset por cuenta. |
| `src/account-manager.js` | Guarda el @ detectado por cuenta. |
| `src/dashboard-server.js` | Endpoints para detectar / resetear / listar. |
| `web/app.js` | Botones «Detectar @» y «Cerrar sesión» + columna con el @. |
| `web/index.html` | Columna «TikTok @» en la tabla de cuentas. |

## Nota técnica

La detección prueba, en orden: la API interna de TikTok
(`passport/web/account/info`), el enlace del perfil en la cabecera
(`a[href="/@usuario"]`) y las cookies (`uniqueId`). Así funciona aunque TikTok
cambie una de las tres. Si no consigue detectar el @, **no bloquea** (para no
impedir publicar por un fallo de lectura); solo bloquea cuando **sí** ha leído un
usuario distinto del esperado.
