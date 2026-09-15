const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { AutonomousWorker } = require("../src/autonomous-worker");

function makeStore() {
  return {
    async init() {},
    async recoverInterrupted() {},
    async listJobs() { return []; },
    async claimDue() { return null; },
    async updateProgress() {},
    async updateFailedProgress() {},
    async complete() {},
    async fail() {},
    async release() {},
    async finishCancel() {},
    async markScheduled() {},
    async patchPayload() {},
    async createJob() { return { id: "x", status: "preparing" }; },
  };
}

async function tempPausedPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-paused-"));
  return path.join(dir, "worker.paused");
}

test("a fresh worker is not paused and start() runs", async () => {
  const pausedStatePath = await tempPausedPath();
  const worker = new AutonomousWorker({ store: makeStore(), pausedStatePath });
  await worker.init();
  assert.equal(worker.getStatus().paused, false);
  assert.equal(worker.start(), true);
  worker.stop();
});

test("after stop the pause is persisted and reopening does not restart", async () => {
  const pausedStatePath = await tempPausedPath();
  const first = new AutonomousWorker({ store: makeStore(), pausedStatePath });
  await first.init();
  first.start();
  first.stop();
  await new Promise((r) => setTimeout(r, 50));

  // Simulate reopening the app: new worker reads the persisted pause.
  const second = new AutonomousWorker({ store: makeStore(), pausedStatePath });
  await second.init();
  assert.equal(second.getStatus().paused, true);
  assert.equal(second.start(), false, "start() must refuse while paused");
  assert.equal(second.getStatus().running, false);
});

test("an explicit action forces the worker back on", async () => {
  const pausedStatePath = await tempPausedPath();
  const first = new AutonomousWorker({ store: makeStore(), pausedStatePath });
  await first.init();
  first.stop();
  await new Promise((r) => setTimeout(r, 50));

  const second = new AutonomousWorker({ store: makeStore(), pausedStatePath });
  await second.init();
  assert.equal(second.start(), false);
  assert.equal(second.start({ force: true }), true);
  assert.equal(second.getStatus().paused, false);
  second.stop();
});
