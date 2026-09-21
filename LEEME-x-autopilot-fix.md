# AutoSocial Studio — Configuración global de IA + X Autopilot

Este paquete hace dos cosas:

1. **Configuración de IA global**: guardas tus claves **una sola vez** y **toda la app**
   las usa en este orden automático:

   ```
   xKiro (gratis)  →  Gemini gratis  →  DeepSeek (pago)  →  Gemini de pago  →  OpenRouter
   ```

2. **X Autopilot arreglado + publicación automática en X** con login por usuario o cookies.

Si un proveedor falla o se agota su cuota, la app **pasa sola al siguiente**. No hay que
tocar nada.

---

## 1. Configuración de IA (nuevo)

Aparece una pestaña nueva en el menú lateral: **Configuración IA**.

- Una caja por proveedor con su campo de clave y su desplegable de modelos.
- Los **gratuitos van primero** y llevan la etiqueta `gratis`.
- Botón **Probar** para verificar una clave con una llamada real (muestra el modelo y los ms).
- Interruptor **Usar la cadena automática en toda la app**.

### Los modelos de xKiro (gratis) ya vienen cargados

Tomados de tu propia API de xKiro, en este orden:

| # | Modelo | Nota |
|---|---|---|
| 1 | `minimax/minimax-m3:free` | el que más aguanta |
| 2 | `qwen/qwen3.7-flash:free` | respaldo sólido |
| 3 | `mistralai/ministral-14b` | el más rápido |
| 4 | `mistralai/mistral-small-2603` | con visión |

xKiro usa `https://api.xkiro.com/v1` (compatible OpenAI) y su clave empieza por `sk-xt-`.

### Dónde se guardan las claves

En `settings.json`, en la raíz del proyecto. **Nunca se devuelven al navegador**: la
interfaz solo muestra la versión enmascarada (`sk-xt-9******224c`).

### Quién más usa esta configuración

- **X Autopilot** — genera con la cadena automática.
- **AutoClone** — si la config global tiene claves, las usa automáticamente (Gemini gratis
  y de pago, DeepSeek, OpenRouter).
- **Competencia / Modelado** — sigue usando su propia caja de Gemini para el análisis.

---

## 2. X Autopilot

### Arreglado

| # | Problema | Estado |
|---|---|---|
| 1 | El worker del cron **nunca arrancaba** (la casilla de generación diaria no hacía nada) | Arreglado |
| 2 | **Zona horaria rota**: `09:00` se guardaba como `09:00 UTC` (publicaba a las 11:00 en España) | Arreglado con `luxon` y `Europe/Madrid` |
| 3 | Sin API key generaba **texto de relleno** y lo encolaba como post real | Arreglado: bloquea y avisa |
| 4 | Sin timeout ni reintentos; un 429/500 abortaba el lote | Timeout 45s + reintentos |
| 5 | La cola **se duplicaba** al pulsar dos veces "Generar ahora" | Arreglado |
| 6 | Sin reintento de fallidos; pendientes antiguos se publicaban en cadena | Botón **Reintentar fallidos**; expiran a los 3 días |
| 7 | Límite de caracteres (280/4000) no se validaba | Arreglado |
| 8 | `x-autopilot-state.json` con claves no estaba en `.gitignore` | Añadido |
| 9 | Una sola IA sin respaldo | **Cadena global con respaldo automático** |

### Añadido

- **Login de X por navegador**: *Iniciar sesión* abre Chromium con un perfil propio
  (`.profiles/<cuenta>/x`); entras una vez, pulsas *Guardar sesión* y listo.
- **Login de X por cookies**: pega `auth_token=...; ct0=...` (o el JSON exportado) y pulsa
  *Importar cookies*. Se guardan con permisos `0600`.
- **Publicación real**: los posts de la cola se escriben y envían solos desde el compositor
  de X.

### Arreglos de login (2ª ronda)

| # | Problema | Estado |
|---|---|---|
| 10 | El estado de sesión leía el estado del **worker**, no el de la sesión de X (badge en «Comprobando…») | Arreglado: la ruta devuelve la sesión real |
| 11 | *Iniciar sesión* **bloqueaba** esperando a que X cargara del todo; parecía muerto | Arreglado: la ventana abre y responde al instante; X carga detrás |
| 12 | Perfil con candado de un Chromium cerrado a la fuerza («otra sesión», cuelgue) | Arreglado: se limpia el candado solo; si hay otra ventana viva, avisa claro |
| 13 | Si faltaba el navegador, el error quedaba oculto | Arreglado: mensaje explícito y registro en la consola del servidor |

