// X Autopilot engine -- patched by instalar-x-autopilot-fix.js
// MARKER: XAP-ENGINE-v2
// MARKER: XAP-ENGINE-v3
const fs = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const { DateTime } = require("luxon");
const { config } = require("./config");
const { getAllAccounts } = require("./account-manager");

const STATE_FILE = path.resolve(config.projectRoot, "x-autopilot-state.json");
const TIMEZONE = config.timezone || "Europe/Madrid";
const REQUEST_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;
const DEFAULT_CONFIG = {
  enabled: false,
  postsPerDay: 3,
  postingMode: "simulation",
  accountTier: "free",
  contentMode: "ai",
  searchTopic: "",
  referenceHandle: "",
  dailyTimes: ["09:00", "14:00", "19:00"],
  masterPrompt: "Escribe contenido original, claro y util para mi audiencia. No inventes datos. Nunca incluyas @usuarios, enlaces, correos, hashtags ni nombres de cuentas o marcas reales.",
  language: "en",
  ai: {
    // "auto" = use the global chain configured in Configuracion de IA.
    model: "auto",
    useGlobalChain: true,
  },
  x: { username: "", accessToken: "", bearerToken: "" },
};

let state = { accounts: {} };
let loaded = false;
let worker = null;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function today() { return DateTime.now().setZone(TIMEZONE).toISODate(); }

function accountState(id) {
  if (!state.accounts[id]) state.accounts[id] = { config: clone(DEFAULT_CONFIG), references: [], queue: [], logs: [] };
  const item = state.accounts[id];
  item.config = cleanConfig(item.config || {});
  item.references = Array.isArray(item.references) ? item.references : [];
  item.queue = Array.isArray(item.queue) ? item.queue : [];
  item.logs = Array.isArray(item.logs) ? item.logs : [];
  return item;
}

