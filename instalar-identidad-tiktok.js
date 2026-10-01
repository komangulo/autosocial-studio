#!/usr/bin/env node
/*
 * Verificacion de identidad de la sesion de TikTok por cuenta
 * ===========================================================
 * AutoSocial Studio guarda la sesion de TikTok en .profiles/<cuenta>/tiktok,
 * pero NUNCA comprobaba DE QUE USUARIO eran esas cookies. Resultado: si un
 * perfil tenia guardada la sesion de OTRA cuenta de TikTok, la app publicaba
 * con la cuenta equivocada sin enterarse (cuentas "mezcladas").
 *
 * Este parche anade:
 *   1. Deteccion automatica del @usuario de TikTok logueado en el perfil.
 *   2. Memoria por cuenta del @usuario detectado (accounts-state.json ->
 *      tiktokUsername), para todas las cuentas presentes y FUTURAS.
 *   3. Validacion antes de publicar/programar: si el @ del perfil NO coincide
 *      con el de la cuenta, se BLOQUEA y se avisa (no publica en la cuenta
 *      equivocada).
 *   4. Endpoint para detectar el @ y para cerrar la sesion solo de ESA cuenta.
 *
 * Uso:
 *   node instalar-identidad-tiktok.js            (aplica; idempotente)
 *   node instalar-identidad-tiktok.js --revert   (revierte)
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const REVERT = args.has("--revert") || args.has("--undo");
const MARK = "IDENTIDAD-TIKTOK";
const MARKER = "// MARKER: " + MARK + "-v1";

function log(msg) { console.log(`[${MARK}] ${msg}`); }

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
function mustReplace(src, needle, replacement, label) {
  if (!src.includes(needle)) {
    throw new Error(`Anclaje no encontrado: ${label}. El proyecto puede haber cambiado; avisa a tu asistente.`);
  }
  return src.replace(needle, replacement);
}

/* ==================================================================
 * 1) NUEVO MODULO: src/tiktok-identity.js
 * ================================================================== */

