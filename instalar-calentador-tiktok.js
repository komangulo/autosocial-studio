#!/usr/bin/env node
/*
 * CALENTADOR TIKTOK (AutoSocial Studio)
 * ==================================================================
 * Anade, EN LA BARRA de TikTok / Auto Post y justo al lado del boton
 * "Iniciar sesion en TikTok", estos dos botones y un indicador:
 *     (Calentamiento parado)  [ Calentar cuenta ]  [ Parar calentamiento ]
 *
 * Al pulsar "Calentar cuenta" sobre LA CUENTA SELECCIONADA, abre su perfil
 * de TikTok (.profiles/<cuenta>/tiktok) en una VENTANA VISIBLE de Chromium,
 * entra a "Para ti" y baja de video automaticamente cada 4 s (con un pelin
 * de aleatorio para que no parezca un robot). Sigue hasta que pulses
 * "Parar calentamiento".
 *
 * - Solo scroll pasivo: sin likes, sin comentarios, sin abrir perfiles.
 * - Cada cuenta es independiente: su perfil, su proceso, su estado.
 * - No usa extensiones ni mueve tu raton.
 *
 * Uso:
 *   node instalar-calentador-tiktok.js            (aplica; idempotente)
 *   node instalar-calentador-tiktok.js --revert   (revierte)
 *
 * Crea copias de seguridad *.bak-WARMER-TIKTOK-<fecha> de cada archivo.
 * Ejecutalo desde la carpeta del proyecto (donde esta package.json).
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const REVERT = args.has("--revert") || args.has("--undo");
const MARK = "WARMER-TIKTOK";

function log(msg) { console.log(`[${MARK}] ${msg}`); }

function read(rel) {
  const full = path.resolve(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`No encuentro ${rel}. Ejecuta esto desde la carpeta del proyecto.`);
  return fs.readFileSync(full, "utf8");
}

function write(rel, text) {
  const full = path.resolve(ROOT, rel);
  const backup = `${full}.bak-${MARK}-${Date.now()}`;
  if (fs.existsSync(full)) fs.copyFileSync(full, backup);
  fs.writeFileSync(full, text, "utf8");
  log(`escrito ${rel} (backup: ${path.basename(backup)})`);
}

function mustReplace(src, needle, replacement, label) {
  if (!src.includes(needle)) {
    throw new Error(
      `No encontrado el punto de anclaje: ${label}. Puede que el proyecto haya cambiado; ` +
      `avisa a tu asistente con esta linea.`
    );
  }
  return src.replace(needle, replacement);
}

/* ==================================================================
 * MODULO NUEVO: src/tiktok-warmer.js
 * Se escribe tal cual desde este archivo (autocontenido).
 * ================================================================== */

function warmerModuleSource() {
  return String.raw`/**
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
`;
}

/* ------------------------------------------------------------------ *
 * P A R C H E   1 : dashboard-server.js
 * Crea el warmer y expone start / stop / status.
 * ------------------------------------------------------------------ */

