/**
 * On-screen text detection + Spanish translation + ASS overlay generation.
 *
 * The pipeline samples frames from a video, asks a vision model (Gemini) to
 * read the on-screen text and its position/size, translates each phrase to
 * Spanish, then writes an ASS subtitle file that renders the translation at
 * the same place on screen with a similar size. The ASS file is burned into
 * the video with ffmpeg's `subtitles` filter by the AutoClone controller.
 */

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

// XKR[xkiro-rotacion] inicio - xKiro con rotacion automatica
const XKIRO_BASE = "https://api.xkiro.com/v1";
// Orden de preferencia, medido con carga y rafaga reales:
//   1) MiniMax M3      aguanta 25/25 peticiones seguidas
//   2) Qwen 3.7 Flash  10/10, respaldo solido
//   3) Ministral 14B   el mas rapido (329ms)
//   4) Mistral Small   el mas rapido empatado (336ms)
const XKIRO_MODELS = [
  "minimax/minimax-m3:free",
  "qwen/qwen3.7-flash:free",
  "mistralai/ministral-14b",
  "mistralai/mistral-small-2603",
];
// Segundos de cuarentena para un modelo que acaba de fallar.
const XKIRO_COOLDOWN_MS = 15000;
// Espera antes de reintentar cuando los 4 han fallado.
const XKIRO_ALL_FAILED_MS = 8000;
const XKIRO_MAX_ROUNDS = 3;

// XKI[indicador][state] inicio - modelo activo de TODA la cadena
// Se actualiza en cada intento, venga de xKiro, DeepSeek, Gemini u OpenRouter.
// Sirve para que la app pueda decir en todo momento que modelo trabaja.
const __modeloActivo = {
  modelo: "",            // id completo, p.ej. "minimax/minimax-m3:free"
  corto: "",             // nombre legible
  proveedor: "",         // "xKiro" | "DeepSeek" | "Gemini" | "OpenRouter"
  detalle: "",           // texto largo para la interfaz
  desde: 0,               // cuando empezo este modelo (ms)
  lote: 0,                // lote de fotogramas actual
  totalLotes: 0,
  historial: [],          // ultimos modelos usados
};
if (typeof globalThis !== "undefined") globalThis.__modeloActivo = __modeloActivo;

/** Marca que modelo esta trabajando ahora mismo. */
function marcarModelo(proveedor, modelo, { detalle = "", lote = 0, totalLotes = 0 } = {}) {
  const s = globalThis.__modeloActivo || __modeloActivo;
  const corto = String(modelo || "").split("/").pop() || modelo || "";
  const cambio = s.modelo !== modelo;
  s.modelo = modelo || "";
  s.corto = corto;
  s.proveedor = proveedor || "";
  s.detalle = detalle || `${proveedor} usando ${corto}`;
  s.desde = Date.now();
  s.lote = lote;
  s.totalLotes = totalLotes;
  if (cambio) {
    s.historial.unshift({ proveedor, modelo: modelo || "", corto, at: new Date().toISOString() });
    if (s.historial.length > 12) s.historial.length = 12;
  }
  return s;
}

/** Estado del modelo activo, para la app. */
function modelActivity() {
  const s = globalThis.__modeloActivo || __modeloActivo;
  return {
    modelo: s.modelo,
    corto: s.corto,
    proveedor: s.proveedor,
    detalle: s.detalle,
    segundos: s.desde ? Math.round((Date.now() - s.desde) / 1000) : 0,
    lote: s.lote,
    totalLotes: s.totalLotes,
    historial: s.historial.slice(0, 12),
  };
}
// XKI[indicador][state] fin
// XKR[xkiro-rotacion] fin
const DEEPSEEK_MODEL = "deepseek-flash"; // DS[consts]
const DEFAULT_VISION_MODEL = "gemini-3.6-flash";
// Free-tier key: only these (gemini-2.5-flash is what the free quota covers).
const FREE_VISION_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
// Free vision models on OpenRouter, tried in order when Gemini runs out of
// quota. The first one answered image requests reliably in testing.
const OPENROUTER_VISION_MODELS = [
  "nex-agi/nex-n2.5-pro:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "google/gemma-4-26b-a4b-it:free",
];
const DEFAULT_SAMPLE_SECONDS = 0.6; // one frame every 0.6s
const MAX_BATCH_FRAMES = 12; // frames per vision request
const MAX_FRAMES = 240; // hard cap for very long videos

function run(cmd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        const error = new Error(`Command timed out after ${timeout}ms: ${cmd}`);
        error.stderr = stderr;
        finish(reject, error);
      }, timeout);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      error.stderr = stderr;
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with code ${code}: ${cmd}`);
      error.code = code;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

function resolveFfmpeg() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function resolveFfprobe() {
  return process.env.FFPROBE_PATH || "ffprobe";
}

async function probeDuration(videoPath) {
  try {
    const { stdout } = await run(resolveFfprobe(), [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function probeSize(videoPath) {
  try {
    const { stdout } = await run(resolveFfprobe(), [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0", videoPath,
    ]);
    const [width, height] = stdout.trim().split("x").map(Number);
    return { width: width || 1080, height: height || 1920 };
  } catch {
    return { width: 1080, height: 1920 };
  }
}

/** Extract one small frame at every `stepSeconds`, capped at MAX_FRAMES. */
async function sampleFrames(videoPath, outputDir, { stepSeconds = DEFAULT_SAMPLE_SECONDS } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const duration = await probeDuration(videoPath);
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(duration / stepSeconds)));
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const time = Number((index * stepSeconds).toFixed(2));
    const target = path.join(outputDir, `t${String(Math.round(time * 1000)).padStart(7, "0")}.jpg`);
    try {
      await run(resolveFfmpeg(), [
        "-y", "-ss", String(time), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "5", target,
      ]);
      frames.push({ time, path: target });
    } catch {
      // Skip undecodable timestamps.
    }
  }
  return { frames, duration };
}

function parseJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  const startObj = candidate.indexOf("{");
  if (start >= 0 && end > start && (startObj < 0 || start < startObj)) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  if (startObj >= 0) {
    const endObj = candidate.lastIndexOf("}");
    return JSON.parse(candidate.slice(startObj, endObj + 1));
  }
  throw new Error("La IA no devolvió JSON válido para el texto en pantalla.");
}

const VISION_SYSTEM = `Eres un sistema de OCR + traduccion para videos verticales (TikTok).
Recibes una lista de fotogramas, cada uno con su marca de tiempo (segundo) y resolucion.
Debes leer TODO el texto visible en pantalla (subtitulos quemados, rotulos, titulos, stickers, texto del HUD) y, para cada bloque de texto:

