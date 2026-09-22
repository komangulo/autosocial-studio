#!/usr/bin/env node
/**
 * instalar-tiktok-dos-navegadores.js
 * ---------------------------------------------------------------------------
 * ARREGLA POR QUE SE PUBLICA 1 VIDEO Y FALLAN LOS DEMAS.
 *
 * DIAGNOSTICO (con el log real del usuario):
 *   El log muestra, A LA VEZ:
 *     - "TikTok upload file selected: ..."      -> un video subiendose
 *     - "Holding browser for 25000ms"           -> esperando con Chrome abierto
 *     - "El perfil de TikTok esta ocupado"      -> OTRO job abriendo el mismo perfil
 *     - exitCode=21
 *
 *   Hay DOS caminos que reclaman trabajos de TikTok y NO se excluyen:
 *
 *     A) drainTikTokQueue()  (autonomous-worker.js:193)
 *        Bucle while que reclama y ejecuta jobs. Se le llama desde
 *        autoclone/index.js:312. NO toca this.laneBusy.
 *
 *     B) tick() -> dispatchLane("tiktok-publish")  (autonomous-worker.js:248-272)
 *        El temporizador (cada minuto) mira this.laneBusy["tiktok-publish"].
 *        Como A) NUNCA lo marca como ocupado, B) lo ve libre y lanza OTRO job
 *        de TikTok EN PARALELO.
 *
 *   Resultado: dos launchPersistentContext sobre el MISMO perfil a la vez.
 *   El primero gana; el segundo muere con exitCode=21 ("Target page, context
 *   or browser has been closed"), y como el drain es secuencial, el video que
 *   iba despues ya no arranca: se publica 1 y el resto falla.
 *
 *   ADEMAS: drainTikTokQueue devuelve `processed` contando jobs fallidos, y el
 *   mensaje final dice "N videos programados" aunque hayan fallado. De ahi el
 *   "3 programados" con 1 publicado.
 *
 * QUE HACE ESTE INSTALADOR
 *   1. drainTikTokQueue marca y respeta this.laneBusy: mientras drena, el
 *      temporizador NO puede lanzar otro job de TikTok.
 *   2. dispatchLane respeta tambien un drain en curso (defensa por ambos lados).
 *   3. Devuelve un resumen honesto { processed, published, failed } para que el
 *      mensaje final no mienta.
 *
 * Idempotente. Uso:  node instalar-tiktok-dos-navegadores.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const WORKER = path.join(SRC, "autonomous-worker.js");

const MARK = "// MARKER: TIKTOK-LANE-EXCLUSIVE-v1";

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(WORKER)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

let w = fs.readFileSync(WORKER, "utf8");
const before = w;

// ===========================================================================
// 1. runClaimedJob: informar si el job se publico o fallo (para el resumen)
// ===========================================================================
{
  const sig = "  async runClaimedJob(job) {";
  const idx = w.indexOf(sig);
  if (idx === -1) {
    fail("No encontre runClaimedJob.");
  } else {
    // Localizamos el try y devolvemos un resultado explicito.
    const bodyStart = idx + sig.length;
    if (/this\.lastJobOutcome/.test(w.slice(idx, idx + 2000))) {
      skip("runClaimedJob ya informaba del resultado");
    } else {
      // Sustituimos las llamadas de exito/fracaso por un registro del estado.
      // Exito: 'await this.store.complete'
      const okRe = /(await this\.store\.complete\([\s\S]*?\);)/;
      // Fracaso: 'await this.store.fail('  (dentro del catch)
      const failRe = /(await this\.store\.fail\([\s\S]*?\);)/;

      const okMatch = w.slice(idx).match(okRe);
      if (okMatch) {
        const at = idx + w.slice(idx).indexOf(okMatch[1]);
        w = w.slice(0, at) + `this._lastOutcome = "succeeded";\n      ` + w.slice(at);
        ok("runClaimedJob registra los jobs publicados");
      } else {
        skip("no pude marcar el exito en runClaimedJob");
      }

      const failMatch = w.slice(idx).match(failRe);
      if (failMatch) {
        const at = idx + w.slice(idx).indexOf(failMatch[1]);
        w = w.slice(0, at) + `this._lastOutcome = "failed";\n      ` + w.slice(at);
        ok("runClaimedJob registra los jobs fallidos");
      } else {
        skip("no pude marcar el fallo en runClaimedJob");
      }
    }
  }
}

// ===========================================================================
// 2. drainTikTokQueue: exclusion mutua con el temporizador + resumen honesto
// ===========================================================================
{
  const oldDrain = `  async drainTikTokQueue({ maxJobs = 100, onJob } = {}) {
    this.clearCancellation();
    let processed = 0;
    while (processed < maxJobs) {
      if (this.isCancelled()) break;
      const job = await this.store.claimDue(new Date(), { type: "tiktok-publish" });
      if (!job) break;
      await onJob?.(job);
      if (this.isCancelled()) {
        // Give the claimed job back so it can run later, then stop.
        await this.store.release?.(job.id).catch?.(() => {});
        break;
      }
      await this.runClaimedJob(job);
      processed += 1;
    }
    return processed;
  }`;

  if (w.includes(MARK)) {
    skip("drainTikTokQueue ya era exclusivo");
  } else if (w.includes(oldDrain)) {
    const newDrain = `  async drainTikTokQueue({ maxJobs = 100, onJob } = {}) {
    ${MARK}
    // Mientras este bucle drena, el temporizador NO debe lanzar otro job de
    // TikTok: si no, se abren DOS Chrome sobre el mismo perfil y el segundo
    // muere con exitCode=21 (se publicaba 1 y fallaban los siguientes).
    if (this.laneBusy["tiktok-publish"]) {
      // Ya hay un drenaje en curso: no duplicar.
      return { processed: 0, published: 0, failed: 0, skipped: true };
    }
    this.laneBusy["tiktok-publish"] = true;
    this.clearCancellation();
    let processed = 0;
    let published = 0;
    let failed = 0;
    try {
      while (processed < maxJobs) {
        if (this.isCancelled()) break;
        const job = await this.store.claimDue(new Date(), { type: "tiktok-publish" });
        if (!job) break;
        await onJob?.(job);
        if (this.isCancelled()) {
          // Devolvemos el job reclamado para que se pueda ejecutar luego.
          try {
            if (typeof this.store.release === "function") {
              await this.store.release(job.id);
            }
          } catch {
            // Liberar es best-effort.
          }
          break;
        }
        this._lastOutcome = null;
        await this.runClaimedJob(job);
        processed += 1;
        if (this._lastOutcome === "failed") failed += 1;
        else if (this._lastOutcome === "succeeded") published += 1;
      }
    } finally {
      this.laneBusy["tiktok-publish"] = false;
    }
    // Resumen honesto: antes se devolvia solo un numero y el mensaje final
    // decia "N programados" aunque hubieran fallado.
    return { processed, published, failed };
  }`;

    w = w.replace(oldDrain, newDrain);
    ok("drainTikTokQueue: lane exclusivo (un solo navegador) + resumen honesto");
  } else {
    fail(
      "No encontre drainTikTokQueue tal cual. Manda las lineas alrededor de " +
      "'async drainTikTokQueue' para ajustar el parche."
    );
  }
}

// ===========================================================================
// 3. dispatchLane: respetar un drenaje en curso (defensa por el otro lado)
// ===========================================================================
{
  const oldDispatch = `  async dispatchLane(type, now) {
    if (this.laneBusy[type]) return;`;
  const newDispatch = `  async dispatchLane(type, now) {
    ${MARK}
    // Si el bucle de drenaje tiene el lane tomado, no lanzar otro job.
    if (this.laneBusy[type]) return;`;

  if (w.includes(newDispatch)) {
    skip("dispatchLane ya respetaba el lane ocupado");
  } else if (w.includes(oldDispatch)) {
    w = w.replace(oldDispatch, newDispatch);
    ok("dispatchLane respeta el drenaje en curso");
  } else {
    skip("no encontre dispatchLane con la forma esperada");
  }
}

// ===========================================================================
// 4. autoclone/index.js: usar el resumen real del drain (no "created")
// ===========================================================================
{
  const CLONE = path.join(SRC, "autoclone", "index.js");
  if (!fs.existsSync(CLONE)) {
    skip("no encontre autoclone/index.js: el resumen seguira siendo aproximado");
  } else {
    let c = fs.readFileSync(CLONE, "utf8");
    if (c.includes("drainSummary")) {
      skip("autoclone ya usaba el resumen real del drain");
    } else {
      const oldBlock =
        `        if (!context.worker.isCancelled?.()) {
          await context.worker.drainTikTokQueue({
            onJob: (job) => {
              run.lastVideoName = job.payload?.videoName || run.lastVideoName;
              run.lastScheduledAt = job.payload?.nativeScheduledAt || run.lastScheduledAt;
            },
          });
        }`;
      if (c.includes(oldBlock)) {
        c = c.replace(
          oldBlock,
          `        if (!context.worker.isCancelled?.()) {
          // El drain devuelve el resumen REAL: cuantos se publicaron y cuantos
          // fallaron. Antes run.done era "cuantos se crearon" y el mensaje final
          // decia "N programados" aunque la subida hubiera fallado.
          const drainSummary = await context.worker.drainTikTokQueue({
            onJob: (job) => {
              run.lastVideoName = job.payload?.videoName || run.lastVideoName;
              run.lastScheduledAt = job.payload?.nativeScheduledAt || run.lastScheduledAt;
            },
          });
          if (drainSummary && typeof drainSummary === "object") {
            if (Number.isFinite(drainSummary.published)) {
              run.published = drainSummary.published;
            }
            if (Number.isFinite(drainSummary.failed)) {
              run.failed = (run.failed || 0) + drainSummary.failed;
            }
          }
        }`
        );
        fs.writeFileSync(CLONE, c, "utf8");
        ok("autoclone/index.js: guarda published y failed reales del lote");
      } else {
        skip("no encontre el bloque drainTikTokQueue en autoclone/index.js");
      }
    }
  }
}

// ===========================================================================
// 5. web/autopost.js: mensaje honesto (no decir "N programados" si fallaron)
// ===========================================================================
{
  const AUTO = path.join(ROOT, "web", "autopost.js");
  if (!fs.existsSync(AUTO)) {
    skip("no encontre web/autopost.js: el mensaje seguira siendo optimista");
  } else {
    let a = fs.readFileSync(AUTO, "utf8");
    if (a.includes("TIKTOK-HONEST-SUMMARY-v2")) {
      skip("web/autopost.js ya daba un mensaje honesto");
    } else {
      const oldMsg =
        'else setMessage(`Listo. ${run?.done || 0} vídeos programados en TikTok. Ya puedes apagar el PC.`, "ok");';
      if (a.includes(oldMsg)) {
        a = a.replace(
          oldMsg,
          `else {
              // TIKTOK-HONEST-SUMMARY-v2: informar de lo que REALMENTE se subio.
              const published = run?.published;
              const failedCount = run?.failed || 0;
              if (failedCount > 0) {
                const okCount = Number.isFinite(published) ? published : (run?.done || 0) - failedCount;
                setMessage(
                  \`Listo. \${okCount} vídeos subidos a TikTok y \${failedCount} fallaron. Revisa la carpeta failed del proyecto.\`,
                  "error"
                );
              } else if (Number.isFinite(published)) {
                setMessage(\`Listo. \${published} vídeos programados en TikTok. Ya puedes apagar el PC.\`, "ok");
              } else {
                setMessage(\`Listo. \${run?.done || 0} vídeos programados en TikTok. Ya puedes apagar el PC.\`, "ok");
              }
            }`
        );
        fs.writeFileSync(AUTO, a, "utf8");
        ok("web/autopost.js: mensaje honesto (avisa si algun video fallo)");
      } else {
        skip("no encontre el mensaje final en web/autopost.js");
      }
    }
  }
}

// ===========================================================================
// Escribir
// ===========================================================================
if (w !== before && !results.some(([s]) => s === "FAIL")) {
  const backup = `${WORKER}.tiktok-lane-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(WORKER, backup);
  fs.writeFileSync(WORKER, w, "utf8");
  ok("src/autonomous-worker.js actualizado (backup .tiktok-lane-backup)");
}

// ===========================================================================
// Verificacion
// ===========================================================================
{
  const files = [
    WORKER,
    path.join(SRC, "autoclone", "index.js"),
    path.join(ROOT, "web", "autopost.js"),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (check.status !== 0) {
      fail(`Sintaxis rota en ${path.basename(file)}: ` + (check.stderr || "").split("\n").filter(Boolean)[0]);
    }
  }
}

console.log("\n=== AutoSocial Studio - TikTok: un solo navegador a la vez ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const changes = results.filter(([s]) => s === "OK").length;
const skips = results.filter(([s]) => s === "SKIP").length;
console.log(`\n${changes} cambios, ${skips} ya presentes, ${failures.length} errores.`);

if (failures.length) {
  console.error("\nRevisa los FAIL de arriba. Backups en *.tiktok-lane-backup.");
  process.exitCode = 1;
} else {
  console.log(
    "\nHecho. Ahora el temporizador NO puede lanzar un segundo job de TikTok" +
    "\nmientras el lote esta subiendo videos: se acabo el exitCode=21 por dos" +
    "\nChrome sobre el mismo perfil.\n" +
    "\nReinicia el dashboard:  node src/dashboard-server.js"
  );
}
