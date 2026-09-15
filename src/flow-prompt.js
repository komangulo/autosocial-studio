const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { config } = require("./config");

const DYNAMIC_MARKER = "{{dynamic}}";
const DEFAULT_FIXED_PROMPT = [
  "Create a vertical cinematic video for TikTok.",
  `Use this original phrase as the central theme and on-screen text: \"${DYNAMIC_MARKER}\"`,
].join("\n");
const HISTORY_DIR = path.resolve(config.projectRoot, "flow-config");
const accountTails = new Map();

function assertAccountId(accountId) {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(String(accountId || ""))) {
    throw new Error("Invalid account identifier.");
  }
}

function validateFixedPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw new Error("The fixed prompt template is required.");
  if (prompt.length > 10000) throw new Error("The fixed prompt template must be 10,000 characters or fewer.");
  if (!prompt.includes(DYNAMIC_MARKER)) {
    throw new Error(`The fixed prompt template must contain ${DYNAMIC_MARKER}.`);
  }
  return prompt;
}

function renderFlowPrompt(template, phrase) {
  const fixed = validateFixedPrompt(template);
  const dynamic = String(phrase || "").trim();
  if (!dynamic) throw new Error("A dynamic phrase is required.");
  return fixed.split(DYNAMIC_MARKER).join(dynamic);
}

function phraseKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLocaleLowerCase("es")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function cleanPhrase(value) {
  return String(value || "")
    .replace(/^```(?:json)?\s*|\s*```$/gi, "")
    .replace(/^[\s"'`\u201c\u201d\u2018\u2019]+|[\s"'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function historyPath(accountId) {
  assertAccountId(accountId);
  return path.join(HISTORY_DIR, `${accountId}.phrase-history.json`);
}

async function readHistory(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.phrases)) {
      throw new Error("Unsupported phrase history format.");
    }
    return parsed.phrases
      .map((entry) => ({
        text: cleanPhrase(entry?.text),
        key: phraseKey(entry?.text),
        createdAt: entry?.createdAt || null,
      }))
      .filter((entry) => entry.text && entry.key);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Dynamic phrase history is unreadable: ${error.message}`);
  }
}

async function writeHistory(filePath, phrases) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${randomUUID()}`;
  const payload = JSON.stringify({ version: 1, phrases }, null, 2);
  await fs.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600);
}

function parseGeminiPhrases(data) {
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || "")
    .join("")
    .trim();
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini did not return text (${reason}).` : "Gemini did not return text.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, ""));
  } catch {
    throw new Error("Gemini returned an invalid structured response.");
  }
  const values = Array.isArray(parsed) ? parsed : parsed?.phrases;
  if (!Array.isArray(values)) throw new Error("Gemini response did not contain a phrase list.");
  return values.map(cleanPhrase).filter(Boolean);
}

function buildGenerationRequest(instructions, count, exclusions) {
  const recent = exclusions.slice(-100);
  const exclusionText = recent.length
    ? recent.map((phrase, index) => `${index + 1}. ${phrase}`).join("\n")
    : "No previous phrases.";
  return [
    "Create original short phrases for TikTok videos.",
    `Return exactly ${count} different phrases in the same language as the user's instructions.`,
    "Every phrase must be newly written, concise, self-contained, and suitable for on-screen text.",
    "Do not quote, copy, closely imitate, name, or attribute any book, author, character, or existing work.",
    "Do not add numbering, Markdown, explanations, quotation marks, or hashtags.",
    "Follow the requested theme and audience while keeping the wording suitable for a mainstream social platform.",
    `Variation nonce: ${randomUUID()}`,
    "",
    "User instructions:",
    String(instructions || "").trim(),
    "",
    "Do not repeat any of these previously used phrases:",
    exclusionText,
  ].join("\n");
}

async function requestGeminiPhrases({ apiKey, model, instructions, count, exclusions, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildGenerationRequest(instructions, count, exclusions) }] }],
          generationConfig: {
            temperature: 1.25,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                phrases: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["phrases"],
            },
          },
        }),
      }
    );
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = String(body?.error?.message || "").slice(0, 300);
      } catch {}
      throw new Error(`Gemini API returned ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
    return parseGeminiPhrases(await response.json());
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Gemini API timed out after 60 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function withAccountLock(accountId, operation) {
  const previous = accountTails.get(accountId) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.catch(() => {});
  accountTails.set(accountId, settled);
  return current.finally(() => {
    if (accountTails.get(accountId) === settled) accountTails.delete(accountId);
  });
}

async function generateUniqueDynamicPhrases(options = {}) {
  const accountId = String(options.accountId || "");
  const apiKey = String(options.apiKey || "").trim();
  const instructions = String(options.instructions || "").trim();
  const count = Math.max(1, Math.min(3, Number(options.count) || 1));
  const model = String(options.model || config.geminiModel || "gemini-2.5-flash").trim();
  const fetchImpl = options.fetchImpl || global.fetch;
  assertAccountId(accountId);
  if (!apiKey) throw new Error("Save a Gemini API key for this account first.");
  if (!instructions) throw new Error("Dynamic content instructions are required.");
  if (typeof fetchImpl !== "function") throw new Error("This Node.js version does not provide the Fetch API.");
  const filePath = options.historyFile || historyPath(accountId);

  return withAccountLock(accountId, async () => {
    const history = await readHistory(filePath);
    const used = new Set(history.map((entry) => entry.key));
    const selected = [];

    for (let attempt = 0; attempt < 4 && selected.length < count; attempt += 1) {
      const exclusions = [...history.map((entry) => entry.text), ...selected];
      const candidates = await requestGeminiPhrases({
        apiKey,
        model,
        instructions,
        count: count - selected.length,
        exclusions,
        fetchImpl,
      });
      for (const phrase of candidates) {
        const key = phraseKey(phrase);
        if (!key || used.has(key)) continue;
        used.add(key);
        selected.push(phrase);
        if (selected.length === count) break;
      }
    }

    if (selected.length !== count) {
      throw new Error(`Gemini could not produce ${count} unused phrases after 4 attempts.`);
    }

    const now = new Date().toISOString();
    await writeHistory(filePath, [
      ...history,
      ...selected.map((text) => ({ text, key: phraseKey(text), createdAt: now })),
    ]);
    return selected;
  });
}

module.exports = {
  DYNAMIC_MARKER,
  DEFAULT_FIXED_PROMPT,
  validateFixedPrompt,
  renderFlowPrompt,
  phraseKey,
  parseGeminiPhrases,
  generateUniqueDynamicPhrases,
};