1. Copia el texto original EXACTO tal y como se ve.
2. Traducelo al espanol de forma natural y breve (si ya esta en espanol, deja el mismo texto).
3. Estima su posicion y tamano como valores normalizados de 0 a 1:
   - x, y: esquina superior izquierda del bloque de texto respecto al ancho y alto del fotograma.
   - w, h: ancho y alto del bloque de texto respecto al ancho y alto del fotograma.
   - IMPORTANTE: el rectangulo debe cubrir TODO el texto visible, incluidas todas
     las lineas y los bordes de las letras. Redondea hacia afuera (deja un poco de
     margen) para que al taparlo con un recuadro opaco no asome nada del original.
     Si el texto ocupa varias lineas, devuelve un unico bloque que las englobe.
4. Da el segundo de inicio y fin en el que ese texto permanece visible (aproximado a partir de las marcas de tiempo dadas). Si solo aparece en un fotograma, usa ese segundo como inicio y fin + 0.6.

Reglas:
- No inventes texto que no se vea. Si un fotograma no tiene texto, no devuelvas nada para el.
- Ignora marcas de agua delgadas y contadores de la app (bateria, hora del sistema) si son pequenos.
- Agrupa palabras que forman una misma frase en un solo bloque.
- Manten el texto traducido corto: si es muy largo, resume sin perder el sentido.

Devuelve EXCLUSIVAMENTE un array JSON valido, sin markdown:
[
  {
    "start": 0.0,
    "end": 2.4,
    "original": "texto original",
    "translated": "texto traducido al espanol",
    "x": 0.10, "y": 0.72, "w": 0.80, "h": 0.10,
    "confidence": 0.0
  }
]`;

async function callGeminiVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const body = {
    systemInstruction: { parts: [{ text: VISION_SYSTEM }] },
    contents: [{
      role: "user",
      parts: [
        { text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` },
        ...frameParts,
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json" },
  };
  const response = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `El proveedor respondio ${response.status}`;
    if (/API key/i.test(message)) throw new Error("La API key no es valida.");
    if (response.status === 429) {
      const error = new Error(`Se agoto la cuota de IA. Detalle de Google: ${message}`);
      error.code = 429;
      throw error;
    }
    throw new Error(message);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  if (!text.trim()) throw new Error("Gemini devolvio una respuesta vacia.");
  return text;
}

/** Identify an out-of-quota (429) or quota-worded error from Gemini. */
function isQuotaError(error) {
  const message = String(error?.message || "");
  return error?.code === 429 || /cuota|quota|rate.?limit|exceeded/i.test(message);
}

/**
 * Fallback vision call through OpenRouter, used when Gemini is out of quota.
 * Uses the same frame parts, converted to the OpenAI-style image_url format.
 */
