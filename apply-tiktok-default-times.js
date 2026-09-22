#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const oldTimes = "10:00, 15:00, 20:00";
const newTimes = "09:30, 17:40, 22:20";
const candidateFiles = [
  path.join(projectRoot, "web", "index.html"),
  path.join(projectRoot, "studio-ui", "web", "index.html"),
];

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const files = candidateFiles.filter((filePath) => fs.existsSync(filePath));
if (!files.length) {
  fail(`No encuentro web/index.html dentro de ${projectRoot}.`);
}

let changed = 0;
for (const filePath of files) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(`value="${newTimes}"`)) continue;

  const exact = `value="${oldTimes}"`;
  let updated = source.replace(exact, `value="${newTimes}"`);
  if (updated === source) {
    updated = source.replace(
      /(<input\b[^>]*\bid=["']apTimes["'][^>]*\bvalue=["'])10:00\s*,\s*15:00\s*,\s*20:00(["'])/,
      `$1${newTimes}$2`
    );
  }
  if (updated === source) continue;

  const backupPath = `${filePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(filePath, backupPath);
  fs.writeFileSync(filePath, updated);
  changed += 1;
  console.log(`Archivo actualizado: ${filePath}`);
  console.log(`Copia de seguridad: ${backupPath}`);
}

if (!changed) {
  if (files.some((filePath) => fs.readFileSync(filePath, "utf8").includes(`value="${newTimes}"`))) {
    console.log(`Los horarios ya son ${newTimes}.`);
    process.exit(0);
  }
  fail(`No encontre el valor predeterminado ${oldTimes} asociado a apTimes.`);
}

console.log(`Horarios predeterminados de TikTok cambiados a: ${newTimes}`);
