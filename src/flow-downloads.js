const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { VIDEO_EXTENSIONS } = require("./queue");

function safeSegment(value, label) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === ".." || path.basename(segment) !== segment) {
    throw new Error(`Invalid ${label}.`);
  }
  return segment;
}

async function ensureRealDirectory(directory) {
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Flow download directory is not a real folder: ${directory}`);
  }
  return directory;
}

async function prepareFlowAccountRoot(accountId, projectRoot = config.projectRoot) {
  const root = path.resolve(projectRoot);
  const downloads = await ensureRealDirectory(path.join(root, "downloads"));
  const googleFlow = await ensureRealDirectory(path.join(downloads, "google-flow"));
  return ensureRealDirectory(path.join(googleFlow, safeSegment(accountId, "Flow account")));
}

async function prepareFlowRunDirectory(accountId, jobId, projectRoot = config.projectRoot) {
  const accountRoot = await prepareFlowAccountRoot(accountId, projectRoot);
  return ensureRealDirectory(path.join(accountRoot, safeSegment(jobId, "Flow job")));
}

function getFlowDownloadsRoot(accountId, projectRoot = config.projectRoot) {
  return path.join(path.resolve(projectRoot), "downloads", "google-flow", safeSegment(accountId, "Flow account"));
}

function getFlowRunDirectory(accountId, jobId, projectRoot = config.projectRoot) {
  return path.join(getFlowDownloadsRoot(accountId, projectRoot), safeSegment(jobId, "Flow job"));
}

async function resolveFlowDownload(accountId, jobId, fileName, projectRoot = config.projectRoot) {
  const root = await prepareFlowAccountRoot(accountId, projectRoot);
  const runDirectory = getFlowRunDirectory(accountId, jobId, projectRoot);
  const safeName = safeSegment(fileName, "Flow video name");
  if (!VIDEO_EXTENSIONS.has(path.extname(safeName).toLowerCase())) {
    throw new Error("Unsupported Flow video type.");
  }
  const candidate = path.join(runDirectory, safeName);
  const [rootStat, runStat, fileStat] = await Promise.all([
    fs.lstat(root),
    fs.lstat(runDirectory),
    fs.lstat(candidate),
  ]);
  if (rootStat.isSymbolicLink() || runStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error("Flow video not found.");
  }
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(realRoot, realCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Flow video is outside this account's download folder.");
  }
  return realCandidate;
}

async function listFlowDownloads(accountId, projectRoot = config.projectRoot) {
  const root = await prepareFlowAccountRoot(accountId, projectRoot);
  const videos = [];
  const runEntries = await fs.readdir(root, { withFileTypes: true });
  for (const runEntry of runEntries) {
    if (!runEntry.isDirectory()) continue;
    const runDirectory = path.join(root, runEntry.name);
    const fileEntries = await fs.readdir(runDirectory, { withFileTypes: true }).catch(() => []);
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(fileEntry.name).toLowerCase())) continue;
      const filePath = path.join(runDirectory, fileEntry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat || stat.size < 1024) continue;
      videos.push({
        jobId: runEntry.name,
        name: fileEntry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        relativePath: path.relative(path.resolve(projectRoot), filePath),
      });
    }
  }
  videos.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { root, videos };
}

module.exports = {
  getFlowDownloadsRoot,
  getFlowRunDirectory,
  prepareFlowAccountRoot,
  prepareFlowRunDirectory,
  resolveFlowDownload,
  listFlowDownloads,
};
