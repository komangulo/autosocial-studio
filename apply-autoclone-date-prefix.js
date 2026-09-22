#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const DONE_MARK = "__DATE_PREFIX_FILENAMES__";

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
  const backupPath = `${sourcePath}.backup-dateprefix-${stamp}`;
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
  // ------------------------------------------------------- autoclone/controller.js
  let controller = read("src/autoclone/controller.js");
  if (!controller.includes(DONE_MARK)) {
    // 1) Rename the freshly downloaded video (and sidecars) with the date prefix.
    controller = replaceOnce(
      controller,
      `        await this._stampDownloadIndex(target, index);`,
      `        await this._stampDownloadIndex(target, index);
        target = await this._renameWithDatePrefix(target); // ${DONE_MARK}`,
      "stamp index"
    );

    // `target` is const in the loop; make it reassignable.
    controller = replaceOnce(
      controller,
      `      const id = selected[index];
      const target = path.join(downloadDir, \`\${id}.mp4\`);`,
      `      const id = selected[index];
      let target = path.join(downloadDir, \`\${id}.mp4\`);`,
      "target const to let"
    );

    // 2) The video object must report the final (renamed) path.
    controller = replaceOnce(
      controller,
      `        videos.push({ id, sourcePath: target, sizeBytes: stat.size, status: "pending", downloadIndex: index, hasThumbnail: Boolean(thumbnailPath) });`,
      `        const finalStat = await fs.stat(target).catch(() => null);
        videos.push({ id, sourcePath: target, sizeBytes: finalStat?.size || stat.size, status: "pending", downloadIndex: index, hasThumbnail: Boolean(thumbnailPath) });`,
      "videos push"
    );

    // 3) The rename helper + folder-wide renamer, inserted before the history method.
    controller = replaceOnce(
      controller,
      `  /** Forget the download memory of one profile, so the next run starts over. */`,
      `  // ${DONE_MARK}
  // Fecha YYYY-MM-DD del video. La lee del .info.json (upload_date / timestamp),
  // que es el dato real de TikTok, y como respaldo del uploadedAt del .meta.json.
  async _datePrefixFor(videoPath) {
    const fsPromises = require("fs/promises");
    const { getMetaPath } = require("../queue");
    const parsed = path.parse(videoPath);

    // 1) .info.json -> upload_date (YYYYMMDD) o timestamp (segundos epoch).
    try {
      const infoPath = path.join(parsed.dir, \`\${parsed.name}.info.json\`);
      const info = JSON.parse(await fsPromises.readFile(infoPath, "utf8"));
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

    // 2) .meta.json -> uploadedAt ya guardado.
    try {
      const meta = JSON.parse(await fsPromises.readFile(getMetaPath(videoPath), "utf8"));
      const raw = String(meta?.uploadedAt || "").trim();
      if (!raw) return "";
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
      return date.toISOString().slice(0, 10);
    } catch {
      return "";
    }
  }

  // Renombra "ID.ext" -> "YYYY-MM-DD_ID.ext" junto con sus companeros
  // (.info.json, .meta.json, portada y subtitulos). Si no hay fecha, no toca nada.
  async _renameWithDatePrefix(videoPath) {
    const datePrefix = await this._datePrefixFor(videoPath);
    if (!datePrefix) return videoPath;
    return this._renameGroup(videoPath, datePrefix);
  }

  async _renameGroup(videoPath, datePrefix) {
    const fsPromises = require("fs/promises");
    const fileExists = async (candidate) => {
      try { await fsPromises.access(candidate); return true; } catch { return false; }
    };
    const parsed = path.parse(videoPath);
    const base = parsed.name;
    if (base.startsWith(datePrefix + "_")) return videoPath;

    let newName = \`\${datePrefix}_\${base}\${parsed.ext}\`;
    let suffix = 0;
    while (await fileExists(path.join(parsed.dir, newName))) {
      if (path.join(parsed.dir, newName) === videoPath) break;
      suffix += 1;
      newName = \`\${datePrefix}_\${base} (\${suffix})\${parsed.ext}\`;
    }

    const targetPath = path.join(parsed.dir, newName);
    if (targetPath === videoPath) return videoPath;

    const companions = [
      \`\${base}.info.json\`,
      \`\${base}.meta.json\`,
      \`\${base}.description\`,
      \`\${base}.txt\`,
    ];
    const thumbExts = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
    for (const ext of thumbExts) companions.push(\`\${base}\${ext}\`);

    const newBase = path.parse(newName).name;
    const newCompanions = [
      \`\${newBase}.info.json\`,
      \`\${newBase}.meta.json\`,
      \`\${newBase}.description\`,
      \`\${newBase}.txt\`,
    ];
    for (const ext of thumbExts) newCompanions.push(\`\${newBase}\${ext}\`);

    try {
      await fsPromises.rename(videoPath, targetPath);
    } catch {
      return videoPath;
    }
    for (let i = 0; i < companions.length; i += 1) {
      const from = path.join(parsed.dir, companions[i]);
      const to = path.join(parsed.dir, newCompanions[i]);
      try { await fsPromises.rename(from, to); } catch { /* el companero no existe */ }
    }
    return targetPath;
  }

  // Recorre una carpeta y pone la fecha delante a todos los videos con fecha.
  async renameFolderWithDates(folder) {
    const fsPromises = require("fs/promises");
    const dir = path.resolve(String(folder || ""));
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    const videos = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\\.(mp4|mov|webm|avi|mkv)$/i.test(name))
      .filter((name) => !/^\\d{4}-\\d{2}-\\d{2}_/.test(name))
      .map((name) => path.join(dir, name));

    if (!videos.length) {
      return { folder: dir, renamed: 0, withoutDate: 0, already: true, items: [] };
    }

    let renamed = 0;
    let withoutDate = 0;
    const items = [];
    for (const videoPath of videos) {
      const before = path.basename(videoPath);
      const after = await this._renameWithDatePrefix(videoPath);
      if (after === videoPath) {
        withoutDate += 1;
        items.push({ before, after: before, changed: false });
      } else {
        renamed += 1;
        items.push({ before, after: path.basename(after), changed: true });
      }
    }
    items.sort((a, b) => a.after.localeCompare(b.after));
    return { folder: dir, renamed, withoutDate, already: false, items };
  }

  /** Forget the download memory of one profile, so the next run starts over. */`,
      "history comment"
    );

    write("src/autoclone/controller.js", controller);
  }

  // ----------------------------------------------------------- autoclone/index.js
  let router = read("src/autoclone/index.js");
  if (!router.includes('"/rename-by-date"')) {
    router = replaceOnce(
      router,
      `  router.post("/destination/check", route(async (req, res) => {`,
      `  // Renombrar los videos de una carpeta con la fecha delante (YYYY-MM-DD_id).
  router.post("/rename-by-date", route(async (req, res) => {
    const { folder } = req.body || {};
    if (!folder) throw new Error("Elige la carpeta de los videos.");
    const result = await controller.renameFolderWithDates(folder);
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

// ---------------------------------------------------------------------- web UI
try {
  let js = read("web/autoclone.js");
  if (!js.includes("autocloneRenameByDateBtn")) {
    if (js.includes('orderByDateBtn: $("autocloneOrderByDateBtn"),')) {
      js = replaceOnce(
        js,
        `    orderByDateBtn: $("autocloneOrderByDateBtn"),`,
        `    orderByDateBtn: $("autocloneOrderByDateBtn"),
    renameByDateBtn: $("autocloneRenameByDateBtn"),`,
        "els orderByDate"
      );
    } else {
      js = replaceOnce(
        js,
        `    startBtn: $("autocloneStartBtn"),`,
        `    startBtn: $("autocloneStartBtn"),
    renameByDateBtn: $("autocloneRenameByDateBtn"),`,
        "els startBtn"
      );
    }

    js = replaceOnce(
      js,
      `  async function cancel() {`,
      `  // Pone la fecha delante del nombre de cada video ya descargado.
  async function renameByDate() {
    const folder = (els.destination?.value || "").trim();
    if (!folder) { els.stage.textContent = "Escribe la carpeta de los videos en 'Carpeta de destino'."; return; }
    if (!window.confirm("Renombrar los videos de " + folder + " con la fecha delante (ej. 2024-01-15_id.mp4)?")) return;
    els.renameByDateBtn.disabled = true;
    try {
      const data = await API.post("/api/autoclone/rename-by-date", { folder });
      els.stage.textContent = data.already
        ? "Todos los videos de esa carpeta ya tienen la fecha en el nombre."
        : "Renombrados " + data.renamed + " videos" + (data.withoutDate ? " (" + data.withoutDate + " sin fecha, sin cambios)." : ".");
      if (data.items?.length) {
        els.videos.innerHTML = data.items.slice(0, 300).map((item, i) =>
          \`<div class="autoclone-video"><span class="autoclone-video-idx">\${i + 1}</span>\`
          + \`<div class="autoclone-video-body"><span class="autoclone-video-id">\${escapeHtmlJs(item.after)}</span>\`
          + \`<span class="autoclone-video-tags">\${item.changed ? "renombrado" : "sin fecha"}</span></div></div>\`
        ).join("");
      }
    } catch (error) {
      els.stage.textContent = error.message;
    } finally {
      els.renameByDateBtn.disabled = false;
    }
  }

  async function cancel() {`,
      "cancel function"
    );

    js = replaceOnce(
      js,
      `  els.cancelBtn.addEventListener("click", cancel);`,
      `  els.cancelBtn.addEventListener("click", cancel);
  els.renameByDateBtn?.addEventListener("click", renameByDate);`,
      "cancel listener"
    );
    write("web/autoclone.js", js);
  } else if (!js.includes("els.renameByDateBtn?.addEventListener")) {
    js = replaceOnce(
      js,
      `  els.cancelBtn.addEventListener("click", cancel);`,
      `  els.cancelBtn.addEventListener("click", cancel);
  els.renameByDateBtn?.addEventListener("click", renameByDate);`,
      "cancel listener (add)"
    );
    write("web/autoclone.js", js);
  }

  let html = read("web/index.html");
  if (!html.includes('id="autocloneRenameByDateBtn"')) {
    const anchor = html.includes('id="autocloneOrderByDateBtn"')
      ? `            <button id="autocloneOrderByDateBtn" class="control-btn-small" type="button"`
      : `            <button id="autocloneResetHistoryBtn" class="control-btn-small" type="button"`;
    html = replaceOnce(
      html,
      anchor,
      `            <button id="autocloneRenameByDateBtn" class="control-btn-small" type="button"
              title="Pone la fecha real delante del nombre de cada vídeo ya descargado (ej. 2024-01-15_7643421855751228694.mp4)">
              <i class="ph ph-text-aa"></i> Poner fecha en el nombre
            </button>
` + anchor,
      "order by date button"
    );
    write("web/index.html", html);
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

console.log("Fecha en el nombre de los videos aplicada correctamente.");
console.log("Renombra cada video a 'YYYY-MM-DD_ID.ext' y trae el boton 'Poner fecha en el nombre'.");
for (const { backupPath } of backups) {
  console.log(`Copia de seguridad: ${backupPath}`);
}
