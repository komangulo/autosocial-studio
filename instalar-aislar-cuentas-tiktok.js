#!/usr/bin/env node
/*
 * Aislar cuentas de TikTok (AutoSocial Studio)
 * ------------------------------------------------------------
 * Problema: al pulsar "Programar todo" en la pestana de TikTok, el sistema
 * usaba la cuenta ACTIVA GLOBAL (la del desplegable de la cabecera) en lugar
 * de la cuenta del perfil que estabas viendo. Asi se mezclaban las cuentas:
 * programabas en "Quinta de Gym" y se abria/publicaba la sesion de otra cuenta.
 *
 * Este parche hace que TikTok (login, estado de sesion, programar, "Programar
 * todo", previsualizar) use SIEMPRE la cuenta seleccionada, enviandola de forma
 * explicita desde el frontend y validandola en el servidor. Cada cuenta sigue
 * teniendo su propio perfil en .profiles/<cuenta>/tiktok, su propia cola y su
 * propia sesion: nada se comparte.
 *
 * Uso:
 *   node instalar-aislar-cuentas-tiktok.js            (aplica; idempotente)
 *   node instalar-aislar-cuentas-tiktok.js --revert   (revierte)
 *
 * Es seguro ejecutarlo varias veces: detecta si ya esta aplicado y no duplica.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const REVERT = args.has("--revert") || args.has("--undo");

const MARK = "AISLAR-CUENTAS-TIKTOK";

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
    throw new Error(`No encontrado el punto de anclaje: ${label}. Puede que el proyecto haya cambiado; avisa a tu asistente.`);
  }
  return src.replace(needle, replacement);
}

/* ------------------------------------------------------------------ *
 * P A R C H E   1 : tiktok-uploader.js
 * getLoginSessionStatus acepta accountId y devuelve el estado de ESA
 * cuenta (no de la activa global). startLoginSession tambien.
 * ------------------------------------------------------------------ */

function patchUploader(text) {
  const anchor =
    "async function getLoginSessionStatus() {\n" +
    "  const activeAccount = await getActiveAccount();\n" +
    "  const saved = await hasSavedPlatformSession(\"tiktok\", activeAccount.id);\n" +
    "  return {\n" +
    "    open: Boolean(loginSessionContext) && loginSessionAccountId === activeAccount.id,\n" +
    "    saved,\n" +
    "    launching: loginLaunchState.launching,\n" +
    "    error: loginLaunchState.error,\n" +
    "  };\n" +
    "}";

  const replacement =
    "async function getLoginSessionStatus(accountId) {\n" +
    "  // " + MARK + ": el estado de sesion es el de LA CUENTA indicada, no el global.\n" +
    "  const target = accountId ? await requireAccount(accountId) : await getActiveAccount();\n" +
    "  const saved = await hasSavedPlatformSession(\"tiktok\", target.id);\n" +
    "  return {\n" +
    "    open: Boolean(loginSessionContext) && loginSessionAccountId === target.id,\n" +
    "    saved,\n" +
    "    accountId: target.id,\n" +
    "    launching: loginLaunchState.launching,\n" +
    "    error: loginLaunchState.error,\n" +
    "  };\n" +
    "}";

  if (text.includes("// " + MARK + ": el estado de sesion")) return text;
  let out = mustReplace(text, anchor, replacement, "getLoginSessionStatus");

  // startDashboardLoginSessionDetached: aceptar accountId explicito.
  const anchor2 =
    "function startDashboardLoginSessionDetached() {\n" +
    "  loginLaunchState = { launching: true, error: \"\" };\n" +
    "  void (async () => {\n" +
    "    try {\n" +
    "      const activeAccount = await getActiveAccount();\n" +
    "      const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);";

  const replacement2 =
    "function startDashboardLoginSessionDetached(accountId) {\n" +
    "  // " + MARK + ": la ventana de login se abre en el perfil de LA CUENTA indicada.\n" +
    "  loginLaunchState = { launching: true, error: \"\" };\n" +
    "  void (async () => {\n" +
    "    try {\n" +
    "      const activeAccount = accountId ? await requireAccount(accountId) : await getActiveAccount();\n" +
    "      const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);";

  out = mustReplace(out, anchor2, replacement2, "startDashboardLoginSessionDetached");

  // startLoginSession (CLI): aceptar accountId opcional.
  const anchor3 =
    "async function startLoginSession() {\n" +
    "  const activeAccount = await getActiveAccount();\n" +
    "  const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);";

  const replacement3 =
    "async function startLoginSession(accountId) {\n" +
    "  const activeAccount = accountId ? await requireAccount(accountId) : await getActiveAccount();\n" +
    "  const { context, alreadyOpen } = await openLoginContextForAccount(activeAccount.id);";

  out = mustReplace(out, anchor3, replacement3, "startLoginSession");
  return out;
}

/* ------------------------------------------------------------------ *
 * P A R C H E   2 : dashboard-server.js
 * Los endpoints /api/tiktok/login(/status|/close) aceptan ?accountId / body.
 * ------------------------------------------------------------------ */

