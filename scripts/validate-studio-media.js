#!/usr/bin/env node
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function has(name) { return process.argv.includes(name); }
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr, elapsedMs: Date.now() - started }) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}
function rate(value) {
  const [a, b] = String(value || "0/1").split("/").map(Number);
  return b ? a / b : 0;
}

async function main() {
  const mode4k = has("--4k") || has("--soak");
  const vertical = has("--vertical");
  const duration = Number(argument("--duration", has("--soak") ? "3600" : mode4k ? "2" : "1"));
  const fps = Number(argument("--fps", "30"));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error("Duration must be between 0 and 3600 seconds.");
  if (![24, 25, 30, 50, 60].includes(fps)) throw new Error("FPS must be 24, 25, 30, 50, or 60.");
  if (duration > 60 && process.env.AUTOSOCIAL_ALLOW_LONG_SOAK !== "1") throw new Error("Long validation requires AUTOSOCIAL_ALLOW_LONG_SOAK=1.");
  const width = mode4k ? (vertical ? 2160 : 3840) : 640;
  const height = mode4k ? (vertical ? 3840 : 2160) : 360;
  const root = path.resolve(argument("--output", path.join(os.tmpdir(), `autosocial-media-check-${Date.now()}`)));
  await fsp.mkdir(root, { recursive: true });
  const output = path.join(root, `smoke-${width}x${height}-${fps}fps.mp4`);
  const ffmpegVersion = (await run("ffmpeg", ["-version"])).stdout.split(/\r?\n/)[0];
  const ffprobeVersion = (await run("ffprobe", ["-version"])).stdout.split(/\r?\n/)[0];
  const filters = `testsrc2=size=${width}x${height}:rate=${fps}:duration=${duration},drawtext=text='AutoSocial validation':x=(w-text_w)/2:y=(h-text_h)/2:fontcolor=white:fontsize=${Math.max(24, Math.round(height / 18))}`;
  const encoded = await run("ffmpeg", ["-y", "-f", "lavfi", "-i", filters, "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${duration}`, "-c:v", "libx264", "-preset", mode4k ? "ultrafast" : "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output]);
  const probeRun = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", output]);
  const probe = JSON.parse(probeRun.stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const failures = [];
  if (!video || video.width !== width || video.height !== height) failures.push("dimensions");
  if (!video || Math.abs(rate(video.avg_frame_rate) - fps) > 0.1) failures.push("fps");
  if (video?.codec_name !== "h264") failures.push("video codec");
  if (audio?.codec_name !== "aac") failures.push("audio codec");
  if (Math.abs(Number(probe.format.duration) - duration) > Math.max(0.25, 2 / fps)) failures.push("duration");
  const stat = await fsp.stat(output);
  if (!stat.isFile() || stat.size < 1024) failures.push("output size");
  const report = {
    ok: failures.length === 0,
    testedAt: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    node: process.version,
    cpu: os.cpus()[0]?.model || "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    ffmpeg: ffmpegVersion,
    ffprobe: ffprobeVersion,
    requested: { width, height, fps, durationSeconds: duration, vertical },
    output: { path: output, sizeBytes: stat.size, encodeElapsedMs: encoded.elapsedMs, probe },
    failures,
  };
  const reportPath = path.join(root, "validation-report.json");
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);
  if (!report.ok) process.exitCode = 1;
  if (!has("--keep") && !has("--output")) await fsp.rm(root, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
