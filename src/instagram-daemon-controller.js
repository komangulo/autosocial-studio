const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const cron = require("node-cron");
const { config } = require("./config");
const { postNextFromQueue } = require("./instagram-post-service");

function nowIso() {
  return new Date().toISOString();
}

function normalizeDailyTimes(times) {
  const source = Array.isArray(times) ? times : [];
  const normalized = source
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => {
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
      if (!match) {
        throw new Error(`Invalid time "${value}". Use HH:MM (24h).`);
      }
      return `${match[1].padStart(2, "0")}:${match[2]}`;
    });

  const uniqueSorted = Array.from(new Set(normalized)).sort((a, b) =>
    a.localeCompare(b)
  );
  if (!uniqueSorted.length) {
    throw new Error("Please provide at least one valid time.");
  }
  return uniqueSorted;
}

function getLocalTimeKey(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

class InstagramDaemonController {
  constructor(options = {}) {
    this.accountId = options.accountId || "default";
    this.queueDir = options.queueDir || config.instagramQueueDir;
    this.postedDir = options.postedDir || config.instagramPostedDir;
    this.failedDir = options.failedDir || config.instagramFailedDir;

    this.task = null;
    this.isPosting = false;
    this.lastRunAt = null;
    this.lastResult = null;
    this.logs = [];
    this.cronExpression = config.instagramCronExpression;
    this.schedulePlan = { type: "cron", expression: this.cronExpression };
    this.lastScheduleTriggerKey = null;
    this.instantPost = false;
    this.desiredRunning = false;
    this._queueWatcher = null;
    this._watchDebounce = null;
    this._scheduledTimers = new Set();
    this.statePath = options.statePath || path.resolve(config.projectRoot, "instagram-scheduler-state.json");
    this._loadState();
  }

  _loadState() {
    try {
      const data = fsSync.readFileSync(this.statePath, "utf-8");
      const state = JSON.parse(data);
      if (state.schedulePlan && state.schedulePlan.type === "daily-times") {
        this.schedulePlan = {
          type: "daily-times",
          times: normalizeDailyTimes(state.schedulePlan.times),
        };
      } else if (state.schedulePlan && state.schedulePlan.type === "cron") {
        this.cronExpression = state.schedulePlan.expression || this.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      } else if (state.cronExpression) {
        this.cronExpression = state.cronExpression;
        this.schedulePlan = { type: "cron", expression: this.cronExpression };
      }
      if (typeof state.desiredRunning === "boolean") this.desiredRunning = state.desiredRunning;
      if (typeof state.instantPost === "boolean") {
        this.instantPost = state.instantPost;
        if (this.instantPost) {
          this._startWatching();
        }
      }
    } catch (error) {
      // Ignore missing file or parse error
    }
  }

  async _saveState() {
    try {
      await fs.writeFile(
        this.statePath,
        JSON.stringify(
          {
            cronExpression: this.cronExpression,
            schedulePlan: this.schedulePlan,
            instantPost: this.instantPost,
            desiredRunning: this.desiredRunning,
          },
          null,
          2
        )
      );
    } catch (error) {
      this.log(`Failed to save scheduler state: ${error.message}`, "error");
    }
  }

  async setSchedule(expression) {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }
    this.cronExpression = expression;
    this.schedulePlan = { type: "cron", expression };
    await this._saveState();
    this.log(`Schedule updated to: ${expression}`);
    if (this.task) {
      this.stop();
      this.start();
    }
    return { ok: true, cronExpression: this.cronExpression };
  }

  async setDailyTimes(times) {
    const normalizedTimes = normalizeDailyTimes(times);
    this.schedulePlan = { type: "daily-times", times: normalizedTimes };
    this.lastScheduleTriggerKey = null;
    await this._saveState();
    this.log(`Schedule updated to daily times: ${normalizedTimes.join(", ")}`);
    if (this.task) {
      this.stop();
      this.start();
    }
    return { ok: true, schedulePlan: this.schedulePlan };
  }

  log(message, level = "info") {
    const entry = { at: nowIso(), level, message };
    this.logs.unshift(entry);
    this.logs = this.logs.slice(0, 50);
    const prefix = `[${entry.at}] [instagram:${this.accountId}]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  async runOnce(source = "manual") {
    if (this.isPosting) {
      return { ok: false, skipped: true, reason: "An Instagram post is already in progress." };
    }

    this.isPosting = true;
    this.lastRunAt = nowIso();
    this.log(`Run triggered by ${source}.`);

    try {
      const result = await postNextFromQueue({
        source,
        queueDir: this.queueDir,
        postedDir: this.postedDir,
        failedDir: this.failedDir,
        accountId: this.accountId,
      });
      this.lastResult = result;

      if (result.skipped) {
        this.log(result.reason);
      } else if (result.ok) {
        this.log(`Posted successfully: ${result.movedVideo}`);
      } else {
        this.log(`Post failed: ${result.error}`, "error");
        if (result.screenshotPath) {
          this.log(`Screenshot: ${result.screenshotPath}`, "error");
        }
      }
      return result;
    } catch (error) {
      const failedResult = { ok: false, error: error.message || "Unexpected Instagram scheduler error" };
      this.lastResult = failedResult;
      this.log(`Post failed: ${failedResult.error}`, "error");
      return failedResult;
    } finally {
      this.isPosting = false;
    }
  }

  _scheduleWithJitter(source) {
    const MAX_JITTER_MS = 10 * 60 * 1000;
    const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
    const jitterMin = Math.round(jitterMs / 1000 / 60 * 10) / 10;
    this.log(`Scheduled post will fire in ~${jitterMin} min (jitter).`);
    const timer = setTimeout(() => {
      this._scheduledTimers.delete(timer);
      if (!this.task) {
        this.log("Scheduled post skipped because scheduler is stopped.");
        return;
      }
      this.runOnce(source);
    }, jitterMs);
    this._scheduledTimers.add(timer);
  }

  _clearScheduledTimers() {
    for (const timer of this._scheduledTimers) {
      clearTimeout(timer);
    }
    this._scheduledTimers.clear();
  }

  start(options = {}) {
    if (options.persist !== false) {
      this.desiredRunning = true;
      this._saveState();
    }
    if (this.task) {
      return { ok: true, alreadyRunning: true };
    }

    if (this.schedulePlan.type === "daily-times") {
      const times = normalizeDailyTimes(this.schedulePlan.times);
      this.schedulePlan = { type: "daily-times", times };
      this.task = cron.schedule(
        "* * * * *",
        async () => {
          const currentTime = getLocalTimeKey(new Date(), config.timezone);
          if (!times.includes(currentTime)) return;
          const minuteKey = `${new Date().toISOString().slice(0, 16)}|${currentTime}`;
          if (this.lastScheduleTriggerKey === minuteKey) return;
          this.lastScheduleTriggerKey = minuteKey;
          this._scheduleWithJitter("daily-times");
        },
        { timezone: config.timezone }
      );
      this.log(`Scheduler started (daily times: ${times.join(", ")}, timezone: ${config.timezone}).`);
      return { ok: true, alreadyRunning: false };
    }

    if (!cron.validate(this.cronExpression)) {
      throw new Error(`Invalid CRON_EXPRESSION: ${this.cronExpression}`);
    }
    this.task = cron.schedule(
      this.cronExpression,
      async () => { this._scheduleWithJitter("cron"); },
      { timezone: config.timezone }
    );
    this.log(`Scheduler started (${this.cronExpression}, timezone: ${config.timezone}).`);
    return { ok: true, alreadyRunning: false };
  }

  stop(options = {}) {
    if (options.persist !== false) {
      this.desiredRunning = false;
      this._saveState();
    }
    this._clearScheduledTimers();
    if (!this.task) return { ok: true, alreadyStopped: true };
    this.task.stop();
    this.task.destroy();
    this.task = null;
    this.log("Scheduler stopped.");
    return { ok: true, alreadyStopped: false };
  }

  resumeIfNeeded() {
    if (!this.desiredRunning) return { ok: true, resumed: false };
    const result = this.start({ persist: false });
    return { ...result, resumed: true };
  }

  async setInstantPost(enabled) {
    this.instantPost = Boolean(enabled);
    await this._saveState();
    if (this.instantPost) {
      this._startWatching();
      this.log("Instant post ENABLED.");
    } else {
      this._stopWatching();
      this.log("Instant post DISABLED.");
    }
    return { ok: true, instantPost: this.instantPost };
  }

  _startWatching() {
    if (this._queueWatcher) return;
    const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
    try {
      this._queueWatcher = fsSync.watch(this.queueDir, (eventType, filename) => {
        if (eventType !== "rename" || !filename) return;
        const ext = path.extname(filename).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) return;
        clearTimeout(this._watchDebounce);
        this._watchDebounce = setTimeout(() => {
          this.log('Instant post: detected new file "' + filename + '"');
          this.runOnce("instant-post");
        }, 2000);
      });
    } catch (err) {
      this.log("Failed to watch queue directory: " + err.message, "error");
    }
  }

  _stopWatching() {
    if (this._queueWatcher) {
      this._queueWatcher.close();
      this._queueWatcher = null;
    }
    clearTimeout(this._watchDebounce);
  }

  async getQueueState() {
    const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
    const pendingEntries = await fs.readdir(this.queueDir, { withFileTypes: true });
    const postedEntries = await fs.readdir(this.postedDir, { withFileTypes: true });
    const failedEntries = await fs.readdir(this.failedDir, { withFileTypes: true });

    const isVideo = (entry) => entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase());

    const pendingVideos = pendingEntries
      .filter(isVideo)
      .map((entry) => {
        const ext = path.extname(entry.name);
        const base = entry.name.slice(0, -ext.length);
        const hasCaption = pendingEntries.some(e => e.isFile() && (e.name === `${base}.description` || e.name === `${base}.txt`));
        return { name: entry.name, hasCaption };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      counts: {
        pending: pendingVideos.length,
        posted: postedEntries.filter(isVideo).length,
        failed: failedEntries.filter(isVideo).length,
      },
      pendingVideos,
    };
  }

  async getStatus() {
    const queue = await this.getQueueState();
    return {
      running: Boolean(this.task),
      isPosting: this.isPosting,
      cronExpression: this.cronExpression,
      schedulePlan: this.schedulePlan,
      instantPost: this.instantPost,
      timezone: config.timezone,
      randomQueueOrder: config.randomQueueOrder,
      accountId: this.accountId,
      queue,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      logs: this.logs,
    };
  }
}

module.exports = {
  InstagramDaemonController,
  normalizeDailyTimes,
  getLocalTimeKey,
};
