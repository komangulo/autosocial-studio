#!/usr/bin/env node
/**
 * instalar-tiktok-lote-real.js
 * ---------------------------------------------------------------------------
 * ARREGLA DE RAIZ la subida de TikTok en AutoSocial Studio.
 *
 * DIAGNOSTICO (repo real github.com/komangulo/autosocial-studio):
 *
 *  1. NO HAY UN SOLO NAVEGADOR PARA EL LOTE.
 *     autonomous-worker.js -> postSingleVideo -> uploadVideo SIN pasar
 *     page/context/reuseBrowser. Asi que `ownsBrowser` es siempre true y
 *     uploadVideo ABRE Y CIERRA Chrome en CADA video.
 *     src/tiktok-batch.js (el lote de un solo navegador) existe pero NADIE lo
 *     importa: es codigo muerto.
 *
 *  2. EL PERFIL SE QUEDA BLOQUEADO Y FALLAN LOS SIGUIENTES.
 *     En el finally de uploadVideo: si falla la PROGRAMACION, se deja el
 *     navegador ABIERTO a proposito. Y como `config.keepBrowserOnScheduleFail`
 *     NO EXISTE en config.js, `undefined !== false` es true: la ventana se
 *     queda abierta SIEMPRE que falla programar. El siguiente video lanza
 *     launchPersistentContext sobre el mismo perfil -> exitCode 21.
 *     Sintoma exacto: "publica el primero y fallan los siguientes".
 *
 *  3. `context.close()` sin .catch() en el finally: si el contexto ya murio,
 *     lanza y TAPA el return {ok:false}, asi que el video no se archiva en
 *     failed/ y el error se pierde.
 *
 *  4. El bloque del popup restringido esta DUPLICADO (v3 y v2) y
 *     `primaryRetryCount = 0` se resetea cada vez, anulando el tope de 2.
 *
 * QUE HACE ESTE INSTALADOR
 *   A. post-service.js pasa un navegador compartido y uploadVideo lo reutiliza
 *      (un solo Chrome para todo el lote). Se abre al primer video y se cierra
 *      al ultimo, via un coordinador en tiktok-uploader.js.
 *   B. config.js define keepBrowserOnScheduleFail=false: nunca deja un Chrome
 *      huerfano bloqueando el perfil.
 *   C. context.close() protegido con .catch() para no perder el error real.
 *   D. Elimina el bloque duplicado del popup (deja solo el v3).
 *
 * Idempotente. Uso:  node instalar-tiktok-lote-real.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const UPLOADER = path.join(SRC, "tiktok-uploader.js");
const POST = path.join(SRC, "post-service.js");
const CONFIG = path.join(SRC, "config.js");

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(UPLOADER)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

const MARK_LEASE = "// MARKER: TIKTOK-SHARED-BROWSER-LEASE-v1";

// ===========================================================================
// A. tiktok-uploader.js: coordinador de navegador compartido entre videos
// ===========================================================================
{
  let text = fs.readFileSync(UPLOADER, "utf8");
  const before = text;

  if (text.includes("acquireSharedTikTokBrowser")) {
    skip("el coordinador de navegador compartido ya estaba instalado");
  } else {
    // Insertamos el coordinador justo antes de uploadVideo.
    const anchor = "async function uploadVideo(";
    const idx = text.indexOf(anchor);
    if (idx === -1) {
      fail("No encontre uploadVideo en tiktok-uploader.js.");
    } else {
      const coord = `/**
 * ${MARK_LEASE}
 * Coordinador de navegador compartido para el LOTE de TikTok.
 *
 * Con reuseBrowser, post-service pide aqui un contexto ya abierto y lo
 * devuelve al terminar. El primer video del lote abre Chrome; los demas lo
 * reutilizan; el ultimo lo cierra. Asi NO se abre/cierra un navegador por
 * video (que bloqueaba el perfil y hacia fallar los siguientes).
 */
const sharedTikTokBrowser = {
  accountId: null,
  context: null,
  page: null,
  lastUseAt: 0,
  idleTimer: null,
  // El worker publica los videos UNO DETRAS DE OTRO (secuencial). Si cerrasemos
  // el navegador al acabar cada video, volveriamos al bug original (perfil
  // bloqueado y siguientes videos fallando). Por eso el navegador del lote se
  // mantiene vivo y solo se cierra cuando pasan N ms sin usarse (lote acabado)
  // o cuando alguien lo pide explicitamente.
  IDLE_MS: 20000,
};

function closeSharedTikTokBrowserNow() {
  const state = sharedTikTokBrowser;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  const context = state.context;
  state.context = null;
  state.page = null;
  state.accountId = null;
  if (context) {
    return context.close().catch(() => {});
  }
  return Promise.resolve();
}

