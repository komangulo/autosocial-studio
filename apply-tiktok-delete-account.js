#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(process.argv[2] || process.cwd());

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(projectRoot, "src"))) {
  fail(`No encuentro el proyecto en ${projectRoot}.`);
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function read(relativePath) {
  return normalize(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function detectUiFile() {
  const serverSource = normalize(fs.readFileSync(path.join(projectRoot, "src/dashboard-server.js"), "utf8"));
  const match = serverSource.match(/express\.static\([^)]*?"\.\."\s*,\s*"([^"]+)"/);
  const candidates = [];
  if (match) candidates.push(`${match[1]}/app.js`);
  for (const guess of ["web/app.js", "studio-ui/web/app.js"]) {
    if (!candidates.includes(guess)) candidates.push(guess);
  }
  const found = candidates.find((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));
  if (!found) fail("No encuentro el app.js del dashboard (ni web/app.js ni studio-ui/web/app.js).");
  return found;
}

const uiFile = detectUiFile();
console.log(`Dashboard servido desde: ${uiFile}`);

const files = [
  "src/account-manager.js",
  "src/daemon-registry.js",
  "src/dashboard-server.js",
  uiFile,
];

for (const relativePath of files) {
  if (!fs.existsSync(path.join(projectRoot, relativePath))) {
    fail(`No encuentro ${path.join(projectRoot, relativePath)}.`);
  }
}

function managedHandlerHasDelete(source) {
  const start = source.indexOf("  async handleManagedAccountsClick(event) {");
  if (start < 0) return false;
  const end = source.indexOf("\n  renderManagedAccounts", start);
  const body = end < 0 ? source.slice(start) : source.slice(start, end);
  return body.includes('action === "delete"') && body.includes("deleteTikTokAccount");
}

const alreadyApplied =
  read("src/dashboard-server.js").includes("/api/accounts/delete") &&
  read("src/account-manager.js").includes("async function removeAccount(accountId)") &&
  read("src/daemon-registry.js").includes("function disposeDaemons(accountId)") &&
  read(uiFile).includes("async deleteTikTokAccount(") &&
  managedHandlerHasDelete(read(uiFile));
if (alreadyApplied) {
  console.log("El boton de eliminar cuenta ya esta aplicado.");
  process.exit(0);
}

function insertAfter(source, anchor, addition, label) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`No encuentro el ancla "${label}"`);
  const end = at + anchor.length;
  return source.slice(0, end) + addition + source.slice(end);
}

function insertBefore(source, anchor, addition, label) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`No encuentro el ancla "${label}"`);
  return source.slice(0, at) + addition + source.slice(at);
}

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`No encuentro el bloque "${label}"`);
  return source.replace(from, to);
}

const backups = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const originals = new Map();
const lineEndings = new Map();
for (const relativePath of files) {
  const sourcePath = path.join(projectRoot, relativePath);
  const raw = fs.readFileSync(sourcePath, "utf8");
  const crlf = raw.includes("\r\n");
  lineEndings.set(relativePath, crlf ? "\r\n" : "\n");
  originals.set(relativePath, raw);
  fs.writeFileSync(sourcePath, raw.replace(/\r\n/g, "\n"));
  const backupPath = `${sourcePath}.backup-accounts-${stamp}`;
  fs.copyFileSync(sourcePath, backupPath);
  backups.push({ sourcePath, backupPath });
}

function restoreAll() {
  for (const relativePath of files) {
    fs.writeFileSync(path.join(projectRoot, relativePath), originals.get(relativePath));
  }
}

