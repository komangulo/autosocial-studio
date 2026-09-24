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
// Publication memory is separate from download memory. The next manual run
// must advance only after TikTok accepted a video, not merely after yt-dlp saved it.
const PUBLICATION_STATE_DIR = path.join(ROOT, "publication-state");
const textOverlay = require("./text-overlay");
const { writeMetaFromInfoJson, infoJsonPathFor } = require("../video-meta");
const { ytDlpCommand } = require("../yt-dlp");

function nowIso() { return new Date().toISOString(); }

function ytDlpDiagnostic(error) {
  const raw = String(error?.stderr || "").trim();
  const fallback = String(error?.message || "").trim();
  const text = raw || fallback || "yt-dlp no devolvio detalles.";
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = lines
    .filter((line) => /ERROR|Unable|not available|Sign in|ffmpeg|permission|access/i.test(line))
    .pop() || lines[lines.length - 1] || text;
  return { text, summary };
}

function timestampFromVideoId(id) {
  try {
    const seconds = Number(BigInt(String(id || "")) >> 32n);
    const now = Math.floor(Date.now() / 1000);
    if (Number.isSafeInteger(seconds) && seconds >= 946684800 && seconds <= now + 86400) return seconds;
  } catch { /* Some playlist ids are not numeric. */ }
  return null;
}

function parsePlaylistEntries(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line, position) => {
      const [idRaw, timestampRaw, uploadDateRaw] = line.trim().split("\t");
      const id = String(idRaw || "").trim();
      const timestampNumber = Number(timestampRaw);
      const uploadDate = String(uploadDateRaw || "").trim();
      const timestamp = Number.isFinite(timestampNumber) && timestampNumber > 0
        ? timestampNumber
        : timestampFromVideoId(id);
      return {
        id,
        position,
        timestamp,
        uploadDate: /^\d{8}$/.test(uploadDate) ? uploadDate : "",
      };
    })
    .filter((entry) => entry.id);
}

function comparePlaylistEntries(a, b, order = "oldest", newestFirstFallback = false) {
  let comparison = 0;
  if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
    comparison = a.timestamp - b.timestamp;
  } else if (a.uploadDate && b.uploadDate && a.uploadDate !== b.uploadDate) {
    comparison = a.uploadDate.localeCompare(b.uploadDate);
  } else if (newestFirstFallback) {
    comparison = b.position - a.position;
  } else {
    comparison = a.position - b.position;
  }
  return order === "recent" ? -comparison : comparison;
}

function sortPlaylistEntries(entries, order, newestFirstFallback = false) {
  return [...entries].sort((a, b) => comparePlaylistEntries(a, b, order, newestFirstFallback));
}

