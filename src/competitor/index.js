const { getCompetitorController } = require("./controller");

function createCompetitorRouter(express) {
  const router = express.Router();
  const controller = getCompetitorController();

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

  router.get("/progress", route(async (req, res) => {
    res.json({ ok: true, progress: controller.getProgress() });
  }));

  router.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (progress) => res.write(`data: ${JSON.stringify(progress)}\n\n`);
    send(controller.getProgress());
    controller.on("progress", send);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      controller.off("progress", send);
    });
  });

  router.post("/analyze", route(async (req, res) => {
    const { target, depth, brand, language } = req.body || {};
    const report = await controller.analyze({ target, depth, brand, language });
    res.json({ ok: true, report });
  }));

  router.get("/reports", route(async (req, res) => {
    res.json({ ok: true, reports: await controller.listReports() });
  }));

  router.get("/reports/:id", route(async (req, res) => {
    res.json({ ok: true, report: await controller.getReport(req.params.id) });
  }));

  router.delete("/reports/:id", route(async (req, res) => {
    res.json(await controller.deleteReport(req.params.id));
  }));

  router.post("/reports/:id/master-prompt", route(async (req, res) => {
    const { brand, language } = req.body || {};
    res.json({ ok: true, report: await controller.rebuildMasterPrompt(req.params.id, { brand, language }) });
  }));

  router.get("/flow-accounts", route(async (req, res) => {
    res.json({ ok: true, accounts: await controller.listFlowAccounts() });
  }));

  router.get("/models", route(async (req, res) => {
    res.json({ ok: true, models: await controller.listModels() });
  }));

  router.post("/reports/:id/apply-to-flow", route(async (req, res) => {
    const { accountId } = req.body || {};
    res.json(await controller.applyToFlow(req.params.id, { accountId }));
  }));

  return router;
}

module.exports = { createCompetitorRouter };
