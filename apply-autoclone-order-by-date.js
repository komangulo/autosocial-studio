#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const DONE_MARK = "__ORDER_BY_UPLOAD_DATE__";

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(projectRoot, "src"))) {
  fail(`No encuentro el proyecto en ${projectRoot}.`);
}

const FILES = [
  "src/video-meta.js",
  "src/autoclone/scheduler.js",
  "src/autoclone/controller.js",
  "src/autoclone/index.js",
  "src/dashboard-server.js",
  "web/autoclone.js",
  "web/index.html",
];

for (const relativePath of FILES) {
  if (!fs.existsSync(path.join(projectRoot, relativePath))) {
    fail(`No encuentro ${path.join(projectRoot, relativePath)}.`);
  }
}

const originals = new Map();
const lineEndings = new Map();
const backups = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

for (const relativePath of FILES) {
  const sourcePath = path.join(projectRoot, relativePath);
  const raw = fs.readFileSync(sourcePath, "utf8");
  lineEndings.set(relativePath, raw.includes("\r\n") ? "\r\n" : "\n");
  originals.set(relativePath, raw);
  fs.writeFileSync(sourcePath, raw.replace(/\r\n/g, "\n"));
  const backupPath = `${sourcePath}.backup-orderbydate-${stamp}`;
  fs.copyFileSync(sourcePath, backupPath);
  backups.push({ sourcePath, backupPath });
}

function restoreAll() {
  for (const relativePath of FILES) {
    fs.writeFileSync(path.join(projectRoot, relativePath), originals.get(relativePath));
  }
}

function toEol(relativePath, text) {
  return lineEndings.get(relativePath) === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function write(relativePath, text) {
  fs.writeFileSync(path.join(projectRoot, relativePath), toEol(relativePath, text));
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count === 0) throw new Error(`No encuentro el bloque "${label}"`);
  if (count > 1) throw new Error(`El bloque "${label}" aparece ${count} veces, no puedo elegir uno`);
  return source.replace(from, to);
}

