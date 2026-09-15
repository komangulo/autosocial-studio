const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { UniquifierController } = require("../src/uniquifier-controller");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "autosocial-uniquifier-"));
}

test("UniquifierController accepts optional user logo paths", async () => {
  const root = await makeTempDir();
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const logoPath = path.join(root, "logo.png");
  await fs.writeFile(logoPath, "");

  const controller = new UniquifierController();

  const withLogo = await controller.setFolders({
    inputDir,
    outputDir,
    logoImage: logoPath,
  });
  assert.equal(withLogo.logoImage, logoPath);

  const withoutLogo = await controller.setFolders({
    logoImage: "",
  });
  assert.equal(withoutLogo.logoImage, "");
});
