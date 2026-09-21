// Global AI configuration for AutoSocial Studio.
// MARKER: AICFG-v1
//
// One place to store every provider API key and the automatic fallback chain
// used across the whole dashboard:
//   xKiro (free models first) -> Gemini free -> DeepSeek paid -> Gemini paid -> OpenRouter
//
// Keys live in settings.json next to the project root and never leave the machine
// except towards the provider they belong to.

const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const SETTINGS_FILE = path.resolve(config.projectRoot, "settings.json");
const REQUEST_TIMEOUT_MS = 45000;

// Models the user picked from the xKiro API, all on the free tier, in order.
const XKIRO_FREE_MODELS = [
  { id: "minimax/minimax-m3:free", label: "MiniMax M3 (gratis)", note: "el que mas aguanta" },
  { id: "qwen/qwen3.7-flash:free", label: "Qwen3.7 Flash (gratis)", note: "respaldo solido" },
  { id: "mistralai/ministral-14b", label: "Ministral 3 14B", note: "el mas rapido" },
  { id: "mistralai/mistral-small-2603", label: "Mistral Small 4", note: "vision" },
];

const PROVIDERS = {
  xkiro: {
    label: "xKiro",
    kind: "openai",
    baseUrl: "https://api.xkiro.com/v1",
    keyHint: "sk-xt-... (xkiro.com)",
    docs: "https://xkiro.com",
    free: true,
    models: XKIRO_FREE_MODELS,
  },
  "gemini-free": {
    label: "Gemini gratis",
    kind: "gemini",
    keyHint: "AIza... (aistudio.google.com/app/apikey)",
    docs: "https://aistudio.google.com/app/apikey",
    free: true,
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (gratis)" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (gratis)" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (gratis)" },
    ],
  },
  deepseek: {
    label: "DeepSeek (pago)",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "sk-... (platform.deepseek.com)",
    docs: "https://platform.deepseek.com",
    free: false,
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3" },
      { id: "deepseek-reasoner", label: "DeepSeek R1" },
    ],
  },
  "gemini-paid": {
    label: "Gemini de pago",
    kind: "gemini",
    keyHint: "AIza... (misma clave puede servir)",
    docs: "https://aistudio.google.com/app/apikey",
    free: false,
    models: [
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
  openrouter: {
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-... (openrouter.ai/keys)",
    docs: "https://openrouter.ai/keys",
    free: true,
    models: [
      { id: "openrouter/free", label: "Free Models Router (auto)" },
      { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (gratis)" },
      { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder (gratis)" },
    ],
  },
};

// The order the whole app must respect. Free options first.
const CHAIN_ORDER = ["xkiro", "gemini-free", "deepseek", "gemini-paid", "openrouter"];

const DEFAULTS = {
  providerKeys: {},
  preferredModel: "auto",
  enabled: true,
  lastTest: null,
};

let cache = null;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettings(next) {
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, SETTINGS_FILE);
}

async function load() {
  if (cache) return cache;
  return reload();
}

/**
 * Re-read settings.json from disk, ignoring any cached copy.
 * The worker calls this before generating so keys saved from the UI are
 * always picked up, even in a different order of initialization.
 */
async function reload() {
  const settings = await readSettings();
  cache = {
    ...clone(DEFAULTS),
    providerKeys: { ...(settings.aiProviderKeys || {}) },
    preferredModel: settings.aiPreferredModel || DEFAULTS.preferredModel,
    enabled: settings.aiChainEnabled !== false,
    lastTest: settings.aiLastTest || null,
  };
  return cache;
}

async function save(patch = {}) {
  const current = await load();
  const next = { ...current };

  if (patch.providerKeys && typeof patch.providerKeys === "object") {
    next.providerKeys = { ...current.providerKeys };
    for (const [provider, value] of Object.entries(patch.providerKeys)) {
      if (!PROVIDERS[provider]) continue;
      if (typeof value !== "string") continue;
      if (value.trim()) next.providerKeys[provider] = value.trim();
      else delete next.providerKeys[provider];
    }
  }
  if (Array.isArray(patch.removeProviders)) {
    next.providerKeys = { ...next.providerKeys };
    for (const provider of patch.removeProviders) delete next.providerKeys[provider];
  }
  if (typeof patch.preferredModel === "string" && patch.preferredModel.trim()) {
    next.preferredModel = patch.preferredModel.trim();
  }
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;

  const settings = await readSettings();
  settings.aiProviderKeys = next.providerKeys;
  settings.aiPreferredModel = next.preferredModel;
  settings.aiChainEnabled = next.enabled;
  cache = next;
  await writeSettings(settings);
  return publicConfig();
}

function keyFor(providerId) {
  return cache?.providerKeys?.[providerId] || "";
}

function publicConfig() {
  const current = cache || clone(DEFAULTS);
  const keyStatus = {};
  for (const providerId of CHAIN_ORDER) {
    const key = current.providerKeys[providerId];
    keyStatus[providerId] = key
      ? { configured: true, masked: `${key.slice(0, 7)}${"*".repeat(6)}${key.slice(-4)}` }
      : { configured: false, masked: "" };
  }
  return {
    providerKeys: keyStatus,
    preferredModel: current.preferredModel,
    enabled: current.enabled,
    lastTest: current.lastTest,
    chain: buildChain().map((entry) => ({
      provider: entry.provider,
      label: PROVIDERS[entry.provider].label,
      model: entry.model,
      free: Boolean(PROVIDERS[entry.provider].free),
      configured: entry.configured,
    })),
    providers: CHAIN_ORDER.map((providerId) => ({
      id: providerId,
      ...PROVIDERS[providerId],
      models: PROVIDERS[providerId].models,
    })),
  };
}

/**
 * Build the automatic provider chain, respecting CHAIN_ORDER.
 * Only providers with a saved key are included, so a missing key never blocks.
 */
function buildChain() {
  const current = cache || { providerKeys: {} };
  const chain = [];
  if (current.enabled === false) return chain;
  for (const providerId of CHAIN_ORDER) {
    const provider = PROVIDERS[providerId];
    const key = current.providerKeys[providerId] || "";
    const configured = Boolean(key);
    if (!configured) continue;
    // A single explicit model wins; otherwise every model of the provider is tried.
    const models = current.preferredModel && current.preferredModel !== "auto"
      ? [current.preferredModel].filter((id) => provider.models.some((m) => m.id === id))
      : provider.models.map((m) => m.id);
    const list = models.length ? models : [provider.models[0].id];
    for (const model of list) {
      chain.push({ provider: providerId, model, key, configured, free: Boolean(provider.free) });
    }
  }
  return chain;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function callGemini({ apiKey, model, prompt, system }) {
  const guard = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: guard.signal }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message || `Gemini respondio ${response.status}`;
      throw new Error(message);
    }
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  } finally {
    guard.done();
  }
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, prompt, system, providerId }) {
  const guard = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
    if (baseUrl.includes("openrouter.ai")) {
      headers["HTTP-Referer"] = "https://autosocial.local";
      headers["X-Title"] = "AutoSocial Studio";
    }
    const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 1024 }),
      signal: guard.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message || `El proveedor respondio ${response.status}`;
      throw new Error(message);
    }
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : (content || []).map((c) => c.text || "").join("");
  } finally {
    guard.done();
  }
}