try {
  // ------------------------------------------------------------- video-meta.js
  let meta = read("src/video-meta.js");
  if (!meta.includes(DONE_MARK)) {
    // 1) Expose the real upload date parsing helper.
    meta = replaceOnce(
      meta,
      `function parseTranslationJson(text) {`,
      `// ${DONE_MARK}
// Fecha real de publicacion en TikTok. yt-dlp la deja en info.upload_date
// (formato YYYYMMDD) y en info.timestamp (segundos epoch). Devolvemos un
// instante ISO, o "" cuando no hay dato.
function uploadedAtFromInfoJson(info = {}) {
  const raw = String(info.upload_date || "").trim();
  if (/^\\d{8}$/.test(raw)) {
    const year = Number(raw.slice(0, 4));
    const month = Number(raw.slice(4, 6));
    const day = Number(raw.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const epoch = Number(info.timestamp);
  if (Number.isFinite(epoch) && epoch > 0) {
    const date = new Date(epoch * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function parseTranslationJson(text) {`,
      "parseTranslationJson"
    );

    // 2) Keep the upload date in the companion meta file.
    meta = replaceOnce(
      meta,
      `function metaFromInfoJson(info = {}) {
  const description = String(info.description || "").trim();
  return { description, caption: buildCaptionFromMeta({ description }) };
}`,
      `function metaFromInfoJson(info = {}) {
  const description = String(info.description || "").trim();
  const uploadedAt = uploadedAtFromInfoJson(info);
  const base = { description, caption: buildCaptionFromMeta({ description }) };
  // ${DONE_MARK}
  // La fecha de subida se guarda para poder ordenar de mas antiguo a mas nuevo.
  if (uploadedAt) base.uploadedAt = uploadedAt;
  return base;
}`,
      "metaFromInfoJson"
    );

    // 3) Export the helper.
    meta = replaceOnce(
      meta,
      `  INFO_JSON_SUFFIX,`,
      `  uploadedAtFromInfoJson, // ${DONE_MARK}
  INFO_JSON_SUFFIX,`,
      "exports"
    );

    write("src/video-meta.js", meta);
  }

  // -------------------------------------------------------- autoclone/scheduler.js
  let scheduler = read("src/autoclone/scheduler.js");
  if (!scheduler.includes(DONE_MARK)) {
    scheduler = replaceOnce(
      scheduler,
      `/** List video files directly inside a folder (non-recursive), sorted by name. */`,
      `// ${DONE_MARK}
// Ordena por fecha real de publicacion (uploadedAt) cuando existe; si falta,
// usa el downloadIndex de siempre y, en ultimo lugar, el nombre del archivo.
function orderVideos(items) {
  return items.sort((a, b) => {
    const aDate = a.uploadedAt ? Date.parse(a.uploadedAt) : NaN;
    const bDate = b.uploadedAt ? Date.parse(b.uploadedAt) : NaN;
    const aHasDate = Number.isFinite(aDate);
    const bHasDate = Number.isFinite(bDate);
    if (aHasDate && bHasDate && aDate !== bDate) return aDate - bDate;
    const aHasOrder = Number.isInteger(a.downloadIndex);
    const bHasOrder = Number.isInteger(b.downloadIndex);
    if (aHasOrder && bHasOrder && a.downloadIndex !== b.downloadIndex) {
      return a.downloadIndex - b.downloadIndex;
    }
    if (aHasDate && bHasDate) return 0;
    if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
    return a.position - b.position;
  }).map((item) => item.filePath);
}

/** List video files directly inside a folder (non-recursive), sorted by name. */`,
      "listVideos comment"
    );

    scheduler = replaceOnce(
      scheduler,
      `  const ordered = await Promise.all(files.map(async (filePath, position) => ({
    filePath,
    position,
    downloadIndex: (await readVideoMeta(filePath))?.downloadIndex,
  })));
  return ordered
    .sort((a, b) => {
      const aHasOrder = Number.isInteger(a.downloadIndex);
      const bHasOrder = Number.isInteger(b.downloadIndex);
      if (aHasOrder && bHasOrder) return a.downloadIndex - b.downloadIndex;
      if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
      return a.position - b.position;
    })
    .map((item) => item.filePath);
}`,
      `  const ordered = await Promise.all(files.map(async (filePath, position) => {
    const meta = await readVideoMeta(filePath);
    return {
      filePath,
      position,
      downloadIndex: meta?.downloadIndex,
      uploadedAt: meta?.uploadedAt,
    };
  }));
  return orderVideos(ordered);
}`,
      "listVideos body"
    );

    scheduler = replaceOnce(
      scheduler,
      `module.exports = { listVideos,`,
      `module.exports = { listVideos, orderVideos,`,
      "scheduler exports"
    );

    write("src/autoclone/scheduler.js", scheduler);
  }

  // ------------------------------------------------------- autoclone/controller.js
  let controller = read("src/autoclone/controller.js");
  if (!controller.includes(DONE_MARK)) {
    // Stamp the upload date into the companion meta right after download.
    controller = replaceOnce(
      controller,
      `        await this._stampDownloadIndex(target, index);`,
      `        await this._stampDownloadIndex(target, index);
        await this._stampUploadedAt(target, infoJsonPathFor(target)); // ${DONE_MARK}`,
      "controller stamp index"
    );

    controller = replaceOnce(
      controller,
      `  async _stampDownloadIndex(videoPath, downloadIndex) {`,
      `  // ${DONE_MARK}
  // Copia la fecha real de publicacion del .info.json al .meta.json para que
  // la subida programada pueda ordenar de mas antiguo a mas nuevo.
  async _stampUploadedAt(videoPath, infoJsonPath) {
    try {
      const { getMetaPath } = require("../queue");
      const { uploadedAtFromInfoJson } = require("../video-meta");
      const info = JSON.parse(await fs.readFile(infoJsonPath, "utf8"));
      const uploadedAt = uploadedAtFromInfoJson(info);
      if (!uploadedAt) return;
      const metaPath = getMetaPath(videoPath);
      let meta = {};
      try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch { meta = {}; }
      if (!meta || typeof meta !== "object") meta = {};
      meta.uploadedAt = uploadedAt;
      await writeJson(metaPath, meta);
    } catch {
      // Sin info.json o sin meta no se puede fechar; no es un error fatal.
    }
  }

  async _stampDownloadIndex(videoPath, downloadIndex) {`,
      "stampDownloadIndex method"
    );

    // Make sure readVideoMeta keeps uploadedAt (it already returns the whole object).
    write("src/autoclone/controller.js", controller);
  }

  // ----------------------------------------------------------- autoclone/index.js
  let router = read("src/autoclone/index.js");
  if (!router.includes('"/order-by-date"')) {
    router = replaceOnce(
      router,
      `  router.post("/destination/check", route(async (req, res) => {`,
      `  // Reordenar una carpeta de videos por la fecha real de publicacion.
  router.post("/order-by-date", route(async (req, res) => {
    const { folder } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de los videos.");
    const result = await controller.orderFolderByDate(folder);
    res.json({ ok: true, ...result });
  }));

  router.post("/destination/check", route(async (req, res) => {`,
      "destination check route"
    );
    write("src/autoclone/index.js", router);
  }
} catch (error) {
  restoreAll();
  fail(error.message);
}

