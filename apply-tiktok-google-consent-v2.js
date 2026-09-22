#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

const waitMarker = "await page.waitForTimeout(10000);";
if (source.includes(waitMarker) && source.includes("button.fc-cta-consent")) {
  console.log("La espera y el segundo consentimiento de Google ya estan aplicados.");
  process.exit(0);
}

const oldBlock = `async function acceptGoogleConsent(page) {
  const button = page.locator("#cmpwelcomebtnyes a, #cmpwelcomebtnyes").first();
  try {
    await button.waitFor({ state: "visible", timeout: 12000 });
    await button.click({ force: true });
  } catch {
    // Sin banner de consentimiento: continuamos.
  }
}`;

const oldBlockAlt = `  const tab = await context.newPage();
  await tab.goto("https://www.google.es/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await currentPage?.bringToFront().catch(() => {});
  return tab;
}`;

const newBlock = `async function clickIfVisible(page, selector, timeout) {
  const button = page.locator(selector).first();
  try {
    await button.waitFor({ state: "visible", timeout });
    await button.click({ force: true });
    return true;
  } catch {
    return false;
  }
}

async function acceptGoogleConsent(page) {
  await page.waitForTimeout(10000);
  await clickIfVisible(page, "#cmpwelcomebtnyes a, #cmpwelcomebtnyes", 12000);
  await page.waitForTimeout(1500);
  await clickIfVisible(page, "button.fc-cta-consent, button[aria-label='Consent']", 12000);
}`;

const newBlockAlt = `  const tab = await context.newPage();
  await tab.goto("https://www.google.es/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await acceptGoogleConsent(tab);
  await currentPage?.bringToFront().catch(() => {});
  return tab;
}

${newBlock}`;

if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
} else if (source.includes(oldBlockAlt) && source.includes("async function openGoogleTab(context, currentPage)")) {
  source = source.replace(oldBlockAlt, newBlockAlt);
} else {
  const start = source.indexOf("async function acceptGoogleConsent(page) {");
  const end = source.indexOf("async function startAssistedTikTokAccountSetup", start);
  if (start < 0 || end < 0) {
    fail("No encuentro openGoogleTab ni acceptGoogleConsent. Aplica primero el ZIP de la pestana de Google.");
  }
  source = `${source.slice(0, start)}${newBlock}\n\n${source.slice(end)}`;
}

const backupPath = `${sourcePath}.backup-google-wait-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(sourcePath, backupPath);
fs.writeFileSync(sourcePath, source);

const check = spawnSync(process.execPath, ["--check", sourcePath], { encoding: "utf8" });
if (check.status !== 0) {
  fs.copyFileSync(backupPath, sourcePath);
  fail((check.stderr || check.stdout || "La validacion de sintaxis fallo.").trim());
}

console.log("Espera de 10s y doble consentimiento de Google aplicados.");
console.log(`Copia de seguridad: ${backupPath}`);