---

## 3. Análisis de cuenta (nuevo)

Pestaña nueva en el menú: **Análisis de cuenta**. Metes cualquier `@` de X y la herramienta
estudia cómo se comunica esa cuenta (temas, tono, sentimiento, ganchos, CTAs, ritmo y formato)
y genera un **Manual de ADN** que usa la IA como molde para escribir.

- **La sesión de X se gestiona aquí mismo**, sin cambiar de pestaña: arriba verás el estado
  (*Sesión guardada* o *Sin sesión*) y los botones **Iniciar sesión**, **Guardar sesión** y
  **Cerrar**. Es la misma sesión que usa X Autopilot para publicar.
- **Enlace directo**: el recuadro de sesión se comprueba con un archivo propio
  (`web/acct-session.js`) que el dashboard sirve como recurso externo. Funciona aunque el
  resto del panel falle, y muestra el error exacto en rojo si algo no responde.
- **Mientras no haya sesión, Analizar queda bloqueado** y sale un aviso claro; X solo devuelve
  10-14 publicaciones sin sesión.
- **Cantidad**: 50 / 100 / 150 / 200 / 300 publicaciones (por defecto 150).
- **Progreso visible**: verás la fase y el contador (*Recogiendo publicaciones — 63 de 150*) en un recuadro azul. El análisis se hace en la **misma ventana de X** que usaste para entrar, así que la verás navegar por el perfil.
- **El informe se guarda y se lista solo**: al terminar, la cuenta aparece en *Cuentas analizadas*. Pulsa sobre ella para ver su detalle y su *Manual de ADN*; queda guardada en `.runtime/account-analysis/` para usarla cuando quieras (incluso al reabrir la app).
- **Usar esta cuenta como referencia** aplica ese estilo a la publicación diaria de X Autopilot.

### Historial de informes: no repitas el análisis (nuevo)

Cada vez que analizas una cuenta, el informe completo **se guarda en local con la fecha y la hora**
en el nombre:

```
.runtime/account-analysis/reports/<cuenta>/20260918-163045.json   (datos)
.runtime/account-analysis/reports/<cuenta>/20260918-163045.md     (manual de ADN)
```

En el panel, encima del *Manual de ADN*, tienes un **desplegable «Informe guardado»**:

- Muestra todos los análisis de esa cuenta, del más reciente al más antiguo, con su **fecha y hora**
  y cuántos posts tenía cada uno (p. ej. `18/09/2026 16:30:45 · 150 posts`).
- Elige uno y pulsa **Cargar informe** para verlo y usarlo **sin volver a analizar**. Ese informe
  pasa a ser el vigente (lo usa también la publicación diaria).
- Pulsa **Borrar informe** para eliminar solo ese, sin tocar los demás.
- La opción **«— Usar el análisis más reciente —»** vuelve al último.

Así, si ya analizaste una cuenta hace un rato, **no tienes que repetir el análisis**: lo seleccionas
y listo.

### Publicación diaria con el perfil (nuevo)

Dentro de la ficha de cada cuenta analizada tienes ahora un panel **«Publicación diaria con este perfil»**. Con esto ya no necesitas X Autopilot: la IA escribe cada día **imitando el estilo de esa
cuenta** y publica en **la cuenta de X con la que estás logueado** (la misma sesión que usaste para
analizar).

Rellena:

| Campo | Qué hace |
|---|---|
| **Tuits diarios** | Cuántos posts genera y publica al día (1–20). |
| **Primer tuit** | Hora del primero (tu hora local). |
| **Minutos entre tuits** | Separación base entre uno y otro (p. ej. 220 = 3 h 40 min). |
| **Variación (min, hasta +/-)** | Desvío aleatorio para no publicar siempre a horas en punto. Con 30, cada post cae dentro de ±30 min de su franja. |
| **Idioma de los posts** | **Español** o **Inglés**. La IA escribe todo el post en el idioma elegido. |
| **Máximo de caracteres** | Límite por post (280 para X normal). |
| **Temas de la cuenta** | Uno por línea o separados por comas. La IA **rota entre ellos** para no repetir. Si lo dejas vacío, escribe del estilo general. |

