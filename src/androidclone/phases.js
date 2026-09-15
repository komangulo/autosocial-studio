/**
 * Phase 1 — Ingest: download the ad video (yt-dlp) and inspect it (ffprobe).
 * Phase 2 — Frames: extract stills with ffmpeg so Gemini can "see" the app.
 */

const fs = require("fs/promises");
const path = require("path");
const tools = require("./tools");
const { projectDir, saveProject, readSettings } = require("./store");

/** Build the yt-dlp cookie flags from saved settings. */
async function cookieArgs() {
  const settings = await readSettings();
  const cookies = settings.cookies || { mode: "none" };
  if (cookies.mode === "browser" && cookies.browser) {
    const args = ["--cookies-from-browser", cookies.browser];
    return args;
  }
  if (cookies.mode === "file" && cookies.file) {
    const exists = await fs.access(cookies.file).then(() => true).catch(() => false);
    if (exists) return ["--cookies", cookies.file];
  }
  return [];
}

async function probe(project, videoPath) {
  const ffprobe = tools.resolveFfprobe();
  if (!ffprobe) return null;
  try {
    const { stdout } = await tools.run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration,size",
      "-show_entries", "stream=width,height,avg_frame_rate,codec_type",
      "-of", "json",
      videoPath,
    ], { timeout: 60_000 });
    const data = JSON.parse(stdout);
    const videoStream = (data.streams || []).find((s) => s.codec_type === "video") || {};
    const [num, den] = String(videoStream.avg_frame_rate || "0/1").split("/").map(Number);
    return {
      durationSeconds: Number(data.format?.duration) || 0,
      sizeBytes: Number(data.format?.size) || 0,
      width: Number(videoStream.width) || 0,
      height: Number(videoStream.height) || 0,
      fps: den ? Number((num / den).toFixed(2)) : 0,
    };
  } catch {
    return null;
  }
}

/** True when the URL points straight at a media file we can fetch ourselves. */
function isDirectMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(mp4|mov|webm|m4v|mkv|avi)(\?.*)?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Download a direct media URL over plain HTTP (no yt-dlp required). */
async function downloadDirectMedia(url, target, { onProgress } = {}) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`El servidor del vídeo respondió ${res.status}.`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      if (total) onProgress?.(Math.round((received / total) * 100));
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 1024) throw new Error("La descarga quedó vacía; la URL no es un vídeo válido.");
  await fs.writeFile(target, buffer);
  return buffer.length;
}

/** Download the ad video with yt-dlp (or directly when it is a plain media URL). */
async function ingestFromUrl(project, url, { onProgress } = {}) {
  const dir = projectDir(project.id);
  const target = path.join(dir, "video.mp4");

  if (isDirectMediaUrl(url)) {
    onProgress?.({ stage: "ingest", detail: "Descargando el vídeo directamente…" });
    await downloadDirectMedia(url, target, {
      onProgress: (percent) => onProgress?.({ stage: "ingest", detail: `Descargando el vídeo… ${percent}%`, percent }),
    });
    const meta = await probe(project, target);
    project.video = { path: target, source: "direct-url", url, ...(meta || {}) };
    project.activePhase = 2;
    await saveProject(project);
    return project.video;
  }

  const ytDlp = tools.resolveYtDlp();
  if (!ytDlp) {
    throw new Error("No se encontró yt-dlp en tu equipo. Ejecuta DESCARGAR-YTDLP.bat o instálalo.");
  }
  const cookies = await cookieArgs();
  const baseArgs = [
    "--no-warnings",
    "--no-playlist",
    "-f", "mp4/bestvideo*+bestaudio/best",
    "--merge-output-format", "mp4",
    "-o", target,
    url,
  ];
  let usedCookies = cookies.length > 0;
  try {
    await tools.run(ytDlp, [...baseArgs.slice(0, 2), ...cookies, ...baseArgs.slice(2)], { timeout: 600_000 });
  } catch (error) {
    let raw = String(error.stderr || error.message || "");
    // Cookie database unavailable: many URLs still work without cookies, retry once.
    if (cookies.length && /could not find .*cookies database|Failed to decrypt|Permission denied.*cookies/i.test(raw)) {
      try {
        await tools.run(ytDlp, baseArgs, { timeout: 600_000 });
        usedCookies = false;
      } catch (retryError) {
        raw = String(retryError.stderr || retryError.message || raw);
        usedCookies = false;
      }
    }
    if (/Unsupported URL/i.test(raw)) {
      throw new Error(
        "Esta URL no contiene un vídeo descargable. Las fichas de Play Store y App Store no sirven: " +
        "sube el vídeo del anuncio o pega la URL directa del anuncio (TikTok, Instagram, X o un .mp4)."
      );
    }
    if (/Sign in to confirm|not a bot|confirm you.?re not a bot/i.test(raw)) {
      throw new Error(
        "El sitio exige una sesión (YouTube). Activa las cookies del navegador en Configuración, " +
        "o sube el vídeo a mano."
      );
    }
    if (/could not find .*cookies database|Failed to decrypt/i.test(raw)) {
      throw new Error(
        "No se pudo leer la base de datos de cookies del navegador. Cambia a 'Archivo cookies.txt' o desactiva las cookies."
      );
    }
    throw new Error(`yt-dlp falló: ${raw.split("\n").filter(Boolean).slice(-1)[0] || "error desconocido"}`);
  }

  const stat = await fs.stat(target).catch(() => null);
  const meta = stat ? await probe(project, target) : null;
  project.video = { path: target, source: "yt-dlp", url, usedCookies, ...(meta || {}) };
  project.activePhase = 2;
  await saveProject(project);
  return project.video;
}

/** Use an already-uploaded local video file. */
async function ingestFromFile(project, filePath) {
  const dir = projectDir(project.id);
  const target = path.join(dir, "video.mp4");
  const resolved = path.resolve(filePath);
  if (resolved !== path.resolve(target)) {
    await fs.copyFile(resolved, target);
  }
  const meta = await probe(project, target);
  project.video = { path: target, source: "upload", ...(meta || {}) };
  project.activePhase = 2;
  await saveProject(project);
  return project.video;
}

/** Extract frames: even 1fps by default, or scene-change keyframes. */
async function extractFrames(project, { mode = "fps", limit } = {}) {
  const ffmpeg = tools.resolveFfmpeg();
  if (!ffmpeg) throw new Error("No se encontró ffmpeg en tu equipo. Instálalo y añádelo al PATH.");
  const videoPath = project.video?.path;
  if (!videoPath) throw new Error("El proyecto no tiene vídeo. Ejecuta la fase 1 primero.");

  const maxFrames = Math.max(1, Number(limit) || 40);
  const framesDir = path.join(projectDir(project.id), "frames");
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const outputPattern = path.join(framesDir, "f%04d.jpg");
  const filters = mode === "keyframes"
    ? "select='gt(scene,0.25)',scale=768:-2"
    : `fps=1,scale=768:-2`;

  await tools.run(ffmpeg, [
    "-y",
    "-i", videoPath,
    "-vf", filters,
    "-frames:v", String(maxFrames),
    "-q:v", "4",
    outputPattern,
  ], { timeout: 300_000 });

  const names = (await fs.readdir(framesDir)).filter((n) => n.endsWith(".jpg")).sort();
  const frames = names.map((name) => path.join(framesDir, name));
  project.activePhase = 3;
  await saveProject(project);
  return { count: frames.length, framesDir, frames };
}

module.exports = { ingestFromUrl, ingestFromFile, extractFrames, probe, cookieArgs, isDirectMediaUrl };