function patchServer(text) {
  // 1a) import del modulo, idempotente.
  if (!text.includes('require("./tiktok-warmer")')) {
    const firstRequire = 'const express = require("express");';
    if (text.includes(firstRequire)) {
      text = mustReplace(
        text,
        firstRequire,
        'const express = require("express");\n' +
          'const { createTikTokWarmer } = require("./tiktok-warmer"); // ' + MARK,
        "import libs"
      );
    } else {
      text = "const { createTikTokWarmer } = require(\"./tiktok-warmer\"); // " + MARK + "\n" + text;
    }
  }

  // 1b) instanciar el warmer. El calentador se autoabastece y no depende de
  //     imports concretos del server. Si ya habia una version anterior (que si
  //     dependia de getPlatformProfileDir), se REEMPLAZA por esta.
  const instance =
    "\n\n// " + MARK + ": motor de calentamiento (abre el perfil de TikTok y baja videos).\n" +
    "const tiktokWarmer = createTikTokWarmer_instance();\n" +
    "function createTikTokWarmer_instance() {\n" +
    "  try {\n" +
    "    // El calentador se autoabastece: solo le pasamos lo que EXISTA aqui,\n" +
    "    // asi no depende de nombres internos que puedan variar en el proyecto.\n" +
    "    const deps = {};\n" +
    "    if (typeof getPlatformProfileDir === \"function\") deps.getPlatformProfileDir = getPlatformProfileDir;\n" +
    "    if (typeof requireAccount === \"function\") deps.requireAccount = requireAccount;\n" +
    "    return createTikTokWarmer(deps);\n" +
    "  } catch (error) {\n" +
    "    console.error(\"[WARMER-TIKTOK] no se pudo crear el calentador:\", error.message);\n" +
    "    return { start: async () => ({ ok: false, error: error.message }), stop: async () => ({ ok: false }), status: () => ({ running: false }), list: () => [], stopAll: () => ({ ok: true }) };\n" +
    "  }\n" +
    "}";

  // Reemplazar un bloque anterior COMPLETO. Se considera bloque todo lo que va
  // desde el comentario MARK (o, si no esta, desde la linea 'const tiktokWarmer'
  // o el propio 'function createTikTokWarmer_instance') hasta el cierre de esa
  // funcion. Asi una version vieja con dependencias (getPlatformProfileDir)
  // queda sustituida por la nueva autosuficiente, sin dejar restos duplicados.
  const blockRe = new RegExp(
    "(?:\\n\\/\\/ " + MARK.replace(/[-]/g, "\\-") + ": motor de calentamiento[\\s\\S]*?)?" +
    "(?:\\nconst tiktokWarmer = createTikTokWarmer_instance\\(\\);)?" +
    "\\nfunction createTikTokWarmer_instance\\(\\) \\{[\\s\\S]*?\\n\\}",
    "m"
  );
  if (blockRe.test(text)) {
    text = text.replace(blockRe, instance.trimStart());
  } else {
    // Insertar SIEMPRE justo despues de la linea del import del warmer, para
    // garantizar que 'createTikTokWarmer' ya esta definido. Es el ancla que
    // usamos nosotros mismos en 1a, asi que existe con seguridad.
    const warmerImportRe = /^[ \t]*const \{ createTikTokWarmer \} = require\("\.\/tiktok-warmer"\);[^\n]*$/m;
    const m = text.match(warmerImportRe);
    if (m) {
      const insertAt = m.index + m[0].length;
      text = text.slice(0, insertAt) + instance + text.slice(insertAt);
    } else {
      // Ultimo recurso: al principio del archivo (con su propio import).
      text = 'const { createTikTokWarmer } = require("./tiktok-warmer"); // ' + MARK +
        instance.trimStart() + "\n" + text;
    }
  }

  // 1c) endpoints, justo antes del bloque de login de TikTok. Idempotente:
  //     solo se insertan si no estan ya.
  const anchorRe = /^([ \t]*)\/\/ Login endpoints \(TikTok\)/m;
  if (!anchorRe.test(text)) {
    throw new Error(
      "No encontrado el punto de anclaje: bloque '// Login endpoints (TikTok)'. " +
      "Avisa a tu asistente con esta linea."
    );
  }
  const anchorMatch = text.match(anchorRe);
  const indent = anchorMatch ? anchorMatch[1] : "  ";
  const anchor = anchorMatch[0];
  const endpointsAlready = text.includes('"/api/tiktok/warm/start"');
  const bodyLines = [
    `// ${MARK}: resuelve la cuenta a calentar sin depender de imports concretos.`,
    `const resolveWarmAccount = async (id) => {`,
    `  if (id && typeof requireAccount === "function") return await requireAccount(id);`,
    `  if (id) return { id, name: id };`,
    `  if (typeof getActiveAccount === "function") return await getActiveAccount();`,
    `  throw new Error("Elige una cuenta de TikTok en el desplegable.");`,
    `};`,
    ``,
    `// ${MARK}: arranca el auto-scroll (calentamiento) de UNA cuenta.`,
    `app.post("/api/tiktok/warm/start", async (req, res) => {`,
    `  try {`,
    `    const account = await resolveWarmAccount(req.body?.accountId || req.query?.accountId);`,
    `    const result = await tiktokWarmer.start(account.id, {`,
    `      scrollMs: Number(req.body?.scrollMs) || undefined,`,
    `      headless: req.body?.headless === true,`,
    `    });`,
    `    res.json(result);`,
    `  } catch (error) {`,
    `    res.status(400).json({ ok: false, error: error.message });`,
    `  }`,
    `});`,
    ``,
    `// ${MARK}: para el auto-scroll de UNA cuenta.`,
    `app.post("/api/tiktok/warm/stop", async (req, res) => {`,
    `  try {`,
    `    const accountId = req.body?.accountId || req.query?.accountId;`,
    `    res.json(tiktokWarmer.stop(accountId));`,
    `  } catch (error) {`,
    `    res.status(400).json({ ok: false, error: error.message });`,
    `  }`,
    `});`,
    ``,
    `// ${MARK}: estado del auto-scroll (cuenta concreta o todas).`,
    `app.get("/api/tiktok/warm/status", async (req, res) => {`,
    `  try {`,
    `    const accountId = req.query?.accountId || req.body?.accountId;`,
    `    res.json(accountId ? tiktokWarmer.status(accountId) : { running: tiktokWarmer.list() });`,
    `  } catch (error) {`,
    `    res.status(400).json({ ok: false, error: error.message });`,
    `  }`,
    `});`,
    ``,
  ];
  if (!endpointsAlready) {
    const endpoints = bodyLines.map((l) => (l ? indent + l : "")).join("\n") + anchor;
    text = mustReplace(text, anchor, endpoints, "endpoints warm");
  }

  // 1d) parar todo al cerrar el servidor (para no dejar Chromium huerfano).
  const closeAnchor = "  server.listen(";
  if (text.includes(closeAnchor) && !text.includes("tiktokWarmer.stopAll()")) {
    text = text.replace(
      closeAnchor,
      "  const shutdownWarmer = () => { try { tiktokWarmer.stopAll(); } catch { /* ignore */ } };\n" +
      "  process.once(\"SIGINT\", shutdownWarmer);\n" +
      "  process.once(\"SIGTERM\", shutdownWarmer);\n\n" +
      closeAnchor
    );
  }

  return text;
}

