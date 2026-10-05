/**
 * CALENTADOR-TIKTOK: motor de calentamiento de cuentas de TikTok.
 *
 * Abre el MISMO perfil persistente que usa la app (.profiles/<cuenta>/tiktok),
 * entra al "Para ti" (For You) y hace auto-scroll cada pocos segundos, sin
 * raton y sin extensiones. Cada cuenta corre en su propio proceso Playwright,
 * totalmente aislada de las demas.
 *
 * Por defecto abre una VENTANA VISIBLE (headed) con la cuenta. Se puede pedir
 * headless:true para modo invisible.
 *
 * Solo scroll pasivo (sin likes, sin comentarios, sin abrir perfiles).
 * Arranca con "start", se detiene con "stop", y va guardando su estado.
 *
 * AUTOSUFICIENTE: no depende de que el servidor le inyecte la ruta del perfil.
 * Resuelve .profiles/<cuenta>/tiktok por su cuenta.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_SCROLL_MS = 4000;   // cada cuanto baja de video
const JITTER_MS = 1200;           // +/- aleatorio para no ser perfecto
const BOOT_TIMEOUT_MS = 60000;    // esperar a que cargue el For You

/** Estado en memoria por cuenta (una sola instancia por proceso). */
const sessions = new Map();

function log(msg) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log("[calentador " + stamp + "] " + msg);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Quita los candados huerfanos de Chromium que dejo un cierre brusco.
 * Sin esto, launchPersistentContext falla con "profile in use".
 */
function clearStaleLocks(dir) {
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.rmSync(path.join(dir, lock), { force: true }); } catch {}
  }
}

async function resolveChromium() {
  try {
    return require("playwright").chromium;
  } catch (e) {
    throw new Error(
      "Playwright no esta instalado. Ejecuta: npx playwright install chromium"
    );
  }
}

/**
 * Resuelve la carpeta del perfil persistente de TikTok de una cuenta.
 * Intenta, en orden: account-manager del proyecto, deps inyectadas, y por
 * ultimo la convencion .profiles/<cuenta>/tiktok.
 *
 * OJO: getPlatformProfileDir puede ser SINCRONA o ASINCRONA (en este proyecto
 * es async). Aqui se hace await siempre y se valida que devuelva un string.
 */
