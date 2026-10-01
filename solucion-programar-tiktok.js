#!/usr/bin/env node
/*
 * SOLUCION: "Programar todo en TikTok" usa el perfil seleccionado
 * ---------------------------------------------------------------
 * Arregla el cruce de cuentas SIN volver al repo y SIN romper la web.
 *
 * Es tolerante: mira lo que ya tienes aplicado y solo corrige lo que falta
 * o lo que esta incoherente. Idempotente. Con --revert.
 *
 * Uso:
 *   node solucionar-programar-tiktok.js
 *   node solucionar-programar-tiktok.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "PROGRAMAR-TIKTOK-CUENTA";

function log(m) { console.log(`[${MARK}] ${m}`); }
function full(rel) { return path.resolve(ROOT, rel); }
function read(rel) {
  const f = full(rel);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${rel}. Ejecuta esto desde la carpeta del proyecto.`);
  return fs.readFileSync(f, "utf8");
}
function write(rel, text) {
  const f = full(rel);
  const backup = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, backup);
  fs.writeFileSync(f, text, "utf8");
  log(`escrito ${rel} (backup: ${path.basename(backup)})`);
}

/* ==================================================================
 * 1) dashboard-server.js — garantizar que el router recibe un validador
 *    de cuentas con el nombre que use autoclone (`context.getAccount`).
 * ================================================================== */
function patchServer(text) {
  const re = /createAutoCloneRouter\(express, \{([^}]*)\}\)/;
  const m = text.match(re);
  if (!m) throw new Error("No encuentro createAutoCloneRouter(express, {...}) en src/dashboard-server.js.");

  let inner = m[1];
  // Limpiamos duplicados y normalizamos getAccount -> requireAccount.
  const parts = inner.split(",").map((s) => s.trim()).filter(Boolean);
  const map = new Map();
  for (const p of parts) {
    const [k, v = ""] = p.split(":").map((s) => s.trim());
    if (k === "getAccount" || k === "requireAccount") continue;
    map.set(k, v);
  }
  map.set("getActiveAccount", "getActiveAccount");
  map.set("getAccount", "requireAccount");
  map.set("worker", "autonomousWorker");
  const fixed = `createAutoCloneRouter(express, { ${[...map.entries()].map(([k, v]) => v === k ? k : `${k}: ${v}`).join(", ")} })`;

  if (fixed === m[0]) {
    log("src/dashboard-server.js: ya correcto.");
    return text;
  }
  log("src/dashboard-server.js: router -> getAccount: requireAccount");
  return text.replace(m[0], fixed);
}

/* ==================================================================
 * 2) src/autoclone/index.js — resolver la cuenta del body (accountId)
 *    usando getAccount o requireAccount (el que exista). Si no, activa.
 * ================================================================== */
