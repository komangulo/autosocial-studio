/**
 * TikTok competitor collector.
 *
 * Uses yt-dlp (the same binary the ProfileDownloader relies on) to read a
 * public profile's videos WITHOUT downloading the media, so the AI analysis is
 * grounded on real numbers instead of guesses.
 *
 * Two-phase strategy:
 *   1. Playlist listing (fast, --flat-playlist) to know the target video URLs.
 *   2. Per-video metadata (real view/like/comment counts) for a bounded sample.
 * If the heavy phase fails we still fall back to whatever the listing returned,
 * but we never silently pretend zeroed metrics are real data.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("../config");
const { ytDlpCommand } = require("../yt-dlp");

const DEFAULT_DEPTH = 24;
const MAX_DEPTH = 60;
const YTDLP_TIMEOUT_MS = 5 * 60 * 1000;

function resolveYtDlp() {
  return ytDlpCommand();
}

/** Accept "@user", "user" or a full URL and return a canonical profile URL. */
function normalizeProfile(target) {
  const value = String(target || "").trim();
  if (!value) throw new Error("Introduce un @usuario o una URL de TikTok.");
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("La URL no es válida.");
    }
    if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) throw new Error("Solo se admiten enlaces de tiktok.com.");
    const handle = extractHandle(url.pathname);
    if (handle) {
      // Canonicalize to the profile root; a /video/ URL becomes its author profile.
      return { url: `https://www.tiktok.com/@${handle}`, handle };
    }
    url.search = "";
    url.hash = "";
    return { url: url.toString().replace(/\/$/, ""), handle: "" };
  }
  const handle = value.replace(/^@/, "").replace(/[^a-zA-Z0-9._]/g, "");
  if (!handle) throw new Error("El nombre de usuario no es válido.");
  return { url: `https://www.tiktok.com/@${handle}`, handle };
}

function extractHandle(pathname) {
  const match = /\/@([^/]+)/.exec(pathname || "");
  return match ? match[1] : "";
}

