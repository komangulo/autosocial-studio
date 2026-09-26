#!/usr/bin/env node
/**
 * reparar-cola-tiktok.js
 * ---------------------------------------------------------------
 * Repara el estado roto que deja la cola de una cuenta TikTok que no
 * publica ("1 programado" pero 0 posted, pending que no baja).
 *
 * Hace, sin borrar nada de forma irreversible, una copia de seguridad
 * de todo lo que toca:
 *
 *   1. Elimina los .meta.json HUERFANOS de queue/<cuenta>/tiktok/pending
 *      (los que no tienen un .mp4 con el mismo nombre). Esos metadatos
 *      hacen que el dashboard cuente "pending" sin que haya video real.
 *   2. Mueve a una carpeta de cuarentena los jobs CANCELADOS/FAILED del
 *      store autonomo, para que su dedupeKey deje de bloquear reintentos.
 *   3. Borra el flag de pausa .runtime/autonomous-worker.paused.
 *
 * Uso (desde la carpeta del proyecto):
 *   node reparar-cola-tiktok.js "kitty-miau"
 *   node reparar-cola-tiktok.js "kitty-miau" --dry   (solo muestra)
 *
 * No toca los .mp4 reales ni los jobs en curso.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const args = process.argv.slice(2);
const dry = args.includes("--dry") || args.includes("--dry-run");
const accountId = args.find((a) => !a.startsWith("--"));

if (!accountId) {
  console.error("Uso: node reparar-cola-tiktok.js <cuenta> [--dry]");
  console.error("Ejemplo: node reparar-cola-tiktok.js kitty-miau");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(accountId)) {
  console.error(`Cuenta invalida: "${accountId}"`);
  process.exit(1);
}

const ROOT = process.cwd();
const accountDir = path.join(ROOT, "queue", accountId, "tiktok");
const pendingDir = path.join(accountDir, "pending");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(ROOT, ".runtime", `reparacion-${accountId}-${stamp}`);

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
const SIDECAR_EXT = new Set([".description", ".txt", ".meta.json", ".jpg", ".jpeg", ".png", ".webp", ".avif"]);

const log = (...a) => console.log(...a);
const changed = { metaMoved: 0, jobsMoved: 0, pauseRemoved: false };

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function main() {
  log(`\n== Reparacion de cola TikTok: cuenta "${accountId}" ${dry ? "(SIMULACION)" : ""} ==`);

  if (!(await exists(path.join(ROOT, "package.json")))) {
    console.error("No encuentro package.json. Ejecuta este script DENTRO de la carpeta del proyecto.");
    process.exit(1);
  }
  if (!(await exists(pendingDir))) {
    console.error(`No existe la carpeta: ${pendingDir}`);
    process.exit(1);
  }

  await fsp.mkdir(path.join(backupDir, "pending-huerfanos"), { recursive: true });
  await fsp.mkdir(path.join(backupDir, "jobs-terminales"), { recursive: true });

  /* ---------- 1. Metadatos huerfanos en pending ---------- */
  const entries = await fsp.readdir(pendingDir, { withFileTypes: true });
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const videoBases = new Set(
    [...names]
      .filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()))
      .map((n) => n.slice(0, -path.extname(n).length))
  );

  const orphans = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (VIDEO_EXT.has(ext)) continue;
    // Solo consideramos sidecars de video (no .mp4) cuyo base no tenga video.
    const isSidecar =
      ext === ".meta.json" ||
      SIDECAR_EXT.has(ext) ||
      name.endsWith(".meta.json");
    if (!isSidecar) continue;
    const base = name.endsWith(".meta.json")
      ? name.slice(0, -".meta.json".length)
      : name.slice(0, -ext.length);
    if (!videoBases.has(base)) orphans.push(name);
  }

  log(`\n[1] Metadatos huerfanos en pending: ${orphans.length}`);
  for (const name of orphans) {
    const src = path.join(pendingDir, name);
    const dst = path.join(backupDir, "pending-huerfanos", name);
    log(`    - ${name}`);
    if (!dry) { await fsp.rename(src, dst); }
    changed.metaMoved += 1;
  }
  if (!orphans.length) log("    (ninguno: la cola pending ya esta limpia)");

  const realVideos = [...names].filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()));
  log(`    Videos reales que se conservan en pending: ${realVideos.length}`);

  /* ---------- 2. Jobs terminales que bloquean por dedupe ---------- */
  const storePath = path.join(ROOT, ".runtime", "autonomous-state.json");
  log(`\n[2] Jobs cancelados/fallidos en el store autonomo`);
  if (!(await exists(storePath))) {
    log("    No existe .runtime/autonomous-state.json (nada que limpiar).");
  } else {
    const raw = JSON.parse(await fsp.readFile(storePath, "utf8"));
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    const terminal = new Set(["cancelled", "failed", "uncertain"]);
    const mine = jobs.filter(
      (j) => j.accountId === accountId && terminal.has(j.status)
    );
    const keep = jobs.filter((j) => !(j.accountId === accountId && terminal.has(j.status)));
    log(`    Jobs de "${accountId}" en estado terminal: ${mine.length} (de ${jobs.length} totales)`);

    if (!dry && mine.length) {
      await fsp.writeFile(
        path.join(backupDir, "jobs-terminales", "autonomous-state.json"),
        JSON.stringify(raw, null, 2),
        "utf8"
      );
      // Copia .bak del original antes de reescribir.
      await fsp.copyFile(storePath, `${storePath}.bak-${stamp}`).catch(() => {});
      const next = { ...raw, jobs: keep };
      const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await fsp.rename(tmp, storePath);
    }
    changed.jobsMoved = mine.length;
  }

  /* ---------- 3. Flag de pausa del worker ---------- */
  const pausedPath = path.join(ROOT, ".runtime", "autonomous-worker.paused");
  log(`\n[3] Flag de pausa del worker`);
  if (await exists(pausedPath)) {
    if (!dry) await fsp.rm(pausedPath, { force: true });
    changed.pauseRemoved = true;
    log(`    - Eliminado: ${path.relative(ROOT, pausedPath)}`);
  } else {
    log("    No hay flag de pausa (correcto).");
  }

  /* ---------- Resumen ---------- */
  log("\n== Resumen ==");
  log(`  Metadatos huerfanos movidos : ${changed.metaMoved}`);
  log(`  Jobs terminales depurados   : ${changed.jobsMoved}`);
  log(`  Flag de pausa borrado       : ${changed.pauseRemoved ? "si" : "no"}`);
  if (!dry) {
    log(`\n  Copia de seguridad en: ${path.relative(ROOT, backupDir)}`);
    log(`  Todo lo movido se puede restaurar desde ahi.`);
  } else {
    log("\n  (SIMULACION: no se ha cambiado nada. Quita --dry para aplicar)");
  }
  log("\nSiguiente paso: reinicia el dashboard y vuelve a pulsar");
  log('"Programar todo en TikTok ahora" sin pulsar "Parar" a mitad.\n');
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
