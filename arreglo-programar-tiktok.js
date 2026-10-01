#!/usr/bin/env node
/*
 * ARREGLO MINIMO: "Programar todo en TikTok" debe usar EL PERFIL SELECCIONADO
 * ---------------------------------------------------------------------------
 * Bug: al pulsar "Programar todo en TikTok" desde el perfil de una cuenta,
 * la app usaba la CUENTA ACTIVA GLOBAL (la del desplegable de la cabecera si
 * se habia sincronizado) en vez de la cuenta del perfil que estabas viendo.
 * Resultado: programaba con el perfil/cola/sesion de OTRA cuenta.
 *
 * Este parche hace que el frontend envie SIEMPRE la cuenta seleccionada en
 * /api/autoclone/schedule y /api/autoclone/schedule/start, y que el servidor
 * la valide y la use.
 *
 * NO toca index.html. NO anade columnas ni botones. NO cambia la UI.
 *
 * Uso:
 *   node arreglo-programar-tiktok.js            (aplica; idempotente)
 *   node arreglo-programar-tiktok.js --revert   (revierte)
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const REVERT = args.has("--revert") || args.has("--undo");
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
  if (fs.existsSync(f)) fs.copyFileSync(f, backup);
  fs.writeFileSync(f, text, "utf8");
  log(`escrito ${rel} (backup: ${path.basename(backup)})`);
}
function mustReplace(src, needle, repl, label) {
  if (!src.includes(needle)) throw new Error(`Anclaje no encontrado: ${label}`);
  return src.replace(needle, repl);
}

/* ------------------------------------------------------------------ *
 * 1) src/autoclone/index.js — resolver la cuenta desde el body (accountId)
 * ------------------------------------------------------------------ */
function patchAutoclone(text) {
  if (text.includes("resolveTikTokAccount")) return text;

  const anchor = '  router.post("/schedule", route(async (req, res) => {';
  const helper =
    "  // " + MARK + ": usa la cuenta del body (accountId) si viene; si no, la activa.\n" +
    "  const resolveTikTokAccount = async (req) => {\n" +
    "    const requested = req?.body?.accountId || req?.query?.accountId;\n" +
    "    if (requested && context.getAccount) {\n" +
    "      try { return await context.getAccount(requested); } catch { /* cae a la activa */ }\n" +
    "    }\n" +
    "    return await context.getActiveAccount();\n" +
    "  };\n" +
    "\n" +
    anchor;
  text = mustReplace(text, anchor, helper, "helper resolveTikTokAccount (autoclone)");

  // /schedule
  text = mustReplace(
    text,
    'const active = await context.getActiveAccount();\n    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");\n    const result = await scheduler.scheduleFolder({',
    'const active = await resolveTikTokAccount(req);\n    if (!active?.id) throw new Error("Elige una cuenta de TikTok en Cuentas.");\n    const result = await scheduler.scheduleFolder({',
    "/schedule usa resolveTikTokAccount"
  );

  // /schedule/start
  text = mustReplace(
    text,
    '    if (startRun?.running) throw new Error("Ya hay una programacion en marcha. Espera a que termine.");\n    const active = await context.getActiveAccount();',
    '    if (startRun?.running) throw new Error("Ya hay una programacion en marcha. Espera a que termine.");\n    const active = await resolveTikTokAccount(req);',
    "/schedule/start usa resolveTikTokAccount"
  );

  return text;
}

/* ------------------------------------------------------------------ *
 * 2) web/autopost.js — enviar la cuenta seleccionada
 *    La cuenta seleccionada la conocemos por /api/accounts (activeAccountId),
 *    que es lo que el desplegable de la cabecera mantiene sincronizado.
 * ------------------------------------------------------------------ */
function patchAutopost(text) {
  if (text.includes("withAccountForTikTok")) return text;

  // Helper: leer la cuenta activa (fuente unica: el backend, que es lo que ve
  // el desplegable). Se refresca con refreshAccount().
  const anchor = "  async function refreshAccount() {";
  const helper =
    "  // " + MARK + ": cuenta activa (la del desplegable). Fuente: el backend.\n" +
    "  let tiktokAccountId = \"\";\n" +
    "  function withAccountForTikTok(payload = {}) {\n" +
    "    return tiktokAccountId ? { ...payload, accountId: tiktokAccountId } : payload;\n" +
    "  }\n" +
    "\n" +
    anchor;
  text = mustReplace(text, anchor, helper, "helper withAccountForTikTok");

  // Guardar el id en refreshAccount.
  text = mustReplace(
    text,
    '      const data = await API.get("/api/accounts");\n' +
    '      const account = data?.activeAccount;\n' +
    '      if (account?.id) {\n' +
    '        els.accountBadge.textContent = account.name || account.id;',
    '      const data = await API.get("/api/accounts");\n' +
    '      const account = data?.activeAccount;\n' +
    '      if (data?.activeAccountId) tiktokAccountId = data.activeAccountId;\n' +
    '      if (account?.id) {\n' +
    '        els.accountBadge.textContent = account.name || account.id;',
    "guardar id en refreshAccount"
  );

  // /schedule
  text = mustReplace(
    text,
    '      const data = await API.post("/api/autoclone/schedule", {\n        folder,',
    '      const data = await API.post("/api/autoclone/schedule", withAccountForTikTok({\n        folder,',
    "/schedule envia cuenta"
  );
  text = mustReplace(
    text,
    '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      });\n      renderPlan((data.created || [])',
    '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      }));\n      renderPlan((data.created || [])',
    "cerrar /schedule"
  );

  // /schedule/start
  text = mustReplace(
    text,
    '      const data = await API.post("/api/autoclone/schedule/start", {\n        folder,',
    '      const data = await API.post("/api/autoclone/schedule/start", withAccountForTikTok({\n        folder,',
    "/schedule/start envia cuenta"
  );
  text = mustReplace(
    text,
    '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      });\n      renderStartProgress(data?.run);',
    '        location: selectedLocation(),\n        aiGenerated: isAiGenerated(),\n      }));\n      renderStartProgress(data?.run);',
    "cerrar /schedule/start"
  );

  // Al cambiar de cuenta, refrescar el id.
  text = mustReplace(
    text,
    '  document.addEventListener("autosocial:viewchange", (event) => {',
    '  document.addEventListener("autosocial:accountchange", () => { refreshAccount(); });\n' +
    '\n' +
    '  document.addEventListener("autosocial:viewchange", (event) => {',
    "refrescar al cambiar de cuenta"
  );

  return text;
}

/* ------------------------------------------------------------------ *
 * 3) src/autoclone/index.js — exponer getAccount en el contexto del router
 *    (dashboard-server ya importa requireAccount; lo pasamos).
 * ------------------------------------------------------------------ */
function patchServer(text) {
  if (text.includes("getAccount: requireAccount")) return text;
  const anchor = "createAutoCloneRouter(express, { getActiveAccount, worker: autonomousWorker })";
  return mustReplace(
    text,
    anchor,
    "createAutoCloneRouter(express, { getActiveAccount, getAccount: requireAccount, worker: autonomousWorker })",
    "pasar getAccount al router autoclone"
  );
}

const FILES = [
  { rel: "src/autoclone/index.js", fn: patchAutoclone },
  { rel: "src/dashboard-server.js", fn: patchServer },
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
    if (after === before) { log(`${rel}: ya estaba aplicado.`); continue; }
    write(rel, after);
  }
  log("Listo. Reinicia el dashboard (npm run dashboard).");
}

if (REVERT) runRevert();
else runApply();
