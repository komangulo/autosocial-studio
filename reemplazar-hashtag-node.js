#!/usr/bin/env node
/**
 * Reemplaza #jthefrog por #fthefrog SOLO en la carpeta fija indicada.
 * - Solo cambia el texto del hashtag. Nada mas se modifica.
 * - Recorre la carpeta de forma recursiva buscando .meta.json
 *
 * USO:
 *   node reemplazar-hashtag-node.js          (aplica los cambios)
 *   node reemplazar-hashtag-node.js --dry    (solo muestra, no escribe)
 */

const fs = require("fs");
const path = require("path");

const DE = "#jthefrog";
const A  = "#fthefrog";

// Carpeta fija donde debe actuar el script:
const CARPETA = "C:\\Users\\msi\\Downloads\\autosocial-studio\\.runtime\\autoclone\\jobs\\jthefrog0-1791270066768\\outputs";

const dry = process.argv.includes("--dry");

if (!fs.existsSync(CARPETA)) {
  console.error("La carpeta no existe:", CARPETA);
  process.exit(1);
}

let revisados = 0, cambiados = 0, ocurrencias = 0;
const lista = [];

function reemplaza(valor) {
  if (typeof valor === "string") {
    const n = valor.split(DE).length - 1;
    if (n > 0) { ocurrencias += n; return valor.split(DE).join(A); }
    return valor;
  }
  if (Array.isArray(valor)) return valor.map(reemplaza);
  if (valor && typeof valor === "object") {
    const out = {};
    for (const k of Object.keys(valor)) out[k] = reemplaza(valor[k]);
    return out;
  }
  return valor;
}

function recorre(dir) {
  for (const nombre of fs.readdirSync(dir)) {
    const full = path.join(dir, nombre);
    const st = fs.statSync(full);
    if (st.isDirectory()) { recorre(full); continue; }
    if (!nombre.toLowerCase().endsWith(".meta.json")) continue;

    revisados++;
    const txt = fs.readFileSync(full, "utf8");
    if (!txt.includes(DE)) continue;

    let data;
    try { data = JSON.parse(txt); }
    catch (e) { console.warn("  JSON invalido, se omite:", full); continue; }

    const nuevo = reemplaza(data);
    cambiados++;
    lista.push(full);
    if (!dry) fs.writeFileSync(full, JSON.stringify(nuevo, null, 2), "utf8");
  }
}

console.log("Carpeta:", CARPETA);
recorre(CARPETA);
console.log("Archivos .meta.json revisados:", revisados);
console.log("Archivos que contenian", DE + ":", cambiados);
console.log("Sustituciones realizadas:", ocurrencias, `(${DE} -> ${A})`);
console.log(dry ? "\nMODO PRUEBA (--dry): no se escribio nada."
                : `\nHecho. Solo se cambio ${DE} por ${A}; el resto quedo intacto.`);
if (lista.length && lista.length <= 25) {
  console.log("\nArchivos modificados:");
  lista.forEach(f => console.log("  -", f));
}
