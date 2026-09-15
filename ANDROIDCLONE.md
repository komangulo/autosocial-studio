# AndroidClone — App de escritorio

AndroidClone es una aplicación de escritorio para Windows que convierte un
**anuncio** (URL o vídeo) en un **proyecto Android compilable**, por fases.

Ya no necesitas abrir el navegador ni escribir `localhost`: se abre una ventana
propia.

---

## Cómo se arranca

| Modo | Cómo | Para qué |
|---|---|---|
| **Escritorio (recomendado)** | Doble clic en `ANDROIDCLONE.bat` | Uso normal. Ventana propia. |
| **Crear instalador .exe** | `npm run dist:win` | Genera `dist-desktop\AndroidClone-Setup-*.exe` para instalar en el PC. |
| **Portátil** | `npm run dist:portable` | Un `.exe` suelto, sin instalación. |
| **Dashboard (navegador)** | `npm start` | Modo antiguo, en `http://localhost:3028`. |

La app arranca un servidor interno **solo en tu PC** (loopback) y abre la ventana.
Nada se expone a internet: las únicas salidas son las llamadas a las APIs de IA
que tú configures.

---

## Cómo dar el vídeo del anuncio (importante)

**La URL de Play Store / App Store NO sirve para conseguir el vídeo.** La ficha de
tienda carga su vídeo por JavaScript y no expone ningún MP4. Está comprobado.

Orden de fiabilidad:

1. **Subir el vídeo a mano** (botón "Subir vídeo"). Funciona siempre. *Recomendado.*
2. **URL directa del anuncio**: TikTok, Instagram, X o un `.mp4` suelto.
3. **YouTube**: funciona, pero exige cookies del navegador (ver abajo).

La URL de la tienda se usa como **contexto** (para saber qué app es), no como vídeo.

---

## Cookies para YouTube

YouTube bloquea las descargas anónimas. En **Configurar IA y cookies** elige:

| Modo | Qué hace |
|---|---|
| **No usar cookies** | Para TikTok, Instagram, X y MP4 directos. |
| **Leer de un navegador** | yt-dlp lee las cookies de tu Chrome/Edge/Firefox, etc. Cierra ese navegador antes de descargar. |
| **Archivo cookies.txt** | Usa un archivo exportado (p. ej. con una extensión "Get cookies.txt"). Más estable. |

Si el navegador no tiene cookies accesibles, la app **reintenta sin cookies** y,
si aun así falla, te explica exactamente qué pasa.


---

## Proveedores de IA (multi-proveedor)

En **AndroidClone → Configurar proveedores** añades las claves que tengas. Se
guardan **solo en tu PC** (`.runtime/androidclone/settings.json`, permisos de tu
usuario) y no se envían a ningún sitio salvo al proveedor elegido.

| Proveedor | Gratis | Visión (imágenes) | Nota |
|---|---|---|---|
| **Google Gemini** | Sí (Flash / Flash-Lite) | Sí | El mejor para analizar fotogramas. |
| **OpenRouter** | Sí (35+ modelos) | Sí | Una sola key = muchos modelos gratis. |
| **Groq** | Sí | Sí | Gratis y muy rápido. |
| **DeepSeek** | 5M tokens de bienvenida | No | Barato después. |
| **OpenAI** | No | Sí | Se pone por si tienes crédito. |
| **Anthropic** | No | Sí | Se pone por si tienes crédito. |

Puedes elegir **un proveedor/modelo distinto para visión y para código**. La
fase de visión necesita un modelo con imágenes; la lista se filtra sola.

Las claves también se pueden sembrar por variable de entorno (`GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`) sin guardarlas en el archivo.

---

## Comprobar entorno (con auto-instalación)

Botón **Comprobar dependencias**. Revisa y, si falta algo, ofrece **Instalar**:

| Herramienta | Cómo se instala sola |
|---|---|
| yt-dlp | Descarga directa del binario. |
| FFmpeg / ffprobe | `winget install Gyan.FFmpeg` |
| JDK 17 | `winget install EclipseAdoptium.Temurin.17.JDK` |
| Android SDK | `winget install Google.AndroidCLI` |

Requiere `winget` (incluido en Windows 11). Si no está, muestra el enlace oficial.

---

## ¿Android SDK o hay otro entorno?

En 2026 el **Android SDK sigue siendo la base**: todo compila contra él. Lo que
cambió es cómo se usa:

- **Android Studio** (IDE) ya **no es obligatorio** para crear ni compilar.
- **Android CLI** (oficial de Google, estable 1.0) es la interfaz de terminal
  pensada para agentes y automatización. Instala el SDK, crea proyectos y
  gestiona emuladores. **AndroidClone la prefiere.**
- **Unity / Unreal** para juegos 3D serios (futuro).
- **Flutter / React Native / KMP** para apps multiplataforma (futuro).

AndroidClone maneja **Android CLI + JDK + Gradle** por debajo, sin que abras un IDE.

---

## Las 6 fases

1. **Ingesta** — yt-dlp baja el anuncio.
2. **Fotogramas** — ffmpeg extrae 1 fps (o cambios de escena).
3. **Visión** — el modelo describe pantallas, HUD y mecánicas.
4. **Plan** — el modelo arquitecto diseña pantallas, datos y fases.
5. **Scaffold** — se genera el proyecto Kotlin + Jetpack Compose.
6. **Build** — `gradlew assembleDebug` con auto-reparación (máx. 3 intentos).

---

## Archivos

| Ruta | Rol |
|---|---|
| `electron/main.js` | Proceso principal de Electron (ventana + backend). |
| `electron/preload.js` | Puente mínimo y seguro. |
| `src/androidclone/` | Todo el motor (fases, IA, scaffold, build). |
| `src/androidclone/ai-providers.js` | Catálogo multi-proveedor. |
| `ANDROIDCLONE.bat` | Arranque rápido en modo escritorio. |
| `INSTALAR-ANDROIDCLONE.bat` | Instalación de dependencias + build de UI. |
| `.runtime/androidclone/` | Ajustes, claves y proyectos generados. |

---

## Aviso legal

AndroidClone es para aprender y crear **tu propia app** a partir del concepto.
No copies nombre, logos, arte ni assets, y no publiques clones literales.
