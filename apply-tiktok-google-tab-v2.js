#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const sourcePath = path.join(projectRoot, "src", "tiktok-uploader.js");
const googleUrl = "https://www.google.es/";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function clickIfVisibleFunction() {
  return [
    "async function clickIfVisible(page, selector, timeout) {",
    "  const button = page.locator(selector).first();",
    "  try {",
    "    await button.waitFor({ state: \"visible\", timeout });",
    "    await button.click({ force: true });",
    "    return true;",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
  ].join("\n");
}

function acceptConsentFunction() {
  return [
    "async function acceptGoogleConsent(page) {",
    "  await page.waitForTimeout(10000);",
    "  await clickIfVisible(page, \"#cmpwelcomebtnyes a, #cmpwelcomebtnyes\", 12000);",
    "  await page.waitForTimeout(1500);",
    "  await clickIfVisible(page, \"button.fc-cta-consent, button[aria-label='Consent']\", 12000);",
    "}",
  ].join("\n");
}

if (!fs.existsSync(sourcePath)) {
  fail(`No encuentro ${sourcePath}.`);
}

let source = fs.readFileSync(sourcePath, "utf8");

const newTabBlock = [
  "  const tab = await context.newPage();",
  `  await tab.goto("${googleUrl}", { waitUntil: "domcontentloaded" }).catch(() => {});`,
  "  await acceptGoogleConsent(tab);",
  "  await currentPage?.bringToFront().catch(() => {});",
  "  return tab;",
  "}",
].join("\n");

const openGoogleTabFunction = [
  "async function openGoogleTab(context, currentPage) {",
  "  const existing = context.pages().find((tab) => /google\\./i.test(tab.url()));",
  "  if (existing) {",
  "    await existing.bringToFront().catch(() => {});",
  "    return existing;",
  "  }",
  newTabBlock,
].join("\n");

if (source.includes("waitForTimeout(10000)") && source.includes("fc-cta-consent")) {
  console.log("La pestana de Google y el consentimiento ya estan aplicados.");
  process.exit(0);
}

const anchor = "async function startAssistedTikTokAccountSetup(accountId) {";
const anchorIndex = source.indexOf(anchor);
if (anchorIndex < 0) {
  fail("No encuentro startAssistedTikTokAccountSetup. Aplica primero el ZIP del panel asistido.");
}

const helperBlock = `${openGoogleTabFunction}

${clickIfVisibleFunction()}

${acceptConsentFunction()}

`;

source = source.slice(0, anchorIndex) + helperBlock + source.slice(anchorIndex);

const callAnchor = `  if (!alreadyOpen || !/tiktok\\.com/i.test(page.url())) {
    await page.goto("https://www.tiktok.com/signup", { waitUntil: "domcontentloaded" });
  }
`;
if (!source.includes(callAnchor)) {
  fail("No encuentro el bloque de navegacion de TikTok dentro del flujo asistido.");
}
if (!source.includes("await openGoogleTab(context, page);")) {
  source = source.replace(callAnchor, `${callAnchor}  await openGoogleTab(context, page);\n`);
}

const backupPath = `${sourcePath}.backup-google-tab-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(sourcePath, backupPath);
fs.writeFileSync(sourcePath, source);

const check = spawnSync(process.execPath, ["--check", sourcePath], { encoding: "utf8" });
if (check.status !== 0) {
  fs.copyFileSync(backupPath, sourcePath);
  fail((check.stderr || check.stdout || "La validacion de sintaxis fallo.").trim());
}

console.log("Pestana de Google, espera de 10s y doble consentimiento aplicados.");
console.log(`Archivo actualizado: ${sourcePath}`);
console.log(`Copia de seguridad: ${backupPath}`);