> **Los posts salen espaciados de verdad y a horas naturales.** Con «Primer tuit 09:00»,
> «220 minutos» y «variación 30», publica uno sobre las 09:00-09:30, otro ~3 h 40 min después
> (±30 min) y el tercero igual. Nunca todos de golpe, y **no siempre a horas en punto**: cada día
> caen en minutos distintos, pero dentro del mismo día no cambian. El panel te muestra las horas
> exactas de hoy y cuántos posts han salido.

Botones:

- **Guardar ajustes** — guarda sin activar nada.
- **Activar publicación diaria** — el interruptor. Cuando está activo, todos los días a la hora
  indicada la IA escribe el lote y lo publica sola. **Automático total, sin aprobación manual.**
- **Parar publicación diaria** — botón rojo de parada inmediata. Detiene la publicación y **no
  publica nada más hoy**, aunque luego la reactives. Mañana vuelve a su ritmo normal. Úsalo si algo
  no te convence y quieres cortar el grifo ya.
- **Publicar uno ahora** — genera y publica un post al instante, para probar.
- **Generar sin publicar** — genera un post y te lo muestra **sin publicarlo**.

Debajo verás el **historial** de los últimos posts (con su tema y resultado) y lo que pasó en el
último lote. Todo se guarda en `.runtime/acct-publisher.json`.

> Recuerda: para publicar hace falta que la **sesión de X esté guardada**. Si X pide login o la
> sesión caducó, el post fallará y lo verás en el historial con el motivo.

### Sin usuarios ni enlaces: nada se filtra a tus posts (nuevo)

El manual de ADN y los prompts ya **no contienen el `@` de la cuenta, ni nombres de usuario,
ni enlaces, ni correos, ni hashtags**. La IA aprende **solo el estilo** (temas, longitud, tono,
emojis, ritmo), nunca la identidad.

- El texto de muestra se limpia: `https://…` → `[enlace]`, `@usuario` → `[usuario]`,
  correos → `[correo]`, y se quitan los `#hashtags`.
- La cabecera del manual es genérica (*cuenta de referencia*) y el `@` original queda solo en
  un comentario técnico `<!-- REF: … -->` que la IA no lee.
- **Red de seguridad**: si la IA devuelve un texto con `@usuario` o un enlace, **se descarta** y
  se reintenta, en vez de publicarlo.

### «No hay ninguna API de IA configurada» (nuevo)

Ese aviso aparecía aunque tuvieras claves, porque la **cadena automática estaba desactivada**.
Ahora el motor **relee `settings.json`** antes de generar y el aviso dice exactamente qué pasa:

| Situación | Aviso |
|---|---|
| Claves guardadas pero interruptor apagado | *La cadena automática está desactivada. Abre Configuración IA y marca «Usar la cadena automática en toda la app».* |
| Interruptor encendido pero sin claves | *No hay ninguna API de IA configurada. Guarda al menos una clave (xKiro es gratis).* |
| Claves que no encajan en la cadena | *Hay claves guardadas pero ninguna es válida para la cadena.* |

Comprueba en **Configuración IA** que el interruptor **Usar la cadena automática en toda la app**
está marcado. Es la causa más habitual.

### Arreglado: publicación en cadena / no respeta el tiempo (importante)

Si viste el log repitiendo *«X no confirmó la publicación (el compositor sigue abierto)»* y te
publicó **muchos posts seguidos**, era un bug del motor de publicación. Ya está corregido:

- **Antes**: cuando X tardaba en cerrar el compositor, el motor creía que el post no había salido,
  **no marcaba la franja como usada** y la **reintentaba cada minuto**… pero el post **sí había
  salido**. Resultado: una ráfaga de posts idénticos o casi.
- **Ahora**:
  - Una franja **nunca se reintenta**. Si falla, se marca como usada y no se vuelve a intentar.
  - La confirmación es **inteligente**: espera hasta 25 s y acepta como éxito si aparece el aviso
    de enviado, si el compositor queda vacío o si se cierra. Solo falla si el texto sigue ahí de verdad.
  - **Candado de tiempo mínimo entre posts** (nuevo campo **«Mínimo entre posts (min)»**, por defecto
    **45**). Aunque algo se recalcule mal, el motor **jamás** publica dos veces dentro de ese margen.
- **Botón «Parar radar hoy»** en el panel del radar, por si quieres cortar el escaneo.

> Si ya te publicó de más, borra los posts sobrantes a mano en X. El motor corregido no volverá a
> hacerlo. En el panel verás el nuevo campo **Mínimo entre posts (min)**: súbelo si quieres más aire
> entre publicaciones.


