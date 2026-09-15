# Competencia / Modelado — Guía completa

Módulo del dashboard **AutoSocial Studio** que analiza un perfil competidor de
TikTok con IA y genera un **Prompt Maestro** reutilizable para tus propios
vídeos (listo para Google Flow).

---

## 1. Qué hace

1. Introduces un `@usuario` o la URL del perfil de TikTok.
2. `yt-dlp` lee los últimos N vídeos (métricas reales: vistas, likes, comentarios, compartidos).
3. `ffmpeg` extrae fotogramas de los vídeos más vistos.
4. **Gemini** (texto + visión) analiza todo y produce el informe.
5. Se genera el **Prompt Maestro** y puedes **aplicarlo directamente a una cuenta de Google Flow**.

---

## 2. Requisitos en tu PC (Windows)

| Herramienta | Para qué | Cómo instalarla |
|---|---|---|
| **Node.js 18+** | Ejecutar el dashboard | https://nodejs.org |
| **yt-dlp** | Leer métricas de TikTok | `autodownload\yt-dlp.exe` o https://github.com/yt-dlp/yt-dlp/releases |
| **ffmpeg + ffprobe** | Extraer fotogramas | https://www.gyan.dev/ffmpeg/builds/ (añade la carpeta `bin` al PATH) |
| **API key de Gemini** | Análisis con IA | Gratis en https://aistudio.google.com/app/apikey |

---

## 3. Instalación

1. Copia esta carpeta del proyecto a tu PC.
2. Doble clic en **`INSTALAR-COMPETENCIA.bat`** (instala dependencias y comprueba yt-dlp/ffmpeg).
3. Arranca con:
   ```
   npm start
   ```
4. Abre **http://localhost:3028** y entra en la pestaña **Competencia**.

---

## 4. Primer uso

1. Pulsa **"Configurar API Gemini"** y pega tu API key.
2. Escribe un `@usuario` (ej. `@noahglenncarter`) y elige cuántos vídeos analizar.
3. Pulsa **Analizar** y sigue el progreso en vivo.
4. Cuando termine, verás el informe completo y el **Prompt Maestro** al final.
5. Pulsa **"Aplicar a Google Flow"** y elige la cuenta: el prompt queda como
   plantilla fija de Flow para que tus vídeos repliquen el estilo estudiado.

---

## 5. Qué incluye el informe

- **Auditoría de métricas**: seguidores, vistas/likes/comentarios medios, engagement,
  cadencia de publicación y estimación de ingresos (Creator Rewards).
- **Estilo y formato**: duración media, texto en pantalla, transiciones, música/efectos,
  encuadre, paleta e iluminación.
- **Narrativa y ganchos**: cómo abren los primeros 3 segundos, CTAs, retención.
- **Categorización**: temáticas principales y qué vídeos le dan más viralidad.
- **Oportunidades**: huecos que el competidor no explota.
- **Prompt Maestro**: plantilla final para Google Flow (con `{{dynamic}}` para variar el tema por vídeo).

---

## 6. Dónde se guarda todo

| Dato | Ruta |
|---|---|
| Ajustes (API key, marca, idioma) | `.runtime/competitor/settings.json` |
| Informes analizados | `.runtime/competitor/reports/*.json` |
| Vídeos y fotogramas descargados | `.runtime/competitor/media/` |

Los ajustes se guardan con permisos restrictivos (solo tu usuario). Tu API key
nunca sale de tu PC salvo en las llamadas a Google.

---

## 7. API interna (por si quieres integrarla en otra parte)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/competitor/health` | Estado del módulo |
| GET/POST | `/api/competitor/settings` | Leer/guardar ajustes |
| GET | `/api/competitor/events` | Progreso en vivo (SSE) |
| POST | `/api/competitor/analyze` | Lanzar análisis `{ target, depth, brand, language }` |
| GET | `/api/competitor/reports` | Listar informes |
| GET | `/api/competitor/reports/:id` | Ver un informe |
| DELETE | `/api/competitor/reports/:id` | Borrar un informe |
| POST | `/api/competitor/reports/:id/master-prompt` | Regenerar el Prompt Maestro |
| GET | `/api/competitor/flow-accounts` | Cuentas de Flow disponibles |
| POST | `/api/competitor/reports/:id/apply-to-flow` | Aplicar prompt a una cuenta `{ accountId }` |

---

## 8. Problemas frecuentes

**"yt-dlp no devolvió contadores de vistas/likes"**
TikTok bloquea temporalmente la extracción. Reintenta más tarde o cambia de red/VPN.
El informe avisará de que ese perfil tiene datos parciales.

**"No se pudieron analizar fotogramas"**
`ffmpeg` no está en el PATH. Instálalo y reinicia la terminal.

**"La API key de Gemini no es válida"**
Genera una nueva en https://aistudio.google.com/app/apikey y vuelve a guardarla.

**El dashboard no arranca (`better-sqlite3`)**
Ejecuta `npm install` de nuevo; se recompila el módulo nativo para tu Node.