function run(cmd, args, { timeout = YTDLP_TIMEOUT_MS } = {}) {
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

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function mean(values) {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function parseJsonLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeVideo(entry, fallbackUrl = "") {
  const views = safeNumber(entry.view_count);
  const likes = safeNumber(entry.like_count);
  const comments = safeNumber(entry.comment_count);
  const shares = safeNumber(entry.repost_count ?? entry.share_count);
  const duration = safeNumber(entry.duration);
  const url = entry.webpage_url || entry.url || fallbackUrl || "";
  return {
    id: String(entry.id || ""),
    url,
    title: String(entry.title || entry.description || "").slice(0, 500),
    description: String(entry.description || "").slice(0, 1000),
    durationSeconds: duration,
    views,
    likes,
    comments,
    shares,
    engagementRate: views > 0 ? Number((((likes + comments + shares) / views) * 100).toFixed(2)) : 0,
    uploadDate: entry.upload_date || "",
    timestamp: safeNumber(entry.timestamp),
    track: entry.track ? String(entry.track).slice(0, 200) : "",
    artist: entry.artist ? String(entry.artist).slice(0, 200) : "",
    hashtags: Array.isArray(entry.tags) ? entry.tags.slice(0, 30) : [],
    thumbnail: entry.thumbnail || "",
    hasMetrics: views > 0 || likes > 0 || comments > 0,
  };
}

/**
 * Phase 1: list the most recent video URLs without heavy extraction.
 * Returns { urls, profileMeta }.
 */
async function listProfileVideos(ytdlp, url, count) {
  const { stdout } = await run(ytdlp, [
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    "--playlist-end", String(count),
    url,
  ]);
  const entries = parseJsonLines(stdout);
  const urls = entries
    .map((entry) => entry.webpage_url || (entry.url && /^https?:/.test(entry.url) ? entry.url : ""))
    .filter(Boolean);
  const profileMeta = entries.find((entry) => entry.follower_count || entry.channel_follower_count) || {};
  return { urls, profileMeta, listed: entries.length };
}

/**
 * Phase 2: fetch real per-video metrics for a bounded sample.
 * Best-effort: individual failures are skipped.
 */
async function fetchVideoDetails(ytdlp, urls, { onProgress, handle } = {}) {
  const details = [];
  for (let index = 0; index < urls.length; index += 1) {
    onProgress?.("collecting", `Leyendo métricas del vídeo ${index + 1}/${urls.length} de ${handle || "perfil"}...`);
    try {
      const { stdout } = await run(ytdlp, ["--dump-json", "--no-warnings", "--skip-download", urls[index]], { timeout: 90_000 });
      const first = parseJsonLines(stdout)[0];
      if (first) details.push(first);
    } catch {
      // Skip videos that fail; a smaller real sample beats a large zeroed one.
    }
  }
  return details;
}

function summarize(videos, profileMeta = {}) {
  const withViews = videos.filter((video) => video.views > 0);
  const views = withViews.map((video) => video.views);
  const engagement = withViews.map((video) => video.engagementRate).filter((value) => value > 0);
  const durations = videos.map((video) => video.durationSeconds).filter((value) => value > 0);
  const sorted = [...videos].sort((a, b) => b.views - a.views);

  const followerCount = safeNumber(profileMeta.follower_count ?? profileMeta.channel_follower_count);
  const avgViews = mean(views);
  return {
    handle: profileMeta.uploader_id || profileMeta.channel || "",
    displayName: profileMeta.uploader || profileMeta.channel || "",
    followerCount,
    videoCount: videos.length,
    videosWithMetrics: withViews.length,
    dataQuality: views.length ? "metrics" : "listing-only",
    totals: {
      views: views.reduce((sum, value) => sum + value, 0),
      likes: videos.reduce((sum, video) => sum + video.likes, 0),
      comments: videos.reduce((sum, video) => sum + video.comments, 0),
      shares: videos.reduce((sum, video) => sum + video.shares, 0),
    },
    averages: {
      views: avgViews,
      likes: mean(videos.map((video) => video.likes)),
      comments: mean(videos.map((video) => video.comments)),
      shares: mean(videos.map((video) => video.shares)),
      durationSeconds: mean(durations),
      engagementRate: engagement.length ? Number((engagement.reduce((s, v) => s + v, 0) / engagement.length).toFixed(2)) : 0,
      viewsMedian: median(views),
      durationMedian: median(durations),
    },
    postingCadence: estimateCadence(videos),
    topVideos: sorted.slice(0, 8),
    // Rough Creator Rewards estimate: eligible views usually run ~$0.40-$1.00 per 1k.
    monetizationEstimate: {
      low: Number(((avgViews / 1000) * 0.4).toFixed(2)),
      high: Number(((avgViews / 1000) * 1.0).toFixed(2)),
      note: "Estimación por vídeo en USD según rangos públicos de Creator Rewards; no es una cifra oficial.",
    },
  };
}

function estimateCadence(videos) {
  const stamps = videos
    .map((video) => video.timestamp)
    .filter((value) => value > 0)
    .sort((a, b) => b - a);
  if (stamps.length < 2) return { perWeek: null, daysCovered: 0 };
  const days = (stamps[0] - stamps[stamps.length - 1]) / 86400;
  if (days <= 0) return { perWeek: null, daysCovered: 0 };
  return { perWeek: Number(((stamps.length / days) * 7).toFixed(1)), daysCovered: Math.round(days) };
}

/**
 * Collect profile metadata and per-video stats. Does not download media.
 * @param {{ target: string, depth?: number, onProgress?: Function }} options
 */
async function collect({ target, depth = DEFAULT_DEPTH, onProgress }) {
  const { url, handle } = normalizeProfile(target);
  const count = Math.max(1, Math.min(MAX_DEPTH, Number(depth) || DEFAULT_DEPTH));
  const report = (stage, detail) => onProgress?.({ stage, detail });
  const ytdlp = resolveYtDlp();

  report("collecting", `Buscando los ${count} vídeos más recientes de ${handle || url}...`);
  let listed;
  try {
    listed = await listProfileVideos(ytdlp, url, count);
  } catch (error) {
    const stderr = String(error.stderr || error.message || "");
    if (/Unable to extract|Unsupported URL|not found|404/i.test(stderr)) {
      throw new Error(`No se pudo leer el perfil ${handle || url}. Comprueba que existe y es público.`);
    }
    throw new Error(`yt-dlp falló al leer el perfil: ${stderr.split("\n")[0] || error.message}`);
  }
  if (!listed.listed) throw new Error("yt-dlp no devolvió vídeos. El perfil puede ser privado o estar vacío.");

  report("collecting", `Obteniendo métricas reales de ${listed.urls.length} vídeos...`);
  let details = await fetchVideoDetails(ytdlp, listed.urls, { onProgress: (s, d) => report(s, d), handle: handle || url });
  if (!details.length) {
    // Fall back to the listing entries if per-video extraction was fully blocked.
    details = [];
    try {
      const { stdout } = await run(ytdlp, ["--dump-json", "--no-warnings", "--playlist-end", String(count), url]);
      details = parseJsonLines(stdout);
    } catch {
      details = [];
    }
  }

  const videos = details.map((entry, index) => normalizeVideo(entry, listed.urls[index] || ""));
  if (!videos.length) throw new Error("No se pudieron leer datos de los vídeos del perfil.");

  // Prefer profile meta found in the per-video extraction (richer than flat listing).
  const profileMeta = details.find((entry) => entry.follower_count || entry.channel_follower_count) || listed.profileMeta || details[0] || {};
  const summary = summarize(videos, profileMeta);
  summary.handle = summary.handle || handle;
  const qualityNote = summary.videosWithMetrics === 0
    ? " yt-dlp no devolvió contadores de vistas/likes; el informe se basa en títulos, duración y fechas."
    : ` Métricas reales en ${summary.videosWithMetrics}/${videos.length} vídeos.`;
  report("collected", `${videos.length} vídeos leídos.${qualityNote}`);
  return { handle: summary.handle || handle, url, videos, summary, collectedAt: new Date().toISOString() };
}

module.exports = { collect, normalizeProfile, summarize, resolveYtDlp };
