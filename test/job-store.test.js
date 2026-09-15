const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JobStore } = require("../src/job-store");

async function createStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-jobs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const store = new JobStore(file);
  await store.init();
  return { store, file };
}

test("jobs persist and are claimed once", async (t) => {
  const { store, file } = await createStore(t);
  const job = await store.createJob({ type: "flow-generate", accountId: "default", scheduledAt: new Date(0) });
  const claimed = await store.claimDue(new Date());
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(await store.claimDue(new Date()), null);

  const reopened = new JobStore(file);
  await reopened.init();
  assert.equal((await reopened.getJob(job.id)).status, "running");
});

test("daily dedupe keys prevent duplicate jobs", async (t) => {
  const { store } = await createStore(t);
  const first = await store.createJob({ type: "flow-generate", accountId: "a", scheduledAt: new Date(), dedupeKey: "flow:a:2026-01-01" });
  const second = await store.createJob({ type: "flow-generate", accountId: "a", scheduledAt: new Date(), dedupeKey: "flow:a:2026-01-01" });
  assert.equal(second.id, first.id);
  assert.equal((await store.listJobs()).length, 1);
});

test("interrupted TikTok publication becomes uncertain", async (t) => {
  const { store } = await createStore(t);
  const job = await store.createJob({ type: "tiktok-publish", accountId: "default", scheduledAt: new Date(0) });
  await store.claimDue(new Date());
  await store.updateProgress(job.id, { stage: "publish-submitted" });
  await store.recoverInterrupted();
  const recovered = await store.getJob(job.id);
  assert.equal(recovered.status, "uncertain");
  await assert.rejects(() => store.retryJob(job.id, "default"), /uncertain remote result/i);
});

test("interrupted TikTok work before publish is retried", async (t) => {
  const { store } = await createStore(t);
  const job = await store.createJob({ type: "tiktok-publish", accountId: "default", scheduledAt: new Date(0) });
  await store.claimDue(new Date());
  await store.updateProgress(job.id, { stage: "browser-started" });
  await store.recoverInterrupted();
  assert.equal((await store.getJob(job.id)).status, "retry");
});

test("interrupted Flow downloads remain recoverable after restart", async (t) => {
  const { store } = await createStore(t);
  const job = await store.createJob({ type: "flow-generate", accountId: "default", scheduledAt: new Date(0) });
  await store.claimDue(new Date());
  await store.updateProgress(job.id, {
    stage: "entering-prompt",
    current: 1,
    total: 3,
    downloadedFiles: ["downloads/google-flow/default/job/video.mp4"],
  });
  await store.recoverInterrupted();
  const recovered = await store.getJob(job.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.progress.downloadedFiles.length, 1);
  await store.updateFailedProgress(job.id, {
    ...recovered.progress,
    stage: "recovered-saved",
    savedVideos: ["video.mp4"],
  });
  assert.deepEqual((await store.getJob(job.id)).progress.savedVideos, ["video.mp4"]);
});

test("cancel only accepts pending jobs", async (t) => {
  const { store } = await createStore(t);
  const job = await store.createJob({ type: "flow-generate", accountId: "default", scheduledAt: new Date(Date.now() + 60000) });
  assert.equal((await store.cancelJob(job.id, "default")).status, "cancelled");
  await assert.rejects(() => store.cancelJob(job.id, "default"), /pending/);
});

test("bulk cancellation only removes pending TikTok jobs", async (t) => {
  const { store } = await createStore(t);
  const pending = await store.createJob({ type: "tiktok-publish", accountId: "default", scheduledAt: new Date(Date.now() + 60000) });
  const running = await store.createJob({ type: "tiktok-publish", accountId: "default", scheduledAt: new Date(0) });
  await store.claimDue(new Date());
  const flow = await store.createJob({ type: "flow-generate", accountId: "default", scheduledAt: new Date(Date.now() + 60000) });

  const marked = await store.beginCancelPending("default", "tiktok-publish");
  assert.deepEqual(marked.map((job) => job.id), [pending.id]);
  assert.equal((await store.getJob(pending.id)).status, "cancelling");
  assert.equal((await store.getJob(running.id)).status, "running");
  assert.equal((await store.getJob(flow.id)).status, "scheduled");

  await store.finishCancel(pending.id, "default");
  const removed = await store.removeCancelled([pending.id], "default");
  assert.equal(removed.length, 1);
  assert.equal(await store.getJob(pending.id), null);
  assert.equal((await store.getJob(running.id)).status, "running");
  assert.equal((await store.getJob(flow.id)).status, "scheduled");
});
