const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

async function ensureDirectories(dirs) {
  await Promise.all(
    dirs.map(async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    })
  );
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function withTimestampPrefix(fileName) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${fileName}`;
}

function makeShortArchivedName(fileName, maxStemLength = 64) {
  const parsed = path.parse(fileName);
  const safeStem = parsed.name.replace(/[^\w.-]/g, "_");
  const shortStem = safeStem.slice(0, maxStemLength);
  const hash = crypto
    .createHash("sha1")
    .update(fileName)
    .digest("hex")
    .slice(0, 8);
  return `${shortStem}_${hash}${parsed.ext}`;
}

async function moveWithTimestamp(sourcePath, targetDir) {
  if (!(await fileExists(sourcePath))) {
    throw new Error(`Source file no longer exists: ${sourcePath}`);
  }

  const fileName = path.basename(sourcePath);
  const archivedName = withTimestampPrefix(makeShortArchivedName(fileName));
  const targetPath = path.join(targetDir, archivedName);

  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    // Fallback path for occasional Windows rename issues.
    if (error && ["ENOENT", "EPERM", "EACCES"].includes(error.code)) {
      await fs.copyFile(sourcePath, targetPath);
      await fs.unlink(sourcePath);
    } else {
      throw error;
    }
  }

  return targetPath;
}

module.exports = {
  ensureDirectories,
  fileExists,
  moveWithTimestamp,
};
