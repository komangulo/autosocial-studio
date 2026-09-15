/**
 * Competitor AI analyst.
 *
 * Uses Google AI Studio (Gemini) because it is the one provider that accepts
 * both text and images in the same call, with a usable free tier.
 *
 * Input: the raw collector summary + optional frames of the top videos.
 * Output: a structured "Perfil de Competencia" (JSON) plus a "Prompt Maestro".
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "gemini-3.6-flash";
// Free vision models on OpenRouter used when Gemini runs out of quota.
const OPENROUTER_VISION_MODELS = [
  "nex-agi/nex-n2.5-pro:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "google/gemma-4-26b-a4b-it:free",
];

const SYSTEM_PROMPT = `Eres un analista senior de contenido vertical (TikTok) y estratega de crecimiento.
Recibes datos REALES de un perfil competidor (métricas de vídeos, descripciones, música y, cuando existan, fotogramas).
Tu trabajo es producir un informe accionable y sin relleno. Si un dato no está en la evidencia, dilo como "no observado" en vez de inventarlo.
Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin markdown, sin texto antes ni después.

Esquema exacto:
{
  "summary": "resumen ejecutivo de 2-3 frases",
  "metrics": {
    "followers": number,
    "avgLikes": number,
    "avgComments": number,
    "avgViews": number,
    "engagementRate": number,
    "postingCadencePerWeek": number|null,
    "estimatedMonthlyEarningsUsd": { "low": number, "high": number },
    "notes": "cómo se calcularon y qué limitaciones tienen"
  },
  "style": {
    "avgDurationSeconds": number,
    "onScreenText": "uso de texto en pantalla",
    "transitions": "transiciones observadas",
    "musicAndSfx": "música/efectos recurrentes",
    "paletteAndLighting": "paleta de colores e iluminación",
    "framing": "tipos de plano y encuadre"
  },
  "narrative": {
    "hooksFirst3s": "cómo abren los primeros 3 segundos, con ejemplos",
    "structure": "estructura típica del vídeo",
    "ctas": "llamados a la acción usados",
    "retention": "técnicas de retención detectadas"
  },
  "categories": {
    "mainTopics": ["temas principales"],
    "viralPatterns": "qué tipo de vídeos le dan más viralidad y por qué",
    "bestPerformingExamples": ["ids o títulos de los vídeos top"]
  },
  "opportunities": ["huecos o ángulos que el competidor no explota"],
  "masterPrompt": "plantilla de prompt larga y reutilizable, lista para pegar en un generador de vídeo/imagen por IA, que replique su estilo pero adaptada a nuestra marca. Incluye estructura de guion, tipo de plano, iluminación, ritmo, hook y CTA."
}`;

function buildUserPrompt(report, { brand = "", language = "es", topFrames = [] } = {}) {
  const payload = {
    competidor: report.handle,
    url: report.url,
    resumen_matematico: report.summary,
    videos: report.videos.map((video) => ({
      id: video.id,
      titulo: video.title,
      duracion_s: video.durationSeconds,
      views: video.views,
      likes: video.likes,
      comentarios: video.comments,
      shares: video.shares,
      engagement_pct: video.engagementRate,
      fecha: video.uploadDate,
      musica: [video.artist, video.track].filter(Boolean).join(" - "),
      hashtags: video.hashtags,
    })),
    fotogramas_analizados: topFrames.map((frame) => ({ videoId: frame.videoId, nota: frame.note || "" })),
  };
  return [
    brand ? `Marca del cliente: ${brand}.` : "No se ha especificado la marca del cliente.",
    `Idioma del informe: ${language}.`,
    "Analiza este competidor y produce el JSON del esquema.",
    "Datos reales:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function parseJsonResponse(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("La IA no devolvió JSON válido.");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function listModels(apiKey) {
  const response = await fetch(`${GEMINI_BASE}/models?key=${encodeURIComponent(apiKey)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini respondió ${response.status}`);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function callGemini(apiKey, model, parts, { temperature = 0.4, maxOutputTokens = 8192 } = {}) {
  const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, maxOutputTokens, responseMimeType: "application/json" },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data.error?.message || `Gemini respondió ${response.status}`;
    if (/API key/i.test(message)) throw new Error("La API key de Gemini no es válida.");
    if (response.status === 429) throw new Error(`Se agotó la cuota de Gemini. Detalle de Google: ${message}`);
    if (response.status === 404 || /no longer available|not found|is not supported/i.test(message)) {
      let hint = "";
      try {
        const models = await listModels(apiKey);
        const preferred = models.find((m) => /flash/i.test(m) && !/vision|embedding|image|tts/i.test(m)) || models[0];
        if (preferred) hint = ` Prueba con otro modelo disponible, por ejemplo "${preferred}".`;
      } catch { /* listing is best-effort */ }
      throw new Error(`El modelo "${model}" no está disponible.${hint}`);
    }
    throw new Error(message);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini devolvió una respuesta vacía.");
  return { text, usage: data.usageMetadata || null };
}