async function callOpenRouterVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const content = [{ type: "text", text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` }];
  for (const part of frameParts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.inline_data) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` },
      });
    }
  }
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://localhost",
      "X-Title": "AutoSocial Studio",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: VISION_SYSTEM },
        { role: "user", content },
      ],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenRouter respondio ${response.status}`;
    if (/api key|no auth|unauthor/i.test(message)) throw new Error("La API key de OpenRouter no es valida.");
    throw new Error(message);
  }
  return data.choices?.[0]?.message?.content || "";
}

// XKR[xkiro-rotacion] call - formato OpenAI
async function callXKiroVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const content = [{ type: "text", text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` }];
  for (const part of frameParts) {
    if (part.text) content.push({ type: "text", text: part.text });
    else if (part.inline_data) content.push({ type: "image_url", image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });
  }
  const response = await fetch(`${XKIRO_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: VISION_SYSTEM }, { role: "user", content }],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `xKiro respondio ${response.status}`;
    const error = new Error(message);
    if (response.status === 429 || /rate limit/i.test(message)) error.code = 429;
    if (/api key|unauthor|invalid|authentication|permission/i.test(message)) error.code = 401;
    throw error;
  }
  return data.choices?.[0]?.message?.content || "";
}

// El limite de xKiro es por IP y por minuto. Mantenemos el estado de
// rotacion FUERA de la funcion, para que se recuerde entre lotes y entre
// videos: el modelo que funciona se sigue usando, no se vuelve al primero.
const __xKiroEstado = { indice: 0, cooldown: new Map(), usos: new Map() };
// Visible para el router, que lo expone en /api/autoclone/xkiro. // XKP[xkiro-panel]
if (typeof globalThis !== "undefined") globalThis.__xKiroEstado = __xKiroEstado;

/**
 * Inspecciona los fotogramas con ROTACION entre los modelos de xKiro.
 * Conserva el modelo activo entre llamadas: solo cambia al siguiente
 * cuando el actual falla. El que falla descansa y se recupera solo.
 */
async function xKiroRotateVision(apiKey, parts, width, height, onProgress) {
  const estado = __xKiroEstado;
  let intentos = 0;
  const maxIntentos = XKIRO_MODELS.length * XKIRO_MAX_ROUNDS;

  while (intentos < maxIntentos) {
    intentos += 1;
    // Busca el modelo activo, o el primero disponible tras el.
    let elegido = null;
    for (let salto = 0; salto < XKIRO_MODELS.length; salto += 1) {
      const i = (estado.indice + salto) % XKIRO_MODELS.length;
      const modelo = XKIRO_MODELS[i];
      const hasta = estado.cooldown.get(modelo) || 0;
      if (Date.now() >= hasta) { elegido = modelo; estado.indice = i; break; }
    }

    // Todos en cuarentena: espera a que el primero se recupere.
    if (!elegido) {
      const tiempos = XKIRO_MODELS.map((m) => estado.cooldown.get(m) || 0).filter((t) => t > 0);
      const proximo = tiempos.length ? Math.min(...tiempos) : 0;
      const espera = Math.max(1500, Math.min(proximo - Date.now(), XKIRO_ALL_FAILED_MS));
      onProgress?.({ stage: "text-fallback", detail: `Todos los modelos de xKiro ocupados; esperando ${Math.round(espera / 1000)}s...` });
      await new Promise((r) => setTimeout(r, espera));
      continue;
    }

    try {
      const corto = elegido.split("/").pop();
// XKP[xkiro-panel]
      onProgress?.({ stage: "text-vision", detail: `Leyendo texto con xKiro ${corto} (modelo ${estado.indice + 1}/${XKIRO_MODELS.length})...` });
      marcarModelo("xKiro", elegido, { detalle: `xKiro ${corto}` }); // XKI[indicador][xkiro]
      const answer = await callXKiroVision(apiKey, elegido, parts, width, height);
      if (answer && answer.trim()) {
        estado.usos.set(elegido, (estado.usos.get(elegido) || 0) + 1);
        return answer;
      }
      // Respuesta vacia: tratamos como fallo suave.
      estado.cooldown.set(elegido, Date.now() + XKIRO_COOLDOWN_MS);
    } catch (error) {
      // Error de clave: no tiene sentido seguir rotando.
      if (error.code === 401) throw error;
      // Cualquier otro fallo: cuarentena y siguiente modelo.
      const seg = error.code === 429 ? 25000 : XKIRO_COOLDOWN_MS;
      estado.cooldown.set(elegido, Date.now() + seg);
      const corto = elegido.split("/").pop();
      onProgress?.({ stage: "text-warning", detail: `xKiro ${corto} fallo (${String(error.message).slice(0, 60)}); rotando al siguiente modelo...` });
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  return null;
}
// DeepSeek V4.1 Flash (deepseek-flash): OpenAI-compatible, vision nativa.
// Cada imagen cuesta como maximo 384 tokens de entrada.
async function callDeepSeekVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const content = [{ type: "text", text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` }];
  for (const part of frameParts) {
    if (part.text) content.push({ type: "text", text: part.text });
    else if (part.inline_data) content.push({ type: "image_url", image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });
  }
  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEEPSEEK_MODEL,
      messages: [{ role: "system", content: VISION_SYSTEM }, { role: "user", content }],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `DeepSeek respondio ${response.status}`;
    if (/api key|unauthor|invalid|authentication/i.test(message)) throw new Error("La API key de DeepSeek no es valida.");
    const error = new Error(message);
    if (response.status === 429) error.code = 429;
    throw error;
  }
  return data.choices?.[0]?.message?.content || "";
}

async function fileToBase64(filePath) { // DS[fn]
  return (await fs.readFile(filePath)).toString("base64");
}

/**
 * Detect on-screen text across the whole video and translate it to Spanish.
 * Returns [{ start, end, original, translated, x, y, w, h, confidence }]
 */
