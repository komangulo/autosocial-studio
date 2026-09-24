/**
 * AutoClone router — /api/autoclone/*
 */

const fs = require("fs");
const path = require("path");
const { getAutoCloneController } = require("./controller");
const scheduler = require("./scheduler");

function createAutoCloneRouter(express, context = {}) {
  const router = express.Router();
  const controller = getAutoCloneController();
  let lastSchedule = null;
  let startRun = null;

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  };

  router.get("/health", route(async (req, res) => {
    res.json({ ok: true, running: controller.running, jobId: controller.jobId });
  }));

  router.get("/xkiro", route(async (req, res) => {
    try {
      const { xKiroRotateStatus } = require("./text-overlay");
      res.json({ ok: true, ...xKiroRotateStatus() });
    } catch (error) {
      res.json({ ok: false, activo: "", indice: 0, modelos: [], error: error.message });
    }
  }));

  router.get("/modelo", route(async (req, res) => {
    try {
      const { modelActivity } = require("./text-overlay");
      res.json({ ok: true, ...modelActivity() });
    } catch (error) {
      res.json({ ok: false, modelo: "", corto: "", proveedor: "", detalle: "", historial: [], error: error.message });
    }
  }));

  router.get("/progress", route(async (req, res) => {
    res.json({ ok: true, progress: controller.getProgress(), running: controller.running });
  }));

  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (progress) => {
      try { res.write(`data: ${JSON.stringify(progress)}\n\n`); } catch { /* client gone */ }
    };
    send(controller.getProgress());
    controller.on("progress", send);
    const keepAlive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* client gone */ }
    }, 20000);
    keepAlive.unref?.();
    const cleanup = () => {
      clearInterval(keepAlive);
      controller.off("progress", send);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  router.post("/start", route(async (req, res) => {
    const {
      username, videoUrl, maxVideos, uniquify, translate, minViews, destinationRoot,
      uniquifyIntensity, uniquifyOptions, metadataLanguage, downloadThumbnail,
      downloadOrder, startMode, karaoke, lastPublishedUrl,
    } = req.body || {};
    const result = await controller.start({
      username, videoUrl, maxVideos, uniquify, translate, minViews, destinationRoot,
      uniquifyIntensity, uniquifyOptions, metadataLanguage, downloadThumbnail,
      downloadOrder, startMode, karaoke, lastPublishedUrl,
    });
    res.json({ ok: true, ...result });
  }));

  // Manual incremental mode: download videos newer than the marker and publish
  // each one to the currently selected TikTok account. No daemon is involved.
  router.post("/start-publish", route(async (req, res) => {
    if (!context.getActiveAccount) throw new Error("No hay cuentas de TikTok disponibles.");
    const active = await context.getActiveAccount();
    if (!active?.id) throw new Error("Elige una cuenta de TikTok destino en Cuentas.");
    const {
      username, lastPublishedUrl, maxVideos, destinationRoot, downloadThumbnail,
      uniquify, translate, uniquifyIntensity, uniquifyOptions, metadataLanguage, karaoke,
    } = req.body || {};
    const result = await controller.start({
      username,
      maxVideos,
      destinationRoot,
      downloadThumbnail,
      uniquify,
      translate,
      uniquifyIntensity,
      uniquifyOptions,
      metadataLanguage,
      karaoke,
      downloadOrder: "oldest",
      startMode: "continue",
      lastPublishedUrl,
      publishToDestination: true,
      publishAccountId: active.id,
      skipAnalysis: true,
    });
    res.json({
      ok: true,
      ...result,
      publishToDestination: true,
      destinationAccount: { id: active.id, name: active.name || active.username || active.id },
    });
  }));

  router.post("/start-download", route(async (req, res) => {
    const { username, videoUrl, maxVideos, destinationRoot, downloadThumbnail, downloadOrder, startMode, lastPublishedUrl } = req.body || {};
    const result = await controller.start({
      username,
      videoUrl,
      maxVideos,
      destinationRoot,
      downloadThumbnail,
      downloadOrder,
      startMode,
      lastPublishedUrl,
      downloadOnly: true,
    });
    res.json({ ok: true, ...result, downloadOnly: true });
  }));

  router.get("/history", route(async (req, res) => {
    const handle = String(req.query.username || "");
    if (!handle.trim()) throw new Error("Escribe un nombre de usuario de TikTok.");
    res.json({ ok: true, ...(await controller.getHistory(handle)) });
  }));

  router.post("/history/reset", route(async (req, res) => {
    const { username } = req.body || {};
    res.json({ ok: true, ...(await controller.resetHistory(username)) });
  }));

  router.post("/rename-by-date", route(async (req, res) => {
    const { folder } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de los videos.");
    res.json({ ok: true, ...(await controller.renameFolderWithDates(folder)) });
  }));

  router.post("/order-by-date", route(async (req, res) => {
    const { folder } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de los videos.");
    res.json({ ok: true, ...(await controller.orderFolderByDate(folder)) });
  }));

  router.post("/destination/check", route(async (req, res) => {
    const { destinationRoot, username } = req.body || {};
    res.json({ ok: true, ...(await controller.checkDestination(destinationRoot, username)) });
  }));

  router.post("/cancel", route(async (req, res) => {
    res.json({ ok: true, ...controller.cancel() });
  }));

  router.get("/jobs", route(async (req, res) => {
    res.json({ ok: true, jobs: await controller.listJobs() });
  }));

  router.get("/jobs/:id", route(async (req, res) => {
    const job = await controller.getJob(req.params.id);
    if (!job) { res.status(404).json({ ok: false, error: "Trabajo no encontrado." }); return; }
    res.json({ ok: true, job });
  }));

  router.get("/jobs/:id/videos/:videoId/file", (req, res) => {
    res.status(404).json({ ok: false, error: "Usa /download para obtener el video." });
  });

  router.get("/jobs/:id/download", route(async (req, res) => {
    const job = await controller.getJob(req.params.id);
    if (!job) { res.status(404).json({ ok: false, error: "Trabajo no encontrado." }); return; }
    const videoId = String(req.query.video || "");
    const video = (job.videos || []).find((item) => item.id === videoId) || (job.videos || [])[0];
    if (!video?.outputPath || !fs.existsSync(video.outputPath)) {
      res.status(404).json({ ok: false, error: "El video procesado no existe todavia." });
      return;
    }
    const stat = fs.statSync(video.outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(video.outputPath)}"`);
    fs.createReadStream(video.outputPath).on("error", () => res.destroy()).pipe(res);
  }));

  router.post("/schedule/list", route(async (req, res) => {
    const { folder } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de salida de los videos.");
    const videos = await scheduler.listVideos(folder);
    const { readVideoMeta } = require("../queue");
    const items = [];
    let withMeta = 0;
    for (const videoPath of videos) {
      const meta = await readVideoMeta(videoPath);
      if (meta) withMeta += 1;
      items.push({
        name: path.basename(videoPath),
        hasMeta: Boolean(meta),
        title: meta?.description || "",
        description: meta?.description || "",
      });
    }
    res.json({ ok: true, folder: path.resolve(folder), videos: items.map((item) => item.name), items, withMeta });
  }));

  router.post("/schedule/preview", route(async (req, res) => {
    const { folder, days, times, maxPerRun, hashtags, location } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de salida de los videos.");
    const videos = await scheduler.listVideos(folder);
    if (!videos.length) throw new Error("No hay videos en la carpeta elegida.");
    const limited = maxPerRun > 0 ? videos.slice(0, maxPerRun) : videos;
    const { config } = require("../config");
    const timezone = req.body?.timezone || config.timezone || "UTC";
    const slots = scheduler.nextSlots({ days, times, timezone, count: limited.length });
    res.json({
      ok: true,
      timezone,
      total: videos.length,
      selected: limited.length,
      hashtags: scheduler.normalizeHashtags(hashtags || []),
      location: String(location || "").trim(),
      plan: scheduler.buildPlan(limited, slots).map((item) => ({ videoName: item.videoName, local: item.local, at: item.at })),
    });
  }));

  router.post("/schedule", route(async (req, res) => {
    const { folder, days, times, maxPerRun, timezone, captionTemplate, hashtags, location, aiGenerated } = req.body || {};
    if (!context.getActiveAccount || !context.worker) throw new Error("El programador de TikTok no esta disponible.");
    const active = await context.getActiveAccount();
    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");
    const result = await scheduler.scheduleFolder({
      accountId: active.id,
      folder,
      days,
      times,
      maxPerRun: Number(maxPerRun) || 0,
      timezone,
      captionTemplate,
      hashtags,
      location,
      aiGenerated,
      worker: context.worker,
    });
    lastSchedule = { at: new Date().toISOString(), ...result, accountId: active.id };
    res.json({ ok: true, ...result, accountId: active.id });
  }));

  router.get("/schedule/status", route(async (req, res) => {
    res.json({ ok: true, lastSchedule, startRun });
  }));

  router.get("/schedule/log", route(async (req, res) => {
    const logPath = path.resolve(process.cwd(), "schedule-debug.log");
    let log = "";
    try { log = await fs.promises.readFile(logPath, "utf8"); } catch { log = ""; }
    res.json({ ok: true, path: logPath, log });
  }));

  router.get("/schedule/diagnostics", route(async (req, res) => {
    const root = process.cwd();
    const files = [];
    for (const entry of await fs.promises.readdir(root).catch(() => [])) {
      if (/^last-schedule-.*\.(png|html)$/.test(entry)) {
        const stat = await fs.promises.stat(path.join(root, entry)).catch(() => null);
        files.push({ name: entry, size: stat?.size || 0, modifiedAt: stat?.mtime?.toISOString() || null });
      }
    }
    res.json({ ok: true, root, files });
  }));

  router.get("/schedule/diagnostics/:name", route(async (req, res) => {
    const name = path.basename(String(req.params.name || ""));
    if (!/^last-schedule-.*\.(png|html)$/.test(name)) throw new Error("Archivo no valido.");
    const filePath = path.resolve(process.cwd(), name);
    const type = name.endsWith(".png") ? "image/png" : "text/html";
    res.setHeader("Content-Type", type);
    fs.createReadStream(filePath).on("error", () => res.status(404).end()).pipe(res);
  }));

  router.post("/schedule/start", route(async (req, res) => {
    const { folder, days, times, maxPerRun, timezone, captionTemplate, hashtags, location, aiGenerated } = req.body || {};
    if (!context.getActiveAccount || !context.worker) throw new Error("El programador de TikTok no esta disponible.");
    if (startRun?.running) throw new Error("Ya hay una programacion en marcha. Espera a que termine.");
    const active = await context.getActiveAccount();
    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");

    context.worker.clearCancellation?.();
    context.worker.start?.({ force: true });
    startRun = {
      running: true, startedAt: new Date().toISOString(), accountId: active.id,
         current: 0, total: 0, done: 0, failed: 0, lastVideoName: null,
       lastScheduledAt: null, sentDir: null, failedDir: null, error: null, cancelled: false, finishedAt: null,
    };

    const run = startRun;
    void (async () => {
      try {
        const result = await scheduler.scheduleFolder({
          accountId: active.id,
          folder,
          days,
          times,
          maxPerRun: Number(maxPerRun) || 0,
          timezone,
          captionTemplate,
          hashtags,
          location,
           aiGenerated,
           worker: context.worker,
           deferArchive: true,
           onProgress: (progress) => {
            run.current = progress.current || run.current;
            run.total = progress.total || run.total;
            if (progress.videoName) run.lastVideoName = progress.videoName;
            if (progress.label) run.lastScheduledAt = progress.label;
            if (progress.error) run.failed += 1;
          },
        });
        lastSchedule = { at: new Date().toISOString(), ...result, accountId: active.id };
        run.total = result.total || run.total;
        run.done = result.created.length;
        if (!context.worker.isCancelled?.()) {
          await context.worker.drainTikTokQueue({
            onJob: (job) => {
              run.lastVideoName = job.payload?.videoName || run.lastVideoName;
              run.lastScheduledAt = job.payload?.nativeScheduledAt || run.lastScheduledAt;
            },
          });
        }
        if (!context.worker.isCancelled?.()) {
          await scheduler.waitForScheduleJobs({
            created: result.created,
            worker: context.worker,
          });
        }
        const finalized = await scheduler.finalizeSchedule({
          accountId: active.id,
          folder,
          created: result.created,
          worker: context.worker,
        });
        run.published = finalized.published;
        run.failed = (run.failed || 0) + finalized.failed;
        run.pending = finalized.pending;
        run.sentDir = finalized.sentDir;
        run.failedDir = finalized.failedDir;
        run.lastArchivedPath = finalized.lastArchivedPath || null;
        run.cancelled = Boolean(context.worker.isCancelled?.());
        run.running = false;
        run.finishedAt = new Date().toISOString();
      } catch (error) {
        run.running = false;
        run.error = error.message;
        run.finishedAt = new Date().toISOString();
      }
    })();

    res.json({ ok: true, started: true, accountId: active.id, run });
  }));

  router.post("/schedule/stop", route(async (req, res) => {
    if (!context.worker) throw new Error("El programador de TikTok no esta disponible.");
    context.worker.stop();
    if (startRun) {
      startRun.cancelled = true;
      startRun.running = false;
      startRun.finishedAt = new Date().toISOString();
    }
    res.json({ ok: true, stopped: true, run: startRun });
  }));

  return router;
}

module.exports = { createAutoCloneRouter };
