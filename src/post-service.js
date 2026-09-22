const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { getNextQueuedItem, getCaptionPaths, getSidecarPaths, findThumbnailPath } = require("./queue");
const { uploadVideo } = require("./tiktok-uploader");
const { ensureDirectories, fileExists, moveWithTimestamp } = require("./fs-utils");

async function moveCaptionsIfExists(captionPaths, targetDir) {
  const moved = [];
  for (const cp of captionPaths) {
    if (await fileExists(cp)) {
      const result = await moveFileSafely(cp, targetDir, "caption file");
      if (result) moved.push(result);
    }
  }
  return moved.length > 0 ? moved[0] : null;
}

async function moveFileSafely(sourcePath, targetDir, label) {
  try {
    return await moveWithTimestamp(sourcePath, targetDir);
  } catch (error) {
    console.error(`Could not move ${label}: ${error.message}`);
    return null;
  }
}

async function postSingleVideo({ videoPath, caption, source, postedDir, failedDir, accountId, onPhase, scheduledAt, scheduleTimezone, location, aiGenerated }) {
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
  await ensureDirectories([posted, failed]);

  const coverPath = await findThumbnailPath(videoPath);
  const result = await uploadVideo({
    videoPath,
    coverPath,
    caption,
    source,
    accountId,
    onPhase,
    scheduledAt,
    scheduleTimezone,
    location,
    aiGenerated,
    // MARKER: TIKTOK-SHARED-BROWSER-LEASE-v1
    // reuseBrowser: el lote reutiliza un solo Chrome para todos los videos,
    // en vez de abrir y cerrar uno por video (que bloqueaba el perfil).
    reuseBrowser: true,
  });
  const sidecarPaths = getSidecarPaths(videoPath);

  if (result.ok) {
    await onPhase?.("archiving");
    const movedVideo = await moveFileSafely(videoPath, posted, "posted video");
    const movedCaption = await moveCaptionsIfExists(sidecarPaths, posted);
    if (!movedVideo) {
      return {
        ok: false,
        error: "Video posted, but could not archive file from queue.",
        screenshotPath: result.screenshotPath,
      };
    }
    return { ok: true, movedVideo, movedCaption };
  }

  const movedVideo = await moveFileSafely(videoPath, failed, "failed video");
  const movedCaption = await moveCaptionsIfExists(sidecarPaths, failed);
  return {
    ok: false,
    movedVideo,
    movedCaption,
    error: result.error,
    screenshotPath: result.screenshotPath,
  };
}

async function postNextFromQueue({ source, queueDir, postedDir, failedDir, accountId } = {}) {
  const queue = queueDir || config.queueDir;
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
  await ensureDirectories([queue, posted, failed]);

  const nextItem = await getNextQueuedItem(queue);
  if (!nextItem) {
    return { ok: true, skipped: true, reason: "Queue is empty." };
  }

  return postSingleVideo({ ...nextItem, source, postedDir: posted, failedDir: failed, accountId });
}

async function postFromManualInput(videoPath, caption) {
  const resolvedPath = path.resolve(videoPath);
  await fs.access(resolvedPath);
  return postSingleVideo({
    videoPath: resolvedPath,
    caption: caption || "",
  });
}

module.exports = {
  postSingleVideo,
  postNextFromQueue,
  postFromManualInput,
};
