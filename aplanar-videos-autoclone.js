#!/usr/bin/env node
/*
 * APLANAR videos de autoclone -> cola de TikTok
 * ---------------------------------------------
 * El autoclone guarda cada video en su propia subcarpeta dentro de
 *   .runtime/autoclone/jobs/<job>/work/<subcarpeta>/ x.mp4
 * y el programador de subidas espera los videos SUELTOS en
 *   queue/<cuenta>/tiktok/pending/
 *
 * Este script recoge todos los videos (.mp4 y otros formatos) que haya dentro
 * de la carpeta "work" del job, los copia (o mueve) a la cola de la cuenta y
 * avisa de los que falten.

 * Uso:
 *   node aplanar-videos-autoclone.js
 *   node aplanar-videos-autoclone.js --mover            (mueve en vez de copiar)
 *   node aplanar-videos-autoclone.js --cuenta kim-tae-jin
 *   node aplanar-videos-autoclone.js --origen "C:\\ruta\\a\\work" --destino "C:\\ruta\\queue\\x\\tiktok\\pending"
 *   node aplanar-videos-autoclone.js --dry-run          (solo muestra, no toca nada)
 *
 * Por defecto:
 *   - Busca TODOS los jobs en .runtime/autoclone/jobs/<job>/work
 *   - Destino: queue/<cuenta-activa>/tiktok/pending (lee accounts-state.json)
 *
 * Idempotente: si un video ya existe en el destino (mismo contenido), lo salta.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has("--dry-run") || has("--simular");
const MOVE = has("--mover") || has("--move");

const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

function log(m) { console.log(`[aplanar] ${m}`); }

function readActiveAccountId() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, "accounts-state.json"), "utf8"));
    if (raw && raw.activeAccountId) return String(raw.activeAccountId);
  } catch { /* sin estado */ }
  return "default";
}

function walkVideos(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVideos(full, out);
    else if (entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function shortHash(file, bytes = 1 << 20) {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try {
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return crypto.createHash("sha1").update(buf.subarray(0, read)).digest("hex").slice(0, 10);
  } finally { fs.closeSync(fd); }
}

async function uniqueName(destDir, originalName, sourceFile) {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext).replace(/[^\w.\-]+/g, "_").slice(0, 80) || "video";
  let candidate = `${base}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(destDir, candidate))) {
    const existing = path.join(destDir, candidate);
    // Mismo tamano + mismo hash inicial => es el mismo video: no duplicar.
    try {
      const a = fs.statSync(existing);
      const b = fs.statSync(sourceFile);
      if (a.size === b.size && shortHash(existing) === shortHash(sourceFile)) return null;
    } catch { /* compara solo por nombre */ }
    candidate = `${base}_${i}${ext}`;
    i += 1;
  }
  return candidate;
}

function resolveOrigins() {
  const direct = argValue("--origen");
  if (direct) return [path.resolve(direct)];
  const base = path.resolve(ROOT, ".runtime", "autoclone", "jobs");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(base, e.name, "work"))
    .filter((p) => fs.existsSync(p));
}

function resolveDestino() {
  const direct = argValue("--destino");
  if (direct) return path.resolve(direct);
  const cuenta = argValue("--cuenta") || readActiveAccountId();
  return path.resolve(ROOT, "queue", cuenta, "tiktok", "pending");
}

async function main() {
  // Permitir una carpeta "work" concreta pasada como primer argumento posicional.
  const positional = args.filter((a) => !a.startsWith("--") && args.indexOf(a) !== args.indexOf(argValue("--origen")) && args.indexOf(a) !== args.indexOf(argValue("--destino")) && args.indexOf(a) !== args.indexOf(argValue("--cuenta")));
  let origins = resolveOrigins();
  if (positional.length) origins = positional.map((p) => path.resolve(p));

  const destino = resolveDestino();

  log(`origen(es): ${origins.length ? origins.join(" | ") : "(no encontrado)"}`);
  log(`destino:    ${destino}`);
  log(`modo:       ${DRY ? "SOLO MOSTRAR" : MOVE ? "MOVER" : "COPIAR"}`);

  if (!origins.length) {
    log("No encontre ninguna carpeta 'work'. Pasa la ruta a mano, por ejemplo:");
    log('  node aplanar-videos-autoclone.js "C:\\Users\\msi\\Downloads\\autosocial-studio\\.runtime\\autoclone\\jobs\\jayandrews69-1790708834467\\work"');
    process.exitCode = 1;
    return;
  }

  const videos = [];
  for (const o of origins) videos.push(...walkVideos(o));
  log(`videos encontrados: ${videos.length}`);
  if (!videos.length) { log("Nada que hacer."); return; }

  if (!DRY) await fsp.mkdir(destino, { recursive: true });

  let copiados = 0, saltados = 0, errores = 0;
  for (const src of videos) {
    try {
      if (DRY) { log(`  -> ${path.basename(src)}`); continue; }
      const name = await uniqueName(destino, path.basename(src), src);
      if (!name) { saltados += 1; log(`  = ya estaba: ${path.basename(src)}`); continue; }
      const dst = path.join(destino, name);
      if (MOVE) await fsp.rename(src, dst).catch(async () => { await fsp.copyFile(src, dst); await fsp.rm(src, { force: true }); });
      else await fsp.copyFile(src, dst);
      copiados += 1;
      log(`  + ${name}`);
    } catch (e) {
      errores += 1;
      log(`  ! error con ${path.basename(src)}: ${e.message}`);
    }
  }

  log(`hecho: ${copiados} ${MOVE ? "movidos" : "copiados"}, ${saltados} ya estaban, ${errores} errores.`);
  if (!DRY && copiados) log("Puedes lanzar el dashboard y programar la cola cuando quieras.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
