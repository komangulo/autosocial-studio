#!/usr/bin/env node
/*
 * instalar-error-visible.js
 * ------------------------------------------------------------
 * Hace VISIBLE el motivo real por el que yt-dlp falla.
 *
 * EL PROBLEMA
 * -----------
 * Cuando falla una descarga, solo ves:
 *   "No se pudo descargar el video (Command failed with code 1: ...yt-dlp.exe)"
 *
 * Ese mensaje no dice NADA util. Pero el motivo real SI existe: la
 * funcion run() lo guarda en error.stderr, y el codigo lo tira a la
 * basura al construir el mensaje final.
 *
 * QUE HACE ESTE PARCHE
 * --------------------
 *  1. Incluye la ultima linea util de stderr de yt-dlp en el mensaje.
 *     Asi, en pantalla, veras algo como:
 *       ERROR: [TikTok] 7669407395914763542: Video not available
 *     o
 *       ERROR: Sign in to confirm you're not a bot
 *     ...que es la pista de verdad.
 *
 *  2. Guarda el stderr COMPLETO en el propio job, en el archivo
 *     error-ytdlp.txt, para que puedas abrirlo y verlo entero.
 *
 *  3. Acepta enlaces de TikTok que hoy rechaza sin motivo:
 *       - https://www.tiktok.com/t/XXXX/   (boton Compartir)
 *       - https://es.tiktok.com/...        (subdominio de idioma)
 *       - www.tiktok.com/...               (sin https://)
 *
 * No cambia la logica de descarga. Solo hace visible el motivo.
 *
 * Uso:
 *   Copia este archivo a la raiz de autosocial-studio.
 *   node instalar-error-visible.js
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "autoclone", "controller.js");
const MARK = "// [ERROR-VISIBLE]";

function ok(m) { console.log("  [OK]   " + m); }
function info(m) { console.log("  [info] " + m); }
function die(m) { console.error("  [ERROR] " + m); process.exit(1); }

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - Diagnostico visible de yt-dlp");
console.log("============================================================");
console.log("");

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  die("No encuentro package.json. Copia este archivo a la raiz del proyecto.");
}
if (!fs.existsSync(TARGET)) {
  die("No encuentro src/autoclone/controller.js.");
}
ok("Proyecto encontrado.");

let src = fs.readFileSync(TARGET, "utf8");

// --- 1. Ya parcheado? -----------------------------------------
console.log("");
console.log("[1/4] Comprobando si ya esta parcheado...");
if (src.includes(MARK)) {
  ok("Ya tiene el diagnostico visible instalado. Nada que hacer.");
  console.log("");
  process.exit(0);
}

// --- 2. Anclas -------------------------------------------------
console.log("");
console.log("[2/4] Localizando los puntos exactos del archivo...");

const ANCLA_MENSAJE =
  "        throw new Error(`No se pudo descargar el video (${error.message}). Comprueba que el enlace sea publico y correcto.`);";

if (!src.includes(ANCLA_MENSAJE)) {
  die(
    "No encuentro el mensaje de error esperado en controller.js.\n" +
      "         Tu version del archivo es distinta. No toco nada.\n" +
      "         Actualiza el proyecto con: git pull"
  );
}
ok("Mensaje de error localizado.");

// --- 3. Aplicar cambios ---------------------------------------
console.log("");
console.log("[3/4] Aplicando cambios...");

// (a) Mensaje de error visible + volcado completo a disco.
const NUEVO_BLOQUE = [
  MARK + " inicio",
  "        // Extrae la ultima linea util de stderr, que es donde yt-dlp",
  "        // explica el motivo real (privado, no disponible, login, geo...).",
  "        const crudo = String(error.stderr || \"\").trim();",
  "        const ultimaUtil = crudo",
  "          .split(/\\r?\\n/)",
  "          .map((l) => l.trim())",
  "          .filter((l) => l && /ERROR|WARNING|Unable|not available|Sign in/i.test(l))",
  "          .pop() || crudo.split(/\\r?\\n/).filter(Boolean).pop() || \"\";",
  "        if (crudo) {",
  "          try {",
  "            await fs.writeFile(",
  "              path.join(downloadDir, \"error-ytdlp.txt\"),",
  "              `URL: ${job.videoUrl}\\n\\n${crudo}\\n`,",
  "              \"utf8\",",
  "            );",
  "          } catch (_) { /* el diagnostico no debe romper la ejecucion */ }",
  "        }",
  "        const detalle = ultimaUtil ? ` - ${ultimaUtil.replace(/^ERROR:\\s*/i, \"\")}` : \"\";",
  "        throw new Error(",
  "          `No se pudo descargar el video (codigo ${error.code || \"?\"}${detalle}). ` +",
  "          `Se guardo el detalle completo en ${path.join(downloadDir, \"error-ytdlp.txt\")}.`",
  "        );",
  MARK + " fin",
].join("\n");