async function detectAndTranslate(videoPath, { apiKey, paidApiKey = "", paidModel = DEFAULT_VISION_MODEL, openRouterKey = "", deepSeekKey = "", xKiroKey = "", model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {
  if (!apiKey && !paidApiKey && !openRouterKey && !deepSeekKey && !xKiroKey) throw new Error("Falta la API key de IA para leer el texto en pantalla."); // XKR[xkiro-rotacion]
  const { width, height } = await probeSize(videoPath);
  const frameDir = path.join(workDir, "frames");
  onProgress?.({ stage: "text-frames", detail: "Extrayendo fotogramas para leer el texto..." });
  const { frames, duration } = await sampleFrames(videoPath, frameDir);
  if (!frames.length) return { boxes: [], errors: ["No se pudieron extraer fotogramas del video."], duration, frames: 0 };

  const models = modelCandidates(model);
  const freeModels = [...new Set(FREE_VISION_MODELS)].filter(Boolean);
  const errors = [];
  const results = [];
  let freeQuotaGone = false;
  let openRouterDown = false;
  let deepSeekDown = false; // DS[flag]
  const paidErrors = [];
  const sameGeminiKey = Boolean(apiKey && paidApiKey && apiKey === paidApiKey);
  onProgress?.({
    stage: "text-provider",
    detail: `Proveedores: Gemini gratis ${apiKey ? "configurado" : "sin key"}; Gemini de pago ${paidApiKey ? (sameGeminiKey ? "configurado, pero coincide con la gratuita" : "configurado") : "sin key"}; OpenRouter ${openRouterKey ? "configurado" : "sin key"}.`,
  });
  for (let index = 0; index < frames.length; index += MAX_BATCH_FRAMES) {
    const batch = frames.slice(index, index + MAX_BATCH_FRAMES);
    const parts = [];
    for (const frame of batch) {
      parts.push({ text: `Fotograma en el segundo ${frame.time}:` });
      parts.push({ inline_data: { mime_type: "image/jpeg", data: await fileToBase64(frame.path) } });
    }
    onProgress?.({ stage: "text-vision", detail: `Leyendo texto en pantalla (${index + batch.length}/${frames.length})...` });
    // XKI[indicador][lote] registro del lote para el indicador
    if (globalThis.__modeloActivo) {
      globalThis.__modeloActivo.lote = index + batch.length;
      globalThis.__modeloActivo.totalLotes = frames.length;
    }
    let text = null;
    let lastError = null;
    let quotaHit = false;
    // El estado vive en __xKiroEstado, fuera del bucle: se conserva entre lotes. // XKR[xkiro-rotacion]

    // 0) xKiro con ROTACION entre 4 modelos gratis. Primera eleccion.
    //    El resto de la cadena (Gemini gratis -> DeepSeek -> Gemini pago
    //    -> OpenRouter) queda intacta como respaldo final.
    if (text === null && xKiroKey) {
      // XKR[xkiro-rotacion] escalon
      try {
        const answer = await xKiroRotateVision(xKiroKey, parts, width, height, onProgress);
        if (answer && answer.trim()) text = answer;
      } catch (error) {
        lastError = error;
        onProgress?.({ stage: "text-warning", detail: `xKiro no disponible: ${error.message}` });
      }
    }
    // 1) Free Gemini key first (gemini-2.5-flash). Once its quota is gone we
    //    remember it and skip it for the rest of this video.
    if (apiKey && !freeQuotaGone) {
      for (const candidate of freeModels) {
        try {
          marcarModelo("Gemini", candidate, { detalle: `Gemini gratis (${candidate})` }); // XKI[indicador][gemini-free]
          text = await callGeminiVision(apiKey, candidate, parts, width, height);
          if (candidate !== freeModels[0]) model = candidate;
          break;
        } catch (error) {
          lastError = error;
          if (isQuotaError(error)) { quotaHit = true; break; }
          if (/API key|no es valida|permission|403/i.test(error.message)) break;
        }
      }
    }

    // 2) DeepSeek V4.1 Flash (deepseek-flash) — pago, con vision nativa y
    //    ~6.7x mas barato que Gemini de pago. Se usa cuando la cuota gratis
    //    de Gemini se agota. Si falla, se cae a Gemini de pago y luego a
    //    OpenRouter.
    if (text === null && deepSeekKey && !deepSeekDown) {
      try {
        onProgress?.({ stage: "text-fallback", detail: "Cuota gratis agotada; usando DeepSeek 4.1 Flash..." });
        const answer = await callDeepSeekVision(deepSeekKey, DEEPSEEK_MODEL, parts, width, height);
        if (answer && answer.trim()) {
          text = answer;
          onProgress?.({ stage: "text-fallback", detail: "Traduciendo con DeepSeek 4.1 Flash..." });
          marcarModelo("DeepSeek", DEEPSEEK_MODEL, { detalle: "DeepSeek 4.1 Flash" }); // XKI[indicador][deepseek]
        }
      } catch (error) {
        lastError = error;
        if (/no es valida/i.test(error.message)) deepSeekDown = true;
        onProgress?.({ stage: "text-warning", detail: `DeepSeek no pudo leer el lote: ${error.message}` });
      }
    }

    // 2b) Free quota exhausted: switch to the paid Gemini key (gemini-3.6-flash) // DS[chain]
    //    for this and every following batch.
    if (text === null && paidApiKey && (quotaHit || freeQuotaGone || !apiKey || lastError)) {
      if (!freeQuotaGone) onProgress?.({ stage: "text-fallback", detail: "Cuota gratis agotada; usando Gemini de pago (gemini-3.6-flash)..." });
      marcarModelo("Gemini", candidate || DEFAULT_VISION_MODEL, { detalle: "Gemini de pago" }); // XKI[indicador][gemini-pago]
      freeQuotaGone = true;
      const paidModels = [paidModel, "gemini-3.6-flash", "gemini-flash-latest"].filter((m, i, a) => m && a.indexOf(m) === i);
      for (const candidate of paidModels) {
        try {
          text = await callGeminiVision(paidApiKey, candidate, parts, width, height);
          onProgress?.({ stage: "text-fallback", detail: `Gemini de pago activo (${candidate}).` });
          break;
        } catch (error) {
          lastError = error;
          paidErrors.push(`${candidate}: ${error.message}`);
          onProgress?.({ stage: "text-warning", detail: `Gemini de pago no pudo usar ${candidate}: ${error.message}` });
          if (/API key|no es valida|permission|403/i.test(error.message)) break;
        }
      }
    }

    if (text === null && !paidApiKey && (quotaHit || freeQuotaGone)) {
      onProgress?.({ stage: "text-warning", detail: "La cuota gratis de Gemini se agotó y no hay una key de pago configurada." });
    }

    // 3) Last resort: OpenRouter's free vision models.
    if (text === null && openRouterKey && !openRouterDown) {
      const paidReason = paidErrors[0] || (paidApiKey ? "no devolvió una respuesta" : "no hay una key configurada");
      onProgress?.({ stage: "text-fallback", detail: `Gemini de pago no disponible (${paidReason}); usando OpenRouter...` });
      for (const orModel of OPENROUTER_VISION_MODELS) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const answer = await callOpenRouterVision(openRouterKey, orModel, parts, width, height);
            if (answer && answer.trim()) {
              text = answer;
              onProgress?.({ stage: "text-fallback", detail: `Traduciendo con OpenRouter (${orModel})...` });
              marcarModelo("OpenRouter", orModel, { detalle: `OpenRouter (${orModel})` }); // XKI[indicador][openrouter]
            }
            break;
          } catch (error) {
            lastError = error;
            if (/no es valida/i.test(error.message)) { openRouterDown = true; break; }
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
          }
        }
        if (text || openRouterDown) break;
      }
    }

    if (text === null) {
      const message = lastError?.message || "error desconocido";
      if (!errors.includes(message)) errors.push(message);
      onProgress?.({ stage: "text-warning", detail: `No se pudo leer un lote de fotogramas: ${message}` });
      continue;
    }
    try {
      const parsed = parseJson(text);
      // Models sometimes answer with a single object or wrap the list under a
      // key instead of returning a bare array. Normalize all of those.
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.boxes) ? parsed.boxes
        : Array.isArray(parsed?.results) ? parsed.results
        : parsed && typeof parsed === "object" ? [parsed]
        : [];
      if (list.length) {
        for (const item of list) {
          const translated = String(item.translated ?? item.original ?? "").trim();
          if (!translated) continue;
          const start = Number(item.start);
          const end = Number(item.end);
          results.push({
            start: Number.isFinite(start) ? start : batch[0].time,
            end: Number.isFinite(end) && end > start ? end : (Number.isFinite(start) ? start : batch[0].time) + 0.6,
            original: String(item.original || "").slice(0, 500),
            translated: translated.slice(0, 500),
            x: normalizeBoxValue(item.x, width, 0.05),
            y: normalizeBoxValue(item.y, height, 0.75),
            w: normalizeBoxValue(item.w, width, 0.9),
            h: normalizeBoxValue(item.h, height, 0.12),
            confidence: Number(item.confidence) || 0.5,
          });
        }
      }
    } catch (error) {
      if (!errors.includes(error.message)) errors.push(error.message);
      onProgress?.({ stage: "text-warning", detail: `Respuesta no valida de la IA: ${error.message}` });
    }
  }

  const boxes = dedupeBoxes(results);
  onProgress?.({ stage: "text-done", detail: `Detectados ${boxes.length} bloques de texto.` });
  return { boxes, errors, duration, frames: frames.length, width, height };
}