function toCrlf(relativePath, text) {
  return lineEndings.get(relativePath) === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

try {
  let accountManager = read("src/account-manager.js");

  if (!accountManager.includes("async function removeAccount(accountId)")) {
    accountManager = insertAfter(
      accountManager,
      `async function requireAccount(accountId) {
  const safeId = assertSafeAccountId(accountId);
  await ensureLoaded();
  const account = state.accounts.find((item) => item.id === safeId);
  if (!account) throw new Error("Account not found.");
  return clone(account);
}`,
      `

async function removeAccount(accountId) {
  await ensureLoaded();
  const safeId = assertSafeAccountId(accountId);
  if (safeId === DEFAULT_ACCOUNT.id) {
    throw new Error("La cuenta por defecto no se puede eliminar.");
  }
  const index = state.accounts.findIndex((item) => item.id === safeId);
  if (index < 0) throw new Error("Account not found.");

  const [removed] = state.accounts.splice(index, 1);
  if (state.activeAccountId === safeId) {
    state.activeAccountId = state.accounts[0].id;
  }
  await saveState();

  const queueDir = path.resolve(config.projectRoot, "queue", safeId);
  const profileDir = path.resolve(config.projectRoot, ".profiles", safeId);
  await fs.rm(queueDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});

  return clone(removed);
}`,
      "requireAccount"
    );
  }

  if (!/  removeAccount,/.test(accountManager)) {
    accountManager = replaceOnce(
      accountManager,
      `  requireAccount,
  assertSafeAccountId,`,
      `  requireAccount,
  removeAccount,
  assertSafeAccountId,`,
      "export removeAccount"
    );
  }
  if (!accountManager.includes("async function removeAccount(accountId)") || !/  removeAccount,/.test(accountManager)) {
    throw new Error("removeAccount no quedo correctamente en account-manager.js");
  }
  fs.writeFileSync(path.join(projectRoot, "src/account-manager.js"), toCrlf("src/account-manager.js", accountManager));

  let registry = read("src/daemon-registry.js");
  if (!registry.includes("function disposeDaemons(accountId)")) {
    registry = insertBefore(
      registry,
      "module.exports = {",
      `function disposeDaemons(accountId) {
    const daemons = registry.get(accountId);
    if (!daemons) return false;
    for (const daemon of Object.values(daemons)) {
        try {
            daemon.stop?.();
        } catch {
            // Best effort: the account is being removed anyway.
        }
    }
    registry.delete(accountId);
    return true;
}

`,
      "module.exports"
    );
    registry = replaceOnce(
      registry,
      `    getRegisteredAccountIds,
};`,
      `    getRegisteredAccountIds,
    disposeDaemons,
};`,
      "export disposeDaemons"
    );
  }
  if (!registry.includes("function disposeDaemons(accountId)") || !registry.includes("disposeDaemons,")) {
    throw new Error("disposeDaemons no quedo correctamente en daemon-registry.js");
  }
  fs.writeFileSync(path.join(projectRoot, "src/daemon-registry.js"), toCrlf("src/daemon-registry.js", registry));

  let server = read("src/dashboard-server.js");
  if (!server.includes("disposeDaemons } = require(\"./daemon-registry\")") && !/require\("\.\/daemon-registry"\)[\s\S]{0,200}disposeDaemons/.test(server)) {
    server = replaceOnce(
      server,
      `const { getDaemons, getAllStatus } = require("./daemon-registry");`,
      `const { getDaemons, getAllStatus, disposeDaemons } = require("./daemon-registry");`,
      "import disposeDaemons"
    );
  }
  if (!/  removeAccount,/.test(server)) {
    server = replaceOnce(
      server,
      `  hasSavedPlatformSession,
} = require("./account-manager");`,
      `  hasSavedPlatformSession,
  removeAccount,
} = require("./account-manager");`,
      "import removeAccount"
    );
  }
  if (!server.includes('"/api/accounts/delete"')) {
    server = insertBefore(
      server,
      `  app.get("/api/x-autopilot", async (req, res) => {`,
      `  app.post("/api/accounts/delete", async (req, res) => {
    try {
      const account = await requireAccount(req.body?.accountId);
      const removed = await removeAccount(account.id);
      disposeDaemons(account.id);
      res.json({ ok: true, account: removed });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

`,
      "x-autopilot route"
    );
  }
  if (!server.includes('"/api/accounts/delete"') || !/removeAccount,/.test(server) || !/disposeDaemons/.test(server)) {
    throw new Error("El endpoint /api/accounts/delete no quedo correctamente en dashboard-server.js");
  }
  fs.writeFileSync(path.join(projectRoot, "src/dashboard-server.js"), toCrlf("src/dashboard-server.js", server));

  let app = read(uiFile);
  if (!app.includes('data-account-action="delete"')) {
    app = insertAfter(
      app,
      `<button class="control-btn-small" data-account-action="open" data-account-id="\${escapeHtml(account.id)}"><i class="ph ph-browser"></i> Open signup</button>`,
      `
              <button class="control-btn-small danger" data-account-action="delete" data-account-id="\${escapeHtml(account.id)}" data-account-name="\${escapeHtml(account.name)}"><i class="ph ph-trash"></i> Eliminar</button>`,
      "open signup button"
    );
  }

  if (!app.includes("async deleteTikTokAccount(")) {
    app = insertBefore(
      app,
      `  async handleManagedAccountsClick(event) {`,
      `  async deleteTikTokAccount(accountId, accountName) {
    const confirmed = confirm(
      \`Eliminar la cuenta "\${accountName}"?\\n\\nSe borran su perfil de navegador, su cola de videos y su sesion guardada. Esta accion no se puede deshacer.\`
    );
    if (!confirmed) return;
    try {
      await API.post("/api/accounts/delete", { accountId });
      await this.refresh();
      document.dispatchEvent(new CustomEvent("autosocial:accountchange", {
        detail: { accountId: null, deletedAccountId: accountId },
      }));
      alert(\`Cuenta "\${accountName}" eliminada: perfil, cola y sesion borrados.\`);
    } catch (error) {
      alert(\`No se pudo eliminar la cuenta: \${error.message}\`);
    }
  },

`,
      "handleManagedAccountsClick"
    );
  }

  const handlerAnchor = `  async handleManagedAccountsClick(event) {`;
  const handlerStart = app.indexOf(handlerAnchor);
  if (handlerStart < 0) throw new Error('No encuentro "handleManagedAccountsClick"');
  const handlerEnd = app.indexOf("\n  renderManagedAccounts", handlerStart);
  if (handlerEnd < 0) throw new Error('No encuentro el final de "handleManagedAccountsClick"');
  const handlerBody = app.slice(handlerStart, handlerEnd);

  if (!handlerBody.includes('action === "delete"')) {
    app = insertAfter(
      app,
      `      if (action === "open") {
        await API.post("/api/account-manager/open-assisted", { accountId });
        await this.refresh();
      }`,
      `
      if (action === "delete") {
        await this.deleteTikTokAccount(accountId, button.dataset.accountName || accountId);
      }`,
      "open action"
    );
  }

  if (!managedHandlerHasDelete(app)) {
    throw new Error("El boton se aplico pero la rama de borrado no quedo en handleManagedAccountsClick");
  }
  fs.writeFileSync(path.join(projectRoot, uiFile), toCrlf(uiFile, app));
} catch (error) {
  restoreAll();
  fail(error.message);
}

for (const relativePath of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(projectRoot, relativePath)], { encoding: "utf8" });
  if (result.status !== 0) {
    restoreAll();
    fail((result.stderr || result.stdout || "La validacion de sintaxis fallo.").trim());
  }
}

console.log("Boton de eliminar cuenta aplicado correctamente.");
console.log("Borra el perfil de Chromium, la cola y la sesion de la cuenta eliminada.");
for (const { backupPath } of backups) {
  console.log(`Copia de seguridad: ${backupPath}`);
}
