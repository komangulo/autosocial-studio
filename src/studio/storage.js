const fs = require("fs/promises");

const GIB = 1024 ** 3;
const MINIMUM_FREE_BYTES = 100 * GIB;
const RECOMMENDED_FREE_BYTES = 250 * GIB;

async function getStorageStatus(rootPath) {
  try {
    const stats = await fs.statfs(rootPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const freeBytes = Number(stats.bavail) * blockSize;
    const totalBytes = Number(stats.blocks) * blockSize;
    return {
      known: Number.isFinite(freeBytes) && freeBytes >= 0,
      freeBytes,
      totalBytes,
      minimumFreeBytes: MINIMUM_FREE_BYTES,
      recommendedFreeBytes: RECOMMENDED_FREE_BYTES,
      longFormReady: freeBytes >= MINIMUM_FREE_BYTES,
    };
  } catch (error) {
    return {
      known: false,
      error: error.message,
      freeBytes: null,
      totalBytes: null,
      minimumFreeBytes: MINIMUM_FREE_BYTES,
      recommendedFreeBytes: RECOMMENDED_FREE_BYTES,
      longFormReady: false,
    };
  }
}

module.exports = { getStorageStatus, MINIMUM_FREE_BYTES, RECOMMENDED_FREE_BYTES };