/** Build an ordered list of model names to try, so a wrong default still works. */
function modelCandidates(preferred) {
  const list = [preferred, "gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-latest"].filter(Boolean);
  return [...new Set(list)];
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

/**
 * The vision model may answer with normalized (0-1) values or with raw pixel
 * coordinates. Detect pixels (anything above 1) and scale by the frame size,
 * so both styles land in the same 0-1 space the ASS writer expects.
 */
function normalizeBoxValue(value, frameSize, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1 && frameSize > 0) return Math.max(0, Math.min(1, number / frameSize));
  return Math.max(0, Math.min(1, number));
}

/** Merge near-duplicate detections of the same phrase across adjacent frames. */
function dedupeBoxes(boxes) {
  const sorted = [...boxes].sort((a, b) => a.start - b.start || a.translated.localeCompare(b.translated));
  const merged = [];
  for (const box of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.original === box.original && box.start <= last.end + 0.35) {
      last.end = Math.max(last.end, box.end);
      last.x = (last.x + box.x) / 2;
      last.y = (last.y + box.y) / 2;
      last.w = (last.w + box.w) / 2;
      last.h = (last.h + box.h) / 2;
    } else {
      merged.push({ ...box });
    }
  }
  return merged;
}

// --------------------------------------------------------------- ASS writer

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function escapeAssText(text) {
  return String(text).replace(/\r?\n/g, "\\N").replace(/[{}]/g, "");
}

// Arial advance widths in units of 1/1000 em for the printable ASCII range.
// Used to measure how wide a line actually renders, instead of guessing a
// per-character average (which massively over-estimates narrow letters and was
// inflating the black box).
const ARIAL_WIDTHS = (() => {
  const table = {};
  const put = (chars, width) => { for (const ch of chars) table[ch] = width; };
  put(" ", 278);
  put("!", 278); put('"', 355); put("#", 556); put("$", 556); put("%", 889); put("&", 667);
  put("'", 191); put("(", 333); put(")", 333); put("*", 389); put("+", 584);
  put(",", 278); put("-", 333); put(".", 278); put("/", 278);
  put("0123456789", 556);
  put(":", 278); put(";", 278); put("<", 584); put("=", 584); put(">", 584); put("?", 556); put("@", 1015);
  const upper = {
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667,
    L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667,
    W: 944, X: 667, Y: 667, Z: 611,
  };
  for (const [ch, w] of Object.entries(upper)) table[ch] = w;
  put("[", 278); put("\\", 278); put("]", 278); put("^", 469); put("_", 556); put("`", 333);
  const lower = {
    a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500,
    l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500,
    w: 722, x: 500, y: 500, z: 500,
  };
  for (const [ch, w] of Object.entries(lower)) table[ch] = w;
  put("{", 334); put("|", 260); put("}", 334); put("~", 584);
  // Accented Latin letters render at the width of their base letter.
  const accents = { "á": "a", "à": "a", "â": "a", "ä": "a", "ã": "a", "å": "a",
    "é": "e", "è": "e", "ê": "e", "ë": "e", "í": "i", "ì": "i", "î": "i", "ï": "i",
    "ó": "o", "ò": "o", "ô": "o", "ö": "o", "õ": "o", "ú": "u", "ù": "u", "û": "u", "ü": "u",
    "ñ": "n", "ç": "c", "ý": "y" };
  for (const [accented, base] of Object.entries(accents)) table[accented] = table[base];
  for (const [accented, base] of Object.entries(accents)) {
    if (!/[a-z]/.test(base)) continue;
    table[accented.toUpperCase()] = table[base.toUpperCase()];
  }
  return table;
})();

/** Width of a string in em units (multiply by font size to get pixels). */
function measureEm(text) {
  let em = 0;
  for (const ch of String(text || "")) {
    em += (ARIAL_WIDTHS[ch] ?? 550) / 1000;
  }
  return em;
}

/**
 * Wrap text into lines that fit `maxWidthPx` at `fontSize`, breaking on spaces.
 * Returns the real rendered lines and the width of the widest one.
 */
