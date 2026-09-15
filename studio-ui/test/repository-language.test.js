const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
// AutoSocial Studio ships a Spanish-facing product surface (UI copy, module
// docs and the AndroidClone/Competencia/Helios guides). Those files are
// intentionally localized and are excluded from the English-ASCII policy.
const localizedProductPaths = [
  "src/platform-ui-labels.js",
  "test/repository-language.test.js",
  "web/androidclone.js",
  "web/app.js",
  "web/index.html",
  "web/studio-assets/studio.js",
  "electron/main.js",
  "src/androidclone/",
  "src/competitor/",
  "studio-ui/src/helios/",
  "autodownload/yt-dlp.exe",
  "outputs/",
  "ANDROIDCLONE.md",
  "COMPETENCIA.md",
  "CUESTIONARIO.md",
  "HELIOS.md",
  "PLAN.md",
  "INSTALAR-ANDROIDCLONE.bat",
  "INSTALAR-COMPETENCIA.bat",
  "ANDROIDCLONE.bat",
];
const isLocalizedProductFile = (filePath) =>
  localizedProductPaths.some((entry) => (entry.endsWith("/") ? filePath.startsWith(entry) : filePath === entry));
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot"]);
const localizedTermHex = [
  "776569746572",
  "7465696c656e",
  "706f7374656e",
  "626573636872656962756e67",
  "626573636872656962",
  "617573776165686c656e",
  "6175737761686c656e",
  "6461746569",
  "6461746569656e",
  "686f63686c6164656e",
  "7665726f656666656e746c696368656e",
  "7665726f656666656e746c69636874",
  "6f656666656e746c696368",
  "73706569636865726e",
  "7a7573636861756572",
  "6665686c6572",
  "67657465696c74",
  "62656974726167",
  "6d6f65676c696368",
  "6d6f676c696368",
  "6b6f6e6e7465",
  "6e69636874",
  "766f6d20636f6d7075746572",
  "766964656f7320686f63686c6164656e",
  "766964656f207775726465",
  "7665726172626569746574",
  "6e65696e",
  "65727374656c6c656e",
  "737061746572",
  "73706165746572",
  "61626272656368656e",
  "7363686c69657373656e",
  "626573746165746967656e",
  "666f727466616872656e",
  "6572666f6c677265696368",
  "6765706c616e74",
  "7072756566756e67",
  "70727566756e67",
  "696e68616c74737072756566756e67",
  "616b746976696572656e",
  "65696e736368616c74656e",
  "7665727374616e64656e",
  "65726e657574",
  "76657273756368656e",
];
const localizedTerms = localizedTermHex.map((value) => Buffer.from(value, "hex").toString("utf8"));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLocalizedTerm(content) {
  return localizedTerms.some((term) => {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`, "i");
    return pattern.test(content);
  });
}

function getTrackedFiles() {
  const result = spawnSync("git", ["ls-files"], { cwd: projectRoot, encoding: "utf8" });
  let files;
  if (result.status === 0) {
    files = result.stdout.split(/\r?\n/).filter(Boolean);
  } else {
    const walk = (directory, prefix = "") => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if ([".git", "node_modules", ".runtime", ".profiles", "queue"].includes(entry.name)) return [];
      const relative = path.join(prefix, entry.name).replace(/\\/g, "/");
      return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
    });
    files = walk(projectRoot);
  }
  return files
    .filter((filePath) => !isLocalizedProductFile(filePath))
    .filter((filePath) => !binaryExtensions.has(path.extname(filePath).toLowerCase()));
}

test("public-facing tracked text files are English-only ASCII", () => {
  const failures = [];

  for (const relativePath of getTrackedFiles()) {
    const absolutePath = path.join(projectRoot, relativePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    if (/[^\x00-\x7F]/.test(content) || hasLocalizedTerm(content)) {
      failures.push(relativePath);
    }
  }

  assert.deepEqual(failures, []);
});
