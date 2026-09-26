/**
 * Auto Post scheduler for Auto Clone outputs.
 *
 * Takes a folder full of finished videos (typically the Auto Clone destination
 * folder for a user), then spreads them across chosen days of the week and
 * times of day, creating reserved TikTok publish jobs that the autonomous
 * worker picks up and publishes by driving the TikTok web UI.
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { config } = require("../config");
const { getAccountQueueDirs } = require("../account-manager");
const { VIDEO_EXTENSIONS, getCaptionPaths, getMetaPath, getThumbnailPaths, getSidecarPaths, readVideoMeta, buildCaptionFromMeta } = require("../queue");
const { fingerprintFile } = require("../file-fingerprint");

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const AUTOPOST_STATE_DIR = path.resolve(config.projectRoot, ".runtime", "autopost");

function autopostDedupeKey(accountId, folder, videoName) {
  const value = `${String(accountId || "")}\n${path.resolve(String(folder || ""))}\n${String(videoName || "")}`;
  return `autopost:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function statePath(accountId, folder) {
  const key = `${String(accountId || "")}\n${path.resolve(String(folder || ""))}`;
  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(AUTOPOST_STATE_DIR, `${digest}.json`);
}

async function readPostingState(accountId, folder) {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(accountId, folder), "utf8"));
    return {
      lastPublishedName: String(raw.lastPublishedName || ""),
      lastPublishedAt: raw.lastPublishedAt || null,
      failedNames: Array.isArray(raw.failedNames) ? raw.failedNames.map(String).filter(Boolean) : [],
    };
  } catch {
    return { lastPublishedName: "", lastPublishedAt: null, failedNames: [] };
  }
}

async function writePostingState(accountId, folder, state) {
  await fs.mkdir(AUTOPOST_STATE_DIR, { recursive: true });
  await fs.writeFile(statePath(accountId, folder), JSON.stringify({
    lastPublishedName: state.lastPublishedName || "",
    lastPublishedAt: state.lastPublishedAt || null,
    failedNames: [...new Set((state.failedNames || []).map(String).filter(Boolean))],
  }, null, 2), "utf8");
}

// __ORDER_BY_UPLOAD_DATE__
// Ordena por fecha real de publicacion (uploadedAt) cuando existe; si falta,
// usa el downloadIndex de siempre y, en ultimo lugar, el nombre del archivo.
function orderVideos(items) {
  return items.sort((a, b) => {
    const aDate = a.uploadedAt ? Date.parse(a.uploadedAt) : NaN;
    const bDate = b.uploadedAt ? Date.parse(b.uploadedAt) : NaN;
    const aHasDate = Number.isFinite(aDate);
    const bHasDate = Number.isFinite(bDate);
    if (aHasDate && bHasDate && aDate !== bDate) return aDate - bDate;
    const aHasOrder = Number.isInteger(a.downloadIndex);
    const bHasOrder = Number.isInteger(b.downloadIndex);
    if (aHasOrder && bHasOrder && a.downloadIndex !== b.downloadIndex) {
      return a.downloadIndex - b.downloadIndex;
    }
    if (aHasDate && bHasDate) return 0;
    if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
    return a.position - b.position;
  }).map((item) => item.filePath);
}

/** List video files directly inside a folder (non-recursive), sorted by name. */
async function listVideos(folder) {
  const dir = path.resolve(String(folder || ""));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const ordered = await Promise.all(files.map(async (filePath, position) => {
    const meta = await readVideoMeta(filePath);
    return {
      filePath,
      position,
      downloadIndex: meta?.downloadIndex,
      uploadedAt: meta?.uploadedAt,
    };
  }));
  return orderVideos(ordered);
}

/**
 * Compute the next `count` publication instants from a set of weekdays and
 * times, starting after `now`, in the given timezone.
 *
 * days: array of "mon".."sun" (empty = every day)
 * times: array of "HH:MM"
 */
