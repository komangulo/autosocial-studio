/**
 * Extract representative still frames from competitor videos so a vision model
 * (Gemini) can study style, on-screen text, palette, framing and lighting.
 */

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const FRAME_COUNT = 4;
const FRAME_WIDTH = 480;

function run(cmd, args, { timeout = 120_000 } = {}) {
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

/** Extract up to `count` frames spread across the clip. */
async function extractFrames(videoPath, outputDir, count = FRAME_COUNT) {
  await fs.mkdir(outputDir, { recursive: true });
  const stem = path.parse(videoPath).name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const frames = [];

  let duration = 0;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    duration = Number(stdout.trim()) || 0;
  } catch {
    duration = 0;
  }

  const span = duration > 1 ? duration : 6;
  const times = Array.from({ length: count }, (_, index) => {
    const fraction = (index + 0.5) / count;
    return Math.max(0.1, Number((span * fraction).toFixed(2)));
  });

  for (let index = 0; index < times.length; index += 1) {
    const target = path.join(outputDir, `${stem}-f${index + 1}.jpg`);
    try {
      await run("ffmpeg", [
        "-y", "-ss", String(times[index]), "-i", videoPath,
        "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-1`, "-q:v", "4", target,
      ]);
      frames.push(target);
    } catch {
      // Skip frames that fail (very short clips, decode issues).
    }
  }
  return { frames, duration };
}

async function fileToBase64(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString("base64");
}

module.exports = { extractFrames, fileToBase64, FRAME_COUNT };