src = src.replace(ANCLA_MENSAJE, NUEVO_BLOQUE);
ok("Mensaje de error ahora muestra el motivo real.");

// (b) parseVideoUrl: aceptar /t/, subdominios de idioma y sin protocolo.
const ANCLA_REGEX =
  "  const match = value.match(\n" +
  "    /^https?:\\/\\/(?:www\\.|m\\.)?tiktok\\.com\\/(@[^/?#]+)\\/video\\/(\\d+)/i\n" +
  "  );";

if (src.includes(ANCLA_REGEX)) {
  const NUEVO_REGEX = [
    "  " + MARK + " regex",
    "  // Acepta, ademas del enlace canonico:",
    "  //   - sin protocolo (www.tiktok.com/...)",
    "  //   - subdominios de idioma (es.tiktok.com, m.tiktok.com...)",
    "  const normalizado = /^https?:\\/\\//i.test(value) ? value : `https://${value}`;",
    "  const match = normalizado.match(",
    "    /^https?:\\/\\/(?:[a-z0-9-]+\\.)?tiktok\\.com\\/(@[^/?#]+)\\/video\\/(\\d+)/i",
    "  );",
  ].join("\n");

  src = src.replace(ANCLA_REGEX, NUEVO_REGEX);
  ok("parseVideoUrl acepta mas formatos de enlace.");
} else {
  info("El regex de parseVideoUrl ya es distinto; no lo toco.");
}

// (c) Enlaces cortos /t/ (boton Compartir).
const ANCLA_CORTOS =
  "  if (/^https?:\\/\\/(?:vm|vt)\\.tiktok\\.com\\//i.test(value)) {\n" +
  "    return { url: value, username: \"\", id: \"\" };\n" +
  "  }";

if (src.includes(ANCLA_CORTOS)) {
  const NUEVO_CORTOS = [
    "  " + MARK + " cortos",
    "  // vm./vt. y tambien el /t/ del boton Compartir; yt-dlp los resuelve.",
    "  if (/^https?:\\/\\/(?:www\\.|m\\.)?tiktok\\.com\\/t\\//i.test(value)) {",
    "    return { url: value, username: \"\", id: \"\" };",
    "  }",
    "  if (/^https?:\\/\\/(?:vm|vt)\\.tiktok\\.com\\//i.test(value)) {",
    "    return { url: value, username: \"\", id: \"\" };",
    "  }",
  ].join("\n");

  src = src.replace(ANCLA_CORTOS, NUEVO_CORTOS);
  ok("Enlaces cortos /t/ ahora se aceptan.");
} else {
  info("El bloque de enlaces cortos ya es distinto; no lo toco.");
}

// --- 4. Guardar ------------------------------------------------
console.log("");
console.log("[4/4] Guardando y comprobando...");

const backup = TARGET + ".backup-" + Date.now();
try {
  fs.copyFileSync(TARGET, backup);
} catch (e) {
  die("No pude crear copia de seguridad: " + e.message);
}
info("Copia de seguridad: " + path.basename(backup));

const tmp = TARGET + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, src, "utf8");
  fs.renameSync(tmp, TARGET);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  die("No pude escribir controller.js: " + e.message);
}

const { spawnSync } = require("child_process");
const check = spawnSync(process.execPath, ["--check", TARGET], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(check.stderr || check.stdout);
  die("La sintaxis fallo. Restaura: " + path.basename(backup));
}
ok("Sintaxis correcta.");

console.log("");
console.log("============================================================");
console.log("  Listo. Ahora haz esto:");
console.log("");
console.log("   1. Arranca:  npm run dashboard   (o ARRANCAR.bat)");
console.log("   2. Repite el AutoClone con la URL del video.");
console.log("   3. En vez de 'Command failed...' veras el motivo REAL,");
console.log("      por ejemplo:");
console.log("        ... (codigo 1 - Video not available)");
console.log("        ... (codigo 1 - Sign in to confirm you are not a bot)");
console.log("");
console.log("   4. Ademas se guarda el detalle completo en:");
console.log("      <carpeta del job>\\downloads\\error-ytdlp.txt");
console.log("");
console.log("  Mandame ese texto y te digo el arreglo exacto.");
console.log("");
console.log("  Para deshacer: restaura el .backup-*");
console.log("============================================================");
console.log("");
