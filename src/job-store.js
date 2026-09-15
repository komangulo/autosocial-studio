const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JobStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = { version: 1, jobs: [] };
    this.loaded = false;
    this.tail = Promise.resolve();
  }

  async init() {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error("Unsupported autonomous state format.");
      }
      this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Autonomous state is unreadable; restore ${this.filePath}.bak or repair it before starting: ${error.message}`);
      }
      await this._write();
    }
    this.loaded = true;
  }

  _serialize(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => {});
    return run;
  }

  async _write() {
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const backupPath = `${this.filePath}.bak`;
    const payload = JSON.stringify(this.state, null, 2);
    try {
      await fs.copyFile(this.filePath, backupPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  async _mutate(operation) {
    await this.init();
    return this._serialize(async () => {
      const result = operation(this.state);
      await this._write();
      return clone(result);
    });
  }

  async createJob(input) {
    const type = String(input.type || "");
    if (!new Set(["tiktok-publish", "flow-generate"]).has(type)) {
      throw new Error("Unsupported autonomous job type.");
    }
    const accountId = String(input.accountId || "").trim();
    if (!accountId) throw new Error("Account is required.");
    const scheduledAt = new Date(input.scheduledAt || Date.now());
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error("A valid scheduled date is required.");

    return this._mutate((state) => {
      if (input.dedupeKey) {
        const existing = state.jobs.find((job) => job.dedupeKey === input.dedupeKey);
        if (existing) return existing;
      }
      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        type,
        accountId,
        scheduledAt: scheduledAt.toISOString(),
        status: input.initialStatus === "preparing" ? "preparing" : "scheduled",
        attempts: 0,
        maxAttempts: Math.max(1, Math.min(5, Number(input.maxAttempts) || 1)),
        payload: clone(input.payload || {}),
        dedupeKey: input.dedupeKey || null,
        progress: null,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      state.jobs.push(job);
      return job;
    });
  }

  async listJobs(filters = {}) {
    await this.init();
    await this.tail;
    const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));
    return clone(this.state.jobs
      .filter((job) => !filters.accountId || job.accountId === filters.accountId)
      .filter((job) => !filters.type || job.type === filters.type)
      .filter((job) => !filters.status || job.status === filters.status)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit));
  }

  async getJob(id) {
    await this.init();
    await this.tail;
    const job = this.state.jobs.find((item) => item.id === id);
    return job ? clone(job) : null;
  }

  async claimDue(now = new Date(), filters = {}) {
    const dueAt = now.getTime();
    return this._mutate((state) => {
      const job = state.jobs
        .filter((item) => ["scheduled", "retry"].includes(item.status))
        .filter((item) => !filters.type || item.type === filters.type)
        .filter((item) => new Date(item.scheduledAt).getTime() <= dueAt)
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
      if (!job) return null;
      job.status = "running";
      job.attempts += 1;
      job.startedAt = new Date().toISOString();
      job.updatedAt = job.startedAt;
      job.error = null;
      return job;
    });
  }

  async markScheduled(id) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      if (job.status !== "preparing") throw new Error("Only a preparing job can be scheduled.");
      job.status = "scheduled";
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async updateProgress(id, progress) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      if (job.status !== "running") throw new Error("Only a running job can update progress.");
      job.progress = clone(progress);
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async updateFailedProgress(id, progress) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      if (job.status !== "failed" || job.type !== "flow-generate") {
        throw new Error("Only an interrupted failed Flow job can record recovered downloads.");
      }
      job.progress = clone(progress);
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async patchPayload(id, patch) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      if (!["preparing", "scheduled"].includes(job.status)) throw new Error("Only a preparing or scheduled job can be prepared.");
      job.payload = { ...job.payload, ...clone(patch || {}) };
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async complete(id, result) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      if (job.status !== "running") throw new Error("Only a running job can complete.");
      job.status = "succeeded";
      job.result = clone(result || {});
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      return job;
    });
  }

  async fail(id, error, options = {}) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) throw new Error("Job not found.");
      const retryable = Boolean(options.retryable) && job.attempts < job.maxAttempts;
      job.status = retryable ? "retry" : (options.uncertain ? "uncertain" : "failed");
      job.error = String(error?.message || error || "Job failed.");
      job.updatedAt = new Date().toISOString();
      if (retryable) {
        job.scheduledAt = new Date(Date.now() + (Number(options.delayMs) || 60000)).toISOString();
      } else {
        job.finishedAt = job.updatedAt;
      }
      return job;
    });
  }

  async beginCancel(id, accountId) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!job) throw new Error("Job not found.");
      if (!["preparing", "scheduled", "retry"].includes(job.status)) throw new Error("Only a pending job can be cancelled.");
      job.status = "cancelling";
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async finishCancel(id, accountId) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!job) throw new Error("Job not found.");
      if (job.status !== "cancelling") throw new Error("Job is not being cancelled.");
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      return job;
    });
  }

  async cancelJob(id, accountId) {
    await this.beginCancel(id, accountId);
    return this.finishCancel(id, accountId);
  }

  async retryJob(id, accountId, scheduledAt = new Date()) {
    return this._mutate((state) => {
      const job = state.jobs.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!job) throw new Error("Job not found.");
      if (!["failed", "uncertain"].includes(job.status)) throw new Error("Only a failed or uncertain job can be retried manually.");
      if (job.status === "uncertain" && job.type === "tiktok-publish") {
        throw new Error("This publication has an uncertain remote result. Review TikTok before creating a new job to avoid a duplicate.");
      }
      const date = new Date(scheduledAt);
      if (!Number.isFinite(date.getTime())) throw new Error("Invalid retry date.");
      job.status = "scheduled";
      job.scheduledAt = date.toISOString();
      job.error = null;
      job.finishedAt = null;
      job.progress = null;
      job.updatedAt = new Date().toISOString();
      return job;
    });
  }

  async recoverInterrupted() {
    return this._mutate((state) => {
      const recovered = [];
      for (const job of state.jobs.filter((item) => item.status === "running")) {
        const stage = job.progress?.stage || "claimed";
        const remoteMayHaveChanged = job.type === "tiktok-publish" &&
          ["publish-clicking", "publish-submitted", "publish-confirmed", "archiving"].includes(stage);
        if (remoteMayHaveChanged) {
          job.status = "uncertain";
          job.error = "The application stopped after TikTok publication may have started. Check TikTok before scheduling again.";
          job.finishedAt = new Date().toISOString();
        } else if (job.type === "tiktok-publish") {
          job.status = "retry";
          job.scheduledAt = new Date().toISOString();
          job.error = "The application stopped before publication was submitted. The reserved video will resume automatically.";
          job.finishedAt = null;
        } else {
          job.status = "failed";
          job.error = "The application stopped during Flow generation. Retry after checking the Flow project.";
          job.finishedAt = new Date().toISOString();
        }
        job.updatedAt = new Date().toISOString();
        recovered.push(job.id);
      }
      return recovered;
    });
  }

  isTerminal(status) {
    return TERMINAL.has(status);
  }
}

module.exports = { JobStore };
