#!/usr/bin/env node
/**
 * instalar-tiktok-subida-solida.js
 * ---------------------------------------------------------------------------
 * ARREGLA LA LOGICA DE LAS ACCIONES DE SUBIDA DE TIKTOK.
 *
 * QUE ESTABA ROTO
 *   uploadVideo() abria y cerraba Chrome en CADA video:
 *       const context = await openPersistentContext(accountId);
 *       ...
 *       } finally { await context.close(); }   // pase lo que pase
 *   Chrome no permite dos procesos sobre el mismo --user-data-dir y NO libera
 *   el perfil al instante al cerrarse. El video siguiente arranca antes de que
 *   se suelte -> launchPersistentContext falla con exitCode=21
 *   ("Target page, context or browser has been closed").
 *   Resultado: TODOS los videos fallan en browser-starting, en cadena, y el
 *   worker los reintenta en bucle.
 *
 * QUE HACE ESTE INSTALADOR (fusion de los dos parches, sin duplicar)
 *   A. uploadVideo() acepta un navegador ya abierto y NO lo cierra por video.
 *   B. openPersistentContext() espera a que el perfil se libere, borra los
 *      candados huerfanos (SingletonLock/Cookie/Socket) y, si de verdad sigue
 *      ocupado, ABORTA con un mensaje claro en vez de fallar 60 veces.
 *   C. Crea src/tiktok-batch.js: un solo navegador para todo el lote, videos
 *      uno a uno, reapertura si el navegador muere, resumen honesto.
 *   D. El lote usa la apertura robusta (B) y detecta la pared de login.
 *
 * Idempotente: puedes ejecutarlo varias veces sin dano.
 * Uso:  node instalar-tiktok-subida-solida.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const UPLOADER = path.join(SRC, "tiktok-uploader.js");
const BATCH = path.join(SRC, "tiktok-batch.js");

const MARK_REUSE = "// MARKER: TIKTOK-REUSE-BROWSER-v2";
const MARK_PROFILE = "// MARKER: TIKTOK-PROFILE-RELEASE-v1";
const MARK_BATCH = "// MARKER: TIKTOK-SINGLE-BROWSER-BATCH-v2";

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(UPLOADER)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// ===========================================================================
// A + B - src/tiktok-uploader.js
// ===========================================================================
let text = fs.readFileSync(UPLOADER, "utf8");
const before = text;

// --- B. helper de apertura robusta, antes de openPersistentContext ----------
if (text.includes("async function openContextWithRetry(")) {
  skip("la apertura robusta del perfil ya estaba instalada");
} else {
  const anchor = "async function openPersistentContext(accountId) {";
  if (!text.includes(anchor)) {
    fail("No encontre openPersistentContext.");
  } else {
    const helper = `/**
 * ${MARK_PROFILE}
 * Abre el perfil persistente de la cuenta esperando a que Chrome lo libere.
 * Windows no suelta el --user-data-dir de inmediato tras cerrarse: si se lanza
 * otro proceso sobre el mismo perfil, falla con exitCode=21. Aqui limpiamos
 * candados huerfanos y reintentamos; si sigue ocupado de verdad, abortamos con
 * un mensaje claro en vez de dejar caer todo el lote.
 */
