/**
 * AutoClone controller — one-button pipeline.
 *
 * Given a TikTok username it:
 *   1. Runs a competitor analysis so the user sees what the profile is about.
 *   2. Downloads every video from that profile (yt-dlp).
 *   3. For each video: reads the on-screen text, translates it to Spanish,
 *      overlays the translation in place, and runs the video uniquifier.
 *
 * Progress is streamed over SSE. All state lives under .runtime/autoclone/.
 */

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { config } = require("../config");

const ROOT = path.resolve(config.projectRoot, ".runtime", "autoclone");
const JOBS_DIR = path.join(ROOT, "jobs");
// Per-profile download memory: which video ids were already downloaded, so a
// later run can continue where the previous one stopped instead of repeating.
const HISTORY_DIR = path.join(ROOT, "history");
const textOverlay = require("./text-overlay");
const { writeMetaFromInfoJson } = require("../video-meta");
const { ytDlpCommand } = require("../yt-dlp");

function nowIso() { return new Date().toISOString(); }

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || `job-${Date.now()}`;
}

function resolveYtDlp() {
  return ytDlpCommand();
}

function resolveFfmpeg() { return process.env.FFMPEG_PATH || "ffmpeg"; }
function resolveFfprobe() { return process.env.FFPROBE_PATH || "ffprobe"; }

function run(cmd, args, { timeout = 900_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
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
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }, timeout);
      timer.unref?.();
    }

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      error.stdout = stdout;
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
      error.stdout = stdout;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write JSON atomically when possible. On Windows a tmp+rename can fail with
 * EPERM/EBUSY when antivirus, OneDrive or Explorer briefly locks the files
 * (common under C:\Users\...\Downloads), so retry and, as a last resort, write
 * straight to the target file.
 */
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) {
          break;
        }
        await sleep(120 * (attempt + 1));
      }
    }
  } catch (error) {
    if (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(error.code)) throw error;
  }
  // Last resort: write directly to the target, retrying a few times.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.writeFile(filePath, body, { encoding: "utf8", mode: 0o600 });
      break;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 4) throw error;
      await sleep(150 * (attempt + 1));
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {});
}

function historyPath(handle) {
  const clean = String(handle || "").replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "unknown";
  return path.join(HISTORY_DIR, `${clean}.json`);
}

/**
 * Read the per-profile download memory.
 * Shape: { handle, downloadedIds: string[], updatedAt }
 */
async function readHistory(handle) {
  try {
    const data = JSON.parse(await fs.readFile(historyPath(handle), "utf8"));
    const downloadedIds = Array.isArray(data.downloadedIds)
      ? data.downloadedIds.map((id) => String(id)).filter(Boolean)
      : [];
    return { handle: normalizeHandle(handle), downloadedIds, updatedAt: data.updatedAt || null };
  } catch {
    return { handle: normalizeHandle(handle), downloadedIds: [], updatedAt: null };
  }
}

async function writeHistory(handle, downloadedIds) {
  await writeJson(historyPath(handle), {
    handle: normalizeHandle(handle),
    downloadedIds: [...new Set(downloadedIds.map((id) => String(id)).filter(Boolean))],
    updatedAt: nowIso(),
  });
}

/**
 * Pick the next batch of video ids to download.
 *
 * ids: the full profile listing already ordered by the chosen cronology.
 * downloaded: ids seen in previous runs.
 * max: how many to take (0 = every remaining video).
 *
 * Returns the slice to download, so "10" then "10" continues 11..20 instead of
 * repeating 1..10.
 */
function selectNextBatch(ids, downloaded, max = 0) {
  const seen = downloaded instanceof Set ? downloaded : new Set(downloaded || []);
  const pending = ids.filter((id) => !seen.has(id));
  if (max > 0) return pending.slice(0, max);
  return pending;
}

