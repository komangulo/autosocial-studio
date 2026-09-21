#!/usr/bin/env node
/**
 * instalar-x-autopilot-fix.js
 * ---------------------------------------------------------------------------
 * Instalador idempotente para AutoSocial Studio que:
 *   1. Crea src/x-auth.js  (login/import de cookies + publicacion real en X).
 *   2. Reescribe src/x-autopilot.js (worker arrancable, timezone correcto,
 *      sin fallback basura, timeouts/reintentos, cadena de IA con fallback,
 *      reconciliacion de cola y publicacion via navegador).
 *   3. Parchea src/dashboard-server.js: arranca el worker y expone endpoints
 *      de login/cookies/estado de X.
 *   4. Parchea web/index.html y web/app.js: UI de sesion de X + botones.
 *   5. Anade x-autopilot-state.json a .gitignore.
 *
 * Uso:  node instalar-x-autopilot-fix.js
 * Es seguro ejecutarlo varias veces: cada bloque lleva un marcador unico.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const MARK = {
  auth: "// MARKER: XAP-AUTH-v1",
  aiConfig: "// MARKER: AICFG-v1",
  engine: "// MARKER: XAP-ENGINE-v2",
  serverStart: "// MARKER: XAP-WORKER-START-v1",
  serverRoutes: "// MARKER: XAP-ROUTES-v1",
  serverAi: "// MARKER: AICFG-ROUTES-v1",
  gitignore: "# MARKER: XAP-IGNORE-v1",
  html: "<!-- MARKER: XAP-UI-v1 -->",
  htmlAi: "<!-- MARKER: AICFG-UI-v1 -->",
  navAi: "<!-- MARKER: AICFG-NAV-v1 -->",
  jsBind: "// MARKER: XAP-BIND-v1",
  jsRender: "// MARKER: XAP-RENDER-v1",
  jsHandlers: "// MARKER: XAP-HANDLERS-v1",
  jsAiBind: "// MARKER: AICFG-BIND-v1",
  jsAiLogic: "// MARKER: AICFG-LOGIC-v1",
  cssAi: "/* MARKER: AICFG-CSS-v1 */",
  xAiClean: "<!-- MARKER: XAP-AI-CLEAN-v1 -->",
  xAiJs: "// MARKER: XAP-AI-CLEAN-JS-v1",
  audit: "// MARKER: ACCTAN-v1",
  auditRoutes: "// MARKER: ACCTAN-ROUTES-v1",
  pubReports: "// MARKER: ACCTAN-REPORTS-v1",
  auditNav: "<!-- MARKER: ACCTAN-NAV-v1 -->",
  auditUi: "<!-- MARKER: ACCTAN-UI-v1 -->",
  auditJs: "// MARKER: ACCTAN-JS-v1",
  acctSession: "// MARKER: ACCTAN-SESSION-v1",
  acctSessionLock: "// MARKER: ACCTAN-SESSION-LOCK-v1",
  pub: "// MARKER: ACCT-PUB-v1",
  pubBoot: "// MARKER: ACCT-PUB-BOOT-v1",
  pubRoutes: "// MARKER: ACCT-PUB-ROUTES-v1",
  pubStopRoute: "// MARKER: ACCT-PUB-STOP-ROUTE-v1",
  pubUi: "<!-- MARKER: ACCT-PUB-UI-v1 -->",
  pubJs: "// MARKER: ACCT-PUB-JS-v1",
  autoclone: "// MARKER: AICFG-BRIDGE-v1",
  radar: "// MARKER: ACCT-RADAR-v1",
  radarRoutes: "// MARKER: ACCT-RADAR-ROUTES-v1",
  radarUi: "<!-- MARKER: ACCT-RADAR-UI-v1 -->",
  postRich: "MARKER: XAP-POST-RICH-v1",
};

const results = [];
function ok(msg) { results.push(["OK", msg]); }
function skip(msg) { results.push(["SKIP", msg]); }
function fail(msg) { results.push(["FAIL", msg]); }

function read(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}
function write(rel, text) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf8");
}
function backup(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return;
  const bak = `${full}.xap-backup`;
  if (!fs.existsSync(bak)) fs.copyFileSync(full, bak);
}
function replaceOnce(text, needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`No se encontro el punto de insercion: ${label}`);
  if (text.indexOf(needle, index + needle.length) !== -1) {
    // Multiple matches: use last occurrence style replacement is risky, so fall back to first.
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

// ---------------------------------------------------------------------------
// 0. Sanity check
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(path.join(ROOT, "src", "x-autopilot.js"))) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. src/x-auth.js
// ---------------------------------------------------------------------------
(function installAuth() {
  const content = read("src/x-auth.js");
  if (content && content.includes("reused: true") && content.includes("XAP-AUTH-CHROMIUM-v1") && content.includes("XAP-CONFIRM-v2")) {
    skip("src/x-auth.js ya esta actualizado"); return;
  }
  const payload = readAsset("x-auth.js");
  write("src/x-auth.js", payload);
  if (content) ok("src/x-auth.js actualizado (publica con Chromium, sin bloquear el perfil)");
  else ok("src/x-auth.js creado");
})();

// ---------------------------------------------------------------------------
// 1b. src/ai-config.js  (configuracion global de IA)
// ---------------------------------------------------------------------------
(function installAiConfig() {
  const content = read("src/ai-config.js");
  if (content && content.includes(MARK.aiConfig) && content.includes("reload()") && content.includes("SETTINGS_FILE")) {
    skip("src/ai-config.js ya estaba instalado"); return;
  }
  write("src/ai-config.js", readAsset("ai-config.js"));
  ok("src/ai-config.js creado (configuracion global de IA)");
})();

// ---------------------------------------------------------------------------
// 1c. src/account-analyzer.js  (analisis de cuentas de X)
// ---------------------------------------------------------------------------
(function installAccountAnalyzer() {
  const content = read("src/account-analyzer.js");
  if (content && content.includes("[acct-analyzer]") && content.includes("sanitizeSample") && content.includes("REF:")) {
    skip("src/account-analyzer.js ya esta actualizado"); return;
  }
  write("src/account-analyzer.js", readAsset("account-analyzer.js"));
  if (content) ok("src/account-analyzer.js actualizado (sin usuarios/URLs en el manual)");
  else ok("src/account-analyzer.js creado (analisis de cualquier cuenta de X)");
})();

// ---------------------------------------------------------------------------
// 2. src/x-autopilot.js
// ---------------------------------------------------------------------------
(function installEngine() {
  const content = read("src/x-autopilot.js");
  if (content && content.includes(MARK.engine) && content.includes("sanitizeOutput") && content.includes("anonimo")) {
    skip("src/x-autopilot.js ya estaba parcheado"); return;
  }
  backup("src/x-autopilot.js");
  write("src/x-autopilot.js", readAsset("x-autopilot.js"));
  ok("src/x-autopilot.js reescrito (v2 - sin usuarios/URLs en los prompts)");
})();

// ---------------------------------------------------------------------------
// 2b. src/acct-publisher.js  (publicacion diaria desde el analisis de cuenta)
// ---------------------------------------------------------------------------
(function installPublisher() {
  const content = read("src/acct-publisher.js");
  if (content && content.includes("ACCT-PUB-v1") && content.includes("seededRandom") && content.includes("async function stop") && content.includes("no se reintenta") && content.includes("minGapMinutes") && content.includes("languageMigrated")) {
    skip("src/acct-publisher.js ya esta actualizado"); return;
  }
  write("src/acct-publisher.js", readAsset("acct-publisher.js"));
  if (content) ok("src/acct-publisher.js actualizado (idioma, espaciado, variacion y parada)");
  else ok("src/acct-publisher.js creado (publicacion diaria con ADN de una cuenta)");
})();

