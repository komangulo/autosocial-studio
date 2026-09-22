#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const patchPath = path.join(__dirname, "tiktok-assisted-account-panel.patch");
const files = [
  "src/dashboard-server.js",
  "src/tiktok-uploader.js",
  "web/app.js",
  "web/index.html",
];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(patchPath)) {
  fail(`Falta ${patchPath}. Manten este script junto al archivo .patch.`);
}

for (const relativePath of files) {
  if (!fs.existsSync(path.join(projectRoot, relativePath))) {
    fail(`No encuentro ${path.join(projectRoot, relativePath)}.`);
  }
}

const markerSource = fs.readFileSync(path.join(projectRoot, "src", "dashboard-server.js"), "utf8");
const markerUi = fs.readFileSync(path.join(projectRoot, "web", "app.js"), "utf8");
if (markerSource.includes("/api/account-manager/create-assisted") && markerUi.includes("createTikTokAccountBtn")) {
  console.log("El panel de creacion asistida ya esta aplicado.");
  process.exit(0);
}

function runGit(args) {
  return spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

const check = runGit(["apply", "--check", patchPath]);
if (check.status !== 0) {
  const reverse = runGit(["apply", "--reverse", "--check", patchPath]);
  if (reverse.status === 0) {
    console.log("El panel de creacion asistida ya esta aplicado.");
    process.exit(0);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backups = [];
for (const relativePath of files) {
  const sourcePath = path.join(projectRoot, relativePath);
  const backupPath = `${sourcePath}.backup-assisted-account-${stamp}`;
  fs.copyFileSync(sourcePath, backupPath);
  backups.push({ sourcePath, backupPath });
}

const result = check.status === 0
  ? runGit(["apply", patchPath])
  : runGit(["apply", "--3way", patchPath]);
if (result.status !== 0) {
  for (const { sourcePath, backupPath } of backups) {
    fs.copyFileSync(backupPath, sourcePath);
  }
  fail((result.stderr || result.stdout || "No se pudo aplicar el panel.").trim());
}

console.log("Panel de creacion asistida aplicado correctamente.");
console.log("El boton abre un perfil persistente separado y el registro manual de TikTok.");
console.log("La contrasena, el CAPTCHA y el codigo de verificacion deben completarse manualmente.");
for (const { backupPath } of backups) {
  console.log(`Copia de seguridad: ${backupPath}`);
}