async function resolveProfileDir(accountId, deps) {
  const fallback = path.resolve(process.cwd(), ".profiles", accountId, "tiktok");

  async function attempt(fn) {
    try {
      const value = await fn();
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  }

  // 1) Lo mas fiable: el propio account-manager del proyecto.
  for (const modPath of ["../src/account-manager", "./account-manager"]) {
    let am = null;
    try { am = require(modPath); } catch { continue; }
    if (am && typeof am.getPlatformProfileDir === "function") {
      const got = await attempt(() => am.getPlatformProfileDir("tiktok", accountId));
      if (got) return got;
    }
  }

  // 2) Funcion inyectada por el llamador, si la hubiera.
  if (deps && typeof deps.getPlatformProfileDir === "function") {
    const got = await attempt(() => deps.getPlatformProfileDir("tiktok", accountId));
    if (got) return got;
  }

  // 3) Convencion del proyecto.
  return fallback;
}

/**
 * Crea el modulo. Todas las dependencias son OPCIONALES: si no vienen, se
 * resuelven solas desde el proyecto.
 * @param {Object} [deps]
 * @param {(platform:string, accountId:string)=>string} [deps.getPlatformProfileDir]
 * @param {(accountId:string)=>Promise<Object>} [deps.requireAccount]
 */
function createTikTokWarmer(deps = {}) {
  const requireAccount = deps.requireAccount || (async (id) => ({ id, name: id }));

  /** Devuelve el estado publico de una cuenta. */
  function publicState(accountId) {
    const s = sessions.get(accountId);
    if (!s) return { accountId, running: false, startedAt: null, elapsedMs: 0, scrollCount: 0, lastError: "" };
    return {
      accountId,
      running: s.running,
      startedAt: s.startedAt,
      elapsedMs: s.startedAt ? Date.now() - s.startedAt : 0,
      scrollCount: s.scrollCount,
      lastError: s.lastError || "",
    };
  }

  /** Arranca el calentamiento de UNA cuenta. Si ya corre, no hace nada. */
  async function start(accountId, options = {}) {
    const account = await requireAccount(accountId);
    if (sessions.has(accountId) && sessions.get(accountId).running) {
      return { ok: true, alreadyRunning: true, ...publicState(accountId) };
    }

    const scrollMs = Number(options.scrollMs) > 0 ? Number(options.scrollMs) : DEFAULT_SCROLL_MS;
    // Por defecto VISIBLE (headed), como pidio el usuario.
    const headless = options.headless === true;
    const profileDir = await resolveProfileDir(account.id, deps);

    const session = {
      accountId: account.id,
      running: true,
      startedAt: Date.now(),
      scrollCount: 0,
      lastError: "",
      stopRequested: false,
      context: null,
      page: null,
      loopPromise: null,
      wake: null,
    };
    sessions.set(account.id, session);

    // Espera interrumpible e inmune a carreras: si "stop" se pide mientras el
    // bucle esta ocupado (p.ej. evaluando en la pagina), no se duerme de mas.
    const WAKE_POLL_MS = 250;
    function interruptibleSleep(ms) {
      return new Promise((resolve) => {
        if (session.stopRequested) return resolve();
        const deadline = Date.now() + ms;
        let timer = null;
        const check = () => {
          if (session.stopRequested || Date.now() >= deadline) {
            if (timer) clearTimeout(timer);
            session.wake = null;
            return resolve();
          }
          timer = setTimeout(check, Math.min(WAKE_POLL_MS, Math.max(1, deadline - Date.now())));
        };
        check();
        session.wake = () => { if (timer) clearTimeout(timer); session.wake = null; resolve(); };
      });
    }

    session.loopPromise = (async () => {
      const chromium = await resolveChromium();
      clearStaleLocks(profileDir);
      log("iniciando @" + (account.name || account.id) + " -> " + profileDir + (headless ? " (invisible)" : " (ventana)"));

      const context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 900 },
        args: [
          "--disable-blink-features=AutomationControlled",
          "--autoplay-policy=no-user-gesture-required",
          "--mute-audio",
        ],
      });
      session.context = context;

      const page = context.pages()[0] || (await context.newPage());
      session.page = page;
      await page.goto("https://www.tiktok.com/foryou", {
        waitUntil: "domcontentloaded",
        timeout: BOOT_TIMEOUT_MS,
      }).catch(() => {});

      // IMPORTANTE: al abrir Chromium, el foco esta en la barra de direcciones,
      // asi que ArrowDown no llega al feed. Hacemos un CLIC REAL con el raton
      // en la zona del video (no en enlaces ni botones) para dar el foco al
      // reproductor. Sin esto, las teclas no hacen nada.
      async function focusFeed() {
        await page.evaluate(() => {
          const v = document.querySelector("video");
          if (v && typeof v.play === "function") {
            v.muted = true;
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
        }).catch(() => {});
        // Clic en un punto del video libre de controles (centro-izquierda).
        const point = await page.evaluate(() => {
          const v = document.querySelector("video");
          if (v) {
            const r = v.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        }).catch(() => ({ x: 640, y: 450 }));
        try {
          await page.mouse.click(point.x, point.y);
        } catch (e) { /* ignore */ }
        // Refuerzo: foco programatico por si el clic cayo en un control.
        await page.evaluate(() => {
          try { document.body.focus(); } catch (e) { /* ignore */ }
          const item = document.querySelector('[data-e2e="recommend-list-item-container"]')
            || document.querySelector("video") || document.body;
          try { item.focus(); } catch (e) { /* ignore */ }
        }).catch(() => {});
      }

      await focusFeed();

      // El feed de TikTok vive en un contenedor interno con overflow:scroll
      // (clase DivColumnListContainer), NO scrollea en la ventana. Buscamos ese
      // contenedor de forma robusta y leemos/escribimos su scrollTop. Este es
      // el metodo fiable: no depende de que el foco este en la URL o el feed.
      const FEED_SCROLL_JS =
        "(function () {" +
        " function findFeed() {" +
        '  var byClass = document.querySelector("[class*=DivColumnListContainer]");' +
        "  if (byClass && byClass.scrollHeight > byClass.clientHeight + 50) return byClass;" +
        "  var all = document.querySelectorAll('div, main, section');" +
        "  var best = null, bestArea = 0;" +
        "  for (var i = 0; i < all.length; i++) {" +
        "   var d = all[i];" +
        "   if (d.scrollHeight <= d.clientHeight + 50) continue;" +
        "   var st = getComputedStyle(d);" +
        "   if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) continue;" +
        "   var area = d.clientHeight * d.clientWidth;" +
        "   if (area > bestArea) { bestArea = area; best = d; }" +
        "  }" +
        "  return best;" +
        " }" +
        " return findFeed();" +
        "})()";

      const readScrollTop = () => page.evaluate(
        "(() => { const f = " + FEED_SCROLL_JS + "; return f ? Math.round(f.scrollTop) : -1; })()"
      ).catch(() => -1);

      // Baja una pantalla el feed. Devuelve el nuevo scrollTop.
      const scrollFeedDown = (fraction) => page.evaluate(
        "(() => { const f = " + FEED_SCROLL_JS + "; if (!f) return -1;" +
        " f.scrollTop = f.scrollTop + f.clientHeight * " + fraction + ";" +
        " return Math.round(f.scrollTop); })()"
      ).catch(() => -1);

      let lastScroll = await readScrollTop();

      while (!session.stopRequested && session.running) {
        try {
          // 1) Metodo principal: scroll programatico del contenedor del feed.
          await scrollFeedDown(1.0);
          await sleep(900);
          let nowScroll = await readScrollTop();

          // 2) Refuerzo con la tecla ArrowDown (por si el contenedor cambia),
          //    habiendo dado foco al feed con un clic real.
          if (nowScroll === lastScroll) {
      // Cierra los popups/modales de TikTok (bienvenida "Continue", aviso de
      // cookies, login). Mientras hay un modal, el feed no recibe el scroll ni
      // las teclas. Se pulsa "Continue"/"Cerrar"/la X hasta que desaparezcan.
      async function dismissPopups() {
        return page.evaluate(() => {
          let closed = 0;
          const modalSels = [
            '[class*="tux-modal"]', '[role="dialog"]',
            '[class*="DivCloseButton"]', '[class*="ModalContainer"]',
          ];
          const hasModal = modalSels.some(function (s) {
            var el = document.querySelector(s);
            return el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
          });
          if (!hasModal) return 0;

          // 1) Botones de texto conocidos.
          const wanted = ["continue", "seguir", "aceptar", "accept", "got it",
                          "entendido", "cerrar", "close", "later", "más tarde",
                          "maybe later", "ahora no", "not now"];
          const clickable = document.querySelectorAll('[class*="tux-modal"] button, [role="dialog"] button, [class*="tux-modal"] [role="button"], [role="dialog"] [role="button"]');
          for (const b of clickable) {
            if (b.offsetParent === null) continue;
            const t = (b.textContent || "").trim().toLowerCase();
            if (wanted.some(function (w) { return t === w || t.indexOf(w) === 0; })) {
              b.click(); closed++; break;
            }
          }
          if (closed) return closed;

          // 2) Boton de cerrar (X) del modal.
          for (const s of ['[class*="tux-modal"] [class*="close"]',
                           '[class*="tux-modal"] [aria-label*="lose"]',
                           '[role="dialog"] [aria-label*="lose"]',
                           '[class*="DivCloseButton"]']) {
            const x = document.querySelector(s);
            if (x && x.offsetParent !== null) { x.click(); closed++; break; }
          }
          // 3) Escape como ultimo recurso.
          if (!closed) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
          }
          return closed;
        }).catch(() => 0);
      }

      // Reintenta cerrar popups durante un rato (aparecen tras cargar).
      for (let i = 0; i < 6; i++) {
        const closed = await dismissPopups();
        await sleep(700);
        if (i >= 2 && closed === 0) break;
      }

      await focusFeed();
            await page.keyboard.press("ArrowDown").catch(() => {});
            await sleep(700);
            nowScroll = await readScrollTop();
          }

          // 3) Ultimo recurso: un empujon mas grande.
          if (nowScroll === lastScroll) {
            await scrollFeedDown(1.3);
            await sleep(800);
            nowScroll = await readScrollTop();
          }

          // Contamos como "bajada" cuando el feed avanzo de verdad.
          if (nowScroll !== lastScroll && nowScroll >= 0) session.scrollCount += 1;
          lastScroll = nowScroll;

          // Deja el video nuevo reproduciendose.
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v && typeof v.play === "function") { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          }).catch(() => {});
        } catch (e) {
          session.lastError = String((e && e.message) || e);
        }
        // Intervalo humano: base + jitter, siempre positivo.
        await interruptibleSleep(Math.max(500, scrollMs + rand(-JITTER_MS, JITTER_MS)));
      }
    })()
      .catch((e) => {
        session.lastError = String((e && e.message) || e);
        log("error en @" + (account.name || account.id) + ": " + session.lastError);
      })
      .finally(async () => {
        session.running = false;
        try { if (session.context) await session.context.close(); } catch {}
        session.context = null;
        session.page = null;
        log("detenido @" + (account.name || account.id) + " (" + session.scrollCount + " bajadas)");
      });

    return { ok: true, ...publicState(account.id) };
  }

  /** Pide parar el calentamiento de UNA cuenta (cierre limpio e inmediato). */
  function stop(accountId) {
    const s = sessions.get(accountId);
    if (!s || !s.running) return { ok: true, running: false, ...publicState(accountId) };
    s.stopRequested = true;
    if (typeof s.wake === "function") { try { s.wake(); } catch { /* ignore */ } }
    return { ok: true, running: false, stopping: true, ...publicState(accountId) };
  }

  /** Para TODAS las cuentas en calentamiento (util al cerrar el dashboard). */
  function stopAll() {
    const ids = [...sessions.keys()];
    for (const id of ids) {
      const s = sessions.get(id);
      if (!s) continue;
      s.stopRequested = true;
      if (typeof s.wake === "function") { try { s.wake(); } catch { /* ignore */ } }
    }
    return { ok: true, stopped: ids };
  }

  function status(accountId) {
    return publicState(accountId);
  }

  function list() {
    return [...sessions.keys()].map((id) => publicState(id));
  }

  return { start, stop, stopAll, status, list };
}

module.exports = { createTikTokWarmer };
