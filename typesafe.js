// Cliente TypeSafe (System One / Jev) para AutoSocial Studio.
//
// La API key vive SOLO en el servidor, en .env como TYPESAFE_API_KEY.
// Nunca se expone al navegador ni se incluye en respuestas HTTP.
//
// Carga .env por su cuenta (igual que src/config.js), de modo que funciona
// tambien si el proceso no cargo dotenv antes.
//
// Uso:
//   const typesafe = require("./typesafe");
//   const { answers, usage } = await typesafe.ask({
//     state: "texto o JSON",
//     questions: {
//       is_urgent: { type: "noul", instructions: "Transmite urgencia?" },
//       tema:      { type: "choice", instructions: "De que trata?", criteria: { tcg: "...", otro: null } },
//       calidad:   { type: "score", instructions: "Calidad", criteria: ["mala", "normal", "buena"] },
//     },
//   });
//
// Docs (fuente de verdad): https://docs.typesafe.ai/llms.txt
// Endpoint: POST https://api.typesafe.ai/v1/systemone

const path = require("path");
const fs = require("fs");

// --- Cargar .env sin depender de dotenv --------------------------------
const PROJECT_ROOT = path.resolve(__dirname, "..");
function parseEnvFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
parseEnvFile(path.join(PROJECT_ROOT, ".env"));
// Si el proyecto esta anidado, prueba tambien junto al modulo.
parseEnvFile(path.join(__dirname, ".env"));

const API_URL = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const REQUEST_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 45000);

function apiKey() {
  const key = (process.env.TYPESAFE_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Falta TYPESAFE_API_KEY. Anade la clave a .env en la raiz del proyecto (solo servidor)."
    );
  }
  return key;
}

function configured() {
  return Boolean((process.env.TYPESAFE_API_KEY || "").trim());
}

/**
 * Lanza una evaluacion tipada contra TypeSafe.
 * @param {{ state: string|object|array, questions: object, model?: string }} input
 * @returns {Promise<{ model: string, answers: object, usage: object }>}
 */
async function ask({ state, questions, model } = {}) {
  if (state == null) throw new Error("TypeSafe: falta 'state'.");
  if (!questions || typeof questions !== "object" || !Object.keys(questions).length) {
    throw new Error("TypeSafe: faltan 'questions' (al menos una).");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: model || DEFAULT_MODEL, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`TypeSafe: respuesta no JSON (HTTP ${res.status}).`); }
    if (!res.ok) {
      const detail = data && (data.error || data.message) ? (data.error || data.message) : text.slice(0, 300);
      throw new Error(`TypeSafe HTTP ${res.status}: ${detail}`);
    }
    return {
      model: data.model || model || DEFAULT_MODEL,
      answers: data.answers || {},
      usage: data.usage || {},
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`TypeSafe: tiempo de espera agotado (${REQUEST_TIMEOUT_MS} ms).`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ejecuta una decision nombrada (definida en typesafe-questions.js) contra un estado.
 * Lanza TODAS las preguntas en una sola llamada (fan-out) y devuelve:
 *   { answers, verdict, model, usage, ms }
 * El `verdict` lo calcula la regla de codigo de esa decision.
 *
 * Si TypeSafe no esta configurado o falla, devuelve `null` en vez de lanzar:
 * asi la herramienta sigue funcionando por la cadena antigua sin romperse.
 *
 * @param {string} decisionKey  clave en DECISIONS, p.ej. "radar_relevance"
 * @param {string|object|array} state
 * @param {{ model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<null | { answers: object, verdict: object, model: string, usage: object, ms: number }>}
 */
async function decide(decisionKey, state, opts = {}) {
  if (!configured()) return null;
  let registry;
  try { registry = require("./typesafe-questions"); } catch { return null; }
  const decision = registry.DECISIONS[decisionKey];
  if (!decision) return null;
  const verdictFor = {
    radar_relevance: registry.radarRelevanceVerdict,
    radar_affiliate: registry.radarAffiliateVerdict,
    publish_quality: registry.publishQualityVerdict,
  }[decisionKey];

  const started = Date.now();
  let out;
  try {
    out = await ask({ state, questions: decision.questions, model: opts.model });
  } catch {
    return null; // fallback silencioso: nunca romper la herramienta por TypeSafe
  }
  let verdict = null;
  try { verdict = verdictFor ? verdictFor(out.answers) : null; } catch { verdict = null; }
  return { answers: out.answers, verdict, model: out.model, usage: out.usage, ms: Date.now() - started };
}

async function listModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.typesafe.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(data.error || text).slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ask, decide, configured, listModels, API_URL, DEFAULT_MODEL };
