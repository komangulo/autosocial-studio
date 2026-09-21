// Cliente TypeSafe (System One / Jev) para AutoSocial Studio.
//
// La API key vive SOLO en el servidor, en .env como TYPESAFE_API_KEY.
// Nunca se expone al navegador ni se incluye en respuestas HTTP.
//
// Uso:
//   const typesafe = require("./typesafe");
//   const { answers, usage } = await typesafe.ask({
//     state: "texto o JSON",
//     questions: {
//       is_urgent: { type: "noul", instructions: "¿Transmite urgencia?" },
//       tema:      { type: "choice", instructions: "¿De qué trata?", criteria: { tcg: "...", otro: null } },
//       calidad:   { type: "score", instructions: "Calidad", criteria: ["mala", "normal", "buena"] },
//     },
//   });
//
// Docs (fuente de verdad): https://docs.typesafe.ai/llms.txt
// Endpoint: POST https://api.typesafe.ai/v1/systemone

const API_URL = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const REQUEST_TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 45000);

function apiKey() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    throw new Error(
      "Falta TYPESAFE_API_KEY. Anade la clave a .env en la raiz del proyecto (solo servidor)."
    );
  }
  return key;
}

function configured() {
  return Boolean(process.env.TYPESAFE_API_KEY);
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

module.exports = { ask, configured, listModels, API_URL, DEFAULT_MODEL };