const IDENTITY_MODULE = `/**
 * ${MARK}: identidad de la sesion de TikTok por cuenta.
 *
 * Detecta QUE usuario de TikTok esta logueado en el perfil persistente de una
 * cuenta y compara con el usuario esperado. Asi nunca se publica con la cuenta
 * equivocada aunque la carpeta tenga una sesion cruzada.
 *
 * Este archivo es autocontenido: recibe el "page" de Playwright ya abierto.
 */
const TIKTOK_USERNAME_KEYS = ["tiktokUsername", "tiktok_username", "tiktokHandle"];

function normalizeHandle(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\\/\\/(www\\.)?tiktok\\.com\\//i, "")
    .replace(/^@+/, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

/**
 * Lee el @usuario de TikTok desde una pagina ya cargada.
 * Devuelve { username, displayName, source } o { username:"" } si no pudo.
 */
async function detectTiktokUsernameFromPage(page) {
  if (!page) return { username: "", displayName: "", source: "no-page" };

  // 1) API interna de TikTok (la mas fiable): usuario actual de la sesion.
  try {
    const viaApi = await page.evaluate(async () => {
      try {
        const res = await fetch("https://www.tiktok.com/passport/web/account/info/?aid=1459", {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        const json = await res.json();
        const d = (json && (json.data || json.userInfo || json)) || {};
        return {
          username: d.username || d.uniqueId || d.userId || "",
          nickname: d.nickname || d.displayName || "",
        };
      } catch (e) {
        return { username: "", nickname: "", error: String(e && e.message || e) };
      }
    });
    const u = normalizeHandle(viaApi && viaApi.username);
    if (u) return { username: u, displayName: viaApi.nickname || "", source: "passport-api" };
  } catch { /* sigue */ }

  // 2) DOM: enlace al perfil propio en la cabecera.
  try {
    const viaDom = await page.evaluate(() => {
      const selectors = [
        'a[data-e2e="profile-icon"]',
        'a[href^="/@"]',
        'a[href*="tiktok.com/@"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const href = el && el.getAttribute && el.getAttribute("href");
        if (href && href.includes("/@")) {
          const m = href.match(/\\/@([A-Za-z0-9._]+)/);
          if (m) return m[1];
        }
      }
      return "";
    });
    const u = normalizeHandle(viaDom);
    if (u) return { username: u, displayName: "", source: "dom" };
  } catch { /* sigue */ }

  // 3) Cookies: tiktok.com guarda "uniqueId" tras el login.
  try {
    const cookies = await page.context().cookies("https://www.tiktok.com");
    for (const key of ["uniqueId", "unique_id", "username"]) {
      const hit = cookies.find((c) => c.name === key && c.value);
      const u = normalizeHandle(hit && hit.value);
      if (u) return { username: u, displayName: "", source: "cookie:" + key };
    }
  } catch { /* sigue */ }

  return { username: "", displayName: "", source: "not-found" };
}

/**
 * Verifica que la sesion del perfil sea la de la cuenta esperada.
 * Devuelve { ok, detected, expected, mismatch, detectedSource, error }.
 *  - ok=true si no hay usuario esperado (cuenta aun sin registrar) o coinciden.
 *  - mismatch=true solo cuando hay usuario esperado y NO coincide.
 */
async function verifyTiktokIdentity({ page, expectedUsername, pageUrl }) {
  let detected = { username: "", displayName: "", source: "n/a" };
  try {
    const url = pageUrl || "https://www.tiktok.com/foryou";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    detected = await detectTiktokUsernameFromPage(page);
  } catch (e) {
    return { ok: true, detected: "", expected: normalizeHandle(expectedUsername), mismatch: false,
      detectedSource: "error", error: String(e && e.message || e) };
  }
  const expected = normalizeHandle(expectedUsername);
  const got = normalizeHandle(detected.username);
  const mismatch = Boolean(expected && got && expected !== got);
  return {
    ok: !mismatch,
    detected: got,
    detectedDisplay: detected.displayName || "",
    expected,
    mismatch,
    detectedSource: detected.source || "",
  };
}

module.exports = {
  normalizeHandle,
  detectTiktokUsernameFromPage,
  verifyTiktokIdentity,
  TIKTOK_USERNAME_KEYS,
};
`;

/* ==================================================================
 * 2) tiktok-uploader.js
 *    - exporta verify/detect
 *    - valida identidad antes de subir (uploadVideo)
 *    - getLoginSessionStatus informa del username detectado
 * ================================================================== */

