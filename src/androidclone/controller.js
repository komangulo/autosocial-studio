/**
 * AndroidClone controller — orchestrates the 6 phases with live progress.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const ai = require("./ai-providers");
const tools = require("./tools");
const store = require("./store");
const phases = require("./phases");
const vision = require("./vision");
const planner = require("./plan");
const scaffold = require("./scaffold");
const { runBuild } = require("./build");

class AndroidCloneController extends EventEmitter {
  constructor() {
    super();
    this.active = new Map(); // projectId -> phase key
    this.lastProgress = { stage: "idle", detail: "Sin trabajo en curso.", percent: 0 };
  }

  getSettings() {
    return store.readSettings();
  }

  async getPublicSettings() {
    return store.publicSettings(await this.getSettings());
  }

  listProviders() {
    return ai.catalog();
  }

  _report(stage, detail, extra = {}) {
    this.lastProgress = { stage, detail, at: new Date().toISOString(), ...extra };
    this.emit("progress", this.lastProgress);
  }

  async listModels({ provider, role } = {}) {
    const settings = await this.getSettings();
    const providerId = provider || (role === "code" ? settings.code.provider : settings.vision.provider);
    const apiKey = await store.apiKeyFor(providerId);
    if (!apiKey) throw new Error(`Falta la API key de ${ai.getProvider(providerId).label}.`);
    return ai.listModels({ providerId, apiKey });
  }

  async createProject({ name, adUrl, storeUrl, adFile, answers, packageName } = {}) {
    await store.ensureRoots();
    const id = `${store.safeId(name || adUrl || "proyecto")}-${crypto.randomBytes(3).toString("hex")}`;
    const project = {
      id,
      name: name || "Proyecto sin nombre",
      adUrl: adUrl || "",
      storeUrl: storeUrl || "",
      answers: answers || "",
      packageName: packageName || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activePhase: 1,
    };
    await fs.mkdir(store.projectDir(id), { recursive: true });
    await store.saveProject(project);
    return project;
  }

  _lock(projectId, key) {
    if (!this.active.has(projectId)) this.active.set(projectId, new Set());
    const set = this.active.get(projectId);
    if (set.has(key)) throw new Error(`La fase "${key}" ya está en curso para este proyecto.`);
    set.add(key);
  }

  _unlock(projectId, key) {
    this.active.get(projectId)?.delete(key);
  }

  async ingest(id, { adFile } = {}) {
    const project = await store.getProject(id);
    this._lock(id, "ingest");
    try {
      this._report("ingest", "Preparando la ingesta del anuncio…", { projectId: id, percent: 5 });
      let video;
      const file = adFile || project.uploadedFile;
      if (file) {
        this._report("ingest", "Usando el vídeo del anuncio subido…", { projectId: id, percent: 15 });
        video = await phases.ingestFromFile(project, file);
      } else if (project.adUrl) {
        this._report("ingest", "Descargando el vídeo del anuncio con yt-dlp…", { projectId: id, percent: 15 });
        video = await phases.ingestFromUrl(project, project.adUrl, {
          onProgress: (p) => this._report(p.stage, p.detail, { projectId: id, percent: p.percent ?? 15 }),
        });
      } else {
        throw new Error("Este proyecto no tiene URL de anuncio. Añade una o sube un vídeo.");
      }
      this._report("ingest", "Vídeo listo.", { projectId: id, percent: 30, video });
      return video;
    } finally {
      this._unlock(id, "ingest");
    }
  }

  async frames(id, { mode, limit } = {}) {
    const project = await store.getProject(id);
    this._lock(id, "frames");
    try {
      this._report("frames", "Extrayendo fotogramas con ffmpeg…", { projectId: id, percent: 40 });
      const settings = await this.getSettings();
      const result = await phases.extractFrames(project, { mode, limit: limit || settings.maxFrames });
      const updated = await store.getProject(id);
      updated.frames = { count: result.count, dir: result.framesDir };
      updated.activePhase = 3;
      await store.saveProject(updated);
      this._report("frames", `${result.count} fotogramas extraídos.`, { projectId: id, percent: 45 });
      return { count: result.count };
    } finally {
      this._unlock(id, "frames");
    }
  }

  async vision(id) {
    const project = await store.getProject(id);
    this._lock(id, "vision");
    try {
      const result = await vision.analyzeVision(project, {
        onProgress: (p) => this._report(p.stage, p.detail, { projectId: id, percent: 60 }),
      });
      this._report("vision", "Análisis visual completado.", { projectId: id, percent: 65 });
      return result;
    } finally {
      this._unlock(id, "vision");
    }
  }

  async plan(id, { answers } = {}) {
    const project = await store.getProject(id);
    this._lock(id, "plan");
    try {
      this._report("plan", "Diseñando el plan de desarrollo con Gemini…", { projectId: id, percent: 70 });
      const result = await planner.buildPlan(project, { answers });
      this._report("plan", "Plan de arquitectura listo.", { projectId: id, percent: 78 });
      return result;
    } finally {
      this._unlock(id, "plan");
    }
  }

  async scaffold(id) {
    const project = await store.getProject(id);
    this._lock(id, "scaffold");
    try {
      this._report("scaffold", "Generando el proyecto Kotlin + Compose…", { projectId: id, percent: 82 });
      const result = await scaffold.scaffold(project);
      this._report("scaffold", "Proyecto Android generado.", { projectId: id, percent: 88 });
      return result;
    } finally {
      this._unlock(id, "scaffold");
    }
  }

  async build(id) {
    const project = await store.getProject(id);
    this._lock(id, "build");
    try {
      const result = await runBuild(project, {
        onProgress: (p) => this._report(p.stage, p.detail, { projectId: id, percent: 92, attempt: p.attempt }),
      });
      this._report("build", result.ok ? "APK generado correctamente." : "El build falló tras los reintentos.", { projectId: id, percent: 100 });
      return result;
    } finally {
      this._unlock(id, "build");
    }
  }

  /** Full pipeline: ingest → frames → vision → plan → scaffold → build. */
  async run(id) {
    const project = await store.getProject(id);
    const steps = [
      ["ingest", () => this.ingest(id)],
      ["frames", () => this.frames(id)],
      ["vision", () => this.vision(id)],
      ["plan", () => this.plan(id)],
      ["scaffold", () => this.scaffold(id)],
      ["build", () => this.build(id)],
    ];
    const results = {};
    for (const [key, fn] of steps) {
      try {
        results[key] = await fn();
      } catch (error) {
        results[key] = { error: error.message };
        this._report("error", `La fase "${key}" se detuvo: ${error.message}`, { projectId: id, percent: 100 });
        break;
      }
    }
    return results;
  }

  async readProjectArtifact(id, name) {
    const project = await store.getProject(id);
    const dir = store.projectDir(id);
    const allowed = new Set(["project.json", "vision.json", "plan.json", "plan.md"]);
    let filePath;
    if (name === "apk") {
      filePath = project.build?.apk || path.join(dir, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    } else if (allowed.has(name)) {
      filePath = path.join(dir, name);
    } else if (name.startsWith("frames/")) {
      filePath = path.join(dir, name.replace(/\.\./g, ""));
    } else if (name.startsWith("android/")) {
      filePath = path.join(dir, name.replace(/\.\./g, ""));
    } else {
      throw new Error("Artefacto no disponible.");
    }
    await fs.access(filePath);
    return filePath;
  }
}

let instance = null;
function getAndroidCloneController() {
  if (!instance) instance = new AndroidCloneController();
  return instance;
}

module.exports = { AndroidCloneController, getAndroidCloneController, checkDependencies: tools.checkDependencies };