---

## 4. Radar de noticias y afiliados (nuevo)

Segundo panel dentro de **Análisis de cuenta**. En vez de escribir posts de la nada, el radar
**busca noticias reales en X**, las reescribe y las republica **con tus links de afiliado**.

### El casillero de temas (tú decides qué es noticia)

Un cuadro de texto **«Temas a escanear»**: escribe ahí tus palabras clave, una por línea o
separadas por comas. Ejemplo:

```
One Piece
TCG
One Piece Card Game
Pokemon TCG
```

**Solo se publica un post si su texto contiene alguna de esas palabras.** Si no coincide ninguna,
se descarta. Así tú controlas de qué habla el radar; no inventa temas.

### El casillero de afiliados (tú pegas tus links)

Tres cajas, una por tienda, donde pones **tu** ID o **tu** link:

| Tienda | Qué pegar | Qué hace el radar |
|---|---|---|
| **Amazon** | tu tag, ej. `miweb-21`, o un link corto `https://amzn.to/…` | reconstruye el link del producto con tu tag |
| **eBay** | tu campaign ID, o un link | añade tu campaña al link del producto |
| **Target** | tu afid, o un link | añade tu afid al link del producto |

Si una caja está vacía, los links de esa tienda se dejan como estaban (no se rompe nada).
Cuando el post original lleva un link de tienda, el radar lo cambia por el tuyo; si no lleva link,
**se publica sin link** (no se inventan productos).

### Qué hace exactamente el ciclo

1. **Escanea** el buscador de X con tu sesión, una búsqueda por palabra clave (orden «más recientes»).
2. **Filtra** por tus temas (sin distinguir mayúsculas ni acentos).
3. **Deduplica**: guarda el id del post y una «firma» de la noticia → la misma noticia **no se repite**.
4. **Reescribe con IA** en tono de aviso breve, en tu idioma, sin copiar frases ni meter `@`, URLs,
   correos o hashtags.
5. **Sustituye** los links de tienda por los tuyos.
6. **Publica** en tu cuenta de X **conservando las imágenes del post original**.

Tope **20 posts/día** por defecto, revisión **cada 60 min**, y no repite lo ya publicado.

### Controles del panel

- **Guardar ajustes del radar** — guarda temas, links y límites.
- **Escanear sin publicar** — busca y te muestra un candidato **sin tocar tu cuenta**. Pruébalo aquí primero.
- **Escanear y publicar ahora** — ciclo completo, una vez.
- **Solo publicar posts que ya lleven link de tienda** — para no republicar noticias sin link.
- Debajo, el **historial** de lo publicado por el radar, con el tema y la tienda de afiliado aplicada.

Estado en `.runtime/acct-radar.json`.

> **Antes de dejarlo solo**: pulsa **Escanear sin publicar** y comprueba que los temas y los links
> te convencen. Luego ya le das a publicar.

---

## Instalación (Windows)

1. Copia el contenido del zip (con `instalar-x-autopilot-fix.js` y la carpeta `assets`)
   dentro de la raíz del proyecto, junto a `package.json`.
2. Ejecuta:

   ```bat
   node instalar-x-autopilot-fix.js
   ```

3. Reinicia el dashboard:

   ```bat
   node src/dashboard-server.js
   ```

4. Abre **Configuración IA**, pega tu clave de xKiro (`sk-xt-...`) y pulsa **Guardar**.
   Pulsa **Probar** para confirmar. Opcionalmente añade Gemini, DeepSeek y OpenRouter.

El instalador es **idempotente**: puedes repetirlo sin romper nada. Guarda copias de los
archivos que toca como `*.xap-backup`.