function patchServer(text) {
  // 0) Pasar requireAccount al router de autoclone (lo necesita resolveTikTokAccount).
  text = text.replace(
    "createAutoCloneRouter(express, { getActiveAccount, worker: autonomousWorker })",
    "createAutoCloneRouter(express, { getActiveAccount, requireAccount, worker: autonomousWorker })"
  );

  const anchor =
    "  app.post(\"/api/tiktok/login\", async (req, res) => {\n" +
    "    try {\n" +
    "      const result = await startTikTokLoginSession();\n" +
    "      res.json(result);\n" +
    "    } catch (error) {\n" +
    "      res.status(400).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });\n" +
    "\n" +
    "  app.get(\"/api/tiktok/login/status\", async (req, res) => {\n" +
    "    res.json(await getTikTokLoginSessionStatus());\n" +
    "  });";

  const replacement =
    "  // " + MARK + ": estos endpoints respetan la cuenta seleccionada (?accountId / body)   \n" +
    "  app.post(\"/api/tiktok/login\", async (req, res) => {\n" +
    "    try {\n" +
    "      const accountId = req.body?.accountId || req.query?.accountId || undefined;\n" +
    "      const result = await startTikTokLoginSession(accountId);\n" +
    "      res.json(result);\n" +
    "    } catch (error) {\n" +
    "      res.status(400).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });\n" +
    "\n" +
    "  app.get(\"/api/tiktok/login/status\", async (req, res) => {\n" +
    "    try {\n" +
    "      const accountId = req.query?.accountId || undefined;\n" +
    "      res.json(await getTikTokLoginSessionStatus(accountId));\n" +
    "    } catch (error) {\n" +
    "      res.status(400).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });";

  if (text.includes("// " + MARK + ": estos endpoints respetan")) return text;
  return mustReplace(text, anchor, replacement, "endpoints /api/tiktok/login");
}

/* ------------------------------------------------------------------ *
 * P A R C H E   3 : autoclone/index.js
 * schedule / schedule/start resuelven la cuenta desde el body (accountId)
 * y la validan. Si no viene, se mantiene el comportamiento anterior.
 * ------------------------------------------------------------------ */

function patchAutoclone(text) {
  if (!text.includes("resolveTikTokAccount")) {
    // Insertar helper justo antes de router.post("/schedule"
    const anchor =
      "  router.post(\"/schedule\", route(async (req, res) => {";
    const helper =
      "  // " + MARK + ": resuelve la cuenta a usar. Si el frontend manda accountId,\n" +
      "  // se valida y se usa esa; si no, se cae a la cuenta activa (compatibilidad).\n" +
      "  const resolveTikTokAccount = async (req) => {\n" +
      "    const requested = req?.body?.accountId || req?.query?.accountId;\n" +
      "    if (requested && typeof context.requireAccount === \"function\") {\n" +
      "      return await context.requireAccount(requested);\n" +
      "    }\n" +
      "    return await context.getActiveAccount();\n" +
      "  };\n" +
      "\n" +
      anchor;
    text = mustReplace(text, anchor, helper, "helper resolveTikTokAccount");
  }

  text = text.replace(
    "const active = await context.getActiveAccount();\n    if (!active?.id) throw new Error(\"Elige una cuenta de TikTok en Cuentas.\");\n    const result = await scheduler.scheduleFolder({",
    "const active = await resolveTikTokAccount(req);\n    if (!active?.id) throw new Error(\"Elige una cuenta de TikTok en Cuentas.\");\n    const result = await scheduler.scheduleFolder({"
  );

  text = text.replace(
    "    if (startRun?.running) throw new Error(\"Ya hay una programacion en marcha. Espera a que termine.\");\n    const active = await context.getActiveAccount();",
    "    if (startRun?.running) throw new Error(\"Ya hay una programacion en marcha. Espera a que termine.\");\n    const active = await resolveTikTokAccount(req);"
  );

  return text;
}

/* ------------------------------------------------------------------ *
 * P A R C H E   4 : web/autopost.js
 * Lee la cuenta seleccionada (localStorage + /api/accounts) y la envia
 * en todas las llamadas de TikTok. Escucha el cambio de cuenta.
 * ------------------------------------------------------------------ */

