const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { getNextQueuedItem, listQueueVideos } = require("../src/queue");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autosocial-queue-"));
}

test("listQueueVideos returns only supported videos in sorted order", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, "b.mov"), "");
  await fs.writeFile(path.join(dir, "a.mp4"), "");
  await fs.writeFile(path.join(dir, "notes.txt"), "");

  const videos = await listQueueVideos(dir);

  assert.deepEqual(
    videos.map((filePath) => path.basename(filePath)),
    ["a.mp4", "b.mov"]
  );
});

test("getNextQueuedItem reads .description before .txt sidecars", async () => {
  const dir = await makeTempDir();
  const videoPath = path.join(dir, "clip.mp4");
  await fs.writeFile(videoPath, "");
  await fs.writeFile(path.join(dir, "clip.txt"), "txt caption");
  await fs.writeFile(path.join(dir, "clip.description"), "description caption");

  const item = await getNextQueuedItem(dir);

  assert.equal(item.videoPath, videoPath);
  assert.equal(item.caption, "description caption");
  assert.deepEqual(
    item.captionPaths.map((filePath) => path.basename(filePath)),
    ["clip.description", "clip.txt"]
  );
});