function wrapText(text, fontSize, maxWidthPx) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [""], width: 0 };
  const fits = (candidate) => measureEm(candidate) * fontSize <= maxWidthPx;
  const lines = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (fits(attempt) || !current) {
      current = attempt;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const width = Math.max(...lines.map((line) => Math.round(measureEm(line) * fontSize)));
  return { lines, width };
}

/**
 * Build an ASS file that puts each translated phrase at its original position,
 * with an opaque rounded black box behind it so the original text is hidden.
 * Font size is derived from the detected box height relative to the video.
 */
function buildAss(boxes, { width = 1080, height = 1920, duration = 0 } = {}) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Overlay,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1",
    "Style: Cover,Arial,48,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  // Vision timestamps are estimates. Keep the black cover continuous across
  // short gaps between detections; otherwise the mirrored source subtitle can
  // flash through for one sampled interval before the next box starts.
  const ordered = [...boxes]
    .map((box) => ({
      ...box,
      start: Math.max(0, Number(box.start) || 0),
      end: Math.max(0, Number(box.end) || 0),
    }))
    .sort((a, b) => a.start - b.start);
  const timeline = ordered.map((box, index) => {
    const next = ordered[index + 1];
    const safeEnd = Math.max(box.start + 0.05, box.end);
    const nextStart = next ? Math.max(safeEnd, next.start) : duration;
    const gap = nextStart - safeEnd;
    const coverEnd = gap > 0 && gap <= 1.2 ? nextStart : safeEnd;
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const sameText = next && normalizeText(box.original) && normalizeText(box.original) === normalizeText(next.original);
    const textEnd = sameText || (!next && coverEnd > safeEnd) ? coverEnd : safeEnd;
    return { ...box, end: safeEnd, textEnd, coverEnd };
  });

  const events = [];
  for (const box of timeline) {
    const rawW = box.w * width;
    const rawH = box.h * height;

    // The cover is fit to the RENDERED translation, not to the detected box.
    // Vision boxes are rough and often far wider/taller than the glyphs, which
    // is what produced huge black slabs covering the video. We measure the real
    // text width and wrap it so the black area hugs the words.
    const text = escapeAssText(box.translated);

    // Font size: the whole rendered block (all lines) must fit inside the
    // original text's height, so the replacement sits in the same footprint.
    // We start from a single-line estimate and then shrink until it fits.
    const maxBlockH = Math.max(Math.round(height * 0.030), Math.round(rawH));
    const frameCap = height * 0.052 * 1.35;
    let fontSize = Math.max(14, Math.min(160, Math.round(Math.min(maxBlockH, frameCap) * 0.90)));

    // Wrap width: the original text width, grown just a little, never past 92%.
    const maxBoxW = Math.min(Math.round(width * 0.92), Math.round(rawW * 1.06) + Math.round(width * 0.02));
    const wrapAt = (size) => {
      const inner = Math.max(24, maxBoxW - Math.round(size * 0.4));
      const wrapped = wrapText(text, size, inner);
      return { wrapped, blockH: wrapped.lines.length * Math.round(size * 1.05) };
    };

    let { wrapped: layout, blockH } = wrapAt(fontSize);
    // Shrink until the block fits the original height (or we hit the floor).
    for (let attempt = 0; attempt < 22 && blockH > maxBlockH && fontSize > 16; attempt += 1) {
      fontSize = Math.max(16, Math.floor(fontSize * 0.94));
      ({ wrapped: layout, blockH } = wrapAt(fontSize));
    }
    // And grow a touch if there is spare room, so it is not needlessly small.
    for (let attempt = 0; attempt < 6 && fontSize < 160; attempt += 1) {
      const next = wrapAt(fontSize + 2);
      if (next.blockH > maxBlockH) break;
      fontSize += 2;
      layout = next.wrapped;
      blockH = next.blockH;
    }

    // Tight margins around the glyphs: enough to hide the original, no slab.
    const padX = Math.max(4, Math.round(fontSize * 0.20));
    const padY = Math.max(3, Math.round(fontSize * 0.10));
    const lineH = Math.round(fontSize * 1.05);
    // Width: wide enough to hide the ORIGINAL text where it was detected. The
    // box then sits EXACTLY on the original text's rectangle (aligned to its
    // edges, not centred with slack) and is only as tall as the rendered lines.
    const origLeft = box.x * width;
    const origTop = box.y * height;
    const origW = rawW;
    const origH = rawH;
    let coverW = Math.round(Math.min(Math.max(origW, layout.width + padX * 2), Math.round(width * 0.92)));
    let coverH = Math.round(layout.lines.length * lineH + padY * 2);
    coverH = Math.min(coverH, Math.round(height * 0.30));
    // Never slimmer than the original text, so the old text cannot peek out.
    coverH = Math.max(coverH, Math.round(origH));

    // Anchor to the original rectangle: centred on it horizontally and
    // vertically so the black sits exactly where the old text was.
    let coverX = Math.max(0, Math.round(origLeft - (coverW - origW) / 2));
    let coverY = Math.max(0, Math.round(origTop + (origH - coverH) / 2));
    coverX = Math.min(coverX, width - coverW);
    coverY = Math.min(coverY, height - coverH);

    const start = assTime(box.start);
    const end = assTime(box.end);
    const textEnd = assTime(box.textEnd);
    const coverEnd = assTime(box.coverEnd);

    // Rounded opaque black rectangle drawn as an ASS vector shape (\p1 = filled).
    const drawing = roundedRect(0, 0, coverW, coverH, Math.round(Math.min(coverW, coverH) * 0.18));
    events.push(`Dialogue: 0,${start},${coverEnd},Cover,,0,0,0,,{\\an7\\pos(${coverX},${coverY})\\p1\\bord0\\shad0\\c&H000000&}${drawing}{\\p0}`);

    // Translated text centered inside the covered area.
    const textCenterX = Math.round(coverX + coverW / 2);
    const textCenterY = Math.round(coverY + coverH / 2);
    const override = `{\\an5\\pos(${textCenterX},${textCenterY})\\fs${fontSize}\\bord2\\shad0}`;
    events.push(`Dialogue: 1,${start},${textEnd},Overlay,,0,0,0,,${override}${text}`);
  }

  return `${header}\n${events.join("\n")}\n`;
}

