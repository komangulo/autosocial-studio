// Motor de publicacion diaria basada en el ADN de una cuenta analizada.
//
// MARKER: ACCT-PUB-v1
//
// Idea: en "Analisis de cuenta" eliges una cuenta estudiada. Su Manual de ADN
// se usa como molde de ESTILO; los "temas" que escribas son el CONTENIDO. Todos
// los dias, a las horas indicadas, la IA escribe N posts originales sobre esos
// temas imitando ese estilo y se publican en la cuenta de X con sesion activa.
//
// Reglas heredadas del analisis: nunca se mete en el prompt el @ de nadie, ni
// usuarios, ni enlaces, ni correos, ni hashtags. Y la salida se limpia igual.

const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const STATE_FILE = path.resolve(config.projectRoot, ".runtime", "acct-publisher.json");

const DEFAULTS = {
  enabled: false,
  referenceHandle: "",
  postsPerDay: 3,
  topics: [],
  startTime: "09:00",
  spreadMinutes: 240,
  jitterMinutes: 30,
  maxChars: 280,
  language: "en",
  minGapMinutes: 45,
};

let state = { profiles: {} };
let loaded = false;
let worker = null;

function nowIso() { return new Date().toISOString(); }

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function safeHandle(handle) {
  return String(handle || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^\.+/, "").slice(0, 40);
}

function profileState(handle) {
  const key = safeHandle(handle);
  if (!key) throw new Error("Falta el @ de la cuenta de referencia.");
  if (!state.profiles[key]) {
    state.profiles[key] = {
      handle: key,
      config: clone(DEFAULTS),
      lastRunDate: "",
      slotDate: "",
      firedSlots: [],
      history: [],
      errors: [],
      lastProvider: "",
      lastPublishedAt: "",
    };
  }
  if (!Array.isArray(state.profiles[key].history)) state.profiles[key].history = [];
  if (!Array.isArray(state.profiles[key].errors)) state.profiles[key].errors = [];
  if (!Array.isArray(state.profiles[key].firedSlots)) state.profiles[key].firedSlots = [];
  // Config antigua sin idioma: por defecto ingles.
  if (!state.profiles[key].config) state.profiles[key].config = clone(DEFAULTS);
  if (!state.profiles[key].config.language) state.profiles[key].config.language = "en";
  if (state.profiles[key].config.jitterMinutes == null) state.profiles[key].config.jitterMinutes = DEFAULTS.jitterMinutes;
  if (state.profiles[key].config.minGapMinutes == null) state.profiles[key].config.minGapMinutes = DEFAULTS.minGapMinutes;
  if (!state.profiles[key].lastPublishedAt) state.profiles[key].lastPublishedAt = "";
  return state.profiles[key];
}

async function load() {
  if (loaded) return state;
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.profiles) state = parsed;
  } catch {
    state = { profiles: {} };
  }
  loaded = true;
  // Migracion unica: perfiles con el antiguo idioma por defecto (espanol) pasan
  // a ingles UNA sola vez. Si luego eliges espanol a proposito, se respeta.
  let migrated = false;
  for (const key of Object.keys(state.profiles || {})) {
    const p = state.profiles[key];
    if (!p || typeof p !== "object") continue;
    if (!p.languageMigrated) {
      p.languageMigrated = true;
      if (p.config && String(p.config.language || "").toLowerCase() === "es") {
        p.config.language = "en";
        migrated = true;
      }
    }
  }
  if (migrated) { try { await save(); } catch {} }
  return state;
}

async function save() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

// --- Saneado (mismo espiritu que el resto de la app) -----------------------

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

function hasForbidden(text) {
  return /(^|\s)@[A-Za-z0-9_]{1,15}\b|https?:\/\/|\bwww\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b/i.test(String(text || ""));
}

function parseTopics(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,;]+/);
  return list
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 40);
}

// --- Horarios ---------------------------------------------------------------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Horas de publicacion de hoy para N posts, repartidos desde startTime con
 * spreadMinutes entre uno y otro. Si la hora de inicio ya paso, el primer slot
  * es "ahora" (recuperacion) para no perder el lote del dia. Devuelve Date.
  */
