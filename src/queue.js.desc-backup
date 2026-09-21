const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const THUMBNAIL_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif"];

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
 * Read the companion metadata for a video. Returns null when there is none.
 * Shape: { title, description, hashtags: string[], caption: string }
 */
async function readVideoMeta(videoPath) {
  try {
    const raw = await fs.readFile(getMetaPath(videoPath), "utf8");
    const data = JSON.parse(raw);
    const title = String(data.title || "").trim();
    const description = String(data.description || "").trim();
    const hashtags = Array.isArray(data.hashtags)
      ? data.hashtags.map((t) => String(t).replace(/^#+/, "").trim()).filter(Boolean)
      : extractHashtags(`${title} ${description}`);
    const caption = buildCaptionFromMeta({ title, description, hashtags });
    const downloadIndex = Number.isInteger(data.downloadIndex) ? data.downloadIndex : null;
    return { title, description, hashtags, caption, downloadIndex };
  } catch {
    return null;
  }
}

/** Merge title, description and hashtags into a single TikTok caption. */
function buildCaptionFromMeta({ title = "", description = "", hashtags = [] } = {}) {
  const parts = [];
  const cleanTitle = String(title || "").trim();
  const cleanDescription = String(description || "").trim();
  // Skip the title when TikTok's description already starts with it (very common).
  if (cleanTitle && !cleanDescription.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    parts.push(cleanTitle);
  }
  if (cleanDescription) parts.push(cleanDescription);

  let text = parts.join("\n").trim();
  const existing = new Set((text.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()));
  const missing = hashtags
    .map((t) => String(t || "").replace(/^#+/, "").trim())
    .filter(Boolean)
    .filter((tag) => !existing.has(`#${tag}`.toLowerCase()));
  if (missing.length) {
    text = text ? `${text} ${missing.map((t) => `#${t}`).join(" ")}` : missing.map((t) => `#${t}`).join(" ");
  }
  return text.trim();
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

async function listQueueVideos(queueDir) {
  const dir = queueDir || config.queueDir;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const videos = entries
    .filter((entry) => entry.isFile())
    .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));

  videos.sort((a, b) => a.localeCompare(b));
  return videos;
}

function pickNextVideo(videos) {
  if (videos.length === 0) {
    return null;
  }
  if (config.randomQueueOrder) {
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
  extractHashtags,
  getCaptionPaths,
  getMetaPath,
  getThumbnailPaths,
  findThumbnailPath,
  getSidecarPaths,
  META_SUFFIX,
  getNextQueuedItem,
  listQueueVideos,
  VIDEO_EXTENSIONS,
};
