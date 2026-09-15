const fs = require("fs");
const path = require("path");
const { config } = require("./config");

/**
 * Single place that knows where yt-dlp lives. Every module should use this so
 * there is no drift between the different download pipelines.
 *
 * Resolution order:
 *   1. YTDLP_PATH env var (explicit override)
 *   2. <project>/autodownload/yt-dlp(.exe)
 *   3. <project>/bin/yt-dlp(.exe)
 *   4. <project>/yt-dlp(.exe)
 *   5. "yt-dlp" on the system PATH (last resort)
 */
function ytDlpCandidates() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "yt-dlp.exe" : "yt-dlp";
  const bare = "yt-dlp";
  const withExe = "yt-dlp.exe";
  const names = [...new Set([exe, bare, withExe])];
  const roots = [
    path.resolve(config.projectRoot, "autodownload"),
    path.resolve(config.projectRoot, "bin"),
    config.projectRoot,
  ];
  const out = [process.env.YTDLP_PATH];
  for (const root of roots) {
    for (const name of names) {
      out.push(path.resolve(root, name));
    }
  }
  return out.filter(Boolean);
}

/** Return the first existing candidate, or "" when nothing is found locally. */
function resolveYtDlp() {
  for (const candidate of ytDlpCandidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch { /* ignore */ }
  }
  return "";
}

/** True when yt-dlp is available (locally resolved or on the PATH). */
function hasYtDlp() {
  if (resolveYtDlp()) return true;
  const pathDirs = String(process.env.PATH || "").split(path.delimiter);
  const names = process.platform === "win32"
    ? ["yt-dlp.exe", "yt-dlp.cmd", "yt-dlp.bat"]
    : ["yt-dlp"];
  for (const dir of pathDirs) {
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * The command to run. Prefers the absolute path so spawn does not depend on the
 * PATH of the process that launched the dashboard. Falls back to the bare name
 * when nothing is found, so callers surface a clear ENOENT instead of failing
 * silently.
 */
function ytDlpCommand() {
  return resolveYtDlp() || (process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

module.exports = { resolveYtDlp, hasYtDlp, ytDlpCommand, ytDlpCandidates };