/* ------------------------------------------------------------------ *
 * P A R C H E   2 : web/autopost.js
 * Anade los botones y su logica. Se engancha al final del modulo para
 * no depender de la estructura interna.
 * ------------------------------------------------------------------ */

function patchAutopost(text) {
  // 1) Si hay una version ANTIGUA del bloque flotante, quitarla: seria un
  //    IIFE aparte al final del archivo con warmerToolbar. Evita duplicados.
  if (text.includes("warmerToolbar") || text.includes("initTikTokWarmer")) {
    text = text.replace(
      /\n*\/\* ={10,}[\s\S]*?WARMER-TIKTOK[\s\S]*?\n\}\)\(\);\s*$/,
      "\n"
    );
    // Por si quedara un IIFE suelto sin el comentario de cabecera.
    text = text.replace(/\n\(function initTikTokWarmer\(\) \{[\s\S]*?\n\}\)\(\);\s*$/m, "\n");
  }

  // 2) Idempotente: si ya esta la version nueva, no repetir.
  if (text.includes("calentadorMontarBotones") || text.includes("ttWarmStartBtn")) return text;

  // Anclaje: el cierre del IIFE initAutoPost ("})();"). Insertamos nuestro
  // codigo DENTRO del IIFE, justo antes de cerrarlo, para usar $, els,
  // withAccount, setMessage y API que ya existen alli.
  const closeRe = /\n\}\)\(\);\s*$/;
  if (!closeRe.test(text)) {
    throw new Error(
      "No encuentro el cierre del modulo de Auto Post (')();' al final de web/autopost.js). " +
      "Avisa a tu asistente con esta linea."
    );
  }

  const injected = `
  // ==================================================================
  // CALENTADOR-TIKTOK: boton "Calentar cuenta" / "Parar calentamiento"
  // Integrado en la barra de TikTok, junto a los demas botones.
  // Al pulsar, abre la ventana de Chromium con el perfil de la cuenta
  // seleccionada, entra a "Para ti" y baja videos cada 4 s.
  // ==================================================================
  let calentadorPollTimer = null;

  // Llamada robusta: usa API.post si existe; si no, fetch directo.
  async function calentadorPost(action, payload) {
    try {
      if (API && typeof API.post === "function") {
        return await API.post("/api/tiktok/warm/" + action, payload || {});
      }
    } catch (e) { /* cae a fetch */ }
    const res = await fetch("/api/tiktok/warm/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }

  async function calentadorGet(action) {
    try {
      if (API && typeof API.get === "function") {
        return await API.get("/api/tiktok/warm/" + action);
      }
    } catch (e) { /* cae a fetch */ }
    const res = await fetch("/api/tiktok/warm/" + action);
    return res.json();
  }

  function calentadorSetEstado(estado, on) {
    const badge = $("ttWarmStateBadge");
    if (badge) {
      badge.textContent = estado;
      badge.className = "status-badge " + (on ? "active" : "warn");
    }
  }

  function calentadorRender(st) {
    const startBtn = $("ttWarmStartBtn");
    const stopBtn = $("ttWarmStopBtn");
    if (!startBtn || !stopBtn) return;
    if (st && st.running) {
      const segs = Math.round((st.elapsedMs || 0) / 1000);
      const mm = String(Math.floor(segs / 60)).padStart(2, "0");
      const ss = String(segs % 60).padStart(2, "0");
      calentadorSetEstado("Calentando · " + (st.scrollCount || 0) + " vídeos · " + mm + ":" + ss, true);
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      calentadorSetEstado(st && st.lastError ? ("Parado (" + st.lastError + ")") : "Calentamiento parado", false);
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  async function calentadorRefresh() {
    const id = currentAccountId();
    if (!id) { calentadorRender(null); return; }
    try {
      const st = await calentadorGet("status?accountId=" + encodeURIComponent(id));
      calentadorRender(st);
    } catch { /* ignore */ }
  }

  async function calentadorStart() {
    const id = currentAccountId();
    if (!id) { setMessage("Elige una cuenta en el desplegable antes de calentar.", "error"); return; }
    const btn = $("ttWarmStartBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Abriendo…"; }
    setMessage("Abriendo Chromium con la cuenta seleccionada y entrando a “Para ti”…");
    try {
      const r = await calentadorPost("start", withAccount({}));
      if (r && r.ok === false) throw new Error(r.error || "No se pudo iniciar.");
      setMessage("Calentamiento iniciado. La ventana de Chromium bajará vídeos cada 4 s. Pulsa «Parar calentamiento» para detenerlo.", "ok");
    } catch (error) {
      setMessage("No se pudo iniciar el calentamiento: " + error.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Calentar cuenta"; }
      calentadorRefresh();
    }
  }

  async function calentadorStop() {
    const id = currentAccountId();
    const btn = $("ttWarmStopBtn");
    if (btn) btn.disabled = true;
    try {
      await calentadorPost("stop", withAccount({}));
      setMessage("Calentamiento parado.", "ok");
    } catch (error) {
      setMessage("No se pudo parar: " + error.message, "error");
    } finally {
      calentadorRefresh();
    }
  }

  // Crea los botones una sola vez y los coloca JUNTO al boton de login,
  // dentro de la misma barra de botones de TikTok.
  function calentadorMontarBotones() {
    if ($("ttWarmStartBtn")) return;
    const ref = els.loginBtn;
    if (!ref || !ref.parentNode) return;

    const wrap = document.createElement("span");
    wrap.id = "ttWarmActions";
    wrap.style.display = "inline-flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    wrap.style.marginLeft = "8px";

    const badge = document.createElement("span");
    badge.id = "ttWarmStateBadge";
    badge.className = "status-badge warn";
    badge.textContent = "Calentamiento parado";

    const start = document.createElement("button");
    start.id = "ttWarmStartBtn";
    start.type = "button";
    start.className = ref.className || "btn";
    start.textContent = "Calentar cuenta";
    start.title = "Abre Chromium con esta cuenta, entra a Para ti y baja vídeos cada 4 s";

    const stop = document.createElement("button");
    stop.id = "ttWarmStopBtn";
    stop.type = "button";
    stop.className = ref.className || "btn";
    stop.textContent = "Parar calentamiento";
    stop.disabled = true;

    start.addEventListener("click", calentadorStart);
    stop.addEventListener("click", calentadorStop);

    wrap.appendChild(badge);
    wrap.appendChild(start);
    wrap.appendChild(stop);
    ref.parentNode.insertBefore(wrap, ref.nextSibling);

    calentadorRefresh();
  }

  // Monta los botones al arrancar y los vigila por si la barra se re-renderiza.
  function calentadorTick() {
    try { calentadorMontarBotones(); } catch (e) { /* ignore */ }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(calentadorTick, 200));
  } else {
    setTimeout(calentadorTick, 200);
  }
  if (calentadorPollTimer) clearInterval(calentadorPollTimer);
  calentadorPollTimer = setInterval(() => {
    calentadorTick();
    if ($("ttWarmStartBtn")) calentadorRefresh();
  }, 4000);
`;
  return text.replace(closeRe, injected + "\n})();\n");
}