// ---------------------------------------------------------------------------
// 3. src/dashboard-server.js -- arrancar worker + rutas
// ---------------------------------------------------------------------------
(function installServer() {
  let text = read("src/dashboard-server.js");
  if (!text) { fail("src/dashboard-server.js no encontrado"); return; }

  if (!text.includes(MARK.serverStart)) {
    const match = text.match(/const xAutopilot\s*=\s*require\((["'])\.\/x-autopilot\1\);/);
    if (!match) {
      // The module might be required inline in route handlers; inject the require.
      const anchor = 'const googleFlow = require("./google-flow");';
      if (!text.includes(anchor)) { fail("dashboard-server.js: no se encontro require de google-flow"); return; }
      text = replaceOnce(text, anchor, `${anchor}\nconst xAutopilot = require("./x-autopilot");`, "googleFlow require");
    }
    const boot = `\n  ${MARK.serverStart}\n  try { xAutopilot.startWorker(); } catch (error) { console.error("[x-autopilot] no se pudo arrancar el worker:", error.message); }`;
    const listenAnchor = "  ensureDashboardBindAllowed();";
    text = replaceOnce(text, listenAnchor, `${boot}\n\n${listenAnchor}`, "arranque del worker");
    ok("dashboard-server.js: worker de X Autopilot arrancado al inicio");
  } else {
    skip("dashboard-server.js: worker ya arrancado");
  }

  // Worker de publicacion diaria (independiente del marcador anterior, para que
  // las instalaciones ya parcheadas tambien lo reciban).
  if (!text.includes(MARK.pubBoot)) {
    const pubBoot = `\n  ${MARK.pubBoot}\n  try { require("./acct-publisher").startWorker(); } catch (error) { console.error("[acct-publisher] no se pudo arrancar el worker:", error.message); }`;
    const listenAnchor = "  ensureDashboardBindAllowed();";
    text = replaceOnce(text, listenAnchor, `${pubBoot}\n\n${listenAnchor}`, "arranque del worker de publicacion");
    ok("dashboard-server.js: worker de publicacion diaria arrancado");
  } else {
    skip("dashboard-server.js: worker de publicacion diaria ya arrancado");
  }

  const oldSessionRoute = `app.get("/api/x-autopilot/session", async (req, res) => {
    try { res.json(await xAutopilot.getStatus((await getActiveAccount()).id)); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });`;
  const newSessionRoute = `app.get("/api/x-autopilot/session", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const status = await xAutopilot.getStatus(account.id);
      res.json({ ok: true, ...status, worker: Boolean(status && status.worker) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });`;
  if (text.includes(oldSessionRoute)) {
    text = replaceOnce(text, oldSessionRoute, newSessionRoute, "ruta de sesion de X actualizada");
    ok("dashboard-server.js: ruta de sesion corregida (devuelve la sesion de X)");
  }

  if (!text.includes(MARK.serverRoutes)) {
    const routes = `
  ${MARK.serverRoutes}
  app.get("/api/x-autopilot/session", async (req, res) => {
    try {
      const account = await getActiveAccount();
      const status = await xAutopilot.getStatus(account.id);
      res.json({ ok: true, ...status, worker: Boolean(status && status.worker) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/x-autopilot/login", async (req, res) => {
    try { res.json(await require("./x-auth").startLoginSession()); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/x-autopilot/login/save", async (req, res) => {
    try { res.json(await require("./x-auth").saveLoginSession()); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/x-autopilot/login/close", async (req, res) => {
    try { res.json(await require("./x-auth").closeLoginSession()); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/x-autopilot/cookies", async (req, res) => {
    try {
      const result = await require("./x-auth").importCookies(req.body?.cookies);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/x-autopilot/retry", async (req, res) => {
    try { res.json(await xAutopilot.retryFailed((await getActiveAccount()).id)); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${routes}\n  ${anchor}`, "rutas google-flow");
    ok("dashboard-server.js: endpoints de sesion de X anadidos");
  } else {
    skip("dashboard-server.js: endpoints de X ya presentes");
  }

  if (!text.includes(MARK.serverAi)) {
    const aiRoutes = `
  ${MARK.serverAi}
  const aiConfig = require("./ai-config");
  app.get("/api/ai-config", async (req, res) => {
    try { await aiConfig.load(); res.json(aiConfig.publicConfig()); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/ai-config", async (req, res) => {
    try { res.json(await aiConfig.save(req.body || {})); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/ai-config/test", async (req, res) => {
    try {
      const result = await aiConfig.testProvider(String(req.body?.provider || ""));
      res.json(await aiConfig.rememberTest(result));
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${aiRoutes}\n  ${anchor}`, "rutas config IA");
    ok("dashboard-server.js: endpoints de configuracion global de IA anadidos");
  } else {
    skip("dashboard-server.js: endpoints de config IA ya presentes");
  }

  if (!text.includes(MARK.auditRoutes)) {
    const auditRoutes = `
  ${MARK.auditRoutes}
  const accountAnalyzer = require("./account-analyzer");
  app.get("/api/account-analysis", async (req, res) => {
    try { res.json({ ok: true, profiles: await accountAnalyzer.listProfiles(), job: await accountAnalyzer.getStatus() }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.get("/api/account-analysis/status", async (req, res) => {
    try { res.json(await accountAnalyzer.getStatus()); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/account-analysis/start", async (req, res) => {
    try {
      const job = await accountAnalyzer.start(req.body?.handle, { maxPosts: req.body?.maxPosts });
      res.json({ ok: true, job });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.get("/api/account-analysis/:handle", async (req, res) => {
    try {
      const data = await accountAnalyzer.get(req.params.handle);
      if (!data) { res.status(404).json({ ok: false, error: "Esa cuenta no esta analizada todavia." }); return; }
      res.json({ ok: true, data });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.delete("/api/account-analysis/:handle", async (req, res) => {
    try { res.json({ ok: true, ...(await accountAnalyzer.remove(req.params.handle)) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${auditRoutes}\n  ${anchor}`, "rutas analisis de cuentas");
    ok("dashboard-server.js: endpoints de analisis de cuentas anadidos");
  } else {
    skip("dashboard-server.js: endpoints de analisis ya presentes");
  }

  // Historial de informes (bloque propio para que las instalaciones ya
  // parcheadas tambien lo reciban).
  if (!text.includes(MARK.pubReports)) {
    const reportRoutes = `
  ${MARK.pubReports}
  app.get("/api/account-analysis/:handle/reports", async (req, res) => {
    try { res.json({ ok: true, reports: await accountAnalyzer.listReports(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.get("/api/account-analysis/:handle/reports/:stamp", async (req, res) => {
    try {
      const data = await accountAnalyzer.getReport(req.params.handle, req.params.stamp);
      if (!data) { res.status(404).json({ ok: false, error: "Ese informe no existe." }); return; }
      res.json({ ok: true, data });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/account-analysis/:handle/reports/:stamp/use", async (req, res) => {
    try { res.json({ ok: true, ...(await accountAnalyzer.useReport(req.params.handle, req.params.stamp)) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.delete("/api/account-analysis/:handle/reports/:stamp", async (req, res) => {
    try { res.json({ ok: true, ...(await accountAnalyzer.removeReport(req.params.handle, req.params.stamp)) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${reportRoutes}\n  ${anchor}`, "rutas de historial de informes");
    ok("dashboard-server.js: endpoints de historial de informes anadidos");
  } else {
    skip("dashboard-server.js: endpoints de historial ya presentes");
  }

  if (!text.includes(MARK.pubRoutes)) {
    const pubRoutes = `
  ${MARK.pubRoutes}
  const acctPublisher = require("./acct-publisher");
  app.get("/api/acct-publisher/:handle", async (req, res) => {
    try { res.json({ ok: true, profile: acctPublisher.publicProfile(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-publisher/:handle", async (req, res) => {
    try { res.json({ ok: true, profile: await acctPublisher.configure(req.params.handle, req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-publisher/:handle/now", async (req, res) => {
    try {
      const result = await acctPublisher.publishNow(req.params.handle, req.body?.count, {
        topics: req.body?.topics,
        dryRun: req.body?.dryRun === true,
      });
      res.json({ ok: true, result, profile: acctPublisher.publicProfile(req.params.handle) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-publisher/:handle/clear", async (req, res) => {
    try { res.json({ ok: true, profile: await acctPublisher.clearHistory(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${pubRoutes}\n  ${anchor}`, "rutas de publicacion diaria");
    ok("dashboard-server.js: endpoints de publicacion diaria anadidos");
  } else {
    skip("dashboard-server.js: endpoints de publicacion diaria ya presentes");
  }

  // Ruta de parada (bloque propio para instalaciones ya parcheadas).
  if (!text.includes(MARK.pubStopRoute)) {
    const stopRoute = `
  ${MARK.pubStopRoute}
  app.post("/api/acct-publisher/:handle/stop", async (req, res) => {
    try { res.json({ ok: true, profile: await require("./acct-publisher").stop(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    text = replaceOnce(text, anchor, `${stopRoute}\n  ${anchor}`, "ruta de parada");
    ok("dashboard-server.js: endpoint de parada de publicacion anadido");
  } else {
    skip("dashboard-server.js: endpoint de parada ya presente");
  }

  write("src/dashboard-server.js", text);
})();

// ---------------------------------------------------------------------------
// 4. .gitignore
// ---------------------------------------------------------------------------
(function installGitignore() {
  const rel = ".gitignore";
  let text = read(rel) || "";
  if (text.includes(MARK.gitignore)) { skip(".gitignore ya parcheado"); return; }
  text += `\n${MARK.gitignore}\nx-autopilot-state.json\nx-autopilot-state.json.tmp\n.runtime/cookies\n`;
  write(rel, text.replace(/^\n+/, ""));
  ok(".gitignore: estado de X y cookies ignorados");
})();

// ---------------------------------------------------------------------------
// 5. web/index.html -- banner de sesion de X
// ---------------------------------------------------------------------------
(function installHtml() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado"); return; }
  if (text.includes(MARK.html)) { skip("web/index.html ya tiene la UI de X"); write("web/index.html", text); return; }

  const block = `
        ${MARK.html}
        <div id="xLoginBanner" class="tt-login-banner card" style="margin-bottom:14px;">
          <div class="tt-login-row">
            <span class="tt-login-icon"><i class="ph ph-x-logo"></i></span>
            <div class="tt-login-text">
              <strong id="xLoginTitle">Sesion de X (Twitter)</strong>
              <span id="xLoginMessage">Inicia sesion en la ventana de X o pega tus cookies para publicar automaticamente.</span>
            </div>
            <span id="xLoginStateBadge" class="status-badge">Sin comprobar</span>
            <button id="xLoginBtn" class="control-btn-small primary"><i class="ph ph-browser"></i> Iniciar sesion</button>
            <button id="xLoginSaveBtn" class="control-btn-small success"><i class="ph ph-floppy-disk"></i> Guardar sesion</button>
            <button id="xLoginCloseBtn" class="control-btn-small danger"><i class="ph ph-x"></i> Cerrar</button>
            <button id="xRetryBtn" class="control-btn-small" title="Reprogramar los posts que fallaron"><i class="ph ph-arrows-clockwise"></i> Reintentar fallidos</button>
          </div>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:flex-start;">
            <textarea id="xCookiesInput" rows="2" placeholder="O pega aqui tus cookies de X (formato header: auth_token=...; ct0=...  o JSON exportado)" style="flex:1; min-width:260px; font-family:monospace; font-size:11px; padding:8px; border-radius:8px; border:1px solid var(--border-color, #2a2a2a); background:var(--bg-input, #111); color:inherit; resize:vertical;"></textarea>
            <button id="xCookiesBtn" class="control-btn-small"><i class="ph ph-key"></i> Importar cookies</button>
          </div>
        </div>
`;
  // Insert right before the first dashboard-grid of the x-autopilot view.
  const viewAnchor = 'id="view-x-autopilot"';
  const viewIndex = text.indexOf(viewAnchor);
  if (viewIndex === -1) { fail("web/index.html: no se encontro la vista x-autopilot"); return; }
  const gridIndex = text.indexOf('<div class="x-grid">', viewIndex);
  if (gridIndex === -1) { fail("web/index.html: no se encontro el grid de x-autopilot"); return; }
  text = text.slice(0, gridIndex) + block + "\n" + text.slice(gridIndex);
  write("web/index.html", text);
  ok("web/index.html: banner de sesion de X anadido");
})();

// ---------------------------------------------------------------------------
// 5b. web/index.html -- pestana de configuracion global de IA
// ---------------------------------------------------------------------------
(function installAiSettingsUi() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado (config IA)"); return; }

  if (!text.includes(MARK.navAi)) {
    const navAnchor = `<button class="nav-item" data-view="settings">`;
    if (!text.includes(navAnchor)) { fail("web/index.html: no se encontro el nav de settings"); return; }
    const navButton = `        ${MARK.navAi}
        <button class="nav-item" data-view="ai-config">
          <i class="ph ph-brain"></i>
          <span>Configuracion IA</span>
        </button>
`;
    text = replaceOnce(text, navAnchor, `${navButton}${navAnchor}`, "nav config IA");
    ok("web/index.html: pestana Configuracion IA anadida al menu");
  } else {
    skip("web/index.html: pestana Configuracion IA ya presente");
  }

  if (!text.includes(MARK.htmlAi)) {
    const view = `
      ${MARK.htmlAi}
      <section id="view-ai-config" class="view-section">
        <header class="view-header">
          <div>
            <h2>Configuracion de IA</h2>
            <span class="view-subtitle">Guarda aqui tus claves una sola vez. Toda la app las usa en este orden automatico: xKiro (gratis) &rarr; Gemini gratis &rarr; DeepSeek (pago) &rarr; Gemini pago &rarr; OpenRouter.</span>
          </div>
          <span id="aiChainBadge" class="status-badge">Sin proveedores</span>
        </header>

        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">Como funciona</div>
          <p class="form-hint">La app intenta primero xKiro con sus modelos gratuitos. Si falla o se agota, pasa solo al siguiente proveedor. No tienes que hacer nada mas.</p>
          <div id="aiChainList" class="ai-chain-list"></div>
          <label class="toggle-line" style="margin-top:14px;">
            <input id="aiChainEnabled" type="checkbox" checked>
            <span>Usar la cadena automatica en toda la app</span>
          </label>
        </div>

        <div class="settings-grid" id="aiProviderGrid"></div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">Probar una clave</div>
          <p class="form-hint">Hace una llamada real y corta para confirmar que la clave funciona.</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <select id="aiTestProvider" class="control-input" style="max-width:240px;"></select>
            <button id="aiTestBtn" class="control-btn-small primary"><i class="ph ph-plug"></i> Probar</button>
            <span id="aiTestResult" class="form-hint"></span>
          </div>
          <p class="form-hint" id="aiLastTest" style="margin-top:8px;"></p>
        </div>
      </section>

`;
    const anchor = `      <!-- View: Auto Download -->`;
    if (!text.includes(anchor)) { fail("web/index.html: no se encontro el ancla para la vista IA"); return; }
    text = replaceOnce(text, anchor, `${view}${anchor}`, "vista config IA");
    ok("web/index.html: vista de configuracion de IA anadida");
  } else {
    skip("web/index.html: vista de configuracion IA ya presente");
  }

  write("web/index.html", text);
})();

// ---------------------------------------------------------------------------
// 5c. web/index.html -- quitar los campos viejos de IA de X Autopilot
// ---------------------------------------------------------------------------
(function installXAiCleanup() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado (limpieza IA X)"); return; }
  if (text.includes(MARK.xAiClean)) { skip("web/index.html: campos viejos de IA ya retirados"); return; }

  const oldBlock = `            <div class="settings-grid" style="margin-top:16px">
              <div class="form-group"><label>Proveedor IA</label><select id="xAiProvider" class="control-input"><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="deepseek">DeepSeek</option></select></div>
              <div class="form-group"><label>Modelo IA</label><input id="xAiModel" class="control-input" placeholder="gpt-4o-mini"></div>
              <div class="form-group"><label>API key IA</label><input id="xAiKey" class="control-input" type="password" placeholder="Dejar vacio para simulacion"></div>
              <div class="form-group"><label>Token de acceso X</label><input id="xAccessToken" class="control-input" type="password" placeholder="Solo para modo live"></div>
              <div class="form-group"><label>Bearer token X</label><input id="xBearerToken" class="control-input" type="password" placeholder="Para busqueda reciente"></div>
            </div>`;

  const newBlock = `            ${MARK.xAiClean}
            <div class="card" style="margin-top:16px; background:#101317; border:1px solid #242a33;">
              <div class="card-title" style="display:flex; align-items:center; gap:8px; font-size:13px;">
                <i class="ph ph-brain"></i> Modelo de IA
                <span class="tag-ok">automatico</span>
              </div>
              <p class="form-hint" style="margin-bottom:10px;">La IA se elige sola, gratis primero. Se configura una vez en <b>Configuracion IA</b>.</p>
              <div id="xAiChainPreview" class="ai-chain-list"></div>
              <button id="xAiConfigLink" class="control-btn-small" style="margin-top:10px;"><i class="ph ph-gear"></i> Abrir Configuracion IA</button>
            </div>

            <details id="xAdvancedTokens" style="margin-top:14px;">
              <summary style="cursor:pointer; color:var(--text-muted, #8b95a5); font-size:12.5px;">Opciones avanzadas: publicar con la API oficial de X (no necesario)</summary>
              <p class="form-hint" style="margin-top:8px;">Solo si vas a usar la API oficial en vez de tu sesion de X. En el uso normal, dejalo vacio.</p>
              <div class="settings-grid">
                <div class="form-group"><label>Token de acceso X</label><input id="xAccessToken" class="control-input" type="password" placeholder="Solo para la API oficial"></div>
                <div class="form-group"><label>Bearer token X</label><input id="xBearerToken" class="control-input" type="password" placeholder="Para busqueda reciente"></div>
              </div>
            </details>`;

  if (!text.includes(oldBlock)) {
    skip("web/index.html: el bloque viejo ya no existe (quizas parcheado antes)");
    return;
  }
  text = replaceOnce(text, oldBlock, newBlock, "bloque IA viejo de X Autopilot");
  write("web/index.html", text);
  ok("web/index.html: campos viejos de IA retirados; ahora muestra la cadena global");
})();

// ---------------------------------------------------------------------------
// 5d. web/index.html -- pestana de analisis de cuentas de X
// ---------------------------------------------------------------------------
(function installAuditUi() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado (analisis)"); return; }

  if (!text.includes(MARK.auditNav)) {
    const navAnchor = `<button class="nav-item" data-view="x-autopilot">`;
    if (!text.includes(navAnchor)) { fail("web/index.html: no se encontro el nav de x-autopilot"); return; }
    const navButton = `        ${MARK.auditNav}
        <button class="nav-item" data-view="account-analysis">
          <i class="ph ph-magnifying-glass-chart"></i>
          <span>Analisis de cuenta</span>
        </button>
`;
    text = replaceOnce(text, navAnchor, `${navButton}${navAnchor}`, "nav analisis");
    ok("web/index.html: pestana Analisis de cuenta anadida al menu");
  } else {
    skip("web/index.html: pestana Analisis de cuenta ya presente");
  }

  // Actualizacion desde la version 1/2/3: sustituir el bloque por el actual.
  if (text.includes(MARK.auditUi) && (!text.includes("acctLoginBtn") || !text.includes("acct-session.js"))) {
    const startTag = `${MARK.auditUi}`;
    const startIdx = text.indexOf(startTag);
    const sectionStart = text.indexOf("<section", startIdx);
    const sectionEnd = text.indexOf("</section>", sectionStart);
    if (sectionStart !== -1 && sectionEnd !== -1) {
      const endIdx = sectionEnd + "</section>".length;
      text = text.slice(0, startIdx) + text.slice(endIdx);
      ok("web/index.html: bloque antiguo de Analisis de cuenta retirado para actualizarlo");
    } else {
      fail("web/index.html: no se pudo localizar el bloque antiguo de Analisis de cuenta");
    }
  }

  if (!text.includes(MARK.auditUi)) {
    const view = `
      ${MARK.auditUi}
      <section id="view-account-analysis" class="view-section">
        <header class="view-header">
          <div>
            <h2>Analisis de cuenta</h2>
            <span class="view-subtitle">Mete cualquier @ de X y la herramienta estudia su forma de comunicar: temas, tono, sentimiento, estructura y ritmo. Guarda varias cuentas y cambia entre ellas cuando quieras.</span>
          </div>
          <span id="acctAnalysisBadge" class="status-badge">Sin analisis</span>
        </header>

        <div id="acctSessionBanner" class="tt-login-banner card" style="margin-bottom:16px;">
          <div class="tt-login-row">
            <span class="tt-login-icon"><i class="ph ph-x-logo"></i></span>
            <div class="tt-login-text">
              <strong id="acctSessionTitle">Sesion de X</strong>
              <span id="acctSessionMessage">Necesitas iniciar sesion en X aqui mismo para poder leer los posts de una cuenta.</span>
            </div>
            <span id="acctSessionBadge" class="status-badge">Sin sesion</span>
            <button id="acctLoginBtn" class="control-btn-small primary"><i class="ph ph-browser"></i> Iniciar sesion</button>
            <button id="acctLoginSaveBtn" class="control-btn-small success"><i class="ph ph-floppy-disk"></i> Guardar sesion</button>
            <button id="acctLoginCloseBtn" class="control-btn-small danger"><i class="ph ph-x"></i> Cerrar</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px;">
          <div class="card-title">Analizar una cuenta</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px;">
            <input id="acctHandle" class="control-input" style="max-width:260px; text-transform:none;" placeholder="@usuario (ej. levelsio)" />
            <select id="acctMaxPosts" class="control-input" style="max-width:180px;">
              <option value="50">50 publicaciones</option>
              <option value="100">100 publicaciones</option>
              <option value="150" selected>150 publicaciones</option>
              <option value="200">200 publicaciones</option>
              <option value="300">300 publicaciones</option>
            </select>
            <button id="acctStartBtn" class="control-btn-small primary"><i class="ph ph-play"></i> Analizar</button>
            <button id="acctRefreshBtn" class="control-btn-small"><i class="ph ph-arrows-clockwise"></i> Actualizar</button>
          </div>
          <div id="acctProgressBox" style="display:none; margin-top:14px; padding:12px 14px; border-radius:10px; background:#101c2e; border:1px solid #1e3a63;">
            <p id="acctProgress" style="font-size:13.5px; color:#9cc3ff; margin:0;"></p>
          </div>
        </div>

        <div id="acctSessionWarning" class="card" style="display:none; margin-bottom:16px; border-color:#5c4413; background:#1a1408;">
          <p style="font-size:13.5px; color:#ffd98a; margin:0;">
            <b>Antes de analizar necesitas iniciar sesion en X.</b> Usa el boton <b>Iniciar sesion</b> de arriba, entra en tu cuenta en la ventana que se abre y pulsa <b>Guardar sesion</b>.
          </p>
        </div>

        <div class="settings-grid">
          <div class="card">
            <div class="card-title">Cuentas analizadas</div>
            <div id="acctProfileList" class="x-reference-list"></div>
          </div>
          <div class="card">
            <div class="card-title" id="acctDetailTitle">Detalle</div>
            <div id="acctDetailBody"><p class="form-hint">Selecciona una cuenta de la lista para ver su analisis.</p></div>
          </div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">Manual de ADN</div>
          <p class="form-hint">Este documento es el molde que usa la IA para escribir. Se guarda por cuenta.</p>
          <pre id="acctManual" style="white-space:pre-wrap; font-size:12px; line-height:1.5; max-height:420px; overflow:auto; background:#0d1013; border:1px solid #242a33; border-radius:10px; padding:14px; margin-top:10px;">Selecciona una cuenta para ver su manual.</pre>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <button id="acctUseBtn" class="control-btn-small primary"><i class="ph ph-check"></i> Usar esta cuenta como referencia</button>
            <button id="acctDeleteBtn" class="control-btn-small danger"><i class="ph ph-trash"></i> Borrar analisis</button>
          </div>
        </div>
      </section>

`;
    const anchor = `      <!-- View: Auto Download -->`;
    if (!text.includes(anchor)) { fail("web/index.html: no se encontro el ancla para la vista de analisis"); return; }
    text = replaceOnce(text, anchor, `${view}${anchor}`, "vista analisis");
    ok("web/index.html: vista de Analisis de cuenta anadida (con sesion propia)");
  } else {
    skip("web/index.html: vista de analisis ya presente");
  }

  write("web/index.html", text);
})();

// ---------------------------------------------------------------------------
// 5c. web/index.html -- selector de informes guardados (para no reanalizar)
// ---------------------------------------------------------------------------
(function installReportsBar() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado"); return; }
  if (text.includes("ACCTAN-REPORTS-UI-v1") || text.includes("acctReportsBar")) { skip("web/index.html: selector de informes ya presente"); return; }
  const anchor = `<pre id="acctManual"`;
  if (!text.includes(anchor)) { fail("web/index.html: no se encontro el manual de ADN para el selector de informes"); return; }
  const bar = `<!-- MARKER: ACCTAN-REPORTS-UI-v1 -->
          <div id="acctReportsBar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0;">
            <label class="form-hint" for="acctReportSelect" style="margin:0;">Informe guardado:</label>
            <select id="acctReportSelect" class="control-input" style="max-width:340px;" disabled>
              <option value="">— Selecciona una cuenta de la lista —</option>
            </select>
            <button id="acctReportLoad" class="control-btn-small primary" disabled><i class="ph ph-folder-open"></i> Cargar informe</button>
            <button id="acctReportDelete" class="control-btn-small danger" disabled><i class="ph ph-trash"></i> Borrar informe</button>
          </div>
          <p id="acctReportsHint" class="form-hint">Cada analisis se guarda con la fecha y la hora. Elige uno anterior para no repetir el analisis.</p>
          ${anchor}`;
  text = replaceOnce(text, anchor, bar, "selector de informes");
  write("web/index.html", text);
  ok("web/index.html: selector de informes guardados anadido");
})();

// ---------------------------------------------------------------------------
// 5b. web/index.html -- panel de publicacion diaria en la ficha de la cuenta
// ---------------------------------------------------------------------------
(function installPubUi() {
  let text = read("web/index.html");
  if (!text) { fail("web/index.html no encontrado"); return; }
  // Si el panel ya existe (instalacion previa), anade los campos que falten.
  if (text.includes(MARK.pubUi)) {
    if (text.includes("acctPubLang") && text.includes("acctPubJitter") && text.includes("acctPubStop") && text.includes("acctPubMinGap")) {
      skip("web/index.html: panel de publicacion diaria ya presente"); return;
    }
    let changed = false;
    if (!text.includes("acctPubStop")) {
      const toggleAnchor = `<button id="acctPubToggle" class="control-btn-small success"><i class="ph ph-power"></i> Activar publicacion diaria</button>`;
      if (text.includes(toggleAnchor)) {
        text = replaceOnce(text, toggleAnchor, `${toggleAnchor}
            <button id="acctPubStop" class="control-btn-small danger"><i class="ph ph-stop-circle"></i> Parar publicacion diaria</button>`, "boton parar");
        changed = true;
      }
    }
    if (!text.includes("acctPubJitter")) {
      const spreadAnchor = `<span class="form-hint">Minutos entre tuits</span>`;
      if (text.includes(spreadAnchor)) {
        // Sustituye el bloque existente del spread por spread+jitter.
        const oldBlock = `<span class="form-hint">Minutos entre tuits</span>
              <input id="acctPubSpread" class="control-input" type="number" min="5" max="1440" value="240" style="max-width:150px;" />
            </label>`;
        if (text.includes(oldBlock)) {
          const newBlock = `<span class="form-hint">Minutos entre tuits</span>
              <input id="acctPubSpread" class="control-input" type="number" min="5" max="1440" value="220" style="max-width:150px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Variacion (min, hasta +/-)</span>
              <input id="acctPubJitter" class="control-input" type="number" min="0" max="120" value="30" style="max-width:170px;" />
            </label>`;
          text = replaceOnce(text, oldBlock, newBlock, "campo de variacion");
          changed = true;
        }
      }
    }
    if (!text.includes("acctPubLang")) {
      const maxAnchor = `<span class="form-hint">Maximo de caracteres</span>`;
      if (text.includes(maxAnchor)) {
        const langField = `<label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Idioma de los posts</span>
              <select id="acctPubLang" class="control-input" style="max-width:150px;">
                <option value="en">Ingles</option>
                <option value="es">Espanol</option>
              </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              ${maxAnchor}`;
        text = replaceOnce(text, `<label style="display:flex; flex-direction:column; gap:4px;">
              ${maxAnchor}`, langField, "selector de idioma");
        changed = true;
      }
    }
    if (!text.includes("acctPubMinGap")) {
      const jitterAnchor = `<input id="acctPubJitter" class="control-input" type="number" min="0" max="120" value="30" style="max-width:170px;" />
            </label>`;
      if (text.includes(jitterAnchor)) {
        text = replaceOnce(text, jitterAnchor, `${jitterAnchor}
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Minimo entre posts (min)</span>
              <input id="acctPubMinGap" class="control-input" type="number" min="5" max="1440" value="45" style="max-width:170px;" />
            </label>`, "campo de separacion minima");
        changed = true;
      }
    }
    if (changed) { write("web/index.html", text); ok("web/index.html: campos de idioma/variacion/separacion anadidos al panel"); }
    else { skip("web/index.html: panel de publicacion diaria ya presente"); }
    return;
  }
  const anchor = `            <button id="acctDeleteBtn" class="control-btn-small danger"><i class="ph ph-trash"></i> Borrar analisis</button>
          </div>
        </div>`;
  if (!text.includes(anchor)) { fail("web/index.html: no se encontro el ancla del panel de publicacion"); return; }
  const panel = `${anchor}

        <div class="card" id="acctPubCard" style="margin-top:16px;">
          ${MARK.pubUi}
          <div class="card-title"><i class="ph ph-calendar-check"></i> Publicacion diaria con este perfil</div>
          <p class="form-hint">La IA escribira cada dia imitando el estilo de la cuenta seleccionada y publicara en <b>la cuenta de X con la que estas logueado</b>. Elige cuantos tuits, en que idioma y sobre que temas. Los tuits salen <b>espaciados</b> segun los minutos indicados, uno por franja horaria.</p>
          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-top:12px;">
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Tuits diarios</span>
              <input id="acctPubCount" class="control-input" type="number" min="1" max="20" value="3" style="max-width:110px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Primer tuit</span>
              <input id="acctPubStart" class="control-input" type="time" value="09:00" style="max-width:130px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Minutos entre tuits</span>
              <input id="acctPubSpread" class="control-input" type="number" min="5" max="1440" value="220" style="max-width:150px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Variacion (min, hasta +/-)</span>
              <input id="acctPubJitter" class="control-input" type="number" min="0" max="120" value="30" style="max-width:170px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Idioma de los posts</span>
              <select id="acctPubLang" class="control-input" style="max-width:150px;">
                <option value="en">Ingles</option>
                <option value="es">Espanol</option>
              </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Minimo entre posts (min)</span>
              <input id="acctPubMinGap" class="control-input" type="number" min="5" max="1440" value="45" style="max-width:170px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Maximo de caracteres</span>
              <input id="acctPubMax" class="control-input" type="number" min="80" max="4000" value="280" style="max-width:150px;" />
            </label>
          </div>
          <label style="display:flex; flex-direction:column; gap:4px; margin-top:12px;">
            <span class="form-hint">Temas de la cuenta (uno por linea o separados por comas). La IA rotara entre ellos; si lo dejas vacio, escribira del estilo general.</span>
            <textarea id="acctPubTopics" class="control-input" rows="3" style="width:100%; resize:vertical;" placeholder="productividad, IA aplicada, errores de fundador..."></textarea>
          </label>
          <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; align-items:center;">
            <button id="acctPubSave" class="control-btn-small primary"><i class="ph ph-floppy-disk"></i> Guardar ajustes</button>
            <button id="acctPubToggle" class="control-btn-small success"><i class="ph ph-power"></i> Activar publicacion diaria</button>
            <button id="acctPubStop" class="control-btn-small danger"><i class="ph ph-stop-circle"></i> Parar publicacion diaria</button>
            <button id="acctPubNow" class="control-btn-small"><i class="ph ph-paper-plane-tilt"></i> Publicar uno ahora</button>
            <button id="acctPubPreview" class="control-btn-small"><i class="ph ph-eye"></i> Generar sin publicar</button>
            <span id="acctPubBadge" class="status-badge">Sin configurar</span>
          </div>
          <div id="acctPubBox" style="display:none; margin-top:12px; padding:12px 14px; border-radius:10px; background:#101c2e; border:1px solid #1e3a63;">
            <p id="acctPubMsg" style="font-size:13.5px; color:#9cc3ff; margin:0;"></p>
          </div>
          <div id="acctPubHistory" style="margin-top:14px;"></div>
          <details style="margin-top:10px;">
            <summary class="form-hint" style="cursor:pointer;">Ver ultimos posts generados</summary>
            <div id="acctPubFeed" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;"></div>
          </details>
        </div>`;
  text = replaceOnce(text, anchor, panel, "panel de publicacion diaria");
  write("web/index.html", text);
  ok("web/index.html: panel de publicacion diaria anadido");
})();

// ---------------------------------------------------------------------------
// 6. web/app.js -- elementos, binding, render y handlers
// ---------------------------------------------------------------------------
(function installAppJs() {
  let text = read("web/app.js");
  if (!text) { fail("web/app.js no encontrado"); return; }

  if (!text.includes(MARK.jsBind)) {
    const anchor = "xReferencesList: document.getElementById(\"xReferencesList\")";
    if (!text.includes(anchor)) { fail("web/app.js: no se encontro xReferencesList en els"); write("web/app.js", text); return; }
    const addition = `${anchor},\n    xLoginBanner: document.getElementById("xLoginBanner"), xLoginTitle: document.getElementById("xLoginTitle"), xLoginMessage: document.getElementById("xLoginMessage"), xLoginStateBadge: document.getElementById("xLoginStateBadge"), xLoginBtn: document.getElementById("xLoginBtn"), xLoginSaveBtn: document.getElementById("xLoginSaveBtn"), xLoginCloseBtn: document.getElementById("xLoginCloseBtn"), xCookiesInput: document.getElementById("xCookiesInput"), xCookiesBtn: document.getElementById("xCookiesBtn"), xRetryBtn: document.getElementById("xRetryBtn"),\n    ${MARK.jsBind}`;
    text = replaceOnce(text, anchor, addition, "els de x login");
    ok("web/app.js: elementos de X registrados");
  } else {
    skip("web/app.js: elementos de X ya registrados");
  }

  if (!text.includes(MARK.jsHandlers)) {
    const bindAnchor = 'if (this.els.xReferenceBtn) this.els.xReferenceBtn.addEventListener("click", () => this.addXReference());';
    const binding = `${MARK.jsHandlers}\n    if (this.els.xLoginBtn) this.els.xLoginBtn.addEventListener("click", () => this.xLoginOpen());\n    if (this.els.xLoginSaveBtn) this.els.xLoginSaveBtn.addEventListener("click", () => this.xLoginSave());\n    if (this.els.xLoginCloseBtn) this.els.xLoginCloseBtn.addEventListener("click", () => this.xLoginClose());\n    if (this.els.xCookiesBtn) this.els.xCookiesBtn.addEventListener("click", () => this.xImportCookies());\n    if (this.els.xRetryBtn) this.els.xRetryBtn.addEventListener("click", () => this.xRetryFailed());\n    if (this.els.xReferenceBtn) this.els.xReferenceBtn.addEventListener("click", () => this.addXReference());`;
    text = replaceOnce(text, bindAnchor, binding, "bind de x login");
    ok("web/app.js: botones de sesion de X enlazados");
  } else {
    skip("web/app.js: botones de X ya enlazados");
  }

  if (!text.includes(MARK.jsRender)) {
    const renderAnchor = "  async refresh() {";
    const renderCall = `  ${MARK.jsRender}\n  async refreshXSession() {\n    try {\n      const data = await API.get("/api/x-autopilot/session");\n      this.renderXSession(data);\n    } catch (error) {\n      if (this.els.xLoginStateBadge) this.els.xLoginStateBadge.textContent = "Sin sesion";\n    }\n  },\n\n  renderXSession(data) {\n    if (!this.els.xLoginStateBadge) return;\n    const session = data?.session || {};\n    const ready = Boolean(session.saved);\n    this.els.xLoginStateBadge.textContent = ready ? "Sesion guardada" : (session.open ? "Ventana abierta" : "Sin sesion");\n    this.els.xLoginStateBadge.className = "status-badge" + (ready ? " success" : "");\n    if (this.els.xLoginMessage) {\n      this.els.xLoginMessage.textContent = ready\n        ? "Sesion de X lista. La publicacion automatica usara esta cuenta."\n        : "Aun no hay sesion guardada. Inicia sesion en la ventana de X o pega tus cookies.";\n    }\n    const worker = data?.worker ? "worker activo" : "worker detenido";\n    if (this.els.xLoginTitle) this.els.xLoginTitle.textContent = "Sesion de X (Twitter) - " + worker;\n  },\n\n  async xLoginOpen() { try { const r = await API.post("/api/x-autopilot/login", {}); if (r && r.ok === false) throw new Error(r.error || "No se pudo abrir la ventana."); await this.refreshXSession(); } catch (error) { alert("Error al abrir la ventana de X: " + error.message); } },\n  async xLoginSave() { try { const r = await API.post("/api/x-autopilot/login/save", {}); if (r && r.ok === false) throw new Error(r.error); await this.refreshXSession(); } catch (error) { alert(error.message); } },\n  async xLoginClose() { try { await API.post("/api/x-autopilot/login/close", {}); await this.refreshXSession(); } catch (error) { alert(error.message); } },\n  async xImportCookies() {\n    const value = this.els.xCookiesInput?.value || "";\n    if (!value.trim()) { alert("Pega tus cookies primero."); return; }\n    try {\n      const r = await API.post("/api/x-autopilot/cookies", { cookies: value });\n      if (r && r.ok === false) throw new Error(r.error);\n      if (this.els.xCookiesInput) this.els.xCookiesInput.value = "";\n      await this.refreshXSession();\n    } catch (error) { alert(error.message); }\n  },\n  async xRetryFailed() { try { await API.post("/api/x-autopilot/retry", {}); await this.refreshXAutopilot(); } catch (error) { alert(error.message); } },\n\n  async refreshXAutopilot() { try { const data = await API.get("/api/x-autopilot"); this.renderXAutopilot(data); } catch {} },\n\n${renderAnchor}`;
    text = replaceOnce(text, renderAnchor, renderCall, "refresh");
    ok("web/app.js: handlers de sesion de X anadidos");
  } else {
    skip("web/app.js: handlers de X ya presentes");
  }

  // Enlazar la llamada al refresco.
  if (!text.includes("this.refreshXSession()")) {
    const hook = 'API.get("/api/x-autopilot").then((data) => this.renderXAutopilot(data)).catch(() => { });';
    const withHook = `${hook}\n      this.refreshXSession();`;
    text = replaceOnce(text, hook, withHook, "hook de refresco de sesion");
    ok("web/app.js: refresco de sesion enlazado");
  }

  write("web/app.js", text);
})();

// ---------------------------------------------------------------------------
// 7. web/app.js -- logica de la configuracion global de IA
// ---------------------------------------------------------------------------
(function installAiConfigJs() {
  let text = read("web/app.js");
  if (!text) { fail("web/app.js no encontrado (config IA)"); return; }

  if (text.includes(MARK.jsAiLogic)) { skip("web/app.js: logica de config IA ya presente"); return; }

  const logic = `  ${MARK.jsAiLogic}
  aiConfig: null,

  async loadAiConfig() {
    try {
      this.aiConfig = await API.get("/api/ai-config");
      this.renderAiConfig(this.aiConfig);
      return this.aiConfig;
    } catch (error) {
      if (this.els.aiChainBadge) this.els.aiChainBadge.textContent = "Error: " + error.message;
      return null;
    }
  },

  renderAiConfig(data) {
    if (!data) return;
    const chain = data.chain || [];
    if (this.els.aiChainBadge) {
      this.els.aiChainBadge.textContent = chain.length
        ? chain.length + " modelos listos"
        : "Sin proveedores";
      this.els.aiChainBadge.className = "status-badge" + (chain.length ? " success" : "");
    }
    if (this.els.aiChainEnabled) this.els.aiChainEnabled.checked = data.enabled !== false;

    if (this.els.aiChainList) {
      const steps = [];
      const seen = new Set();
      for (const item of chain) {
        if (seen.has(item.provider)) continue;
        seen.add(item.provider);
        steps.push(\`<span class="ai-chain-step \${item.free ? "free" : ""}">\${escapeHtml(item.label)}\${item.free ? " · gratis" : ""}</span>\`);
      }
      this.els.aiChainList.innerHTML = steps.length
        ? steps.join('<span class="ai-chain-arrow">→</span>')
        : '<span class="form-hint">Aun no hay ninguna clave guardada. Empieza por xKiro, que es gratis.</span>';
    }

    if (this.els.aiProviderGrid) {
      this.els.aiProviderGrid.innerHTML = (data.providers || []).map((provider) => {
        const status = data.providerKeys?.[provider.id] || {};
        const modelList = (provider.models || []).map((m) => \`<option value="\${escapeHtml(m.id)}">\${escapeHtml(m.label || m.id)}</option>\`).join("");
        return \`
          <div class="card">
            <div class="card-title" style="display:flex; align-items:center; gap:8px;">
              \${escapeHtml(provider.label)}
              \${provider.free ? '<span class="tag-free">gratis</span>' : ""}
              \${status.configured ? '<span class="tag-ok">lista</span>' : ""}
            </div>
            <p class="form-hint">\${escapeHtml(provider.keyHint || "")}</p>
            <div class="helios-key-row">
              <input id="aiKey_\${provider.id}" class="control-input" type="password"
                placeholder="\${status.configured ? escapeHtml(status.masked) : "Pega tu clave"}" />
              <button class="control-btn-small primary" data-ai-save="\${provider.id}">Guardar</button>
              <button class="control-btn-small danger" data-ai-remove="\${provider.id}">Quitar</button>
            </div>
            <div class="helios-key-row" style="margin-top:8px;">
              <select class="control-input" id="aiModel_\${provider.id}">\${modelList}</select>
            </div>
          </div>\`;
      }).join("");

      this.els.aiProviderGrid.querySelectorAll("[data-ai-save]").forEach((button) => {
        button.addEventListener("click", () => this.saveAiKey(button.dataset.aiSave));
      });
      this.els.aiProviderGrid.querySelectorAll("[data-ai-remove]").forEach((button) => {
        button.addEventListener("click", () => this.removeAiKey(button.dataset.aiRemove));
      });
    }

    if (this.els.aiTestProvider) {
      this.els.aiTestProvider.innerHTML = (data.providers || [])
        .map((p) => \`<option value="\${escapeHtml(p.id)}">\${escapeHtml(p.label)}</option>\`)
        .join("");
    }
    if (this.els.aiLastTest) {
      const last = data.lastTest;
      this.els.aiLastTest.textContent = last
        ? \`Ultima prueba: \${last.provider}/\${last.model} · \${last.ms}ms · "\${String(last.sample || "").slice(0, 40)}"\`
        : "Aun no has probado ninguna clave.";
    }
  },

  async saveAiKey(providerId) {
    const input = document.getElementById("aiKey_" + providerId);
    const value = input?.value.trim() || "";
    if (!value) { alert("Pega la clave primero."); return; }
    try {
      await API.post("/api/ai-config", { providerKeys: { [providerId]: value } });
      input.value = "";
      await this.loadAiConfig();
    } catch (error) { alert(error.message); }
  },

  async removeAiKey(providerId) {
    try {
      await API.post("/api/ai-config", { removeProviders: [providerId] });
      await this.loadAiConfig();
    } catch (error) { alert(error.message); }
  },

  async testAiProvider() {
    const provider = this.els.aiTestProvider?.value;
    if (!provider) return;
    if (this.els.aiTestResult) this.els.aiTestResult.textContent = "Probando...";
    try {
      const data = await API.post("/api/ai-config/test", { provider });
      const last = data.lastTest || {};
      if (this.els.aiTestResult) this.els.aiTestResult.textContent = \`OK · \${last.model} · \${last.ms}ms\`;
      this.renderAiConfig(data);
    } catch (error) {
      if (this.els.aiTestResult) this.els.aiTestResult.textContent = "Fallo: " + error.message;
    }
  },

  async toggleAiChain(enabled) {
    try {
      const data = await API.post("/api/ai-config", { enabled: Boolean(enabled) });
      this.renderAiConfig(data);
    } catch (error) { alert(error.message); }
  },

  renderXAiChain(data) {
    const chain = data?.ai?.chain || [];
    const box = document.getElementById("xAiChainPreview");
    if (!box) return;
    if (!chain.length) {
      box.innerHTML = '<span class="form-hint">Aun no hay ninguna clave de IA guardada. Abre Configuracion IA y guarda la de xKiro (es gratis).</span>';
      return;
    }
    const steps = [];
    const seen = new Set();
    for (const item of chain) {
      if (seen.has(item.provider)) continue;
      seen.add(item.provider);
      steps.push(\`<span class="ai-chain-step \${item.free ? "free" : ""}">\${escapeHtml(item.label)}\${item.free ? " · gratis" : ""}</span>\`);
    }
    box.innerHTML = steps.join('<span class="ai-chain-arrow">→</span>');
  },

`;

  const anchor = "  async refresh() {";
  text = replaceOnce(text, anchor, `${logic}${anchor}`, "logica config IA");

  // Register the new elements.
  const elsAnchor = 'xLoginBanner: document.getElementById("xLoginBanner")';
  if (text.includes(elsAnchor) && !text.includes("aiChainBadge:")) {
    const elsAddition = `aiChainBadge: document.getElementById("aiChainBadge"), aiChainList: document.getElementById("aiChainList"), aiChainEnabled: document.getElementById("aiChainEnabled"), aiProviderGrid: document.getElementById("aiProviderGrid"), aiTestProvider: document.getElementById("aiTestProvider"), aiTestBtn: document.getElementById("aiTestBtn"), aiTestResult: document.getElementById("aiTestResult"), aiLastTest: document.getElementById("aiLastTest"), xAiChainPreview: document.getElementById("xAiChainPreview"), xAiConfigLink: document.getElementById("xAiConfigLink"),\n    ${elsAnchor}`;
    text = replaceOnce(text, elsAnchor, elsAddition, "els config IA");
  }

  // Bind events.
  const bindAnchor = 'if (this.els.xRetryBtn) this.els.xRetryBtn.addEventListener("click", () => this.xRetryFailed());';
  if (text.includes(bindAnchor) && !text.includes("this.els.aiTestBtn")) {
    const bindAddition = `${bindAnchor}\n    if (this.els.aiTestBtn) this.els.aiTestBtn.addEventListener("click", () => this.testAiProvider());\n    if (this.els.aiChainEnabled) this.els.aiChainEnabled.addEventListener("change", () => this.toggleAiChain(this.els.aiChainEnabled.checked));\n    if (this.els.xAiConfigLink) this.els.xAiConfigLink.addEventListener("click", () => Router.navigate("ai-config"));`;
    text = replaceOnce(text, bindAnchor, bindAddition, "bind config IA");
  }

  // Load on refresh.
  const refreshHook = 'API.get("/api/x-autopilot").then((data) => this.renderXAutopilot(data)).catch(() => { });';
  if (text.includes(refreshHook) && !text.includes("this.loadAiConfig();\n      this.refreshAcctSession();")) {
    text = replaceOnce(text, refreshHook, `${refreshHook}\n      this.loadAiConfig();\n      this.loadAccountAnalysis();\n      this.refreshAcctSession();`, "hook config IA + analisis");
    ok("web/app.js: config IA y analisis cargados al refrescar");
  } else {
    skip("web/app.js: hooks de refresco ya presentes");
  }

  // ---- Quitar las referencias a los campos viejos de IA en X Autopilot ----
  if (!text.includes(MARK.xAiJs)) {
    // 1) renderXAutopilot ya no debe escribir provider/model.
    const renderOld = `setValue(this.els.xAiProvider, config.ai?.provider, "xAiProvider"); setValue(this.els.xAiModel, config.ai?.model, "xAiModel");`;
    if (text.includes(renderOld)) {
      text = replaceOnce(text, renderOld, `${MARK.xAiJs}\n    this.renderXAiChain(data);`, "render de IA viejo");
    } else {
      const renderOld2 = `setValue(this.els.xAiProvider, config.ai?.provider, "xAiProvider");`;
      if (text.includes(renderOld2)) {
        text = replaceOnce(text, renderOld2, `${MARK.xAiJs}\n    this.renderXAiChain(data);`, "render de IA viejo (simple)");
      }
    }

    // 2) saveXConfig no debe enviar provider/model/apiKey ni tokens.
    const saveOld = `const key = this.els.xAiKey?.value || (current.config?.ai?.apiKey === "configured" ? undefined : "");`;
    if (text.includes(saveOld)) {
      const saveNew = `const key = undefined; // la IA se configura en Configuracion IA`;
      text = replaceOnce(text, saveOld, saveNew, "saveXConfig apiKey");
    }
    const providerOld = `const provider = this.els.xAiProvider?.value || "openai";`;
    if (text.includes(providerOld)) {
      text = replaceOnce(text, providerOld, `const provider = "auto"; // cadena global`, "saveXConfig provider");
    }
    const modelOld = `const defaultModels = { openai: "gpt-4o-mini", gemini: "gemini-3.6-flash", deepseek: "deepseek-chat" };`;
    if (text.includes(modelOld)) {
      text = replaceOnce(text, modelOld, `const defaultModels = {}; // la cadena global elige el modelo`, "saveXConfig defaultModels");
    }
    const urlsOld = `const defaultUrls = { openai: "https://api.openai.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta", deepseek: "https://api.deepseek.com/v1" };`;
    if (text.includes(urlsOld)) {
      text = replaceOnce(text, urlsOld, `const defaultUrls = {}; // la cadena global elige el proveedor`, "saveXConfig defaultUrls");
    }

    // 3) El payload ya no debe leer el input de modelo.
    const payloadOld = `ai: { provider, baseUrl: defaultUrls[provider], model: this.els.xAiModel?.value || defaultModels[provider], ...(key !== undefined ? { apiKey: key } : {}) },`;
    if (text.includes(payloadOld)) {
      text = replaceOnce(text, payloadOld, `ai: { provider: "auto", model: "auto", useGlobalChain: true },`, "saveXConfig payload ai");
    }

    // 4) Los elementos viejos ya no existen en el HTML: quitar del registro y del dirty-tracking.
    const elsOld = `xMasterPrompt: document.getElementById("xMasterPrompt"), xAiProvider: document.getElementById("xAiProvider"), xAiModel: document.getElementById("xAiModel"),\n    xAiKey: document.getElementById("xAiKey"), xAccessToken: document.getElementById("xAccessToken"), xBearerToken: document.getElementById("xBearerToken"), xEnabled: document.getElementById("xEnabled"),`;
    if (text.includes(elsOld)) {
      text = replaceOnce(text, elsOld, `xMasterPrompt: document.getElementById("xMasterPrompt"), xAccessToken: document.getElementById("xAccessToken"), xBearerToken: document.getElementById("xBearerToken"), xEnabled: document.getElementById("xEnabled"),`, "els viejos");
    }
    const trackOld = `"xMasterPrompt", "xAiProvider", "xAiModel", "xEnabled"`;
    if (text.includes(trackOld)) {
      text = replaceOnce(text, trackOld, `"xMasterPrompt", "xEnabled"`, "dirty tracking");
    }

    ok("web/app.js: referencia a los campos viejos de IA retirada");
  } else {
    skip("web/app.js: limpieza de campos viejos ya aplicada");
  }

  write("web/app.js", text);
})();

// ---------------------------------------------------------------------------
// 8. web/style.css -- estilos de la cadena de IA
// ---------------------------------------------------------------------------
(function installAiStyles() {
  const rel = "web/style.css";
  let text = read(rel);
  if (!text) { skip("web/style.css no encontrado; la pestana usara estilos por defecto"); return; }
  if (text.includes(MARK.cssAi)) { skip("web/style.css ya tiene los estilos de IA"); return; }
  text += `
${MARK.cssAi}
.ai-chain-list { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.ai-chain-step { font-size: 12.5px; padding: 6px 12px; border-radius: 999px; background: #1a1e24; border: 1px solid #2c323c; color: #cdd6e2; }
.ai-chain-step.free { background: #0f2b1e; border-color: #1d4a35; color: #4ade80; }
.ai-chain-arrow { color: #6b7686; font-size: 14px; }
.tag-free { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: #0f2b1e; color: #4ade80; letter-spacing: .3px; }
.tag-ok { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: #101c2e; color: #9cc3ff; letter-spacing: .3px; }
`;
  write(rel, text);
  ok("web/style.css: estilos de la cadena de IA anadidos");
})();

// ---------------------------------------------------------------------------
// 9. src/autoclone/controller.js -- heredar las claves de la config global
// ---------------------------------------------------------------------------
(function installAutocloneBridge() {
  let text = read("src/autoclone/controller.js");
  if (!text) { skip("src/autoclone/controller.js no encontrado; se omite el puente de claves"); return; }
  if (text.includes(MARK.autoclone)) { skip("autoclone/controller.js ya usa la config global de IA"); return; }

  const marker = `${MARK.autoclone}\n    try {`;
  const anchor = "    return {\n      // Free key (gemini-2.5-flash) is used first; the paid key only kicks in";
  if (!text.includes(anchor)) { skip("autoclone/controller.js: no se encontro el bloque de claves; se omite"); return; }
  // El puente usa await: asegurate de que el metodo sea async.
  if (text.includes("  _aiSettings() {")) {
    text = replaceOnce(text, "  _aiSettings() {", "  async _aiSettings() {", "async _aiSettings");
  }
  const bridge = `${marker}
      const globalAi = require("../ai-config");
      await globalAi.load();
      const globalKeys = globalAi.publicConfig().providerKeys || {};
      const hasGlobal = Object.values(globalKeys).some((entry) => entry && entry.configured);
      if (hasGlobal) {
        const pick = (id) => (globalKeys[id] && globalKeys[id].configured ? globalAi.keyFor(id) : "");
        return {
          apiKey: pick("gemini-free"),
          paidApiKey: pick("gemini-paid"),
          paidModel: "gemini-3.6-flash",
          openRouterKey: pick("openrouter"),
          deepSeekKey: pick("deepseek"),
          xKiroKey: pick("xkiro"),
          model: "gemini-3.6-flash",
          visionModel: "gemini-3.6-flash",
          fromGlobalConfig: true,
        };
      }
    } catch { /* sin config global: usa las claves de siempre */ }

    return {
      // Free key (gemini-2.5-flash) is used first; the paid key only kicks in`;
  text = replaceOnce(text, anchor, bridge, "puente config global en autoclone");
  write("src/autoclone/controller.js", text);
  ok("autoclone/controller.js: ahora usa la configuracion global de IA");
})();

// ---------------------------------------------------------------------------
// 7b. web/app.js -- logica del analisis de cuentas
// ---------------------------------------------------------------------------
(function installAuditJs() {
  let text = read("web/app.js");
  if (!text) { fail("web/app.js no encontrado (analisis)"); return; }

  // Actualizacion desde la version 1: el marcador existe pero sin la sesion propia.
  if (text.includes(MARK.auditJs) && !text.includes("acctLoginOpen()")) {
    const startIdx = text.indexOf(MARK.auditJs);
    const endMark = "  async refresh() {";
    const endIdx = text.indexOf(endMark, startIdx);
    if (endIdx !== -1) {
      text = text.slice(0, startIdx) + text.slice(endIdx);
      ok("web/app.js: bloque antiguo de Analisis de cuenta retirado para actualizarlo");
    } else {
      fail("web/app.js: no se pudo localizar el bloque antiguo de Analisis de cuenta");
    }
  }

  if (text.includes(MARK.auditJs)) { skip("web/app.js: logica de analisis ya presente"); return; }

  const logic = `  ${MARK.auditJs}
  acctProfiles: [],
  acctSelected: null,
  acctPoll: null,
  acctSession: { saved: false, open: false },

  async refreshAcctSession() {
    // Si el enlace autonomo de la vista ya gestiona la sesion, no duplicamos.
    if (typeof window !== "undefined" && window.__acctSessionOwned) {
      this.acctSession = this.acctSession || { saved: false, open: false };
      if (typeof window.__acctSessionRefresh === "function") window.__acctSessionRefresh();
      return this.acctSession;
    }
    try {
      const data = await API.get("/api/x-autopilot/session");
      this.acctSession = (data && data.session) || { saved: false, open: false };
    } catch (error) {
      this.acctSession = { saved: false, open: false };
      this.renderAcctSession();
      this.setAcctProgress("No se pudo comprobar la sesion: " + (error.message || "error desconocido"), true);
      return this.acctSession;
    }
    this.renderAcctSession();
    return this.acctSession;
  },

  renderAcctSession() {
    const s = this.acctSession || {};
    const saved = Boolean(s.saved);
    if (this.els.acctSessionBadge) {
      this.els.acctSessionBadge.textContent = saved ? "Sesion guardada" : (s.open ? "Ventana abierta" : "Sin sesion");
      this.els.acctSessionBadge.className = "status-badge" + (saved ? " success" : "");
    }
    if (this.els.acctSessionMessage) {
      this.els.acctSessionMessage.textContent = saved
        ? "Sesion de X lista. Ya puedes analizar cualquier cuenta."
        : "Necesitas iniciar sesion en X aqui mismo para poder leer los posts de una cuenta.";
    }
    if (this.els.acctStartBtn) {
      this.els.acctStartBtn.disabled = !saved;
      this.els.acctStartBtn.style.opacity = saved ? "1" : "0.5";
      this.els.acctStartBtn.style.cursor = saved ? "pointer" : "not-allowed";
      this.els.acctStartBtn.title = saved ? "Analizar la cuenta" : "Primero inicia sesion en X";
    }
    if (this.els.acctSessionWarning) {
      this.els.acctSessionWarning.style.display = saved ? "none" : "block";
    }
  },

  async acctLoginOpen() {
    this.setAcctProgress("Abriendo la ventana de X... (puede tardar unos segundos)");
    try {
      const r = await API.post("/api/x-autopilot/login", {});
      if (r && r.ok === false) throw new Error(r.error || "No se pudo abrir la ventana.");
      await this.refreshAcctSession();
      this.setAcctProgress("Ventana de X abierta. Inicia sesion en ella y luego pulsa Guardar sesion.");
    } catch (error) { this.setAcctProgress("Error al abrir X: " + error.message, true); }
  },

  async acctLoginSave() {
    try {
      const r = await API.post("/api/x-autopilot/login/save", {});
      if (r && r.ok === false) throw new Error(r.error);
      await this.refreshAcctSession();
      this.setAcctProgress("Sesion guardada. Ya puedes analizar una cuenta.");
    } catch (error) { this.setAcctProgress("Error: " + error.message, true); }
  },

  async acctLoginClose() {
    try {
      await API.post("/api/x-autopilot/login/close", {});
      await this.refreshAcctSession();
    } catch (error) { alert(error.message); }
  },

  async loadAccountAnalysis() {
    try {
      const data = await API.get("/api/account-analysis");
      this.acctProfiles = data.profiles || [];
      this.renderAccountProfiles();
      if (data.job && data.job.running) this.startAcctPolling();
      else if (data.job && data.job.error) this.setAcctProgress("Error: " + data.job.error, true);
      return data;
    } catch (error) {
      if (this.els.acctAnalysisBadge) this.els.acctAnalysisBadge.textContent = "Error";
      return null;
    }
  },

  renderAccountProfiles() {
    const list = this.els.acctProfileList;
    if (!list) return;
    if (this.els.acctAnalysisBadge) {
      this.els.acctAnalysisBadge.textContent = this.acctProfiles.length
        ? this.acctProfiles.length + " cuenta(s)"
        : "Sin analisis";
      this.els.acctAnalysisBadge.className = "status-badge" + (this.acctProfiles.length ? " success" : "");
    }
    if (!this.acctProfiles.length) {
      list.innerHTML = '<div class="setup-empty">Todavia no has analizado ninguna cuenta.</div>';
      return;
    }
    list.innerHTML = this.acctProfiles.map((p) => \`
      <div class="x-reference-item" style="cursor:pointer;" data-acct="\${escapeHtml(p.handle)}">
        <strong>@\${escapeHtml(p.handle)}</strong>
        <span>\${p.posts} publicaciones · \${p.originals} propias · \${p.replies} respuestas</span>
        <span class="form-hint">\${escapeHtml((p.topTopics || []).join(" · "))}</span>
      </div>\`).join("");
    list.querySelectorAll("[data-acct]").forEach((node) => {
      node.addEventListener("click", () => this.openAccountProfile(node.dataset.acct));
    });
  },

  async openAccountProfile(handle) {
    try {
      const data = await API.get("/api/account-analysis/" + encodeURIComponent(handle));
      this.acctSelected = data.data;
      this.renderAccountDetail();
    } catch (error) { alert(error.message); }
  },

  renderAccountDetail() {
    const data = this.acctSelected;
    if (!data) return;
    const a = data.analysis || {};
    const f = a.format || {};
    if (this.els.acctDetailTitle) this.els.acctDetailTitle.textContent = "@" + data.handle;
    if (this.els.acctDetailBody) {
      const topics = (a.topics || []).slice(0, 5).map((t) => \`<span class="ai-chain-step">\${escapeHtml(t.topic)} · \${t.count}</span>\`).join("");
      const hints = (a.keywords || []).slice(0, 20).map((k) => k.word).join(", ");
      this.els.acctDetailBody.innerHTML = \`
        <div class="ai-chain-list" style="margin-bottom:12px;">\${topics || '<span class="form-hint">Sin temas detectados.</span>'}</div>
        <p class="form-hint"><b>\${f.total || 0}</b> publicaciones · <b>\${f.originalPosts || 0}</b> propias · <b>\${f.replies || 0}</b> respuestas</p>
        <p class="form-hint">Longitud media: <b>\${f.avgLength || 0}</b> caracteres · Emojis: \${f.emojiRatio ?? 0} · Imagen en \${f.withImage || 0}</p>
        <p class="form-hint">Sentimiento: <b>\${escapeHtml(a.sentiment?.label || "?")}</b> (\${a.sentiment?.score ?? 0})</p>
        <p class="form-hint">Ritmo: <b>\${a.rhythm?.postsPerDay ?? 0}</b> publicaciones/dia durante \${a.rhythm?.spanDays ?? 0} dias</p>
        <p class="form-hint" style="margin-top:8px;">Palabras clave: \${escapeHtml(hints)}</p>\`;
    }
    if (this.els.acctManual) this.els.acctManual.textContent = data.manual || "Sin manual generado.";
    if (this.els.acctUseBtn) this.els.acctUseBtn.dataset.handle = data.handle;
  },

  async startAccountAnalysis() {
    const handle = (this.els.acctHandle?.value || "").trim();
    if (!handle) { this.setAcctProgress("Escribe un @ de X primero.", true); return; }
    if (!this.acctSession?.saved) {
      this.setAcctProgress("No puedes analizar todavia: primero inicia sesion en X (boton de arriba).", true);
      if (this.els.acctSessionWarning) this.els.acctSessionWarning.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const maxPosts = Number(this.els.acctMaxPosts?.value) || 150;
    try {
      this.setAcctProgress("Iniciando analisis de " + handle + "...");
      await API.post("/api/account-analysis/start", { handle, maxPosts });
      this.startAcctPolling();
    } catch (error) { this.setAcctProgress("Error: " + error.message, true); }
  },

  startAcctPolling() {
    if (this.acctPoll) return;
    this.setAcctProgress("Preparando la extraccion...");
    this.acctPoll = setInterval(async () => {
      try {
        const job = await API.get("/api/account-analysis/status");
        if (job.running) {
          const phases = {
            "abriendo perfil": "Abriendo el perfil en X",
            "cargando perfil": "Cargando el perfil",
            "recogiendo publicaciones": "Recogiendo publicaciones",
            "analizando": "Analizando los datos",
            "generando manual": "Generando el manual de ADN",
          };
          const label = phases[job.phase] || job.phase;
          this.setAcctProgress(\`@\${job.handle} — \${label}: \${job.collected} de \${job.maxPosts} publicaciones. No cierres esta ventana.\`);
        } else {
          clearInterval(this.acctPoll);
          this.acctPoll = null;
          if (job.error) this.setAcctProgress("Error: " + job.error, true);
          else {
            this.setAcctProgress(\`Listo: \${job.collected} publicaciones analizadas. Ya aparece abajo.\`);
            await this.loadAccountAnalysis();
            if (job.handle) await this.openAccountProfile(job.handle);
          }
        }
      } catch (error) {
        clearInterval(this.acctPoll);
        this.acctPoll = null;
        this.setAcctProgress("Error al consultar el progreso: " + error.message, true);
      }
    }, 3000);
  },

  setAcctProgress(message, isError) {
    const box = this.els.acctProgressBox;
    const text = this.els.acctProgress;
    if (!text) return;
    text.textContent = message;
    if (box) {
      box.style.display = "block";
      box.style.background = isError ? "#2a0f0f" : "#101c2e";
      box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
      text.style.color = isError ? "#f87171" : "#9cc3ff";
    }
  },

  async useAccountForReference() {
    const handle = this.els.acctUseBtn?.dataset.handle;
    if (!handle) { alert("Selecciona una cuenta primero."); return; }
    try {
      await API.post("/api/x-autopilot/configure", { referenceHandle: handle });
      alert("Ahora X Autopilot usara @" + handle + " como referencia de estilo.");
    } catch (error) { alert(error.message); }
  },

  async deleteAccountAnalysis() {
    const handle = this.els.acctUseBtn?.dataset.handle;
    if (!handle) { alert("Selecciona una cuenta primero."); return; }
    if (!confirm("Borrar el analisis de @" + handle + "?")) return;
    try {
      await API.delete("/api/account-analysis/" + encodeURIComponent(handle));
      this.acctSelected = null;
      if (this.els.acctManual) this.els.acctManual.textContent = "Selecciona una cuenta para ver su manual.";
      if (this.els.acctDetailBody) this.els.acctDetailBody.innerHTML = '<p class="form-hint">Selecciona una cuenta de la lista.</p>';
      await this.loadAccountAnalysis();
    } catch (error) { alert(error.message); }
  },

`;

  const anchor = "  async refresh() {";
  text = replaceOnce(text, anchor, `${logic}${anchor}`, "logica analisis");

  // Elementos.
  const elsAnchor = 'xAiChainPreview: document.getElementById("xAiChainPreview")';
  if (text.includes(elsAnchor) && !text.includes("acctHandle:")) {
    text = replaceOnce(text, elsAnchor, `acctHandle: document.getElementById("acctHandle"), acctMaxPosts: document.getElementById("acctMaxPosts"), acctStartBtn: document.getElementById("acctStartBtn"), acctRefreshBtn: document.getElementById("acctRefreshBtn"), acctProgress: document.getElementById("acctProgress"), acctProgressBox: document.getElementById("acctProgressBox"), acctProfileList: document.getElementById("acctProfileList"), acctDetailTitle: document.getElementById("acctDetailTitle"), acctDetailBody: document.getElementById("acctDetailBody"), acctManual: document.getElementById("acctManual"), acctUseBtn: document.getElementById("acctUseBtn"), acctDeleteBtn: document.getElementById("acctDeleteBtn"), acctAnalysisBadge: document.getElementById("acctAnalysisBadge"), acctSessionBadge: document.getElementById("acctSessionBadge"), acctSessionMessage: document.getElementById("acctSessionMessage"), acctSessionWarning: document.getElementById("acctSessionWarning"), acctLoginBtn: document.getElementById("acctLoginBtn"), acctLoginSaveBtn: document.getElementById("acctLoginSaveBtn"), acctLoginCloseBtn: document.getElementById("acctLoginCloseBtn"),\n    ${elsAnchor}`, "els analisis");
  }

  // Binding.
  const bindAnchor2 = 'if (this.els.xAiConfigLink) this.els.xAiConfigLink.addEventListener("click", () => Router.navigate("ai-config"));';
  if (text.includes(bindAnchor2) && !text.includes("acctRefreshBtn) this.els.acctRefreshBtn.addEventListener")) {
    text = replaceOnce(text, bindAnchor2, `${bindAnchor2}\n    // Los botones de analisis los enlaza web/acct-session.js (CSP-safe).`, "bind analisis");
  }

  // Carga al refrescar (se une al hook de config IA).
  const hook = "this.loadAiConfig();";
  if (text.includes(hook) && !text.includes("this.refreshAcctSession();")) {
    text = replaceOnce(text, hook, `${hook}\n      this.loadAccountAnalysis();\n      this.refreshAcctSession();`, "hook analisis");
  }

  write("web/app.js", text);
  ok("web/app.js: logica de analisis de cuentas anadida");
})();

// ---------------------------------------------------------------------------
// 7c. web/acct-session.js -- enlace de sesion de X (archivo externo, CSP-safe)
// ---------------------------------------------------------------------------
(function installAcctSessionScript() {
  const script = `// Controlador de la pestana "Analisis de cuenta".
// MARKER: ACCTAN-SESSION-v1
//
// La CSP del dashboard bloquea <script> inline, asi que esta logica vive en
// un archivo externo servido desde web/. Gestiona la sesion de X, lanza el
// analisis y muestra el progreso, de forma independiente al resto del panel.
(function () {
  var poll = null;
  function $(id) { return document.getElementById(id); }
  function setBadge(text, ok) {
    var b = $("acctSessionBadge");
    if (!b) return;
    b.textContent = text;
    b.className = "status-badge" + (ok ? " success" : "");
  }
  function setMessage(text) { var m = $("acctSessionMessage"); if (m) m.textContent = text; }
  function showBox(html, isError) {
    var w = $("acctSessionWarning");
    if (!w) return;
    w.style.display = "block";
    w.style.borderColor = isError ? "#5c1a1a" : "";
    w.style.background = isError ? "#2a0f0f" : "";
    var p = w.querySelector("p");
    if (p) { p.innerHTML = html; p.style.color = isError ? "#f87171" : ""; }
  }
  function hideBox() { var w = $("acctSessionWarning"); if (w) w.style.display = "none"; }
  function progress(text, isError) {
    var box = $("acctProgressBox");
    var el = $("acctProgress");
    if (!el) return;
    el.textContent = text;
    if (box) {
      box.style.display = "block";
      box.style.background = isError ? "#2a0f0f" : "#101c2e";
      box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
      el.style.color = isError ? "#f87171" : "#9cc3ff";
    }
  }
  function jsonp(r) {
    return r.text().then(function (t) {
      var d = null;
      try { d = JSON.parse(t); } catch (e) {}
      return { status: r.status, data: d, raw: t };
    });
  }
  function fail(res) {
    var msg = (res.data && res.data.error) || res.raw || ("HTTP " + res.status);
    return String(msg).slice(0, 300);
  }

  var isSaved = false;

  function refresh() {
    return fetch("/api/x-autopilot/session", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data) {
          isSaved = false; setBadge("Sin sesion", false);
          showBox("<b>No se pudo comprobar la sesion de X.</b> El servidor respondio " + res.status + ". " + fail(res), true);
          return;
        }
        var s = res.data.session || {};
        isSaved = !!s.saved;
        setBadge(isSaved ? "Sesion guardada" : (s.open ? "Ventana abierta" : "Sin sesion"), isSaved);
        setMessage(isSaved
          ? "Sesion de X lista. Escribe un @, elige cuantas publicaciones y pulsa Analizar."
          : "Necesitas iniciar sesion en X aqui mismo para poder leer los posts de una cuenta.");
        if (isSaved) hideBox();
        var btn = $("acctStartBtn");
        if (btn) {
          btn.disabled = !isSaved;
          btn.style.opacity = isSaved ? "1" : "0.5";
          btn.style.cursor = isSaved ? "pointer" : "not-allowed";
        }
      })
      .catch(function (e) {
        isSaved = false; setBadge("Sin sesion", false);
        showBox("<b>No se pudo conectar con el servidor.</b> " + String(e && e.message ? e.message : e), true);
      });
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(jsonp).then(function (res) {
      if (res.status !== 200 || (res.data && res.data.ok === false)) throw new Error(fail(res));
      return res.data || {};
    });
  }

  function startPolling() {
    if (poll) return;
    progress("Analisis en marcha. No cierres esta pestana.");
    poll = setInterval(function () {
      fetch("/api/account-analysis/status", { credentials: "same-origin", headers: { "Accept": "application/json" } })
        .then(jsonp)
        .then(function (res) {
          if (res.status !== 200 || !res.data) return;
          var job = res.data;
          if (job.running) {
            var labels = {
              "abriendo perfil": "Abriendo el perfil en X",
              "cargando perfil": "Cargando el perfil",
              "recogiendo publicaciones": "Recogiendo publicaciones",
              "analizando": "Analizando los datos",
              "generando manual": "Generando el manual de ADN",
            };
            progress("@" + job.handle + " — " + (labels[job.phase] || job.phase) + ": " + job.collected + " de " + job.maxPosts + " publicaciones...");
            return;
          }
          clearInterval(poll); poll = null;
          if (job.error) {
            progress("No se pudo completar el analisis: " + job.error, true);
          } else {
            progress("Listo: " + job.collected + " publicaciones analizadas de @" + job.handle + ". Aparecen abajo.");
            loadList().then(function () { if (job.handle) openProfile(job.handle); });
          }
        })
        .catch(function () {});
    }, 2500);
  }

  function analyze() {
    var input = $("acctHandle");
    var handle = (input && input.value ? input.value : "").replace(/^\\s+|\\s+$/g, "");
    if (!handle) { progress("Escribe primero un @ de X (por ejemplo levelsio).", true); input && input.focus(); return; }
    if (!isSaved) {
      progress("Primero inicia sesion en X con el boton de arriba.", true);
      var w = $("acctSessionWarning"); if (w) w.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var sel = $("acctMaxPosts");
    var maxPosts = sel ? Number(sel.value) || 150 : 150;
    progress("Iniciando el analisis de @" + handle.replace(/^@+/, "") + "...");
    post("/api/account-analysis/start", { handle: handle, maxPosts: maxPosts })
      .then(function () { startPolling(); })
      .catch(function (e) { progress("Error al iniciar: " + String(e && e.message ? e.message : e), true); });
  }

  function boot() {
    if (!$("view-account-analysis") && !$("acctSessionBadge")) return;
    bind(); refresh(); loadList();
    setInterval(function () {
      var view = $("view-account-analysis");
      var visible = view ? view.offsetParent !== null || (view.className || "").indexOf("active") !== -1 : true;
      fetch("/api/account-analysis/status", { credentials: "same-origin" }).then(jsonp).then(function (res) {
        if (res.status === 200 && res.data && res.data.running) { startPolling(); return; }
        if (visible) loadList();
      }).catch(function () {});
    }, 5000);
    // Al pulsar la pestana, refrescar inmediatamente.
    var nav = document.querySelector('[data-view="account-analysis"]');
    if (nav) nav.addEventListener("click", function () { setTimeout(function () { refresh(); loadList(); }, 150); });
  }

  // ---- Lista, detalle y manual (independientes del panel general) ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function loadList() {
    return fetch("/api/account-analysis", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data) return;
        renderList(res.data.profiles || []);
      })
      .catch(function () {});
  }
  function renderList(profiles) {
    var list = $("acctProfileList");
    var badge = $("acctAnalysisBadge");
    if (badge) {
      badge.textContent = profiles.length ? profiles.length + " cuenta(s)" : "Sin analisis";
      badge.className = "status-badge" + (profiles.length ? " success" : "");
    }
    if (!list) return;
    if (!profiles.length) {
      list.innerHTML = '<div class="setup-empty">Todavia no has analizado ninguna cuenta.</div>';
      return;
    }
    list.innerHTML = profiles.map(function (p) {
      return '<div class="x-reference-item" style="cursor:pointer;" data-acct="' + esc(p.handle) + '">' +
        '<strong>@' + esc(p.handle) + '</strong>' +
        '<span>' + p.posts + ' publicaciones · ' + p.originals + ' propias · ' + p.replies + ' respuestas</span>' +
        '<span class="form-hint">' + esc((p.topTopics || []).join(" · ")) + '</span></div>';
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-acct]"), function (node) {
      node.addEventListener("click", function () { openProfile(node.getAttribute("data-acct")); });
    });
  }
  function openProfile(handle) {
    fetch("/api/account-analysis/" + encodeURIComponent(handle), { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data || !res.data.data) return;
        renderDetail(res.data.data);
      })
      .catch(function () {});
  }
  function renderDetail(data) {
    var a = data.analysis || {};
    var f = a.format || {};
    var title = $("acctDetailTitle");
    if (title) title.textContent = "@" + data.handle;
    var body = $("acctDetailBody");
    if (body) {
      var topics = (a.topics || []).slice(0, 5).map(function (t) {
        return '<span class="ai-chain-step">' + esc(t.topic) + ' · ' + t.count + '</span>';
      }).join("");
      var hints = (a.keywords || []).slice(0, 20).map(function (k) { return k.word; }).join(", ");
      body.innerHTML =
        '<div class="ai-chain-list" style="margin-bottom:12px;">' + (topics || '<span class="form-hint">Sin temas detectados.</span>') + '</div>' +
        '<p class="form-hint"><b>' + (f.total || 0) + '</b> publicaciones · <b>' + (f.originalPosts || 0) + '</b> propias · <b>' + (f.replies || 0) + '</b> respuestas</p>' +
        '<p class="form-hint">Longitud media: <b>' + (f.avgLength || 0) + '</b> caracteres · Emojis: ' + (f.emojiRatio || 0) + ' · Imagen en ' + (f.withImage || 0) + '</p>' +
        '<p class="form-hint">Sentimiento: <b>' + esc(a.sentiment && a.sentiment.label || "?") + '</b> (' + (a.sentiment && a.sentiment.score || 0) + ')</p>' +
        '<p class="form-hint">Ritmo: <b>' + (a.rhythm && a.rhythm.postsPerDay || 0) + '</b> publicaciones/dia durante ' + (a.rhythm && a.rhythm.spanDays || 0) + ' dias</p>' +
        '<p class="form-hint" style="margin-top:8px;">Palabras clave: ' + esc(hints) + '</p>';
    }
    var manual = $("acctManual");
    if (manual) manual.textContent = data.manual || "Sin manual generado.";
    var ub = $("acctUseBtn");
    if (ub) ub.setAttribute("data-handle", data.handle);
    loadPublisher(data.handle);
    loadReports(data.handle);
  }

  // ---- Historial de informes guardados (elegir uno anterior) ----
  function setReportsEnabled(on) {
    var sel = $("acctReportSelect"), rl = $("acctReportLoad"), rd = $("acctReportDelete");
    [sel, rl, rd].forEach(function (el) {
      if (!el) return;
      el.disabled = !on;
      el.style.opacity = on ? "1" : "0.5";
      el.style.cursor = on ? "pointer" : "not-allowed";
    });
  }
  function loadReports(handle) {
    var sel = $("acctReportSelect");
    if (!sel) return;
    sel.setAttribute("data-handle", handle || "");
    if (!handle) {
      sel.innerHTML = '<option value="">— Selecciona una cuenta de la lista —</option>';
      setReportsEnabled(false);
      return;
    }
    setReportsEnabled(true);
    fetch("/api/account-analysis/" + encodeURIComponent(handle) + "/reports", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        var reports = (res.data && res.data.reports) || [];
        var hint = $("acctReportsHint");
        if (!reports.length) {
          sel.innerHTML = '<option value="">— Aun no hay informes guardados —</option>';
          if (hint) hint.textContent = "Este es el primer analisis de @" + handle + ". Se guardara con fecha y hora para reutilizarlo.";
          return;
        }
        sel.innerHTML = '<option value="">— Usar el analisis mas reciente —</option>' + reports.map(function (r, i) {
          return '<option value="' + esc(r.stamp) + '">' + esc(r.label) + ' · ' + r.posts + ' posts' + (i === 0 ? ' (mas reciente)' : '') + '</option>';
        }).join("");
        if (hint) hint.textContent = reports.length + " informe(s) guardado(s) de @" + handle + ". Elige uno y pulsa Cargar informe.";
      })
      .catch(function () {});
  }
  function loadSelectedReport() {
    var sel = $("acctReportSelect");
    var handle = sel && sel.getAttribute("data-handle");
    var stamp = sel && sel.value;
    if (!handle) { alert("Selecciona una cuenta de la lista de arriba primero."); return; }
    if (!stamp) {
      // Volver al mas reciente: simplemente recargar el detalle vigente.
      openProfile(handle);
      return;
    }
    post("/api/account-analysis/" + encodeURIComponent(handle) + "/reports/" + encodeURIComponent(stamp) + "/use", {})
      .then(function () { openProfile(handle); loadList(); })
      .catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }
  function deleteSelectedReport() {
    var sel = $("acctReportSelect");
    var handle = sel && sel.getAttribute("data-handle");
    var stamp = sel && sel.value;
    if (!handle || !stamp) { alert("Elige un informe concreto del desplegable para borrarlo."); return; }
    if (!window.confirm("Borrar este informe guardado?")) return;
    fetch("/api/account-analysis/" + encodeURIComponent(handle) + "/reports/" + encodeURIComponent(stamp), { method: "DELETE", credentials: "same-origin" })
      .then(jsonp).then(function () { loadReports(handle); }).catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }

  // ---- Publicacion diaria (usa el ADN de esta cuenta) ----
  var pubHandle = "";
  function pubMsg(text, isError) {
    var box = $("acctPubBox"), el = $("acctPubMsg");
    if (!el) return;
    box.style.display = "block";
    box.style.background = isError ? "#2a0f0f" : "#101c2e";
    box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
    el.style.color = isError ? "#f87171" : "#9cc3ff";
    el.textContent = text;
  }
  function loadPublisher(handle) {
    pubHandle = handle || "";
    if (!pubHandle || !$("acctPubCard")) return;
    fetch("/api/acct-publisher/" + encodeURIComponent(pubHandle), { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data || !res.data.profile) return;
        renderPublisher(res.data.profile);
      })
      .catch(function () {});
  }
  function renderPublisher(profile) {
    var c = profile.config || {};
    if ($("acctPubCount")) $("acctPubCount").value = c.postsPerDay || 3;
    if ($("acctPubStart")) $("acctPubStart").value = c.startTime || "09:00";
    if ($("acctPubSpread")) $("acctPubSpread").value = c.spreadMinutes || 240;
    if ($("acctPubJitter")) $("acctPubJitter").value = (c.jitterMinutes == null ? 30 : c.jitterMinutes);
    if ($("acctPubMinGap")) $("acctPubMinGap").value = c.minGapMinutes || 45;
    if ($("acctPubMax")) $("acctPubMax").value = c.maxChars || 280;
    if ($("acctPubLang")) $("acctPubLang").value = c.language === "es" ? "es" : "en";
    if ($("acctPubTopics")) $("acctPubTopics").value = (c.topics || []).join("\\n");
    var badge = $("acctPubBadge");
    if (badge) {
      badge.textContent = c.enabled ? "Activo" : "Pausado";
      badge.className = "status-badge" + (c.enabled ? " success" : "");
    }
    var tb = $("acctPubToggle");
    if (tb) tb.innerHTML = c.enabled
      ? '<i class="ph ph-pause"></i> Desactivar publicacion diaria'
      : '<i class="ph ph-power"></i> Activar publicacion diaria';
    var sb = $("acctPubStop");
    if (sb) {
      sb.disabled = !c.enabled;
      sb.style.opacity = c.enabled ? "1" : "0.5";
      sb.style.cursor = c.enabled ? "pointer" : "not-allowed";
    }
    var hist = $("acctPubHistory");
    if (hist) {
      if (c.enabled) {
        var slots = profile.todaySlots || [];
        var times = slots.map(function (iso) {
          var d = new Date(iso);
          return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        });
        var line = times.length
          ? 'Hoy publica a las: <b>' + times.join(" · ") + '</b> (hora local, con variacion aleatoria).'
          : 'Se calcularan las horas al activar.';
        hist.innerHTML = '<p class="form-hint">' + line + ' Han salido <b>' + ((profile.firedSlots || []).length) + '</b> de ' + (Number(c.postsPerDay) || 3) + ' hoy.</p>';
      } else {
        var last = profile.lastResult;
        hist.innerHTML = last
          ? '<p class="form-hint">Ultimo lote: <b>' + (last.published || 0) + '</b> publicados, <b>' + ((last.failed || []).length) + '</b> fallos.</p>'
          : "";
      }
    }
    var feed = $("acctPubFeed");
    if (feed) {
      var items = profile.history || [];
      feed.innerHTML = items.length ? items.map(function (h) {
        var when = h.at ? new Date(h.at).toLocaleString() : "";
        var ok = h.status === "published";
        return '<div class="x-reference-item"><strong>' + (ok ? "Publicado" : (h.status === "generated" ? "Generado" : "Fallo")) + '</strong>' +
          '<span class="form-hint">' + esc(h.topic ? "Tema: " + h.topic + " · " : "") + when + (h.model ? " · " + esc(h.model) : "") + '</span>' +
          '<span style="white-space:pre-wrap;">' + esc(h.text) + '</span>' +
          (h.error ? '<span class="form-hint" style="color:#f87171;">' + esc(h.error) + '</span>' : '') + '</div>';
      }).join("") : '<p class="form-hint">Aun no ha publicado nada.</p>';
    }
  }
  function savePublisher(extra) {
    if (!pubHandle) { pubMsg("Selecciona una cuenta analizada primero.", true); return Promise.reject(new Error("sin cuenta")); }
    var body = {
      postsPerDay: Number($("acctPubCount") && $("acctPubCount").value) || 3,
      startTime: ($("acctPubStart") && $("acctPubStart").value) || "09:00",
      spreadMinutes: Number($("acctPubSpread") && $("acctPubSpread").value) || 240,
      jitterMinutes: Number($("acctPubJitter") && $("acctPubJitter").value) || 0,
      maxChars: Number($("acctPubMax") && $("acctPubMax").value) || 280,
      language: ($("acctPubLang") && $("acctPubLang").value) || "en",
      minGapMinutes: Number($("acctPubMinGap") && $("acctPubMinGap").value) || 45,
      topics: ($("acctPubTopics") && $("acctPubTopics").value) || "",
    };
    if (extra) for (var k in extra) body[k] = extra[k];
    return post("/api/acct-publisher/" + encodeURIComponent(pubHandle), body)
      .then(function (d) { if (d.profile) renderPublisher(d.profile); return d; });
  }
  function pubNow(dryRun) {
    savePublisher().then(function () {
      pubMsg(dryRun ? "Generando un post de prueba (sin publicar)..." : "Generando y publicando un post...", false);
      return post("/api/acct-publisher/" + encodeURIComponent(pubHandle) + "/now", { count: 1, dryRun: dryRun });
    }).then(function (d) {
      if (d.profile) renderPublisher(d.profile);
      var r = d.result || {};
      var last = (d.profile && d.profile.history && d.profile.history[0]) || {};
      if (r.failed && r.failed.length) pubMsg("Fallo: " + r.failed[0].error, true);
      else if (dryRun) pubMsg("Generado sin publicar: " + (last.text || ""), false);
      else pubMsg("Publicado en tu cuenta de X: " + (last.text || ""), false);
    }).catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function togglePublisher() {
    var active = $("acctPubBadge") && $("acctPubBadge").textContent === "Activo";
    savePublisher({ enabled: !active })
      .then(function (d) {
        var on = d.profile && d.profile.config && d.profile.config.enabled;
        pubMsg(on
          ? "Publicacion diaria ACTIVADA. La IA escribira y publicara sola cada dia a las horas indicadas."
          : "Publicacion diaria en pausa.", false);
      })
      .catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function stopPublisher() {
    if (!pubHandle) { pubMsg("Selecciona una cuenta analizada primero.", true); return; }
    if (!window.confirm("Parar la publicacion diaria de @" + pubHandle + "? No se publicara nada mas hoy (podras reactivarla cuando quieras).")) return;
    post("/api/acct-publisher/" + encodeURIComponent(pubHandle) + "/stop", {})
      .then(function (d) {
        if (d.profile) renderPublisher(d.profile);
        pubMsg("Publicacion diaria PARADA. No se publicara nada mas hoy. Pulsa «Activar publicacion diaria» para reanudarla manana.", false);
      })
      .catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function useRef() {
    var ub = $("acctUseBtn");
    var handle = ub && ub.getAttribute("data-handle");
    if (!handle) { alert("Selecciona una cuenta de la lista primero."); return; }
    post("/api/x-autopilot/configure", { referenceHandle: handle })
      .then(function () { alert("Ahora X Autopilot usara @" + handle + " como referencia de estilo."); })
      .catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }
  function delProfile() {
    var ub = $("acctUseBtn");
    var handle = ub && ub.getAttribute("data-handle");
    if (!handle) { alert("Selecciona una cuenta de la lista primero."); return; }
    if (!window.confirm("Borrar el analisis de @" + handle + "?")) return;
    fetch("/api/account-analysis/" + encodeURIComponent(handle), { method: "DELETE", credentials: "same-origin" })
      .then(jsonp).then(function () {
        var manual = $("acctManual"); if (manual) manual.textContent = "Selecciona una cuenta para ver su manual.";
        var body = $("acctDetailBody"); if (body) body.innerHTML = '<p class="form-hint">Selecciona una cuenta de la lista.</p>';
        loadList();
      }).catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }

  function bind() {
    var lb = $("acctLoginBtn"), sb = $("acctLoginSaveBtn"), cb = $("acctLoginCloseBtn"), ab = $("acctStartBtn"), rb = $("acctRefreshBtn");
    if (lb) lb.addEventListener("click", function () {
      setMessage("Abriendo la ventana de X... (puede tardar unos segundos)");
      post("/api/x-autopilot/login", {})
        .then(function () { setMessage("Ventana abierta. Inicia sesion en ella y pulsa Guardar sesion."); hideBox(); })
        .catch(function (e) { showBox("<b>Error al abrir X:</b> " + String(e && e.message ? e.message : e), true); })
        .then(refresh);
    });
    if (sb) sb.addEventListener("click", function () {
      post("/api/x-autopilot/login/save", {})
        .then(function (d) { setMessage("Sesion guardada" + (d && d.handle ? " (" + d.handle + ")" : "") + ". Ya puedes analizar: la ventana de X se reutilizara."); hideBox(); })
        .catch(function (e) { showBox("<b>Error al guardar la sesion:</b> " + String(e && e.message ? e.message : e), true); })
        .then(refresh);
    });
    if (cb) cb.addEventListener("click", function () { post("/api/x-autopilot/login/close", {}).catch(function () {}).then(refresh); });
    if (ab) ab.addEventListener("click", analyze);
    if (rb) rb.addEventListener("click", function () { loadList(); refresh(); });
    var ub = $("acctUseBtn"), db = $("acctDeleteBtn");
    if (ub) ub.addEventListener("click", useRef);
    if (db) db.addEventListener("click", delProfile);
    var ps = $("acctPubSave"), pt = $("acctPubToggle"), pn = $("acctPubNow"), pp = $("acctPubPreview");
    if (ps) ps.addEventListener("click", function () { savePublisher().then(function () { pubMsg("Ajustes guardados.", false); }).catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); }); });
    if (pt) pt.addEventListener("click", togglePublisher);
    var st = $("acctPubStop");
    if (st) st.addEventListener("click", stopPublisher);
    if (pn) pn.addEventListener("click", function () { pubNow(false); });
    if (pp) pp.addEventListener("click", function () { pubNow(true); });
    var rl = $("acctReportLoad"), rd = $("acctReportDelete");
    if (rl) rl.addEventListener("click", loadSelectedReport);
    if (rd) rd.addEventListener("click", deleteSelectedReport);
    window.__acctSessionOwned = true;
    window.__acctSessionRefresh = refresh;
    window.__acctSessionLoadList = loadList;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;
  const current = read("web/acct-session.js");
  if (current && current.includes(MARK.acctSession) && current.includes("loadReports") && current.includes("stopPublisher")) { skip("web/acct-session.js ya esta instalado"); }
  else { write("web/acct-session.js", script); ok(current ? "web/acct-session.js actualizado (boton Parar)" : "web/acct-session.js creado (sesion + analisis)"); }

  let html = read("web/index.html");
  if (!html) { fail("web/index.html no encontrado (script de sesion)"); return; }
  if (!html.includes("acct-session.js")) {
    if (html.includes("</body>")) {
      html = replaceOnce(html, "</body>", `    <script src="acct-session.js" defer></script>\n</body>`, "script de sesion");
      write("web/index.html", html);
      ok("web/index.html: enlace a acct-session.js anadido");
    } else {
      fail("web/index.html: no se encontro </body> para enganchar el script");
    }
  } else {
    skip("web/index.html: acct-session.js ya enlazado");
  }
})();

// ---------------------------------------------------------------------------
// 13. Radar de noticias + afiliados
// ---------------------------------------------------------------------------
(function installRadar() {
  // 13a. src/acct-radar.js (motor)
  const radarSrc = read("src/acct-radar.js");
  if (radarSrc && radarSrc.includes(MARK.radar) && radarSrc.includes("rewriteAffiliateLinks") && radarSrc.includes("scanKeyword") && radarSrc.includes("languageMigrated")) {
    skip("src/acct-radar.js ya esta actualizado");
  } else {
    write("src/acct-radar.js", readAsset("acct-radar.js"));
    ok(radarSrc ? "src/acct-radar.js actualizado" : "src/acct-radar.js creado (radar de noticias + afiliados)");
  }

  // 13b. src/x-auth.js: helper postTweetRich (texto + imagenes)
  let xauth = read("src/x-auth.js");
  if (xauth && !xauth.includes(MARK.postRich)) {
    const snippet = readAsset("radar-patch.js");
    const match = snippet.match(/const XAUTH_POST_RICH = `([\s\S]*?)`;\n\nmodule\.exports/);
    if (!match) { fail("no se pudo leer el fragmento postTweetRich"); return; }
    const helper = match[1];
    if (!xauth.includes("async function firstVisibleLocator")) {
      fail("src/x-auth.js: no se encontro firstVisibleLocator para insertar postTweetRich");
      return;
    }
    xauth = replaceOnce(xauth, "async function firstVisibleLocator", helper + "async function firstVisibleLocator", "helper postTweetRich");
    xauth = replaceOnce(xauth, "  postTweet,\n  openScratchContext,", "  postTweet,\n  postTweetRich,\n  openScratchContext,", "export postTweetRich");
    write("src/x-auth.js", xauth);
    ok("src/x-auth.js: publicacion con imagenes (postTweetRich) anadida");
  } else if (xauth) {
    skip("src/x-auth.js: postTweetRich ya presente");
  } else {
    fail("src/x-auth.js no encontrado (radar)");
  }

  // 13c. dashboard-server.js: rutas del radar
  let server = read("src/dashboard-server.js");
  if (!server) { fail("src/dashboard-server.js no encontrado (radar)"); return; }
  if (!server.includes(MARK.radarRoutes)) {
    const radarRoutes = `
  ${MARK.radarRoutes}
  const acctRadar = require("./acct-radar");
  app.get("/api/acct-radar/:handle", async (req, res) => {
    try { await acctRadar.load(); res.json({ ok: true, profile: acctRadar.getStatus(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-radar/:handle", async (req, res) => {
    try { await acctRadar.load(); res.json({ ok: true, profile: acctRadar.configure(req.params.handle, req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-radar/:handle/now", async (req, res) => {
    try {
      const run = await acctRadar.runOnce(req.params.handle, { dryRun: req.body?.dryRun === true, force: true });
      const profile = acctRadar.getStatus(req.params.handle);
      res.json({ ok: true, result: { published: run.published || [], skipped: run.skipped || 0, scan: run.scan || null }, profile });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/acct-radar/:handle/stop", async (req, res) => {
    try { await acctRadar.load(); res.json({ ok: true, profile: acctRadar.stop(req.params.handle) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
`;
    const anchor = `app.get("/api/google-flow/status"`;
    if (!server.includes(anchor)) { fail("dashboard-server.js: no se encontro el ancla para las rutas del radar"); return; }
    server = replaceOnce(server, anchor, `${radarRoutes}\n  ${anchor}`, "rutas del radar");
    ok("dashboard-server.js: endpoints del radar anadidos");
  } else {
    skip("dashboard-server.js: endpoints del radar ya presentes");
  }
  write("src/dashboard-server.js", server);

  // 13d. web/index.html: panel del radar + enlace al script
  let html = read("web/index.html");
  if (!html) { fail("web/index.html no encontrado (radar)"); return; }
  if (!html.includes(MARK.radarUi)) {
    const anchor = `        <div class="card" id="acctPubCard" style="margin-top:16px;">`;
    const altAnchor = `            <button id="acctDeleteBtn" class="control-btn-small danger"><i class="ph ph-trash"></i> Borrar analisis</button>
          </div>
        </div>`;
    if (!html.includes(anchor) && !html.includes(altAnchor)) {
      fail("web/index.html: no se encontro donde insertar el panel del radar");
    } else {
      const panel = `
        <div class="card" id="radarCard" style="margin-top:16px;">
          ${MARK.radarUi}
          <div class="card-title"><i class="ph ph-broadcast"></i> Radar de noticias y afiliados</div>
          <p class="form-hint">El radar escanea X con <b>la sesion con la que ya estas logueado</b> (no hace falta analizar ninguna cuenta) buscando las <b>palabras clave</b> que escribas abajo. Los posts que coincidan se reescriben con IA, sus links de tienda se cambian por <b>tu link de afiliado</b>, y se publican conservando las imagenes del original. Tope diario y sin repetir la misma noticia.</p>

          <label style="display:flex; flex-direction:column; gap:4px; margin-top:12px;">
            <span class="form-hint">Temas a escanear (uno por linea o separados por comas). Solo se publican posts que contengan alguna de estas palabras.</span>
            <textarea id="radarKeywords" class="control-input" rows="4" style="width:100%; resize:vertical;" placeholder="One Piece&#10;TCG&#10;One Piece Card Game&#10;Pokemon TCG"></textarea>
          </label>

          <div class="card-title" style="margin-top:16px; font-size:14px;"><i class="ph ph-link"></i> Mis links de afiliado</div>
          <p class="form-hint">Pega aqui tus IDs o links. Amazon: tu tag (ej. miweb-21) o el link corto. eBay: tu campaign ID o link. Target: tu afid o link.</p>
          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
            <label style="display:flex; flex-direction:column; gap:4px; flex:1; min-width:220px;">
              <span class="form-hint">Amazon</span>
              <input id="radarAmazon" class="control-input" type="text" placeholder="miweb-21  o  https://amzn.to/xxxx" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px; flex:1; min-width:220px;">
              <span class="form-hint">eBay</span>
              <input id="radarEbay" class="control-input" type="text" placeholder="campaign id  o  https://ebay.us/xxxx" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px; flex:1; min-width:220px;">
              <span class="form-hint">Target</span>
              <input id="radarTarget" class="control-input" type="text" placeholder="afid  o  https://goto.target.com/xxxx" />
            </label>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-top:14px;">
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Maximo de posts al dia</span>
              <input id="radarMax" class="control-input" type="number" min="1" max="100" value="20" style="max-width:170px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Revisar cada (min)</span>
              <input id="radarEvery" class="control-input" type="number" min="15" max="1440" value="60" style="max-width:160px;" />
            </label>
            <label style="display:flex; flex-direction:column; gap:4px;">
              <span class="form-hint">Idioma</span>
              <select id="radarLang" class="control-input" style="max-width:150px;">
                <option value="en">Ingles</option>
                <option value="es">Espanol</option>
              </select>
            </label>
            <label style="display:flex; flex-direction:row; gap:8px; align-items:center; padding-bottom:8px;">
              <input id="radarOnlyLinks" type="checkbox" />
              <span class="form-hint">Solo publicar posts que ya lleven un link de tienda</span>
            </label>
          </div>

          <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; align-items:center;">
            <button id="radarSave" class="control-btn-small primary"><i class="ph ph-floppy-disk"></i> Guardar ajustes del radar</button>
            <button id="radarScan" class="control-btn-small"><i class="ph ph-magnifying-glass"></i> Escanear sin publicar</button>
            <button id="radarRun" class="control-btn-small success"><i class="ph ph-broadcast"></i> Escanear y publicar ahora</button>
            <button id="radarStop" class="control-btn-small danger"><i class="ph ph-stop-circle"></i> Parar radar hoy</button>
            <span id="radarBadge" class="status-badge">0 / 20 hoy</span>
          </div>
          <div id="radarBox" style="display:none; margin-top:12px; padding:12px 14px; border-radius:10px; background:#101c2e; border:1px solid #1e3a63;">
            <p id="radarMsg" style="font-size:13.5px; color:#9cc3ff; margin:0;"></p>
          </div>
          <details style="margin-top:12px;" open>
            <summary class="form-hint" style="cursor:pointer;">Ultimos posts publicados por el radar</summary>
            <div id="radarHistory" style="margin-top:10px;"></div>
          </details>
        </div>`;
      if (html.includes(anchor)) {
        html = replaceOnce(html, anchor, `${panel}\n\n${anchor}`, "panel del radar");
      } else {
        html = replaceOnce(html, altAnchor, `${altAnchor}\n\n${panel}`, "panel del radar (alt)");
      }
      ok("web/index.html: panel del radar anadido");
    }
  } else {
    // Panel ya presente: anade piezas nuevas (boton de parada) si faltan.
    if (!html.includes("radarStop")) {
      const runAnchor = `<button id="radarRun" class="control-btn-small success"><i class="ph ph-broadcast"></i> Escanear y publicar ahora</button>`;
      if (html.includes(runAnchor)) {
        html = replaceOnce(html, runAnchor, `${runAnchor}
            <button id="radarStop" class="control-btn-small danger"><i class="ph ph-stop-circle"></i> Parar radar hoy</button>`, "boton parar radar");
        ok("web/index.html: boton de parada del radar anadido");
      } else {
        skip("web/index.html: panel del radar ya presente (sin ancla para el boton)");
      }
    } else {
      skip("web/index.html: panel del radar ya presente");
    }
  }
  if (!html.includes("acct-radar-ui.js")) {
    if (html.includes("</body>")) {
      html = replaceOnce(html, "</body>", `    <script src="acct-radar-ui.js" defer></script>\n</body>`, "script del radar");
      ok("web/index.html: enlace a acct-radar-ui.js anadido");
    }
  } else {
    skip("web/index.html: acct-radar-ui.js ya enlazado");
  }
  write("web/index.html", html);

  // 13e. web/acct-radar-ui.js
  const uiCurrent = read("web/acct-radar-ui.js");
  if (uiCurrent && uiCurrent.includes("ACCT-RADAR-UI-v1") && uiCurrent.includes("radarKeywords") && uiCurrent.includes('radarLang").value = c.language === "es"')) {
    skip("web/acct-radar-ui.js ya esta instalado");
  } else {
    write("web/acct-radar-ui.js", readAsset("acct-radar-ui.js"));
    ok(uiCurrent ? "web/acct-radar-ui.js actualizado" : "web/acct-radar-ui.js creado");
  }
})();

// ---------------------------------------------------------------------------
// Helper: leer assets embebidos
// ---------------------------------------------------------------------------
function readAsset(name) {
  const candidates = [
    path.join(__dirname, "assets", name),
    path.join(ROOT, "assets", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  throw new Error(`No se encontro el asset ${name} (junto al instalador o en assets/).`);
}

// ---------------------------------------------------------------------------
// Resumen
// ---------------------------------------------------------------------------
console.log("\n=== AutoSocial Studio - X Autopilot Fix ===");
for (const [status, message] of results) {
  console.log(`  [${status}] ${message}`);
}
const failures = results.filter(([status]) => status === "FAIL");
console.log(`\n${results.length - failures.length - results.filter(([s]) => s === "SKIP").length} cambios aplicados, ${results.filter(([s]) => s === "SKIP").length} ya presentes, ${failures.length} errores.`);
if (failures.length) {
  console.error("\nRevisa los errores de arriba antes de arrancar el dashboard.");
  process.exitCode = 1;
} else {
  console.log("\nReinicia el dashboard (node src/dashboard-server.js) y abre la pestana X Autopilot.");
}