function normalizeHandle(target) {
  let value = String(target || "").trim();
  if (!value) return "";
  if (value.startsWith("http")) {
    try {
      const parsed = new URL(value);
      const match = parsed.pathname.match(/@([^/]+)/);
      return match ? `@${match[1]}` : value;
    } catch { return value; }
  }
  return value.startsWith("@") ? value : `@${value}`;
}

/**
 * Detect a direct video URL (tiktok.com/@user/video/<id>). Accepts the canonical
 * link, share links with query strings, and short vm./vt. links (resolved by
 * yt-dlp later). Returns { url, username, id } or null when it is not a video.
 */
function parseVideoUrl(target) {
  const value = String(target || "").trim();
  if (!value) return null;
  const match = value.match(
    /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/(@[^/?#]+)\/video\/(\d+)/i
  );
  if (match) {
    return {
      url: `https://www.tiktok.com/${match[1]}/video/${match[2]}`,
      username: match[1],
      id: match[2],
    };
  }
  // Short share links (vm.tiktok.com/XXXX, vt.tiktok.com/XXXX) carry no id here;
  // yt-dlp resolves them, but we still flag them as single-video requests.
  if (/^https?:\/\/(?:vm|vt)\.tiktok\.com\//i.test(value)) {
    return { url: value, username: "", id: "" };
  }
  return null;
}

class AutoCloneController extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.running = false;
    this.cancelRequested = false;
    this.jobId = null;
    this.lastProgress = { stage: "idle", detail: "Sin trabajo en curso.", percent: 0 };
    fsSync.mkdirSync(JOBS_DIR, { recursive: true });
  }

  getProgress() { return this.lastProgress; }

  /** Per-profile download memory (which video ids were already downloaded). */
  async getHistory(handle) {
    const history = await readHistory(handle);
    return { ...history, count: history.downloadedIds.length };
  }

  /** Forget the download memory of one profile, so the next run starts over. */
  async resetHistory(handle) {
    const target = normalizeHandle(handle);
    if (!target) throw new Error("Escribe un nombre de usuario de TikTok.");
    await fs.rm(historyPath(target), { force: true }).catch(() => {});
    return { ok: true, handle: target, count: 0 };
  }

  get lastFolder() {
    return this.lastProgress?.folder || null;
  }

  /** Validate a destination folder and preview the per-user subfolder name. */
  async checkDestination(destinationRoot, username = "") {
    const raw = String(destinationRoot || "").trim();
    if (!raw) return { valid: false, folder: "", perUser: "" };
    const resolved = path.resolve(raw);
    try {
      await fs.mkdir(resolved, { recursive: true });
      await fs.access(resolved, fsSync.constants.W_OK);
      const handle = normalizeHandle(username);
      const clean = handle.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "");
      return {
        valid: true,
        folder: resolved,
        perUser: clean ? path.join(resolved, clean) : resolved,
      };
    } catch {
      return { valid: false, folder: resolved, perUser: "", error: "La carpeta no existe o no se puede escribir en ella." };
    }
  }

  _report(stage, detail, extra = {}) {
    this.lastProgress = { stage, detail, at: nowIso(), ...extra };
    this.emit("progress", this.lastProgress);
  }

  /** Cookie flags for the active account, so yt-dlp can use the saved session. */
  async _cookieArgs() {
    try {
      const { getActiveAccount } = require("../account-manager");
      const jar = require("../cookie-jar");
      const account = await getActiveAccount();
      return await jar.cookieArgsForAccount(account && account.id ? account.id : "default");
    } catch {
      return [];
    }
  }

  /** Read the Gemini key saved by the Competencia section so both share it. */
  async _aiSettings() { // CK[read]
    const competitorSettings = await readJson(
      path.resolve(config.projectRoot, ".runtime", "competitor", "settings.json"),
      {},
    );
    return {
      // Free key (gemini-2.5-flash) is used first; the paid key only kicks in
      // once the free quota is exhausted. Keep both paid names for old settings.
      apiKey: competitorSettings.freeGeminiApiKey || process.env.GEMINI_FREE_API_KEY || "",
      paidApiKey: competitorSettings.paidGeminiApiKey
        || competitorSettings.geminiPaidApiKey
        || competitorSettings.geminiPaidKey
        || competitorSettings.geminiApiKey
        || process.env.GEMINI_PAID_API_KEY
        || process.env.GEMINI_API_KEY
        || "",
      paidModel: competitorSettings.paidGeminiModel || process.env.GEMINI_PAID_MODEL || "gemini-3.6-flash",
      openRouterKey: competitorSettings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
      deepSeekKey: competitorSettings.deepSeekApiKey || process.env.DEEPSEEK_API_KEY || "", // DS[ac-read]
      model: competitorSettings.model || "gemini-3.6-flash",
      visionModel: process.env.AUTOCLONE_VISION_MODEL || competitorSettings.model || "gemini-3.6-flash",
    };
  }

  async listJobs() {
    const names = await fs.readdir(JOBS_DIR).catch(() => []);
    const jobs = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const raw = await readJson(path.join(JOBS_DIR, name), null);
      if (raw) jobs.push({
        id: raw.id, handle: raw.handle, status: raw.status, createdAt: raw.createdAt,
        totalVideos: raw.videos?.length || 0,
        processed: (raw.videos || []).filter((v) => v.status === "done").length,
        analysisSummary: raw.analysis?.summary || "",
      });
    }
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return jobs;
  }

  async getJob(id) { return readJson(path.join(JOBS_DIR, `${safeId(id)}.json`), null); }

  async _saveJob(job) {
    await writeJson(path.join(JOBS_DIR, `${safeId(job.id)}.json`), job);
  }

  cancel() {
    if (!this.running) return { ok: false, error: "No hay ningun trabajo en curso." };
    this.cancelRequested = true;
    this._report("cancelling", "Cancelando...", { percent: this.lastProgress.percent });
    return { ok: true };
  }

  /**
   * Kick off the pipeline. Returns immediately; progress arrives over SSE.
   * options: { username, maxVideos, uniquify, translate, minViews, destinationRoot, downloadThumbnail, downloadOrder }
   */
  async start(options = {}) {
    if (this.running) throw new Error("Ya hay una ejecucion en curso. Espera a que termine.");

    // A direct video URL takes priority: it clones exactly that one video.
    const video = parseVideoUrl(options.videoUrl);
    if (String(options.videoUrl || "").trim() && !video) {
      throw new Error("La URL del video no es valida. Pega un enlace de TikTok del tipo https://www.tiktok.com/@usuario/video/123...");
    }

    const handle = video && video.username
      ? video.username
      : normalizeHandle(options.username);
    if (!video && !handle) throw new Error("Escribe un nombre de usuario de TikTok o la URL de un video.");

    const destinationRoot = String(options.destinationRoot || "").trim();
    if (destinationRoot) {
      const resolved = path.resolve(destinationRoot);
      try {
        await fs.mkdir(resolved, { recursive: true });
        await fs.access(resolved, fsSync.constants.W_OK);
      } catch {
        throw new Error(`No se puede escribir en la carpeta de destino: ${destinationRoot}`);
      }
    }

    const job = {
      id: `${safeId(handle || "video")}-${Date.now()}`,
      handle,
      url: video ? video.url : `https://www.tiktok.com/${handle}`,
      videoUrl: video ? video.url : "",
      singleVideo: Boolean(video),
      createdAt: nowIso(),
      status: "running",
      options: {
        maxVideos: video ? 1 : (Number(options.maxVideos) || 0),
        uniquify: options.uniquify !== false,
        translate: options.translate !== false,
        minViews: Number(options.minViews) || 0,
        uniquifyIntensity: options.uniquifyIntensity || "media",
        uniquifyOptions: options.uniquifyOptions && typeof options.uniquifyOptions === "object"
          ? options.uniquifyOptions
          : {},
        metadataLanguage: options.metadataLanguage === "original" ? "original" : "es",
        downloadThumbnail: options.downloadThumbnail === true,
        downloadOrder: options.downloadOrder === "recent" ? "recent" : "oldest",
        startMode: options.startMode === "restart" ? "restart" : "continue",
        karaoke: options.karaoke === true,
        destinationRoot: destinationRoot ? path.resolve(destinationRoot) : "",
      },
      analysis: null,
      videos: [],
    };
    await fs.mkdir(this._videoDir(job), { recursive: true });
    await this._saveJob(job);

    this.running = true;
    this.cancelRequested = false;
    this.jobId = job.id;

    this._run(job).catch((error) => {
      this._report("error", error.message, { percent: 100 });
    }).finally(() => {
      this.running = false;
    });

    return { id: job.id, handle, singleVideo: Boolean(video), folder: this._userDir(job) };
  }

  _videoDir(job) { return path.join(ROOT, "jobs", safeId(job.id)); }
  /** Folder the finished videos land in: chosen destination/<user> or the job folder. */
  _userDir(job) {
    const username = String(job.handle || "").replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "") || "usuario";
    if (job.options?.destinationRoot) return path.join(job.options.destinationRoot, username);
    return path.join(this._videoDir(job), "outputs");
  }
  _downloadDir(job) { return path.join(this._videoDir(job), "downloads"); }
  _outputDir(job) { return this._userDir(job); }
  _workDir(job) { return path.join(this._videoDir(job), "work"); }

  async _run(job) {
    const ai = await this._aiSettings();
    try {
      // 1) Competitor analysis -------------------------------------------
      if (job.singleVideo) {
        // A single video has no profile to analyse; skip straight to download.
        this._report("analysis", "Video suelto: se omite el analisis del perfil.", { percent: 12 });
      } else {
        this._report("analysis", `Analizando el perfil ${job.handle}...`, { percent: 3 });
        try {
          const competitor = require("../competitor/controller").getCompetitorController();
          const report = await competitor.analyze({ target: job.handle, depth: 24, language: "es" });
          job.analysis = {
            id: report.id || "",
            summary: report.summary || "",
            metrics: report.metrics || {},
            style: report.style || {},
            narrative: report.narrative || {},
            categories: report.categories || {},
            opportunities: report.opportunities || [],
            masterPrompt: report.masterPrompt || "",
            dataQuality: report.dataQuality,
          };
          await this._saveJob(job);
          this._report("analysis", "Analisis completado.", { percent: 12 });
        } catch (error) {
          job.analysis = { error: error.message };
          await this._saveJob(job);
          this._report("analysis-warning", `El analisis fallo (${error.message}). Se continua con la descarga.`, { percent: 12 });
        }
      }

      // 2) Download every video ------------------------------------------
      this._report("download", job.singleVideo ? "Descargando el video indicado..." : "Descargando los videos del perfil...", { percent: 15 });
      const downloaded = await this._downloadAll(job, ai);
      if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
      if (!downloaded.length) throw new Error("No se pudo descargar ningun video del perfil.");
      this._report("download", `${downloaded.length} videos descargados.`, { percent: 45 });

      // 3) Per video: translate overlay + uniquify -----------------------
      await fs.mkdir(this._outputDir(job), { recursive: true });
      for (let index = 0; index < downloaded.length; index += 1) {
        if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
        const video = downloaded[index];
        const basePercent = 45 + Math.round((index / downloaded.length) * 53);
        try {
          video.status = "processing";
          await this._saveJob(job);
          const result = await this._processVideo(job, video, ai, {
            onProgress: (progress) => this._report(progress.stage, progress.detail, {
              percent: Math.min(98, basePercent + 2),
              videoIndex: index + 1,
              videoTotal: downloaded.length,
            }),
          });
          Object.assign(video, result, { status: "done" });
        } catch (error) {
          video.status = "error";
          video.error = error.message;
          this._report("video-error", `Video ${index + 1} fallo: ${error.message}`, { percent: basePercent + 2 });
        }
        await this._saveJob(job);
      }

      job.status = this.cancelRequested ? "cancelled" : "done";
      job.finishedAt = nowIso();
      job.folder = this._userDir(job);
      await this._saveJob(job);
      this._report("done", `Pipeline completado: ${job.videos.filter((v) => v.status === "done").length} de ${job.videos.length} videos. Guardados en ${job.folder}`, {
        percent: 100, jobId: job.id, folder: job.folder,
      });
    } catch (error) {
      job.status = this.cancelRequested ? "cancelled" : "error";
      job.error = error.message;
      job.finishedAt = nowIso();
      await this._saveJob(job).catch(() => {});
      this._report("error", error.message, { percent: 100, jobId: job.id });
    }
  }

  /** List profile video URLs then download each one. */
  async _downloadAll(job, ai) {
    const ytDlp = resolveYtDlp();
    if (path.isAbsolute(ytDlp) && !fsSync.existsSync(ytDlp)) {
      throw new Error(
        `No se encontro yt-dlp. Coloca yt-dlp.exe en ${path.dirname(ytDlp)} o define YTDLP_PATH en .env.`
      );
    }
    const downloadDir = this._downloadDir(job);
    await fs.mkdir(downloadDir, { recursive: true });

    // Single video: download exactly the requested URL, no profile listing.
    if (job.singleVideo) {
      const parsed = parseVideoUrl(job.videoUrl) || { url: job.videoUrl, id: "" };
      const id = parsed.id || `video-${Date.now()}`;
      const target = path.join(downloadDir, `${id}.mp4`);
      this._report("download", `Descargando el video indicado...`, { percent: 15 });
      try {
        const cookieArgs = await this._cookieArgs();
        const downloadArgs = [
          "--no-warnings", ...cookieArgs, "-f", "mp4/bestvideo*+bestaudio/best",
          "--merge-output-format", "mp4", "-o", target,
          "--write-info-json",
        ];
        if (job.options.downloadThumbnail) downloadArgs.push("--write-thumbnail");
        downloadArgs.push(job.videoUrl); // CK[single]
        await run(ytDlp, downloadArgs, { timeout: 600_000 });
        const stat = await fs.stat(target).catch(() => null);
        if (!stat || stat.size < 1024) throw new Error("descarga vacia");
        try {
          await writeMetaFromInfoJson(target, {
            language: job.options.metadataLanguage,
            apiKey: ai.apiKey,
            paidApiKey: ai.paidApiKey,
            paidModel: ai.paidModel,
            openRouterKey: ai.openRouterKey,
            logger: (m) => this._report("download", m, {}),
          });
        } catch (metaError) {
          this._report("download-warning", `Sin metadatos para ${id}: ${metaError.message}`, {});
        }
        const thumbnailPath = job.options.downloadThumbnail
          ? await require("../queue").findThumbnailPath(target)
          : null;
        if (job.options.downloadThumbnail && !thumbnailPath) {
          this._report("download-warning", `No se encontro la portada del video ${id}; se usara la portada de TikTok al publicar.`, {});
        }
        await this._stampDownloadIndex(target, 0);
        const videos = [{ id, sourcePath: target, sizeBytes: stat.size, status: "pending", downloadIndex: 0, hasThumbnail: Boolean(thumbnailPath) }];
        job.videos = videos;
        await this._saveJob(job);
        return videos;
      } catch (error) {
        throw new Error(`No se pudo descargar el video (${error.message}). Comprueba que el enlace sea publico y correcto.`);
      }
    }

    const max = job.options.maxVideos;
    const startMode = job.options.startMode === "restart" ? "restart" : "continue";
    const history = startMode === "restart"
      ? { downloadedIds: [] }
      : await readHistory(job.handle);
    job.historyCount = history.downloadedIds.length;

    const cookieArgs = await this._cookieArgs();
    const listArgs = ["--no-warnings", ...cookieArgs, "--flat-playlist", "--print", "%(id)s"]; // CK[list]
    if (job.options.downloadOrder === "oldest") listArgs.push("--playlist-reverse");
    listArgs.push(job.url);

    let ids = [];
    try {
      const { stdout } = await run(ytDlp, listArgs, { timeout: 300_000 });
      ids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      throw new Error(`No se pudo listar el perfil con yt-dlp: ${error.message}`);
    }
    if (!ids.length) throw new Error("El perfil no devolvio videos (puede ser privado o no existir).");

    // Continue where the previous run stopped: skip the ids already downloaded
    // and take the next `max` in the chosen chronological order.
    const selected = selectNextBatch(ids, history.downloadedIds, max);
    if (!selected.length) {
      this._report("download", `No hay videos nuevos en ${job.handle}: ya se descargaron todos (${ids.length}).`, { percent: 45 });
    } else {
      this._report("download", `Descargando ${selected.length} de ${ids.length} videos (${history.downloadedIds.length} ya descargados)...`, { percent: 15 });
    }
    job.historyTotal = ids.length;

    const videos = [];
    for (let index = 0; index < selected.length; index += 1) {
      if (this.cancelRequested) break;
      const id = selected[index];
      const target = path.join(downloadDir, `${id}.mp4`);
      this._report("download", `Descargando video ${index + 1}/${selected.length}...`, { percent: 15 });
      try {
        const downloadArgs = [
          "--no-warnings", ...cookieArgs, "-f", "mp4/bestvideo*+bestaudio/best",
          "--merge-output-format", "mp4", "-o", target,
          "--write-info-json",
        ];
        if (job.options.downloadThumbnail) downloadArgs.push("--write-thumbnail");
        downloadArgs.push(`https://www.tiktok.com/${job.handle}/video/${id}`); // CK[loop]
        await run(ytDlp, downloadArgs, { timeout: 600_000 });
        const stat = await fs.stat(target).catch(() => null);
        if (!stat || stat.size < 1024) throw new Error("descarga vacia");
        // Save the video's own title/description/hashtags next to the file.
        try {
          await writeMetaFromInfoJson(target, {
            language: job.options.metadataLanguage,
            apiKey: ai.apiKey,
            paidApiKey: ai.paidApiKey,
            paidModel: ai.paidModel,
            openRouterKey: ai.openRouterKey,
            logger: (m) => this._report("download", m, {}),
          });
        } catch (metaError) {
          this._report("download-warning", `Sin metadatos para ${id}: ${metaError.message}`, {});
        }
        const thumbnailPath = job.options.downloadThumbnail
          ? await require("../queue").findThumbnailPath(target)
          : null;
        if (job.options.downloadThumbnail && !thumbnailPath) {
          this._report("download-warning", `No se encontro la portada del video ${id}; se usara la portada de TikTok al publicar.`, {});
        }
        await this._stampDownloadIndex(target, index);
        videos.push({ id, sourcePath: target, sizeBytes: stat.size, status: "pending", downloadIndex: index, hasThumbnail: Boolean(thumbnailPath) });
      } catch (error) {
        this._report("download-warning", `No se pudo descargar el video ${id}: ${error.message}`, {});
      }
    }
    job.videos = videos;
    // Remember what was downloaded so the next run continues from here. The ids
    // from this run are added even when some of them failed, so we do not loop
    // forever on a permanently broken video.
    const alreadyDownloaded = startMode === "restart" ? [] : history.downloadedIds;
    await writeHistory(job.handle, [...alreadyDownloaded, ...selected]).catch(() => {});
    await this._saveJob(job);
    return videos;
  }

  /** Translate on-screen text, burn it, then uniquify the result. */
  async _processVideo(job, video, ai, { onProgress } = {}) {
    const workDir = path.join(this._workDir(job), video.id);
    await fs.mkdir(workDir, { recursive: true });
    let current = video.sourcePath;
    video.notes = [];

    const { uniquifyVideo, resolveUniquifyOptions } = require("../video-uniquifier");
    const strengthOptions = resolveUniquifyOptions({
      ...(job.options.uniquifyOptions || {}),
      intensity: job.options.uniquifyIntensity || "media",
      removeAudio: false,
    });

    // Mirror FIRST, on the original frame, so the translated text burned later
    // stays readable. The uniquifier then runs without mirroring again.
    if (job.options.uniquify && strengthOptions.mirror) {
      onProgress?.({ stage: "uniquify", detail: `Volteando el video ${video.id}...` });
      const mirroredPath = path.join(workDir, "mirrored.mp4");
      await this._mirrorVideo(current, mirroredPath);
      current = mirroredPath;
      strengthOptions.mirror = false;
      video.mirrored = true;
    }

    if (job.options.translate) {
      if (!ai.apiKey && !ai.paidApiKey && !ai.openRouterKey && !ai.deepSeekKey) { // DS[ac-guard]
        video.notes.push("Sin API key de IA: no se pudo traducir el texto en pantalla.");
        this._report("translate-warning", "Sin API key de IA; se omite la traduccion del texto en pantalla.", {});
      } else {
        onProgress?.({ stage: "translate", detail: `Leyendo y traduciendo el texto del video ${video.id}...` });
        const result = await textOverlay.detectAndTranslate(current, {
          apiKey: ai.apiKey,
          paidApiKey: ai.paidApiKey,
          paidModel: ai.paidModel,
          openRouterKey: ai.openRouterKey,
          deepSeekKey: ai.deepSeekKey,
          model: ai.visionModel, // DS[ac-pass]
          workDir,
          onProgress,
        });
        video.textBoxes = result.boxes.length;
        video.visionErrors = result.errors || [];
        if (result.boxes.length) {
          // Karaoke replaces the black-box overlay: same position and size, but
          // the translation is highlighted word by word.
          const karaoke = job.options.karaoke === true;
          const assPath = path.join(workDir, karaoke ? "overlay.karaoke.es.ass" : "overlay.es.ass");
          if (karaoke) {
            await textOverlay.writeKaraokeAssFor(current, result.boxes, assPath, {
              width: result.width,
              height: result.height,
              duration: result.duration,
            });
          } else {
            await textOverlay.writeAssFor(current, result.boxes, assPath, {
              width: result.width,
              height: result.height,
              duration: result.duration,
            });
          }
          const translatedPath = path.join(workDir, "translated.mp4");
          await this._burnSubtitles(current, translatedPath, assPath, { width: result.width, height: result.height });
          current = translatedPath;
          video.translated = true;
          if (karaoke) video.karaoke = true;
        } else {
          video.translated = false;
          const detail = video.visionErrors.length
            ? `No se detecto texto traducible (${video.visionErrors[0]})`
            : "No se detecto texto traducible en el video.";
          video.notes.push(detail);
        }
      }
    }

    const outputPath = path.join(this._outputDir(job), `${video.id}${job.options.uniquify ? "_unique" : ""}.mp4`);
    if (job.options.uniquify) {
      onProgress?.({ stage: "uniquify", detail: `Uniquificando el video ${video.id} (${job.options.uniquifyIntensity || "media"})...` });
      await uniquifyVideo(current, outputPath, strengthOptions);
    } else {
      await fs.copyFile(current, outputPath);
    }

    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat || stat.size < 1024) {
      throw new Error("El procesado termino pero no se genero el video de salida.");
    }
    // Carry the original title/description/hashtags next to the final video so
    // Auto Post can publish with them.
    await this._copyMetaSidecar(video.sourcePath, outputPath, video.downloadIndex);
    await this._copyThumbnailSidecar(video.sourcePath, outputPath);
    return { outputPath, outputSizeBytes: stat.size };
  }

  async _stampDownloadIndex(videoPath, downloadIndex) {
    if (!Number.isInteger(downloadIndex)) return;
    const { getMetaPath } = require("../queue");
    const metaPath = getMetaPath(videoPath);
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      meta.downloadIndex = downloadIndex;
      await writeJson(metaPath, meta);
    } catch {
      // A later fallback still guarantees a .meta.json next to the final video.
    }
  }

  /**
   * Ensure the finished video has a companion "<name>.meta.json" so Auto Post
   * can always publish with the original title, description and hashtags. It is
   * created even when the video has no translatable text.
   */
  async _copyMetaSidecar(sourceVideoPath, targetVideoPath, downloadIndex = null) {
    const { getMetaPath } = require("../queue");
    const { writeMetaFromInfoJson, metaJsonPathFor, metaFromInfoJson, INFO_JSON_SUFFIX } = require("../video-meta");
    const targetMeta = getMetaPath(targetVideoPath);

    try {
      // 1) Preferred: the metadata file already built next to the download.
      await fs.copyFile(getMetaPath(sourceVideoPath), targetMeta);
      await this._stampDownloadIndex(targetVideoPath, downloadIndex);
      return;
    } catch {
      // No companion yet: try to build it from yt-dlp's info.json.
    }

    try {
      const meta = await writeMetaFromInfoJson(sourceVideoPath);
      if (meta) {
        await fs.copyFile(metaJsonPathFor(sourceVideoPath), targetMeta);
        await this._stampDownloadIndex(targetVideoPath, downloadIndex);
        return;
      }
    } catch {
      // Fall through to the minimal file below.
    }

    // 2) Last resort: still create the file, even if it is empty, so every
    // final video is guaranteed to carry a metadata companion.
    try {
      const { readVideoMeta } = require("../queue");
      const meta = await readVideoMeta(sourceVideoPath);
      const payload = meta || { title: "", description: "", hashtags: [], caption: "" };
      if (Number.isInteger(downloadIndex)) payload.downloadIndex = downloadIndex;
      await fs.writeFile(targetMeta, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Non-fatal: the video still publishes, just without its own metadata.
    }
  }

  async _copyThumbnailSidecar(sourceVideoPath, targetVideoPath) {
    const { getThumbnailPaths } = require("../queue");
    const target = path.parse(targetVideoPath);
    // Remove an old cover before copying the current one. This matters when a
    // destination folder is reused and the new run has cover downloads off.
    for (const targetPath of getThumbnailPaths(targetVideoPath)) {
      await fs.rm(targetPath, { force: true }).catch(() => {});
    }
    for (const sourcePath of getThumbnailPaths(sourceVideoPath)) {
      try {
        await fs.copyFile(sourcePath, path.join(target.dir, `${target.name}${path.extname(sourcePath)}`));
        return;
      } catch {
        // Try the next supported thumbnail extension.
      }
    }
  }

  /** Burn an ASS subtitle file into the video (optional logo overlay preserved). */
  _burnSubtitles(inputPath, outputPath, assPath, { width, height } = {}) {
    const escaped = String(assPath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    return run(resolveFfmpeg(), [
      "-y", "-i", inputPath,
      "-vf", `subtitles='${escaped}':original_size=${width || 1080}x${height || 1920}`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ], { timeout: 900_000 });
  }

  /**
   * Mirror the frame horizontally. Applied to the ORIGINAL video before any
   * translated text is burned in, so the on-screen text stays readable.
   */
  _mirrorVideo(inputPath, outputPath) {
    return run(resolveFfmpeg(), [
      "-y", "-i", inputPath,
      "-vf", "hflip",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ], { timeout: 900_000 });
  }
}

let instance = null;
function getAutoCloneController() {
  if (!instance) instance = new AutoCloneController();
  return instance;
}

module.exports = { AutoCloneController, getAutoCloneController, ROOT, HISTORY_DIR, normalizeHandle, parseVideoUrl, writeJson, selectNextBatch, readHistory, writeHistory, historyPath };