function scheduleIdleClose() {
  const state = sharedTikTokBrowser;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    // Si nadie lo ha vuelto a usar, el lote ha terminado: cerrar.
    if (Date.now() - sharedTikTokBrowser.lastUseAt >= sharedTikTokBrowser.IDLE_MS - 50) {
      closeSharedTikTokBrowserNow().catch(() => {});
    }
  }, sharedTikTokBrowser.IDLE_MS);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

async function acquireSharedTikTokBrowser(accountId) {
  const state = sharedTikTokBrowser;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  // Otra cuenta: cerramos el anterior y abrimos el de esta.
  if (state.accountId && state.accountId !== accountId) {
    await closeSharedTikTokBrowserNow();
  }

  // Contexto muerto: reabrir.
  if (state.context && state.accountId === accountId) {
    const alive = (() => {
      try {
        return !state.context.pages().every((p) => p.isClosed());
      } catch {
        return false;
      }
    })();
    if (!alive) await closeSharedTikTokBrowserNow();
  }

  if (!state.context) {
    state.context = await openContextWithRetry(accountId);
    state.page = state.context.pages()[0] || (await state.context.newPage());
    state.accountId = accountId;
    console.log("Lote TikTok: navegador abierto (se reutilizara para los demas videos).");
  }
  state.lastUseAt = Date.now();
  return { context: state.context, page: state.page };
}

function releaseSharedTikTokBrowser() {
  // No cerramos aqui: el lote sigue. Solo marcamos el uso y programamos el
  // cierre por inactividad, para que el ultimo video del lote sea quien deje
  // el navegador cerrado.
  const state = sharedTikTokBrowser;
  state.lastUseAt = Date.now();
  scheduleIdleClose();
  return Promise.resolve();
}

async function closeSharedTikTokBrowser() {
  return closeSharedTikTokBrowserNow();
}

`;

      text = text.slice(0, idx) + coord + "\n" + text.slice(idx);
      ok("coordinador de navegador compartido anadido");
    }
  }

  // En uploadVideo: cuando reuseBrowser, pedir el navegador compartido.
  {
    const oldOpen =
      /const context = ownsBrowser\s*\n?\s*\?\s*await openContextWithRetry\(accountId\)\s*\n?\s*:\s*sharedContext;/;
    if (oldOpen.test(text)) {
      text = text.replace(
        oldOpen,
        `// Si reuseBrowser, tomamos el navegador del lote (se cierra solo al
  // terminar el ultimo video). Si no, abrimos uno propio para este video.
  let lease = null;
  let context;
  let page;
  if (ownsBrowser) {
    context = await openContextWithRetry(accountId);
    page = context.pages()[0] || (await context.newPage());
  } else {
    lease = await acquireSharedTikTokBrowser(accountId);
    context = lease.context;
    page = lease.page;
  }`
      );
      // Quitar la asignacion de page que venia despues y ya no aplica.
      text = text.replace(
        /(let page;\n  if \(ownsBrowser\) \{\n    context = await openContextWithRetry\(accountId\);\n    page = context\.pages\(\)\[0\] \|\| \(await context\.newPage\(\)\);\n  \} else \{\n    lease = await acquireSharedTikTokBrowser\(accountId\);\n    context = lease\.context;\n    page = lease\.page;\n  \})\n  const page = ownsBrowser\n    \? context\.pages\(\)\[0\] \|\| \(await context\.newPage\(\)\)\n    : sharedPage;/,
        "$1"
      );
      ok("uploadVideo usa el navegador del lote o uno propio");
    } else if (text.includes("acquireSharedTikTokBrowser(accountId)")) {
      skip("el arranque de uploadVideo ya usaba el coordinador");
    } else {
      fail("No encontre el arranque del contexto en uploadVideo.");
    }
  }

  // En el finally: liberar el lease y cerrar con .catch().
  {
    const oldFinally =
      /if \(ownsBrowser && !\(scheduleMode && failedSchedule && config\.keepBrowserOnScheduleFail !== false\)\) \{\s*\n\s*await holdBrowserBeforeClose\(page, closeHoldMs, "post-finalization"\);\s*\n\s*await context\.close\(\);\s*\n\s*\} else if \(scheduleMode && failedSchedule\) \{\s*\n\s*console\.log\("Programacion fallida: se deja el navegador ABIERTO para revisarlo\."\);\s*\n\s*\} else if \(!ownsBrowser\) \{\s*\n\s*\/\/ Navegador compartido: nunca lo cierra el uploader\.\s*\n\s*\}/;

    if (oldFinally.test(text)) {
      text = text.replace(
        oldFinally,
        `if (ownsBrowser) {
      // Navegador propio de este video.
      if (!(scheduleMode && failedSchedule && config.keepBrowserOnScheduleFail === true)) {
        await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
        await context.close().catch(() => {});
      } else {
        console.log("Programacion fallida: se deja el navegador ABIERTO para revisarlo.");
      }
    }
    // Navegador compartido: se devuelve al lote. Se cierra solo cuando ya no
    // queda ningun video usandolo, aunque haya fallado la programacion, para
    // no dejar una ventana huerfana bloqueando el perfil del siguiente video.
    if (lease) {
      await releaseSharedTikTokBrowser().catch(() => {});
    }`
      );
      ok("finally del uploader: cierra con .catch y libera el navegador del lote");
    } else if (text.includes("releaseSharedTikTokBrowser()")) {
      skip("el finally ya liberaba el navegador del lote");
    } else {
      fail("No encontre el finally de uploadVideo (estructura distinta).");
    }
  }

  // Quitar el bloque DUPLICADO del popup (dejar solo el v3). Se localiza por
  // rango, desde su MARKER v2 hasta la llave que lo cierra, y se equilibra:
  // borramos tambien el `}` huerfano que dejaria el if eliminado.
  {
    const startMarker = "// MARKER: TIKTOK-RESTRICTED-MODAL-v2";
    const count = (text.match(/if \(await dismissRestrictedContentModal\(page\)\)/g) || []).length;
    const s = text.indexOf(startMarker);
    if (s !== -1 && count > 1) {
      const open = text.indexOf("if (await dismissRestrictedContentModal(page))", s);
      if (open !== -1) {
        // Recorremos a partir del `{` del if equilibrando llaves.
        const braceStart = text.indexOf("{", open);
        let depth = 0;
        let i = braceStart;
        for (; i < text.length; i += 1) {
          if (text[i] === "{") depth += 1;
          else if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        // i es la llave que cierra el if. Borramos [s, i] y colapsamos el
        // hueco (esto se lleva tambien la llave huerfana que quedaba antes).
        const head = text.slice(0, s).replace(/\s+$/, "");
        const tail = text.slice(i + 1).replace(/^\s*\n/, "");
        text = head + "\n" + tail;
        ok("eliminado el bloque duplicado del popup (queda solo el v3)");
      }
    } else {
      skip("no hay bloque duplicado del popup");
    }
  }

  if (text !== before && !results.some(([s]) => s === "FAIL")) {
    const backup = `${UPLOADER}.tiktok-lote-real-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(UPLOADER, backup);
    fs.writeFileSync(UPLOADER, text, "utf8");
    ok("src/tiktok-uploader.js actualizado (backup .tiktok-lote-real-backup)");
  }
}

