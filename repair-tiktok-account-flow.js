#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const patchPath = path.join(__dirname, "tiktok-assisted-account-panel.patch");
const panelFiles = [
  "src/dashboard-server.js",
  "src/tiktok-uploader.js",
  "web/app.js",
  "web/index.html",
];
const backups = [];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function runGit(args) {
  return spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function panelInstalled() {
  return (
    read("src/dashboard-server.js").includes("/api/account-manager/create-assisted") &&
    read("web/app.js").includes("createTikTokAccountBtn") &&
    read("src/tiktok-uploader.js").includes("startAssistedTikTokAccountSetup")
  );
}

if (!fs.existsSync(patchPath)) {
  fail(`Falta ${patchPath}. Manten este script junto al archivo .patch.`);
}
for (const relativePath of panelFiles) {
  if (!fs.existsSync(path.join(projectRoot, relativePath))) {
    fail(`No encuentro ${path.join(projectRoot, relativePath)}.`);
  }
}

if (!panelInstalled()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const relativePath of panelFiles) {
    const sourcePath = path.join(projectRoot, relativePath);
    const backupPath = `${sourcePath}.backup-account-flow-${stamp}`;
    fs.copyFileSync(sourcePath, backupPath);
    backups.push({ sourcePath, backupPath });
  }

  const check = runGit(["apply", "--check", patchPath]);
  const result = check.status === 0
    ? runGit(["apply", patchPath])
    : runGit(["apply", "--3way", patchPath]);
  if (result.status !== 0 || !panelInstalled()) {
    for (const { sourcePath, backupPath } of backups) fs.copyFileSync(backupPath, sourcePath);
    fail((result.stderr || result.stdout || "No se pudo instalar el panel asistido.").trim());
  }
  console.log("Panel asistido instalado y verificado.");
} else {
  console.log("Panel asistido ya estaba instalado.");
}

const sourcePath = path.join(projectRoot, "src", "tiktok-uploader.js");
let source = fs.readFileSync(sourcePath, "utf8");
const fixedMarker = "channel.click({ force: true })";
const navigationBlock = `async function selectTikTokSignupDate(page) {
  const fields = [
    { label: "Month", value: "April" },
    { label: "Day", value: "18" },
    { label: "Year", value: "1988" },
  ];

  for (const field of fields) {
    const combobox = page.getByRole("combobox", { name: new RegExp("^" + field.label + "\\\\.") }).first();
    await combobox.waitFor({ state: "visible", timeout: 15000 });
    await combobox.click();
    const option = page.getByRole("option", { name: field.value, exact: true }).last();
    await option.waitFor({ state: "visible", timeout: 10000 });
    await option.click();
  }
}

async function prepareTikTokSignup(page) {
  const channel = page.locator('[data-e2e="channel-item"]').filter({ hasText: /Use phone or email/i }).first();
  await channel.waitFor({ state: "visible", timeout: 20000 });
  await channel.scrollIntoViewIfNeeded();
  await channel.click({ force: true });

  const emailLink = page.locator('a[href="/signup/phone-or-email/email"]').first();
  await emailLink.waitFor({ state: "visible", timeout: 20000 });
  await emailLink.scrollIntoViewIfNeeded();
  await Promise.all([
    page.waitForURL(/\\/signup\\/phone-or-email\\/email/i, { timeout: 20000 }).catch(() => {}),
    emailLink.click({ force: true }),
  ]);
  await selectTikTokSignupDate(page);
}

async function startAssistedTikTokAccountSetup(accountId) {
  const account = await requireAccount(accountId);
  const { context, alreadyOpen } = await openLoginContextForAccount(account.id);
  const page = context.pages()[0] || (await context.newPage());

  if (!alreadyOpen || !/tiktok\\.com/i.test(page.url())) {
    await page.goto("https://www.tiktok.com/signup", { waitUntil: "domcontentloaded" });
  }

  let setupMessage = "Completa manualmente el correo, la contrasena, el CAPTCHA y el codigo de verificacion.";
  let setupStage = "manual-signup";
  try {
    await prepareTikTokSignup(page);
    setupMessage = "Metodo de registro y fecha 18/04/1988 preparados. Completa manualmente el correo, la contrasena, el CAPTCHA y el codigo de verificacion.";
  } catch (error) {
    setupStage = "needs-attention";
    setupMessage = "TikTok no mostro el formulario esperado. Completa los pasos iniciales manualmente. Detalle: " + error.message;
  }

  assistedAccountSetupState = {
    accountId: account.id,
    open: true,
    stage: setupStage,
    message: setupMessage,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  return { ok: true, account, status: getAssistedAccountSetupStatus() };
}`;

if (!source.includes(fixedMarker)) {
  const start = source.indexOf("async function startAssistedTikTokAccountSetup");
  const helperStart = source.indexOf("async function selectTikTokSignupDate");
  const segmentStart = helperStart >= 0 && helperStart < start ? helperStart : start;
  const end = source.indexOf("async function confirmAssistedTikTokAccountSetup", start);
  if (start < 0 || end < 0 || segmentStart < 0) {
    fail("El panel existe, pero no encuentro el flujo asistido completo en src/tiktok-uploader.js.");
  }
  const backupPath = `${sourcePath}.backup-navigation-flow-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(sourcePath, backupPath);
  backups.push({ sourcePath, backupPath });
  source = `${source.slice(0, segmentStart)}${navigationBlock}\n\n${source.slice(end)}`;
  fs.writeFileSync(sourcePath, source);
  console.log("Navegacion inicial de TikTok corregida y verificada.");
} else {
  console.log("Navegacion inicial de TikTok ya estaba corregida.");
}

for (const relativePath of ["src/dashboard-server.js", "src/tiktok-uploader.js", "web/app.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(projectRoot, relativePath)], { encoding: "utf8" });
  if (result.status !== 0) {
    for (const { sourcePath: filePath, backupPath } of backups) fs.copyFileSync(backupPath, filePath);
    fail((result.stderr || result.stdout || "La validacion de sintaxis fallo.").trim());
  }
}

console.log("Flujo de cuenta TikTok reparado correctamente.");
console.log("Cierra y reinicia el dashboard antes de volver a pulsar Crear cuenta TikTok.");