/**
 * Split a phrase into the words that will be highlighted one after another.
 * Punctuation-only tokens are dropped so they do not get their own beat.
 */
function karaokeWords(text) {
  return String(text || "")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
}

/**
 * Distribute a block's duration across its words. Long words get proportionally
 * more time, so the highlight follows the reading rhythm instead of jumping at
 * a constant speed.
 */
function karaokeTimings(words, durationSeconds) {
  const total = Math.max(0.1, Number(durationSeconds) || 0);
  const weights = words.map((word) => Math.max(2, word.replace(/[^\p{L}\p{N}]/gu, "").length));
  const sum = weights.reduce((acc, value) => acc + value, 0) || 1;
  const raw = weights.map((weight) => (weight / sum) * total);
  // Round to centiseconds (ASS \k unit) while keeping the exact total.
  const kValues = raw.map((value) => Math.max(1, Math.round(value * 100)));
  const drift = kValues.reduce((acc, value) => acc + value, 0) - Math.round(total * 100);
  if (kValues.length) kValues[kValues.length - 1] = Math.max(1, kValues[kValues.length - 1] - drift);
  return kValues;
}

/**
 * Karaoke-style replacement for the old black box + text overlay.
 *
 * The box keeps the exact geometry of the detected on-screen text (same place,
 * same size), but paints it solid black and renders the translation with an
 * ASS `\k` karaoke: the active word is highlighted in yellow while the rest of
 * the phrase stays white. Words are timed proportionally to their length, since
 * these videos have on-screen text but no speech to align against.
 */
function buildKaraokeAss(boxes, {
  width = 1080,
  height = 1920,
  duration = 0,
  activeColour = "&H0000FFFF&",
  baseColour = "&H00FFFFFF&",
  highlightScale = 112,
} = {}) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Overlay,Arial,48,${baseColour},${activeColour},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1`,
    // `Cover` paints the solid black rectangle that hides the original text.
    "Style: Cover,Arial,48,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    // `Karaoke` is the karaoke line: PrimaryColour is the not-yet-said word,
    // SecondaryColour the already-said one, so the highlight sweeps left to
    // right as the block plays. `\kf` smooths the transition.
    `Style: Karaoke,Arial,48,${baseColour},${activeColour},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const ordered = [...boxes]
    .map((box) => ({
      ...box,
      start: Math.max(0, Number(box.start) || 0),
      end: Math.max(0, Number(box.end) || 0),
    }))
    .sort((a, b) => a.start - b.start);
  const timeline = ordered.map((box, index) => {
    const next = ordered[index + 1];
    const safeEnd = Math.max(box.start + 0.05, box.end);
    const nextStart = next ? Math.max(safeEnd, next.start) : duration;
    const gap = nextStart - safeEnd;
    const coverEnd = gap > 0 && gap <= 1.2 ? nextStart : safeEnd;
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const sameText = next && normalizeText(box.original) && normalizeText(box.original) === normalizeText(next.original);
    const textEnd = sameText || (!next && coverEnd > safeEnd) ? coverEnd : safeEnd;
    return { ...box, end: safeEnd, textEnd, coverEnd };
  });

  const events = [];
  for (const box of timeline) {
    const rawW = box.w * width;
    const rawH = box.h * height;

    const words = karaokeWords(box.translated);
    if (!words.length) continue;
    const plainText = words.join(" ");

    // Size the cover around the RENDERED translation instead of the rough
    // vision box, so the black area stays tight to the glyphs.
    const maxBlockH = Math.max(Math.round(height * 0.030), Math.round(rawH));
    const frameCap = height * 0.052 * 1.35;
    let fontSize = Math.max(14, Math.min(160, Math.round(Math.min(maxBlockH, frameCap) * 0.90)));
    const maxBoxW = Math.min(Math.round(width * 0.92), Math.round(rawW * 1.06) + Math.round(width * 0.02));
    const wrapAt = (size) => {
      const inner = Math.max(24, maxBoxW - Math.round(size * 0.4));
      const wrapped = wrapText(plainText, size, inner);
      return { wrapped, blockH: wrapped.lines.length * Math.round(size * 1.05) };
    };
    let { wrapped: layout, blockH } = wrapAt(fontSize);
    for (let attempt = 0; attempt < 22 && blockH > maxBlockH && fontSize > 16; attempt += 1) {
      fontSize = Math.max(16, Math.floor(fontSize * 0.94));
      ({ wrapped: layout, blockH } = wrapAt(fontSize));
    }
    for (let attempt = 0; attempt < 6 && fontSize < 160; attempt += 1) {
      const next = wrapAt(fontSize + 2);
      if (next.blockH > maxBlockH) break;
      fontSize += 2;
      layout = next.wrapped;
      blockH = next.blockH;
    }

    const padX = Math.max(4, Math.round(fontSize * 0.20));
    const padY = Math.max(3, Math.round(fontSize * 0.10));
    const lineH = Math.round(fontSize * 1.05);
    // Wide enough to hide the original, tall only as the rendered lines, and
    // anchored exactly on the original text's rectangle.
    const origLeft = box.x * width;
    const origTop = box.y * height;
    const origW = rawW;
    const origH = rawH;
    let coverW = Math.round(Math.min(Math.max(origW, layout.width + padX * 2), Math.round(width * 0.92)));
    let coverH = Math.round(layout.lines.length * lineH + padY * 2);
    coverH = Math.min(coverH, Math.round(height * 0.30));
    // Never slimmer than the original text, so the old text cannot peek out.
    coverH = Math.max(coverH, Math.round(origH));

    let coverX = Math.max(0, Math.round(origLeft - (coverW - origW) / 2));
    let coverY = Math.max(0, Math.round(origTop + (origH - coverH) / 2));
    coverX = Math.min(coverX, width - coverW);
    coverY = Math.min(coverY, height - coverH);

    const start = assTime(box.start);
    const coverEnd = assTime(box.coverEnd);

    // Solid black box in the exact position of the original text.
    const drawing = roundedRect(0, 0, coverW, coverH, Math.round(Math.min(coverW, coverH) * 0.18));
    events.push(`Dialogue: 0,${start},${coverEnd},Cover,,0,0,0,,{\\an7\\pos(${coverX},${coverY})\\p1\\bord0\\shad0\\c&H000000&}${drawing}{\\p0}`);

    const span = Math.max(0.1, Number(box.textEnd) - Number(box.start));
    const kValues = karaokeTimings(words, span);
    // `\k` expects the duration in centiseconds before each word.
    const karaokeLine = words
      .map((word, index) => `{\\k${kValues[index]}}${escapeAssText(word)}`)
      .join(" ");
    // The `\fscx`/`\fscy` gives the active word a small pop; `\kf` sweeps the
    // highlight smoothly across the word instead of snapping.
    const override = `{\\an5\\pos(${Math.round(coverX + coverW / 2)},${Math.round(coverY + coverH / 2)})` +
      `\\fs${fontSize}\\bord2\\shad0\\kf\\fscx${highlightScale}\\fscy${highlightScale}}`;
    events.push(`Dialogue: 1,${start},${assTime(box.textEnd)},Karaoke,,0,0,0,,${override}${karaokeLine}`);
  }

  return `${header}\n${events.join("\n")}\n`;
}

