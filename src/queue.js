const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const THUMBNAIL_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
const DATE_PREFIX_PATTERNS = [
  /^(\d{4})-(\d{2})-(\d{2})(?=[ _.-]|$)/,
  /^(\d{4})(\d{2})(\d{2})(?=[ _.-]|$)/,
];

// Companion metadata file written next to each downloaded video. It carries the
// original title, description and hashtags so the publisher can reuse them.
const META_SUFFIX = ".meta.json";

function getCaptionPaths(videoPath) {
  const parsed = path.parse(videoPath);
  return [
    path.join(parsed.dir, `${parsed.name}.description`),
    path.join(parsed.dir, `${parsed.name}.txt`),
  ];
}

function getMetaPath(videoPath) {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}${META_SUFFIX}`);
}

function getThumbnailPaths(videoPath) {
  const parsed = path.parse(videoPath);
  return THUMBNAIL_EXTENSIONS.map((extension) => path.join(parsed.dir, `${parsed.name}${extension}`));
}

/** All sidecars that travel with a video (captions, metadata and optional cover). */
function getSidecarPaths(videoPath) {
  return [...getCaptionPaths(videoPath), getMetaPath(videoPath), ...getThumbnailPaths(videoPath)];
}

async function findThumbnailPath(videoPath) {
  for (const thumbnailPath of getThumbnailPaths(videoPath)) {
    try {
      await fs.access(thumbnailPath);
      return thumbnailPath;
    } catch {
      // Try the next supported image extension.
    }
  }
  return null;
}

/** Extract hashtag tokens (without the leading '#') from free text. */
function extractHashtags(text) {
  const matches = String(text || "").match(/#[\p{L}\p{N}_]+/gu) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const tag = raw.slice(1);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * SIDECAR-DESC-ONLY
 * Read the companion metadata for a video. Returns null when there is none.
 * Shape: { description, caption, downloadIndex }
 *
 * Solo se conserva la descripcion (que ya incluye los hashtags). Los campos
 * "title" y "hashtags" de sidecars antiguos se ignoran a proposito: el titulo
 * de TikTok viene truncado y los hashtags duplicarian lo que ya hay.
 */
async function readVideoMeta(videoPath) {
  try {
    const raw = await fs.readFile(getMetaPath(videoPath), "utf8");
    const data = JSON.parse(raw);
    const description = String(data.description || "").trim();
    // El caption SIEMPRE se regenera desde la description: los sidecars
    // antiguos traen un caption con el titulo truncado duplicado.
    const caption = buildCaptionFromMeta({ description });
    const downloadIndex = Number.isInteger(data.downloadIndex) ? data.downloadIndex : null;
    return { description, caption, downloadIndex };
  } catch {
    return null;
  }
}

/**
 * META-DESC-ONLY-v1
 * TikTok no tiene titulo: solo descripcion. El "title" de yt-dlp viene
 * truncado con "..." y la descripcion ya incluye el texto y los hashtags.
 * Por eso el caption es EXACTAMENTE la descripcion (sin duplicar ni anadir
 * hashtags por separado). Si no hay descripcion, cae al titulo como ultimo
 * recurso. Los parametros se aceptan por compatibilidad con las llamadas.
 */
function buildCaptionFromMeta({ title = "", description = "" } = {}) {
  const cleanDescription = String(description || "").trim();
  if (cleanDescription) return cleanDescription;
  return stripTruncation(String(title || ""));
}

/** Quita el sufijo de truncado que TikTok pone en los titulos ("..." / "…"). */
function stripTruncation(text) {
  return String(text || "").replace(/\s*(?:\.\.\.|…)\s*$/, "").trim();
}

async function readCaption(videoPath) {
  // Prefer our structured metadata file when present.
  const meta = await readVideoMeta(videoPath);
  if (meta && meta.caption) return meta.caption;

  const captionPaths = getCaptionPaths(videoPath);
  for (const cp of captionPaths) {
    try {
      const text = await fs.readFile(cp, "utf8");
      return text.trim();
    } catch {
      // try next
    }
  }
  return "";
}

function queueDateTimestamp(videoPath) {
  const name = path.basename(videoPath, path.extname(videoPath));
  const match = DATE_PREFIX_PATTERNS.map((pattern) => pattern.exec(name)).find(Boolean);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function compareQueueVideos(a, b) {
  const dateA = queueDateTimestamp(a);
  const dateB = queueDateTimestamp(b);
  if (dateA !== null && dateB === null) return -1;
  if (dateA === null && dateB !== null) return 1;
  if (dateA !== null && dateB !== null && dateA !== dateB) return dateA - dateB;
  return path.basename(a).localeCompare(path.basename(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortQueueVideos(videos) {
  const sorted = [...videos];
  sorted.sort(config.tiktokQueueDateAsc ? compareQueueVideos : (a, b) => a.localeCompare(b));
  return sorted;
}

async function listQueueVideos(queueDir) {
  const dir = queueDir || config.queueDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const videos = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));

  return sortQueueVideos(videos);
}

function pickNextVideo(videos) {
  if (videos.length === 0) {
    return null;
  }
  if (config.randomQueueOrder && !config.tiktokQueueDateAsc) {
    return videos[Math.floor(Math.random() * videos.length)];
  }
  return videos[0];
}

async function getNextQueuedItem(queueDir) {
  const videos = await listQueueVideos(queueDir);
  const videoPath = pickNextVideo(videos);
  if (!videoPath) {
    return null;
  }

  const caption = await readCaption(videoPath);
  return {
    videoPath,
    caption,
    captionPaths: getCaptionPaths(videoPath),
  };
}

module.exports = {
  readCaption,
  readVideoMeta,
  buildCaptionFromMeta,
  stripTruncation,
  extractHashtags,
  getCaptionPaths,
  getMetaPath,
  getThumbnailPaths,
  findThumbnailPath,
  getSidecarPaths,
  META_SUFFIX,
  getNextQueuedItem,
  listQueueVideos,
  queueDateTimestamp,
  compareQueueVideos,
  sortQueueVideos,
  VIDEO_EXTENSIONS,
};
