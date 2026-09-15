# AndroidClone — Plan de implementación por fases

Objetivo: pestaña del dashboard **AutoSocial Studio** que convierte un anuncio
en un **proyecto Android compilable**, con progreso en vivo y auto-reparación.

Estado: `[x]` hecho · `[~]` en curso · `[ ]` pendiente.

---

## Fase 0 — Base (backend + UI + deps)  `[x]`

- `src/androidclone/` con controller, store, router `/api/androidclone/*`.
- Pestaña **AndroidClone** en `web/`.
- Comprobador de dependencias (`GET /deps`): yt-dlp, ffmpeg, java, sdkmanager, adb, gradle.
- Proyectos persistidos en `.runtime/androidclone/`.

## Fase 1 — Ingesta  `[x]`

- `POST /projects` con `{ adUrl | adFile, storeUrl }`.
- `yt-dlp` descarga el vídeo a `projects/<id>/video.mp4`.
- `ffprobe` extrae duración, resolución, fps.
- Sobrescribible con un vídeo local subido a mano.

## Fase 2 — Fotogramas  `[x]`

- `ffmpeg -vf fps=1,scale=768:-1` → `frames/f0001.jpg…`.
- Modo `keyframes` (solo cambios de escena) para anuncios largos.
- Límite configurable de frames (por defecto 40).

## Fase 3 — Visión IA  `[x]`

- `POST /projects/:id/vision`
- Gemini `gemini-2.5-flash` con las imágenes en la misma llamada.
- Salida JSON: pantallas, elementos de UI, HUD, mecánicas, estilo, género,
  monetización sospechada, flujo de usuario.

## Fase 4 — Plan de arquitectura  `[x]`

- `POST /projects/:id/plan`
- Gemini arquitecto recibe el JSON de visión + tus respuestas del cuestionario.
- Salida: `plan.md` + `plan.json` con:
  - resumen, tipo de app, stack y dependencias
  - pantallas/actividades y navegación
  - modelo de datos y estado
  - mecánicas y reglas
  - fases de desarrollo con criterio de terminado (DoD)
  - riesgos y supuestos

## Fase 5 — Scaffold Android  `[x]`

- `POST /projects/:id/scaffold`
- Genera proyecto Kotlin + Jetpack Compose:
  - `settings.gradle.kts`, `build.gradle.kts` (raíz y app)
  - `AndroidManifest.xml`, `MainActivity.kt`, tema, navegación
  - `gradle-wrapper` (versions.toml)
  - un archivo por pantalla descrita en el plan

## Fase 6 — Build y auto-reparación  `[x]`

- `POST /projects/:id/build`
- Ejecuta `gradlew assembleDebug` en tu PC (Windows/Linux).
- Si falla, el ciclo de reparación manda el error a Gemini, aplica el parche
  y reintenta (máx. 3 por defecto, configurable).
- Resultado: `app-debug.apk` en `projects/<id>/android/app/build/outputs/apk/debug/`.

## Fase 7 — Assets e identidad  `[ ]` (futuro)

- Iconos y capturas de tienda con IA de imagen.
- Generación de textos de la ficha de Play Store.

## Fase 8 — Juegos con motor  `[ ]` (futuro, investigación)

- Plantillas Unity/Godot en vez de Compose para juegos 3D.
- Requiere definir el motor y su build CLI.

---

## API

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/androidclone/health` | Estado del módulo |
| GET | `/api/androidclone/deps` | Comprobación de herramientas |
| GET | `/api/androidclone/settings` | Leer ajustes |
| POST | `/api/androidclone/settings` | Guardar ajustes (API key, modelo, límites) |
| GET | `/api/androidclone/events` | Progreso en vivo (SSE) |
| GET | `/api/androidclone/projects` | Listar proyectos |
| POST | `/api/androidclone/projects` | Crear proyecto (URL o vídeo local) |
| GET | `/api/androidclone/projects/:id` | Ver proyecto |
| DELETE | `/api/androidclone/projects/:id` | Borrar proyecto |
| POST | `/api/androidclone/projects/:id/ingest` | Fase 1 |
| POST | `/api/androidclone/projects/:id/frames` | Fase 2 |
| POST | `/api/androidclone/projects/:id/vision` | Fase 3 |
| POST | `/api/androidclone/projects/:id/plan` | Fase 4 |
| POST | `/api/androidclone/projects/:id/scaffold` | Fase 5 |
| POST | `/api/androidclone/projects/:id/build` | Fase 6 (auto-repair) |
| POST | `/api/androidclone/projects/:id/run` | Pipeline completo 1→6 |
| POST | `/api/androidclone/upload` | Subir un vídeo local |

## Archivos del proyecto en `.runtime/androidclone/`

```
projects/<id>/
├── project.json      # estado, métricas, rutas
├── video.mp4
├── frames/f0001.jpg …
├── vision.json       # salida Gemini visión
├── plan.md / plan.json
└── android/          # proyecto Gradle generado
    ├── settings.gradle.kts
    ├── gradle/libs.versions.toml
    ├── app/src/main/AndroidManifest.xml
    ├── app/src/main/java/.../MainActivity.kt
    └── app/build/outputs/apk/debug/app-debug.apk
```
