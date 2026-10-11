/*
 * limpiar-cola.js  —  BORRADO SEGURO
 * Borra los trabajos de TikTok (pending / scheduled / processing)
 * SOLO de las cuentas: capybluh y madrid-nueva-modelo
 * y cancela sus jobs en .runtime/autonomous-state.json
 *
 * NO toca ninguna otra cuenta.
 *
 * USO (desde la raiz del proyecto):
 *     node limpiar-cola.js
 * Para confirmar sin pregunta interactiva:
 *     node limpiar-cola.js --si
 */
const fs = require("fs");
const path = require("path");

const PROJ = process.cwd();
const CUENTAS = ["capybluh", "madrid-nueva-modelo"];
const SUBS_BORRAR = ["pending", "scheduled", "processing"];
const FORZAR = process.argv.includes("--si");

function listar(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function contar(dir) {
  return listar(dir).length;
}

function vaciar(dir) {
  if (!fs.existsSync(dir)) return;
  for (const nombre of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, nombre), { recursive: true, force: true });
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

console.log("Proyecto:", PROJ);
console.log("\n=== ANTES ===");
for (const c of CUENTAS) {
  for (const sub of ["pending", "scheduled", "processing", "posted", "failed"]) {
    console.log(`  queue/${c}/tiktok/${sub} = ${contar(path.join(PROJ, "queue", c, "tiktok", sub))}`);
  }
}

if (!FORZAR) {
  console.log("\nEsto BORRA pendientes/procesando/reservados de: " + CUENTAS.join(", "));
  console.log("Cierra la app antes de continuar.");
  process.stdout.write("Escribe SI para continuar: ");
  try {
    const buf = fs.readFileSync(0, "utf8").trim();
    if (buf !== "SI") { console.log("Cancelado."); process.exit(0); }
  } catch {
    console.log("\n(No hay entrada interactiva; usa: node limpiar-cola.js --si)");
    process.exit(0);
  }
}

// 1) Backup del estado
const statePath = path.join(PROJ, ".runtime", "autonomous-state.json");
if (fs.existsSync(statePath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(statePath, `${statePath}.bak-${stamp}`);
  console.log("Backup del estado creado.");
}

// 2) Vaciar carpetas de cola (solo capybluh y madrid)
for (const c of CUENTAS) {
  for (const sub of SUBS_BORRAR) {
    const dir = path.join(PROJ, "queue", c, "tiktok", sub);
    console.log(`Borrando contenido de queue/${c}/tiktok/${sub} ...`);
    vaciar(dir);
    mkdirp(dir);
  }
}

// 3) Cancelar jobs en el estado (solo esas cuentas, solo no-terminales)
if (fs.existsSync(statePath)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    console.log("No pude leer el estado:", e.message);
    data = null;
  }
  if (data) {
    const TERMINAL = new Set(["completed", "failed", "cancelled"]);
    const set = new Set(CUENTAS);
    let cambiados = 0;
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }
      if (set.has(obj.accountId) && typeof obj.status === "string" && !TERMINAL.has(obj.status)) {
        obj.status = "cancelled";
        cambiados++;
      }
      for (const k of Object.keys(obj)) walk(obj[k]);
    };
    walk(data);
    fs.copyFileSync(statePath, statePath + ".pre-cancel");
    fs.writeFileSync(statePath, JSON.stringify(data, null, 2), "utf8");
    console.log(`Jobs de capybluh/madrid marcados como cancelled: ${cambiados}`);
  }
}

console.log("\n=== DESPUES ===");
for (const c of CUENTAS) {
  for (const sub of SUBS_BORRAR) {
    console.log(`  queue/${c}/tiktok/${sub} = ${contar(path.join(PROJ, "queue", c, "tiktok", sub))}`);
  }
}
console.log("\nLimpieza terminada. Reinicia la app.");