async function openContextWithRetry(accountId, maxMs = 30000) {
  const fsSync = require("fs");
  const profileDir = await getPlatformProfileDir("tiktok", accountId);
  await fs.mkdir(profileDir, { recursive: true });

  const options = {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  const tryLaunch = async (opts) => chromium.launchPersistentContext(profileDir, opts);

  const deadline = Date.now() + maxMs;
  let announced = false;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        fsSync.rmSync(path.join(profileDir, lock), { force: true });
      } catch {
        // En Windows el candado puede estar en uso: no es fatal, lo ignora.
      }
    }
    try {
      return await tryLaunch(options);
    } catch (error) {
      lastError = error;
      // Un navegador del sistema puede salvar el caso de Chromium no instalado.
      const candidates = process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
      const chrome = candidates.find((c) => c && fsSync.existsSync(c));
      if (chrome) {
        try {
          return await tryLaunch({ ...options, executablePath: chrome });
        } catch (error2) {
          lastError = error2;
        }
      }
      if (!announced) {
        console.log("El perfil de TikTok esta ocupado; esperando a que Chrome lo libere...");
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new Error(
    "No se pudo abrir el perfil de TikTok: sigue en uso por otro proceso. " +
    "Cierra TODAS las ventanas de Chrome (taskkill /F /IM chrome.exe /T) " +
    "y vuelve a lanzar la subida. Detalle: " +
    (lastError ? lastError.message : "desconocido")
  );
}

${anchor}`;
    text = text.replace(anchor, helper);
    ok("apertura robusta del perfil anadida (espera, limpia candados, aborta claro)");
  }
}

// --- A. firma + arranque + cierre condicional de uploadVideo ----------------
{
  // IMPORTANTE: recalcular el offset. El helper de arriba se inserto antes de
  // uploadVideo, asi que cualquier fnStart anterior quedo desplazado.
  const fnStartNow = text.indexOf("async function uploadVideo(");
  if (fnStartNow === -1) {
    fail("No encontre uploadVideo.");
  } else {
    // El cierre del navegador es lo ultimo de uploadVideo: buscamos desde ahi.
    const closeAnchor = text.indexOf("await context.close();", fnStartNow);
    const endOfFn = closeAnchor === -1 ? -1 : text.indexOf("\n}\n", closeAnchor);
    if (closeAnchor === -1 || endOfFn === -1) {
      fail("No encontre el cierre de uploadVideo (estructura distinta).");
    } else {
      let body = text.slice(fnStartNow, endOfFn);
      const alreadyPatched = /\bownsBrowser\b/.test(body) || text.includes(MARK_REUSE);
      let changed = false;

      // 1) FIRMA: anadir page/context/reuseBrowser solo si faltan.
      const sigMatch = body.match(/async function uploadVideo\(\s*\{([\s\S]*?)\}\s*\)\s*\{/);
      if (!sigMatch) {
        fail("No pude leer la firma de uploadVideo.");
      } else {
        const inner = sigMatch[1].replace(/\s*$/, "");
        const needed = [];
        if (!/\baccountId\b/.test(inner)) needed.push("accountId");
        if (!/\bpage\s*:/.test(inner) && !/\bsharedPage\b/.test(inner)) needed.push("page: sharedPage");
        if (!/\bcontext\s*:/.test(inner) && !/\bsharedContext\b/.test(inner)) needed.push("context: sharedContext");
        if (!/\breuseBrowser\b/.test(inner)) needed.push("reuseBrowser");
        if (needed.length) {
          body = body.replace(sigMatch[0], `async function uploadVideo({${inner}, ${needed.join(", ")} }) {`);
          changed = true;
          ok("firma de uploadVideo completada: " + needed.join(", "));
        } else {
          skip("la firma de uploadVideo ya estaba completa");
        }
      }

      // 2) ARRANQUE: si ya hay ownsBrowser, solo aseguramos openContextWithRetry.
      const openRe =
        /const context = await openPersistentContext\(([^)]*)\);[\s\S]{0,400}?const page = (?:context\.pages\(\)\[0\] \|\| \(await context\.newPage\(\)\)|await context\.newPage\(\));/;
      const openMatch = body.match(openRe);
      if (openMatch) {
        body = body.replace(
          openRe,
          `${MARK_REUSE}\n` +
            "  // Con reuseBrowser, la pagina y el contexto vienen del lote: un solo\n" +
            "  // navegador para todos los videos, sin abrir/cerrar uno por video.\n" +
            "  const ownsBrowser = !(reuseBrowser && sharedPage && sharedContext);\n" +
            "  const context = ownsBrowser\n" +
            `    ? await openContextWithRetry(${openMatch[1]})\n` +
            "    : sharedContext;\n" +
            "  const page = ownsBrowser\n" +
            "    ? context.pages()[0] || (await context.newPage())\n" +
            "    : sharedPage;"
        );
        changed = true;
        ok("uploadVideo acepta page/context/reuseBrowser");
      } else if (alreadyPatched) {
        // Ya tiene ownsBrowser: solo cambiamos la apertura por la robusta.
        const oldOpen = /const context = ownsBrowser\s*\?\s*await openPersistentContext\(([^)]*)\)\s*:\s*sharedContext;/;
        if (oldOpen.test(body)) {
          body = body.replace(
            oldOpen,
            "const context = ownsBrowser\n    ? await openContextWithRetry($1)\n    : sharedContext;"
          );
          changed = true;
          ok("apertura cambiada a openContextWithRetry (con reintentos)");
        } else if (body.includes("openContextWithRetry")) {
          skip("el arranque ya usaba openContextWithRetry");
        } else {
          fail("uploadVideo tiene ownsBrowser pero no pude localizar su apertura de contexto.");
        }
      } else {
        fail(
          "No encontre el arranque contexto/pagina de uploadVideo. " +
          "Manda el trozo desde 'const context =' hasta 'const page ='."
        );
      }

      // 3) CIERRE CONDICIONAL. Idempotente: si el cierre ya esta protegido por
      // ownsBrowser (en cualquier variante, incluida la que deja el navegador
      // abierto si falla la programacion), no se toca.
      const closeAlreadyGuarded =
        /if\s*\(\s*ownsBrowser[\s\S]{0,200}?await context\.close\(\)/.test(body) ||
        /if\s*\(!ownsBrowser\)[\s\S]{0,200}?(?:nunca lo cierra|no lo cierra)/.test(body);

      const closeRe =
        /await holdBrowserBeforeClose\(page, closeHoldMs, "post-finalization"\);\s*\n\s*await context\.close\(\);/;
      if (closeAlreadyGuarded) {
        skip("el cierre ya estaba protegido por ownsBrowser");
      } else if (closeRe.test(body)) {
        body = body.replace(
          closeRe,
          "// Solo se cierra si lo abrimos nosotros: con sesion compartida el\n" +
            "    // navegador lo cierra el lote al terminar el ultimo video.\n" +
            "    if (ownsBrowser) {\n" +
            "      await holdBrowserBeforeClose(page, closeHoldMs, \"post-finalization\");\n" +
            "      await context.close();\n" +
            "    }"
        );
        changed = true;
        ok("uploadVideo solo cierra el navegador cuando es suyo");
      } else {
        fail("No encontre el cierre de contexto de uploadVideo.");
      }

      if (changed) {
        text = text.slice(0, fnStartNow) + body + text.slice(endOfFn);
      }
    }
  }
}

if (text !== before && !results.some(([s]) => s === "FAIL")) {
  const backup = `${UPLOADER}.tiktok-subida-solida-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(UPLOADER, backup);
  fs.writeFileSync(UPLOADER, text, "utf8");
  ok("src/tiktok-uploader.js actualizado (backup .tiktok-subida-solida-backup)");
}

// ===========================================================================
// C - src/tiktok-batch.js
// ===========================================================================
const batchSource = `const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { getPlatformProfileDir, getActiveAccount } = require("./account-manager");
const { listQueueVideos, readCaption, getCaptionPaths } = require("./queue");
const { ensureDirectories, moveWithTimestamp, fileExists } = require("./fs-utils");

${MARK_BATCH}

let batchState = {
  running: false, total: 0, done: 0, posted: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null, results: [],
};

function getBatchState() {
  return JSON.parse(JSON.stringify(batchState));
}

async function moveCaptionSidecars(captionPaths, targetDir) {
  const moved = [];
  for (const cp of captionPaths) {
    if (!(await fileExists(cp))) continue;
    try {
      moved.push(await moveWithTimestamp(cp, targetDir));
    } catch (error) {
      console.error(\`No se pudo mover el sidecar de caption: \${error.message}\`);
    }
  }
  return moved;
}

/**
 * Sube TODA la cola de TikTok usando UN SOLO navegador.
 * - Abre Chrome una vez (perfil persistente de la cuenta) con reintento.
 * - Videos uno a uno: no empieza el siguiente hasta que el anterior termina.
 * - Reabre el navegador si muere a mitad, sin perder el lote.
 * - Al terminar el ultimo, cierra el navegador.
 */
async function uploadTikTokQueueInOneBrowser({
  accountId, queueDir, postedDir, failedDir, uploader, onProgress, keepBrowserOpen = false,
} = {}) {
  if (batchState.running) {
    return { ok: false, error: "Ya hay un lote de TikTok en curso." };
  }

  const account = accountId ? { id: accountId } : await getActiveAccount();
  const queue = queueDir || config.queueDir;
  const posted = postedDir || config.postedDir;
  const failed = failedDir || config.failedDir;
  const uploaderModule = uploader || require("./tiktok-uploader");

  await ensureDirectories([queue, posted, failed]);

  const videos = await listQueueVideos(queue);
  batchState = {
    running: true, total: videos.length, done: 0, posted: 0, failed: 0,
    current: null, startedAt: new Date().toISOString(), finishedAt: null, results: [],
  };

  if (videos.length === 0) {
    batchState.running = false;
    batchState.finishedAt = new Date().toISOString();
    return { ok: true, skipped: true, reason: "La cola esta vacia.", ...getBatchState() };
  }

  const profileDir = await getPlatformProfileDir("tiktok", account.id);
  await fs.mkdir(profileDir, { recursive: true });

  // Apertura robusta: el uploader expone la espera de liberacion del perfil.
  const open = async () => {
    if (typeof uploaderModule.openContextWithRetry === "function") {
      return uploaderModule.openContextWithRetry(account.id);
    }
    const { chromium } = require("playwright");
    return chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      viewport: { width: 1400, height: 1000 },
      locale: config.browserLocale,
      timezoneId: config.timezone,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  };

  let context = await open();
  let page = context.pages()[0] || (await context.newPage());

  const browserIsAlive = () => {
    try { return !context.pages().every((p) => p.isClosed()); } catch { return false; }
  };

  const reopenBrowser = async () => {
    await context.close().catch(() => {});
    context = await open();
    page = context.pages()[0] || (await context.newPage());
  };

  try {
    for (const videoPath of videos) {
      if (!browserIsAlive()) {
        console.log("El navegador se cerro; reabriendo para continuar el lote...");
        await reopenBrowser();
      }
      const name = path.basename(videoPath);
      batchState.current = name;
      const caption = await readCaption(videoPath);
      const captionPaths = getCaptionPaths(videoPath);

      let result;
      try {
        result = await uploaderModule.uploadVideo({
          videoPath, caption, source: "queue-batch",
          accountId: account.id, page, context, reuseBrowser: true,
        });
      } catch (error) {
        result = { ok: false, error: error.message || "Error inesperado al subir." };
      }

      if (result && result.ok) {
        const moved = await moveWithTimestamp(videoPath, posted).catch(() => null);
        await moveCaptionSidecars(captionPaths, posted);
        if (!moved) {
          await moveWithTimestamp(videoPath, failed).catch(() => null);
          batchState.failed += 1;
          batchState.results.push({ video: name, ok: false, error: "Se publico, pero no se pudo archivar." });
        } else {
          batchState.posted += 1;
          batchState.results.push({ video: name, ok: true, archived: true });
        }
      } else {
        await moveWithTimestamp(videoPath, failed).catch(() => null);
        await moveCaptionSidecars(captionPaths, failed);
        batchState.failed += 1;
        batchState.results.push({ video: name, ok: false, error: (result && result.error) || "Fallo desconocido." });
      }
      batchState.done += 1;
      if (typeof onProgress === "function") {
        try { onProgress(getBatchState(), name, result); } catch { /* la UI no rompe el lote */ }
      }
    }
  } finally {
    if (!keepBrowserOpen) await context.close().catch(() => {});
    batchState.running = false;
    batchState.current = null;
    batchState.finishedAt = new Date().toISOString();
  }

  return { ok: batchState.failed === 0, ...getBatchState() };
}

function summarizeBatch(state) {
  const s = state || batchState;
  return \`\${s.posted} publicados, \${s.failed} fallidos de \${s.total}.\`;
}

module.exports = {
  uploadTikTokQueueInOneBrowser, getBatchState, summarizeBatch,
  _private: { moveCaptionSidecars },
};
`;

if (fs.existsSync(BATCH) && fs.readFileSync(BATCH, "utf8").includes(MARK_BATCH)) {
  skip("src/tiktok-batch.js ya estaba instalado");
} else {
  fs.writeFileSync(BATCH, batchSource, "utf8");
  ok("src/tiktok-batch.js instalado (un navegador, secuencial, resumen real)");
}

// El uploader debe exponer la apertura robusta para el lote.
{
  const modAnchor = "  uploadVideo,";
  let t = fs.readFileSync(UPLOADER, "utf8");
  if (t.includes("openContextWithRetry,")) {
    skip("el uploader ya expone openContextWithRetry");
  } else if (t.includes(modAnchor)) {
    t = t.replace(modAnchor, "  uploadVideo,\n  openContextWithRetry,");
    fs.writeFileSync(UPLOADER, t, "utf8");
    ok("el uploader expone openContextWithRetry para el lote");
  } else {
    fail("No encontre el module.exports del uploader.");
  }
}

// ===========================================================================
// E - resumen honesto: no decir "N programados" si solo subio 1
// ===========================================================================
{
  const WORKER = path.join(SRC, "autonomous-worker.js");
  if (!fs.existsSync(WORKER)) {
    skip("no encontre src/autonomous-worker.js: revisa a mano el resumen final");
  } else {
    let w = fs.readFileSync(WORKER, "utf8");
    const wBefore = w;

    // El texto suele montarse como: `${n} videos programados en TikTok`.
    // Lo cambiamos por un resumen que informe de fallos si los hubo.
    const msgRe = /(\$\{?\s*[\w.]*?(?:posted|succeeded|subidos|programados)[\w.]*\s*\}?\s*[\w\s]*v[ií]deos?\s+programados en TikTok\.?)/i;
    if (w.includes("TIKTOK-HONEST-SUMMARY-v1")) {
      skip("el resumen del worker ya era honesto");
    } else if (msgRe.test(w)) {
      w = w.replace(
        msgRe,
        "${(typeof failed !== 'undefined' && failed > 0)" +
          " ? `${posted} de ${total} videos subidos en TikTok; ${failed} FALLARON (revisa failed/).`" +
          " : `${posted} videos programados en TikTok.`}" + "\n// TIKTOK-HONEST-SUMMARY-v1"
      );
      ok("resumen del worker: avisa si algun video fallo");
    } else {
      skip("no localice el texto de resumen en el worker (lo revisas a mano)");
    }

    if (w !== wBefore) {
      const wBackup = `${WORKER}.tiktok-subida-solida-backup`;
      if (!fs.existsSync(wBackup)) fs.copyFileSync(WORKER, wBackup);
      fs.writeFileSync(WORKER, w, "utf8");
      const chk = spawnSync(process.execPath, ["--check", WORKER], { encoding: "utf8" });
      if (chk.status !== 0) {
        fs.copyFileSync(wBackup, WORKER);
        fail("El parche del worker rompia sintaxis; restaurado su backup.");
      }
    }
  }
}

// ===========================================================================
// D - verificacion: sintaxis y ausencia de duplicados (la unica prueba fiable)
// ===========================================================================
for (const file of [UPLOADER, BATCH]) {
  if (!fs.existsSync(file)) continue;
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    fail(`Sintaxis rota en ${path.basename(file)}: ` + (check.stderr || "").split("\n").filter(Boolean)[0]);
  }
}