> **Si ya ejecutaste una versión anterior** y todo salía `[SKIP]`, esta versión **sí actualiza**
> el bloque de *Análisis de cuenta*: verás `[OK] bloque antiguo retirado para actualizarlo`.
> Si sigue todo en `[SKIP]`, es que ya tienes la versión buena.
>
> **Sin usuarios/URLs + aviso de IA (4ª ronda):** esta ejecución mostrará
> `[OK] src/account-analyzer.js actualizado (sin usuarios/URLs en el manual)`,
> `[OK] src/x-autopilot.js reescrito (v2 - sin usuarios/URLs en los prompts)` y
> `[OK] src/ai-config.js creado`. Reinicia el dashboard después.
>
> **Publicación diaria desde Análisis de cuenta (5ª ronda):** esta ejecución añadirá
> `[OK] src/acct-publisher.js creado (publicacion diaria con ADN de una cuenta)`,
> `[OK] dashboard-server.js: endpoints de publicacion diaria anadidos`,
> `[OK] web/index.html: panel de publicacion diaria anadido` y
> `[OK] web/acct-session.js actualizado`. Al terminar, pulsa **Ctrl+F5** para ver el panel nuevo.
>
> **Publica aunque tengas Chrome abierto (6ª ronda):** antes, si tenías una ventana de Chrome
> con el perfil de X abierta, publicar fallaba con `launchPersistentContext ... browser has been
> closed`. Ya no: la publicación usa un navegador ligero con tus cookies guardadas, sin tocar el
> perfil, así que **no choca con la ventana de login ni de análisis**. Verás
> `[OK] src/x-auth.js actualizado (publica sin bloquear el perfil)`.
>
> **Publica con Chromium (7ª ronda):** la publicación usa ahora el **Chromium propio de Playwright**
> (no tu Chrome), en segundo plano. Puedes tener Chrome abierto con X sin que nada se pelee.
> Si nunca has descargado Chromium, una sola vez:
>
> ```bat
> npx playwright install chromium
> ```
>
> **Historial de informes (8ª ronda):** cada análisis se guarda ahora con fecha y hora y puedes
> volver a elegir uno anterior desde el desplegable **Informe guardado**, sin repetir el análisis.
> Verás `[OK] dashboard-server.js: endpoints de historial de informes anadidos`,
> `[OK] web/index.html: selector de informes guardados anadido` y
> `[OK] web/acct-session.js actualizado (historial de informes anadido)`.
>
> **Idioma + posts espaciados (9ª ronda):** arreglados dos fallos del motor:
> (1) ahora hay un **selector de idioma** (Español / Inglés) para los posts, y
> (2) los posts se publican **espaciados según «minutos entre tuits»**, uno por franja horaria,
> en vez de todos de golpe. Verás `[OK] src/acct-publisher.js actualizado`.
>
> **Horas naturales con variación (10ª ronda):** añadido el campo **«Variación»** para que los
> posts no caigan siempre a horas en punto. Cada día se calculan minutos distintos (p. ej. 09:12,
> 13:19, 17:03), estables dentro del mismo día. Verás
> `[OK] web/index.html: campos de idioma/variacion anadidos al panel` y
> `[OK] src/acct-publisher.js actualizado (idioma + posts espaciados)`.
>
> **Botón «Parar publicación diaria» (11ª ronda):** botón rojo de parada inmediata. Corta la
> publicación y no sale nada más hoy; mañana vuelve a su ritmo. Verás
> `[OK] dashboard-server.js: endpoint de parada de publicacion anadido` y
> `[OK] src/acct-publisher.js actualizado`.
>
> **Arreglos de login (2ª ronda):** si tenías el login atascado, esta ejecución mostrará
> `[OK] src/x-auth.js actualizado`, `[OK] src/account-analyzer.js actualizado` y
> `[OK] ... ruta de sesion corregida`. Reinicia el dashboard después.
>
> **Badge «Comprobando…» que no cambia (3ª ronda):** la CSP del dashboard bloquea los scripts
> en línea, así que el enlace se movió a un archivo externo (`web/acct-session.js`). Verás
> `[OK] web/acct-session.js creado` y `[OK] ... enlace a acct-session.js anadido`.
> Tras instalarlo, **recarga con Ctrl+F5**.

## Cómo dejarlo publicando solo

1. **Configuración IA** → guarda al menos la clave de xKiro (gratis) y pulsa Probar.
2. **X Autopilot** → **Sesión de X** → *Iniciar sesión* → entra en X → *Guardar sesión*.
   (O pega tus cookies y pulsa *Importar cookies*.)
   La misma sesión te sirve para **Análisis de cuenta**, que tiene sus propios botones de sesión.
3. **Modo de publicación**: **API oficial de X**. En esta versión el modo `live` publica
   usando la sesión de X guardada, sin necesidad de tokens de API.
4. Rellena **Usuario X**, **Posts diarios** y **Horarios** (tu hora local).
5. Marca **Activar generación diaria autónoma** y pulsa **Guardar**.

## Seguridad

- Las claves y cookies nunca se devuelven al navegador.
- Las cookies se guardan en formato Netscape con permisos `0600`.
- **Si pegaste claves en un chat, revócalas y genera nuevas.** Guárdalas solo en la app.
