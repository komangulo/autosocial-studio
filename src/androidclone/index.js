/**
 * AndroidClone routes — mounted at /api/androidclone
 */

const { getAndroidCloneController } = require("./controller");
const tools = require("./tools");
const store = require("./store");

function createAndroidCloneRouter(express) {
  const router = express.Router();
  const controller = getAndroidCloneController();

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  };

  router.get("/health", route(async (req, res) => {
    res.json({ ok: true, ...(await controller.getPublicSettings()) });
  }));

  router.get("/deps", route(async (req, res) => {
    res.json({ ok: true, deps: await tools.checkDependencies() });
  }));

  router.post("/deps/install", route(async (req, res) => {
    const { id } = req.body || {};
    const controller = getAndroidCloneController();
    const onProgress = (p) => controller._report(p.stage, p.detail, { percent: 50 });
    const result = await tools.installDependency(id, { onProgress });
    res.json({ ok: true, result, deps: await tools.checkDependencies() });
  }));

  router.get("/settings", route(async (req, res) => {
    res.json({ ok: true, settings: await controller.getPublicSettings() });
  }));

  router.get("/providers", route(async (req, res) => {
    res.json({ ok: true, providers: controller.listProviders() });
  }));

  router.post("/settings", route(async (req, res) => {
    await require("./store").saveSettings(req.body || {});
    res.json({ ok: true, settings: await controller.getPublicSettings() });
  }));

  router.get("/models", route(async (req, res) => {
    res.json({ ok: true, models: await controller.listModels({ provider: req.query.provider, role: req.query.role }) });
  }));

  router.get("/progress", route(async (req, res) => {
    res.json({ ok: true, progress: controller.lastProgress });
  }));

  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (progress) => res.write(`data: ${JSON.stringify(progress)}\n\n`);
    send(controller.lastProgress);
    controller.on("progress", send);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      controller.off("progress", send);
    });
  });

  router.get("/projects", route(async (req, res) => {
    res.json({ ok: true, projects: await require("./store").listProjects() });
  }));

  router.post("/projects", route(async (req, res) => {
    const project = await controller.createProject(req.body || {});
    res.json({ ok: true, project });
  }));

  /**
   * Upload a local video file for a project. Sent as a raw body with the
   * filename in the X-Filename header, so no multipart dependency is needed.
   */
  router.post(
    "/upload",
    express.raw({ type: ["video/*", "application/octet-stream"], limit: "2gb" }),
    route(async (req, res) => {
      const filename = String(req.headers["x-filename"] || "video.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
      if (!req.body || !req.body.length) throw new Error("No se recibió ningún archivo.");
      await store.ensureRoots();
      const target = require("path").join(store.UPLOADS_DIR, `${Date.now()}-${filename}`);
      await require("fs/promises").writeFile(target, req.body);
      res.json({ ok: true, path: target, bytes: req.body.length });
    })
  );

  router.get("/projects/:id", route(async (req, res) => {
    res.json({ ok: true, project: await require("./store").getProject(req.params.id) });
  }));

  router.delete("/projects/:id", route(async (req, res) => {
    res.json(await require("./store").deleteProject(req.params.id));
  }));

  router.post("/projects/:id/ingest", route(async (req, res) => {
    res.json({ ok: true, video: await controller.ingest(req.params.id, req.body || {}) });
  }));

  router.post("/projects/:id/frames", route(async (req, res) => {
    res.json({ ok: true, ...(await controller.frames(req.params.id, req.body || {})) });
  }));

  router.post("/projects/:id/vision", route(async (req, res) => {
    res.json({ ok: true, vision: await controller.vision(req.params.id) });
  }));

  router.post("/projects/:id/plan", route(async (req, res) => {
    res.json({ ok: true, plan: await controller.plan(req.params.id, req.body || {}) });
  }));

  router.post("/projects/:id/scaffold", route(async (req, res) => {
    res.json({ ok: true, scaffold: await controller.scaffold(req.params.id) });
  }));

  router.post("/projects/:id/build", route(async (req, res) => {
    res.json({ ok: true, build: await controller.build(req.params.id) });
  }));

  router.post("/projects/:id/run", route(async (req, res) => {
    res.json({ ok: true, result: await controller.run(req.params.id) });
  }));

  router.get("/projects/:id/artifacts/:name", route(async (req, res) => {
    const filePath = await controller.readProjectArtifact(req.params.id, req.params.name);
    res.sendFile(filePath);
  }));

  return router;
}

module.exports = { createAndroidCloneRouter };
