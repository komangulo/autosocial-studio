/**
 * External tool discovery + execution for AndroidClone.
 * Never assumes a tool exists: resolves candidates per platform and reports.
 */

const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { config } = require("../config");

const IS_WIN = os.platform() === "win32";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

function which(command) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function resolveYtDlp() {
  return firstExisting([
    path.resolve(config.projectRoot, "autodownload", IS_WIN ? "yt-dlp.exe" : "yt-dlp"),
    which("yt-dlp"),
    which("yt-dlp.exe"),
  ]);
}

function resolveFfmpeg() {
  return firstExisting([
    which("ffmpeg"),
    path.resolve(config.projectRoot, "bin", IS_WIN ? "ffmpeg.exe" : "ffmpeg"),
  ]);
}

function resolveFfprobe() {
  return firstExisting([
    which("ffprobe"),
    path.resolve(config.projectRoot, "bin", IS_WIN ? "ffprobe.exe" : "ffprobe"),
  ]);
}

function resolveJava() {
  const javaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", IS_WIN ? "java.exe" : "java") : null;
  return firstExisting([javaHome, which("java")]);
}

function resolveAndroidSdk() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk") : path.join(os.homedir(), "Android", "Sdk"),
    IS_WIN ? "C:\\Android\\Sdk" : "/opt/android-sdk",
  ].filter(Boolean);
  for (const root of roots) {
    if (fs.existsSync(root)) return root;
  }
  return null;
}

function sdkManagerPath(sdkRoot) {
  if (!sdkRoot) return null;
  return firstExisting([
    path.join(sdkRoot, "cmdline-tools", "latest", "bin", IS_WIN ? "sdkmanager.bat" : "sdkmanager"),
    path.join(sdkRoot, "tools", "bin", IS_WIN ? "sdkmanager.bat" : "sdkmanager"),
  ]);
}

function adbPath(sdkRoot) {
  if (!sdkRoot) return null;
  return firstExisting([path.join(sdkRoot, "platform-tools", IS_WIN ? "adb.exe" : "adb")]);
}

/** Google's official Android CLI (agent-first, 1.0+). */
function resolveAndroidCli() {
  return firstExisting([
    which("android"),
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Android", "bin", "android.exe") : null,
  ]);
}

/** Windows package manager, used for auto-install. */
function resolveWinget() {
  if (!IS_WIN) return null;
  return which("winget");
}

/** Android Studio installed via the standard Windows path (optional). */
function resolveAndroidStudio() {
  return firstExisting([
    process.env.ANDROID_STUDIO,
    IS_WIN ? "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe" : null,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Programs", "Android Studio", "bin", "studio64.exe") : null,
  ]);
}

function run(cmd, args, { timeout = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 60 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function version(cmd, args = ["--version"]) {
  if (!cmd) return null;
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 20_000 });
    return String(stdout || stderr).trim().split("\n")[0] || "ok";
  } catch (error) {
    return null;
  }
}

async function checkDependencies() {
  const ytDlp = resolveYtDlp();
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const java = resolveJava();
  const sdkRoot = resolveAndroidSdk();
  const sdkmanager = sdkManagerPath(sdkRoot);
  const adb = adbPath(sdkRoot);
  const androidCli = resolveAndroidCli();
  const winget = resolveWinget();
  const studio = resolveAndroidStudio();

  const results = {
    ytDlp: { found: Boolean(ytDlp), path: ytDlp, version: await version(ytDlp, ["--version"]), installMethod: "descarga directa" },
    ffmpeg: { found: Boolean(ffmpeg), path: ffmpeg, version: await version(ffmpeg, ["-version"]), installMethod: "winget Gyan.FFmpeg" },
    ffprobe: { found: Boolean(ffprobe), path: ffprobe, version: await version(ffprobe, ["-version"]) },
    java: { found: Boolean(java), path: java, version: await version(java, ["-version"]), installMethod: "winget EclipseAdoptium.Temurin.17.JDK" },
    androidSdk: { found: Boolean(sdkRoot), path: sdkRoot, installMethod: "Android CLI o Android Studio" },
    androidCli: { found: Boolean(androidCli), path: androidCli, version: await version(androidCli, ["--version"]), installMethod: "winget Google.AndroidCLI" },
    androidStudio: { found: Boolean(studio), path: studio, optional: true },
    sdkmanager: { found: Boolean(sdkmanager), path: sdkmanager },
    adb: { found: Boolean(adb), path: adb },
    winget: { found: Boolean(winget), path: winget },
    platform: os.platform(),
    canIngest: Boolean(ytDlp && ffprobe),
    canFrames: Boolean(ffmpeg),
    canBuild: Boolean(java && (sdkRoot || androidCli)),
  };

  results.missing = [];
  const addMissing = (id, label) => results.missing.push({ id, label });
  if (!results.ytDlp.found) addMissing("ytDlp", "yt-dlp (descargar anuncios)");
  if (!results.ffmpeg.found) addMissing("ffmpeg", "FFmpeg (extraer fotogramas)");
  if (!results.ffprobe.found) addMissing("ffprobe", "ffprobe (medir el vídeo)");
  if (!results.java.found) addMissing("java", "JDK 17 (compilar)");
  if (!results.androidSdk.found && !results.androidCli.found) addMissing("androidSdk", "Android SDK (compilar APK)");
  results.ready = results.missing.length === 0;
  return results;
}

/**
 * Auto-install a missing dependency. Windows uses winget where possible;
 * yt-dlp (single binary) is downloaded directly. Returns a value object.
 */
async function installDependency(id, { onProgress } = {}) {
  const report = (detail) => onProgress?.({ stage: "install", detail });
  const winget = resolveWinget();

  const wingetPackages = {
    ffmpeg: "Gyan.FFmpeg",
    java: "EclipseAdoptium.Temurin.17.JDK",
    androidCli: "Google.AndroidCLI",
    androidSdk: "Google.AndroidCLI",
  };

  if (id === "ytDlp") {
    const dir = path.resolve(config.projectRoot, "autodownload");
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, IS_WIN ? "yt-dlp.exe" : "yt-dlp");
    const url = IS_WIN
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
    report("Descargando yt-dlp…");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar yt-dlp (${res.status}).`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(target, buffer);
    if (!IS_WIN) await fsp.chmod(target, 0o755).catch(() => {});
    return { ok: true, id, path: target, method: "download" };
  }

  if (id === "ffprobe") {
    // ffprobe ships with ffmpeg.
    id = "ffmpeg";
  }

  const pkg = wingetPackages[id];
  if (!pkg) throw new Error(`No hay instalación automática para "${id}".`);
  if (!winget) {
    throw new Error("No se encontró winget. Instala la dependencia a mano desde el enlace de la app.");
  }
  report(`Instalando ${pkg} con winget… (puede pedir permisos y tardar varios minutos)`);
  await run(winget, [
    "install", "--id", pkg, "--silent",
    "--accept-source-agreements", "--accept-package-agreements",
    "--disable-interactivity",
  ], { timeout: 900_000 });
  return { ok: true, id, method: "winget", package: pkg };
}

async function ensureDirs(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

module.exports = {
  IS_WIN,
  resolveYtDlp,
  resolveFfmpeg,
  resolveFfprobe,
  resolveJava,
  resolveAndroidSdk,
  resolveAndroidCli,
  resolveAndroidStudio,
  resolveWinget,
  sdkManagerPath,
  adbPath,
  which,
  run,
  checkDependencies,
  installDependency,
  ensureDirs,
};