/** ASS vector path for a rounded rectangle starting at (0,0) in local coords. */
function roundedRect(x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r === 0) {
    return `m ${x} ${y} l ${x + w} ${y} l ${x + w} ${y + h} l ${x} ${y + h}`;
  }
  // ASS uses cubic beziers (b x1 y1 x2 y2 x3 y3). Approximate each quarter arc
  // with the standard circle constant so corners look smooth.
  const k = Math.round(r * 0.5523);
  const x1 = x + w;
  const y1 = y + h;
  return [
    `m ${x + r} ${y}`,
    `l ${x1 - r} ${y}`,
    `b ${x1 - r + k} ${y} ${x1} ${y + r - k} ${x1} ${y + r}`,
    `l ${x1} ${y1 - r}`,
    `b ${x1} ${y1 - r + k} ${x1 - r + k} ${y1} ${x1 - r} ${y1}`,
    `l ${x + r} ${y1}`,
    `b ${x + r - k} ${y1} ${x} ${y1 - r + k} ${x} ${y1 - r}`,
    `l ${x} ${y + r}`,
    `b ${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y}`,
  ].join(" ");
}

async function writeAssFor(videoPath, boxes, assPath, size) {
  let assSize = size || {};
  if (!Number.isFinite(Number(assSize.duration)) || Number(assSize.duration) <= 0) {
    assSize = { ...assSize, duration: await probeDuration(videoPath) };
  }
  const ass = buildAss(boxes, assSize);
  await fs.mkdir(path.dirname(assPath), { recursive: true });
  await fs.writeFile(assPath, ass, "utf8");
  return assPath;
}

/** Same as writeAssFor, but writes the karaoke variant of the overlay. */
async function writeKaraokeAssFor(videoPath, boxes, assPath, size) {
  let assSize = size || {};
  if (!Number.isFinite(Number(assSize.duration)) || Number(assSize.duration) <= 0) {
    assSize = { ...assSize, duration: await probeDuration(videoPath) };
  }
  const ass = buildKaraokeAss(boxes, assSize);
  await fs.mkdir(path.dirname(assPath), { recursive: true });
  await fs.writeFile(assPath, ass, "utf8");
  return assPath;
}

module.exports = {
  detectAndTranslate,
  buildAss,
  buildKaraokeAss,
  karaokeWords,
  karaokeTimings,
  measureEm,
  wrapText,
  ARIAL_WIDTHS,
  writeAssFor,
  writeKaraokeAssFor,
  sampleFrames,
  dedupeBoxes,
  parseJson,
  probeDuration,
  probeSize,
  DEFAULT_VISION_MODEL,
  OPENROUTER_VISION_MODELS,
  XKIRO_BASE, XKIRO_MODELS, xKiroVision: callXKiroVision, xKiroRotateVision,
  xKiroRotateStatus,
  modelActivity, // XKI[indicador][export]
  isQuotaError,
  callOpenRouterVision,
};

/** Resumen del estado de la rotacion de xKiro, para mostrarlo en la app. */
function xKiroRotateStatus() {
  const estado = globalThis.__xKiroEstado;
  if (!estado) return { ok: false, activo: "", indice: 0, modelos: [] };
  const ahora = Date.now();
  const modelos = XKIRO_MODELS.map((id, i) => ({
    id,
    corto: id.split("/").pop(),
    usos: estado.usos.get(id) || 0,
    enEspera: (estado.cooldown.get(id) || 0) > ahora,
    esperaSeg: Math.max(0, Math.ceil(((estado.cooldown.get(id) || 0) - ahora) / 1000)),
    activo: i === estado.indice,
  }));
  return {
    ok: true,
    activo: XKIRO_MODELS[estado.indice] || "",
    corto: (XKIRO_MODELS[estado.indice] || "").split("/").pop(),
    indice: estado.indice,
    totalUsos: modelos.reduce((s, m) => s + m.usos, 0),
    modelos,
  };
}

