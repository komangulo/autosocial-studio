/**
 * Video metadata companions.
 *
 * When yt-dlp downloads a TikTok video we ask it for --write-info-json, which
 * leaves a "<video>.info.json" next to the file. This module turns that rich
 * dump into a small, stable companion file "<video>.meta.json" holding just the
 * title, description and hashtags, so the publisher can reuse them.
 *
 * The companion shape is:
 *   { title: string, description: string, hashtags: string[], caption: string }
 */

const fs = require("fs/promises");
const path = require("path");
const { buildCaptionFromMeta, extractHashtags } = require("./queue");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const INFO_JSON_SUFFIX = ".info.json";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

function infoJsonPathFor(videoPath) {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}${INFO_JSON_SUFFIX}`);
}

function metaJsonPathFor(videoPath) {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}.meta.json`);
}

/** Normalize a yt-dlp "tags" value (array, string or null) into a clean list. */
function normalizeTagList(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string") list = value.split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const tag = String(entry || "").replace(/^#+/, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * META-DESC-ONLY-v1
 * Build the companion metadata object from a yt-dlp info.json payload.
 * TikTok no tiene titulo: la descripcion trae el texto completo y los
 * hashtags. El "title" de yt-dlp viene truncado con "..." y los "tags"
 * repetirian lo que ya esta en la descripcion, asi que se descartan.
 * Shape: { description, caption }
 */
function metaFromInfoJson(info = {}) {
  const description = String(info.description || "").trim();
  return { description, caption: buildCaptionFromMeta({ description }) };
}

function parseTranslationJson(text) {
  const raw = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("La IA no devolvio metadatos traducidos validos.");
  return JSON.parse(candidate.slice(start, end + 1));
}

function preserveHashtagsInText(translatedText, originalText) {
  const translated = String(translatedText || "").trim();
  const original = String(originalText || "").trim();
  const hashIndex = original.indexOf("#");
  if (hashIndex < 0) return translated;
  const body = translated.split("#", 1)[0].trim();
  const hashtagSuffix = original.slice(hashIndex).trim();
  return [body, hashtagSuffix].filter(Boolean).join(" ");
}

function preserveTitleHashtags(translatedTitle, originalTitle) {
  return preserveHashtagsInText(translatedTitle, originalTitle);
}

async function callGeminiTranslation(apiKey, model, prompt) {
  const response = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: "Eres un traductor de metadatos para videos de TikTok. Devuelve exclusivamente JSON valido." }],
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: "application/json" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini respondio ${response.status}`);
  return (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
}

async function callOpenRouterTranslation(apiKey, prompt) {
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://localhost",
      "X-Title": "AutoSocial Studio",
    },
    body: JSON.stringify({
      model: "google/gemma-4-26b-a4b-it:free",
      messages: [
        { role: "system", content: "Eres un traductor de metadatos para videos de TikTok. Devuelve exclusivamente JSON valido." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenRouter respondio ${response.status}`);
  return data.choices?.[0]?.message?.content || "";
}

/**
 * TRANS-DESC-ONLY
 * Translate the description to Spanish while preserving hashtags.
 */
async function translateMetaToSpanish(meta, {
  apiKey = "",
  paidApiKey = "",
  paidModel = "gemini-3.6-flash",
  openRouterKey = "",
  logger = null,
} = {}) {
  const original = {
    description: String(meta.description || "").trim(),
  };
  const prompt = [
    "Traduce el campo description al espanol.",
    "Conserva los hashtags exactamente sin cambios.",
    "Devuelve exactamente este JSON: {\"description\":\"\"}",
    JSON.stringify(original),
  ].join("\n");

  const providers = [];
  if (apiKey) providers.push(() => callGeminiTranslation(apiKey, "gemini-2.5-flash", prompt));
  if (paidApiKey && paidApiKey !== apiKey) providers.push(() => callGeminiTranslation(paidApiKey, paidModel, prompt));
  if (openRouterKey) providers.push(() => callOpenRouterTranslation(openRouterKey, prompt));
  if (!providers.length) return { ...original, caption: buildCaptionFromMeta(original) };

  let lastError = null;
  for (const request of providers) {
    try {
      const translated = parseTranslationJson(await request());
      const description = preserveHashtagsInText(translated.description || original.description, original.description);
      const result = {
        description,
        caption: buildCaptionFromMeta({ description }),
      };
      logger?.("Metadatos traducidos al espanol para Auto Post.");
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No se pudo traducir el metadata.");
}

/**
 * If a "<video>.info.json" exists next to the video, write "<video>.meta.json".
 * Returns the metadata object, or null when there is nothing to do.
 */
async function writeMetaFromInfoJson(videoPath, { logger = null, language = "original", ...translationOptions } = {}) {
  const infoPath = infoJsonPathFor(videoPath);
  let info;
  try {
    info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  } catch {
    return null;
  }
  let meta = metaFromInfoJson(info);
  if (String(language).toLowerCase() === "es") {
    try {
      meta = await translateMetaToSpanish(meta, { ...translationOptions, logger });
    } catch (error) {
      logger?.(`No se pudieron traducir los metadatos: ${error.message}. Se conserva el texto original.`);
    }
  }
  const metaPath = metaJsonPathFor(videoPath);
  try {
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    logger?.(`Wrote metadata: ${path.basename(metaPath)} (description)`);
    return meta;
  } catch (error) {
    logger?.(`Could not write ${path.basename(metaPath)}: ${error.message}`, "error");
    return null;
  }
}

/**
 * Scan a downloads folder for videos newer than `sinceMs` and make sure each
 * has a companion .meta.json. Useful right after a yt-dlp run.
 */
async function enrichRecentVideos(rootDir, sinceMs, { logger = null } = {}) {
  let dirs = [];
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(rootDir, entry.name));
  } catch {
    return { processed: 0 };
  }

  let processed = 0;
  const walk = async (dir) => {
    let files = [];
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of files) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = await fs.stat(full);
        if (sinceMs && stat.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      // Only write when missing or older than the info.json.
      const metaPath = metaJsonPathFor(full);
      const infoPath = infoJsonPathFor(full);
      try {
        const [metaStat, infoStat] = await Promise.all([fs.stat(metaPath), fs.stat(infoPath)]);
        if (metaStat.mtimeMs >= infoStat.mtimeMs) continue;
      } catch {
        // Missing one of them: try to write anyway.
      }
      const meta = await writeMetaFromInfoJson(full, { logger });
      if (meta) processed += 1;
    }
  };

  await walk(rootDir);
  return { processed };
}

module.exports = {
  INFO_JSON_SUFFIX,
  infoJsonPathFor,
  metaJsonPathFor,
  metaFromInfoJson,
  translateMetaToSpanish,
  preserveTitleHashtags,
  normalizeTagList,
  writeMetaFromInfoJson,
  enrichRecentVideos,
};
