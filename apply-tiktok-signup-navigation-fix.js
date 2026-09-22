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

const source = fs.readFileSync(sourcePath, "utf8");
if (source.includes("channel.click({ force: true })") && source.includes("waitForURL(/\\/signup\\/phone-or-email\\/email/i")) {
  console.log("La correccion de navegacion ya esta aplicada.");
  process.exit(0);
}

const oldBlock = `async function prepareTikTokSignup(page) {
  const channel = page
    .locator('[data-e2e="channel-item"]')
    .filter({ hasText: "Use phone or email" })
    .first();
  await channel.waitFor({ state: "visible", timeout: 20000 });
  await channel.click();

  const emailLink = page.locator('a[href="/signup/phone-or-email/email"]').first();
  await emailLink.waitFor({ state: "visible", timeout: 20000 });
  await emailLink.click();
  await selectTikTokSignupDate(page);
}`;

const newBlock = `async function prepareTikTokSignup(page) {
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
}`;

let updatedSource;
if (source.includes(oldBlock)) {
  updatedSource = source.replace(oldBlock, newBlock);
} else {
  const start = source.indexOf("async function prepareTikTokSignup(page) {");
  const end = source.indexOf("async function startAssistedTikTokAccountSetup", start);
  if (start < 0 || end < 0) {
    fail("No encuentro prepareTikTokSignup ni el flujo asistido. Aplica primero el ZIP del panel asistido.");
  }
  updatedSource = `${source.slice(0, start)}${newBlock}\n\n${source.slice(end)}`;
}

const backupPath = `${sourcePath}.backup-signup-navigation-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(sourcePath, backupPath);
fs.writeFileSync(sourcePath, updatedSource);
console.log("Correccion de navegacion TikTok aplicada.");
console.log(`Copia de seguridad: ${backupPath}`);