/** Detect an out-of-quota failure from Gemini. */
function isQuotaError(error) {
  return /cuota|quota|rate.?limit|exceeded|429/i.test(String(error?.message || ""));
}

/**
 * Fallback analysis through OpenRouter's free vision models, used when Gemini
 * is out of quota. Mirrors analyze()'s inputs in the OpenAI-style format.
 */
async function analyzeWithOpenRouter(apiKey, report, { brand = "", language = "es", frames = [] } = {}) {
  const list = Array.isArray(apiKey) ? apiKey : String(apiKey || "").split(",").map((k) => k.trim()).filter(Boolean);
  for (const model of OPENROUTER_VISION_MODELS) {
    for (const key of list) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const content = [{ type: "text", text: buildUserPrompt(report, { brand, language }) }];
          for (const frame of frames.slice(0, 12)) {
            content.push({ type: "text", text: `Fotograma del vídeo ${frame.videoId}:` });
            content.push({
              type: "image_url",
              image_url: { url: `data:${frame.mimeType || "image/jpeg"};base64,${frame.imageBase64}` },
            });
          }
          const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
              "HTTP-Referer": "https://localhost",
              "X-Title": "AutoSocial Studio",
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content },
              ],
              temperature: 0.4,
              max_tokens: 8192,
              response_format: { type: "json_object" },
            }),
          });
          clearTimeout(timer);
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const message = data.error?.message || `OpenRouter respondió ${response.status}`;
            if (/api key|no auth|unauthor/i.test(message)) break;
            if (attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; }
            throw new Error(message);
          }
          const text = data.choices?.[0]?.message?.content || "";
          if (!text.trim()) { if (attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; } break; }
          return { analysis: parseJsonResponse(text), usage: data.usage || null, model };
        } catch (error) {
          clearTimeout(timer);
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; }
        }
      }
    }
  }
  throw new Error("OpenRouter no pudo completar el analisis (cuota o modelos no disponibles).");
}

/**
 * Analyze a collected competitor profile.
 * @param {object} report  Output of tiktok-collector.collect()
 * @param {object} options { apiKey, model, brand, language, frames }
 *   frames: [{ videoId, imageBase64, mimeType }]
 */
async function analyze(report, { apiKey, paidApiKey = "", paidModel = DEFAULT_MODEL, openRouterKey = "", model = DEFAULT_MODEL, brand = "", language = "es", frames = [] } = {}) {
  if (!apiKey && !paidApiKey && !openRouterKey) throw new Error("Falta la API key de IA. Añádela en la sección Competencia.");
  const parts = [{ text: buildUserPrompt(report, { brand, language }).replace(/\nDatos reales:/, "\nFotogramas adjuntos de los vídeos más vistos: " + frames.length + "\nDatos reales:") }];

  // Attach up to 12 frames (4 per top video) as inline images.
  for (const frame of frames.slice(0, 12)) {
    parts.push({ text: `Fotograma del vídeo ${frame.videoId}:` });
    parts.push({ inline_data: { mime_type: frame.mimeType || "image/jpeg", data: frame.imageBase64 } });
  }

  // 1) Free key (gemini-2.5-flash) first.
  if (apiKey) {
    try {
      const { text, usage } = await callGemini(apiKey, "gemini-2.5-flash", parts);
      return { analysis: parseJsonResponse(text), usage, model: "gemini-2.5-flash" };
    } catch (error) {
      // Only a quota/auth problem should push us to the paid key; a bad model
      // name is retried once with the configured default.
      if (!isQuotaError(error) && !/API key|no es valida|permission|403/i.test(error.message)) {
        try {
          const { text, usage } = await callGemini(apiKey, model, parts);
          return { analysis: parseJsonResponse(text), usage, model };
        } catch (inner) {
          if (!isQuotaError(inner)) throw inner;
        }
      }
    }
  }

  // 2) Free quota gone: paid key (gemini-3.6-flash).
  if (paidApiKey) {
    const paidModels = [paidModel, "gemini-3.6-flash"].filter((m, i, a) => m && a.indexOf(m) === i);
    for (const candidate of paidModels) {
      try {
        const { text, usage } = await callGemini(paidApiKey, candidate, parts);
        return { analysis: parseJsonResponse(text), usage, model: candidate };
      } catch (error) {
        if (/API key|no es valida|permission|403/i.test(error.message)) break;
      }
    }
  }

  // 3) Last resort: OpenRouter's free vision models.
  if (openRouterKey) {
    return await analyzeWithOpenRouter(openRouterKey, report, { brand, language, frames });
  }
  throw new Error("No se pudo completar el analisis con las API keys disponibles.");
}

module.exports = { analyze, listModels, SYSTEM_PROMPT, DEFAULT_MODEL, OPENROUTER_VISION_MODELS, isQuotaError, FREE_VISION_MODEL: "gemini-2.5-flash" };