function uploadedAtForEntry(entry) {
  if (entry?.timestamp !== null && Number.isFinite(entry?.timestamp)) {
    return new Date(entry.timestamp * 1000).toISOString();
  }
  if (/^\d{8}$/.test(String(entry?.uploadDate || ""))) {
    const date = entry.uploadDate;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00.000Z`;
  }
  return "";
}

function entryIsNewerThanMarker(entry, marker, markerInListing = false) {
  if (!entry || !marker || entry.id === marker.id) return false;
  if (entry.timestamp !== null && marker.timestamp !== null) {
    if (entry.timestamp !== marker.timestamp) return entry.timestamp > marker.timestamp;
    // TikTok timestamps have second precision. When two videos share a second,
    // the profile listing order is the only available tie-breaker.
    return markerInListing
      && Number.isInteger(entry.position)
      && Number.isInteger(marker.position)
      && entry.position < marker.position;
  }
  if (entry.uploadDate && marker.uploadDate) return entry.uploadDate > marker.uploadDate;
  // TikTok normally returns profile playlists newest-first. This fallback is
  // only used when yt-dlp cannot expose a precise timestamp.
  if (markerInListing && Number.isInteger(entry.position) && Number.isInteger(marker.position)) {
    return entry.position < marker.position;
  }
  return false;
}

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

function publicationStatePath(handle) {
  const clean = String(handle || "").replace(/^@/, "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "unknown";
  return path.join(PUBLICATION_STATE_DIR, `${clean}.json`);
}

async function readPublicationState(handle) {
  const raw = await readJson(publicationStatePath(handle), {});
  return {
    handle: normalizeHandle(handle),
    baseMarkerId: String(raw.baseMarkerId || ""),
    baseMarkerUrl: String(raw.baseMarkerUrl || ""),
    lastPublishedId: String(raw.lastPublishedId || ""),
    lastPublishedUrl: String(raw.lastPublishedUrl || ""),
    lastPublishedTimestamp: Number.isFinite(Number(raw.lastPublishedTimestamp))
      ? Number(raw.lastPublishedTimestamp)
      : null,
    lastPublishedAt: raw.lastPublishedAt || null,
    failedIds: Array.isArray(raw.failedIds) ? raw.failedIds.map(String).filter(Boolean) : [],
  };
}

async function writePublicationState(handle, state) {
  await writeJson(publicationStatePath(handle), {
    ...state,
    handle: normalizeHandle(handle),
    failedIds: [...new Set((state.failedIds || []).map(String).filter(Boolean))],
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
  // [ERROR-VISIBLE] regex
  // Acepta, ademas del enlace canonico:
  //   - sin protocolo (www.tiktok.com/...)
  //   - subdominios de idioma (es.tiktok.com, m.tiktok.com...)
  const normalizado = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const match = normalizado.match(
    /^https?:\/\/(?:[a-z0-9-]+\.)?tiktok\.com\/(@[^/?#]+)\/video\/(\d+)/i
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
  // [ERROR-VISIBLE] cortos
  // vm./vt. y tambien el /t/ del boton Compartir; yt-dlp los resuelve.
  if (/^https?:\/\/(?:www\.|m\.)?tiktok\.com\/t\//i.test(value)) {
    return { url: value, username: "", id: "" };
  }
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

  // __DATE_PREFIX_FILENAMES_V2__
  // Fecha YYYY-MM-DD del video. Se lee del .info.json de yt-dlp (upload_date en
  // formato YYYYMMDD, o timestamp en segundos). El .meta.json queda de respaldo.
  async _datePrefixFor(videoPath) {
    const { getMetaPath } = require("../queue");
    const parsed = path.parse(videoPath);

    try {
      const infoPath = path.join(parsed.dir, `${parsed.name}.info.json`);
      const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
      const rawDate = String(info?.upload_date || "").trim();
      if (/^\d{8}$/.test(rawDate)) {
        return `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      }
      const epoch = Number(info?.timestamp);
      if (Number.isFinite(epoch) && epoch > 0) {
        return new Date(epoch * 1000).toISOString().slice(0, 10);
      }
    } catch {
      // Sin .info.json probamos el .meta.json.
    }

    try {
      const meta = JSON.parse(await fs.readFile(getMetaPath(videoPath), "utf8"));
      const raw = String(meta?.uploadedAt || "").trim();
      if (!raw) return "";
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
      return date.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }

  // Renombra "ID.ext" -> "YYYY-MM-DD_ID.ext" junto con sus companeros
  // (.info.json, .meta.json, portada y subtitulos). Si no hay fecha, no toca nada.
  async _renameWithDatePrefix(videoPath) {
    const datePrefix = await this._datePrefixFor(videoPath);
    if (!datePrefix) return videoPath;
    return this._renameGroup(videoPath, datePrefix);
  }

  async _renameGroup(videoPath, datePrefix) {
    const fsPromises = require("fs/promises");
    const fileExists = async (candidate) => {
      try { await fsPromises.access(candidate); return true; } catch { return false; }
    };
    const parsed = path.parse(videoPath);
    const base = parsed.name;
    if (base.startsWith(datePrefix + "_")) return videoPath;

    let newName = `${datePrefix}_${base}${parsed.ext}`;
    let suffix = 0;
    while (await fileExists(path.join(parsed.dir, newName))) {
      if (path.join(parsed.dir, newName) === videoPath) break;
      suffix += 1;
      newName = `${datePrefix}_${base} (${suffix})${parsed.ext}`;
    }

    const targetPath = path.join(parsed.dir, newName);
    if (targetPath === videoPath) return videoPath;

    const companions = [
      `${base}.info.json`,
      `${base}.meta.json`,
      `${base}.description`,
      `${base}.txt`,
    ];
    const thumbExts = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
    for (const ext of thumbExts) companions.push(`${base}${ext}`);

    const newBase = path.parse(newName).name;
    const newCompanions = [
      `${newBase}.info.json`,
      `${newBase}.meta.json`,
      `${newBase}.description`,
      `${newBase}.txt`,
    ];
    for (const ext of thumbExts) newCompanions.push(`${newBase}${ext}`);

    try {
      await fsPromises.rename(videoPath, targetPath);
    } catch {
      return videoPath;
    }
    for (let i = 0; i < companions.length; i += 1) {
      const from = path.join(parsed.dir, companions[i]);
      const to = path.join(parsed.dir, newCompanions[i]);
      try { await fsPromises.rename(from, to); } catch { /* el companero no existe */ }
    }
    return targetPath;
  }

  // Recorre una carpeta y pone la fecha delante a todos los videos con fecha.
  async renameFolderWithDates(folder) {
    const fsPromises = require("fs/promises");
    const dir = path.resolve(String(folder || ""));
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const videos = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(mp4|mov|webm|avi|mkv)$/i.test(name))
      .filter((name) => !/^\d{4}-\d{2}-\d{2}_/.test(name))
      .map((name) => path.join(dir, name));

    if (!videos.length) {
      return { folder: dir, renamed: 0, withoutDate: 0, already: true, items: [] };
    }

    let renamed = 0;
    let withoutDate = 0;
    const items = [];
    for (const videoPath of videos) {
      const before = path.basename(videoPath);
      const after = await this._renameWithDatePrefix(videoPath);
      if (after === videoPath) {
        withoutDate += 1;
        items.push({ before, after: before, changed: false });
      } else {
        renamed += 1;
        items.push({ before, after: path.basename(after), changed: true });
      }
    }
    items.sort((a, b) => a.after.localeCompare(b.after));
    return { folder: dir, renamed, withoutDate, already: false, items };
  }

  // __ORDER_BY_UPLOAD_DATE__
  // Relee cada .info.json de una carpeta y reescribe downloadIndex segun la
  // fecha real de publicacion, para arreglar carpetas ya descargadas.
  async orderFolderByDate(folder) {
    const fsPromises = require("fs/promises");
    const {
      uploadedAtFromInfoJson,
      infoJsonPathFor,
      metaJsonPathFor,
      INFO_JSON_SUFFIX,
    } = require("../video-meta");
    const { getMetaPath } = require("../queue");

    const dir = path.resolve(String(folder || ""));
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const videos = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(mp4|mov|webm|avi|mkv)$/i.test(name))
      .map((name) => path.join(dir, name));

    if (!videos.length) throw new Error("No hay videos en esa carpeta.");

    const items = [];
    for (const videoPath of videos) {
      const infoPath = infoJsonPathFor(videoPath);
      let uploadedAt = "";
      let timestamp = Infinity;
      try {
        const info = JSON.parse(await fsPromises.readFile(infoPath, "utf8"));
        uploadedAt = uploadedAtFromInfoJson(info);
        const epoch = Number(info.timestamp);
        if (Number.isFinite(epoch) && epoch > 0) timestamp = epoch;
      } catch {
        // Sin info.json este video no se puede fechar; se deja al final.
      }
      items.push({ videoPath, uploadedAt, timestamp });
    }

    const conFecha = items.filter((item) => item.uploadedAt);
    const sinFecha = items.filter((item) => !item.uploadedAt);
    conFecha.sort((a, b) => a.timestamp - b.timestamp);
    const ordered = [...conFecha, ...sinFecha.sort((a, b) => a.videoPath.localeCompare(b.videoPath))];

    for (let index = 0; index < ordered.length; index += 1) {
      const { videoPath, uploadedAt } = ordered[index];
      const metaPath = getMetaPath(videoPath);
      let meta = {};
      try { meta = JSON.parse(await fsPromises.readFile(metaPath, "utf8")); } catch { meta = {}; }
      if (!meta || typeof meta !== "object") meta = {};
      meta.downloadIndex = index;
      if (uploadedAt) meta.uploadedAt = uploadedAt;
      await writeJson(metaPath, meta);
    }

    return {
      folder: dir,
      total: ordered.length,
      withDate: conFecha.length,
      withoutDate: sinFecha.length,
      order: ordered.map((item, index) => ({
        index,
        name: path.basename(item.videoPath),
        uploadedAt: item.uploadedAt || null,
      })),
    };
  }

  /** Forget the download memory of one profile, so the next run starts over. */
  async resetHistory(handle) {
    const target = normalizeHandle(handle);
    if (!target) throw new Error("Escribe un nombre de usuario de TikTok.");
    await fs.rm(historyPath(target), { force: true }).catch(() => {});
    await fs.rm(publicationStatePath(target), { force: true }).catch(() => {});
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
// MARKER: AICFG-BRIDGE-v1
    try {
      const globalAi = require("../ai-config");
      await globalAi.load();
      const globalKeys = globalAi.publicConfig().providerKeys || {};
      const hasGlobal = Object.values(globalKeys).some((entry) => entry && entry.configured);
      if (hasGlobal) {
        const pick = (id) => (globalKeys[id] && globalKeys[id].configured ? globalAi.keyFor(id) : "");
        return {
          apiKey: pick("gemini-free"),
          paidApiKey: pick("gemini-paid"),
          paidModel: "gemini-3.6-flash",
          openRouterKey: pick("openrouter"),
          deepSeekKey: pick("deepseek"),
          xKiroKey: pick("xkiro"),
          model: "gemini-3.6-flash",
          visionModel: "gemini-3.6-flash",
          fromGlobalConfig: true,
        };
      }
    } catch { /* sin config global: usa las claves de siempre */ }

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
      xKiroKey: competitorSettings.xKiroApiKey || process.env.XKIRO_API_KEY || "", // XKR[xkiro-rotacion]
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
    * options: { username, maxVideos, uniquify, translate, minViews, destinationRoot, downloadThumbnail, downloadOrder, lastPublishedUrl, publishToDestination, publishAccountId }
   */
  async start(options = {}) {
    if (this.running) throw new Error("Ya hay una ejecucion en curso. Espera a que termine.");

    // A direct video URL takes priority: it clones exactly that one video.
    const video = parseVideoUrl(options.videoUrl);
    if (String(options.videoUrl || "").trim() && !video) {
      throw new Error("La URL del video no es valida. Pega un enlace de TikTok del tipo https://www.tiktok.com/@usuario/video/123...");
    }

    const markerUrl = String(options.lastPublishedUrl || "").trim();
    const marker = markerUrl ? parseVideoUrl(markerUrl) : null;
    const handle = video && video.username
      ? video.username
      : normalizeHandle(options.username || marker?.username);
    if (!video && !handle) {
      if (markerUrl) throw new Error("La URL del video marcador no es valida. Usa el enlace completo de TikTok.");
      throw new Error("Escribe un nombre de usuario de TikTok o pega la URL de un video.");
    }

    if (markerUrl) {
      if (video) throw new Error("El marcador necesita un perfil de origen, no una URL de video individual.");
      if (!marker?.id || !marker.username) {
        throw new Error("La URL del video marcador no es valida. Usa el enlace completo de TikTok.");
      }
      if (normalizeHandle(marker.username).toLowerCase() !== handle.toLowerCase()) {
        throw new Error("El video marcador debe pertenecer al mismo perfil de origen.");
      }
    }
    if (options.publishToDestination) {
      if (video) throw new Error("El modo descargar y publicar necesita un perfil de origen, no una URL de video individual.");
      if (!markerUrl) {
        throw new Error("Pega la URL completa del ultimo video ya publicado para usarlo como marcador.");
      }
      if (!String(options.publishAccountId || "").trim()) {
        throw new Error("No hay una cuenta destino de TikTok seleccionada.");
      }
    }

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
        // __ORIGINAL_DOWNLOAD_MODE__ Solo descarga: ni analisis, ni subtitulos, ni uniquify.
        downloadOnly: options.downloadOnly === true,
        lastPublishedUrl: String(options.lastPublishedUrl || "").trim(),
        publishToDestination: options.publishToDestination === true,
        publishAccountId: String(options.publishAccountId || "").trim(),
        skipAnalysis: options.skipAnalysis === true,
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
      // 0) Original-only download: no analysis, no processing. -----------
      if (job.options.downloadOnly) {
        this._report("download", "Modo solo descarga: bajando los videos originales sin modificar.", { percent: 5 });
        const originals = await this._downloadAll(job, ai);
        if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
        if (!originals.length) {
          if (!job.options.lastPublishedUrl) throw new Error("No se pudo descargar ningun video del perfil.");
          job.status = "done";
          job.finishedAt = nowIso();
          job.folder = this._userDir(job);
          await this._saveJob(job);
          this._report("done", `No hay videos nuevos posteriores al marcador.`, { percent: 100, jobId: job.id, folder: job.folder });
          return;
        }

        // __DATE_PREFIX_IN_DOWNLOAD_ONLY__ El renombrado ya ocurre en _downloadAll.
        job.status = "done";
        job.finishedAt = nowIso();
        job.folder = this._userDir(job);
        job.videos = originals.map((video) => ({ ...video, status: "done" }));
        await this._saveJob(job);
        this._report(
          "done",
          `Descarga original completada: ${job.videos.length} videos sin modificar. Guardados en ${job.folder}`,
          { percent: 100, jobId: job.id, folder: job.folder }
        );
        return;
      }

      // 1) Competitor analysis -------------------------------------------
      if (job.options.skipAnalysis) {
        this._report("analysis", "Modo manual: se omite el analisis automatico del perfil.", { percent: 12 });
      } else if (job.singleVideo) {
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
      if (!downloaded.length) {
        if (!job.options.lastPublishedUrl) throw new Error("No se pudo descargar ningun video del perfil.");
        job.status = "done";
        job.finishedAt = nowIso();
        job.folder = this._userDir(job);
        await this._saveJob(job);
        this._report("done", `No hay videos nuevos posteriores al marcador.`, { percent: 100, jobId: job.id, folder: job.folder });
        return;
      }
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
           if (job.options.publishToDestination) {
             const publication = await this._publishOutput(job, video);
             Object.assign(video, publication);
             await this._recordPublication(job, video, publication.publishStatus);
           }
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
      const processedCount = job.videos.filter((v) => v.status === "done").length;
      const publishedCount = job.videos.filter((v) => v.publishStatus === "published").length;
      const publishFailedCount = job.videos.filter((v) => v.publishStatus === "failed").length;
      const publishSummary = job.options.publishToDestination
        ? ` Publicados: ${publishedCount}; fallidos: ${publishFailedCount}.`
        : "";
      this._report("done", `Pipeline completado: ${processedCount} de ${job.videos.length} videos.${publishSummary} Guardados en ${job.folder}`, {
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
    const downloadDir = job.options.downloadOnly ? this._userDir(job) : this._downloadDir(job);
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
            xKiroKey: ai.xKiroKey,
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
// [ERROR-VISIBLE] inicio
        // Extrae la ultima linea util de stderr, que es donde yt-dlp
        // explica el motivo real (privado, no disponible, login, geo...).
        const crudo = String(error.stderr || "").trim();
        const ultimaUtil = crudo
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && /ERROR|WARNING|Unable|not available|Sign in/i.test(l))
          .pop() || crudo.split(/\r?\n/).filter(Boolean).pop() || "";
        if (crudo) {
          try {
            await fs.writeFile(
              path.join(downloadDir, "error-ytdlp.txt"),
              `URL: ${job.videoUrl}\n\n${crudo}\n`,
              "utf8",
            );
          } catch (_) { /* el diagnostico no debe romper la ejecucion */ }
        }
        const detalle = ultimaUtil ? ` - ${ultimaUtil.replace(/^ERROR:\s*/i, "")}` : "";
        throw new Error(
          `No se pudo descargar el video (codigo ${error.code || "?"}${detalle}). ` +
          `Se guardo el detalle completo en ${path.join(downloadDir, "error-ytdlp.txt")}.`
        );
// [ERROR-VISIBLE] fin
      }
    }

    const max = job.options.maxVideos;
    const startMode = job.options.startMode === "restart" ? "restart" : "continue";
    const history = startMode === "restart"
      ? { downloadedIds: [] }
      : await readHistory(job.handle);
    const publicationState = job.options.publishToDestination
      ? await readPublicationState(job.handle)
      : null;
    job.historyCount = history.downloadedIds.length;

    const cookieArgs = await this._cookieArgs();
    const listArgs = [
      "--no-warnings", ...cookieArgs, "--flat-playlist", "--skip-download",
      "--print", "%(id)s\t%(timestamp)s\t%(upload_date)s",
      job.url,
    ];

    let entries = [];
    try {
      const { stdout } = await run(ytDlp, listArgs, { timeout: 300_000 });
      entries = parsePlaylistEntries(stdout);
    } catch (error) {
      const diagnostic = ytDlpDiagnostic(error);
      throw new Error(`No se pudo listar el perfil con yt-dlp: ${diagnostic.summary}`);
    }
    if (!entries.length) throw new Error("El perfil no devolvio videos (puede ser privado o no existir).");

    const requestedMarker = job.options.lastPublishedUrl
      ? parseVideoUrl(job.options.lastPublishedUrl)
      : null;
    let stateForRun = publicationState;
    if (stateForRun) {
      const knownMarkerIds = new Set([stateForRun.baseMarkerId, stateForRun.lastPublishedId].filter(Boolean));
      const userChangedMarker = requestedMarker?.id && knownMarkerIds.size && !knownMarkerIds.has(requestedMarker.id);
      if (userChangedMarker) {
        stateForRun = {
          handle: job.handle,
          baseMarkerId: requestedMarker.id,
          baseMarkerUrl: requestedMarker.url,
          lastPublishedId: "",
          lastPublishedUrl: "",
          lastPublishedTimestamp: null,
          lastPublishedAt: null,
          failedIds: [],
        };
      } else if (!stateForRun.baseMarkerId && requestedMarker?.id) {
        stateForRun.baseMarkerId = requestedMarker.id;
        stateForRun.baseMarkerUrl = requestedMarker.url;
      }
    }
    const markerId = stateForRun?.lastPublishedId || requestedMarker?.id || "";
    const markerUrl = stateForRun?.lastPublishedUrl || requestedMarker?.url || "";
    let markerEntry = null;
    let markerInListing = false;
    if (markerId || markerUrl) {
      markerEntry = entries.find((entry) => entry.id === markerId) || null;
      markerInListing = Boolean(markerEntry);
      if (!markerEntry && stateForRun?.lastPublishedTimestamp !== null) {
        markerEntry = {
          id: markerId,
          position: -1,
          timestamp: stateForRun.lastPublishedTimestamp,
          uploadDate: "",
        };
      }
      if (!markerEntry) {
        try {
          const { stdout } = await run(ytDlp, [
            "--no-warnings", ...cookieArgs, "--skip-download", "--print",
            "%(id)s\t%(timestamp)s\t%(upload_date)s", markerUrl,
          ], { timeout: 180_000 });
          markerEntry = parsePlaylistEntries(stdout).find((entry) => entry.id === markerId) || null;
        } catch (error) {
          const diagnostic = ytDlpDiagnostic(error);
          throw new Error(`No se pudo leer la fecha del video marcador: ${diagnostic.summary}`);
        }
      }
      if (!markerEntry) {
        throw new Error("No se pudo leer el video marcador. Comprueba que la URL sea publica y completa.");
      }
    }

    const orderedEntries = sortPlaylistEntries(
      entries,
      markerEntry ? "oldest" : (job.options.downloadOrder === "recent" ? "recent" : "oldest"),
      true,
    );
    const candidateEntries = markerEntry
      ? orderedEntries.filter((entry) => entryIsNewerThanMarker(entry, markerEntry, markerInListing))
      : orderedEntries;
    const ids = candidateEntries.map((entry) => entry.id);

    // Continue where the previous run stopped: skip the ids already downloaded
    // and take the oldest new videos first. In publication mode, the persistent
    // publication marker is authoritative; only known failed ids are skipped.
    const rememberedIds = job.options.publishToDestination
      ? (stateForRun?.failedIds || [])
      : history.downloadedIds;
    job.publicationState = stateForRun;
    const rememberedSet = new Set(rememberedIds);
    const skippedByHistory = ids.filter((id) => rememberedSet.has(id));
    const selected = selectNextBatch(ids, rememberedIds, max);
    job.skippedByHistory = skippedByHistory.length;
    job.selectedVideoIds = selected;
    if (!selected.length) {
      this._report("download", markerEntry
        ? `No hay videos posteriores pendientes al marcador en ${job.handle}. Ya descargados: ${skippedByHistory.length}.`
        : `No hay videos nuevos en ${job.handle}: ya se descargaron todos (${ids.length}).`, { percent: 45 });
    } else {
      this._report("download", markerEntry
        ? `Marcador ${markerEntry.id}. Omitidos por historial: ${skippedByHistory.length}. Primer pendiente: ${selected[0]}. Descargando ${selected.length} videos de ${job.handle}, del mas antiguo al mas reciente...`
        : `Descargando ${selected.length} de ${ids.length} videos (${history.downloadedIds.length} ya descargados)...`, { percent: 15 });
    }
    job.historyTotal = entries.length;
    job.markerVideoId = markerEntry?.id || null;
    job.availableNewVideos = candidateEntries.length;

    const videos = [];
    const entryById = new Map(candidateEntries.map((entry) => [entry.id, entry]));
    for (let index = 0; index < selected.length; index += 1) {
      if (this.cancelRequested) break;
      const id = selected[index];
      let target = path.join(downloadDir, `${id}.mp4`);
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
            xKiroKey: ai.xKiroKey,
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
        await this._stampUploadedAt(target, infoJsonPathFor(target)); // __ORDER_BY_UPLOAD_DATE__
        target = await this._renameWithDatePrefix(target); // __DATE_PREFIX_FILENAMES__
        const finalStat = await fs.stat(target).catch(() => null);
        const sourceEntry = entryById.get(id);
        videos.push({
          id,
          sourcePath: target,
          sizeBytes: finalStat?.size || stat.size,
          status: "pending",
          downloadIndex: index,
          uploadedAt: uploadedAtForEntry(sourceEntry),
          sourceTimestamp: sourceEntry?.timestamp ?? null,
          hasThumbnail: Boolean(thumbnailPath),
        });
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

  async _recordPublication(job, video, status) {
    if (!job.options.publishToDestination) return;
    const state = job.publicationState || await readPublicationState(job.handle);
    if (!state.baseMarkerId && job.options.lastPublishedUrl) {
      const initial = parseVideoUrl(job.options.lastPublishedUrl);
      if (initial?.id) {
        state.baseMarkerId = initial.id;
        state.baseMarkerUrl = initial.url;
      }
    }
    if (status === "published") {
      state.lastPublishedId = video.id;
      state.lastPublishedUrl = `https://www.tiktok.com/${job.handle}/video/${video.id}`;
      state.lastPublishedTimestamp = Number.isFinite(video.sourceTimestamp) ? video.sourceTimestamp : null;
      state.lastPublishedAt = nowIso();
      state.failedIds = (state.failedIds || []).filter((id) => id !== video.id);
    } else if (status === "failed") {
      state.failedIds = [...(state.failedIds || []), video.id];
    }
    job.publicationState = state;
    job.lastPublishedId = state.lastPublishedId || null;
    job.lastPublishedUrl = state.lastPublishedUrl || null;
    job.failedPublicationIds = state.failedIds;
    await writePublicationState(job.handle, state).catch(() => {});
  }

  /** Publish one finished video to the currently selected destination account. */
  async _publishOutput(job, video) {
    const accountId = String(job.options.publishAccountId || "").trim();
    if (!accountId) {
      return { publishStatus: "failed", publishError: "No hay una cuenta destino de TikTok seleccionada." };
    }

    const { getAccountQueueDirs } = require("../account-manager");
    const { readVideoMeta, getSidecarPaths } = require("../queue");
    const { postSingleVideo } = require("../post-service");
    const dirs = getAccountQueueDirs(accountId).tiktok;
    const meta = await readVideoMeta(video.outputPath).catch(() => null);
    const caption = meta?.caption || meta?.description || "";
    this._report("publish", `Publicando el video ${video.id} en la cuenta destino...`, {});

    try {
      const result = await postSingleVideo({
        videoPath: video.outputPath,
        caption,
        source: "autoclone-manual",
        postedDir: dirs.posted,
        failedDir: dirs.failed,
        accountId,
      });
      if (result.ok) {
        return {
          publishStatus: "published",
          publishedPath: result.movedVideo || "",
        };
      }
      return {
        publishStatus: "failed",
        publishError: result.error || "TikTok no acepto el video.",
        failedPath: result.movedVideo || "",
      };
    } catch (error) {
      // uploadVideo can throw before post-service gets a chance to archive the
      // file. Keep the failed video recoverable in the destination account's
      // failed folder and let the batch continue with the next one.
      await fs.mkdir(dirs.failed, { recursive: true }).catch(() => {});
      const failedPath = path.join(dirs.failed, path.basename(video.outputPath));
      try {
        await fs.rename(video.outputPath, failedPath);
        for (const sidecar of getSidecarPaths(video.outputPath)) {
          const sidecarTarget = path.join(dirs.failed, path.basename(sidecar));
          await fs.rename(sidecar, sidecarTarget).catch(() => {});
        }
      } catch {
        // The original path is still visible in the job if archiving fails.
      }
      return { publishStatus: "failed", publishError: error.message, failedPath };
    }
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
            xKiroKey: ai.xKiroKey,
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

    const outputPath = path.join(this._outputDir(job), `${video.id}${job.options.uniquify && !job.options.downloadOnly ? "_unique" : ""}.mp4`);
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

  // __ORDER_BY_UPLOAD_DATE__
  // Copia la fecha real de publicacion del .info.json al .meta.json para que
  // la subida programada pueda ordenar de mas antiguo a mas nuevo.
  async _stampUploadedAt(videoPath, infoJsonPath) {
    try {
      const { getMetaPath } = require("../queue");
      const { uploadedAtFromInfoJson } = require("../video-meta");
      const info = JSON.parse(await fs.readFile(infoJsonPath, "utf8"));
      const uploadedAt = uploadedAtFromInfoJson(info);
      if (!uploadedAt) return;
      const metaPath = getMetaPath(videoPath);
      let meta = {};
      try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch { meta = {}; }
      if (!meta || typeof meta !== "object") meta = {};
      meta.uploadedAt = uploadedAt;
      await writeJson(metaPath, meta);
    } catch {
      // Sin info.json o sin meta no se puede fechar; no es un error fatal.
    }
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

module.exports = {
  AutoCloneController,
  getAutoCloneController,
  ROOT,
  HISTORY_DIR,
  PUBLICATION_STATE_DIR,
  normalizeHandle,
  parseVideoUrl,
  parsePlaylistEntries,
  sortPlaylistEntries,
  entryIsNewerThanMarker,
  readPublicationState,
  writePublicationState,
  writeJson,
  selectNextBatch,
  readHistory,
  writeHistory,
  historyPath,
};
