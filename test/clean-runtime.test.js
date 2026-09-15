const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { collectCleanupTargets, removeTargets } = require("../scripts/clean-runtime");

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x");
}

test("clean debug targets only include screenshots and dashboard logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autosocial-clean-"));
  try {
    const expectedTargets = [
      path.join(root, ".dashboard.out.log"),
      path.join(root, ".local", "dashboard.err.log"),
      path.join(root, ".local", "dashboard.out.log"),
      path.join(root, "last-upload-error.png"),
      path.join(root, "last-youtube-upload-success.png"),
      path.join(root, "qa-setup.png"),
    ];
    for (const target of expectedTargets) {
      touch(target);
    }

    const preserved = [
      path.join(root, ".env"),
      path.join(root, ".profiles", "default", "tiktok", "session"),
      path.join(root, "accounts-state.json"),
      path.join(root, "queue", "default", "tiktok", "pending", "video.mp4"),
    ];
    for (const target of preserved) {
      touch(target);
    }

    assert.deepEqual(collectCleanupTargets(root), expectedTargets.sort());

    removeTargets(collectCleanupTargets(root));

    for (const target of expectedTargets) {
      assert.equal(fs.existsSync(target), false);
    }
    for (const target of preserved) {
      assert.equal(fs.existsSync(target), true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
