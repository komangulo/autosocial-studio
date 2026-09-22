#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(projectRoot, "src"))) {
  fail(`No encuentro el proyecto en ${projectRoot}.`);
}

const FILES = [
  "src/autoclone/controller.js",
  "src/autoclone/index.js",
  "web/index.html",
  "web/autoclone.js",
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
  const crlf = raw.includes("\r\n");
  lineEndings.set(relativePath, crlf ? "\r\n" : "\n");
  originals.set(relativePath, raw);
  fs.writeFileSync(sourcePath, raw.replace(/\r\n/g, "\n"));
  const backupPath = `${sourcePath}.backup-originaldl-${stamp}`;
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

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count === 0) throw new Error(`No encuentro el bloque "${label}"`);
  if (count > 1) throw new Error(`El bloque "${label}" aparece ${count} veces, no puedo elegir uno`);
  return source.replace(from, to);
}

const DONE_MARK = "__ORIGINAL_DOWNLOAD_MODE__";

try {
  // ---------------------------------------------------------------- controller
  let controller = read("src/autoclone/controller.js");

  if (!controller.includes(DONE_MARK)) {
    // 1) Persist the new option on the job.
    controller = replaceOnce(
      controller,
      `        startMode: options.startMode === "restart" ? "restart" : "continue",`,
      `        startMode: options.startMode === "restart" ? "restart" : "continue",
        // ${DONE_MARK} Solo descarga: ni analisis, ni subtitulos, ni uniquify.
        downloadOnly: options.downloadOnly === true,`,
      "startMode option"
    );

    // 2) Skip profile analysis and per-video processing when downloadOnly.
    controller = replaceOnce(
      controller,
      `      // 1) Competitor analysis -------------------------------------------
      if (job.singleVideo) {`,
      `      // 0) Original-only download: no analysis, no processing. -----------
      if (job.options.downloadOnly) {
        this._report("download", "Modo solo descarga: bajando los videos originales sin modificar.", { percent: 5 });
        const originals = await this._downloadAll(job, ai);
        if (this.cancelRequested) throw new Error("Ejecucion cancelada.");
        if (!originals.length) throw new Error("No se pudo descargar ningun video del perfil.");

        job.status = "done";
        job.finishedAt = nowIso();
        job.folder = this._userDir(job);
        job.videos = originals.map((video) => ({ ...video, status: "done" }));
        await this._saveJob(job);
        this._report(
          "done",
          \`Descarga original completada: \${job.videos.length} videos sin modificar. Guardados en \${job.folder}\`,
          { percent: 100, jobId: job.id, folder: job.folder }
        );
        return;
      }

      // 1) Competitor analysis -------------------------------------------
      if (job.singleVideo) {`,
      "competitor analysis block"
    );

    // 3) In original mode videos must land in the destination as-is (no _unique suffix).
    controller = replaceOnce(
      controller,
      `    const outputPath = path.join(this._outputDir(job), \`\${video.id}\${job.options.uniquify ? "_unique" : ""}.mp4\`);`,
      `    const outputPath = path.join(this._outputDir(job), \`\${video.id}\${job.options.uniquify && !job.options.downloadOnly ? "_unique" : ""}.mp4\`);`,
      "output path"
    );

    // 4) Download straight into the destination folder in original mode.
    controller = replaceOnce(
      controller,
      `    const downloadDir = this._downloadDir(job);
    await fs.mkdir(downloadDir, { recursive: true });`,
      `    const downloadDir = job.options.downloadOnly ? this._userDir(job) : this._downloadDir(job);
    await fs.mkdir(downloadDir, { recursive: true });`,
      "download dir"
    );

    fs.writeFileSync(
      path.join(projectRoot, "src/autoclone/controller.js"),
      toEol("src/autoclone/controller.js", controller)
    );
  }

  // -------------------------------------------------------------------- router
  let router = read("src/autoclone/index.js");
  if (!router.includes('"/start-download"')) {
    router = replaceOnce(
      router,
      `  // Which videos of a profile were already downloaded by previous runs.`,
      `  // Download the profile's original videos: no analysis, no subtitles, no changes.
  router.post("/start-download", route(async (req, res) => {
    const { username, videoUrl, maxVideos, destinationRoot, downloadThumbnail, downloadOrder, startMode } = req.body || {};
    const result = await controller.start({
      username,
      videoUrl,
      maxVideos,
      destinationRoot,
      downloadThumbnail,
      downloadOrder,
      startMode,
      downloadOnly: true,
    });
    res.json({ ok: true, ...result, downloadOnly: true });
  }));

  // Which videos of a profile were already downloaded by previous runs.`,
      "history comment"
    );
    fs.writeFileSync(
      path.join(projectRoot, "src/autoclone/index.js"),
      toEol("src/autoclone/index.js", router)
    );
  }

  // ---------------------------------------------------------------------- HTML
  let html = read("web/index.html");
  if (!html.includes('id="autocloneDownloadOnlyBtn"')) {
    html = replaceOnce(
      html,
      `            <button id="autocloneStartBtn" class="control-btn primary autoclone-go" type="button">
              <i class="ph ph-lightning"></i> Clonar ahora
            </button>`,
      `            <button id="autocloneStartBtn" class="control-btn primary autoclone-go" type="button">
              <i class="ph ph-lightning"></i> Clonar ahora
            </button>
            <button id="autocloneDownloadOnlyBtn" class="control-btn autoclone-go" type="button"
              title="Descarga los videos originales sin subtitulos, sin uniquificar y sin analizar el perfil">
              <i class="ph ph-download-simple"></i> Descargar videos originales
            </button>`,
      "start button"
    );
    fs.writeFileSync(path.join(projectRoot, "web/index.html"), toEol("web/index.html", html));
  }

  // ----------------------------------------------------------------- autoclone.js
  let js = read("web/autoclone.js");
  if (!js.includes("autocloneDownloadOnlyBtn")) {
    js = replaceOnce(
      js,
      `    startBtn: $("autocloneStartBtn"),`,
      `    startBtn: $("autocloneStartBtn"),
    downloadOnlyBtn: $("autocloneDownloadOnlyBtn"),`,
      "els.startBtn"
    );

    js = replaceOnce(
      js,
      `  async function start(override = {}) {`,
      `  // "Descargar videos originales": mismo flujo que clonar, pero sin analisis,
  // sin traducir texto en pantalla y sin uniquificar. Solo baja los MP4 tal cual.
  async function startDownloadOnly() {
    const username = (els.username.value || "").trim();
    if (!username) {
      els.stage.textContent = "Escribe un @usuario de TikTok para descargar sus videos originales.";
      return;
    }
    const destinationRoot = els.destination?.value.trim() || "";
    els.downloadOnlyBtn.disabled = true;
    els.startBtn.disabled = true;
    renderedSignature = "";
    els.videos.innerHTML = \`<p class="autoclone-empty">Descargando los videos originales...</p>\`;
    els.analysis.hidden = true;
    setBar(1);
    try {
      const data = await API.post("/api/autoclone/start-download", {
        username,
        maxVideos: Number(els.maxVideos.value) || 0,
        downloadOrder: els.downloadOrder?.value || "oldest",
        downloadThumbnail: Boolean(els.downloadThumbnail?.checked),
        startMode: els.startMode?.value || "continue",
        destinationRoot,
      });
      currentJobId = data.id;
      lastJobId = data.id;
      saveDestination(destinationRoot);
      saveDownloadOrder(els.downloadOrder?.value || "oldest");
      saveDownloadThumbnail(Boolean(els.downloadThumbnail?.checked));
      saveStartMode(els.startMode?.value || "continue");
      updateDestHint(data.handle || username, destinationRoot);
      els.stage.textContent = data.folder
        ? \`Descargando los videos originales de \${data.handle}. Guardando en \${data.folder}\`
        : \`Descargando los videos originales de \${data.handle}.\`;
      connectEvents();
    } catch (error) {
      els.downloadOnlyBtn.disabled = false;
      els.startBtn.disabled = false;
      els.stage.textContent = error.message;
      setBar(0);
    }
  }

  async function start(override = {}) {`,
      "start function"
    );

    js = replaceOnce(
      js,
      `  els.startBtn.addEventListener("click", () => start());`,
      `  els.startBtn.addEventListener("click", () => start());
  els.downloadOnlyBtn?.addEventListener("click", startDownloadOnly);`,
      "start listener"
    );

    js = replaceOnce(
      js,
      `      els.cancelBtn.hidden = !running;
      els.startBtn.disabled = running;`,
      `      els.cancelBtn.hidden = !running;
      els.startBtn.disabled = running;
      if (els.downloadOnlyBtn) els.downloadOnlyBtn.disabled = running;`,
      "progress buttons"
    );

    fs.writeFileSync(path.join(projectRoot, "web/autoclone.js"), toEol("web/autoclone.js", js));
  }
} catch (error) {
  restoreAll();
  fail(error.message);
}

for (const relativePath of ["src/autoclone/controller.js", "src/autoclone/index.js", "web/autoclone.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(projectRoot, relativePath)], { encoding: "utf8" });
  if (result.status !== 0) {
    restoreAll();
    fail((result.stderr || result.stdout || "La validacion de sintaxis fallo.").trim());
  }
}

console.log("Modo 'Solo descargar videos originales' aplicado correctamente.");
console.log("Anade un boton nuevo en AutoClone que baja los MP4 sin analizar, sin subtitulos y sin uniquificar.");
for (const { backupPath } of backups) {
  console.log(`Copia de seguridad: ${backupPath}`);
}
