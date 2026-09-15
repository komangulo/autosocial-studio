/**
 * AndroidClone — turn an ad video into a buildable Android project.
 *
 * Shared helpers: ids, atomic JSON, settings, project store.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");

const ROOT = path.resolve(config.projectRoot, ".runtime", "androidclone");
const SETTINGS_PATH = path.join(ROOT, "settings.json");
const PROJECTS_DIR = path.join(ROOT, "projects");
const UPLOADS_DIR = path.join(ROOT, "uploads");

const DEFAULT_SETTINGS = {
  // API keys per provider: { gemini: "AIza...", openrouter: "sk-or-...", ... }
  providerKeys: {},
  // Which provider/model each role uses.
  vision: { provider: "gemini", model: "gemini-2.5-flash" },
  code: { provider: "gemini", model: "gemini-2.5-flash" },
  maxFrames: 40,
  repairAttempts: 3,
  language: "es",
  packagePrefix: "com.autosocial.generated",
  autonomy: "auto", // auto | plan-approval | step
  // yt-dlp cookies for sites that require a session (e.g. YouTube).
  cookies: {
    mode: "none", // none | browser | file
    browser: "",  // chrome | edge | firefox | brave | chromium | opera | vivaldi
    file: "",     // absolute path to a Netscape cookies.txt
  },
};

/** Map of provider id -> env var that can seed the key (convenience). */
const PROVIDER_ENV = {
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
};

function safeId(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `project-${crypto.randomUUID().slice(0, 8)}`;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode });
  await fs.rename(tmp, filePath);
}

async function readSettings() {
  const stored = await readJson(SETTINGS_PATH, {});
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  merged.providerKeys = { ...(stored?.providerKeys || {}) };
  // Seed from environment only when the user has not saved a key for that provider.
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV)) {
    if (!merged.providerKeys[provider] && process.env[envVar]) {
      merged.providerKeys[provider] = process.env[envVar];
    }
  }
  merged.vision = { ...DEFAULT_SETTINGS.vision, ...(stored?.vision || {}) };
  merged.code = { ...DEFAULT_SETTINGS.code, ...(stored?.code || {}) };
  merged.cookies = { ...DEFAULT_SETTINGS.cookies, ...(stored?.cookies || {}) };
  return merged;
}

async function saveSettings(patch = {}) {
  const current = await readSettings();
  const next = { ...current };

  const stringKeys = ["language", "packagePrefix", "autonomy"];
  for (const key of stringKeys) {
    if (typeof patch[key] === "string" && patch[key].trim()) next[key] = patch[key].trim();
  }
  for (const key of ["maxFrames", "repairAttempts"]) {
    const num = Number(patch[key]);
    if (Number.isFinite(num) && num > 0) next[key] = Math.min(200, Math.round(num));
  }

  // Per-provider keys: { providerKeys: { gemini: "..." } } or { provider, apiKey }
  const incomingKeys = { ...(patch.providerKeys || {}) };
  if (patch.provider && typeof patch.apiKey === "string") incomingKeys[patch.provider] = patch.apiKey;
  next.providerKeys = { ...current.providerKeys };
  for (const [provider, value] of Object.entries(incomingKeys)) {
    if (typeof value !== "string") continue;
    if (value.trim()) next.providerKeys[provider] = value.trim();
    else delete next.providerKeys[provider];
  }
  if (Array.isArray(patch.removeProviders)) {
    for (const provider of patch.removeProviders) delete next.providerKeys[provider];
  }

  // Role selection: { vision: {provider, model}, code: {provider, model} }
  for (const role of ["vision", "code"]) {
    if (patch[role] && typeof patch[role] === "object") {
      next[role] = { ...next[role], ...patch[role] };
    }
  }

  if (patch.cookies && typeof patch.cookies === "object") {
    next.cookies = { ...next.cookies, ...patch.cookies };
    if (!["none", "browser", "file"].includes(next.cookies.mode)) next.cookies.mode = "none";
  }

  await writeJson(SETTINGS_PATH, next);
  return next;
}

function publicSettings(settings) {
  const keyStatus = {};
  for (const [provider, key] of Object.entries(settings.providerKeys || {})) {
    if (!key) continue;
    keyStatus[provider] = { configured: true, masked: `${key.slice(0, 4)}${"*".repeat(6)}${key.slice(-4)}` };
  }
  return {
    providerKeys: keyStatus,
    vision: settings.vision,
    code: settings.code,
    maxFrames: settings.maxFrames,
    repairAttempts: settings.repairAttempts,
    language: settings.language,
    packagePrefix: settings.packagePrefix,
    autonomy: settings.autonomy,
    cookies: settings.cookies,
    hasAnyKey: Object.keys(keyStatus).length > 0,
  };
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, safeId(id));
}

async function ensureRoots() {
  await Promise.all([
    fs.mkdir(PROJECTS_DIR, { recursive: true }),
    fs.mkdir(UPLOADS_DIR, { recursive: true }),
  ]);
}

async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await writeJson(path.join(projectDir(project.id), "project.json"), project);
  return project;
}

async function getProject(id) {
  const raw = await readJson(path.join(projectDir(id), "project.json"), null);
  if (!raw) throw new Error(`Proyecto no encontrado: ${id}`);
  return raw;
}

async function listProjects() {
  await ensureRoots();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readJson(path.join(PROJECTS_DIR, entry.name, "project.json"), null);
    if (raw) projects.push(raw);
  }
  projects.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return projects;
}

async function deleteProject(id) {
  await fs.rm(projectDir(id), { recursive: true, force: true });
  return { ok: true };
}

/** Resolve the API key for a provider id from saved settings. */
async function apiKeyFor(providerId) {
  const settings = await readSettings();
  return settings.providerKeys?.[providerId] || "";
}

module.exports = {
  ROOT,
  PROJECTS_DIR,
  UPLOADS_DIR,
  SETTINGS_PATH,
  DEFAULT_SETTINGS,
  PROVIDER_ENV,
  safeId,
  readJson,
  writeJson,
  readSettings,
  saveSettings,
  publicSettings,
  apiKeyFor,
  projectDir,
  ensureRoots,
  saveProject,
  getProject,
  listProjects,
  deleteProject,
};
