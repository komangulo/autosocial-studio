#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const minimumNodeMajor = 18;
const checks = [];
function addCheck(name, status, detail) { checks.push({ name, status, detail }); }
function candidates(command) {
  return process.platform === "win32" && !/\.(cmd|exe)$/i.test(command) ? [command, `${command}.cmd`, `${command}.exe`] : [command];
}
function commandWorks(command, args) {
  let result = null;
  let selected = command;
  for (const candidate of candidates(command)) {
    result = spawnSync(candidate, args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    selected = candidate;
    if (!result.error || result.error.code !== "ENOENT") break;
  }
  result = result || {};
  const locate = process.platform === "win32"
    ? spawnSync("where.exe", [selected], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-c", "command -v \"$1\"", "doctor", selected], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    output: String(result.stdout || result.stderr || "").trim().split(/\r?\n/)[0] || "",
    executable: String(locate.stdout || "").trim().split(/\r?\n/)[0] || selected,
    error: result.error,
  };
}
function hasCapability(output, name) { return new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m").test(output); }
function formatGiB(bytes) { return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`; }

function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  addCheck("Node.js", major >= minimumNodeMajor ? "ok" : "fail", `${version} at ${process.execPath} (requires >= ${minimumNodeMajor})`);
}
function checkNpm() {
  if (process.env.npm_execpath) return addCheck("npm", "ok", process.env.npm_config_user_agent || process.env.npm_execpath);
  const npm = process.platform === "win32" ? commandWorks("cmd.exe", ["/d", "/s", "/c", "npm --version"]) : commandWorks("npm", ["--version"]);
  addCheck("npm", npm.ok ? "ok" : "fail", npm.ok ? `${npm.output} at ${npm.executable}` : npm.error?.message || "not found");
}
function checkFfmpeg() {
  const ffmpeg = commandWorks(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
  addCheck("FFmpeg", ffmpeg.ok ? "ok" : "fail", ffmpeg.ok ? `${ffmpeg.output} at ${ffmpeg.executable}` : "ffmpeg not found; set FFMPEG_PATH or add it to PATH");
  const ffprobe = commandWorks(process.env.FFPROBE_PATH || "ffprobe", ["-version"]);
  addCheck("ffprobe", ffprobe.ok ? "ok" : "fail", ffprobe.ok ? `${ffprobe.output} at ${ffprobe.executable}` : "ffprobe not found; set FFPROBE_PATH or add it to PATH");
  if (!ffmpeg.ok) return;
  const encoders = commandWorks(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-encoders"]);
  const filters = commandWorks(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-filters"]);
  const muxers = commandWorks(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-muxers"]);
  const requiredEncoders = ["libx264", "aac"];
  const requiredFilters = ["scale", "crop", "eq", "colorbalance", "lut3d", "rotate", "pad", "overlay", "amix", "afade", "adelay", "loudnorm", "alimiter", "subtitles", "waveform", "vectorscope"];
  const missing = [
    ...requiredEncoders.filter((item) => !hasCapability(encoders.stdout, item)),
    ...requiredFilters.filter((item) => !hasCapability(filters.stdout, item)),
    ...(hasCapability(muxers.stdout, "mp4") ? [] : ["mp4 muxer"]),
  ];
  addCheck("Studio FFmpeg capabilities", missing.length ? "fail" : "ok", missing.length ? `missing: ${missing.join(", ")}` : `${requiredEncoders.length} encoders, ${requiredFilters.length} filters, and MP4 muxer available`);
}
function checkPlaywrightChromium() {
  try {
    const { chromium } = require("playwright");
    const executablePath = chromium.executablePath();
    if (fs.existsSync(executablePath)) return addCheck("Playwright Chromium", "ok", executablePath);
    const systemChrome = process.platform === "win32" ? null : commandWorks("google-chrome", ["--version"]);
    addCheck("Playwright Chromium", systemChrome?.ok ? "ok" : "fail", systemChrome?.ok ? `bundled browser missing; system Chrome fallback ${systemChrome.executable}` : "missing; run `npx playwright install chromium`");
  } catch (error) { addCheck("Playwright Chromium", "fail", error.message); }
}
function checkYtDlp() {
  const localExe = path.join(projectRoot, "autodownload", "yt-dlp.exe");
  if (fs.existsSync(localExe)) return addCheck("yt-dlp", "ok", localExe);
  const tool = commandWorks("yt-dlp", ["--version"]);
  addCheck("yt-dlp", tool.ok ? "ok" : "warn", tool.ok ? `${tool.output} at ${tool.executable}` : "optional; add autodownload/yt-dlp.exe for downloader features");
}
function checkEnvExample() {
  const file = path.join(projectRoot, ".env.example");
  addCheck(".env.example", fs.existsSync(file) ? "ok" : "fail", fs.existsSync(file) ? file : "missing");
}
function checkLongFormStudio() {
  try {
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.prepare("SELECT 1 AS value").get();
    database.close();
    addCheck("Long-form SQLite", "ok", `better-sqlite3 loaded for Node ABI ${process.versions.modules}`);
  } catch (error) {
    addCheck("Long-form SQLite", "fail", `${error.message}; run npm ci with the same supported Node version used to start AutoSocial`);
  }
  const bundle = path.join(projectRoot, "web", "studio-assets", "studio.js");
  addCheck("Long-form UI bundle", fs.existsSync(bundle) ? "ok" : "fail", fs.existsSync(bundle) ? bundle : "missing; run `npm run build:studio`");
  const studioRoot = path.resolve(projectRoot, process.env.STUDIO_ROOT || ".runtime/studio");
  try {
    fs.mkdirSync(studioRoot, { recursive: true });
    const probe = path.join(studioRoot, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    fs.rmSync(probe, { force: true });
    addCheck("Studio root", "ok", `${studioRoot} is writable`);
  } catch (error) { addCheck("Studio root", "fail", `${studioRoot}: ${error.message}`); }
  if (typeof fs.statfsSync === "function") {
    try {
      const stats = fs.statfsSync(studioRoot);
      const blockSize = Number(stats.bsize || stats.frsize || 0);
      const freeBytes = Number(stats.bavail) * blockSize;
      const totalBytes = Number(stats.blocks) * blockSize;
      addCheck("Long-form storage", freeBytes >= 100 * 1024 ** 3 ? "ok" : "warn", `${formatGiB(freeBytes)} free of ${formatGiB(totalBytes)} on the Studio volume; final renders require 100 GiB and 250 GiB is recommended`);
    } catch (error) { addCheck("Long-form storage", "warn", error.message); }
  }
  const speech = process.platform === "win32" ? commandWorks("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech"]) : commandWorks("espeak-ng", ["--version"]);
  addCheck("Local speech", speech.ok ? "ok" : "warn", speech.ok ? `${process.platform === "win32" ? "Windows System.Speech" : speech.output} available` : "optional local speech engine unavailable");
}

checkNode();
checkNpm();
checkFfmpeg();
checkPlaywrightChromium();
checkYtDlp();
checkEnvExample();
checkLongFormStudio();
const label = { ok: "OK", warn: "WARN", fail: "FAIL" };
for (const check of checks) console.log(`[${label[check.status]}] ${check.name}: ${check.detail}`);
const failed = checks.filter((check) => check.status === "fail");
if (failed.length) {
  console.error(`\n${failed.length} required check(s) failed.`);
  process.exit(1);
}
console.log("\nDoctor checks passed. Warnings identify optional features or final-render gates.");