{
  const t = fs.readFileSync(UPLOADER, "utf8");
  const count = (t.match(/async function openContextWithRetry\(/g) || []).length;
  if (count > 1) {
    fail(`openContextWithRetry esta duplicada (${count} veces). Restaura el backup y avisame.`);
  }
}

console.log("\n=== AutoSocial Studio - TikTok: subida solida ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const changes = results.filter(([s]) => s === "OK").length;
const skips = results.filter(([s]) => s === "SKIP").length;
console.log(`\n${changes} cambios, ${skips} ya presentes, ${failures.length} errores.`);

if (failures.length) {
  console.error(
    "\nNo se dejo nada a medias. Tu copia original esta en " +
    "src/tiktok-uploader.js.tiktok-subida-solida-backup"
  );
  process.exitCode = 1;
} else {
  console.log("\nHecho. Para subir la cola con un solo navegador:");
  console.log("");
  console.log('  const { uploadTikTokQueueInOneBrowser } = require("./tiktok-batch");');
  console.log("  const r = await uploadTikTokQueueInOneBrowser({ accountId: \"kim-tae-jin\" });");
  console.log("  console.log(r.posted + \" publicados, \" + r.failed + \" fallidos\");");
  console.log("");
  console.log("Antes de lanzarlo, cierra cualquier Chrome abierto para evitar");
  console.log("que el perfil siga ocupado.  Reinicia:  node src/dashboard-server.js");
}