function slotTimes(configProfile, count, reference) {
  const [h, m] = String(configProfile.startTime || "09:00").split(":").map(Number);
  const spread = Math.max(5, Number(configProfile.spreadMinutes) || 240);
  const base = new Date(reference);
  base.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  const start = base.getTime() < reference.getTime() ? new Date(reference) : base;
  const times = [];
  for (let i = 0; i < count; i += 1) {
    times.push(new Date(start.getTime() + i * spread * 60 * 1000));
  }
  return times;
}

/**
 * Generador pseudoaleatorio con semilla: mismo dia + cuenta => mismos horarios
 * (asi el tick no recalcula horas distintas cada minuto), pero cada dia cambia.
 */
function seededRandom(seedStr) {
  let h = 2166136261;
  const s = String(seedStr);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Horas FIJAS del dia (no se re-anclan a "ahora") con un desvio aleatorio
 * estable para no publicar siempre a horas en punto:
 *   - el primer post cae en [startTime, startTime + jitter]
 *   - cada siguiente suma spread +/- jitter, acotado a minimo 1 min entre posts.
 * Misma fecha + misma cuenta => mismas horas (estable durante el dia).
 */
function fixedSlotTimes(configProfile, count, reference, seedExtra) {
  const [h, m] = String(configProfile.startTime || "09:00").split(":").map(Number);
  const spread = Math.max(5, Number(configProfile.spreadMinutes) || 240);
  const jitter = Math.max(0, Math.min(120, Number(configProfile.jitterMinutes) || 0));
  const base = new Date(reference);
  base.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  const dayKey = base.getFullYear() + "-" + (base.getMonth() + 1) + "-" + base.getDate();
  const rand = seededRandom(`${seedExtra || ""}|${dayKey}|${configProfile.startTime}|${spread}|${jitter}`);
  const times = [];
  let cursor = base.getTime();
  if (jitter > 0) cursor += Math.floor(rand() * jitter) * 60000;
  times.push(new Date(cursor));
  for (let i = 1; i < count; i += 1) {
    let gap = spread;
    if (jitter > 0) gap += Math.round((rand() * 2 - 1) * jitter);
    gap = Math.max(1, gap);
    cursor += gap * 60000;
    times.push(new Date(cursor));
  }
  return times;
}

// --- Generacion -------------------------------------------------------------

async function buildStyleBlock(handle) {
  const analyzer = require("./account-analyzer");
  const data = await analyzer.get(handle);
  if (!data) {
    throw new Error(`La cuenta @${handle} no esta analizada. Analizala primero en "Analisis de cuenta".`);
  }
  // El manual ya va saneado y sin identidad. Se recorta para no inflar el prompt.
  const manual = String(data.manual || "").slice(0, 6000);
  return manual;
}

function topicForSlot(topics, index, queue) {
  if (!topics.length) return "";
  // Rotacion estable: evita repetir tema hasta agotar la lista.
  return topics[index % topics.length];
}

async function generateOne(profile, topic, attempt) {
  const aiConfig = require("./ai-config");
  const manual = await buildStyleBlock(profile.handle);
  const max = Math.max(80, Math.min(4000, Number(profile.config.maxChars) || 280));
  const lang = String(profile.config.language || "en").toLowerCase() === "es" ? "es" : "en";
  const langInstruction = lang === "en"
    ? `Escribe UN solo post EN INGLES (English), de ${Math.round(max * 0.55)} a ${max} caracteres.`
    : `Escribe UN solo post EN ESPANOL, de ${Math.round(max * 0.55)} a ${max} caracteres.`;

  const prompt = [
    "Eres el autor de una cuenta de X. Vas a escribir UN post original, nuevo, listo para publicar.",
    "",
    "A continuacion tienes el MANUAL DE ESTILO de una cuenta de referencia. Describe COMO escribe (tono, longitud, estructura, ritmo), no QUE dice. No menciones esa cuenta ni copies sus posts.",
    "--- MANUAL DE ESTILO ---",
    manual,
    "--- FIN DEL MANUAL ---",
    "",
    topic ? `Tema del post: ${topic}` : "Tema: elige uno coherente con el estilo.",
    attempt > 0 ? `Intento ${attempt + 1}: evita repetir ideas de intentos anteriores; cambia el enfoque.` : "",
    "",
    langInstruction,
    "REGLAS OBLIGATORIAS:",
    "- Devuelve SOLO el texto del post, sin comillas ni comentarios.",
    "- PROHIBIDO: @usuarios, enlaces/URLs, correos, hashtags y nombres de cuentas o marcas reales.",
    "- No menciones el manual ni que te basas en otra cuenta.",
    "- No inventes datos, cifras ni noticias que no puedas afirmar.",
    lang === "en" ? "- Write the entire post in English only." : "- Escribe todo el post en espanol, sin palabras en otros idiomas.",
    attempt > 0 ? "- Este intento debe ser claramente distinto a los anteriores." : "",
  ].filter(Boolean).join("\n");

  const result = await aiConfig.generate(prompt, {
    system: lang === "en"
      ? "You write short X posts. Follow the rules exactly and never include users, links or hashtags."
      : "Escribes posts breves para X. Cumples las reglas al pie de la letra y nunca incluyes usuarios, enlaces ni hashtags.",
  });

  let text = String(result.text || "").trim().replace(/^["']|["']$/g, "").trim();
  text = sanitizeOutput(text);
  if (!text) throw new Error("La IA devolvio un texto vacio.");
  if (hasForbidden(text)) throw new Error("La IA incluyo un usuario o enlace; se descarta el texto.");
  if (text.length > max) throw new Error(`El texto supera ${max} caracteres (${text.length}).`);
  // TSAFE-ACP-CALL: control de calidad TypeSafe antes de publicar.
  const tsQuality = await typesafeQuality(profile, text, max);
  if (tsQuality && tsQuality.verdict && !tsQuality.verdict.ok) {
    throw new Error(`TypeSafe: calidad insuficiente (${tsQuality.verdict.reason}).`);
  }

  return { text, provider: result.provider, model: result.model };
}

/**
 * Genera `count` posts variados para el perfil y los publica en la cuenta con
 * sesion activa. Devuelve un resumen.
 */
async function publishNow(handle, count, { topics, dryRun = false } = {}) {
  await load();
  const profile = profileState(handle);
  const total = Math.max(1, Math.min(20, Number(count) || profile.config.postsPerDay || 3));
  const failed = [];
  let generatedCount = 0;
  // Separacion entre posts de una misma tanda manual (por defecto 2 min) para
  // no soltar una rafaga si se piden varios de golpe.
  const gapMs = Math.max(30, Number(profile.config.manualGapSeconds) || 120) * 1000;
  for (let i = 0; i < total; i += 1) {
    if (i > 0 && !dryRun) await new Promise((r) => setTimeout(r, gapMs));
    const result = await publishOne(profile, { topics, dryRun });
    if (result.ok) generatedCount += 1;
    else failed.push({ topic: result.topic, error: result.error });
  }
  await save();
  return {
    ok: failed.length === 0,
    published: profile.history.filter((h) => h.status === "published").length,
    generated: generatedCount,
    failed,
  };
}

/**
 * Genera (y publica, salvo dryRun) UN solo post para el perfil. Reutilizado por
 * la publicacion manual y por el tick programado (un post por franja horaria).
 */
async function publishOne(profile, { topics, dryRun = false, slot = "" } = {}) {
  const xAuth = require("./x-auth");
  const list = parseTopics(topics || profile.config.topics);
  const topic = topicForSlot(list, profile.history.length, profile.history);
  let generated = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      generated = await generateOne(profile, topic, attempt);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!generated) {
    const error = lastError ? lastError.message : "sin texto";
    profile.errors.unshift({ at: nowIso(), topic, error });
    profile.errors = profile.errors.slice(0, 50);
    return { ok: false, topic, error };
  }
  const entry = {
    at: nowIso(),
    text: generated.text,
    topic,
    slot,
    provider: generated.provider,
    model: generated.model,
    status: dryRun ? "generated" : "pending",
    remoteId: "",
    error: "",
  };
  if (!dryRun) {
    try {
      const result = await xAuth.postTweet(generated.text);
      entry.status = "published";
      entry.remoteId = result && result.accountId ? String(result.accountId) : "";
      profile.lastPublishedAt = nowIso();
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
      profile.errors.unshift({ at: nowIso(), topic, error: error.message });
      profile.errors = profile.errors.slice(0, 50);
      profile.history.unshift(entry);
      profile.history = profile.history.slice(0, 200);
      profile.lastProvider = `${generated.provider}/${generated.model}`;
      return { ok: false, topic, error: error.message, entry };
    }
  }
  profile.history.unshift(entry);
  profile.history = profile.history.slice(0, 200);
  profile.lastProvider = `${generated.provider}/${generated.model}`;
  return { ok: true, topic, entry };
}

/**
 * Tick programado: publica UN post por cada franja horaria que ya haya llegado
 * y no se haya publicado todavia hoy. Respeta "minutos entre posts" de verdad.
 *
 * IMPORTANTE: una franja NUNCA se reintenta. Si falla, se marca como usada y el
 * siguiente tick no volvera a intentarla. Asi evitamos el bucle que publicaba en
 * cadena cuando X devolvia un falso error (el post si salia, pero la confirmacion
 * fallaba). Ademas hay un candado de tiempo minimo entre posts.
 */
async function tick() {
  await load();
  const now = new Date();
  const day = todayKey();
  for (const key of Object.keys(state.profiles)) {
    const profile = state.profiles[key];
    if (!profile.config.enabled) continue;

    // Reinicia el registro de franjas al cambiar de dia.
    if (profile.slotDate !== day) {
      profile.slotDate = day;
      profile.firedSlots = [];
    }
    if (!Array.isArray(profile.firedSlots)) profile.firedSlots = [];

    // Candado duro: nunca dos posts del mismo perfil dentro del margen minimo.
    const minGap = Math.max(5, Number(profile.config.minGapMinutes) || 45);
    const lastAt = profile.lastPublishedAt ? new Date(profile.lastPublishedAt).getTime() : 0;
    if (lastAt && now.getTime() - lastAt < minGap * 60000) {
      continue;
    }

    const count = Math.max(1, Number(profile.config.postsPerDay) || 3);
    // Tope duro diario: nunca mas posts que los pedidos, pase lo que pase.
    const publishedToday = Array.isArray(profile.history)
      ? profile.history.filter((h) => h && h.status === "published" && String(h.at || "").slice(0, 10) === day).length
      : 0;
    if (publishedToday >= count) {
      continue;
    }
    const slots = fixedSlotTimes(profile.config, count, now, key);
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i].getTime() > now.getTime()) break; // aun no toca
      const slotKey = `${day}#${i}`;
      if (profile.firedSlots.includes(slotKey)) continue; // ya salio o ya fallo
      profile.firedSlots.push(slotKey); // se marca SIEMPRE: no se reintenta
      try {
        const result = await publishOne(profile, { slot: slots[i].toISOString() });
        if (result.ok) {
          profile.lastPublishedAt = nowIso();
          profile.lastRunDate = day;
          console.log(`[acct-publisher] @${key}: post ${i + 1}/${count} publicado (franja ${slots[i].toISOString()})`);
        } else {
          console.error(`[acct-publisher] @${key}: franja ${i + 1} fallo: ${result.error}`);
        }
      } catch (error) {
        console.error(`[acct-publisher] @${key}: ${error.message}`);
      }
      await save(); // guarda tras cada post para no repetir si se cae
      // Solo una franja por tick para no publicar en cadena si el worker estuvo parado.
      break;
    }
    await save();
  }
}

