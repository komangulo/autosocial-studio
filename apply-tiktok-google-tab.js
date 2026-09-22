#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const sourcePath = path.join(projectRoot, "src", "tiktok-uploader.js");

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourcePath)) {
  fail(`No encuentro ${sourcePath}.`);
}

let source = fs.readFileSync(sourcePath, "utf8");
if (source.includes("async function openGoogleTab(context, currentPage)")) {
  console.log("La pestana de Google ya esta aplicada.");
  process.exit(0);
}

const anchor = "async function startAssistedTikTokAccountSetup(accountId) {";
const anchorIndex = source.indexOf(anchor);
if (anchorIndex < 0) {
  fail("No encuentro startAssistedTikTokAccountSetup. Aplica primero el reparador del flujo de cuentas.");
}

const callAnchor = `  if (!alreadyOpen || !/tiktok\\.com/i.test(page.url())) {
    await page.goto("https://www.tiktok.com/signup", { waitUntil: "domcontentloaded" });
  }
`;
if (!source.includes(callAnchor)) {
  fail("No encuentro el bloque de navegacion de TikTok dentro del flujo asistido.");
}

const helper = [
  "async function openGoogleTab(context, currentPage) {",
  "  const existing = context.pages().find((tab) => /google\\./i.test(tab.url()));",
  "  if (existing) {",
  "    await existing.bringToFront().catch(() => {});",
  "    return existing;",
  "  }",
  "  const tab = await context.newPage();",
  "  await tab.goto(\"https://www.google.es/\", { waitUntil: \"domcontentloaded\" }).catch(() => {});",
  "  await currentPage?.bringToFront().catch(() => {});",
  "  return tab;",
  "}",
  "",
  "",
].join("\n");

source = source.slice(0, anchorIndex) + helper + source.slice(anchorIndex);
source = source.replace(callAnchor, `${callAnchor}  await openGoogleTab(context, page);\n`);

const backupPath = `${sourcePath}.backup-google-tab-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(sourcePath, backupPath);
fs.writeFileSync(sourcePath, source);

const check = require("node:child_process").spawnSync(process.execPath, ["--check", sourcePath], { encoding: "utf8" });
if (check.status !== 0) {
  fs.copyFileSync(backupPath, sourcePath);
  fail((check.stderr || check.stdout || "La validacion de sintaxis fallo.").trim());
}

console.log("Pestana de Google anadida al flujo asistido.");
console.log(`Archivo actualizado: ${sourcePath}`);
console.log(`Copia de seguridad: ${backupPath}`);
