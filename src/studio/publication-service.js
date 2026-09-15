const fs = require("fs/promises");
const { constants } = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { StudioValidationError } = require("./validation");

const PLATFORMS = new Set(["youtube", "tiktok", "instagram"]);
function parse(value) { return value == null ? null : JSON.parse(value); }
function sidecarPath(mediaPath) {
  const parsed = path.parse(mediaPath);
  return path.join(parsed.dir, `${parsed.name}.description`);
}
function manifestPath(mediaPath) {
  const parsed = path.parse(mediaPath);
  return path.join(parsed.dir, `${parsed.name}.studio.json`);
}
async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}
function mapPublication(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    accountId: row.account_id,
    renderId: row.render_id,
    platform: row.platform,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    scheduledAt: row.scheduled_at,
    caption: row.caption,
    options: parse(row.options_json),
    queuePath: row.queue_path,
    blockedReason: row.blocked_reason,
    remoteId: row.remote_id || null,
    remoteUrl: row.remote_url || null,
    remoteStatus: row.remote_status || null,
    confirmation: parse(row.confirmation_json),
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class PublicationService {
  constructor({ database, projectService, renderService, getAccountQueueDirs }) {
    Object.assign(this, { db: database.db, projectService, renderService, getAccountQueueDirs });
    this.timer = setInterval(() => { void this.reconcile().then(() => this.promoteDue()).catch(() => {}); }, 30000);
    this.timer.unref?.();
    setImmediate(() => { void this.reconcile().then(() => this.promoteDue()).catch(() => {}); });
  }

  list(accountId, projectId) {
    this.projectService.get(accountId, projectId);
    return this.db.prepare("SELECT * FROM studio_publications WHERE account_id=? AND project_id=? ORDER BY created_at DESC")
      .all(accountId, projectId).map(mapPublication);
  }

  get(accountId, projectId, publicationId) {
    this.projectService.get(accountId, projectId);
    const row = this.db.prepare("SELECT * FROM studio_publications WHERE id=? AND account_id=? AND project_id=?")
      .get(publicationId, accountId, projectId);
    if (!row) throw new StudioValidationError("Publication handoff not found.", 404);
    return mapPublication(row);
  }

  async queueDirectories(accountId, platform) {
    if (typeof this.getAccountQueueDirs !== "function") throw new Error("No reliable account publication queue integration is configured.");
    const dirs = await this.getAccountQueueDirs(accountId);
    const pending = dirs?.[platform]?.pending;
    const scheduled = dirs?.[platform]?.scheduled;
    if (!pending || !scheduled || !path.isAbsolute(pending) || !path.isAbsolute(scheduled)) throw new Error("Account publication queues are unavailable.");
    return {
      pending: path.resolve(pending),
      scheduled: path.resolve(scheduled),
      processing: dirs?.[platform]?.processing && path.isAbsolute(dirs[platform].processing) ? path.resolve(dirs[platform].processing) : null,
      posted: dirs?.[platform]?.posted && path.isAbsolute(dirs[platform].posted) ? path.resolve(dirs[platform].posted) : null,
      failed: dirs?.[platform]?.failed && path.isAbsolute(dirs[platform].failed) ? path.resolve(dirs[platform].failed) : null,
    };
  }

  async copyHandoff(accountId, projectId, render, item) {
    const dirs = await this.queueDirectories(accountId, item.platform);
    const future = item.scheduledAt && new Date(item.scheduledAt).getTime() > Date.now();
    const destinationRoot = future ? dirs.scheduled : dirs.pending;
    await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    const source = this.renderService.content(accountId, projectId, render.id).filePath;
    const target = path.join(destinationRoot, `studio-${item.id}.mp4`);
    if (!path.resolve(target).startsWith(`${destinationRoot}${path.sep}`)) throw new Error("Unsafe account publication queue path.");
    const description = sidecarPath(target);
    const manifest = manifestPath(target);
    const temporaryMedia = `${target}.partial-${randomUUID()}`;
    const temporaryDescription = `${description}.partial-${randomUUID()}`;
    const temporaryManifest = `${manifest}.partial-${randomUUID()}`;
    try {
      await fs.copyFile(source, temporaryMedia, constants.COPYFILE_EXCL);
      await fs.writeFile(temporaryDescription, item.caption || "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.writeFile(temporaryManifest, JSON.stringify({ version: 1, publicationId: item.id, projectId, accountId, platform: item.platform, idempotencyKey: item.idempotencyKey, scheduledAt: item.scheduledAt || null }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporaryDescription, description);
      await fs.rename(temporaryManifest, manifest);
      await fs.rename(temporaryMedia, target);
      return { status: future ? "scheduled" : "handed-off", queuePath: target, blockedReason: null };
    } catch (error) {
      await Promise.all([
        fs.rm(temporaryMedia, { force: true }),
        fs.rm(temporaryDescription, { force: true }),
        fs.rm(temporaryManifest, { force: true }),
      ]);
      throw error;
    }
  }

  async create(accountId, projectId, input = {}) {
    this.projectService.get(accountId, projectId);
    const platform = String(input.platform || "");
    if (!PLATFORMS.has(platform)) throw new StudioValidationError("Unsupported publication platform.");
    const key = String(input.idempotencyKey || "").trim();
    if (!key || key.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(key)) throw new StudioValidationError("A valid idempotency key is required.");
    const existing = this.db.prepare("SELECT * FROM studio_publications WHERE account_id=? AND idempotency_key=?").get(accountId, key);
    if (existing) {
      if (existing.project_id !== projectId) throw new StudioValidationError("Idempotency key is already used by another project.", 409);
      return mapPublication(existing);
    }
    const render = this.renderService.get(accountId, projectId, input.renderId);
    if (render.status !== "completed" || !render.outputAssetId) throw new StudioValidationError("Only a completed render can be handed off.", 409);
    const scheduledAt = input.scheduledAt == null ? null : new Date(input.scheduledAt);
    if (scheduledAt && !Number.isFinite(scheduledAt.getTime())) throw new StudioValidationError("Invalid scheduledAt.");
    const caption = String(input.caption || "").trim();
    if (caption.length > 5000) throw new StudioValidationError("Caption is too long.");
    let options;
    try { options = JSON.stringify(input.options || {}); } catch { throw new StudioValidationError("Publication options must be JSON."); }
    if (Buffer.byteLength(options) > 64 * 1024) throw new StudioValidationError("Publication options are too large.");

    const id = randomUUID();
    const now = new Date().toISOString();
    const item = { id, platform, caption, idempotencyKey: key, scheduledAt: scheduledAt?.toISOString() || null };
    this.db.prepare("INSERT INTO studio_publications(id,project_id,account_id,render_id,platform,idempotency_key,status,scheduled_at,caption,options_json,queue_path,blocked_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,'preparing',?,?,?,?,?,?,?)")
      .run(id, projectId, accountId, render.id, platform, key, item.scheduledAt, caption, options, null, null, now, now);
    let outcome = { status: "blocked", queuePath: null, blockedReason: "No reliable account publication queue integration is configured." };
    try {
      outcome = await this.copyHandoff(accountId, projectId, render, item);
    } catch (error) {
      outcome.blockedReason = `Publication handoff blocked: ${error.message}`.slice(0, 1000);
    }
    this.db.prepare("UPDATE studio_publications SET status=?,queue_path=?,blocked_reason=?,updated_at=? WHERE id=? AND status='preparing'")
      .run(outcome.status, outcome.queuePath, outcome.blockedReason, new Date().toISOString(), id);
    return this.get(accountId, projectId, id);
  }

  async removeQueuedFiles(item) {
    if (!item.queuePath) return;
    await Promise.all([
      fs.rm(item.queuePath, { force: true }),
      fs.rm(sidecarPath(item.queuePath), { force: true }),
      fs.rm(manifestPath(item.queuePath), { force: true }),
    ]);
  }

  async cancel(accountId, projectId, publicationId) {
    const item = this.get(accountId, projectId, publicationId);
    if (item.status === "handed-off") throw new StudioValidationError("The handoff already entered the platform queue and can no longer be cancelled safely.", 409);
    if (item.status === "cancelled") throw new StudioValidationError("Publication handoff is already cancelled.", 409);
    if (!new Set(["blocked", "scheduled"]).has(item.status)) throw new StudioValidationError("Publication handoff cannot be cancelled in its current status.", 409);
    await this.removeQueuedFiles(item);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE studio_publications SET status='cancelled',queue_path=NULL,updated_at=? WHERE id=?").run(now, publicationId);
    return this.get(accountId, projectId, publicationId);
  }

  async retry(accountId, projectId, publicationId) {
    const item = this.get(accountId, projectId, publicationId);
    if (!["blocked", "cancelled"].includes(item.status)) throw new StudioValidationError("Only blocked or cancelled handoffs can be retried.", 409);
    const render = this.renderService.get(accountId, projectId, item.renderId);
    this.db.prepare("UPDATE studio_publications SET status='preparing',queue_path=NULL,blocked_reason=NULL,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), item.id);
    let outcome = { status: "blocked", queuePath: null, blockedReason: "No reliable account publication queue integration is configured." };
    try {
      outcome = await this.copyHandoff(accountId, projectId, render, item);
    } catch (error) {
      outcome.blockedReason = `Publication handoff blocked: ${error.message}`.slice(0, 1000);
    }
    this.db.prepare("UPDATE studio_publications SET status=?,queue_path=?,blocked_reason=?,updated_at=? WHERE id=?")
      .run(outcome.status, outcome.queuePath, outcome.blockedReason, new Date().toISOString(), item.id);
    return this.get(accountId, projectId, item.id);
  }

  async reconcile() {
    const rows = this.db.prepare("SELECT * FROM studio_publications WHERE status IN ('preparing','promoting') ORDER BY created_at LIMIT 100").all();
    let reconciled = 0;
    for (const row of rows) {
      const item = mapPublication(row);
      try {
        const dirs = await this.queueDirectories(item.accountId, item.platform);
        const pending = path.join(dirs.pending, `studio-${item.id}.mp4`);
        const scheduled = path.join(dirs.scheduled, `studio-${item.id}.mp4`);
        const pendingComplete = await pathExists(pending) && await pathExists(sidecarPath(pending));
        const scheduledComplete = await pathExists(scheduled) && await pathExists(sidecarPath(scheduled));
        if (pendingComplete) {
          this.db.prepare("UPDATE studio_publications SET status='handed-off',queue_path=?,blocked_reason=NULL,updated_at=? WHERE id=?")
            .run(pending, new Date().toISOString(), item.id);
          reconciled += 1;
          continue;
        }
        if (scheduledComplete) {
          this.db.prepare("UPDATE studio_publications SET status='scheduled',queue_path=?,blocked_reason=NULL,updated_at=? WHERE id=?")
            .run(scheduled, new Date().toISOString(), item.id);
          reconciled += 1;
          continue;
        }
        if (item.status === "promoting") {
          const sourceMedia = await pathExists(scheduled);
          const sourceCaption = await pathExists(sidecarPath(scheduled));
          const targetMedia = await pathExists(pending);
          const targetCaption = await pathExists(sidecarPath(pending));
          if (sourceMedia && targetCaption && !targetMedia) await fs.rename(scheduled, pending);
          else if (targetMedia && sourceCaption && !targetCaption) await fs.rename(sidecarPath(scheduled), sidecarPath(pending));
          if (await pathExists(pending) && await pathExists(sidecarPath(pending))) {
            this.db.prepare("UPDATE studio_publications SET status='handed-off',queue_path=?,blocked_reason=NULL,updated_at=? WHERE id=?")
              .run(pending, new Date().toISOString(), item.id);
          } else {
            this.db.prepare("UPDATE studio_publications SET status='scheduled',queue_path=?,blocked_reason=?,updated_at=? WHERE id=?")
              .run(scheduled, "Scheduled handoff recovery is waiting for complete queue files.", new Date().toISOString(), item.id);
          }
          reconciled += 1;
          continue;
        }
        await Promise.all([pending, sidecarPath(pending), manifestPath(pending), scheduled, sidecarPath(scheduled), manifestPath(scheduled)].map((file) => fs.rm(file, { force: true })));
        const render = this.renderService.get(item.accountId, item.projectId, item.renderId);
        let outcome;
        try {
          outcome = await this.copyHandoff(item.accountId, item.projectId, render, item);
        } catch (error) {
          outcome = { status: "blocked", queuePath: null, blockedReason: `Publication handoff blocked: ${error.message}`.slice(0, 1000) };
        }
        this.db.prepare("UPDATE studio_publications SET status=?,queue_path=?,blocked_reason=?,updated_at=? WHERE id=?")
          .run(outcome.status, outcome.queuePath, outcome.blockedReason, new Date().toISOString(), item.id);
        reconciled += 1;
      } catch (error) {
        this.db.prepare("UPDATE studio_publications SET status='blocked',blocked_reason=?,updated_at=? WHERE id=?")
          .run(`Publication handoff recovery blocked: ${error.message}`.slice(0, 1000), new Date().toISOString(), item.id);
      }
    }
    return reconciled;
  }

  async promoteDue(nowValue = new Date()) {
    const now = new Date(nowValue);
    if (!Number.isFinite(now.getTime())) throw new StudioValidationError("Invalid publication scheduler time.");
    const due = this.db.prepare("SELECT * FROM studio_publications WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 100")
      .all(now.toISOString());
    let promoted = 0;
    for (const row of due) {
      const item = mapPublication(row);
      try {
        const dirs = await this.queueDirectories(item.accountId, item.platform);
        const source = path.resolve(item.queuePath || "");
        if (!source.startsWith(`${dirs.scheduled}${path.sep}`)) throw new Error("Scheduled handoff path is outside its account queue.");
        const marked = this.db.prepare("UPDATE studio_publications SET status='promoting',updated_at=? WHERE id=? AND status='scheduled'").run(new Date().toISOString(), item.id);
        if (!marked.changes) continue;
        await fs.mkdir(dirs.pending, { recursive: true, mode: 0o700 });
        const target = path.join(dirs.pending, path.basename(source));
        const sourceSidecar = sidecarPath(source);
        const targetSidecar = sidecarPath(target);
        const sourceManifest = manifestPath(source);
        const targetManifest = manifestPath(target);
        await fs.rename(sourceSidecar, targetSidecar);
        const hasManifest = await pathExists(sourceManifest);
        if (hasManifest) await fs.rename(sourceManifest, targetManifest);
        try {
          await fs.rename(source, target);
        } catch (error) {
          await fs.rename(targetSidecar, sourceSidecar).catch(() => {});
          if (hasManifest) await fs.rename(targetManifest, sourceManifest).catch(() => {});
          throw error;
        }
        this.db.prepare("UPDATE studio_publications SET status='handed-off',queue_path=?,blocked_reason=NULL,updated_at=? WHERE id=? AND status='promoting'")
          .run(target, new Date().toISOString(), item.id);
        promoted += 1;
      } catch (error) {
        this.db.prepare("UPDATE studio_publications SET status='scheduled',blocked_reason=?,updated_at=? WHERE id=? AND status='promoting'")
          .run(`Scheduled handoff is waiting: ${error.message}`.slice(0, 1000), new Date().toISOString(), item.id);
      }
    }
    return promoted;
  }

  confirm(accountId, projectId, publicationId, input = {}) {
    const item = this.get(accountId, projectId, publicationId);
    const status = String(input.status || "");
    if (!["published", "failed", "uncertain"].includes(status)) throw new StudioValidationError("Unsupported remote publication status.");
    if (!["handed-off", "published", "remote-failed", "uncertain"].includes(item.status)) throw new StudioValidationError("Publication has not reached a remotely confirmable state.", 409);
    const remoteId = input.remoteId == null ? null : String(input.remoteId).trim().slice(0, 500);
    const remoteUrl = input.remoteUrl == null ? null : String(input.remoteUrl).trim();
    if (remoteUrl) {
      let parsed;
      try { parsed = new URL(remoteUrl); } catch { throw new StudioValidationError("Invalid remote publication URL."); }
      if (!["https:", "http:"].includes(parsed.protocol) || remoteUrl.length > 2000) throw new StudioValidationError("Invalid remote publication URL.");
    }
    let evidence;
    try { evidence = JSON.stringify(input.evidence || {}); } catch { throw new StudioValidationError("Publication evidence must be JSON."); }
    if (Buffer.byteLength(evidence) > 64 * 1024) throw new StudioValidationError("Publication evidence is too large.");
    const parsedEvidence = JSON.parse(evidence);
    if (status === "published" && !remoteId && !remoteUrl && parsedEvidence.confirmed !== true) throw new StudioValidationError("Published status requires a remote identifier, URL, or explicit confirmation evidence.");
    const nextStatus = status === "failed" ? "remote-failed" : status;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE studio_publications SET status=?,remote_status=?,remote_id=?,remote_url=?,confirmation_json=?,published_at=?,updated_at=? WHERE id=? AND account_id=?")
        .run(nextStatus, status, remoteId, remoteUrl, evidence, status === "published" ? now : null, now, publicationId, accountId);
      this.projectService.recordEvent(accountId, projectId, "publication.remote-status", { publicationId, status, remoteId, remoteUrl }, now);
    })();
    return this.get(accountId, projectId, publicationId);
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = { PublicationService, mapPublication, PLATFORMS, sidecarPath, manifestPath };
