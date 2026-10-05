#!/usr/bin/env node
/*
 * ARREGLO: "Idioma del titulo y descripcion = Original" no se respetaba al
 *          usar el boton "Descargar" (start-download) del autoclone.
 *
 * Causa exacta:
 *   - El backend decide traducir asi (src/autoclone/controller.js):
 *       metadataLanguage: options.metadataLanguage === "original" ? "original" : "es"
 *     Es decir, si no le llega el idioma, TRADUCE (es).
 *   - La peticion de descarga de perfil (web/autoclone.js, /api/autoclone/start-download)
 *     NO enviaba el campo metadataLanguage, asi que llegaba undefined -> "es".
 *   - El otro boton (/api/autoclone/start) SI lo enviaba. Por eso a veces
 *     funcionaba y a veces no.
 *
 * Arreglo: anadir metadataLanguage a la peticion de start-download, leyendo el
 * desplegable igual que en start.
 *
 * Solo toca web/autoclone.js. Idempotente. Con --revert.
 *
 * Uso:
 *   node arreglar-idioma-original-autoclone.js
 *   node arreglar-idioma-original-autoclone.js --revert
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const REVERT = process.argv.slice(2).some((a) => a === "--revert" || a === "--undo");
const MARK = "ARREGLO-IDIOMA-ORIGINAL-AUTOCLONE";
const REL = "web/autoclone.js";

function log(m) { console.log(`[${MARK}] ${m}`); }
const full = (rel) => path.resolve(ROOT, rel);

// Bloque original de la peticion start-download (identificado con su marcador unico).
const OLD = `      const data = await API.post("/api/autoclone/start-download", {
        username,
        lastPublishedUrl: markerUrl,
        maxVideos: Number(els.maxVideos.value) || 0,
        downloadOrder: els.downloadOrder?.value || "oldest",
        downloadThumbnail: Boolean(els.downloadThumbnail?.checked),
        startMode: els.startMode?.value || "continue",
        destinationRoot,
      });`;

const NEW = `      const data = await API.post("/api/autoclone/start-download", {
        username,
        lastPublishedUrl: markerUrl,
        maxVideos: Number(els.maxVideos.value) || 0,
        downloadOrder: els.downloadOrder?.value || "oldest",
        downloadThumbnail: Boolean(els.downloadThumbnail?.checked),
        startMode: els.startMode?.value || "continue",
        // MARKER: ARREGLO-IDIOMA-ORIGINAL-AUTOCLONE
        // Sin esto, la descarga de perfil no enviaba el idioma y el backend
        // traducia siempre (asumia "es"). Con "Original" debe quedarse igual.
        metadataLanguage: els.metadataLanguage?.value || "es",
        destinationRoot,
      });`;

function apply() {
  const f = full(REL);
  if (!fs.existsSync(f)) throw new Error(`No encuentro ${REL}. Ejecuta esto desde la carpeta del proyecto.`);
  let text = fs.readFileSync(f, "utf8");

  if (text.includes(`MARKER: ${MARK}`)) { log("ya estaba aplicado. Sin cambios."); return; }

  if (!text.includes(OLD)) {
    throw new Error("No encuentro la peticion de start-download esperada. Avisa a tu asistente (el archivo no coincide).");
  }

  const backup = `${f}.bak-${MARK}-${Date.now()}`;
  fs.copyFileSync(f, backup);
  text = text.replace(OLD, NEW);
  fs.writeFileSync(f, text, "utf8");
  log(`anadido metadataLanguage a /api/autoclone/start-download en ${REL}`);
  log(`backup: ${path.basename(backup)}`);
  log("Listo. Reinicia el dashboard y recarga el navegador (Ctrl+F5).");
}

function revert() {
  const dir = path.dirname(full(REL));
  const baks = fs.readdirSync(dir).filter((x) => x.startsWith(`${path.basename(REL)}.bak-${MARK}-`)).sort();
  if (!baks.length) { log("Nada que revertir."); return; }
  fs.copyFileSync(path.resolve(dir, baks[baks.length - 1]), full(REL));
  log(`revertido ${REL} desde ${baks[baks.length - 1]}`);
}

if (REVERT) revert(); else apply();
