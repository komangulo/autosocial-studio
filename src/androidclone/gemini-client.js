/**
 * Minimal Gemini client for AndroidClone.
 * Supports text-only and multimodal (inline images) JSON responses.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

async function listModels(apiKey) {
  const res = await fetch(`${BASE}/models?key=${encodeURIComponent(apiKey)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini respondió ${res.status}`);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

/**
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {string} params.system   System instruction
 * @param {Array<{text?:string, image?:{base64:string,mimeType:string}}>} params.parts
 * @param {boolean} [params.json]  Force JSON output
 */
async function generate({ apiKey, model, system, parts, json = true, temperature = 0.3, maxOutputTokens = 8192 }) {
  if (!apiKey) throw new Error("Falta la API key de Gemini. Añádela en la pestaña AndroidClone.");

  const contents = parts.map((part) => {
    if (part.image) {
      return { inline_data: { mime_type: part.image.mimeType || "image/jpeg", data: part.image.base64 } };
    }
    return { text: String(part.text || "") };
  });

  const body = {
    contents: [{ role: "user", parts: contents }],
    generationConfig: { temperature, maxOutputTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || `Gemini respondió ${res.status}`;
    if (/API key/i.test(message)) throw new Error("La API key de Gemini no es válida.");
    if (res.status === 429) throw new Error("Se agotó la cuota de Gemini. Inténtalo más tarde.");
    if (/no longer available|not found|not supported/i.test(message)) {
      throw new Error(`El modelo "${model}" no está disponible. Prueba a cambiar de modelo.`);
    }
    throw new Error(message);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return { text, usage: data.usageMetadata || null };
}

function parseJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("La IA no devolvió JSON válido.");
  return JSON.parse(candidate.slice(start, end + 1));
}

module.exports = { generate, listModels, parseJson };
