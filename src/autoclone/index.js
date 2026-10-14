/**
 * AutoClone router — /api/autoclone/*
 */

const fs = require("fs");
const path = require("path");
const { getAutoCloneController } = require("./controller");
const scheduler = require("./scheduler");
const { getAllAccounts, hasSavedPlatformSession } = require("../account-manager");
const { closeSharedTikTokBrowser } = require("../tiktok-uploader");

const BULK_TIMES = ["09:30", "17:40", "22:20"];
const EVERY_DAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "uncertain", "cancelled"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAutoCloneRouter(express, context = {}) {
  const router = express.Router();
  const controller = getAutoCloneController();
  let lastSchedule = null;
  let startRun = null;
  let bulkRun = null;

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  };

  // PATCH-TIKTOK-ACCOUNT-FROM-REQUEST-v2
  // El frontend (web/autopost.js withAccount()) SIEMPRE envia la cuenta
  // seleccionada en el body como accountId. Antes las rutas ignoraban ese dato
  // y usaban la cuenta "activa" global (accounts-state.json), que puede estar
  // desincronizada: por eso al programar/subir salia SIEMPRE la misma cuenta
  // (p. ej. madrid-nueva-modelo) aunque la UI mostrara capybluh.
  // Prioridad: body.accountId > query.accountId > cuenta activa global.
  const resolveTikTokAccount = async (req) => {
    const candidate = String(
      (req.body && (req.body.accountId || req.body.publishAccountId)) ||
      (req.query && req.query.accountId) ||
      ""
    ).trim();
    if (candidate) {
      try {
        return await require("../account-manager").requireAccount(candidate);
      } catch (error) {
        // Cuenta invalida o borrada: seguimos con la activa, pero avisamos.
        console.warn(`resolveTikTokAccount: ${candidate} no valida (${error.message}); uso la activa.`);
      }
    }
    if (!context.getActiveAccount) return null;
    return context.getActiveAccount();
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
    const active = await resolveTikTokAccount(req);
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
    const { username, videoUrl, maxVideos, destinationRoot, downloadThumbnail, downloadOrder, startMode, lastPublishedUrl, metadataLanguage } = req.body || {};
    const result = await controller.start({
      username,
      videoUrl,
      maxVideos,
      destinationRoot,
      downloadThumbnail,
      downloadOrder,
      startMode,
      lastPublishedUrl,
      metadataLanguage,
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
    if (!context.worker) throw new Error("El programador de TikTok no esta disponible.");
    const active = await resolveTikTokAccount(req);
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
    res.json({ ok: true, lastSchedule, startRun, bulkRun });
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
    if (!context.worker) throw new Error("El programador de TikTok no esta disponible.");
    if (startRun?.running || bulkRun?.running) throw new Error("Ya hay una programacion en marcha. Espera a que termine.");
    const active = await resolveTikTokAccount(req);
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
        // PATCH-TIKTOK-HONEST-DONE
        // done = videos que ARRANCARON el proceso, no los meramente encolados.
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

  router.post("/schedule/all/start", route(async (req, res) => {
    if (!context.worker) throw new Error("El programador de TikTok no esta disponible.");
    if (startRun?.running || bulkRun?.running) throw new Error("Ya hay una programacion en marcha. Espera a que termine.");
    const settingsByAccount = req.body?.settingsByAccount;
    if (!settingsByAccount || typeof settingsByAccount !== "object" || Array.isArray(settingsByAccount)) {
      throw new Error("No se recibieron las carpetas AutoPost guardadas por cuenta.");
    }
    const timezone = String(req.body?.timezone || require("../config").config.timezone || "UTC");
    const accounts = await getAllAccounts();
    if (!accounts.length) throw new Error("No hay cuentas registradas.");

    context.worker.clearCancellation?.();
    context.worker.draining = true;
    context.worker.start?.({ force: true });
    bulkRun = {
      running: true,
      startedAt: new Date().toISOString(),
      timezone,
      totalAccounts: accounts.length,
      currentAccountId: null,
      currentVideoName: null,
      done: 0,
      failedVideos: 0,
      accounts: accounts.map((account) => ({
        accountId: account.id,
        name: account.name || account.id,
        status: "pending",
        total: 0,
        published: 0,
        error: null,
      })),
      cancelled: false,
      error: null,
      finishedAt: null,
    };

    const run = bulkRun;
    void runBulkAutoPost({ run, accounts, settingsByAccount, timezone, worker: context.worker });
    res.json({ ok: true, started: true, run });
  }));

  async function runBulkAutoPost({ run, accounts, settingsByAccount, timezone, worker }) {
    const startedAt = Date.now();
    try {
      while (worker.laneBusy?.["tiktok-publish"] && !run.cancelled && Date.now() - startedAt < 15 * 60_000) {
        await sleep(250);
      }
      if (worker.laneBusy?.["tiktok-publish"] && !run.cancelled) {
        throw new Error("Hay otra publicacion de TikTok activa y no se pudo esperar a que terminara.");
      }

      for (const account of accounts) {
        if (run.cancelled) break;
        const accountRun = run.accounts.find((item) => item.accountId === account.id);
        run.currentAccountId = account.id;
        accountRun.status = "processing";
        const settings = settingsByAccount[account.id] || {};
        const folder = String(settings.folder || settings.destination || "").trim();

        try {
          if (!folder) {
            accountRun.status = "skipped";
            accountRun.error = "No tiene una carpeta AutoPost guardada.";
            continue;
          }
          if (!(await hasSavedPlatformSession("tiktok", account.id))) {
            accountRun.status = "skipped";
            accountRun.error = "No hay una sesion de TikTok guardada.";
            continue;
          }

          const jobs = await worker.store.listJobs({ accountId: account.id, type: "tiktok-publish", limit: 500 });
          const autopostJobs = jobs.filter((job) => ["autoclone-schedule", "autoclone-bulk"].includes(job.payload?.source));
          if (autopostJobs.some((job) => ["preparing", "scheduled", "retry", "running", "cancelling"].includes(job.status))) {
            throw new Error("Tiene un job AutoPost sin terminar. Revísalo antes de iniciar otro lote.");
          }
          if (autopostJobs.some((job) => job.status === "uncertain")) {
            throw new Error("Tiene una publicación AutoPost incierta. Comprueba TikTok para evitar duplicados.");
          }

          const sourceDir = path.resolve(folder);
          const postingState = await scheduler.readPostingState(account.id, sourceDir);
          let videos = await scheduler.listVideos(sourceDir);
          if (postingState.lastPublishedName) {
            const lastIndex = videos.findIndex((filePath) => path.basename(filePath) === postingState.lastPublishedName);
            if (lastIndex >= 0) videos = videos.slice(lastIndex + 1);
          }
          const failedNames = new Set(postingState.failedNames || []);
          const completedKeys = new Set(autopostJobs
            .filter((job) => job.status !== "cancelled" && job.dedupeKey)
            .map((job) => job.dedupeKey));
          videos = videos.filter((filePath) => {
            const name = path.basename(filePath);
            return !failedNames.has(name) && !completedKeys.has(scheduler.autopostDedupeKey(account.id, sourceDir, name));
          }).slice(0, 9);
          accountRun.total = videos.length;
          run.totalVideos = (run.totalVideos || 0) + videos.length;
          if (!videos.length) {
            accountRun.status = "empty";
            accountRun.error = "No hay vídeos nuevos pendientes.";
            continue;
          }

          let lastScheduledAt = autopostJobs
            .filter((job) => job.status === "succeeded" && job.payload?.nativeScheduledAt)
            .map((job) => job.payload.nativeScheduledAt)
            .filter((value) => Number.isFinite(Date.parse(value)))
            .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
          for (const videoPath of videos) {
            if (run.cancelled) break;
            const videoName = path.basename(videoPath);
            run.currentVideoName = videoName;
            const result = await scheduler.scheduleFolder({
              accountId: account.id,
              folder: sourceDir,
              videos: [videoPath],
              days: EVERY_DAY,
              times: BULK_TIMES,
              maxPerRun: 1,
              timezone,
              after: lastScheduledAt,
              captionTemplate: String(settings.caption || ""),
              hashtags: settings.hashtags || [],
              location: settings.locationMadrid ? "Madrid, Spain" : String(settings.location || settings.locationCustom || ""),
              aiGenerated: Boolean(settings.aiGenerated),
              worker,
              deferArchive: true,
              keepInPlace: true,
            });
            const created = result.created?.[0];
            if (!created?.jobId) throw new Error(`No se pudo preparar ${videoName} para TikTok.`);
            accountRun.lastScheduledAt = created.local;

            while (worker.laneBusy?.["tiktok-publish"] && !run.cancelled) await sleep(250);
            if (run.cancelled) break;
            const drained = await worker.drainTikTokQueue({
              maxJobs: 1,
              accountId: account.id,
              jobIds: [created.jobId],
              onJob: (job) => { run.currentVideoName = job.payload?.videoName || videoName; },
            });
            const job = await worker.store.getJob(created.jobId);
            if (run.cancelled) break;
            if (drained.skipped || !job || !TERMINAL_JOB_STATUSES.has(job.status)) {
              throw new Error(`El job de ${videoName} no llegó a un resultado confirmado.`);
            }
            const finalized = await scheduler.finalizeSchedule({
              accountId: account.id,
              folder: sourceDir,
              created: [created],
              worker,
              keepInPlace: true,
            });
            if (job.status !== "succeeded" || finalized.published !== 1) {
              run.failedVideos += 1;
              throw new Error(job.status === "uncertain"
                ? `El resultado de ${videoName} es incierto. Comprueba TikTok antes de reintentar.`
                : `TikTok no confirmó ${videoName}: ${job.error || job.status}.`);
            }
            lastScheduledAt = created.at;
            accountRun.published += 1;
            run.done += 1;
          }
          if (!run.cancelled) accountRun.status = "completed";
          else accountRun.status = "stopped";
        } catch (error) {
          accountRun.status = "failed";
          accountRun.error = error.message;
        } finally {
          await closeSharedTikTokBrowser().catch(() => {});
        }
      }
    } catch (error) {
      run.error = error.message;
    } finally {
      run.currentAccountId = null;
      run.currentVideoName = null;
      run.running = false;
      run.cancelled = Boolean(run.cancelled || worker.isCancelled?.());
      run.finishedAt = new Date().toISOString();
      worker.draining = false;
    }
  }

  router.post("/schedule/stop", route(async (req, res) => {
    if (!context.worker) throw new Error("El programador de TikTok no esta disponible.");
    context.worker.stop();
    if (startRun) {
      startRun.cancelled = true;
      startRun.running = false;
      startRun.finishedAt = new Date().toISOString();
    }
    if (bulkRun) {
      bulkRun.cancelled = true;
    }
    res.json({ ok: true, stopped: true, run: startRun, bulkRun });
  }));

  return router;
}

module.exports = { createAutoCloneRouter };
