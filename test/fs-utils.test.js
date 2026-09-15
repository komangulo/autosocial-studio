const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { moveWithTimestamp } = require("../src/fs-utils");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autosocial-fs-"));
}

test("moveWithTimestamp archives a file without losing content", async () => {
  const root = await makeTempDir();
  const source = path.join(root, "source video.mp4");
  const archiveDir = path.join(root, "posted");
  await fs.mkdir(archiveDir);
  await fs.writeFile(source, "video-content");

  const archivedPath = await moveWithTimestamp(source, archiveDir);

  assert.equal(await fs.readFile(archivedPath, "utf8"), "video-content");
  await assert.rejects(fs.access(source));
  assert.equal(path.dirname(archivedPath), archiveDir);
  assert.match(path.basename(archivedPath), /source_video_[a-f0-9]{8}\.mp4$/);
});