function patchAutoclone(text) {
  if (!text.includes("resolveTikTokAccount")) {
    const anchor = '  router.post("/schedule", route(async (req, res) => {';
    if (!text.includes(anchor)) throw new Error("No encuentro el router /schedule en src/autoclone/index.js.");
    const helper =
      "  // " + MARK + ": cuenta del body si viene; si no, la activa.\n" +
      "  const resolveTikTokAccount = async (req) => {\n" +
      "    const requested = req?.body?.accountId || req?.query?.accountId;\n" +
      "    const validator = context.getAccount || context.requireAccount;\n" +
      "    if (requested && typeof validator === \"function\") {\n" +
      "      try { return await validator(requested); } catch { /* cae a activa */ }\n" +
      "    }\n" +
      "    return await context.getActiveAccount();\n" +
      "  };\n" +
      "\n" + anchor;
    text = text.replace(anchor, helper);
    log("src/autoclone/index.js: helper resolveTikTokAccount creado.");
  } else {
    // Ya existe. Lo reescribimos ENTERO con una version segura, sin importar
    // como este (asi cubrimos cualquier variante de parche anterior).
    const fnRe = /const resolveTikTokAccount = async \(req\) => \{[\s\S]*?\n  \};/;
    const safeFn =
      "const resolveTikTokAccount = async (req) => {\n" +
      "    const requested = req?.body?.accountId || req?.query?.accountId;\n" +
      "    const validator = context.getAccount || context.requireAccount;\n" +
      "    if (requested && typeof validator === \"function\") {\n" +
      "      try { return await validator(requested); } catch { /* cae a la activa */ }\n" +
      "    }\n" +
      "    return await context.getActiveAccount();\n" +
      "  };";
    if (fnRe.test(text)) {
      text = text.replace(fnRe, safeFn);
      log("src/autoclone/index.js: helper reescrito (seguro).");
    } else {
      log("src/autoclone/index.js: no se pudo localizar el helper; se deja igual.");
    }
  }

  // Red de seguridad: si quedara alguna llamada directa a context.requireAccount
  // (sin guarda), la redirigimos al validador disponible. Cubre ambos casos.
  text = text
    .replace(/if \(requested && context\.requireAccount\) \{ try \{ return await context\.requireAccount\(requested\); \} catch \{ \} \}/g,
      "if (requested && typeof context.requireAccount === \"function\") { try { return await context.requireAccount(requested); } catch {} }")
    .replace(/await context\.requireAccount\(/g, "await (context.getAccount || context.requireAccount)(");

  // Usar resolveTikTokAccount(req) en /schedule y /schedule/start (idempotente).
  text = text.split(
    'const active = await context.getActiveAccount();\n    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");'
  ).join(
    'const active = await resolveTikTokAccount(req);\n    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");'
  );
  text = text.replace(
    'const active = await context.getActiveAccount();\n\n    context.worker.clearCancellation',
    'const active = await resolveTikTokAccount(req);\n\n    context.worker.clearCancellation'
  );
  return text;
}

/* ==================================================================
 * 3) web/autopost.js — enviar la cuenta seleccionada en Programar/Programar todo
 * ================================================================== */
function patchAutopost(text) {
  if (!text.includes("withAccountForTikTok")) {
    const anchor = "  async function refreshAccount() {";
    if (!text.includes(anchor)) throw new Error("No encuentro refreshAccount() en web/autopost.js.");
    const helper =
      "  // " + MARK + ": cuenta activa (la del desplegable). Fuente: el backend.\n" +
      "  let tiktokAccountId = \"\";\n" +
      "  function withAccountForTikTok(payload = {}) {\n" +
      "    return tiktokAccountId ? { ...payload, accountId: tiktokAccountId } : payload;\n" +
      "  }\n" +
      "\n" + anchor;
    text = text.replace(anchor, helper);
    log("web/autopost.js: helper withAccountForTikTok creado.");
  } else {
    log("web/autopost.js: helper ya existe.");
  }

  // Guardar el id en refreshAccount
  if (!text.includes("tiktokAccountId = data.activeAccountId")) {
    text = text.replace(
      '      const data = await API.get("/api/accounts");\n      const account = data?.activeAccount;\n      if (account?.id) {\n        els.accountBadge.textContent = account.name || account.id;',
      '      const data = await API.get("/api/accounts");\n      const account = data?.activeAccount;\n      if (data?.activeAccountId) tiktokAccountId = data.activeAccountId;\n      if (account?.id) {\n        els.accountBadge.textContent = account.name || account.id;'
    );
  }

  // Envolver /schedule (solo si aun no lo esta)
  if (!/autoclone\/schedule\", withAccountForTikTok/.test(text)) {
    text = text.replace(
      'const data = await API.post("/api/autoclone/schedule", {\n        folder,',
      'const data = await API.post("/api/autoclone/schedule", withAccountForTikTok({\n        folder,'
    );
    text = text.replace(
      '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      });\n      renderPlan((data.created || [])',
      '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      }));\n      renderPlan((data.created || [])'
    );
  }

  // Envolver /schedule/start (solo si aun no lo esta)
  if (!/autoclone\/schedule\/start\", withAccountForTikTok/.test(text)) {
    text = text.replace(
      'const data = await API.post("/api/autoclone/schedule/start", {\n        folder,',
      'const data = await API.post("/api/autoclone/schedule/start", withAccountForTikTok({\n        folder,'
    );
    text = text.replace(
      '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      });\n      renderStartProgress(data?.run);',
      '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      }));\n      renderStartProgress(data?.run);'
    );
  }

  // Refrescar al cambiar de cuenta
  if (!text.includes('autosocial:accountchange", () => { refreshAccount()')) {
    text = text.replace(
      '  document.addEventListener("autosocial:viewchange", (event) => {',
      '  document.addEventListener("autosocial:accountchange", () => { refreshAccount(); });\n\n  document.addEventListener("autosocial:viewchange", (event) => {'
    );
  }

  return text;
}

const FILES = [
  { rel: "src/dashboard-server.js", fn: patchServer },
  { rel: "src/autoclone/index.js", fn: patchAutoclone },
  { rel: "web/autopost.js", fn: patchAutopost },
];

function runRevert() {
  let n = 0;
  for (const { rel } of FILES) {
    const dir = path.dirname(full(rel));
    const base = path.basename(rel);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-${MARK}-`)).sort();
    if (!baks.length) { log(`sin backup para ${rel}`); continue; }
    fs.copyFileSync(path.resolve(dir, baks[baks.length - 1]), full(rel));
    log(`revertido ${rel}`);
    n += 1;
  }
  log(n ? `Revertido (${n}).` : "Nada que revertir.");
}

function runApply() {
  for (const { rel, fn } of FILES) {
    const before = read(rel);
    const after = fn(before);
    if (after === before) { log(`${rel}: sin cambios.`); continue; }
    write(rel, after);
  }
  log("Listo. Reinicia el dashboard (npm run dashboard).");
}

if (REVERT) runRevert();
else runApply();