async function save() {
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

async function load() {
  if (loaded) return;
  try { state = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { await save(); }
  loaded = true;
  // Migracion unica de idioma: la version anterior generaba siempre en espanol
  // (hardcoded). Los perfiles guardados sin campo "language" pasan a ingles UNA
  // vez. Si luego eliges espanol a proposito, se respeta.
  let migrated = false;
  for (const key of Object.keys((state && state.accounts) || {})) {
    const acc = state.accounts[key];
    if (!acc || typeof acc !== "object") continue;
    if (!acc.languageMigrated) {
      acc.languageMigrated = true;
      if (!acc.config || typeof acc.config !== "object") acc.config = {};
      if (acc.config.language !== "es" && acc.config.language !== "en") {
        acc.config.language = "en";
        migrated = true;
      }
    }
  }
  if (migrated) { try { await save(); } catch {} }
}

function log(item, message, level = "info") {
  item.logs = [{ at: new Date().toISOString(), message, level }, ...(item.logs || [])].slice(0, 80);
}

function cleanConfig(input = {}) {
  const current = clone(DEFAULT_CONFIG);
  Object.assign(current, input);
  current.ai = { ...DEFAULT_CONFIG.ai, ...(input.ai || {}) };
  current.x = { ...DEFAULT_CONFIG.x, ...(input.x || {}) };
  current.postsPerDay = Math.max(1, Math.min(20, Number(current.postsPerDay) || 3));
  current.accountTier = current.accountTier === "premium" ? "premium" : "free";
  current.language = String(current.language || "en").toLowerCase() === "es" ? "es" : "en";
  current.contentMode = current.contentMode === "recent-search" ? "recent-search" : "ai";
  current.postingMode = current.postingMode === "live" ? "live" : "simulation";
  current.searchTopic = String(current.searchTopic || "").trim().slice(0, 200);
  current.dailyTimes = Array.isArray(current.dailyTimes) ? current.dailyTimes.slice(0, 20) : DEFAULT_CONFIG.dailyTimes;
  current.dailyTimes = current.dailyTimes
    .map((value) => String(value || "").trim())
    .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  if (!current.dailyTimes.length) current.dailyTimes = clone(DEFAULT_CONFIG.dailyTimes);
  return current;
}

function maxCharacters(item) { return item.config.accountTier === "premium" ? 4000 : 280; }

function publicItem(item) {
  const result = clone(item);
  if (result.config?.x) {
    result.config.x.accessToken = result.config.x.accessToken ? "configured" : "";
    result.config.x.bearerToken = result.config.x.bearerToken ? "configured" : "";
  }
  return result;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
  const guard = withTimeout(ms);
  try {
    return await fetch(url, { ...options, signal: guard.signal });
  } finally {
    guard.done();
  }
}

async function withRetry(label, fn, attempts = MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = !/^IA respondio 4\d\d/.test(String(error.message));
      if (!retryable || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${label}: ${lastError?.message || "error desconocido"}`);
}

async function searchRecent(item) {
  const token = item.config.x.bearerToken;
  const topic = item.config.searchTopic;
  if (!token || !topic) return [];
  const query = encodeURIComponent(`${topic} -is:retweet lang:es`);
  const response = await fetchWithTimeout(
    `https://api.x.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=created_at,public_metrics,author_id`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`X search respondio ${response.status}`);
  return (await response.json()).data || [];
}

async function referenceDna(item) {
  const handle = String(item.config.referenceHandle || "").trim().replace(/^@/, "");
  if (!handle) return { handle: "", summary: "" };
  try {
    const analyzer = require("./account-analyzer");
    const data = await analyzer.get(handle);
    if (!data || !data.analysis) return { handle, summary: "" };
    const a = data.analysis;
    const f = a.format || {};
    const topics = (a.topics || []).slice(0, 5).map((t) => t.topic).join(", ");
    const words = (a.keywords || []).slice(0, 15).map((k) => k.word).join(", ");
    // Nunca se pasa la identidad de la cuenta ni enlaces al prompt: solo estilo.
    const lines = [
      "Perfil de estilo de referencia (anonimo):",
      `Temas: ${topics || "no detectados"}`,
      `Longitud media: ${f.avgLength || 0} caracteres (nunca pasar de ${280})`,
      `Emojis: ${(f.emojiRatio || 0) < 0.15 ? "con moderacion" : "de forma natural"}`,
      `Salto de linea en ${Math.round(((f.multiline || 0) / Math.max(f.total || 1, 1)) * 100)}% de sus posts`,
      `Sentimiento predominante: ${a.sentiment?.label || "neutral"}`,
      words ? `Vocabulario caracteristico: ${words}` : "",
      "Escribe TU un post nuevo y original con ese tono. No copies ni parafrasees.",
      "PROHIBIDO en el resultado: @usuarios, enlaces/URLs, correos y hashtags.",
      "No menciones a ninguna cuenta, marca ni persona real.",
    ].filter(Boolean);
    return { handle, summary: lines.join("\n") };
  } catch {
    return { handle, summary: "" };
  }
}

// Red de seguridad: borra del texto final cualquier rastro que jamas debe
// publicarse (arrobas, enlaces, correos, hashtags y marcadores de muestra).
function sanitizeOutput(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "")
    .replace(/(^|\s)@[A-Za-z0-9_]{1,15}\b/g, "$1")
    .replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, "$1$2")
    .replace(/\[(usuario|enlace|correo)\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function itemLanguage(item) {
  return String((item && item.config && item.config.language) || "en").toLowerCase() === "es" ? "es" : "en";
}

function buildPrompt(item, account, sourceText, limit) {
  const lang = itemLanguage(item);
  const references = item.references
    .map((ref) => sanitizeOutput(`${ref.text || ""}`))
    .filter(Boolean)
    .join("\n");
  const source = sourceText
    ? (lang === "en"
      ? `Recent post to reinterpret (do not copy):\n${sanitizeOutput(sourceText)}`
      : `Post reciente para reinterpretar (no copiar):\n${sanitizeOutput(sourceText)}`)
    : (lang === "en" ? "No recent reference post" : "Sin post de referencia reciente");
  const body = lang === "en"
    ? `Generate one original post for X with a maximum of ${limit} characters. Write it entirely in English. Return only the text, no quotes or comments.\nForbidden: @users, links/URLs, emails, hashtags and real account or brand names.`
    : `Genera un post original para X de maximo ${limit} caracteres. Escribelo entero en espanol. Devuelve solo el texto, sin comillas ni comentarios.\nProhibido: @usuarios, enlaces/URLs, correos, hashtags y nombres de cuentas o marcas reales.`;
  const refLabel = lang === "en" ? "References to learn the tone from, do not copy:" : "Referencias para aprender tono, no copiar:";
  const noRef = lang === "en" ? "No references" : "Sin referencias";
  return `${item.config.masterPrompt}\n${body}\n${source}\n${refLabel}\n${references || noRef}`;
}

async function generateText(item, account, sourceText = "") {
  const limit = maxCharacters(item);
  const lang = itemLanguage(item);
  let prompt = buildPrompt(item, account, sourceText, limit);
  const dna = await referenceDna(item);
  if (dna.summary) prompt = `${dna.summary}\n\n${prompt}`;
  const aiConfig = require("./ai-config");
  // A specific model can still be forced from the UI; "auto" uses the global chain.
  const forced = item.config.ai.model && item.config.ai.model !== "auto" ? item.config.ai.model : null;
  try {
    const result = await aiConfig.generate(prompt, {
      system: lang === "en"
        ? "Always write in English. Do not invent facts. Return only the post text."
        : "Escribe siempre en espanol de Espana. No inventes datos. Devuelve solo el texto del post.",
      onFallback: (from, error) => {
        log(item, `IA ${from.provider}/${from.model} fallo (${error.message}); probando el siguiente`, "error");
      },
    });
    if (forced && result.model !== forced) {
      log(item, `Se pidio ${forced} pero respondio ${result.model}`, "info");
    }
    const clean = sanitizeOutput(String(result.text || "").trim().replace(/^["']|["']$/g, "").trim());
    if (!clean) throw new Error("respuesta vacia");
    if (/(^|\s)@[A-Za-z0-9_]{1,15}\b|https?:\/\/|\bwww\./i.test(clean)) {
      throw new Error("La IA genero un usuario o enlace; se descarta el texto por seguridad.");
    }
    if (clean.length > limit) {
      throw new Error(`El texto de la IA supera ${limit} caracteres (${clean.length}).`);
    }
    item.lastProvider = `${result.provider}/${result.model}`;
    return clean;
  } catch (error) {
    throw new Error(error.message);
  }
}

async function publish(item, post) {
  if (item.config.postingMode === "simulation") {
    post.status = "simulated";
    post.publishedAt = new Date().toISOString();
    return { ok: true, simulated: true, id: `simulation-${Date.now()}`, reason: "Posting mode is simulation" };
  }

  const xAuth = require("./x-auth");
  const authMode = item.config.x.authMode === "cookies" ? "cookies" : "browser";
  if (authMode === "cookies" && !item.config.x.username) {
    log(item, "Modo cookies: no hace falta usuario, se usan las cookies guardadas", "info");
  }
  const result = await withRetry("Publicacion en X", () => xAuth.postTweet(post.text), 2);
  post.status = "published";
  post.publishedAt = new Date().toISOString();
  post.remoteId = `browser-${Date.now()}`;
  return { ok: true, simulated: false, id: post.remoteId, method: result ? "browser" : "browser" };
}

function scheduleTime(item, index, reference) {
  const times = item.config.dailyTimes.length ? item.config.dailyTimes : ["09:00"];
  const [hours, minutes] = String(times[index % times.length]).split(":").map(Number);
  let when = reference.set({ hour: hours || 9, minute: minutes || 0, second: 0, millisecond: 0 });
  if (when <= reference) when = when.plus({ days: 1 });
  return when.toUTC().toISO();
}

async function generate(accountId, count) {
  await load();
  const item = accountState(accountId);
  const accounts = await getAllAccounts();
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error("Cuenta no encontrada");

  const requested = Math.max(1, Math.min(20, Number(count) || item.config.postsPerDay));
  const now = DateTime.now().setZone(TIMEZONE);

  // Idempotencia: no duplicar el lote programado del dia si ya hay posts futuros.
  const pending = item.queue.filter((post) => post.status === "scheduled" && new Date(post.scheduledFor) > new Date());
  const missing = Math.max(0, requested - pending.length);
  if (missing === 0) {
    log(item, `Ya hay ${pending.length} posts programados; no se generan duplicados`);
    await save();
    return publicItem(item);
  }

  const recent = item.config.contentMode === "recent-search" ? await searchRecent(item) : [];
  for (let index = 0; index < missing; index += 1) {
    const sourceText = recent[index % Math.max(recent.length, 1)]?.text || "";
    const text = await generateText(item, account, sourceText);
    const scheduledFor = scheduleTime(item, pending.length + index, now);
    if (text.length > maxCharacters(item)) {
      throw new Error(`El texto generado supera ${maxCharacters(item)} caracteres.`);
    }
    item.queue.push({
      id: `x-${Date.now()}-${index}`,
      text,
      scheduledFor,
      status: "scheduled",
      attempts: 0,
      createdAt: new Date().toISOString(),
      source: sourceText ? "recent-search" : "ai",
    });
  }
  log(item, `Generados ${missing} posts para ${account.name}`);
  await save();
  return publicItem(item);
}

async function tick() {
  await load();
  const accounts = await getAllAccounts();
  for (const account of accounts) {
    const item = accountState(account.id);
    if (item.config.enabled && item.lastGeneratedDate !== today()) {
      try {
        await generate(account.id);
        item.lastGeneratedDate = today();
      } catch (error) {
        log(item, `Generacion diaria fallo: ${error.message}`, "error");
      }
      await save();
    }
    const due = item.queue.filter(
      (entry) => entry.status === "scheduled" && new Date(entry.scheduledFor) <= new Date()
    );
    if (!due.length) continue;
    // Reconciliacion: expira pendientes demasiado antiguos para no publicar en cadena.
    for (const stale of item.queue.filter(
      (entry) => entry.status === "scheduled" && DateTime.fromISO(entry.scheduledFor).diffNow("days").days < -3
    )) {
      stale.status = "expired";
      log(item, `Post expirado sin publicar (${stale.id})`, "error");
    }
    for (const post of due) {
      if (post.status !== "scheduled") continue;
      post.attempts = (post.attempts || 0) + 1;
      try {
        await publish(item, post);
        log(item, `${post.status === "simulated" ? "Simulado" : "Publicado"}: ${post.text.slice(0, 60)}`);
      } catch (error) {
        post.status = post.attempts >= 3 ? "failed" : "scheduled";
        post.error = error.message;
        post.retryAt = new Date(Date.now() + post.attempts * 5 * 60 * 1000).toISOString();
        log(item, `Fallo al publicar (intento ${post.attempts}): ${error.message}`, "error");
      }
      await save();
    }
  }
}

function startWorker() {
  if (!worker) {
    worker = cron.schedule("* * * * *", () => tick().catch((error) => console.error("[x-autopilot]", error)));
    // Diagnostico: deja claro que claves ve el motor al arrancar.
    try {
      const aiConfig = require("./ai-config");
      aiConfig.reload().then(() => {
        const pub = aiConfig.publicConfig();
        const saved = Object.entries(pub.providerKeys || {}).filter(([, v]) => v && v.configured).map(([k]) => k);
        console.log(`[x-autopilot] config de IA: ${aiConfig.SETTINGS_FILE}`);
        console.log(`[x-autopilot] claves detectadas: ${saved.length ? saved.join(", ") : "ninguna"}`);
        console.log(`[x-autopilot] cadena de modelos: ${pub.chain.length ? pub.chain.map((c) => c.provider + "/" + c.model).join(" -> ") : "vacia"}${pub.enabled === false ? " (cadena desactivada en Configuracion IA)" : ""}`);
      }).catch(() => {});
    } catch {}
  }
  return worker;
}

async function get(accountId) { await load(); return publicItem(accountState(accountId)); }
async function getStatus(accountId) {
  const item = await get(accountId);
  let session = { saved: false, open: false };
  try { session = await require("./x-auth").getSessionStatus(); } catch {}
  let ai = { chain: [], enabled: false };
  try {
    const aiConfig = require("./ai-config");
    await aiConfig.reload();
    const pub = aiConfig.publicConfig();
    ai = { chain: pub.chain, enabled: pub.enabled !== false && pub.chain.length > 0, keys: Object.entries(pub.providerKeys || {}).filter(([, v]) => v && v.configured).map(([k]) => k) };
  } catch {}
  return { ...item, worker: Boolean(worker), timezone: TIMEZONE, session, ai };
}

async function configure(accountId, input) {
  await load();
  const item = accountState(accountId);
  item.config = cleanConfig({
    ...item.config,
    ...input,
    ai: { ...item.config.ai, ...(input.ai || {}) },
    x: { ...item.config.x, ...(input.x || {}) },
  });
  await save();
  return publicItem(item);
}

async function addReference(accountId, input) {
  await load();
  const item = accountState(accountId);
  const username = String(input.username || "").replace(/^@/, "").trim();
  const text = String(input.text || "").trim();
  if (!username || !text) throw new Error("Usuario y texto son obligatorios");
  item.references.unshift({
    id: `ref-${Date.now()}`,
    username,
    text: text.slice(0, 1000),
    url: String(input.url || ""),
  });
  item.references = item.references.slice(0, 100);
  await save();
  return publicItem(item);
}

async function clearQueue(accountId) {
  await load();
  const item = accountState(accountId);
  const removed = item.queue.filter((post) => post.status === "scheduled").length;
  item.queue = item.queue.filter((post) => post.status !== "scheduled");
  log(item, `Eliminados ${removed} posts pendientes de X`);
  await save();
  return publicItem(item);
}

async function retryFailed(accountId) {
  await load();
  const item = accountState(accountId);
  let count = 0;
  for (const post of item.queue) {
    if (post.status === "failed") {
      post.status = "scheduled";
      post.attempts = 0;
      post.scheduledFor = new Date().toISOString();
      count += 1;
    }
  }
  log(item, `Reprogramados ${count} posts fallidos`);
  await save();
  return publicItem(item);
}

module.exports = {
  load, startWorker, tick, get, getStatus, configure, addReference,
  clearQueue, generate, retryFailed, sanitizeOutput, referenceDna,
};
