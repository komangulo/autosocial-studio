const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { DateTime } = require("luxon");
const { normalizeConfig } = require("../src/flow-config");
const { nextPublicationDates, isInside, processFlowOutputFiles } = require("../src/autonomous-worker");

test("Flow config validates daily automation settings", () => {
  const value = normalizeConfig("default", {
    enabled: true,
    prompt: "A vertical product video",
    videosPerDay: 9,
    dailyTime: "06:30",
    publicationTimes: ["09:30", "14:30", "22:10", "09:30"],
    timezone: "Europe/Madrid",
  });
  assert.equal(value.videosPerDay, 3);
  assert.deepEqual(value.publicationTimes, ["09:30", "14:30", "22:10"]);
  assert.throws(() => normalizeConfig("default", { dailyTime: "25:00" }), /HH:MM/);
  assert.throws(() => normalizeConfig("default", { timezone: "Mars/Olympus" }), /timezone/);
});

test("publication dates are future UTC instants in configured timezone", () => {
  const now = DateTime.fromISO("2026-03-28T10:00:00", { zone: "Europe/Madrid" });
  const values = nextPublicationDates(["09:00", "14:00", "20:00"], "Europe/Madrid", 3, now);
  assert.deepEqual(values, [
    "2026-03-28T13:00:00.000Z",
    "2026-03-28T19:00:00.000Z",
    "2026-03-29T07:00:00.000Z",
  ]);
});

test("path containment rejects root and traversal siblings", () => {
  assert.equal(isInside("/tmp/root", "/tmp/root/child/video.mp4"), true);
  assert.equal(isInside("/tmp/root", "/tmp/root-other/video.mp4"), false);
  assert.equal(isInside("/tmp/root", "/tmp/root"), false);
});

test("Flow output processing rejects symbolic-link videos", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-output-symlink-"));
  try {
    const outputDir = path.join(root, "downloads", "google-flow", "brand", "job");
    const pending = path.join(root, "queue", "pending");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(pending, { recursive: true });
    const outside = path.join(root, "outside.mp4");
    const linked = path.join(outputDir, "linked.mp4");
    await fs.writeFile(outside, Buffer.alloc(2048, 3));
    try {
      await fs.symlink(outside, linked);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        context.skip("Symlink creation is unavailable on this platform.");
        return;
      }
      throw error;
    }
    await assert.rejects(processFlowOutputFiles({
      files: [linked],
      outputDir,
      queueDirs: { pending },
      flow: { autoPublish: false, caption: "" },
      job: { id: "job", accountId: "brand" },
      publishDates: [new Date(Date.now() + 60000).toISOString()],
      createReservedTikTokJob: async () => { throw new Error("should not reserve"); },
    }), /symbolic link/);
    assert.deepEqual(await fs.readdir(pending), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("processed Flow videos remain permanent and are copied to pending", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-output-"));
  try {
    const outputDir = path.join(root, "downloads", "google-flow", "brand", "job");
    const pending = path.join(root, "queue", "pending");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(pending, { recursive: true });
    const source = path.join(outputDir, "browser-download.mp4");
    await fs.writeFile(source, Buffer.alloc(2048, 7));
    const progress = [];

    const result = await processFlowOutputFiles({
      files: [source],
      outputDir,
      queueDirs: { pending },
      flow: { autoPublish: false, caption: "Saved caption" },
      job: { id: "job", accountId: "brand" },
      publishDates: [new Date(Date.now() + 60000).toISOString()],
      createReservedTikTokJob: async () => { throw new Error("should not reserve"); },
      onProcessed: async (state) => { progress.push(state); },
    });

    const permanent = path.join(outputDir, result.savedVideos[0]);
    const queued = path.join(pending, result.savedVideos[0]);
    assert.equal((await fs.stat(permanent)).size, 2048);
    assert.equal((await fs.stat(queued)).size, 2048);
    assert.equal(await fs.readFile(path.join(pending, `${path.parse(result.savedVideos[0]).name}.description`), "utf8"), "Saved caption");
    assert.deepEqual(result.childJobs, []);
    assert.deepEqual(progress.map((state) => state.stage), ["permanent-saved", "pending-copied"]);
    assert.deepEqual(progress[0].savedVideos, result.savedVideos);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("queue failures still record the permanent Flow video before retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-copy-failure-"));
  try {
    const outputDir = path.join(root, "downloads", "google-flow", "brand", "job");
    await fs.mkdir(outputDir, { recursive: true });
    const source = path.join(outputDir, "browser-download.mp4");
    await fs.writeFile(source, Buffer.alloc(2048, 5));
    const progress = [];
    await assert.rejects(processFlowOutputFiles({
      files: [source],
      outputDir,
      queueDirs: { pending: path.join(root, "missing", "pending") },
      flow: { autoPublish: false, caption: "" },
      job: { id: "job", accountId: "brand" },
      publishDates: [new Date(Date.now() + 60000).toISOString()],
      createReservedTikTokJob: async () => { throw new Error("should not reserve"); },
      onProcessed: async (state) => { progress.push(state); },
    }), /ENOENT/);
    assert.equal(progress[0].stage, "permanent-saved");
    assert.equal((await fs.stat(path.join(outputDir, progress[0].savedVideos[0]))).size, 2048);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("auto-publish reserves a copy without removing the permanent Flow video", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-reserve-"));
  try {
    const outputDir = path.join(root, "downloads", "google-flow", "brand", "job");
    const pending = path.join(root, "queue", "pending");
    const scheduled = path.join(root, "queue", "scheduled");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(pending, { recursive: true });
    await fs.mkdir(scheduled, { recursive: true });
    const source = path.join(outputDir, "browser-download.webm");
    await fs.writeFile(source, Buffer.alloc(3072, 9));
    let reservationInput;

    const result = await processFlowOutputFiles({
      files: [source],
      outputDir,
      queueDirs: { pending },
      flow: { autoPublish: true, caption: "" },
      job: { id: "job", accountId: "brand" },
      publishDates: [new Date(Date.now() + 60000).toISOString()],
      createReservedTikTokJob: async (input) => {
        reservationInput = input;
        await fs.copyFile(input.sourcePath, path.join(scheduled, path.basename(input.sourcePath)));
        return { id: "child-job" };
      },
    });

    const permanent = path.join(outputDir, result.savedVideos[0]);
    assert.equal((await fs.stat(permanent)).size, 3072);
    assert.equal((await fs.stat(path.join(scheduled, result.savedVideos[0]))).size, 3072);
    assert.equal(reservationInput.copySource, true);
    assert.deepEqual(result.childJobs, ["child-job"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