/* ==================================================================
 * Instalacion
 * ================================================================== */

const FILES = [
  { rel: "web/autopost.js", fn: patchAutopost },
  { rel: "src/dashboard-server.js", fn: patchServer },
];

function install() {
  log(`Proyecto: ${ROOT}`);

  // 1) Copiar el modulo motor.
  const modulePath = path.resolve(ROOT, "src/tiktok-warmer.js");
  if (fs.existsSync(modulePath)) {
    log("src/tiktok-warmer.js ya existe; lo actualizo con copia previa.");
    fs.copyFileSync(modulePath, `${modulePath}.bak-${MARK}-${Date.now()}`);
  }
  fs.writeFileSync(modulePath, warmerModuleSource(), "utf8");
  log("escrito src/tiktok-warmer.js");

  // 2) Parchear archivos.
  for (const { rel, fn } of FILES) {
    const before = read(rel);
    const after = fn(before);
    if (after === before) { log(`${rel}: ya estaba aplicado.`); continue; }
    write(rel, after);
  }

  log("");
  log("LISTO. Ahora:");
  log("  1) Cierra el dashboard si estaba abierto y arrancalo: npm run dashboard");
  log("  2) Recarga el navegador con Ctrl+Shift+R.");
  log("  3) Ve a TikTok / Auto Post.");
  log("     Junto a 'Iniciar sesion en TikTok' veras:");
  log("       [ Calentar cuenta ]   [ Parar calentamiento ]");
  log("     Elige la cuenta en el desplegable y pulsa 'Calentar cuenta'.");
  log("     Para cuando quieras con 'Parar calentamiento'.");
  log("");
  log("Revisa que tengas Playwright: npm ls playwright  (si falta: npx playwright install chromium)");
}

function revert() {
  log(`Revirtiendo en ${ROOT}`);

  // Borrar el modulo motor y sus backups mas recientes.
  const modulePath = path.resolve(ROOT, "src/tiktok-warmer.js");
  if (fs.existsSync(modulePath)) { fs.rmSync(modulePath, { force: true }); log("eliminado src/tiktok-warmer.js"); }

  for (const { rel } of FILES) {
    const full = path.resolve(ROOT, rel);
    const dir = path.dirname(full);
    const base = path.basename(full);
    const backups = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-${MARK}-`)).sort()
      : [];
    if (!backups.length) { log(`${rel}: no hay copia de seguridad; no toco nada.`); continue; }
    const latest = path.join(dir, backups[backups.length - 1]);
    fs.copyFileSync(latest, full);
    log(`restaurado ${rel} desde ${path.basename(latest)}`);
  }

  log("");
  log("REVERTIDO. Reinicia el dashboard para aplicar los cambios.");
}

try {
  if (REVERT) revert(); else install();
} catch (e) {
  console.error(`[${MARK}] ERROR: ${e.message}`);
  process.exitCode = 1;
}