function patchAutopost(text) {
  if (text.includes("function currentAccountId")) return text;

  const anchor =
    "  async function refreshAccount() {\n" +
    "    try {\n" +
    "      const data = await API.get(\"/api/accounts\");\n" +
    "      const account = data?.activeAccount;";

  const helper =
    "  // " + MARK + ": la cuenta que se usa en TikTok es SIEMPRE la seleccionada.   \n" +
    "  const ACCOUNT_KEY = \"autosocial.selectedAccountId\";\n" +
    "  let selectedAccountId = \"\";\n" +
    "  function setSelectedAccountId(id) {\n" +
    "    selectedAccountId = id || \"\";\n" +
    "    try { if (id) localStorage.setItem(ACCOUNT_KEY, id); } catch { /* ignore */ }\n" +
    "  }\n" +
    "  function currentAccountId() {\n" +
    "    return selectedAccountId || \"\";\n" +
    "  }\n" +
    "  function withAccount(payload = {}) {\n" +
    "    const id = currentAccountId();\n" +
    "    return id ? { ...payload, accountId: id } : payload;\n" +
    "  }\n" +
    "\n" + anchor;

  let out = mustReplace(text, anchor, helper, "helper currentAccountId");

  // refreshAccount: guardar el id activo y usarlo como fallback inicial.
  out = out.replace(
    "      const data = await API.get(\"/api/accounts\");\n" +
    "      const account = data?.activeAccount;\n" +
    "      if (account?.id) {\n" +
    "        els.accountBadge.textContent = account.name || account.id;\n" +
    "        els.accountBadge.classList.add(\"active\");",
    "      const data = await API.get(\"/api/accounts\");\n" +
    "      const account = data?.activeAccount;\n" +
    "      if (account?.id) {\n" +
    "        if (!currentAccountId()) setSelectedAccountId(account.id);\n" +
    "        els.accountBadge.textContent = account.name || account.id;\n" +
    "        els.accountBadge.classList.add(\"active\");"
  );

  // preview: tambien debe usar la cuenta seleccionada.
  out = out.replace(
    "      const data = await API.post(\"/api/autoclone/schedule/preview\", {\n" +
    "        folder,",
    "      const data = await API.post(\"/api/autoclone/schedule/preview\", withAccount({\n" +
    "        folder,"
  );
  out = out.replace(
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      });\n" +
    "      renderPlan(data.plan);",
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      }));\n" +
    "      renderPlan(data.plan);"
  );

  // Enviar accountId en schedule
  out = out.replace(
    "      const data = await API.post(\"/api/autoclone/schedule\", {\n" +
    "        folder,",
    "      const data = await API.post(\"/api/autoclone/schedule\", withAccount({\n" +
    "        folder,"
  );
  out = out.replace(
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      });\n" +
    "      renderPlan(",
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      }));\n" +
    "      renderPlan("
  );

  // Enviar accountId en schedule/start
  out = out.replace(
    "      const data = await API.post(\"/api/autoclone/schedule/start\", {\n" +
    "        folder,",
    "      const data = await API.post(\"/api/autoclone/schedule/start\", withAccount({\n" +
    "        folder,"
  );
  out = out.replace(
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      });\n" +
    "      renderStartProgress(data?.run);",
    "        location: selectedLocation(),\n" +
    "        aiGenerated: isAiGenerated(),\n" +
    "      }));\n" +
    "      renderStartProgress(data?.run);"
  );

  // login/status con accountId
  out = out.replace(
    "      const data = await API.get(\"/api/tiktok/login/status\");",
    "      const id = currentAccountId();\n" +
    "      const data = await API.get(\"/api/tiktok/login/status\" + (id ? `?accountId=${encodeURIComponent(id)}` : \"\"));"
  );

  // login con accountId
  out = out.replace(
    "      await API.post(\"/api/tiktok/login\", {});",
    "      await API.post(\"/api/tiktok/login\", withAccount({}));"
  );

  // Escuchar cambio de cuenta: refrescar badge + estado de sesion de ESA cuenta.
  out = out.replace(
    "  document.addEventListener(\"autosocial:viewchange\", (event) => {",
    "  document.addEventListener(\"autosocial:accountchange\", (event) => {\n" +
    "    const id = event?.detail?.accountId || \"\";\n" +
    "    if (id) setSelectedAccountId(id);\n" +
    "    refreshAccount();\n" +
    "    checkLoginStatus(true);\n" +
    "  });\n" +
    "\n" +
    "  document.addEventListener(\"autosocial:viewchange\", (event) => {"
  );

  return out;
}

/* ------------------------------------------------------------------ */

const FILES = [
  { rel: "src/tiktok-uploader.js", fn: patchUploader },
  { rel: "src/dashboard-server.js", fn: patchServer },
  { rel: "src/autoclone/index.js", fn: patchAutoclone },
  { rel: "web/autopost.js", fn: patchAutopost },
];

function runRevert() {
  let restored = 0;
  for (const { rel } of FILES) {
    const dir = path.dirname(path.resolve(ROOT, rel));
    const base = path.basename(rel);
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-${MARK}-`))
      .sort();
    if (!backups.length) { log(`sin backup para ${rel}`); continue; }
    const latest = backups[backups.length - 1];
    fs.copyFileSync(path.resolve(dir, latest), path.resolve(ROOT, rel));
    log(`revertido ${rel} desde ${latest}`);
    restored += 1;
  }
  log(restored ? `Revertido (${restored} archivo/s).` : "No habia nada que revertir.");
}

function runApply() {
  for (const { rel, fn } of FILES) {
    const before = read(rel);
    const after = fn(before);
    if (after === before) {
      log(`${rel}: ya estaba aplicado (sin cambios).`);
      continue;
    }
    write(rel, after);
  }
  log("Listo. Cierra y vuelve a arrancar el dashboard (npm run dashboard).");
}

if (REVERT) runRevert();
else runApply();
