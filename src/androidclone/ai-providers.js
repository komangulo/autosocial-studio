/**
 * Multi-provider AI layer for AndroidClone.
 *
 * One interface over: Gemini, DeepSeek, OpenAI, Anthropic, OpenRouter, Groq.
 * Each provider describes its models (curated + free flags) and its request shape.
 * Vision (images) is supported by Gemini, OpenAI, Anthropic, OpenRouter and Groq.
 */

const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    kind: "gemini",
    keyHint: "AIza... (aistudio.google.com/app/apikey)",
    docs: "https://aistudio.google.com/app/apikey",
    free: true,
    supportsVision: true,
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", free: true, vision: true },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", free: true, vision: true },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", free: false, vision: true },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", free: true, vision: true },
    ],
  },
  deepseek: {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "sk-... (platform.deepseek.com)",
    docs: "https://platform.deepseek.com",
    free: true,
    supportsVision: false,
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3 (chat)", free: false, vision: false },
      { id: "deepseek-reasoner", label: "DeepSeek R1 (razonamiento)", free: false, vision: false },
    ],
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-... (platform.openai.com)",
    docs: "https://platform.openai.com/api-keys",
    free: false,
    supportsVision: true,
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", free: false, vision: true },
      { id: "gpt-4o", label: "GPT-4o", free: false, vision: true },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", free: false, vision: true },
      { id: "o4-mini", label: "o4-mini (razonamiento)", free: false, vision: true },
    ],
  },
  anthropic: {
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyHint: "sk-ant-... (console.anthropic.com)",
    docs: "https://console.anthropic.com",
    free: false,
    supportsVision: true,
    models: [
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", free: false, vision: true },
      { id: "claude-sonnet-4-latest", label: "Claude Sonnet 4", free: false, vision: true },
      { id: "claude-opus-4-latest", label: "Claude Opus 4", free: false, vision: true },
    ],
  },
  openrouter: {
    label: "OpenRouter (muchos modelos gratis)",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-... (openrouter.ai/keys)",
    docs: "https://openrouter.ai/keys",
    free: true,
    supportsVision: true,
    models: [
      { id: "openrouter/free", label: "Free Models Router (auto)", free: true, vision: true },
      { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (free)", free: true, vision: false },
      { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek V3 (free)", free: true, vision: false },
      { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder 480B (free)", free: true, vision: false },
      { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free)", free: true, vision: false },
      { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash Exp (free)", free: true, vision: true },
      { id: "mistralai/mistral-small-3.1-24b-instruct:free", label: "Mistral Small 3.1 (free)", free: true, vision: true },
    ],
  },
  groq: {
    label: "Groq (gratis y muy rápido)",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    keyHint: "gsk_... (console.groq.com/keys)",
    docs: "https://console.groq.com/keys",
    free: true,
    supportsVision: true,
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", free: true, vision: false },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", free: true, vision: false },
      { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B", free: true, vision: false },
      { id: "qwen/qwen3-32b", label: "Qwen3 32B", free: true, vision: false },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (visión)", free: true, vision: true },
    ],
  },
};

function catalog() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    kind: p.kind,
    keyHint: p.keyHint,
    docs: p.docs,
    free: p.free,
    supportsVision: p.supportsVision,
    models: p.models,
  }));
}

