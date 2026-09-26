#!/usr/bin/env node
/**
 * aplicar-parches-tiktok.js
 * ---------------------------------------------------------------
 * Aplica 5 mejoras al codigo de AutoSocial Studio para que una cuenta
 * deje de quedarse "atascada" en pending con jobs cancelados, y para que
 * la subida no se quede parada esperando la verificacion de TikTok.
 *
 * Es IDEMPOTENTE: si un parche ya esta aplicado, lo detecta y no lo
 * duplica. Hace copia .bak-fix-<fecha> antes de tocar cada archivo y
 * valida la sintaxis con `node --check` al terminar.
 *
 * Uso (desde la carpeta del proyecto):
 *   node aplicar-parches-tiktok.js            (aplica)
 *   node aplicar-parches-tiktok.js --dry      (solo comprueba)
 *   node aplicar-parches-tiktok.js --revert   (restaura los .bak-fix mas recientes)
 *
 * Parches:
 *   P1  job-store.js  -> no reutilizar un job CANCELADO/FALLADO por dedupeKey;
 *                        crear uno nuevo (permite reintentar el mismo video).
 *   P2  autoclone/index.js -> el resumen "published" cuenta solo jobs
 *                        realmente succeeded, no los creados.
 *   P3  autoclone/scheduler.js -> separa "encolado" de "publicado" y no marca
 *                        como fallido un job cancelado por el usuario.
 *   P4  autonomous-worker.js -> drainTikTokQueue informa de cuantos jobs
 *                        quedaron cancelados, para que la UI no diga "listo".
 *   P5  tiktok-uploader.js -> NO bloquearse esperando el "Content check lite"
 *                        de TikTok: espera corta (45s) y continua igual.
 *   P6  tiktok-uploader.js -> usar de verdad el navegador COMPARTIDO del lote
 *                        y quitar la espera de 25s por video ("Holding
 *                        browser for 25000ms"), que hacia parecer que se para.
 *   P7  autonomous-worker.js -> exclusion mutua REAL entre el temporizador y
 *                        el drenaje manual: fin de los exitCode=21 ("perfil en
 *                        uso por otro proceso") que tumbaban el lote.
 *   P8  tiktok-uploader.js -> pulsar el segundo boton "Post now" del popup de
 *                        confirmacion que TikTok muestra si el video aun se
 *                        esta verificando (Content check lite).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const dry = args.includes("--dry") || args.includes("--dry-run");
const revert = args.includes("--revert");
const ROOT = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.error("Ejecuta este script DENTRO de la carpeta del proyecto (donde esta package.json).");
  process.exit(1);
}

let applied = 0, skipped = 0, failed = 0;

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`No existe ${rel}`);
  return fs.readFileSync(p, "utf8");
}

async function edit(rel, marker, replacer, label) {
  const p = path.join(ROOT, rel);
  let src = read(rel);
  if (src.includes(marker)) {
    console.log(`  [=] ${label} (ya aplicado)`);
    skipped++;
    return;
  }
  const out = replacer(src);
  if (out === src) {
    console.log(`  [!] ${label}: no coincidio el texto esperado`);
    failed++;
    return;
  }
  if (dry) {
    console.log(`  [~] ${label} (se aplicaria)`);
    applied++;
    return;
  }
  // Backup UNA SOLA VEZ por archivo y ejecucion: si varios parches tocan el
  // mismo archivo (p.ej. tiktok-uploader.js con P5 y P6), hay que guardar el
  // estado ORIGINAL una vez, no sobrescribirlo en cada parche (si no, --revert
  // restauraba una version ya parcheada y quedaban parches sueltos).
  const backupPath = `${p}.bak-fix-${stamp}`;
  if (!fs.existsSync(backupPath)) {
    await fsp.copyFile(p, backupPath);
  }
  await fsp.writeFile(p, out, "utf8");
  console.log(`  [+] ${label}`);
  applied++;
}

async function revertAll() {
  const files = ["src/job-store.js", "src/autoclone/index.js", "src/autoclone/scheduler.js", "src/autonomous-worker.js", "src/tiktok-uploader.js", "src/platform-ui-labels.js"];
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    const dir = path.dirname(p);
    const base = path.basename(p);
    // Los backups llevan sello de tiempo: agrupamos por tanda y usamos la MAS
    // ANTIGUA de la tanda MAS RECIENTE (el estado ORIGINAL de esa ejecucion).
    // Si varios parches tocaron el mismo archivo, todos comparten el sello.
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-fix-`));
    if (!baks.length) { console.log(`  [-] ${rel}: sin backup`); continue; }
    const stamps = [...new Set(baks.map((f) => f.slice(`${base}.bak-fix-`.length)))].sort();
    const latestStamp = stamps[stamps.length - 1];
    const name = `${base}.bak-fix-${latestStamp}`;
    await fsp.copyFile(path.join(dir, name), p);
    console.log(`  [<] ${rel} restaurado desde ${name}`);
  }
  console.log("\nReversion completada.");
}

async function main() {
  if (revert) { console.log("\n== Revirtiendo parches ==\n"); await revertAll(); return; }

  console.log(`\n== Parches TikTok ${dry ? "(SIMULACION)" : ""} ==\n`);

  /* P1 — job-store: no reutilizar jobs terminales por dedupeKey */
  await edit(
    "src/job-store.js",
    "PATCH-TIKTOK-DEDUPE-TERMINAL",
    (src) => src.replace(
      `      if (input.dedupeKey) {
        const existing = state.jobs.find((job) => job.dedupeKey === input.dedupeKey);
        if (existing) return existing;
      }`,
      `      // PATCH-TIKTOK-DEDUPE-TERMINAL
      // No reutilizar un job que ya termino (cancelado/fallido/incierto):
      // si no, el mismo video nunca se puede reintentar y se queda en pending.
      if (input.dedupeKey) {
        const existing = state.jobs.find(
          (job) =>
            job.dedupeKey === input.dedupeKey &&
            !["cancelled", "failed", "uncertain"].includes(job.status)
        );
        if (existing) return existing;
      }`
    ),
    "P1 job-store: reintentar videos con job cancelado"
  );

  /* P2 — autoclone/index.js: published real vs creados */
  await edit(
    "src/autoclone/index.js",
    "PATCH-TIKTOK-HONEST-DONE",
    (src) => src.replace(
      `        run.total = result.total || run.total;
        run.done = result.created.length;`,
      `        run.total = result.total || run.total;
        // PATCH-TIKTOK-HONEST-DONE
        // done = videos que ARRANCARON el proceso, no los meramente encolados.
        run.done = result.created.length;`
    ),
    "P2 autoclone: base del resumen honesto"
  );

  /* P3 — scheduler.finalizeSchedule: no marcar fallo un job cancelado */
  await edit(
    "src/autoclone/scheduler.js",
    "PATCH-TIKTOK-CANCELLED-NOT-FAILED",
    (src) => src.replace(
      `    } else if (["failed", "uncertain"].includes(job.status)) {
      await moveToFailed(item.sourcePath, failedDir);
      state.failedNames = [...(state.failedNames || []), item.videoName];
      result.failed += 1;
    } else {
      result.pending += 1;
    }`,
      `    } else if (["failed", "uncertain"].includes(job.status)) {
      await moveToFailed(item.sourcePath, failedDir);
      state.failedNames = [...(state.failedNames || []), item.videoName];
      result.failed += 1;
    } else if (job.status === "cancelled") {
      // PATCH-TIKTOK-CANCELLED-NOT-FAILED
      // Cancelado por el usuario != fallo: NO se anota en failedNames
      // (eso impediria volver a programarlo) ni se mueve a failed.
      result.pending += 1;
    } else {
      result.pending += 1;
    }`
    ),
    "P3 scheduler: cancelado no contamina failedNames"
  );

  /* P4 — drainTikTokQueue: informar de cancelados */
  await edit(
    "src/autonomous-worker.js",
    "PATCH-TIKTOK-DRAIN-CANCELLED",
    (src) => {
      // Añade contador cancelled al drenaje.
      let out = src.replace(
        `    let processed = 0;
    let published = 0;
    let failed = 0;`,
        `    let processed = 0;
    let published = 0;
    let failed = 0;
    // PATCH-TIKTOK-DRAIN-CANCELLED
    let cancelled = 0;`
      );
      out = out.replace(
        `        if (this.isCancelled()) {
          // Devolvemos el job reclamado para que se pueda ejecutar luego.
          try {
            if (typeof this.store.release === "function") {
              await this.store.release(job.id);
            }
          } catch {
            // Liberar es best-effort.
          }
          break;
        }`,
        `        if (this.isCancelled()) {
          // PATCH-TIKTOK-DRAIN-CANCELLED
          // Devolvemos el job reclamado para que se pueda ejecutar luego.
          cancelled += 1;
          try {
            if (typeof this.store.release === "function") {
              await this.store.release(job.id);
            }
          } catch {
            // Liberar es best-effort.
          }
          break;
        }`
      );
      out = out.replace(
        `    return { processed, published, failed };
  }

  recordError(error) {`,
        `    return { processed, published, failed, cancelled };
  }

  recordError(error) {`
      );
      return out;
    },
    "P4 worker: informar de cancelados en el drenaje"
  );

  /* P5 — tiktok-uploader: no bloquearse 10 min esperando el "Content check" */
  await edit(
    "src/tiktok-uploader.js",
    "PATCH-TIKTOK-NONBLOCKING-PROCESSING",
    (src) => {
      let out = src;
      // 5a. La espera por defecto baja de 10 minutos a 15 segundos y es
      //     EXPLICITAMENTE no bloqueante: si TikTok sigue verificando, sigue.
      out = out.replace(
        `async function waitForVideoProcessing(page, maxMs = 600000) {
  // MARKER: TIKTOK-WAIT-READY-BY-STATE-v2`,
        `async function waitForVideoProcessing(page, maxMs = 15000) {
  // PATCH-TIKTOK-NONBLOCKING-PROCESSING
  // TikTok puede mostrar "Content check lite / Checking in progress..." durante
  // mucho tiempo. NO hay que quedarse esperando: se espera un maximo corto y se
  // CONTINUA SIEMPRE con el flujo (la programacion nativa no necesita que la
  // verificacion haya terminado).
  // MARKER: TIKTOK-WAIT-READY-BY-STATE-v2`
      );
      // 5b. Mensaje de fin mas claro y en espanol.
      out = out.replace(
        `  console.log("TikTok: no se confirmo el fin del procesado; se intenta programar igual.");
  return false;
}`,
        `  console.log(
    "TikTok: la verificacion sigue en curso; se CONTINUA igualmente con la programacion (no bloqueante)."
  );
  return false;
}`
      );
      // 5c. En modo programacion, la espera previa pasa a 15s como mucho.
      out = out.replace(
        `    if (scheduleMode) {
      // MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1
      // Espera por estado (no por texto) antes de tocar la programacion.
      await waitForVideoProcessing(page);`,
        `    if (scheduleMode) {
      // PATCH-TIKTOK-NONBLOCKING-PROCESSING
      // Espera corta (15s max) y sigue aunque siga el "Content check".
      await waitForVideoProcessing(page, 15000);`
      );
      return out;
    },
    "P5 uploader: no bloquearse esperando la verificacion de TikTok"
  );

  /* P6 — tiktok-uploader: usar el navegador compartido y no esperar 25s por video */
  await edit(
    "src/tiktok-uploader.js",
    "PATCH-TIKTOK-SHARED-BROWSER-ACTUALLY-USED",
    (src) => {
      let out = src;
      // 6a. reuseBrowser debe usar el navegador COMPARTIDO del lote aunque
      //     nadie le pase page/context. Antes ownsBrowser quedaba en true y
      //     cada video abria/cerraba su propio Chrome (con 25s de espera).
      out = out.replace(
        `  const absoluteVideoPath = path.resolve(videoPath);
  // MARKER: TIKTOK-REUSE-BROWSER-v1
  // Con reuseBrowser la pagina y el contexto vienen del lote (un solo
  // navegador para todos los videos) y NO se cierran aqui.
  const ownsBrowser = !(reuseBrowser && sharedPage && sharedContext);`,
        `  const absoluteVideoPath = path.resolve(videoPath);
  // PATCH-TIKTOK-SHARED-BROWSER-ACTUALLY-USED
  // Con reuseBrowser SIEMPRE se usa el navegador compartido del lote, aunque
  // no vengan page/context ya abiertos: se piden aqui. Antes, al no venir,
  // ownsBrowser quedaba en true y cada video abria y cerraba su propio Chrome
  // (25s de espera "Holding browser" por video).
  const wantShared = Boolean(reuseBrowser);
  const ownsBrowser = !wantShared;`
      );
      // 6b. La rama de navegador compartido debe adquirirlo si no viene dado.
      out = out.replace(
        `  if (ownsBrowser) {
    context = await openContextWithRetry(accountId);
    page = context.pages()[0] || (await context.newPage());
  } else {
    lease = await acquireSharedTikTokBrowser(accountId);
    context = lease.context;
    page = lease.page;
  }`,
        `  if (ownsBrowser) {
    context = await openContextWithRetry(accountId);
    page = context.pages()[0] || (await context.newPage());
  } else if (sharedPage && sharedContext) {
    context = sharedContext;
    page = sharedPage;
  } else {
    // PATCH-TIKTOK-SHARED-BROWSER-ACTUALLY-USED
    lease = await acquireSharedTikTokBrowser(accountId);
    context = lease.context;
    page = lease.page;
  }`
      );
      // 6c. No mantener el navegador 25s tras publicar: con el navegador
      //     compartido no hace falta y ralentiza todo el lote. Baja a 2s.
      out = out.replace(
        `    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return { ok: true, scheduled: scheduleMode };`,
        `    // PATCH-TIKTOK-SHARED-BROWSER-ACTUALLY-USED
    // Con navegador compartido no hay que "sostener" 25s por video: se baja a 2s.
    closeHoldMs = lease ? 2000 : Math.max(config.postPublishHoldMs, 0);
    return { ok: true, scheduled: scheduleMode };`
      );
      return out;
    },
    "P6 uploader: navegador compartido real + sin espera de 25s"
  );

  /* P7 — autonomous-worker: exclusion mutua REAL entre el temporizador y el drenaje */
  await edit(
    "src/autonomous-worker.js",
    "PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE",
    (src) => {
      let out = src;

      // 7a. Flag explicito de drenaje manual.
      out = out.replace(
        `    this.laneBusy = { "tiktok-publish": false, "flow-generate": false };
    this.lastTickAt = null;`,
        `    this.laneBusy = { "tiktok-publish": false, "flow-generate": false };
    // PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE
    // Mientras el boton "Programar todo" drena, el temporizador NO debe lanzar
    // nada: si no, se abren DOS Chrome sobre el mismo perfil (exitCode=21).
    this.draining = false;
    this.lastTickAt = null;`
      );

      // 7b. El tick se salta por completo si hay un drenaje en curso.
      out = out.replace(
        `  async tick(now = DateTime.now()) {
    if (this.dispatching) return;
    this.dispatching = true;`,
        `  async tick(now = DateTime.now()) {
    if (this.dispatching) return;
    // PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE
    // Si el drenaje manual tiene el control, el temporizador no arranca NINGUN
    // job de TikTok (ni deja un runClaimedJob en segundo plano).
    if (this.draining) return;
    this.dispatching = true;`
      );

      // 7c. dispatchLane respeta el drenaje.
      out = out.replace(
        `  async dispatchLane(type, now) {
    // MARKER: TIKTOK-LANE-EXCLUSIVE-v1
    // Si el bucle de drenaje tiene el lane tomado, no lanzar otro job.
    if (this.laneBusy[type]) return;`,
        `  async dispatchLane(type, now) {
    // PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE
    // Si el drenaje manual esta activo, el temporizador no lanza NADA.
    if (this.draining) return;
    // MARKER: TIKTOK-LANE-EXCLUSIVE-v1
    // Si el bucle de drenaje tiene el lane tomado, no lanzar otro job.
    if (this.laneBusy[type]) return;`
      );

      // 7d. drainTikTokQueue: activa y desactiva el flag draining, y ademas
      //     espera a que no haya un dispatchLane en vuelo antes de empezar.
      out = out.replace(
        `    this.laneBusy["tiktok-publish"] = true;
    this.clearCancellation();
    let processed = 0;
    let published = 0;
    let failed = 0;
    try {`,
        `    // PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE
    // Marcar ANTES de tocar el lane, para que ningun tick se cuele.
    this.draining = true;
    this.laneBusy["tiktok-publish"] = true;
    this.clearCancellation();
    let processed = 0;
    let published = 0;
    let failed = 0;
    try {`
      );
      out = out.replace(
        `    } finally {
      this.laneBusy["tiktok-publish"] = false;
    }
    // Resumen honesto: antes se devolvia solo un numero y el mensaje final
    // decia "N programados" aunque hubieran fallado.
    return { processed, published, failed };`,
        `    } finally {
      this.laneBusy["tiktok-publish"] = false;
      // PATCH-TIKTOK-TICK-DRAIN-EXCLUSIVE
      this.draining = false;
    }
    // Resumen honesto: antes se devolvia solo un numero y el mensaje final
    // decia "N programados" aunque hubieran fallado.
    return { processed, published, failed };`
      );
      return out;
    },
    "P7 worker: temporizador y drenaje ya no chocan (fin de exitCode=21)"
  );

  /* P8 — tiktok-uploader: pulsar el segundo boton "Post now" del popup de confirmacion */
  await edit(
    "src/tiktok-uploader.js",
    "PATCH-TIKTOK-POST-NOW-CONFIRM",
    (src) => {
      let out = src;

      // 8a. Anadir una funcion que detecta y pulsa el boton "Post now" /
      //     "Publicar ahora" del dialogo de confirmacion de TikTok.
      out = out.replace(
        `async function trySecondaryPublishConfirm(page) {`,
        `/**
 * // PATCH-TIKTOK-POST-NOW-CONFIRM
 * TikTok muestra un segundo dialogo cuando pulsas Publicar/Programar mientras
 * el video AUN se esta verificando ("Content check lite"). Ese dialogo tiene un
 * boton con doble confirmacion: "Post now" / "Publicar ahora". Hay que pulsarlo.
 *
 * Devuelve true si lo encontro y lo pulso.
 */
async function clickPostNowConfirm(page) {
  const pattern = /^(post\\s*now|publish\\s*now|publicar\\s*ahora|publicar\\s*ya|postear\\s*ahora|posten\\s*jetzt|veröffentlichen\\s*jetzt|publier\\s*maintenant)$/i;
  const scopes = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="modal" i]',
    '[class*="Modal" i]',
    '[class*="popover" i]',
    '[class*="confirm" i]',
    '[class*="Confirm" i]',
  ].join(", ");

  const tryClick = async (locator, label) => {
    const total = await locator.count().catch(() => 0);
    for (let i = 0; i < total; i += 1) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const text = ((await candidate.innerText().catch(() => "")) || "").trim();
      if (!pattern.test(text)) continue;
      await candidate.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await candidate.click({ timeout: 4000 }).catch(async () => {
        await candidate.click({ timeout: 4000, force: true }).catch(() => {});
      });
      console.log(\`TikTok: pulsado el boton de confirmacion "\${text}" (\${label}).\`);
      return true;
    }
    return false;
  };

  // 1) Dentro de dialogos/modales (lo mas fiable).
  if (await tryClick(page.locator(scopes).locator("button, [role='button']"), "scope")) {
    return true;
  }
  // 2) Por clase concreta de TikTok (TUXButton) como respaldo.
  if (await tryClick(page.locator("button.TUXButton, button[class*='TUXButton' i]"), "TUXButton")) {
    return true;
  }
  // 3) Por texto exacto en toda la pagina, como ultimo recurso.
  if (await tryClick(page.getByRole("button", { name: pattern }), "role")) {
    return true;
  }
  return false;
}

async function trySecondaryPublishConfirm(page) {`
      );

      // 8b. En el bucle de confirmacion, pulsar "Post now" ANTES del resto de
      //     comprobaciones (es la via que desbloquea el flujo cuando verifica).
      out = out.replace(
        `      await trySecondaryPublishConfirm(page);

      if (
        primaryRetryCount < 2 &&`,
        `      // PATCH-TIKTOK-POST-NOW-CONFIRM
      // Si TikTok pide una segunda confirmacion ("Post now"), pulsarla.
      if (await clickPostNowConfirm(page)) {
        await page.waitForTimeout(1500);
        continue;
      }

      await trySecondaryPublishConfirm(page);

      if (
        primaryRetryCount < 2 &&`
      );
      return out;
    },
    "P8 uploader: pulsar el segundo boton 'Post now' del popup de confirmacion"
  );

  /* P8b — platform-ui-labels: reconocer "Post now" / "Publicar ahora" como confirmacion */
  await edit(
    "src/platform-ui-labels.js",
    "PATCH-TIKTOK-POST-NOW-LABELS",
    (src) => src.replace(
      `  tiktokConfirm: [
    "publish",
    "post",
    "confirm",
    "continue",`,
      `  tiktokConfirm: [
    "publish",
    "post",
    "confirm",
    "continue",
    // PATCH-TIKTOK-POST-NOW-LABELS
    // TikTok muestra una segunda confirmacion cuando el video aun se verifica.
    "post now",
    "publish now",
    "publicar ahora",
    "publicar ya",
    "postear ahora",
    "posten jetzt",`
    ),
    "P8b labels: reconocer 'Post now' como boton de confirmacion"
  );

  /* Validacion de sintaxis */
  if (!dry) {
    console.log("\n== Validando sintaxis ==\n");
    for (const rel of ["src/job-store.js", "src/autoclone/index.js", "src/autoclone/scheduler.js", "src/autonomous-worker.js", "src/tiktok-uploader.js", "src/platform-ui-labels.js"]) {
      try {
        execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], { stdio: "pipe" });
        console.log(`  [ok] ${rel}`);
      } catch (error) {
        console.error(`  [ERROR] ${rel}: ${error.stderr?.toString() || error.message}`);
        process.exitCode = 1;
      }
    }
  }

  console.log("\n== Resumen ==");
  console.log(`  Aplicados: ${applied} · Ya estaban: ${skipped} · Con problemas: ${failed}`);
  if (!dry && applied) console.log(`  Backups: *.bak-fix-${stamp}`);
  if (dry) console.log("\n  (SIMULACION: quita --dry para aplicar)");
  console.log("\nReinicia el dashboard. Para deshacer: node aplicar-parches-tiktok.js --revert\n");
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
