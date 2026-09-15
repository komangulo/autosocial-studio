const { EventEmitter } = require("events");
const crypto = require("crypto");

/**
 * In-process job manager for Helios generations.
 * Mirrors HeliosGen's jobStore + jobEvents, but keyed in memory and persisted to
 * the Helios history file by the controller so results survive a restart via the
 * history record (the poller is re-armed from history on load).
 */
class HeliosJobManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(500);
    this.jobs = new Map();
  }

  create(kind, meta = {}) {
    const id = `hg-${kind}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const job = {
      id,
      kind,
      status: "pending",
      createdAt: new Date().toISOString(),
      ...meta,
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  upsert(id, patch) {
    const existing = this.jobs.get(id);
    const next = { ...(existing || { id }), ...patch, id };
    this.jobs.set(id, next);
    return next;
  }

  update(id, patch) {
    const current = this.jobs.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, next);
    this.emit(`job:${id}`, next);
    this.emit("job", next);
    return next;
  }

  succeed(id, { imageUrl, imageUrls, videoUrl }) {
    return this.update(id, { status: "done", imageUrl, imageUrls, videoUrl, error: undefined });
  }

  fail(id, error) {
    return this.update(id, { status: "error", error: String(error || "Generation failed") });
  }

  list(limit = 200) {
    return Array.from(this.jobs.values())
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  remove(id) {
    this.jobs.delete(id);
  }
}

module.exports = { HeliosJobManager };