/**
 * Ask a specific provider+model. Returns the raw text.
 */
async function callProvider({ provider, model, key }, prompt, system) {
  const definition = PROVIDERS[provider];
  if (!definition) throw new Error(`Proveedor desconocido: ${provider}`);
  if (definition.kind === "gemini") {
    return callGemini({ apiKey: key, model, prompt, system });
  }
  return callOpenAiCompatible({
    baseUrl: definition.baseUrl,
    apiKey: key,
    model,
    prompt,
    system,
    providerId: provider,
  });
}

/**
 * Generate text following the automatic chain. Returns { text, provider, model, attempts }.
 * `onFallback(from, to, error)` is called whenever a provider fails and the next is tried.
 */
async function generate(prompt, { system = "", onFallback = null, maxAttempts = 12 } = {}) {
  await reload();
  const chain = buildChain();
  if (!chain.length) {
    const keys = cache?.providerKeys || {};
    const anyKey = Object.keys(keys).length > 0;
    if (cache && cache.enabled === false) {
      throw new Error(
        "La cadena automatica esta desactivada. Abre Configuracion de IA y marca «Usar la cadena automatica en toda la app»."
      );
    }
    if (anyKey) {
      throw new Error(
        "Hay claves guardadas pero ninguna es valida para la cadena. Revisa Configuracion de IA."
      );
    }
    throw new Error(
      "No hay ninguna API de IA configurada. Abre Configuracion de IA y guarda al menos una clave (xKiro es gratis)."
    );
  }
  const errors = [];
  for (const entry of chain.slice(0, maxAttempts)) {
    try {
      const text = await callProvider(entry, prompt, system);
      const clean = String(text || "").trim();
      if (!clean) throw new Error("respuesta vacia");
      return { text: clean, provider: entry.provider, model: entry.model, attempts: errors.length + 1 };
    } catch (error) {
      errors.push({ provider: entry.provider, model: entry.model, error: error.message });
      if (onFallback) onFallback(entry, error);
    }
  }
  const summary = errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join(" | ");
  throw new Error(`Todos los proveedores fallaron. ${summary}`);
}

/**
 * Try one provider quickly to confirm the key works.
 */
async function testProvider(providerId) {
  await load();
  const definition = PROVIDERS[providerId];
  if (!definition) throw new Error(`Proveedor desconocido: ${providerId}`);
  const key = keyFor(providerId);
  if (!key) throw new Error(`No hay clave guardada para ${definition.label}.`);
  const model = definition.models[0].id;
  const started = Date.now();
  const text = await callProvider({ provider: providerId, model, key }, "Responde solo con: OK", "");
  return {
    ok: true,
    provider: providerId,
    model,
    ms: Date.now() - started,
    sample: String(text).trim().slice(0, 80),
  };
}

async function rememberTest(result) {
  const current = await load();
  const settings = await readSettings();
  current.lastTest = { ...result, at: new Date().toISOString() };
  settings.aiLastTest = current.lastTest;
  settings.aiProviderKeys = current.providerKeys;
  settings.aiPreferredModel = current.preferredModel;
  settings.aiChainEnabled = current.enabled;
  await writeSettings(settings);
  return publicConfig();
}

/** Best available model id for a provider, respecting the stored preference. */
function defaultModelFor(providerId) {
  const definition = PROVIDERS[providerId];
  if (!definition) return "";
  return definition.models[0]?.id || "";
}

module.exports = {
  PROVIDERS,
  CHAIN_ORDER,
  XKIRO_FREE_MODELS,
  SETTINGS_FILE,
  load,
  reload,
  save,
  publicConfig,
  buildChain,
  generate,
  testProvider,
  rememberTest,
  defaultModelFor,
  keyFor,
};