// ---------------------------------------------------------------------------
// orderFolderByDate lives in the controller; add it in a second, separate pass
// so the first pass stays simple.
try {
  let controller = read("src/autoclone/controller.js");
  if (!controller.includes("async orderFolderByDate(")) {
    controller = replaceOnce(
      controller,
      `  /** Forget the download memory of one profile, so the next run starts over. */`,
      `  // ${DONE_MARK}
  // Relee cada .info.json de una carpeta y reescribe downloadIndex segun la
  // fecha real de publicacion, para arreglar carpetas ya descargadas.
  async orderFolderByDate(folder) {
    const fsPromises = require("fs/promises");
    const {
      uploadedAtFromInfoJson,
      infoJsonPathFor,
      metaJsonPathFor,
      INFO_JSON_SUFFIX,
    } = require("../video-meta");
    const { getMetaPath } = require("../queue");

    const dir = path.resolve(String(folder || ""));
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const videos = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\\.(mp4|mov|webm|avi|mkv)$/i.test(name))
      .map((name) => path.join(dir, name));

    if (!videos.length) throw new Error("No hay videos en esa carpeta.");

    const items = [];
    for (const videoPath of videos) {
      const infoPath = infoJsonPathFor(videoPath);
      let uploadedAt = "";
      let timestamp = Infinity;
      try {
        const info = JSON.parse(await fsPromises.readFile(infoPath, "utf8"));
        uploadedAt = uploadedAtFromInfoJson(info);
        const epoch = Number(info.timestamp);
        if (Number.isFinite(epoch) && epoch > 0) timestamp = epoch;
      } catch {
        // Sin info.json este video no se puede fechar; se deja al final.
      }
      items.push({ videoPath, uploadedAt, timestamp });
    }

    const conFecha = items.filter((item) => item.uploadedAt);
    const sinFecha = items.filter((item) => !item.uploadedAt);
    conFecha.sort((a, b) => a.timestamp - b.timestamp);
    const ordered = [...conFecha, ...sinFecha.sort((a, b) => a.videoPath.localeCompare(b.videoPath))];

    for (let index = 0; index < ordered.length; index += 1) {
      const { videoPath, uploadedAt } = ordered[index];
      const metaPath = getMetaPath(videoPath);
      let meta = {};
      try { meta = JSON.parse(await fsPromises.readFile(metaPath, "utf8")); } catch { meta = {}; }
      if (!meta || typeof meta !== "object") meta = {};
      meta.downloadIndex = index;
      if (uploadedAt) meta.uploadedAt = uploadedAt;
      await writeJson(metaPath, meta);
    }

    return {
      folder: dir,
      total: ordered.length,
      withDate: conFecha.length,
      withoutDate: sinFecha.length,
      order: ordered.map((item, index) => ({
        index,
        name: path.basename(item.videoPath),
        uploadedAt: item.uploadedAt || null,
      })),
    };
  }

  /** Forget the download memory of one profile, so the next run starts over. */`,
      "orderFolderByDate method"
    );
    write("src/autoclone/controller.js", controller);
  }
} catch (error) {
  restoreAll();
  fail(error.message);
}

