#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const sourcePath = path.join(projectRoot, "src", "tiktok-uploader.js");
const patchPath = path.join(__dirname, "tiktok-popup-fix.patch");

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourcePath)) {
  fail(`No encuentro ${sourcePath}. Pasa la carpeta del proyecto como argumento.`);
}

if (!fs.existsSync(patchPath)) {
  fail(`Falta ${patchPath}. Manten este script junto al archivo .patch.`);
}

const originalSource = fs.readFileSync(sourcePath, "utf8");

function isFixed(source) {
  return (
    source.includes("async function retryFinalActionButton(page, scheduleMode)") &&
    source.includes("scheduleMode = false") &&
    source.includes("retryFinalActionButton(page, scheduleMode)") &&
    source.includes("waitForPublishConfirmation(page, publishResponseTracker, scheduleMode)")
  );
}

if (isFixed(originalSource)) {
  console.log("La correccion ya esta aplicada.");
  process.exit(0);
}

function applyFallback(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let updated = source;
  let changed = false;

  if (!updated.includes("async function retryFinalActionButton(page, scheduleMode)")) {
    const marker = "function formatScheduleDate(";
    const markerIndex = updated.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error("No encuentro el punto de insercion de retryFinalActionButton.");
    }

    const helper = [
      "async function retryFinalActionButton(page, scheduleMode) {",
      "  if (!scheduleMode) return tryClickPublishButton(page);",
      "",
      "  try {",
      "    await clickScheduleButton(page);",
      "    return true;",
      "  } catch (error) {",
      "    console.log(`Could not retry TikTok Schedule button: ${error.message}`);",
      "    return false;",
      "  }",
      "}",
      "",
    ].join(eol);
    updated = updated.slice(0, markerIndex) + helper + updated.slice(markerIndex);
    changed = true;
  }

  const oldDisabledFilter = 'element.offsetParent !== null && element.getAttribute("aria-disabled") !== "true"';
  const newDisabledFilter = 'element.offsetParent !== null && !element.disabled && element.getAttribute("aria-disabled") !== "true"';
  if (updated.includes(oldDisabledFilter)) {
    updated = updated.replaceAll(oldDisabledFilter, newDisabledFilter);
    changed = true;
  }

  const oldSignature = "async function waitForPublishConfirmation(page, responseTracker)";
  const newSignature = "async function waitForPublishConfirmation(page, responseTracker, scheduleMode = false)";
  if (updated.includes(oldSignature)) {
    updated = updated.replace(oldSignature, newSignature);
    changed = true;
  }

  const confirmationStart = updated.indexOf("async function waitForPublishConfirmation");
  const uploadStart = updated.indexOf("async function uploadVideo", confirmationStart);
  if (confirmationStart < 0 || uploadStart < 0) {
    throw new Error("No encuentro el flujo de confirmacion de TikTok.");
  }

  let confirmation = updated.slice(confirmationStart, uploadStart);
  if (!confirmation.includes("const finalActionLabel = scheduleMode")) {
    const retryLine = /([ \t]+let primaryRetryCount = 0;\r?\n)/;
    if (!retryLine.test(confirmation)) {
      throw new Error("No encuentro primaryRetryCount en el flujo de confirmacion.");
    }
    confirmation = confirmation.replace(
      retryLine,
      (line) => `${line}  const finalActionLabel = scheduleMode ? "Schedule" : "Publish";${eol}`
    );
    changed = true;
  }

  if (confirmation.includes("await tryClickPublishButton(page)")) {
    confirmation = confirmation.replaceAll(
      "await tryClickPublishButton(page)",
      "await retryFinalActionButton(page, scheduleMode)"
    );
    changed = true;
  }

  const logReplacements = [
    ["\"Popup restringido cerrado y Publicar pulsado de nuevo.\"", "`Popup restringido cerrado y ${finalActionLabel} pulsado de nuevo.`"],
    ["\"Popup restringido cerrado; el boton esta listo pero no consegui pulsarlo.\"", "`Popup restringido cerrado; el boton ${finalActionLabel} esta listo pero no consegui pulsarlo.`"],
    ["\"Popup restringido cerrado, pero el boton Publicar no volvio a estar disponible.\"", "`Popup restringido cerrado, pero el boton ${finalActionLabel} no volvio a estar disponible.`"],
    ["\"Popup restringido cerrado, pero no encontre el boton Publicar.\"", "`Popup restringido cerrado, pero no encontre el boton ${finalActionLabel}.`"],
    ["\"No publish confirmation yet; retrying the primary TikTok Post button.\"", "`No ${finalActionLabel.toLowerCase()} confirmation yet; retrying the TikTok ${finalActionLabel} button.`"],
  ];
  for (const [from, to] of logReplacements) {
    if (confirmation.includes(from)) {
      confirmation = confirmation.replaceAll(from, to);
      changed = true;
    }
  }

  updated = updated.slice(0, confirmationStart) + confirmation + updated.slice(uploadStart);
  const oldCall = "waitForPublishConfirmation(page, publishResponseTracker)";
  const newCall = "waitForPublishConfirmation(page, publishResponseTracker, scheduleMode)";
  if (updated.includes(oldCall)) {
    updated = updated.replace(oldCall, newCall);
    changed = true;
  }

  if (!changed || !isFixed(updated)) {
    throw new Error("La estructura de src/tiktok-uploader.js no coincide con una version compatible.");
  }
  return updated;
}

const check = spawnSync("git", ["apply", "--check", patchPath], {
  cwd: projectRoot,
  encoding: "utf8",
});

if (check.status === 0) {
  const backupPath = `${sourcePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(sourcePath, backupPath);
  const result = spawnSync("git", ["apply", patchPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fs.copyFileSync(backupPath, sourcePath);
    fail((result.stderr || result.stdout || "No se pudo aplicar el parche.").trim());
  }
  console.log("Correccion aplicada correctamente.");
  console.log(`Archivo actualizado: ${sourcePath}`);
  console.log(`Copia de seguridad: ${backupPath}`);
  process.exit(0);
}

let updatedSource;
try {
  updatedSource = applyFallback(originalSource);
} catch (error) {
  fail(`${(check.stderr || check.stdout || "El parche exacto no aplica.").trim()}\n${error.message}`);
}

const backupPath = `${sourcePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(sourcePath, backupPath);
fs.writeFileSync(sourcePath, updatedSource);
console.log("Correccion aplicada correctamente mediante Node.");
console.log(`Archivo actualizado: ${sourcePath}`);
console.log(`Copia de seguridad: ${backupPath}`);