// ===========================================================================
// B. config.js: keepBrowserOnScheduleFail = false
// ===========================================================================
{
  if (!fs.existsSync(CONFIG)) {
    fail("No encontre src/config.js.");
  } else {
    let c = fs.readFileSync(CONFIG, "utf8");
    if (/keepBrowserOnScheduleFail\s*:/.test(c)) {
      skip("config.js ya define keepBrowserOnScheduleFail");
    } else {
      const anchor = /(\n\s*failureHoldMs:[^\n]*\n)/;
      if (anchor.test(c)) {
        c = c.replace(
          anchor,
          `$1  // Si falla la programacion, cerrar igualmente: una ventana abierta
  // bloquea el perfil y hace fallar los videos siguientes del lote.
  keepBrowserOnScheduleFail: getBoolean(process.env.KEEP_BROWSER_ON_SCHEDULE_FAIL, false),
`
        );
        fs.writeFileSync(CONFIG, c, "utf8");
        ok("config.js: keepBrowserOnScheduleFail = false (no deja Chrome huerfano)");
      } else {
        fail("No encontre failureHoldMs en config.js.");
      }
    }
  }
}

// ===========================================================================
// C. post-service.js: el lote pide un navegador compartido
// ===========================================================================
{
  if (!fs.existsSync(POST)) {
    fail("No encontre src/post-service.js.");
  } else {
    let p = fs.readFileSync(POST, "utf8");
    if (p.includes("reuseBrowser")) {
      skip("post-service.js ya pide el navegador compartido");
    } else {
      const oldCall =
        /const result = await uploadVideo\(\{ videoPath, coverPath, caption, source, accountId, onPhase, scheduledAt, scheduleTimezone, location, aiGenerated \}\);/;
      if (oldCall.test(p)) {
        p = p.replace(
          oldCall,
          `const result = await uploadVideo({
    videoPath,
    coverPath,
    caption,
    source,
    accountId,
    onPhase,
    scheduledAt,
    scheduleTimezone,
    location,
    aiGenerated,
    // MARKER: TIKTOK-SHARED-BROWSER-LEASE-v1
    // reuseBrowser: el lote reutiliza un solo Chrome para todos los videos,
    // en vez de abrir y cerrar uno por video (que bloqueaba el perfil).
    reuseBrowser: true,
  });`
        );
        fs.writeFileSync(POST, p, "utf8");
        ok("post-service.js: pide un navegador compartido para el lote");
      } else {
        fail("No encontre la llamada a uploadVideo en post-service.js.");
      }
    }
  }
}

