const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { IANAZone } = require("luxon");
const { config } = require("./config");
const { DEFAULT_FIXED_PROMPT, DYNAMIC_MARKER, validateFixedPrompt } = require("./flow-prompt");

const CONFIG_DIR = path.resolve(config.projectRoot, "flow-config");
const ASSET_DIR = path.resolve(config.projectRoot, "user-assets", "google-flow");
const saveTails = new Map();
const ALLOWED_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function assertAccountId(accountId) {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(String(accountId || ""))) {
    throw new Error("Invalid account identifier.");
  }
}

function configPath(accountId) {
  assertAccountId(accountId);
  return path.join(CONFIG_DIR, `${accountId}.json`);
}

function assetPath(accountId, extension) {
  assertAccountId(accountId);
  return path.join(ASSET_DIR, accountId, `reference${extension}`);
}

function normalizeTime(value, label = "time") {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) throw new Error(`${label} must use HH:MM in 24-hour format.`);
  return `${match[1]}:${match[2]}`;
}

function normalizeConfig(accountId, raw = {}) {
  const timezone = String(raw.timezone || config.timezone || "UTC").trim();
  if (!IANAZone.isValidZone(timezone)) throw new Error("Invalid IANA timezone.");
  const publicationTimes = Array.isArray(raw.publicationTimes) && raw.publicationTimes.length
    ? Array.from(new Set(raw.publicationTimes.map((time) => normalizeTime(time, "Publication time"))))
    : ["09:30", "14:30", "22:10"];
  const hasFixedTemplate = Object.prototype.hasOwnProperty.call(raw, "fixedPromptTemplate");
  const legacyPrompt = String(raw.prompt || "").trim();
  const legacyLimit = 10000 - DYNAMIC_MARKER.length - 2;
  const fixedPromptTemplate = validateFixedPrompt(
    hasFixedTemplate
      ? raw.fixedPromptTemplate
      : (legacyPrompt ? `${legacyPrompt.slice(0, legacyLimit)}\n\n${DYNAMIC_MARKER}` : DEFAULT_FIXED_PROMPT)
  );
  return {
    accountId,
    enabled: Boolean(raw.enabled),
    fixedPromptTemplate,
    dynamicInstructions: String(raw.dynamicInstructions || "").trim().slice(0, 5000),
    geminiApiKey: String(raw.geminiApiKey || "").trim().slice(0, 2048),
    caption: String(raw.caption || "").trim().slice(0, 2200),
    referenceImage: raw.referenceImage || null,
    videosPerDay: Math.max(1, Math.min(3, Number(raw.videosPerDay) || 3)),
    dailyTime: normalizeTime(raw.dailyTime || "06:00", "Generation time"),
    publicationTimes,
    timezone,
    autoPublish: raw.autoPublish !== false,
  };
}

function publicConfig(value) {
  const result = JSON.parse(JSON.stringify(value));
  result.geminiApiKeyConfigured = Boolean(result.geminiApiKey);
  delete result.geminiApiKey;
  if (result.referenceImage) {
    result.referenceImage = { type: result.referenceImage.type, name: result.referenceImage.name };
  }
  return result;
}

async function getFlowConfig(accountId, options = {}) {
  let value;
  try {
    const raw = await fs.readFile(configPath(accountId), "utf8");
    value = normalizeConfig(accountId, JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    value = normalizeConfig(accountId, {});
  }
  return options.includePrivate ? value : publicConfig(value);
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600);
}

function serializeAccountSave(accountId, operation) {
  const previous = saveTails.get(accountId) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.catch(() => {});
  saveTails.set(accountId, settled);
  return current.finally(() => {
    if (saveTails.get(accountId) === settled) saveTails.delete(accountId);
  });
}

async function saveFlowConfig(accountId, payload = {}) {
  assertAccountId(accountId);
  return serializeAccountSave(accountId, async () => {
    const current = await getFlowConfig(accountId, { includePrivate: true });
    let referenceImage = current.referenceImage || null;
    let geminiApiKey = current.geminiApiKey || "";

    if (typeof payload.geminiApiKey === "string" && payload.geminiApiKey.trim()) {
      geminiApiKey = payload.geminiApiKey.trim();
    }
    if (payload.removeGeminiApiKey) geminiApiKey = "";

    let imageUpload = null;
    if (payload.referenceImage?.data) {
      const type = String(payload.referenceImage.type || "").toLowerCase();
      const extension = ALLOWED_TYPES.get(type);
      if (!extension) throw new Error("Reference image must be JPG, PNG, or WebP.");
      const encoded = String(payload.referenceImage.data).replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(encoded, "base64");
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
        throw new Error("Reference image must be smaller than 12 MB.");
      }
      const target = assetPath(accountId, extension);
      imageUpload = { type, extension, buffer, target };
      referenceImage = { type, path: target, name: `reference${extension}` };
    }
    if (payload.removeReference) {
      imageUpload = null;
      referenceImage = null;
    }

    const next = normalizeConfig(accountId, { ...current, ...payload, referenceImage, geminiApiKey });
    if (imageUpload) {
      await fs.mkdir(path.dirname(imageUpload.target), { recursive: true });
      const temp = `${imageUpload.target}.partial-${randomUUID()}`;
      await fs.writeFile(temp, imageUpload.buffer, { mode: 0o600 });
      await fs.rename(temp, imageUpload.target);
    }
    await writeAtomic(configPath(accountId), JSON.stringify(next, null, 2));

    if (payload.removeReference) {
      for (const extension of ALLOWED_TYPES.values()) await fs.rm(assetPath(accountId, extension), { force: true });
    } else if (imageUpload) {
      for (const otherExtension of ALLOWED_TYPES.values()) {
        if (otherExtension !== imageUpload.extension) await fs.rm(assetPath(accountId, otherExtension), { force: true });
      }
    }
    return getFlowConfig(accountId);
  });
}

module.exports = { getFlowConfig, saveFlowConfig, normalizeConfig, normalizeTime, publicConfig };
