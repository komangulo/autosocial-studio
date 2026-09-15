const { getHeliosController } = require("./controller");
const schema = require("./schema");

function createHeliosRouter(express) {
  const router = express.Router();
  const controller = getHeliosController();

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  };

  router.get("/health", route(async (req, res) => {
    res.json({ ok: true, ...controller.getSettings() });
  }));

  router.get("/settings", route(async (req, res) => {
    res.json({ ok: true, settings: controller.getSettings() });
  }));

  router.post("/settings", route(async (req, res) => {
    res.json({ ok: true, settings: await controller.saveSettings(req.body || {}) });
  }));

  router.get("/models", route(async (req, res) => {
    res.json({ ok: true, ...controller.getCatalog() });
  }));

  router.get("/history", route(async (req, res) => {
    res.json({ ok: true, items: controller.getHistory({ kind: req.query.kind, limit: Number(req.query.limit) || 60 }) });
  }));

  router.delete("/history/:id", route(async (req, res) => {
    res.json(await controller.deleteHistory(req.params.id));
  }));

  router.post("/history/clear", route(async (req, res) => {
    res.json(await controller.clearHistory());
  }));

  router.get("/jobs/:id", route(async (req, res) => {
    const job = controller.jobs.get(req.params.id);
    const history = controller.history.find((h) => h.id === req.params.id);
    if (!job && !history) {
      res.status(404).json({ ok: false, error: "Job not found." });
      return;
    }
    res.json({ ok: true, job: job || history, history: history || null });
  }));

  router.post("/generate", route(async (req, res) => {
    res.json({ ok: true, ...(await controller.generate(req.body || {})) });
  }));

  router.post("/save-generated", route(async (req, res) => {
    res.json(await controller.saveGenerated(req.body || {}));
  }));

  router.post("/upload", route(async (req, res) => {
    const body = req.body || {};
    if (typeof body.dataUrl === "string") {
      res.json({ ok: true, upload: await controller.saveDataUrl(body.dataUrl) });
      return;
    }
    res.json({ ok: true, upload: await controller.saveUpload(body) });
  }));

  // ---- Config value (JSON/YAML) helpers ----
  router.post("/config/parse", route(async (req, res) => {
    const body = req.body || {};
    res.json({ ok: true, config: schema.parseConfigValue(body.format, body.value) });
  }));

  router.post("/config/stringify", route(async (req, res) => {
    const body = req.body || {};
    res.json({ ok: true, value: schema.stringifyConfigValue(body.format, body.config) });
  }));

  router.get("/config/default", route(async (req, res) => {
    res.json({ ok: true, value: schema.defaultConfigValue(), example: schema.emptyProject("Example") });
  }));

  // ---- Graph projects ----
  router.get("/projects", route(async (req, res) => {
    res.json({ ok: true, projects: await controller.listProjects() });
  }));

  router.get("/projects/:id", route(async (req, res) => {
    res.json({ ok: true, project: await controller.getProject(req.params.id) });
  }));

  router.post("/projects", route(async (req, res) => {
    res.json(await controller.saveProject(req.body?.id, req.body?.project || req.body));
  }));

  router.put("/projects/:id", route(async (req, res) => {
    res.json(await controller.saveProject(req.params.id, req.body?.project || req.body));
  }));

  router.delete("/projects/:id", route(async (req, res) => {
    res.json(await controller.deleteProject(req.params.id));
  }));

  return router;
}

module.exports = { createHeliosRouter };
