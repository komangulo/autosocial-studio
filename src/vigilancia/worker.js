"use strict";

// Estado y programacion de la vigilancia diaria.
// - config: .runtime/vigilancia/config.json   (ajustes)
// - historial: .runtime/vigilancia/historial.jsonl (una linea por dia)

const fs = require("fs");
const path = require("path");

let cron = null;
try { cron = require("node-cron"); } catch { cron = null; }

const { runWatch } = require("./core");
const { sendReport } = require("./mailer");

const DEFAULT_CONFIG = {
  enabled: false,
  hour: 10,
  minute: 0,
  windowHours: 24,
  email: {
    apiKey: "",
    inboxId: "medicalchina@agentmail.to",
    to: "contacto.liberal.swinger@gmail.com",
  },
  filters: {
    region: "ES3 - COMUNIDAD DE MADRID",
    beneficiary: "PERSONAS FISICAS QUE NO DESARROLLAN ACTIVIDAD ECONOMICA",
    groups: ["madrid", "estado"],
  },
};

function runtimeDir(rootDir) {
  return path.join(rootDir || process.cwd(), ".runtime", "vigilancia");
}

function configPath(rootDir) {
  return path.join(runtimeDir(rootDir), "config.json");
}

function historyPath(rootDir) {
  return path.join(runtimeDir(rootDir), "historial.jsonl");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object") return { ...base };
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getConfig(rootDir) {
  const stored = readJsonIfExists(configPath(rootDir), {});
  return deepMerge(DEFAULT_CONFIG, stored);
}

function saveConfig(rootDir, patch) {
  const current = getConfig(rootDir);
  const next = deepMerge(current, patch || {});
  ensureDir(runtimeDir(rootDir));
  fs.writeFileSync(configPath(rootDir), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function getHistory(rootDir, limit = 60) {
  try {
    const raw = fs.readFileSync(historyPath(rootDir), "utf8").trim();
    if (!raw) return [];
    const lines = raw.split("\n").filter(Boolean);
    const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return items.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function appendHistory(rootDir, entry) {
  ensureDir(runtimeDir(rootDir));
  fs.appendFileSync(historyPath(rootDir), JSON.stringify(entry) + "\n", "utf8");
}

class VigilanciaWorker {
  constructor({ rootDir, logger = console } = {}) {
    this.rootDir = rootDir || process.cwd();
    this.logger = logger;
    this.cronTask = null;
    this.running = false;
    this.lastRun = null;
  }

  schedule() {
    this.unschedule();
    const cfg = getConfig(this.rootDir);
    if (!cfg.enabled) {
      this.logger.log?.("[vigilancia] programacion desactivada.");
      return null;
    }
    if (!cron) {
      this.logger.error?.("[vigilancia] falta la dependencia node-cron (npm i node-cron).");
      return null;
    }
    const expr = `${cfg.minute} ${cfg.hour} * * *`;
    if (!cron.validate(expr)) {
      this.logger.error?.(`[vigilancia] expresion cron invalida: ${expr}`);
      return null;
    }
    this.cronTask = cron.schedule(expr, () => {
      this.runOnce({ trigger: "cron" }).catch((e) => this.logger.error?.("[vigilancia] error:", e.message));
    }, { timezone: "Europe/Madrid" });
    this.logger.log?.(`[vigilancia] programada a las ${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")} (Europe/Madrid).`);
    return expr;
  }

  /**
   * Recupera la revision perdida: si hoy ya paso la hora programada y aun no
   * se ha ejecutado la revision de hoy, la lanza (con un retraso corto para no
   * bloquear el arranque del dashboard).
   */
  catchUp({ delayMs = 8000 } = {}) {
    try {
      const cfg = getConfig(this.rootDir);
      if (!cfg.enabled) return { ran: false, reason: "disabled" };

      const now = new Date();
      const target = new Date(now);
      target.setHours(cfg.hour, cfg.minute, 0, 0);
      if (now < target) return { ran: false, reason: "too-early" };

      const todayKey = now.toISOString().slice(0, 10);
      const history = getHistory(this.rootDir, 200);
      const ranToday = history.some((h) => {
        const at = String(h.at || "").slice(0, 10);
        return at === todayKey && !h.error;
      });
      if (ranToday) return { ran: false, reason: "already-ran" };

      this.logger.log?.("[vigilancia] revision de hoy pendiente; se recupera al arrancar.");
      setTimeout(() => {
        this.runOnce({ trigger: "catch-up" }).catch((e) => this.logger.error?.("[vigilancia] catch-up error:", e.message));
      }, delayMs);
      return { ran: true, reason: "scheduled", at: new Date(Date.now() + delayMs).toISOString() };
    } catch (error) {
      this.logger.error?.("[vigilancia] catchUp fallo:", error.message);
      return { ran: false, reason: error.message };
    }
  }

  unschedule() {
    if (this.cronTask) {
      try { this.cronTask.stop(); } catch {}
      this.cronTask = null;
    }
  }

  isScheduled() {
    return Boolean(this.cronTask);
  }

  /**
   * Ejecuta una vigilancia y (opcionalmente) envia el correo.
   * @param {object} opts
   * @param {string} [opts.trigger] cron | manual | test
   * @param {boolean} [opts.sendEmail=true]
   * @param {number} [opts.windowHours]
   */
  async runOnce({ trigger = "manual", sendEmail = true, windowHours, forceEmail = false } = {}) {
    if (this.running) {
      return { ok: false, error: "Ya hay una vigilancia en curso." };
    }
    this.running = true;
    const cfg = getConfig(this.rootDir);
    const hours = Number.isFinite(windowHours) ? windowHours : cfg.windowHours;
    try {
      const result = await runWatch({ windowHours: hours });
      let mail = null;
      let skipped = false;
      // Si no hay novedades, NO se envia correo (salvo que se fuerce con
      // forceEmail, que usa la prueba manual).
      const shouldEmail = sendEmail && (result.total > 0 || forceEmail);
      if (shouldEmail) {
        mail = await sendReport({ config: cfg.email, result });
      } else if (sendEmail) {
        skipped = true;
      }
      const entry = {
        at: new Date().toISOString(),
        trigger,
        windowHours: hours,
        since: result.since,
        today: result.today,
        total: result.total,
        groups: result.groups,
        skippedEmail: skipped,
        mail: mail ? { ok: true, messageId: mail.messageId, subject: mail.subject } : null,
        items: result.items,
      };
      appendHistory(this.rootDir, entry);
      this.lastRun = { at: entry.at, total: result.total, groups: result.groups };
      return { ok: true, result, mail, entry };
    } catch (error) {
      const entry = {
        at: new Date().toISOString(),
        trigger,
        windowHours: hours,
        error: error.message,
      };
      appendHistory(this.rootDir, entry);
      return { ok: false, error: error.message, entry };
    } finally {
      this.running = false;
    }
  }

  async runTest(windowHours = 24 * 30) {
    const cfg = getConfig(this.rootDir);
    const result = await runWatch({ windowHours });
    const preview = await sendReport({ config: cfg.email, result, dryRun: true });
    return { ok: true, result, preview: { subject: preview.subject, text: preview.text } };
  }

  status() {
    const cfg = getConfig(this.rootDir);
    const history = getHistory(this.rootDir, 30);
    return {
      enabled: cfg.enabled,
      hour: cfg.hour,
      minute: cfg.minute,
      windowHours: cfg.windowHours,
      to: cfg.email.to,
      inboxId: cfg.email.inboxId,
      hasApiKey: Boolean(cfg.email.apiKey),
      scheduled: this.isScheduled(),
      running: this.running,
      lastRun: history[0] || null,
      history,
    };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  runtimeDir,
  configPath,
  historyPath,
  getConfig,
  saveConfig,
  getHistory,
  appendHistory,
  VigilanciaWorker,
};
