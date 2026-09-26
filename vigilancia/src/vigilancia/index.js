"use strict";

const { VigilanciaWorker, getConfig, saveConfig, getHistory } = require("./worker");
const core = require("./core");
const mailer = require("./mailer");

function createVigilanciaRouter(express, { rootDir, worker } = {}) {
  const router = express.Router();
  const w = worker || new VigilanciaWorker({ rootDir });

  const route = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  };

  router.get("/health", route(async (req, res) => {
    res.json({ ok: true, status: w.status() });
  }));

  router.get("/status", route(async (req, res) => {
    res.json({ ok: true, ...w.status() });
  }));

  router.get("/settings", route(async (req, res) => {
    const cfg = getConfig(rootDir);
    res.json({
      ok: true,
      settings: {
        enabled: cfg.enabled,
        hour: cfg.hour,
        minute: cfg.minute,
        windowHours: cfg.windowHours,
        to: cfg.email.to,
        inboxId: cfg.email.inboxId,
        hasApiKey: Boolean(cfg.email.apiKey),
      },
    });
  }));

  router.post("/settings", route(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (Number.isFinite(Number(body.hour))) patch.hour = Math.max(0, Math.min(23, Number(body.hour)));
    if (Number.isFinite(Number(body.minute))) patch.minute = Math.max(0, Math.min(59, Number(body.minute)));
    if (Number.isFinite(Number(body.windowHours))) patch.windowHours = Math.max(1, Math.min(24 * 90, Number(body.windowHours)));
    const emailPatch = {};
    if (typeof body.to === "string" && body.to.trim()) emailPatch.to = body.to.trim();
    if (typeof body.inboxId === "string" && body.inboxId.trim()) emailPatch.inboxId = body.inboxId.trim();
    if (typeof body.apiKey === "string" && body.apiKey.trim()) emailPatch.apiKey = body.apiKey.trim();
    if (Object.keys(emailPatch).length) patch.email = emailPatch;

    const saved = saveConfig(rootDir, patch);
    w.unschedule();
    if (saved.enabled) w.schedule();
    res.json({ ok: true, settings: { enabled: saved.enabled, hour: saved.hour, minute: saved.minute, windowHours: saved.windowHours, to: saved.email.to, inboxId: saved.email.inboxId, hasApiKey: Boolean(saved.email.apiKey) } });
  }));

  router.get("/history", route(async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
    res.json({ ok: true, items: getHistory(rootDir, limit) });
  }));

  // Previsualizacion del correo sin enviarlo.
  router.get("/preview", route(async (req, res) => {
    const hours = Number(req.query.windowHours) || 24;
    const result = await core.runWatch({ windowHours: hours });
    const cfg = getConfig(rootDir);
    const preview = await mailer.sendReport({ config: cfg.email, result, dryRun: true });
    res.json({ ok: true, subject: preview.subject, text: preview.text, result });
  }));

  // Comprobar ahora (envia correo).
  router.post("/run", route(async (req, res) => {
    const hours = Number(req.body && req.body.windowHours);
    const sendEmail = req.body && req.body.sendEmail === false ? false : true;
    const out = await w.runOnce({ trigger: "manual", sendEmail, windowHours: Number.isFinite(hours) ? hours : undefined });
    res.json(out.ok ? { ok: true, total: out.result.total, groups: out.result.groups, mail: out.mail } : out);
  }));

  // Prueba de correo: envia el informe aunque no haya novedades (ventana amplia).
  router.post("/test-email", route(async (req, res) => {
    const hours = Number(req.body && req.body.windowHours) || 24 * 30;
    const out = await w.runOnce({ trigger: "test", sendEmail: true, windowHours: hours });
    res.json(out.ok ? { ok: true, total: out.result.total, mail: out.mail } : out);
  }));

  return router;
}

module.exports = { createVigilanciaRouter, VigilanciaWorker };
