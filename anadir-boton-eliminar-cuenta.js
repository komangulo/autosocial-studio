#!/usr/bin/env node
/*
 * ANADIR BOTON "ELIMINAR CUENTA" al panel de cuentas gestionadas
 * ---------------------------------------------------------------
 * Permite borrar un perfil/cuenta que creaste (p.ej. "Erick - TechWired").
 * Borra la cuenta, su cola (queue/<id>) y sus perfiles (.profiles/<id>).
 * La cuenta "Default" NO se puede borrar (proteccion en el backend).
 *
 * Cambios:
 *   - src/dashboard-server.js: importa removeAccount + endpoint
 *     POST /api/accounts/remove
 *   - web/app.js: boton "Eliminar" en la tabla + manejador con confirmacion
 *
 * NO toca la interfaz mas alla de anadir ese boton. Idempotente. Con --revert.
 *
 * Uso:
 *   node anadir-boton-eliminar-cuenta.js
 *   node anadir-boton-eliminar-cuenta.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "BOTON-ELIMINAR-CUENTA";

function log(m) { console.log(`[${MARK}] ${m}`); }
const full = (rel) => path.resolve(ROOT, rel);

const backups = [];

function backup(rel) {
  const f = full(rel);
  const b = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, b);
  backups.push({ rel, b });
  return b;
}

function patch(rel, edits) {
  const f = full(rel);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${rel}. Ejecuta desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");
  if (text.includes(`MARKER: ${MARK}`)) { log(`${rel}: ya estaba aplicado`); return; }
  for (const [oldStr, newStr] of edits) {
    if (!text.includes(oldStr)) {
      throw new Error(`${rel}: no encuentro el punto de insercion. Avisa a tu asistente.\n---\n${oldStr.slice(0, 120)}`);
    }
    text = text.replace(oldStr, newStr);
  }
  backup(rel);
  fs.writeFileSync(f, text, "utf8");
  log(`${rel}: parcheado`);
}

// ---------------- 1) dashboard-server.js ----------------
const SRV_IMPORT_OLD = `  getAccountQueueDirs,
  requireAccount,
  hasSavedPlatformSession,
} = require("./account-manager");`;
const SRV_IMPORT_NEW = `  getAccountQueueDirs,
  requireAccount,
  hasSavedPlatformSession,
  removeAccount, // MARKER: BOTON-ELIMINAR-CUENTA
} = require("./account-manager");`;

const SRV_ROUTE_OLD = `  app.post("/api/accounts/select", async (req, res) => {
    try {
      const account = await selectAccount(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });`;
const SRV_ROUTE_NEW = `  app.post("/api/accounts/select", async (req, res) => {
    try {
      const account = await selectAccount(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // MARKER: BOTON-ELIMINAR-CUENTA
  app.post("/api/accounts/remove", async (req, res) => {
    try {
      const removed = await removeAccount(req.body?.accountId);
      const state = await getState();
      const active = await getActiveAccount();
      res.json({ ok: true, removed, state, activeAccount: active });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });`;

// ---------------- 2) web/app.js ----------------
// Boton en la fila de cada cuenta (junto a Select / Open signup).
const WEB_BTN_OLD = `              <button class="control-btn-small" data-account-action="open" data-account-id="\${escapeHtml(account.id)}"><i class="ph ph-browser"></i> Open signup</button>
            </div></td>`;
const WEB_BTN_NEW = `              <button class="control-btn-small" data-account-action="open" data-account-id="\${escapeHtml(account.id)}"><i class="ph ph-browser"></i> Open signup</button>
              <!-- MARKER: BOTON-ELIMINAR-CUENTA -->
              <button class="control-btn-small danger" data-account-action="remove" data-account-id="\${escapeHtml(account.id)}" \${account.id === "default" ? "disabled title='La cuenta por defecto no se puede eliminar.'" : "title='Eliminar esta cuenta, su cola y sus perfiles.'"}><i class="ph ph-trash"></i> Eliminar</button>
            </div></td>`;

// Manejador de la accion "remove".
const WEB_HANDLER_OLD = `      if (action === "open") {
        await API.post("/api/account-manager/open-assisted", { accountId });
        await this.refresh();
      }
    } catch (error) {
      alert(\`Account action failed: \${error.message}\`);
    }
  },`;
const WEB_HANDLER_NEW = `      if (action === "open") {
        await API.post("/api/account-manager/open-assisted", { accountId });
        await this.refresh();
        return;
      }
      // MARKER: BOTON-ELIMINAR-CUENTA
      if (action === "remove") {
        const row = button.closest("tr");
        const name = row ? (row.querySelector(".managed-account-name")?.textContent || accountId) : accountId;
        const ok = confirm("¿Eliminar la cuenta \\"" + name + "\\"?\\n\\nSe borraran su cola de videos y sus perfiles de navegador (sesiones). No se puede deshacer.");
        if (!ok) return;
        const result = await API.post("/api/accounts/remove", { accountId });
        if (result && result.ok === false) throw new Error(result.error);
        await this.refresh();
      }
    } catch (error) {
      alert(\`Account action failed: \${error.message}\`);
    }
  },`;

function apply() {
  patch("src/dashboard-server.js", [
    [SRV_IMPORT_OLD, SRV_IMPORT_NEW],
    [SRV_ROUTE_OLD, SRV_ROUTE_NEW],
  ]);
  patch("web/app.js", [
    [WEB_BTN_OLD, WEB_BTN_NEW],
    [WEB_HANDLER_OLD, WEB_HANDLER_NEW],
  ]);
  log("Listo. Reinicia el dashboard (npm run dashboard) y recarga la pagina (Ctrl+F5).");
}

function revert() {
  let any = false;
  for (const rel of ["src/dashboard-server.js", "web/app.js"]) {
    const dir = path.dirname(full(rel));
    const base = path.basename(rel);
    const baks = fs.readdirSync(dir).filter((x) => x.startsWith(`${base}.bak-${MARK}-`)).sort();
    if (baks.length) {
      fs.copyFileSync(path.resolve(dir, baks[baks.length - 1]), full(rel));
      log(`revertido ${rel} desde ${baks[baks.length - 1]}`);
      any = true;
    }
  }
  if (!any) log("Nada que revertir.");
}

if (REVERT) revert(); else apply();
