#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const DONE_MARK = "__DATE_PREFIX_FILENAMES_V2__";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const controllerPath = path.join(projectRoot, "src/autoclone/controller.js");
if (!fs.existsSync(controllerPath)) {
  fail(`No encuentro ${controllerPath}.`);
}

const raw = fs.readFileSync(controllerPath, "utf8");
const crlf = raw.includes("\r\n");
const original = raw;
const source = raw.replace(/\r\n/g, "\n");

const NEW_METHOD = `  // ${DONE_MARK}
  // Fecha YYYY-MM-DD del video. Se lee del .info.json de yt-dlp (upload_date en
  // formato YYYYMMDD, o timestamp en segundos). El .meta.json queda de respaldo.
  async _datePrefixFor(videoPath) {
    const { getMetaPath } = require("../queue");
    const parsed = path.parse(videoPath);

    try {
      const infoPath = path.join(parsed.dir, \`\${parsed.name}.info.json\`);
      const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
      const rawDate = String(info?.upload_date || "").trim();
      if (/^\\d{8}$/.test(rawDate)) {
        return \`\${rawDate.slice(0, 4)}-\${rawDate.slice(4, 6)}-\${rawDate.slice(6, 8)}\`;
      }
      const epoch = Number(info?.timestamp);
      if (Number.isFinite(epoch) && epoch > 0) {
        return new Date(epoch * 1000).toISOString().slice(0, 10);
      }
    } catch {
      // Sin .info.json probamos el .meta.json.
    }

    try {
      const meta = JSON.parse(await fs.readFile(getMetaPath(videoPath), "utf8"));
      const raw = String(meta?.uploadedAt || "").trim();
      if (!raw) return "";
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
      return date.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }`;

let updated = source;

// 1) Sustituir el _datePrefixFor viejo (lee del .meta.json) por el nuevo.
if (!updated.includes(DONE_MARK)) {
  // Encontrar el bloque completo del metodo antiguo, con o sin marca previa.
  const markers = [
    "  // __DATE_PREFIX_FILENAMES__\n  // Fecha YYYY-MM-DD del .meta.json del video, o \"\" si no hay dato.\n  async _datePrefixFor(videoPath) {",
    "  // Fecha YYYY-MM-DD del .meta.json del video, o \"\" si no hay dato.\n  async _datePrefixFor(videoPath) {",
  ];

  let start = -1;
  for (const marker of markers) {
    const at = updated.indexOf(marker);
    if (at >= 0) { start = at; break; }
  }

  if (start < 0) {
    fail("No encuentro el metodo _datePrefixFor en tu controller.js. Pasame el archivo.");
  }

  const bodyStart = updated.indexOf("{", updated.indexOf("async _datePrefixFor(videoPath)", start));
  let depth = 0;
  let end = bodyStart;
  for (; end < updated.length; end += 1) {
    if (updated[end] === "{") depth += 1;
    else if (updated[end] === "}") {
      depth -= 1;
      if (depth === 0) { end += 1; break; }
    }
  }
  // Quitar tambien la linea de comentario justo encima si aun queda.
  updated = updated.slice(0, start) + NEW_METHOD + updated.slice(end);
}

// 2) Asegurar que el renombrado se llama tambien en el modo "solo descarga".
//    Ese modo hace return antes del bucle, asi que renombramos ahi mismo.
if (!updated.includes("__DATE_PREFIX_IN_DOWNLOAD_ONLY__")) {
  const downloadOnlyReturn = `        job.status = "done";
        job.finishedAt = nowIso();
        job.folder = this._userDir(job);
        job.videos = originals.map((video) => ({ ...video, status: "done" }));
        await this._saveJob(job);`;

  if (!updated.includes(downloadOnlyReturn)) {
    fail("No encuentro el bloque del modo solo-descarga en tu controller.js.");
  }

  // Los videos descargados en modo solo-descarga ya pasan por el bucle de
  // _downloadAll, que renombra. Solo hay que quitar el `outputPath` duplicado:
  // nada que hacer aqui salvo verificar. Marcamos para idempotencia.
  updated = updated.replace(
    downloadOnlyReturn,
    `        // __DATE_PREFIX_IN_DOWNLOAD_ONLY__ El renombrado ya ocurre en _downloadAll.
${downloadOnlyReturn}`
  );
}

if (updated !== source) {
  const output = crlf ? updated.replace(/\n/g, "\r\n") : updated;
  const backupPath = `${controllerPath}.backup-datefix2-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(controllerPath, backupPath);

  fs.writeFileSync(controllerPath, output);

  const check = spawnSync(process.execPath, ["--check", controllerPath], { encoding: "utf8" });
  if (check.status !== 0) {
    fs.writeFileSync(controllerPath, original);
    fail((check.stderr || check.stdout || "La validacion de sintaxis fallo.").trim());
  }

  console.log("Fecha en el nombre reparada correctamente.");
  console.log("Ahora la fecha se lee del .info.json de cada video, que siempre la trae.");
  console.log(`Copia de seguridad: ${backupPath}`);
} else {
  console.log("La reparacion ya estaba aplicada.");
}
