#!/usr/bin/env node
/*
 * QUITAR la validacion previa que rompia la subida/programacion en TikTok
 * ----------------------------------------------------------------------
 * Causa: un parche anterior insertaba, ANTES de subir el video, una llamada
 *   assertTiktokIdentity(page, accountId)
 * que hace page.goto("https://www.tiktok.com/foryou"). Eso NAVEGA fuera del
 * editor de subida y deja el flujo en la pagina equivocada, por lo que dejan
 * de aplicarse la fecha/dias al programar (y puede fallar la subida).
 *
 * Este script elimina esa comprobacion del flujo de subida (uploadVideo),
 * dejando intactas las demas funciones (detectar @, reset de sesion, etc.).
 *
 * NO toca index.html ni la interfaz. Idempotente. Con --revert.
 *
 * Uso:
 *   node quitar-validacion-identidad-subida.js
 *   node quitar-validacion-identidad-subida.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "QUITAR-VALIDACION-IDENTIDAD";

function log(m) { console.log(`[${MARK}] ${m}`); }
function full(rel) { return path.resolve(ROOT, rel); }

const REL = "src/tiktok-uploader.js";

const BLOCK = [
  "    // // MARKER: IDENTIDAD-TIKTOK-v1: antes de tocar nada, comprobar que la sesion es de la cuenta correcta.",
  "    try {",
  "      const idCheck = await assertTiktokIdentity(page, accountId);",
  "      if (idCheck.blocked) {",
  "        throw new Error(",
  "          `Sesion de TikTok equivocada en esta cuenta. Esta cuenta tiene la sesion de @${idCheck.detected}` +",
  "          (idCheck.expected ? ` pero deberia ser @${idCheck.expected}` : \"\") +",
  "          `. Abre \"Iniciar sesion en TikTok\" con ESA cuenta o usa \"Cerrar sesion de esta cuenta\" y vuelve a entrar.`",
  "        );",
  "      }",
  "    } catch (e) {",
  "      if (/Sesion de TikTok equivocada/.test(String(e && e.message))) throw e;",
  "      console.log(`[identidad] no se pudo verificar la sesion: ${e && e.message}`);",
  "    }",
  "",
].join("\n");

function runApply() {
  const f = full(REL);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${REL}. Ejecuta esto desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");

  if (!text.includes("await assertTiktokIdentity(page, accountId)")) {
    log("No hay validacion previa en uploadVideo (ya quitada). Sin cambios.");
    return;
  }
  if (!text.includes(BLOCK)) {
    throw new Error("Encontrada la llamada 'await assertTiktokIdentity(page, accountId)' pero el bloque no coincide exactamente. Avisa a tu asistente.");
  }

  // Backup
  const backup = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, backup);

  text = text.replace(BLOCK, "");
  fs.writeFileSync(f, text, "utf8");
  log(`quitada la validacion previa de la subida en ${REL}`);
  log(`backup: ${path.basename(backup)}`);
  log("Listo. Reinicia el dashboard (npm run dashboard).");
}

function runRevert() {
  const dir = path.dirname(full(REL));
  const baks = fs.readdirSync(dir).filter((x) => x.startsWith(`${path.basename(REL)}.bak-${MARK}-`)).sort();
  if (!baks.length) { log("Nada que revertir."); return; }
  fs.copyFileSync(path.resolve(dir, baks[baks.length - 1]), full(REL));
  log(`revertido ${REL} desde ${baks[baks.length - 1]}`);
}

if (REVERT) runRevert();
else runApply();