function startWorker() {
  if (worker) return;
  const cron = require("node-cron");
  worker = cron.schedule("* * * * *", () => tick().catch((error) => console.error("[acct-publisher]", error)));
  console.log("[acct-publisher] worker arrancado (revisa cada minuto)");
}

function publicProfile(handle) {
  const profile = profileState(handle);
  const count = Math.max(1, Number(profile.config.postsPerDay) || 3);
  let slots = [];
  try {
    slots = fixedSlotTimes(profile.config, count, new Date(), profile.handle)
      .map((d) => d.toISOString());
  } catch { slots = []; }
  return {
    handle: profile.handle,
    config: clone(profile.config),
    lastRunDate: profile.lastRunDate,
    lastResult: profile.lastResult || null,
    lastProvider: profile.lastProvider || "",
    lastPublishedAt: profile.lastPublishedAt || "",
    firedSlots: (profile.slotDate === todayKey() ? profile.firedSlots : []) || [],
    todaySlots: slots,
    history: profile.history.slice(0, 30),
    errors: profile.errors.slice(0, 10),
  };
}

async function configure(handle, patch = {}) {
  await load();
  const profile = profileState(handle);
  const c = profile.config;
  if (typeof patch.enabled === "boolean") c.enabled = patch.enabled;
  if (patch.postsPerDay != null) c.postsPerDay = Math.max(1, Math.min(20, Number(patch.postsPerDay) || 3));
  if (patch.topics != null) c.topics = parseTopics(patch.topics);
  if (patch.startTime != null) {
    const m = String(patch.startTime).match(/^(\d{1,2}):(\d{2})$/);
    if (m) c.startTime = `${String(Math.min(23, Number(m[1]))).padStart(2, "0")}:${m[2]}`;
  }
  if (patch.spreadMinutes != null) c.spreadMinutes = Math.max(5, Math.min(1440, Number(patch.spreadMinutes) || 240));
  if (patch.maxChars != null) c.maxChars = Math.max(80, Math.min(4000, Number(patch.maxChars) || 280));
  if (patch.language != null) {
    c.language = String(patch.language).toLowerCase() === "es" ? "es" : "en";
    c.languageChosen = c.language;
  }
  if (patch.jitterMinutes != null) c.jitterMinutes = Math.max(0, Math.min(120, Number(patch.jitterMinutes) || 0));
  if (patch.minGapMinutes != null) c.minGapMinutes = Math.max(5, Math.min(1440, Number(patch.minGapMinutes) || 45));
  // NO se borran las franjas ya usadas al cambiar ajustes: eso republicaria lo
  // de hoy. Las franjas solo se reinician al cambiar de dia.
  await save();
  return publicProfile(handle);
}

