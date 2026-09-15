const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");
const { HeliosJobManager } = require("./job-manager");
const { findImageModel, findVideoModel, imageModelCatalog, videoModelCatalog, providerCatalog } = require("./models");
const { generateOnServer } = require("./free-client");
const schema = require("./schema");

const HELIOS_ROOT = path.resolve(config.projectRoot, ".runtime", "helios");
const SETTINGS_PATH = path.join(HELIOS_ROOT, "settings.json");
const HISTORY_PATH = path.join(HELIOS_ROOT, "history.json");
const UPLOADS_DIR = path.join(HELIOS_ROOT, "uploads");
const PROJECTS_DIR = path.join(HELIOS_ROOT, "projects");

const ALLOWED_IMAGE_MIME = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);
const ALLOWED_VIDEO_MIME = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
]);
const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const HISTORY_LIMIT = 500;

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, filePath);
}

class HeliosController {
  constructor() {
    this.jobs = new HeliosJobManager();
    this.settings = { geminiApiKey: "", hfToken: "", autoDownload: false };
    this.history = [];
    this.ready = false;
    this._writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});
    await fs.mkdir(PROJECTS_DIR, { recursive: true }).catch(() => {});
    this.settings = { geminiApiKey: "", hfToken: "", autoDownload: false, ...(await readJson(SETTINGS_PATH, {})) };
    this.history = await readJson(HISTORY_PATH, []);
    if (!Array.isArray(this.history)) this.history = [];
    this.ready = true;
  }

  _persist() {
    const snapshot = { history: this.history.slice(0, HISTORY_LIMIT) };
    this._writeChain = this._writeChain
      .then(() => writeJsonAtomic(HISTORY_PATH, snapshot))
      .catch(() => {});
    return this._writeChain;
  }

  hasKey(provider) {
    if (provider === "google") return Boolean(this.settings.geminiApiKey);
    if (provider === "huggingface") return Boolean(this.settings.hfToken);
    return true;
  }

  async saveSettings(patch = {}) {
    if (typeof patch.geminiApiKey === "string" && patch.geminiApiKey.trim()) this.settings.geminiApiKey = patch.geminiApiKey.trim();
    if (patch.removeGemini) this.settings.geminiApiKey = "";
    if (typeof patch.hfToken === "string" && patch.hfToken.trim()) this.settings.hfToken = patch.hfToken.trim();
    if (patch.removeHf) this.settings.hfToken = "";
    if (typeof patch.autoDownload === "boolean") this.settings.autoDownload = patch.autoDownload;
    await writeJsonAtomic(SETTINGS_PATH, this.settings);
    return this.getSettings();
  }

  mask(value) {
    if (!value) return "";
    return `${value.slice(0, 4)}${"*".repeat(8)}${value.slice(-4)}`;
  }

  getSettings() {
    return {
      providers: providerCatalog(),
      geminiKeyMasked: this.mask(this.settings.geminiApiKey),
      hfTokenMasked: this.mask(this.settings.hfToken),
      hasGeminiKey: Boolean(this.settings.geminiApiKey),
      hasHfToken: Boolean(this.settings.hfToken),
      autoDownload: this.settings.autoDownload,
    };
  }

  getCatalog() {
    return {
      imageModels: imageModelCatalog(),
      videoModels: videoModelCatalog(),
      providers: providerCatalog(),
    };
  }

  getHistory({ kind, limit = 60 } = {}) {
    let items = this.history;
    if (kind) items = items.filter((h) => h.kind === kind);
    return items.slice(0, limit);
  }

  async _addHistory(entry) {
    this.history.unshift(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
    this.jobs.upsert(entry.id, {
      kind: entry.kind,
      status: entry.status,
      createdAt: entry.createdAt,
      prompt: entry.prompt,
      model: entry.model,
    });
    await this._persist();
    return entry;
  }

  async _updateHistory(id, patch) {
    const entry = this.history.find((h) => h.id === id);
    if (entry) Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    await this._persist();
    return entry;
  }

  resolveModel({ model, kind }) {
    if (model) {
      const found = kind === "video" ? findVideoModel(model) : findImageModel(model);
      if (found) return found;
    }
    const list = kind === "video" ? videoModelCatalog() : imageModelCatalog();
    if (!list.length) throw new Error(`No ${kind} models available.`);
    return list[0];
  }

  /**
   * Generate from a resolved config object. Server providers run inline and the
   * output is saved locally; browser providers (Puter, Flow) return a `client`
   * instruction for the frontend to execute.
   */
  async generate(body = {}) {
    const configValue = body.config && typeof body.config === "object" ? body.config : {};
    const kind = configValue.kind === "video" ? "video" : body.kind === "video" ? "video" : "image";
    const prompt = String(configValue.prompt ?? body.prompt ?? "").trim();
    const model = this.resolveModel({ model: configValue.model || body.model, kind });
    const ratio = configValue.aspectRatio || model.defaultRatio || "1:1";

    if (!prompt && !(kind === "video" && model.promptOptional)) throw new Error("Prompt is required.");

    const references = collectReferenceUrls(configValue.references || body.references || []);
    const target = kind === "video" && model.requiredReferences ? model.requiredReferences : 0;
    if (target && references.length < target) {
      throw new Error(`${model.name} requires at least ${target} reference image(s).`);
    }

    const historyId = `hg-${crypto.randomUUID()}`;
    await this._addHistory({
      id: historyId,
      kind,
      status: "pending",
      prompt,
      model: model.id,
      modelName: model.name,
      provider: model.provider,
      aspectRatio: ratio,
      references,
      createdAt: new Date().toISOString(),
    });

    const apiKey = model.provider === "google" ? this.settings.geminiApiKey
      : model.provider === "huggingface" ? this.settings.hfToken
      : "";

    if (!this.hasKey(model.provider)) {
      const message = `${model.provider} needs an API key. Add it in Settings.`;
      await this._updateHistory(historyId, { status: "error", error: message });
      throw new Error(message);
    }

    try {
      const inlineReferences = model.provider === "google" ? await this._inlineReferences(references) : references;
      const result = await generateOnServer({
        provider: model.provider,
        providerModel: model.providerModel,
        kind,
        prompt,
        ratio,
        references: inlineReferences,
        apiKey,
      });

      if (result.client) {
        await this._updateHistory(historyId, { status: "client", client: result.client, clientCall: result.call });
        return { historyId, client: result.client, call: result.call, model: model.id };
      }

      const saved = await this.saveBuffer(result.buffer, result.mime);
      const patch = kind === "video"
        ? { status: "done", videoUrl: saved.url, videoUrls: [saved.url] }
        : { status: "done", imageUrl: saved.url, imageUrls: [saved.url] };
      this.jobs.succeed(historyId, patch);
      await this._updateHistory(historyId, patch);
      return { historyId, ...patch, model: model.id };
    } catch (error) {
      this.jobs.fail(historyId, error.message);
      await this._updateHistory(historyId, { status: "error", error: error.message });
      throw error;
    }
  }

  /** Read local reference images into { base64, mimeType } for inline APIs. */
  async _inlineReferences(references) {
    const out = [];
    for (const ref of references) {
      if (ref.startsWith("data:")) {
        const match = /^data:([^;]+);base64,(.+)$/s.exec(ref);
        if (match) out.push({ base64: match[2], mimeType: match[1] });
        continue;
      }
      if (ref.startsWith("/api/helios/media/")) {
        const name = ref.split("/").pop();
        const filePath = this.resolveUpload(name);
        const buffer = await fs.readFile(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        out.push({ base64: buffer.toString("base64"), mimeType: MIME_BY_EXT[ext] || "image/png" });
      }
    }
    return out;
  }

  /** Persist a finished asset produced by the browser (Puter / Flow). */
  async saveGenerated({ historyId, dataUrl, remoteUrl, kind }) {
    if (!historyId) throw new Error("historyId is required.");
    const entry = this.history.find((h) => h.id === historyId);
    if (!entry) throw new Error("Unknown generation.");
    let url = remoteUrl;
    const isVideo = (kind || entry.kind) === "video";
    if (!url && dataUrl) {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ""));
      if (!match) throw new Error("Invalid data URL.");
      const saved = await this.saveBuffer(Buffer.from(match[2], "base64"), match[1]);
      url = saved.url;
    }
    if (!url) throw new Error("No asset URL or data provided.");
    const patch = isVideo ? { status: "done", videoUrl: url, videoUrls: [url] } : { status: "done", imageUrl: url, imageUrls: [url] };
    this.jobs.succeed(historyId, patch);
    await this._updateHistory(historyId, patch);
    return { ok: true, ...patch };
  }

  async saveBuffer(buffer, mimeType) {
    const ext = ALLOWED_IMAGE_MIME.get(mimeType) || ALLOWED_VIDEO_MIME.get(mimeType)
      || (mimeType?.startsWith("image/") ? ".png" : ".mp4");
    if (!buffer?.length) throw new Error("Empty asset.");
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    const filePath = path.join(UPLOADS_DIR, name);
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    return { path: filePath, url: `/api/helios/media/${name}`, size: buffer.length };
  }

  async saveUpload({ buffer, mimeType, originalName }) {
    const allowed = ALLOWED_IMAGE_MIME.get(mimeType) || ALLOWED_VIDEO_MIME.get(mimeType);
    if (!allowed) throw new Error(`Unsupported file type: ${mimeType}`);
    if (!buffer || !buffer.length) throw new Error("Empty upload.");
    if (buffer.length > MAX_UPLOAD_BYTES) throw new Error("Upload exceeds 100 MB.");
    const saved = await this.saveBuffer(buffer, mimeType);
    return { ...saved, name: originalName || path.basename(saved.path), mimeType };
  }

  async saveDataUrl(dataUrl) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ""));
    if (!match) throw new Error("Invalid data URL.");
    return this.saveUpload({ buffer: Buffer.from(match[2], "base64"), mimeType: match[1], originalName: "reference" });
  }

  resolveUpload(name) {
    const safe = path.basename(String(name || ""));
    if (!safe) throw new Error("Invalid media name.");
    const filePath = path.join(UPLOADS_DIR, safe);
    if (!filePath.startsWith(UPLOADS_DIR + path.sep)) throw new Error("Invalid media path.");
    return filePath;
  }

  async deleteHistory(id) {
    this.history = this.history.filter((h) => h.id !== id);
    this.jobs.remove(id);
    await this._persist();
    return { ok: true };
  }

  async clearHistory() {
    this.history = [];
    await this._persist();
    return { ok: true };
  }

  /* ------------------------------- Projects ------------------------------- */

  projectPath(id) {
    const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safe) throw new Error("Invalid project id.");
    return path.join(PROJECTS_DIR, `${safe}.json`);
  }

  async listProjects() {
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
    const names = await fs.readdir(PROJECTS_DIR).catch(() => []);
    const projects = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const raw = await readJson(path.join(PROJECTS_DIR, name), null);
      if (!raw) continue;
      projects.push({
        id: name.replace(/\.json$/, ""),
        name: raw.name || "Untitled",
        updatedAt: raw.updatedAt || null,
        nodes: Array.isArray(raw.nodes) ? raw.nodes.length : 0,
      });
    }
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return projects;
  }

  async getProject(id) {
    const raw = await readJson(this.projectPath(id), null);
    if (!raw) throw new Error("Project not found.");
    return schema.normalizeProject(raw, raw.name);
  }

  async saveProject(id, document) {
    const project = schema.normalizeProject(document, document?.name);
    const resolvedId = String(id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "") || crypto.randomUUID();
    const payload = { ...project, id: resolvedId, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.projectPath(resolvedId), payload);
    return { ok: true, id: resolvedId, project: payload };
  }

  async deleteProject(id) {
    await fs.rm(this.projectPath(id), { force: true });
    return { ok: true };
  }
}

let instance = null;
function getHeliosController() {
  if (!instance) instance = new HeliosController();
  return instance;
}

/** Normalize a references array: strings stay, objects expose a url. */
function collectReferenceUrls(references) {
  return (references || [])
    .map((ref) => (typeof ref === "string" ? ref : ref?.url))
    .filter(Boolean);
}

module.exports = { HeliosController, getHeliosController, HELIOS_ROOT, UPLOADS_DIR, PROJECTS_DIR };
