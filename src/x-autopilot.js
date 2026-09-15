const fs = require("fs/promises");
const path = require("path");
const cron = require("node-cron");
const { config } = require("./config");
const { getAllAccounts } = require("./account-manager");

const STATE_FILE = path.resolve(config.projectRoot, "x-autopilot-state.json");
const DEFAULT_CONFIG = {
  enabled: false,
  postsPerDay: 3,
  postingMode: "simulation",
  accountTier: "free",
  contentMode: "ai",
  searchTopic: "",
  dailyTimes: ["09:00", "14:00", "19:00"],
  masterPrompt: "Escribe contenido original, claro y util para mi audiencia. No inventes datos.",
  ai: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
  x: { username: "", accessToken: "", bearerToken: "" },
};

let state = { accounts: {} };
let loaded = false;
let worker = null;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function today() { return new Date().toISOString().slice(0, 10); }
function accountState(id) {
  if (!state.accounts[id]) state.accounts[id] = { config: clone(DEFAULT_CONFIG), references: [], queue: [], logs: [] };
  const item = state.accounts[id];
  item.config = cleanConfig(item.config || {});
  item.references = Array.isArray(item.references) ? item.references : [];
  item.queue = Array.isArray(item.queue) ? item.queue : [];
  item.logs = Array.isArray(item.logs) ? item.logs : [];
  return item;
}
async function save() { await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8"); }
async function load() {
  if (loaded) return;
  try { state = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { await save(); }
  loaded = true;
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
  current.contentMode = current.contentMode === "recent-search" ? "recent-search" : "ai";
  current.searchTopic = String(current.searchTopic || "").trim().slice(0, 200);
  current.dailyTimes = Array.isArray(current.dailyTimes) ? current.dailyTimes.slice(0, 20) : DEFAULT_CONFIG.dailyTimes;
  return current;
}
function maxCharacters(item) { return item.config.accountTier === "premium" ? 4000 : 280; }
function publicItem(item) {
  const result = clone(item);
  if (result.config?.ai) result.config.ai.apiKey = result.config.ai.apiKey ? "configured" : "";
  if (result.config?.x) {
    result.config.x.accessToken = result.config.x.accessToken ? "configured" : "";
    result.config.x.bearerToken = result.config.x.bearerToken ? "configured" : "";
  }
  return result;
}

async function searchRecent(item) {
  const token = item.config.x.bearerToken;
  const topic = item.config.searchTopic;
  if (!token || !topic) return [];
  const query = encodeURIComponent(`${topic} -is:retweet lang:es`);
  const response = await fetch(`https://api.x.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=created_at,public_metrics,author_id`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`X search responded ${response.status}: ${await response.text()}`);
  return (await response.json()).data || [];
}

async function generateText(item, account, sourceText = "") {
  const references = item.references.map((ref) => `@${ref.username}: ${ref.text}`).join("\n");
  const limit = maxCharacters(item);
  const source = sourceText ? `Post reciente para reinterpretar (no copiar):\n${sourceText}` : "Sin post de referencia reciente";
  const prompt = `${item.config.masterPrompt}\nCuenta: ${account.name}\nGenera un post original para X de maximo ${limit} caracteres. Devuelve solo el texto.\n${source}\nReferencias para aprender tono, no copiar:\n${references || "Sin referencias"}`;
  const ai = item.config.ai;
  if (!ai.apiKey) {
    const fallback = sourceText ? `Idea propia sobre ${item.config.searchTopic}: ${sourceText}` : `Idea de ${account.name}: comparte una observacion practica y original sobre tu tema. #contenido`;
    return fallback.slice(0, limit);
  }
  let endpoint = `${String(ai.baseUrl).replace(/\/$/, "")}/chat/completions`;
  let headers = { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` };
  let body = { model: ai.model, temperature: 0.8, messages: [{ role: "user", content: prompt }] };
  if (ai.provider === "gemini") {
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model || "gemini-3.6-flash")}:generateContent?key=${encodeURIComponent(ai.apiKey)}`;
    headers = { "content-type": "application/json" };
    body = { contents: [{ parts: [{ text: prompt }] }] };
  } else if (ai.provider === "deepseek") {
    endpoint = "https://api.deepseek.com/chat/completions";
  }
  const response = await fetch(endpoint, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`IA respondio ${response.status}`);
  const data = await response.json();
  const text = ai.provider === "gemini" ? data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") : data.choices?.[0]?.message?.content;
  return String(text || "").trim().slice(0, limit);
}

async function publish(item, post) {
  if (item.config.postingMode === "simulation") {
    post.status = "simulated";
    post.publishedAt = new Date().toISOString();
    return { ok: true, simulated: true, id: `simulation-${Date.now()}`, reason: "Posting mode is simulation" };
  }
  if (!item.config.x.accessToken) throw new Error("Live mode requires an X User Access Token with Write permission.");
  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${item.config.x.accessToken}` },
    body: JSON.stringify({ text: post.text.slice(0, maxCharacters(item)) }),
  });
  if (!response.ok) throw new Error(`X respondio ${response.status}: ${await response.text()}`);
  const data = await response.json();
  post.status = "published"; post.publishedAt = new Date().toISOString(); post.remoteId = data.data?.id;
  return { ok: true, simulated: false, id: post.remoteId };
}

async function generate(accountId, count) {
  await load();
  const item = accountState(accountId);
  const accounts = await getAllAccounts();
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error("Cuenta no encontrada");
  const total = Math.max(1, Math.min(20, Number(count) || item.config.postsPerDay));
  const times = item.config.dailyTimes.length ? item.config.dailyTimes : ["09:00"];
  const recent = item.config.contentMode === "recent-search" ? await searchRecent(item) : [];
  for (let index = 0; index < total; index += 1) {
    const [hours, minutes] = String(times[index % times.length]).split(":").map(Number);
    const scheduled = new Date(); scheduled.setHours(hours || 9, minutes || 0, 0, 0);
    if (scheduled <= new Date()) scheduled.setDate(scheduled.getDate() + 1);
    const sourceText = recent[index % Math.max(recent.length, 1)]?.text || "";
    const text = await generateText(item, account, sourceText);
    item.queue.push({ id: `x-${Date.now()}-${index}`, text, scheduledFor: scheduled.toISOString(), status: "scheduled", createdAt: new Date().toISOString(), source: sourceText ? "recent-search" : "ai" });
  }
  log(item, `Generados ${total} posts para ${account.name}`); await save();
  return publicItem(item);
}
async function tick() {
  await load();
  const accounts = await getAllAccounts();
  for (const account of accounts) {
    const item = accountState(account.id);
    if (item.config.enabled && item.lastGeneratedDate !== today()) {
      try { await generate(account.id); item.lastGeneratedDate = today(); } catch (error) { log(item, error.message, "error"); await save(); }
    }
    for (const post of item.queue.filter((entry) => entry.status === "scheduled" && new Date(entry.scheduledFor) <= new Date())) {
      try { await publish(item, post); log(item, `${post.status === "simulated" ? "Simulado" : "Publicado"}: ${post.text.slice(0, 60)}`); } catch (error) { post.status = "failed"; post.error = error.message; log(item, error.message, "error"); }
      await save();
    }
  }
}
function startWorker() { if (!worker) worker = cron.schedule("* * * * *", () => tick().catch(console.error)); return worker; }
async function get(accountId) { await load(); return publicItem(accountState(accountId)); }
async function configure(accountId, input) { await load(); const item = accountState(accountId); item.config = cleanConfig({ ...item.config, ...input, ai: { ...item.config.ai, ...(input.ai || {}) }, x: { ...item.config.x, ...(input.x || {}) } }); await save(); return publicItem(item); }
async function addReference(accountId, input) { await load(); const item = accountState(accountId); const username = String(input.username || "").replace(/^@/, "").trim(); const text = String(input.text || "").trim(); if (!username || !text) throw new Error("Usuario y texto son obligatorios"); item.references.unshift({ id: `ref-${Date.now()}`, username, text: text.slice(0, 1000), url: String(input.url || "") }); item.references = item.references.slice(0, 100); await save(); return publicItem(item); }
async function clearQueue(accountId) { await load(); const item = accountState(accountId); const removed = item.queue.filter((post) => post.status === "scheduled").length; item.queue = item.queue.filter((post) => post.status !== "scheduled"); log(item, `Cleared ${removed} pending X posts`); await save(); return publicItem(item); }
async function getStatus(accountId) { const item = await get(accountId); return { ...item, worker: Boolean(worker) }; }
module.exports = { load, startWorker, tick, get, getStatus, configure, addReference, clearQueue, generate };