function clearHistory(handle) {
  const profile = profileState(handle);
  profile.history = [];
  profile.errors = [];
  profile.lastRunDate = "";
  profile.slotDate = "";
  profile.firedSlots = [];
  return save().then(() => publicProfile(handle));
}

/**
 * Parada de emergencia: desactiva la publicacion diaria y marca las franjas de
 * hoy como ya atendidas, para que no salga nada mas hoy aunque se reactive.
 * Manana vuelve a su ritmo normal.
 */
async function stop(handle) {
  await load();
  const profile = profileState(handle);
  profile.config.enabled = false;
  const day = todayKey();
  const count = Math.max(1, Number(profile.config.postsPerDay) || 3);
  profile.slotDate = day;
  profile.firedSlots = [];
  for (let i = 0; i < count; i += 1) profile.firedSlots.push(`${day}#${i}`);
  await save();
  return publicProfile(handle);
}

module.exports = {
  DEFAULTS,
  STATE_FILE,
  load,
  save,
  startWorker,
  tick,
  configure,
  publicProfile,
  publishNow,
  publishOne,
  clearHistory,
  stop,
  parseTopics,
  sanitizeOutput,
  slotTimes,
  fixedSlotTimes,
  safeHandle,
};

// TSAFE-ACP-QUALITY: capa de decision TypeSafe para la publicacion diaria.
// Devuelve null si TypeSafe no esta configurado o falla (nunca rompe el flujo).
async function typesafeQuality(profile, text, max) {
  try {
    const ts = require("./typesafe");
    if (!ts.configured || !ts.configured()) return null;
    const lang = String(profile.config.language || "en").toLowerCase() === "es" ? "es" : "en";
    return await ts.decide("publish_quality", {
      texto_generado: String(text || "").slice(0, 1500),
      master_prompt: "Publicar un post original breve sobre el tema del perfil, sin enlaces ni arrobas.",
      idioma_esperado: lang,
      max_caracteres: max,
    });
  } catch {
    return null;
  }
}