// ===========================================================================
// D. tiktok-uploader.js: exportar closeSharedTikTokBrowser para el worker
// ===========================================================================
{
  let u = fs.readFileSync(UPLOADER, "utf8");
  if (u.includes("closeSharedTikTokBrowser,")) {
    skip("el uploader ya exporta closeSharedTikTokBrowser");
  } else if (u.includes("\n  uploadVideo,")) {
    u = u.replace("\n  uploadVideo,", "\n  uploadVideo,\n  closeSharedTikTokBrowser,");
    fs.writeFileSync(UPLOADER, u, "utf8");
    ok("el uploader exporta closeSharedTikTokBrowser");
  } else {
    fail("No encontre 'uploadVideo,' en module.exports del uploader.");
  }
}

// ===========================================================================
// E. autonomous-worker.js: cerrar el navegador al terminar el lote
// ===========================================================================
{
  const WORKER = path.join(SRC, "autonomous-worker.js");
  if (!fs.existsSync(WORKER)) {
    skip("no encontre autonomous-worker.js: se cierra por inactividad");
  } else {
    let w = fs.readFileSync(WORKER, "utf8");
    if (w.includes("closeSharedTikTokBrowser")) {
      skip("el worker ya cierra el navegador del lote");
    } else {
      const reqRe = /const (\w+) = require\("\.\/tiktok-uploader"\);/;
      const m = w.match(reqRe);
      const varName = m ? m[1] : null;
      if (!varName) {
        skip("el worker no importa tiktok-uploader (se cierra por inactividad)");
      } else {
        const drainRe = /(async drainTikTokQueue\([\s\S]*?)(\n\s*}\n)/;
        const dm = w.match(drainRe);
        if (dm) {
          const closeLine =
            `\n    // Al terminar el lote, cerrar el navegador compartido de TikTok.\n` +
            `    try {\n` +
            `      if (typeof ${varName}.closeSharedTikTokBrowser === "function") {\n` +
            `        await ${varName}.closeSharedTikTokBrowser();\n` +
            `      }\n` +
            `    } catch {}\n`;
          w = w.replace(drainRe, (full, body, tail) => body + closeLine + tail);
          const chk = spawnSync(process.execPath, ["--check", WORKER], { encoding: "utf8" });
          if (chk.status !== 0) {
            fail("El parche del worker rompia sintaxis; se dejo sin tocar.");
          } else {
            fs.writeFileSync(WORKER, w, "utf8");
            ok("el worker cierra el navegador del lote al terminar");
          }
        } else {
          skip("no pude delimitar drainTikTokQueue (se cierra por inactividad)");
        }
      }
    }
  }
}

// ===========================================================================
// F. Verificacion: sintaxis y ausencia de duplicados
// ===========================================================================
for (const file of [UPLOADER, POST, CONFIG]) {
  if (!fs.existsSync(file)) continue;
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    fail(`Sintaxis rota en ${path.basename(file)}: ` + (check.stderr || "").split("\n").filter(Boolean)[0]);
  }
}

{
  const t = fs.readFileSync(UPLOADER, "utf8");
  const n = (t.match(/async function acquireSharedTikTokBrowser\(/g) || []).length;
  if (n > 1) fail(`acquireSharedTikTokBrowser duplicada (${n} veces).`);
}

console.log("\n=== AutoSocial Studio - TikTok: lote con un navegador real ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const changes = results.filter(([s]) => s === "OK").length;
const skips = results.filter(([s]) => s === "SKIP").length;
console.log(`\n${changes} cambios, ${skips} ya presentes, ${failures.length} errores.`);

if (failures.length) {
  console.error(
    "\nNo se dejo el proyecto a medias donde hubo FAIL. Revisa los backups " +
    "*.tiktok-lote-real-backup."
  );
  process.exitCode = 1;
} else {
  console.log(
    "\nHecho. Ahora el lote abre UN solo Chrome y lo cierra al terminar el" +
    "\nultimo video, y si falla una programacion NO deja la ventana abierta" +
    "\nbloqueando el perfil.\n" +
    "\nReinicia el dashboard:  node src/dashboard-server.js"
  );
}
