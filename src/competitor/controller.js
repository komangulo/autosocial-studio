const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { config } = require("../config");
const { EventEmitter } = require("events");
const collector = require("./tiktok-collector");
const videoFrames = require("./video-frames");
const aiAnalyst = require("./ai-analyst");
const promptBuilder = require("./prompt-builder");

const ROOT = path.resolve(config.projectRoot, ".runtime", "competitor");
const SETTINGS_PATH = path.join(ROOT, "settings.json");
const REPORTS_DIR = path.join(ROOT, "reports");
const MEDIA_DIR = path.join(ROOT, "media");

const FRAME_VIDEOS = 3; // download the top N videos to study visuals

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

function run(cmd, args, { timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        const error = new Error(`Command timed out after ${timeout}ms: ${cmd}`);
        error.stderr = stderr;
        finish(reject, error);
      }, timeout);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      error.stderr = stderr;
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(`Command failed with code ${code}: ${cmd}`);
      error.code = code;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || `report-${Date.now()}`;
}

class CompetitorController extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.running = false;
    this.settings = { geminiApiKey: "", paidGeminiApiKey: "", freeGeminiApiKey: "", openRouterApiKey: "", xKiroApiKey: "", // XKC[controller][default]
          deepSeekApiKey: "", model: aiAnalyst.DEFAULT_MODEL, brand: "", language: "es" }; // DS[settings]
    this.lastProgress = { stage: "idle", detail: "", handle: "", at: null };
  }

  async init() {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    this.settings = { ...this.settings, ...(await readJson(SETTINGS_PATH, {})) };
  }

  getSettings() {
    return {
      hasGeminiKey: Boolean(this.settings.paidGeminiApiKey || this.settings.geminiApiKey),
      hasPaidGeminiKey: Boolean(this.settings.paidGeminiApiKey || this.settings.geminiApiKey),
      hasOpenRouterKey: Boolean(this.settings.openRouterApiKey),
      hasDeepSeekKey: Boolean(this.settings.deepSeekApiKey),
      hasXKiroKey: Boolean(this.settings.xKiroApiKey), // XKC[controller][status]
      xKiroKeyMasked: this.settings.xKiroApiKey ? `${this.settings.xKiroApiKey.slice(0, 6)}...${this.settings.xKiroApiKey.slice(-4)}` : "",
      deepSeekKeyMasked: this.settings.deepSeekApiKey ? `${this.settings.deepSeekApiKey.slice(0, 6)}...${this.settings.deepSeekApiKey.slice(-4)}` : "",
      deepSeekModel: "deepseek-flash", // DS[status]
      hasFreeGeminiKey: Boolean(this.settings.freeGeminiApiKey),
      geminiKeyMasked: this.settings.geminiApiKey ? `${this.settings.geminiApiKey.slice(0, 4)}${"*".repeat(8)}${this.settings.geminiApiKey.slice(-4)}` : "",
      model: this.settings.model,
      brand: this.settings.brand,
      language: this.settings.language,
      running: this.running,
    };
  }

  /** Ask Gemini which text models the key can use. */
  async listModels() {
    const paidKey = this.settings.paidGeminiApiKey || this.settings.geminiApiKey;
    if (!paidKey) throw new Error("Falta la API key de Gemini.");
    const models = await aiAnalyst.listModels(paidKey);
    return models;
  }

  async saveSettings(patch = {}) {
    if (typeof patch.geminiApiKey === "string") {
      if (patch.geminiApiKey.trim()) {
        this.settings.geminiApiKey = patch.geminiApiKey.trim();
        this.settings.paidGeminiApiKey = patch.geminiApiKey.trim();
      } else if (patch.geminiApiKey === "") {
        this.settings.geminiApiKey = "";
        this.settings.paidGeminiApiKey = "";
      }
    }
    if (typeof patch.paidGeminiApiKey === "string") {
      if (patch.paidGeminiApiKey.trim()) {
        this.settings.paidGeminiApiKey = patch.paidGeminiApiKey.trim();
        this.settings.geminiApiKey = patch.paidGeminiApiKey.trim();
      } else if (patch.paidGeminiApiKey === "") {
        this.settings.paidGeminiApiKey = "";
        this.settings.geminiApiKey = "";
      }
    }
    if (typeof patch.geminiPaidApiKey === "string") {
      if (patch.geminiPaidApiKey.trim()) {
        this.settings.paidGeminiApiKey = patch.geminiPaidApiKey.trim();
        this.settings.geminiApiKey = patch.geminiPaidApiKey.trim();
      } else if (patch.geminiPaidApiKey === "") {
        this.settings.paidGeminiApiKey = "";
        this.settings.geminiApiKey = "";
      }
    }
    if (patch.removeGemini) {
      this.settings.geminiApiKey = "";
      this.settings.paidGeminiApiKey = "";
    }
    if (typeof patch.freeGeminiApiKey === "string") {
      if (patch.freeGeminiApiKey.trim()) this.settings.freeGeminiApiKey = patch.freeGeminiApiKey.trim();
      else if (patch.freeGeminiApiKey === "") this.settings.freeGeminiApiKey = "";
    }
    if (typeof patch.openRouterApiKey === "string") {
      if (patch.openRouterApiKey.trim()) this.settings.openRouterApiKey = patch.openRouterApiKey.trim();
      else if (patch.openRouterApiKey === "") this.settings.openRouterApiKey = "";
    }
    if (patch.removeOpenRouter) this.settings.openRouterApiKey = "";
    if (typeof patch.deepSeekApiKey === "string") {
      if (patch.deepSeekApiKey.trim()) this.settings.deepSeekApiKey = patch.deepSeekApiKey.trim();
      else if (patch.deepSeekApiKey === "") this.settings.deepSeekApiKey = "";
    }
    if (patch.removeDeepSeek) this.settings.deepSeekApiKey = "";
    if (typeof patch.xKiroApiKey === "string") {
      if (patch.xKiroApiKey.trim()) this.settings.xKiroApiKey = patch.xKiroApiKey.trim();
      else if (patch.xKiroApiKey === "") this.settings.xKiroApiKey = "";
    } // XKC[controller][save]
    if (patch.removeXKiro) this.settings.xKiroApiKey = ""; // DS[save]
    if (typeof patch.model === "string" && patch.model.trim()) this.settings.model = patch.model.trim();
    if (typeof patch.brand === "string") this.settings.brand = patch.brand.trim().slice(0, 120);
    if (typeof patch.language === "string") this.settings.language = patch.language.trim().slice(0, 20) || "es";
    await writeJsonAtomic(SETTINGS_PATH, this.settings);
    return this.getSettings();
  }

  getProgress() {
    return this.lastProgress;
  }

  _report(stage, detail, extra = {}) {
    this.lastProgress = { stage, detail, at: new Date().toISOString(), ...extra };
    this.emit("progress", this.lastProgress);
  }

  reportPath(id) {
    return path.join(REPORTS_DIR, `${safeId(id)}.json`);
  }

  async listReports() {
    const names = await fs.readdir(REPORTS_DIR).catch(() => []);
    const reports = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const raw = await readJson(path.join(REPORTS_DIR, name), null);
      if (!raw) continue;
      reports.push({
        id: raw.id,
        handle: raw.handle,
        url: raw.url,
        summary: raw.summary || "",
        analyzedAt: raw.analyzedAt || null,
        metrics: raw.metrics || {},
        framesAnalyzed: raw.framesAnalyzed || 0,
        dataQuality: raw.dataQuality || null,
      });
    }
    reports.sort((a, b) => String(b.analyzedAt).localeCompare(String(a.analyzedAt)));
    return reports;
  }

  async getReport(id) {
    const raw = await readJson(this.reportPath(id), null);
    if (!raw) throw new Error("Informe no encontrado.");
    return raw;
  }

  async deleteReport(id) {
    await fs.rm(this.reportPath(id), { force: true });
    return { ok: true };
  }

  /** Download the top N videos so we can extract frames from them. */
  async _downloadTopVideos(report) {
    const ytdlp = collector.resolveYtDlp();
    const dir = path.join(MEDIA_DIR, safeId(report.handle || "profile"));
    await fs.mkdir(dir, { recursive: true });
    const top = report.summary.topVideos.slice(0, FRAME_VIDEOS);
    const downloaded = [];
    for (let index = 0; index < top.length; index += 1) {
      const video = top[index];
      if (!video.url) continue;
      const target = path.join(dir, `${safeId(video.id || String(index))}.mp4`);
      if (await fs.access(target).then(() => true).catch(() => false)) {
        downloaded.push({ videoId: video.id, path: target });
        continue;
      }
      try {
        await run(ytdlp, ["--no-warnings", "-f", "mp4/best", "-S", "res:480", "-o", target, video.url], { timeout: 180_000 });
        downloaded.push({ videoId: video.id, path: target });
      } catch {
        // A failed download just means fewer frames; keep going.
      }
    }
    return downloaded;
  }

  /** Full pipeline: collect -> frames -> AI analysis -> report. */
  async analyze({ target, depth, brand, language } = {}) {
    if (this.running) throw new Error("Ya hay un análisis en curso. Espera a que termine.");
    if (!(this.settings.paidGeminiApiKey || this.settings.geminiApiKey)) throw new Error("Falta la API key de Gemini. Añádela en la sección Competencia.");
    this.running = true;
    let resolvedHandle = "";
    this._report("starting", "Preparando análisis...", { percent: 2 });
    try {
      const report = await collector.collect({
        target,
        depth,
        onProgress: (progress) => this._report(progress.stage, progress.detail, { handle: resolvedHandle, percent: 10 }),
      });
      resolvedHandle = report.handle || "";

      const frames = [];
      this._report("frames", "Descargando los vídeos más vistos para estudiar el estilo visual...", { handle: resolvedHandle, percent: 45 });
      try {
        const clips = await this._downloadTopVideos(report);
        for (const clip of clips) {
          const { frames: extracted } = await videoFrames.extractFrames(clip.path, path.join(MEDIA_DIR, safeId(report.handle || "profile"), "frames"));
          for (const framePath of extracted) {
            frames.push({
              videoId: clip.videoId,
              imageBase64: await videoFrames.fileToBase64(framePath),
              mimeType: "image/jpeg",
            });
          }
        }
      } catch (error) {
        this._report("frames-skipped", `No se pudieron analizar fotogramas (${error.message}). Se continúa solo con métricas.`, { handle: resolvedHandle, percent: 55 });
      }

      this._report("analyzing", `Analizando ${report.videos.length} vídeos con IA...`, { handle: resolvedHandle, percent: 65 });
      const { analysis, usage } = await aiAnalyst.analyze(report, {
        // Free key first; the paid key takes over when the free quota runs out.
        apiKey: this.settings.freeGeminiApiKey || "",
        paidApiKey: this.settings.paidGeminiApiKey || this.settings.geminiApiKey,
        paidModel: "gemini-3.6-flash",
        openRouterKey: this.settings.openRouterApiKey,
        xKiroKey: this.settings.xKiroApiKey || process.env.XKIRO_API_KEY || "", // XKA[analisis][controller]
        deepSeekKey: this.settings.deepSeekApiKey || process.env.DEEPSEEK_API_KEY || "", // DSA[analisis][controller]
        onProgress: (p) => this._report(p.stage || "analysis", p.detail || ""),
        model: this.settings.model,
        brand: brand ?? this.settings.brand,
        language: language ?? this.settings.language,
        frames,
      });

      const finalReport = promptBuilder.buildReport(report, analysis, {
        brand: brand ?? this.settings.brand,
        language: language ?? this.settings.language,
        framesUsed: frames.length,
      });
      finalReport.id = safeId(report.handle || target);
      finalReport.usage = usage;
      finalReport.dataQuality = report.summary.dataQuality;
      await writeJsonAtomic(this.reportPath(finalReport.id), finalReport);
      this._report("done", "Análisis completado.", { handle: resolvedHandle, reportId: finalReport.id, percent: 100 });
      return finalReport;
    } catch (error) {
      this._report("error", error.message);
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Regenerate only the master prompt from a stored report. */
  async rebuildMasterPrompt(id, { brand, language } = {}) {
    const report = await this.getReport(id);
    report.masterPrompt = promptBuilder.buildMasterPrompt(report, {
      brand: brand ?? report.brand ?? this.settings.brand,
      language: language ?? report.language ?? this.settings.language,
    });
    report.analyzedAt = new Date().toISOString();
    await writeJsonAtomic(this.reportPath(id), report);
    return report;
  }

  /** List Google Flow accounts so the UI can pick where to apply the prompt. */
  async listFlowAccounts() {
    try {
      const manager = require("../account-manager");
      const accounts = await manager.getAllAccounts();
      return (accounts || [])
        .filter((account) => (account.platform || "tiktok") === "tiktok")
        .map((account) => ({ id: account.id, name: account.name || account.id, enabled: account.enabled !== false }));
    } catch {
      return [];
    }
  }

  /**
   * Apply a report's master prompt as the fixed Flow prompt template for an
   * account. The template must contain the {{dynamic}} marker that Flow uses
   * to inject the per-video phrase.
   */
  async applyToFlow(id, { accountId } = {}) {
    if (!accountId) throw new Error("Elige una cuenta de Google Flow.");
    const report = await this.getReport(id);
    const base = String(report.masterPrompt || "").trim();
    if (!base) throw new Error("Este informe no tiene Prompt Maestro.");

    const { getFlowConfig, saveFlowConfig } = require("../flow-config");
    const { DYNAMIC_MARKER } = require("../flow-prompt");
    const current = await getFlowConfig(accountId, { includePrivate: true });
    let template = base;
    if (!template.includes(DYNAMIC_MARKER)) {
      template += `\n\nTema concreto del vídeo de hoy (texto en pantalla y guion): \"${DYNAMIC_MARKER}\"`;
    }
    if (template.length > 10000) template = template.slice(0, 9990);
    const saved = await saveFlowConfig(accountId, { fixedPromptTemplate: template });
    return { ok: true, accountId, template: saved.fixedPromptTemplate, length: template.length };
  }
}

let instance = null;
function getCompetitorController() {
  if (!instance) instance = new CompetitorController();
  return instance;
}

module.exports = { CompetitorController, getCompetitorController, ROOT };
