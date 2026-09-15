# HeliosGen — tapiz de generación con APIs gratuitas

Sección de AutoSocial Studio para generar **imágenes y vídeo con IA usando proveedores gratuitos**
(sin kie.ai). El corazón de la sección es un **tapiz de nodos** (canvas infinito tipo HeliosGen) cuya
configuración se exporta e importa como **JSON/YAML**.

## Cómo se usa

1. Arranca el dashboard (`npm run dashboard`).
2. Menú lateral → **Create → HeliosGen**.
3. Verás el tapiz. Arrastra y conecta nodos:
   - **Prompt** — escribe la idea.
   - **Imagen de referencia** — opcional; se adjunta a la generación.
   - **Configuración** — el JSON o YAML con `kind`, `model`, `prompt`, `aspectRatio`, `duration`,
     `resolution`, `references`, etc. Es la fuente de verdad de la generación.
   - **Modelo / Proveedor** — elige el modelo.
   - **Salida** — muestra el resultado.
4. Pulsa **Generar**. El resultado aparece en el nodo Salida.
5. **Guardar** / **Exportar JSON** persisten el tapiz; **Proyectos** los recarga.

## Proveedores gratuitos

| Proveedor | Tipo | Key | Modelos |
|---|---|---|---|
| **Puter.js** | navegador | no | Sora 2, Veo 3.x/2.0, Kling 2.1/2.0/1.6, Wan 2.7 (t2v/i2v/r2v), Vidu Q1, PixVerse V5, Nano Banana, GPT Image, FLUX, Grok |
| **Pollinations** | servidor | no | FLUX, Turbo (imagen) |
| **Google Flow** | navegador | no | Abre labs.google/fx/tools/flow para generar con Veo/Nano Banana (no tiene API pública) |
| **Google AI Studio** | servidor | sí (gratis) | Nano Banana, Imagen 4 |
| **Hugging Face** | servidor | sí (gratis) | FLUX.1 schnell, Wan 2.2, LTX-Video |

- **Puter.js** usa el modelo "User-Pays": no necesitas key, pero el resultado puede pedir una cuenta
  Puter al usuario la primera vez. Se carga desde `https://js.puter.com/v2/` solo al generar.
- **Google Flow** no ofrece API; el botón abre Flow y te deja copiar el prompt.
- Las claves de Google AI Studio y Hugging Face se guardan en **Ajustes** dentro del tapiz
  (`.\runtime\helios\settings.json`).

## Esquema del tapiz (JSON/YAML)

```json
{
  "version": 1,
  "name": "Estudio de podcast",
  "nodes": [
    { "id": "prompt-1", "type": "prompt", "position": { "x": 0, "y": 160 }, "data": { "text": "..." } },
    { "id": "reference-1", "type": "reference", "position": { "x": 0, "y": 470 }, "data": { "images": [] } },
    { "id": "config-1", "type": "config", "position": { "x": 390, "y": 150 },
      "data": { "format": "yaml", "value": "kind: video\nmodel: puter:sora-2\nprompt: ...\nduration: 9" } },
    { "id": "provider-1", "type": "provider", "position": { "x": 780, "y": 200 }, "data": { "model": "puter:sora-2" } },
    { "id": "output-1", "type": "output", "position": { "x": 1130, "y": 220 }, "data": {} }
  ],
  "edges": [
    { "id": "e1", "source": "prompt-1", "target": "config-1" },
    { "id": "e2", "source": "config-1", "target": "provider-1" },
    { "id": "e3", "source": "provider-1", "target": "output-1" }
  ]
}
```

El nodo `config` acepta **JSON o YAML**; el parser YAML soporta objetos, listas, strings, números,
booleanos y null. `references` puede ser una lista de URLs (`/api/helios/media/...`) o rutas públicas.

## Archivos

### Backend (`src/helios/`)
| Archivo | Rol |
|---|---|
| `models.js` | Catálogo: 9 modelos de imagen + 15 de vídeo, agrupados por proveedor. |
| `free-client.js` | Llamadas HTTP a Pollinations / Google AI Studio / Hugging Face y las que corren en el navegador (Puter, Flow). |
| `schema.js` | Esquema de nodos/edges y parser/emisor JSON **y YAML**. |
| `job-manager.js` | Cola de trabajos en memoria. |
| `controller.js` | Orquestación: ajustes, proyectos, historial, generación, guardado de assets. |
| `index.js` | Router Express `/api/helios/*`. |

### Frontal (`studio-ui/src/helios/`)
| Archivo | Rol |
|---|---|
| `HeliosStudio.tsx` | Canvas React Flow, barra de herramientas, proyectos, ajustes, generación. |
| `nodes.tsx` | Nodos: Prompt, Referencia, Config, Modelo, Salida, Nota. |
| `api.ts` | Cliente de los endpoints Helios. |
| `types.ts` | Tipos TS. |
| `helios.css` | Estilos del tapiz. |

Montaje: `web/index.html` incluye `<div id="heliosStudioRoot">` y carga `studio-assets/studio.js`
(construido desde `studio-ui/src/main.tsx` con Vite). El bundle es IIFE, se carga con `<script>` normal.

## Endpoints

- `GET  /api/helios/models` · `GET/POST /api/helios/settings`
- `GET  /api/helios/history` · `DELETE /api/helios/history/:id` · `POST /api/helios/history/clear`
- `GET  /api/helios/jobs/:id`
- `POST /api/helios/generate` · `POST /api/helios/save-generated`
- `POST /api/helios/upload` · `GET /api/helios/media/:name`
- `POST /api/helios/config/parse` · `POST /api/helios/config/stringify` · `GET /api/helios/config/default`
- `GET/POST /api/helios/projects` · `GET/PUT/DELETE /api/helios/projects/:id`

## Notas

- La generación en servidor (Pollinations, Google, HF) se guarda localmente en `.runtime/helios/uploads/`.
- La generación en navegador (Puter) devuelve una instrucción `client` y el frontend la ejecuta con
  `puter.ai.txt2img` / `puter.ai.txt2vid`; luego se persiste con `/api/helios/save-generated`.
- Dependencia nueva declarada: **`@xyflow/react`** (React Flow). Ejecuta `npm install` una vez y
  `npm run build:studio` (o `npm run dashboard`, que lo hace solo).
