/**
 * Free-first generation client.
 *
 * Browser-runtime providers (Puter.js, Google Flow) cannot be called from Node:
 * the controller returns a "client" instruction and the frontend executes it
 * with puter.js / browser automation.
 *
 * Server-runtime providers (Pollinations, Google AI Studio, Hugging Face) are
 * called directly over HTTP here.
 */

const POLLINATIONS_IMAGE = "https://image.pollinations.ai/prompt";

function ratioToSize(ratio, base = 1024) {
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  if (!w || !h) return { width: base, height: base };
  if (w >= h) return { width: base, height: Math.round((base * h) / w) };
  return { width: Math.round((base * w) / h), height: base };
}

/* ----------------------------- Pollinations ----------------------------- */

async function pollinationsImage({ prompt, model = "flux", ratio, seed, nologo = true }) {
  const { width, height } = ratioToSize(ratio);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    nologo: String(nologo),
  });
  if (seed !== undefined && seed !== null && seed !== "") params.set("seed", String(seed));
  const url = `${POLLINATIONS_IMAGE}/${encodeURIComponent(prompt)}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pollinations responded ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/jpeg";
  return { buffer, mime, url };
}

/* --------------------------- Google AI Studio ---------------------------- */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function googleImage({ apiKey, prompt, model, ratio, references = [] }) {
  if (!apiKey) throw new Error("Google AI Studio needs a Gemini API key (free at aistudio.google.com/apikey).");

  if (model.startsWith("imagen")) {
    const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: ratioToGeminiAspect(ratio) },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Google responded ${res.status}`);
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error("Google returned no image.");
    return { buffer: Buffer.from(b64, "base64"), mime: "image/png" };
  }

  const parts = [{ text: prompt }];
  for (const ref of references) {
    if (ref.base64 && ref.mimeType) parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
  }
  const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Google responded ${res.status}`);
  const candidate = data.candidates?.[0]?.content?.parts || [];
  const imagePart = candidate.find((part) => part.inlineData?.data);
  if (!imagePart) throw new Error("Google returned no image (prompt may have been blocked).");
  return { buffer: Buffer.from(imagePart.inlineData.data, "base64"), mime: imagePart.inlineData.mimeType || "image/png" };
}

function ratioToGeminiAspect(ratio) {
  const map = { "1:1": "1:1", "16:9": "16:9", "9:16": "9:16", "4:3": "4:3", "3:4": "3:4" };
  return map[String(ratio)] || "1:1";
}

/* ----------------------------- Hugging Face ------------------------------ */

const HF_BASE = "https://api-inference.huggingface.co/models";

async function huggingfaceImage({ apiKey, prompt, model }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${HF_BASE}/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: prompt }),
  });
  if (!res.ok) {
    if (res.status === 503) throw new Error("Hugging Face model is warming up. Try again in ~30s.");
    if (res.status === 401) throw new Error("Hugging Face needs a token for this model.");
    throw new Error(`Hugging Face responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: res.headers.get("content-type") || "image/png" };
}

async function huggingfaceVideo({ apiKey, prompt, model }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${HF_BASE}/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: prompt }),
  });
  if (!res.ok) throw new Error(`Hugging Face responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime: res.headers.get("content-type") || "video/mp4" };
}

/* ------------------------------- Router ---------------------------------- */

/**
 * Generate on the server for the providers Node can reach.
 * Returns { buffer, mime } on success, or { client: "..." } when the browser
 * must run the call (Puter.js, Google Flow).
 */
async function generateOnServer({ provider, providerModel, kind, prompt, ratio, references = [], apiKey }) {
  if (provider === "pollinations") {
    if (kind !== "image") throw new Error("Pollinations only supports images here.");
    return { ...(await pollinationsImage({ prompt, model: providerModel, ratio })) };
  }
  if (provider === "google") {
    if (kind !== "image") throw new Error("Google AI Studio path here only supports images (use Puter for Veo).");
    return { ...(await googleImage({ apiKey, prompt, model: providerModel, ratio, references })) };
  }
  if (provider === "huggingface") {
    if (kind === "image") return { ...(await huggingfaceImage({ apiKey, prompt, model: providerModel })) };
    return { ...(await huggingfaceVideo({ apiKey, prompt, model: providerModel })) };
  }
  if (provider === "puter") {
    return { client: "puter", call: { method: kind === "image" ? "txt2img" : "txt2vid", prompt, model: providerModel, options: {} } };
  }
  if (provider === "flow") {
    return { client: "flow", call: { prompt, query: { model: providerModel } } };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

module.exports = {
  generateOnServer,
  pollinationsImage,
  googleImage,
  huggingfaceImage,
  huggingfaceVideo,
  ratioToSize,
};
