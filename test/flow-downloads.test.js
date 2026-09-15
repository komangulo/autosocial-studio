const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  getFlowDownloadsRoot,
  getFlowRunDirectory,
  prepareFlowRunDirectory,
  resolveFlowDownload,
  listFlowDownloads,
} = require("../src/flow-downloads");

test("Flow downloads use a permanent per-account and per-job folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-downloads-"));
  try {
    const runDirectory = getFlowRunDirectory("brand-one", "job-one", root);
    assert.equal(runDirectory, path.join(root, "downloads", "google-flow", "brand-one", "job-one"));
    assert.equal(await prepareFlowRunDirectory("brand-one", "job-one", root), runDirectory);
    await fs.writeFile(path.join(runDirectory, "saved.mp4"), Buffer.alloc(2048));
    await fs.writeFile(path.join(runDirectory, "diagnostic.json"), "{}");
    await fs.writeFile(path.join(runDirectory, "empty.webm"), Buffer.alloc(20));

    const result = await listFlowDownloads("brand-one", root);
    assert.equal(result.root, getFlowDownloadsRoot("brand-one", root));
    assert.deepEqual(result.videos.map((video) => video.name), ["saved.mp4"]);
    assert.equal(result.videos[0].relativePath, path.join("downloads", "google-flow", "brand-one", "job-one", "saved.mp4"));
    assert.equal(await resolveFlowDownload("brand-one", "job-one", "saved.mp4", root), path.join(runDirectory, "saved.mp4"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Flow download paths reject traversal and non-video files", async () => {
  assert.throws(() => getFlowRunDirectory("brand-one", "../other"), /Invalid Flow job/);
  await assert.rejects(resolveFlowDownload("brand-one", "job-one", "../video.mp4"), /Invalid Flow video name/);
  await assert.rejects(resolveFlowDownload("brand-one", "job-one", "report.json"), /Unsupported Flow video type/);
});

test("Flow downloads reject symlinks outside the active account", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-symlink-"));
  try {
    const runDirectory = getFlowRunDirectory("brand-one", "job-one", root);
    await fs.mkdir(runDirectory, { recursive: true });
    const outside = path.join(root, "outside.mp4");
    await fs.writeFile(outside, Buffer.alloc(2048));
    try {
      await fs.symlink(outside, path.join(runDirectory, "linked.mp4"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        context.skip("Symlink creation is unavailable on this platform.");
        return;
      }
      throw error;
    }
    await assert.rejects(resolveFlowDownload("brand-one", "job-one", "linked.mp4", root), /not found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Flow generation rejects a symlinked account download root", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-root-symlink-"));
  try {
    const googleFlowRoot = path.join(root, "downloads", "google-flow");
    const outside = path.join(root, "outside-account");
    await fs.mkdir(googleFlowRoot, { recursive: true });
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(googleFlowRoot, "brand-one"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        context.skip("Symlink creation is unavailable on this platform.");
        return;
      }
      throw error;
    }
    await assert.rejects(prepareFlowRunDirectory("brand-one", "job-one", root), /not a real folder/);
    await assert.rejects(listFlowDownloads("brand-one", root), /not a real folder/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Flow downloads reject a symlinked downloads ancestor", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-ancestor-symlink-"));
  try {
    const outside = path.join(root, "outside-downloads");
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(root, "downloads"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        context.skip("Symlink creation is unavailable on this platform.");
        return;
      }
      throw error;
    }
    await assert.rejects(prepareFlowRunDirectory("brand-one", "job-one", root), /not a real folder/);
    await assert.rejects(resolveFlowDownload("brand-one", "job-one", "video.mp4", root), /not a real folder/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
