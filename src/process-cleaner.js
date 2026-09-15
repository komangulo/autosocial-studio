const { spawn } = require("child_process");

/*
 * Kill leftover media child processes (ffmpeg / ffprobe / yt-dlp) that a
 * previous run may have left behind. A dashboard crash or a hard stop can
 * orphan them, and on Windows they keep the CPU busy and may hold file locks
 * on the very videos the pipeline is trying to write.
 *
 * This is a best-effort cleanup: it never throws, and it never touches other
 * Node processes (the dashboard itself is a node.exe, so we must not match it).
 */
const MEDIA_NAMES = ["ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe"];

function listKillableNames() {
  // On non-Windows the binaries have no .exe suffix.
  if (process.platform === "win32") return MEDIA_NAMES;
  return MEDIA_NAMES.map((name) => name.replace(/\.exe$/, ""));
}

/**
 * Run a command and collect stdout. Resolves with "" when the tool is missing
 * or fails; cleanup must never break startup.
 */
function capture(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      resolve("");
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

/** Return [{ pid, name }] for every live media process. */
async function findMediaProcesses() {
  const names = listKillableNames();
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = [];

  if (process.platform === "win32") {
    // tasklist only; parsing is simple and does not need admin rights.
    const out = await capture("tasklist", ["/FO", "CSV", "/NH"]);
    for (const line of out.split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (!match) continue;
      if (!wanted.has(match[1].toLowerCase())) continue;
      found.push({ pid: Number(match[2]), name: match[1] });
    }
    return found;
  }

  const out = await capture("ps", ["-eo", "pid=,comm="]);
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const name = trimmed.slice(space + 1).trim();
    if (!wanted.has(name.toLowerCase())) continue;
    found.push({ pid, name });
  }
  return found;
}

async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const out = await capture("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return /SUCCESS|correctamente|terminated/i.test(out);
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill every leftover ffmpeg/ffprobe/yt-dlp process.
 * @returns {{killed: Array<{pid:number,name:string}>, failed: Array<{pid:number,name:string}>}}
 */
async function killMediaProcesses() {
  const killed = [];
  const failed = [];
  let processes = [];
  try {
    processes = await findMediaProcesses();
  } catch {
    return { killed, failed };
  }
  for (const proc of processes) {
    const ok = await killPid(proc.pid).catch(() => false);
    (ok ? killed : failed).push(proc);
  }
  return { killed, failed };
}

module.exports = { findMediaProcesses, killMediaProcesses, killPid, listKillableNames };