// ---------------------------------------------------------------------- web UI
try {
  let js = read("web/autoclone.js");
  if (!js.includes("autocloneOrderByDateBtn")) {
    if (js.includes('downloadOnlyBtn: $("autocloneDownloadOnlyBtn"),')) {
      js = replaceOnce(
        js,
        `    downloadOnlyBtn: $("autocloneDownloadOnlyBtn"),`,
        `    downloadOnlyBtn: $("autocloneDownloadOnlyBtn"),
    orderByDateBtn: $("autocloneOrderByDateBtn"),`,
        "els downloadOnly"
      );
    } else {
      js = replaceOnce(
        js,
        `    startBtn: $("autocloneStartBtn"),`,
        `    startBtn: $("autocloneStartBtn"),
    orderByDateBtn: $("autocloneOrderByDateBtn"),`,
        "els startBtn"
      );
    }

    js = replaceOnce(
      js,
      `  async function cancel() {`,
      `  // Reordena la carpeta de destino por la fecha real de publicacion.
  async function orderByDate() {
    const folder = (els.destination?.value || "").trim();
    if (!folder) { els.stage.textContent = "Escribe la carpeta de los videos en 'Carpeta de destino'."; return; }
    if (!window.confirm("Reordenar los videos de " + folder + " de mas antiguo a mas nuevo?")) return;
    els.orderByDateBtn.disabled = true;
    try {
      const data = await API.post("/api/autoclone/order-by-date", { folder });
      els.stage.textContent = "Orden actualizado: " + data.withDate + " videos con fecha"
        + (data.withoutDate ? " y " + data.withoutDate + " sin fecha (al final)." : ".");
      if (data.order?.length) {
        els.videos.innerHTML = data.order.slice(0, 300).map((item, i) =>
          \`<div class="autoclone-video"><span class="autoclone-video-idx">\${i + 1}</span>\`
          + \`<div class="autoclone-video-body"><span class="autoclone-video-id">\${escapeHtmlJs(item.name)}</span>\`
          + \`<span class="autoclone-video-tags">\${item.uploadedAt ? "publicado " + escapeHtmlJs(item.uploadedAt.slice(0, 10)) : "sin fecha"}</span></div></div>\`
        ).join("");
      }
    } catch (error) {
      els.stage.textContent = error.message;
    } finally {
      els.orderByDateBtn.disabled = false;
    }
  }

  async function cancel() {`,
      "cancel function"
    );

    js = replaceOnce(
      js,
      `  els.cancelBtn.addEventListener("click", cancel);`,
      `  els.cancelBtn.addEventListener("click", cancel);
  els.orderByDateBtn?.addEventListener("click", orderByDate);`,
      "cancel listener"
    );
    write("web/autoclone.js", js);
  }

  let html = read("web/index.html");
  if (!html.includes('id="autocloneOrderByDateBtn"')) {
    html = replaceOnce(
      html,
      `            <button id="autocloneResetHistoryBtn" class="control-btn-small" type="button" title="Olvidar los vídeos ya descargados de este perfil">`,
      `            <button id="autocloneOrderByDateBtn" class="control-btn-small" type="button"
              title="Relee la fecha real de cada vídeo y los ordena de más antiguo a más nuevo para subirlos en ese orden">
              <i class="ph ph-sort-ascending"></i> Ordenar por fecha real
            </button>
            <button id="autocloneResetHistoryBtn" class="control-btn-small" type="button" title="Olvidar los vídeos ya descargados de este perfil">`,
      "reset history button"
    );
    write("web/index.html", html);
  }
} catch (error) {
  restoreAll();
  fail(error.message);
}

for (const relativePath of [
  "src/video-meta.js",
  "src/autoclone/scheduler.js",
  "src/autoclone/controller.js",
  "src/autoclone/index.js",
  "web/autoclone.js",
]) {
  const result = spawnSync(process.execPath, ["--check", path.join(projectRoot, relativePath)], { encoding: "utf8" });
  if (result.status !== 0) {
    restoreAll();
    fail((result.stderr || result.stdout || "La validacion de sintaxis fallo.").trim());
  }
}

console.log("Orden por fecha real de publicacion aplicado correctamente.");
console.log("AutoClone ahora guarda la fecha de subida, ordena por ella y trae el boton 'Ordenar por fecha real'.");
for (const { backupPath } of backups) {
  console.log(`Copia de seguridad: ${backupPath}`);
}