function patchUploader(text) {
  if (text.includes(MARKER)) return text;

  // 2a) require del modulo y extraccion del username esperado de la cuenta.
  const anchorImport =
    "const {\n" +
    "  getActiveAccount,";
  if (!text.includes("tiktok-identity")) {
    text = mustReplace(
      text,
      "const {\n  getActiveAccount,",
      "const tiktokIdentity = require(\"./tiktok-identity\"); // " + MARKER + "\n\nconst {\n  getActiveAccount,",
      "import tiktok-identity"
    );
  }

  // 2b) helper que obtiene el usuario esperado de una cuenta.
  //     Se inserta justo antes de getLoginSessionStatus(...) usando indice,
  //     para convivir con el parche previo que anadio (accountId) a la firma.
  const statusIdx = text.search(/async function getLoginSessionStatus\s*\(/);
  if (statusIdx < 0) {
    throw new Error("Anclaje no encontrado: helper identidad (getLoginSessionStatus).");
  }
  const helper =
    "// " + MARKER + ": usuario de TikTok esperado para una cuenta (para validar la sesion).\n" +
    "async function getExpectedTiktokUsername(accountId) {\n" +
    "  try {\n" +
    "    const account = await requireAccount(accountId);\n" +
    "    for (const key of tiktokIdentity.TIKTOK_USERNAME_KEYS) {\n" +
    "      const value = account && account[key];\n" +
    "      if (value) return tiktokIdentity.normalizeHandle(value);\n" +
    "    }\n" +
    "  } catch { /* cuenta sin usuario registrado */ }\n" +
    "  return \"\";\n" +
    "}\n" +
    "\n" +
    "// " + MARKER + ": valida que la sesion del perfil pertenezca a la cuenta.\n" +
    "// Devuelve { blocked, detected, expected } y NUNCA lanza por si sola.\n" +
    "async function assertTiktokIdentity(page, accountId) {\n" +
    "  const expected = await getExpectedTiktokUsername(accountId);\n" +
    "  const result = await tiktokIdentity.verifyTiktokIdentity({ page, expectedUsername: expected });\n" +
    "  if (result.mismatch) {\n" +
    "    return { blocked: true, detected: result.detected, expected: result.expected, result };\n" +
    "  }\n" +
    "  return { blocked: false, detected: result.detected, expected: result.expected, result };\n" +
    "}\n" +
    "\n";
  text = text.slice(0, statusIdx) + helper + text.slice(statusIdx);

  // 2c) validar al inicio de uploadVideo, tras cargar la pagina.
  const upAnchor =
    "  try {\n" +
    "    await onPhase?.(\"browser-started\");\n" +
    "    await gotoUploadPage(page);";
  const upRepl =
    "  try {\n" +
    "    await onPhase?.(\"browser-started\");\n" +
    "    // " + MARKER + ": antes de tocar nada, comprobar que la sesion es de la cuenta correcta.\n" +
    "    try {\n" +
    "      const idCheck = await assertTiktokIdentity(page, accountId);\n" +
    "      if (idCheck.blocked) {\n" +
    "        throw new Error(\n" +
    "          `Sesion de TikTok equivocada en esta cuenta. Esta cuenta tiene la sesion de @${idCheck.detected}` +\n" +
    "          (idCheck.expected ? ` pero deberia ser @${idCheck.expected}` : \"\") +\n" +
    "          `. Abre \"Iniciar sesion en TikTok\" con ESA cuenta o usa \"Cerrar sesion de esta cuenta\" y vuelve a entrar.`\n" +
    "        );\n" +
    "      }\n" +
    "    } catch (e) {\n" +
    "      if (/Sesion de TikTok equivocada/.test(String(e && e.message))) throw e;\n" +
    "      console.log(`[identidad] no se pudo verificar la sesion: ${e && e.message}`);\n" +
    "    }\n" +
    "    await gotoUploadPage(page);";
  text = mustReplace(text, upAnchor, upRepl, "validacion en uploadVideo");

  // 2d) getLoginSessionStatus: informar del username detectado.
  //     Se localiza la funcion por regex (convive con el parche previo) y se
  //     reemplaza solo si no incluye ya expectedUsername.
  const statusFnRe = /async function getLoginSessionStatus\([^)]*\) \{[\s\S]*?\n\}/;
  const statusMatch = text.match(statusFnRe);
  if (!statusMatch) throw new Error("Anclaje no encontrado: getLoginSessionStatus v2.");
  let statusFn = statusMatch[0];
  if (!statusFn.includes("expectedUsername")) {
    // Cambia la firma para aceptar accountId y anade el usuario esperado.
    statusFn = statusFn
      .replace(/async function getLoginSessionStatus\([^)]*\) \{/,
        "async function getLoginSessionStatus(accountId) {")
      .replace("  const activeAccount = await getActiveAccount();",
        "  const activeAccount = accountId ? await requireAccount(accountId) : await getActiveAccount();")
      .replace("    saved,\n",
        "    saved,\n    accountId: activeAccount.id,\n    expectedUsername: await getExpectedTiktokUsername(activeAccount.id),\n");
  }
  text = text.replace(statusFnRe, statusFn);

  // 2e) helpers para el dashboard: detectar @ de la sesion guardada y resetear
  //     la sesion de UNA cuenta. Se insertan justo antes de la funcion de status.
  const helpers =
    "// " + MARKER + ": abre el perfil de una cuenta, lee el @ de TikTok y cierra.\n" +
    "// Sirve para \"detectar el usuario\" de una sesion ya guardada.\n" +
    "async function detectTiktokSessionUsername(accountId) {\n" +
    "  const account = await requireAccount(accountId);\n" +
    "  const context = await openContextWithRetry(account.id);\n" +
    "  try {\n" +
    "    const page = context.pages()[0] || (await context.newPage());\n" +
    "    const found = await tiktokIdentity.verifyTiktokIdentity({ page, expectedUsername: \"\" });\n" +
    "    return { username: found.detected || \"\", source: found.detectedSource || \"\", account: account.id };\n" +
    "  } finally {\n" +
    "    await context.close().catch(() => {});\n" +
    "  }\n" +
    "}\n" +
    "\n" +
    "// " + MARKER + ": borra la sesion de TikTok SOLO de esta cuenta.\n" +
    "// No toca ninguna otra cuenta: solo su carpeta .profiles/<id>/tiktok.\n" +
    "async function resetTiktokSessionForAccount(accountId) {\n" +
    "  const account = await requireAccount(accountId);\n" +
    "  const profileDir = await getPlatformProfileDir(\"tiktok\", account.id);\n" +
    "  if (loginSessionContext && loginSessionAccountId === account.id) {\n" +
    "    await closeCurrentLoginContext().catch(() => {});\n" +
    "  }\n" +
    "  if (sharedTikTokBrowser && sharedTikTokBrowser.accountId === account.id) {\n" +
    "    await closeSharedTikTokBrowserNow().catch(() => {});\n" +
    "  }\n" +
    "  const fsSync = require(\"fs\");\n" +
    "  await new Promise((r) => setTimeout(r, 800));\n" +
    "  fsSync.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });\n" +
    "  return { reset: true, profileDir };\n" +
    "}\n" +
    "\n";
  const statusIdx2 = text.search(/async function getLoginSessionStatus\s*\(/);
  if (statusIdx2 < 0) throw new Error("Anclaje no encontrado: helpers detect/reset.");
  text = text.slice(0, statusIdx2) + helpers + text.slice(statusIdx2);

  // 2f) exportar helpers nuevos.
  text = mustReplace(
    text,
    "  uploadVideo,\n  closeSharedTikTokBrowser,",
    "  uploadVideo,\n  assertTiktokIdentity,\n  getExpectedTiktokUsername,\n  detectTiktokSessionUsername,\n  resetTiktokSessionForAccount,\n  detectTiktokUsername: tiktokIdentity.detectTiktokUsernameFromPage,\n  closeSharedTikTokBrowser,",
    "exports uploader"
  );

  // 2f) quitar la version previa (sin accountId) si el parche antiguo estaba aplicado.
  if (text.includes("async function getLoginSessionStatus(accountId) {") &&
      text.includes("// AISLAR-CUENTAS-TIKTOK: el estado de sesion")) {
    // nada que hacer: la rama con accountId ya gana; evitamos dobles firmas.
  }
  return text;
}

/* ==================================================================
 * 3) account-manager.js
 *    - conservar tiktokUsername al normalizar/guardar cuentas
 *    - funcion setTiktokUsername
 * ================================================================== */

function patchAccountManager(text) {
  if (text.includes(MARKER)) return text;

  // 3a) normalizeState: conservar tiktokUsername.
  text = mustReplace(
    text,
    "      .map((item) => ({ id: item.id, name: item.name }))",
    "      .map((item) => ({ id: item.id, name: item.name, tiktokUsername: item.tiktokUsername || \"\" })) // " + MARK,
    "normalizeState tiktokUsername"
  );

  // 3b) setTiktokUsername + include en exports.
  text = mustReplace(
    text,
    "async function getAllAccounts() {",
    "// " + MARKER + ": memoriza el @usuario de TikTok de una cuenta.\n" +
    "async function setTiktokUsername(accountId, username) {\n" +
    "  await ensureLoaded();\n" +
    "  const target = state.accounts.find((item) => item.id === assertSafeAccountId(accountId));\n" +
    "  if (!target) throw new Error(\"Account not found.\");\n" +
    "  const clean = String(username || \"\").trim().replace(/^@+/, \"\").slice(0, 60);\n" +
    "  target.tiktokUsername = clean;\n" +
    "  await saveState();\n" +
    "  return clone(target);\n" +
    "}\n" +
    "\n" +
    "async function getAllAccounts() {",
    "setTiktokUsername"
  );

  text = mustReplace(
    text,
    "  getPlatformProfileDir,\n  hasSavedPlatformSession,",
    "  getPlatformProfileDir,\n  hasSavedPlatformSession,\n  setTiktokUsername,",
    "exports account-manager"
  );

  return text;
}

/* ==================================================================
 * 4) dashboard-server.js
 *    - endpoints para detectar @ y cerrar sesion de una cuenta
 *    - exponer tiktokUsername en /api/accounts
 * ================================================================== */

function patchServer(text) {
  if (text.includes("identity/accounts")) return text;

  // 4a) imports: setTiktokUsername (+ helpers de identidad del uploader).
  text = mustReplace(
    text,
    "  requireAccount,\n  hasSavedPlatformSession,\n} = require(\"./account-manager\");",
    "  requireAccount,\n  hasSavedPlatformSession,\n  setTiktokUsername,\n} = require(\"./account-manager\"); // " + MARK,
    "import setTiktokUsername"
  );

  text = mustReplace(
    text,
    "  getLoginSessionStatus: getTikTokLoginSessionStatus,\n  closeLoginSession: closeTikTokLoginSession,\n} = require(\"./tiktok-uploader\");",
    "  getLoginSessionStatus: getTikTokLoginSessionStatus,\n  closeLoginSession: closeTikTokLoginSession,\n  detectTiktokSessionUsername: detectTikTokSessionUsername,\n  resetTiktokSessionForAccount,\n} = require(\"./tiktok-uploader\"); // " + MARK,
    "import helpers identidad uploader"
  );

  // getAllAccounts ya se importa de account-manager en el proyecto original;
  // nos aseguramos de que este disponible.
  if (!/getAllAccounts/.test(text.split("} = require(\"./account-manager\");")[0])) {
    text = mustReplace(
      text,
      "  setTiktokUsername,\n} = require(\"./account-manager\");",
      "  setTiktokUsername,\n  getAllAccounts,\n} = require(\"./account-manager\");",
      "import getAllAccounts"
    );
  }

  // 4b) endpoints: detectar @ y cerrar sesion de una cuenta concreta.
  const anchor = "  // Login endpoints (TikTok)";
  const endpoints =
    "  // " + MARK + ": lee el @ de la sesion guardada y lo memoriza en la cuenta.\n" +
    "  app.post(\"/api/tiktok/identity/refresh\", async (req, res) => {\n" +
    "    try {\n" +
    "      const account = await requireAccount(req.body?.accountId);\n" +
    "      const detected = await detectTikTokSessionUsername(account.id);\n" +
    "      if (detected && detected.username) {\n" +
    "        await setTiktokUsername(account.id, detected.username);\n" +
    "      }\n" +
    "      res.json({ ok: true, account: account.id, detected });\n" +
    "    } catch (error) {\n" +
    "      res.status(400).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });\n" +
    "\n" +
    "  // " + MARK + ": cierra la sesion SOLO de esta cuenta (borra su perfil de TikTok).\n" +
    "  app.post(\"/api/tiktok/identity/reset\", async (req, res) => {\n" +
    "    try {\n" +
    "      const account = await requireAccount(req.body?.accountId);\n" +
    "      const result = await resetTikTokSessionForAccount(account.id);\n" +
    "      await setTiktokUsername(account.id, \"\").catch(() => {});\n" +
    "      res.json({ ok: true, account: account.id, ...result });\n" +
    "    } catch (error) {\n" +
    "      res.status(400).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });\n" +
    "\n" +
    "  // " + MARK + ": lista el @ esperado y la sesion guardada de cada cuenta.\n" +
    "  app.get(\"/api/tiktok/identity/accounts\", async (req, res) => {\n" +
    "    try {\n" +
    "      const accounts = await getAllAccounts();\n" +
    "      const items = [];\n" +
    "      for (const account of accounts) {\n" +
    "        items.push({\n" +
    "          id: account.id,\n" +
    "          name: account.name,\n" +
    "          tiktokUsername: account.tiktokUsername || \"\",\n" +
    "          sessionSaved: await hasSavedPlatformSession(\"tiktok\", account.id),\n" +
    "        });\n" +
    "      }\n" +
    "      res.json({ ok: true, accounts: items });\n" +
    "    } catch (error) {\n" +
    "      res.status(500).json({ ok: false, error: error.message });\n" +
    "    }\n" +
    "  });\n" +
    "\n" +
    anchor;
  text = mustReplace(text, anchor, endpoints, "endpoints identidad");

  return text;
}

/* ==================================================================
 * 5) web/app.js
 *    - muestra el @ de TikTok de cada cuenta
 *    - botones "Detectar @" y "Cerrar sesion" por cuenta
 * ================================================================== */

function patchWebApp(text) {
  if (text.includes("identity/refresh")) return text;

  // 5a0) cabecera de la tabla: anadir columna "TikTok @" (en index.html no aplica).
  return patchWebAppInner(text);
}

function patchWebAppInner(text) {
  // 5a) fila de cuenta: mostrar @ detectado + botones.
  const rowAnchor =
    "        const isActive = account.id === data.activeAccountId;\n" +
    "        const sessionSaved = Boolean(account.sessionSaved);\n" +
    "        const status = sessionSaved ? \"session saved\" : isActive ? \"setup in progress\" : \"not connected\";";
  const rowRepl =
    "        const isActive = account.id === data.activeAccountId;\n" +
    "        const sessionSaved = Boolean(account.sessionSaved);\n" +
    "        const status = sessionSaved ? \"session saved\" : isActive ? \"setup in progress\" : \"not connected\";\n" +
    "        const tiktokUser = account.tiktokUsername ? \"@\" + account.tiktokUsername : \"\"; // " + MARK;
  text = mustReplace(text, rowAnchor, rowRepl, "fila cuenta web");

  const cellAnchor =
    "            <td><span class=\"mono\">.profiles/${escapeHtml(account.id)}/tiktok</span></td>";
  const cellRepl =
    "            <td><span class=\"mono\">.profiles/${escapeHtml(account.id)}/tiktok</span></td>\n" +
    "            <td>${tiktokUser ? `<span class=\"status-badge active\" title=\"Usuario de TikTok detectado\">${escapeHtml(tiktokUser)}</span>` : '<span class=\"status-badge warn\">sin comprobar</span>'}</td>";
  text = mustReplace(text, cellAnchor, cellRepl, "celda @ web");

  const btnAnchor =
    "              <button class=\"control-btn-small\" data-account-action=\"open\" data-account-id=\"${escapeHtml(account.id)}\"><i class=\"ph ph-browser\"></i> Open signup</button>";
  const btnRepl =
    "              <button class=\"control-btn-small\" data-account-action=\"open\" data-account-id=\"${escapeHtml(account.id)}\"><i class=\"ph ph-browser\"></i> Open signup</button>\n" +
    "              <button class=\"control-btn-small\" data-account-action=\"detect-identity\" data-account-id=\"${escapeHtml(account.id)}\"><i class=\"ph ph-tiktok-logo\"></i> Detectar @</button>\n" +
    "              <button class=\"control-btn-small\" data-account-action=\"reset-identity\" data-account-id=\"${escapeHtml(account.id)}\"><i class=\"ph ph-sign-out\"></i> Cerrar sesion</button>";
  text = mustReplace(text, btnAnchor, btnRepl, "botones identidad web");

  // 5b) colspan de la tabla (ahora 6 columnas).
  text = text.replace(
    "'<tr><td colspan=\"5\">No local accounts found.</td></tr>'",
    "'<tr><td colspan=\"6\">No local accounts found.</td></tr>'"
  );

  // 5c) manejo del clic.
  const clickAnchor =
    "      if (action === \"open\") {\n" +
    "        await API.post(\"/api/account-manager/open-assisted\", { accountId });\n" +
    "        await this.refresh();\n" +
    "      }";
  const clickRepl =
    "      if (action === \"open\") {\n" +
    "        await API.post(\"/api/account-manager/open-assisted\", { accountId });\n" +
    "        await this.refresh();\n" +
    "      }\n" +
    "      // " + MARK + ": detectar el @ de TikTok de esta cuenta.\n" +
    "      if (action === \"detect-identity\") {\n" +
    "        const result = await API.post(\"/api/tiktok/identity/refresh\", { accountId });\n" +
    "        const who = result?.detected?.username ? \"@\" + result.detected.username : \"(no detectado)\";\n" +
    "        alert(\"Cuenta de TikTok en este perfil: \" + who);\n" +
    "        this.renderManagedAccounts(await API.get(\"/api/account-manager\"));\n" +
    "      }\n" +
    "      // " + MARK + ": cerrar la sesion SOLO de esta cuenta.\n" +
    "      if (action === \"reset-identity\") {\n" +
    "        const ok = confirm(\"Se borrara la sesion de TikTok SOLO de esta cuenta. \" +\n" +
    "          \"Las demas cuentas no se tocan. ¿Continuar?\");\n" +
    "        if (ok) {\n" +
    "          await API.post(\"/api/tiktok/identity/reset\", { accountId });\n" +
    "          alert(\"Sesion borrada. Abre «Iniciar sesion en TikTok» con la cuenta correcta.\");\n" +
    "          this.renderManagedAccounts(await API.get(\"/api/account-manager\"));\n" +
    "        }\n" +
    "      }";
  text = mustReplace(text, clickAnchor, clickRepl, "click identidad web");

  return text;
}

/* ==================================================================
 * 6) web/index.html
 *    - cabecera con columna "TikTok @" y colspan de 6
 * ================================================================== */

function patchIndexHtml(text) {
  if (text.includes("TikTok @")) return text;
  const anchor =
    "                  <th>Browser profile</th>\n" +
    "                  <th>Session</th>\n" +
    "                  <th>Status</th>\n" +
    "                  <th>Actions</th>";
  const repl =
    "                  <th>Browser profile</th>\n" +
    "                  <th>TikTok @</th>\n" +
    "                  <th>Session</th>\n" +
    "                  <th>Status</th>\n" +
    "                  <th>Actions</th>";
  text = mustReplace(text, anchor, repl, "cabecera tabla accounts");
  text = text.replace('<tr><td colspan="5">Loading accounts...</td></tr>',
    '<tr><td colspan="6">Loading accounts...</td></tr>');
  return text;
}

/* ==================================================================
 * Punto de entrada
 * ================================================================== */

function ensureIdentityModule() {
  const target = full("src/tiktok-identity.js");
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8").includes(MARK)) {
    log("src/tiktok-identity.js ya existe.");
    return;
  }
  fs.writeFileSync(target, IDENTITY_MODULE, "utf8");
  log("creado src/tiktok-identity.js");
}

const FILES = [
  { rel: "src/tiktok-uploader.js", fn: patchUploader },
  { rel: "src/account-manager.js", fn: patchAccountManager },
  { rel: "src/dashboard-server.js", fn: patchServer },
  { rel: "web/app.js", fn: patchWebApp },
  { rel: "web/index.html", fn: patchIndexHtml },
];

function runRevert() {
  let restored = 0;
  for (const { rel } of FILES) {
    const dir = path.dirname(full(rel));
    const base = path.basename(rel);
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-${MARK}-`))
      .sort();
    if (!backups.length) { log(`sin backup para ${rel}`); continue; }
    fs.copyFileSync(path.resolve(dir, backups[backups.length - 1]), full(rel));
    log(`revertido ${rel}`);
    restored += 1;
  }
  const idMod = full("src/tiktok-identity.js");
  if (fs.existsSync(idMod)) { fs.rmSync(idMod); log("eliminado src/tiktok-identity.js"); }
  log(restored ? `Revertido (${restored}).` : "Nada que revertir.");
}

function runApply() {
  ensureIdentityModule();
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