function nextSlots({ days = [], times = [], timezone = "UTC", count = 1, now = DateTime.now() } = {}) {
  const zone = timezone || "UTC";
  const localNow = now.setZone(zone);
  const wantedDays = (days.length ? days : WEEKDAYS).map((d) => String(d).toLowerCase());
  const wantedTimes = (times.length ? times : ["12:00"])
    .map((t) => String(t).trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => {
      const [h, m] = t.split(":").map(Number);
      return { hour: Math.min(23, Math.max(0, h)), minute: Math.min(59, Math.max(0, m)), label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
    })
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  const slots = [];
  // TikTok requires at least 15 minutes of lead time, so skip slots that are
  // closer than the safety margin (20 minutes).
  const earliest = localNow.plus({ minutes: 20 });
  let dayOffset = 0;
  while (slots.length < count && dayOffset < 120) {
    const day = localNow.startOf("day").plus({ days: dayOffset });
    const dayKey = day.toFormat("ccc").toLowerCase();
    if (wantedDays.includes(dayKey)) {
      for (const time of wantedTimes) {
        const candidate = day.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
        if (candidate >= earliest) {
          slots.push({
            at: candidate.toUTC().toISO(),
            local: candidate.toFormat("yyyy-LL-dd HH:mm"),
            label: `${candidate.toFormat("ccc dd LLL HH:mm")}`,
          });
          if (slots.length === count) break;
        }
      }
    }
    dayOffset += 1;
  }
  return slots;
}

/**
 * Build a plan mapping each video to a slot, without creating jobs. Useful for
 * showing a preview in the dashboard before committing.
 */
function buildPlan(videos, slots) {
  return videos.slice(0, slots.length).map((videoPath, index) => ({
    videoPath,
    videoName: path.basename(videoPath),
    at: slots[index].at,
    local: slots[index].local,
    label: slots[index].label,
  }));
}

/**
 * Schedule videos from a folder. Handles external folders (like the Auto Clone
 * destination) by copying each video into the account's pending queue before
 * reserving it, because reservations must reference the project folder.
 *
 * options:
 *   accountId, folder, videos?, days[], times[], maxPerRun, timezone, captionTemplate
 *   worker: AutonomousWorker instance, deferArchive? (manual AutoPost run)
 *   onProgress({ current, total, videoName, at })
 */
async function scheduleFolder({ accountId, folder, videos, days, times, maxPerRun = 0, timezone, captionTemplate = "", hashtags = [], location = "", aiGenerated = false, worker, onProgress, deferArchive = false } = {}) {
  if (!worker) throw new Error("Falta el trabajador autonomo de TikTok.");
  const sourceDir = path.resolve(String(folder || ""));
  let files = Array.isArray(videos) && videos.length ? videos : await listVideos(sourceDir);
  if (!files.length) throw new Error("No hay videos en la carpeta elegida.");

  const postingState = await readPostingState(accountId, sourceDir);
  if (postingState.lastPublishedName) {
    const lastIndex = files.findIndex((filePath) => path.basename(filePath) === postingState.lastPublishedName);
    if (lastIndex >= 0) files = files.slice(lastIndex + 1);
  }
  if (postingState.failedNames.length) {
    const failed = new Set(postingState.failedNames);
    files = files.filter((filePath) => !failed.has(path.basename(filePath)));
  }
  if (maxPerRun > 0) files = files.slice(0, maxPerRun);
  if (!files.length) throw new Error("No hay videos nuevos pendientes de publicar en la carpeta.");

  const locationText = String(location || "").trim();
  const hashtagList = normalizeHashtags(hashtags);

  const dirs = getAccountQueueDirs(accountId).tiktok;
  await fs.mkdir(dirs.pending, { recursive: true });

  const timezone2 = timezone || config.timezone || "UTC";
  const slots = nextSlots({ days, times, timezone: timezone2, count: files.length });
  if (!slots.length) throw new Error("No se pudo calcular ninguna fecha futura con esos dias y horas.");

  const created = [];
  const sentDir = resolvePostedDir(sourceDir);
  for (let index = 0; index < files.length && index < slots.length; index += 1) {
    const source = path.resolve(files[index]);
    const slot = slots[index];
    const videoName = path.basename(source);
    try {
      const sourceFingerprint = await fingerprintFile(source);
      // Copy into the account pending queue so the reservation can reference it.
      const queuedName = await uniqueName(dirs.pending, videoName);
      const queuedPath = path.join(dirs.pending, queuedName);
      await fs.copyFile(source, queuedPath);
      const queuedFingerprint = await fingerprintFile(queuedPath);
      if (queuedFingerprint.sha256 !== sourceFingerprint.sha256) {
        throw new Error(`La copia preparada para TikTok no coincide con el video final (${videoName}).`);
      }
      for (const captionPath of getCaptionPaths(source)) {
        if (await exists(captionPath)) {
          const parsed = path.parse(queuedName);
          await fs.copyFile(captionPath, path.join(dirs.pending, `${parsed.name}${path.extname(captionPath)}`));
        }
      }
      // Carry the per-video metadata sidecar (title/description/hashtags).
      const metaPath = getMetaPath(source);
      if (await exists(metaPath)) {
        const parsed = path.parse(queuedName);
        await fs.copyFile(metaPath, path.join(dirs.pending, `${parsed.name}.meta.json`));
      }
      for (const thumbnailPath of getThumbnailPaths(source)) {
        if (!(await exists(thumbnailPath))) continue;
        const parsed = path.parse(queuedName);
        await fs.copyFile(thumbnailPath, path.join(dirs.pending, `${parsed.name}${path.extname(thumbnailPath)}`));
        break;
      }

      // Base caption: the video's own title+description+hashtags when available,
      // else the dashboard template.
      let caption = "";
      const videoMeta = await readVideoMeta(source);
      if (videoMeta && videoMeta.caption) {
        caption = videoMeta.caption;
      } else if (captionTemplate) {
        caption = captionTemplate
          .replace(/\{usuario\}/gi, path.basename(sourceDir))
          .replace(/\{video\}/gi, path.parse(videoName).name);
      }
      // The dashboard hashtags are always appended on top of the video's own.
      caption = appendHashtags(caption, hashtagList);

      const job = await worker.createReservedTikTokJob({
        accountId,
        sourcePath: queuedPath,
        // Run the job now; the future date is enforced by TikTok's native
        // scheduler, so the computer does not need to stay on.
        scheduledAt: new Date(),
        nativeScheduledAt: slot.at,
        nativeTimezone: timezone2,
        caption,
       location: locationText,
       aiGenerated: Boolean(aiGenerated),
       sourceFingerprint,
       dedupeKey: autopostDedupeKey(accountId, sourceDir, videoName),
       source: "autoclone-schedule",
      });

       // For the manual AutoPost button, archive the original only after the
       // worker reports whether TikTok accepted or rejected the upload.
       if (!deferArchive) await moveToSent(source, sentDir);

       created.push({ jobId: job.id, videoName, sourcePath: source, at: slot.at, local: slot.local, label: slot.label });
      await onProgress?.({ current: index + 1, total: files.length, videoName, at: slot.at, label: slot.label });
    } catch (error) {
      await onProgress?.({ current: index + 1, total: files.length, videoName, error: error.message });
    }
  }

  return { created, timezone: timezone2, total: files.length, location: locationText, hashtags: hashtagList, sentDir, deferArchive };
}

/**
 * Where to move a video once it has been sent to TikTok.
 *
 * Auto Clone keeps its output under ".../jobs/<user-id>/outputs". When the
 * chosen folder is that "outputs" folder, the "posted" folder is created next
 * to it (at the job level), e.g. ".../jobs/<user-id>/posted". Otherwise it is
 * created inside the chosen folder as "<folder>/posted".
 */
function resolvePostedDir(sourceDir) {
  const parsed = path.parse(sourceDir);
  if (parsed.base.toLowerCase() === "outputs") {
    return path.join(parsed.dir, "posted");
  }
  return path.join(sourceDir, "posted");
}

function resolveFailedDir(sourceDir) {
  const parsed = path.parse(sourceDir);
  if (parsed.base.toLowerCase() === "outputs") return path.join(parsed.dir, "failed");
  return path.join(sourceDir, "failed");
}

/**
 * Move a video and its sidecars into the "posted" folder, avoiding overwrites.
 * A failed move is non-fatal: the upload already has its own copy in the queue.
 */
async function moveToSent(videoPath, sentDir) {
  await fs.mkdir(sentDir, { recursive: true });
  const base = path.basename(videoPath);
  const existing = path.join(sentDir, base);
  if (!(await exists(videoPath)) && await exists(existing)) return existing;

  const finalName = await uniqueName(sentDir, base);
  const destination = path.join(sentDir, finalName);
  try {
    await fs.rename(videoPath, destination);
  } catch (error) {
    // A source and destination on different volumes cannot be renamed atomically.
    if (error.code !== "EXDEV") throw error;
    await fs.copyFile(videoPath, destination);
    await fs.rm(videoPath, { force: true });
  }

  const stem = path.parse(finalName).name;
  for (const sidecar of getSidecarPaths(videoPath)) {
    if (!(await exists(sidecar))) continue;
    const suffix = path.basename(sidecar).slice(path.parse(videoPath).name.length);
    const sidecarDestination = path.join(sentDir, `${stem}${suffix}`);
    try {
      await fs.rename(sidecar, sidecarDestination);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      await fs.copyFile(sidecar, sidecarDestination);
      await fs.rm(sidecar, { force: true });
    }
  }
  return destination;
}

async function moveToFailed(videoPath, failedDir) {
  try {
    await fs.mkdir(failedDir, { recursive: true });
    const base = path.basename(videoPath);
    const finalName = await uniqueName(failedDir, base);
    await fs.rename(videoPath, path.join(failedDir, finalName));
    const stem = path.parse(finalName).name;
    for (const sidecar of getSidecarPaths(videoPath)) {
      if (!(await exists(sidecar))) continue;
      const suffix = path.basename(sidecar).slice(path.parse(videoPath).name.length);
      await fs.rename(sidecar, path.join(failedDir, `${stem}${suffix}`));
    }
    return path.join(failedDir, finalName);
  } catch {
    return "";
  }
}

async function waitForScheduleJobs({ created = [], worker, timeoutMs = 900_000, pollMs = 250 } = {}) {
  const ids = created.map((item) => item.jobId).filter(Boolean);
  const terminal = new Set(["succeeded", "failed", "uncertain", "cancelled"]);
  const startedAt = Date.now();
  while (ids.length && Date.now() - startedAt < timeoutMs) {
    const jobs = await Promise.all(ids.map((id) => worker?.store?.getJob(id)));
    if (jobs.every((job) => job && terminal.has(job.status))) return jobs;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return Promise.all(ids.map((id) => worker?.store?.getJob(id)));
}

/** Archive manual AutoPost sources only after the real TikTok result exists. */
async function finalizeSchedule({ accountId, folder, created, worker } = {}) {
  const sourceDir = path.resolve(String(folder || ""));
  const state = await readPostingState(accountId, sourceDir);
  const sentDir = resolvePostedDir(sourceDir);
  const failedDir = resolveFailedDir(sourceDir);
  const result = { published: 0, failed: 0, pending: 0, sentDir, failedDir };

  for (const item of created || []) {
    const job = await worker?.store?.getJob(item.jobId);
    if (!job || !["succeeded", "failed", "uncertain", "cancelled"].includes(job.status)) {
      result.pending += 1;
      continue;
    }
    if (job.status === "succeeded") {
      const archivedPath = await moveToSent(item.sourcePath, sentDir);
      state.lastPublishedName = item.videoName;
      state.lastPublishedAt = new Date().toISOString();
      state.failedNames = (state.failedNames || []).filter((name) => name !== item.videoName);
      result.published += 1;
      result.lastArchivedPath = archivedPath;
    } else if (["failed", "uncertain"].includes(job.status)) {
      await moveToFailed(item.sourcePath, failedDir);
      state.failedNames = [...(state.failedNames || []), item.videoName];
      result.failed += 1;
    } else {
      result.pending += 1;
    }
  }
  await writePostingState(accountId, sourceDir, state);
  return result;
}

/**
 * Normalize a hashtag list: accept an array or a whitespace/comma separated
 * string, strip leading "#", drop empties and duplicates (case-insensitive).
 */
function normalizeHashtags(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const tag = String(entry || "").trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** Append hashtags to a caption, keeping them space-separated and deduped. */
function appendHashtags(caption, hashtags) {
  const base = String(caption || "").trim();
  const tags = (hashtags || [])
    .map((tag) => String(tag || "").trim().replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`);
  if (!tags.length) return base;
  const existing = new Set((base.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()));
  const missing = tags.filter((tag) => !existing.has(tag.toLowerCase()));
  if (!missing.length) return base;
  return base ? `${base} ${missing.join(" ")}` : missing.join(" ");
}

async function uniqueName(dir, desired) {
  let candidate = desired;
  let counter = 1;
  const parsed = path.parse(desired);
  while (await exists(path.join(dir, candidate))) {
    candidate = `${parsed.name}-${counter}${parsed.ext}`;
    counter += 1;
  }
  return candidate;
}

module.exports = {
  listVideos,
  orderVideos,
  nextSlots,
  buildPlan,
  scheduleFolder,
  finalizeSchedule,
  normalizeHashtags,
  appendHashtags,
  resolvePostedDir,
  resolveFailedDir,
  moveToSent,
  moveToFailed,
  waitForScheduleJobs,
  readPostingState,
  writePostingState,
  WEEKDAYS,
  uniqueName,
};