function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Proveedor desconocido: ${id}. Usa uno de: ${Object.keys(PROVIDERS).join(", ")}.`);
  return provider;
}

function resolveModel(providerId, modelId) {
  const provider = getProvider(providerId);
  const model = provider.models.find((m) => m.id === modelId);
  return model || { id: modelId || provider.models[0].id, vision: provider.supportsVision };
}

async function generate({ providerId, apiKey, model, system, parts, json = true, temperature = 0.3, maxOutputTokens = 8192 }) {
  if (!apiKey) throw new Error(`Falta la API key de ${getProvider(providerId).label}. Añádela en Configuración.`);
  const provider = getProvider(providerId);
  if (provider.kind === "gemini") return callGemini({ apiKey, model, system, parts, json, temperature, maxOutputTokens });
  if (provider.kind === "openai") return callOpenAICompatible({ provider, apiKey, model, system, parts, json, temperature, maxOutputTokens });
  if (provider.kind === "anthropic") return callAnthropic({ apiKey, model, system, parts, json, temperature, maxOutputTokens });
  throw new Error(`Proveedor no soportado: ${providerId}`);
}

// ---------------------------------------------------------------- Gemini
async function callGemini({ apiKey, model, system, parts, json, temperature, maxOutputTokens }) {
  const contents = parts.map((part) =>
    part.image
      ? { inline_data: { mime_type: part.image.mimeType || "image/jpeg", data: part.image.base64 } }
      : { text: String(part.text || "") }
  );
  const body = {
    contents: [{ role: "user", parts: contents }],
    generationConfig: { temperature, maxOutputTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    body
  );
  return { text: (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), usage: data.usageMetadata || null };
}

// ------------------------------------------------------ OpenAI-compatible
async function callOpenAICompatible({ provider, apiKey, model, system, parts, json, temperature, maxOutputTokens }) {
  const content = parts.map((part) =>
    part.image
      ? { type: "image_url", image_url: { url: `data:${part.image.mimeType || "image/jpeg"};base64,${part.image.base64}` } }
      : { type: "text", text: String(part.text || "") }
  );
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content });

  const body = { model, messages, temperature, max_tokens: maxOutputTokens };
  if (json) body.response_format = { type: "json_object" };
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (provider.baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://androidclone.local";
    headers["X-Title"] = "AndroidClone";
  }
  const data = await postJson(`${provider.baseUrl}/chat/completions`, body, headers);
  const text = data.choices?.[0]?.message?.content;
  return { text: typeof text === "string" ? text : (text || []).map((c) => c.text || "").join(""), usage: data.usage || null };
}

// ------------------------------------------------------------- Anthropic
async function callAnthropic({ apiKey, model, system, parts, json, temperature, maxOutputTokens }) {
  const content = parts.map((part) =>
    part.image
      ? { type: "image", source: { type: "base64", media_type: part.image.mimeType || "image/jpeg", data: part.image.base64 } }
      : { type: "text", text: String(part.text || "") }
  );
  const body = {
    model,
    max_tokens: maxOutputTokens,
    temperature,
    messages: [{ role: "user", content }],
  };
  if (system) body.system = json ? `${system}\nDevuelve EXCLUSIVAMENTE JSON válido.` : system;
  const data = await postJson("https://api.anthropic.com/v1/messages", body, {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  const text = (data.content || []).map((c) => c.text || "").join("");
  return { text, usage: data.usage || null };
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || data.error?.type || `El proveedor respondió ${res.status}`;
    if (res.status === 401 || /api key|unauthorized|invalid/i.test(String(message))) {
      throw new Error(`La API key no es válida o no tiene permisos: ${message}`);
    }
    if (res.status === 429) throw new Error(`Se agotó la cuota gratuita o hay demasiadas peticiones: ${message}`);
    throw new Error(String(message));
  }
  return data;
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

/**
 * Ask any provider for the live list of model ids it offers (best effort).
 */
async function listModels({ providerId, apiKey }) {
  const provider = getProvider(providerId);
  try {
    if (provider.kind === "gemini") {
      const data = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`)).json();
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name || "").replace(/^models\//, ""));
    }
    if (provider.kind === "anthropic") {
      const data = await (await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      })).json();
      return (data.data || []).map((m) => m.id).filter(Boolean);
    }
    const data = await (await fetch(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
    return (data.data || []).map((m) => m.id).filter(Boolean);
  } catch {
    return provider.models.map((m) => m.id);
  }
}

module.exports = { PROVIDERS, catalog, getProvider, resolveModel, generate, listModels, parseJson };
