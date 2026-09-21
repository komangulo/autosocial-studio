const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { config } = require("./config");
const {
  getPlatformProfileDir,
  getActiveAccount,
} = require("./account-manager");
const { listQueueVideos, readCaption, getCaptionPaths } = require("./queue");
const { ensureDirectories, moveWithTimestamp, fileExists } = require("./fs-utils");

// MARKER: TIKTOK-SINGLE-BROWSER-BATCH-v1

let batchState = {
  running: false,
  total: 0,
  done: 0,
  posted: 0,
  failed: 0,
  current: null,
  startedAt: null,
  finishedAt: null,
  results: [],
};

function getBatchState() {
  return JSON.parse(JSON.stringify(batchState));
}

async function moveCaptionSidecars(captionPaths, targetDir) {
  const moved = [];
  for (const cp of captionPaths) {
    if (!(await fileExists(cp))) continue;
    try {
      moved.push(await moveWithTimestamp(cp, targetDir));
    } catch (error) {
      console.error(`Could not move caption sidecar: ${error.message}`);
    }
  }
  return moved;
}

/**
 * Sube TODA la cola de TikTok usando UN SOLO navegador.
 *
 * - Abre Chrome una vez (perfil persistente de la cuenta).
 * - Coge los vídeos uno a uno; no empieza el siguiente hasta que el anterior
 *   devuelve succeeded/failed.
 * - Al terminar el último, cierra el navegador.
 */
async function uploadTikTokQueueInOneBrowser({
  accountId,
  queueDir,
  postedDir,
  failedDir,
  uploader,
  onProgress,
  keepBrowserOpen = false,
} = {}) {
  if (batchState.running) {
    return { ok: false, error: "Ya hay un lote de TikTok en curso." };
  }

  const account = accountId ? { id: accountId } : await getActiveAccount();
  const queue = queueDir || config.queueDir;
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
  const uploaderModule = uploader || require("./tiktok-uploader");

  await ensureDirectories([queue, posted, failed]);

  const videos = await listQueueVideos(queue);
  batchState = {
    running: true,
    total: videos.length,
    done: 0,
    posted: 0,
    failed: 0,
    current: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  if (videos.length === 0) {
    batchState.running = false;
    batchState.finishedAt = new Date().toISOString();
    return { ok: true, skipped: true, reason: "La cola está vacía.", ...getBatchState() };
  }

  const profileDir = await getPlatformProfileDir("tiktok", account.id);
  await fs.mkdir(profileDir, { recursive: true });

  let context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let page = context.pages()[0] || (await context.newPage());

  const browserIsAlive = async () => {
    try {
      return !context.pages().every((p) => p.isClosed());
    } catch {
      return false;
    }
  };

  const reopenBrowser = async () => {
    await context.close().catch(() => {});
    context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      viewport: { width: 1400, height: 1000 },
      locale: config.browserLocale,
      timezoneId: config.timezone,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    page = context.pages()[0] || (await context.newPage());
  };

  try {
    for (const videoPath of videos) {
      if (!(await browserIsAlive())) {
        console.log("El navegador se cerró; reabriendo para continuar el lote...");
        await reopenBrowser();
      }
      const name = path.basename(videoPath);
      batchState.current = name;
      const caption = await readCaption(videoPath);
      const captionPaths = getCaptionPaths(videoPath);
      let result;

      try {
        result = await uploaderModule.uploadVideo({
          videoPath,
          caption,
          source: "queue-batch",
          accountId: account.id,
          page,
          context,
          reuseBrowser: true,
        });
      } catch (error) {
        result = { ok: false, error: error.message || "Error inesperado al subir." };
      }

      if (result && result.ok) {
        const moved = await moveWithTimestamp(videoPath, posted).catch(() => null);
        await moveCaptionSidecars(captionPaths, posted);
        if (!moved) {
          await moveWithTimestamp(videoPath, failed).catch(() => null);
          batchState.failed += 1;
          batchState.results.push({
            video: name,
            ok: false,
            error: "El vídeo se publicó, pero no se pudo archivar.",
          });
        } else {
          batchState.posted += 1;
          batchState.results.push({ video: name, ok: true, archived: true });
        }
      } else {
        await moveWithTimestamp(videoPath, failed).catch(() => null);
        await moveCaptionSidecars(captionPaths, failed);
        batchState.failed += 1;
        batchState.results.push({
          video: name,
          ok: false,
          error: (result && result.error) || "Fallo desconocido.",
        });
      }

      batchState.done += 1;
      if (typeof onProgress === "function") {
        try {
          onProgress(getBatchState(), name, result);
        } catch {
          // La UI nunca debe romper el lote.
        }
      }
    }
  } finally {
    if (!keepBrowserOpen) {
      await context.close().catch(() => {});
    }
    batchState.running = false;
    batchState.current = null;
    batchState.finishedAt = new Date().toISOString();
  }

  return { ok: batchState.failed === 0, ...getBatchState() };
}

function summarizeBatch(state) {
  const s = state || batchState;
  return `${s.posted} publicados, ${s.failed} fallidos de ${s.total}.`;
}

module.exports = {
  uploadTikTokQueueInOneBrowser,
  getBatchState,
  summarizeBatch,
  _private: { moveCaptionSidecars },
};
