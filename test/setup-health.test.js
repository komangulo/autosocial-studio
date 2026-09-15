const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  countPendingVideos,
  getAllowedSetupFolderPath,
} = require("../src/setup-health");

test("countPendingVideos only counts supported video files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autosocial-health-"));
  try {
    fs.writeFileSync(path.join(dir, "clip-a.mp4"), "");
    fs.writeFileSync(path.join(dir, "clip-b.MOV"), "");
    fs.writeFileSync(path.join(dir, "caption.txt"), "");
    fs.mkdirSync(path.join(dir, "nested"));

    assert.equal(countPendingVideos(dir), 2);
    assert.equal(countPendingVideos(path.join(dir, "missing")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup folder resolver only exposes known onboarding folders", () => {
  const tiktokPath = getAllowedSetupFolderPath("tiktokPending", "default");
  const instagramPath = getAllowedSetupFolderPath("instagramPending", "default");
  const youtubePath = getAllowedSetupFolderPath("youtubePending", "default");

  assert.match(tiktokPath, /queue[\\/]default[\\/]tiktok[\\/]pending$/);
  assert.match(instagramPath, /queue[\\/]default[\\/]instagram[\\/]pending$/);
  assert.match(youtubePath, /queue[\\/]default[\\/]youtube[\\/]pending$/);
  assert.equal(getAllowedSetupFolderPath("../.env", "default"), null);
  assert.equal(getAllowedSetupFolderPath("C:\\Windows", "default"), null);
});
