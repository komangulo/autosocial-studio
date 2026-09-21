#!/usr/bin/env node
/**
 * instalar-typesafe-decision.js
 * Integra TypeSafe (System One / Jev) como PRIMERA capa de decision en
 * AutoSocial Studio, Fases 0-2:
 *
 *   Fase 0  Cimiento: src/typesafe-questions.js + decide() en src/typesafe.js.
 *   Fase 1  Radar: filtro de relevancia + tienda de afiliado (assets/acct-radar.js).
 *   Fase 2  Validador de publicacion (assets/x-autopilot.js, assets/acct-publisher.js).
 *
 * Idempotente: cada cambio lleva un marcador unico y no se repite.
 * Seguro: si TypeSafe no esta configurado, no cambia el comportamiento.
 *
 * USO (desde la raiz del proyecto):
 *   node instalar-typesafe-decision.js
 *
 * Requiere haber instalado antes el cliente: node instalar-typesafe.js --key ...
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();
const HERE = __dirname;

function log(m) { console.log(m); }
function ok(m) { console.log("OK  " + m); }
function skip(m) { console.log("--  " + m); }
function fail(m) { console.error("\n[ERROR] " + m); process.exit(1); }

function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function write(p, t) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
}
function readHere(name) {
  const p = path.join(HERE, name);
  if (!fs.existsSync(p)) fail(`Falta ${name} junto al instalador.`);
  return fs.readFileSync(p, "utf8");
}
function check(rel) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], { stdio: "pipe" });
    return true;
  } catch (e) {
    return e.stderr ? e.stderr.toString() : String(e.message);
  }
}

// ---------------------------------------------------------------------------
// 0. Comprobaciones previas
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(ROOT, "src", "dashboard-server.js"))) {
  fail("No encuentro src/dashboard-server.js. Ejecuta desde la raiz de autosocial-studio.");
}
log("Proyecto: " + ROOT);

// El cliente del servidor debe existir (instalar-typesafe.js). Si no, lo creamos.
let needClient = true;
const clientPath = path.join(ROOT, "src", "typesafe.js");
const clientNow = read(clientPath);
if (clientNow && clientNow.includes("async function decide(")) {
  skip("src/typesafe.js ya tiene decide() (cliente al dia).");
  needClient = false;
} else if (clientNow && !clientNow.includes("parseEnvFile")) {
  log("AVISO src/typesafe.js parece la version antigua; se actualizara.");
}

// ---------------------------------------------------------------------------
// 1. Fase 0a: src/typesafe-questions.js  (preguntas + umbrales, un solo sitio)
// ---------------------------------------------------------------------------
const qSrc = readHere("typesafe-questions.js");
const qDst = path.join(ROOT, "src", "typesafe-questions.js");
const qNow = read(qDst);
if (qNow && qNow.includes("TSAFE-Q-v1") && qNow === qSrc) {
  skip("src/typesafe-questions.js ya estaba instalado e igual.");
} else {
  write(qDst, qSrc);
  ok("src/typesafe-questions.js instalado (preguntas y umbrales).");
}

// ---------------------------------------------------------------------------
// 2. Fase 0b: src/typesafe.js  (cliente + decide())
// ---------------------------------------------------------------------------
const cSrc = readHere("typesafe.js");
if (needClient || !read(clientPath) || !read(clientPath).includes("async function decide(")) {
  write(clientPath, cSrc);
  ok("src/typesafe.js actualizado (cliente + decide()).");
} else {
  skip("src/typesafe.js sin cambios.");
}

// ---------------------------------------------------------------------------
// 3. Fase 1: assets/acct-radar.js  (relevancia + afiliado)
// ---------------------------------------------------------------------------
{
  const rel = "assets/acct-radar.js";
  const p = path.join(ROOT, rel);
  let t = read(p);
  let changed = false;

  const helperAnchor = "function matchesKeywords(text, keywords) {";
  const helperMarker = "TSAFE-RADAR-HELPER";
  if (!t) skip(`${rel} no existe; se omite (radar no instalado).`);
  else if (!t.includes(helperMarker) && t.includes(helperAnchor)) {
    const block = readHere("patch-radar-helpers.txt");
    t = t.replace(helperAnchor, block + "\n" + helperAnchor);
    changed = true;
  } else if (t.includes(helperMarker)) {
    skip(`${rel}: helpers TypeSafe ya presentes.`);
  }

  const filterAnchor = 'if (!matchesKeywords(post.text, keywords)) { skipped.push({ id, why: "fuera de tema" }); continue; }';
  if (t && !t.includes("TSAFE-RADAR-FILTER") && t.includes(filterAnchor)) {
    const block = readHere("patch-radar-filter.txt");
    t = t.replace(filterAnchor, filterAnchor + block);
    changed = true;
  } else if (t && t.includes("TSAFE-RADAR-FILTER")) {
    skip(`${rel}: filtro TypeSafe ya presente.`);
  }

  const affAnchor = "          const res = affiliateUrlFor(raw, cfg);\n          if (res && res.applied) affLinks.push(res);";
  if (t && !t.includes("TSAFE-RADAR-AFF") && t.includes(affAnchor)) {
    const block = readHere("patch-radar-affiliate.txt");
    t = t.replace(affAnchor, block);
    changed = true;
  } else if (t && t.includes("TSAFE-RADAR-AFF")) {
    skip(`${rel}: afiliado TypeSafe ya presente.`);
  }

  const storeAnchor = "function affiliateUrlFor(rawUrl, cfg) {\n  const store = detectStore(rawUrl);\n  if (!store) return null;";
  const storeNew = "function affiliateUrlFor(rawUrl, cfg) {\n  // TSAFE-RADAR-STORE: TypeSafe puede haber decidido ya la tienda.\n  const store = detectStore(rawUrl) || (cfg.affiliate && cfg.affiliate.__store) || null;\n  if (!store) return null;";
  if (t && !t.includes("TSAFE-RADAR-STORE") && t.includes(storeAnchor)) {
    t = t.replace(storeAnchor, storeNew);
    changed = true;
  }

  if (changed) { write(p, t); ok(`${rel} actualizado (TypeSafe en radar).`); }
  else if (t) skip(`${rel}: sin cambios.`);
}

// ---------------------------------------------------------------------------
// 4. Fase 2a: assets/x-autopilot.js  (validador antes de publicar)
// ---------------------------------------------------------------------------
{
  const rel = "assets/x-autopilot.js";
  const p = path.join(ROOT, rel);
  let t = read(p);
  let changed = false;

  if (!t) skip(`${rel} no existe; se omite.`);
  else {
    const fnAnchor = "function itemLanguage(item) {";
    if (!t.includes("TSAFE-XAP-QUALITY") && t.includes(fnAnchor)) {
      const block = readHere("patch-xap-quality.txt");
      t = t.replace(fnAnchor, block + "\n" + fnAnchor);
      changed = true;
    } else if (t.includes("TSAFE-XAP-QUALITY")) skip(`${rel}: validador ya presente.`);

    const callAnchor = `    if (clean.length > limit) {
      throw new Error(\`El texto de la IA supera \${limit} caracteres (\${clean.length}).\`);
    }`;
    if (t && !t.includes("TSAFE-XAP-CALL") && t.includes(callAnchor)) {
      const block = readHere("patch-xap-call.txt");
      t = t.replace(callAnchor, callAnchor + block);
      changed = true;
    } else if (t && t.includes("TSAFE-XAP-CALL")) skip(`${rel}: llamada validador ya presente.`);
  }

  if (changed) { write(p, t); ok(`${rel} actualizado (validador TypeSafe).`); }
}

// ---------------------------------------------------------------------------
// 5. Fase 2b: assets/acct-publisher.js  (validador en publicacion diaria)
// ---------------------------------------------------------------------------
{
  const rel = "assets/acct-publisher.js";
  const p = path.join(ROOT, rel);
  let t = read(p);
  let changed = false;

  if (!t) skip(`${rel} no existe; se omite.`);
  else {
    const acpMarker = "TSAFE-ACP-CALL";
    const acpAnchor = "  if (text.length > max) throw new Error(`El texto supera ${max} caracteres (${text.length}).`);";
    if (!t.includes(acpMarker) && t.includes(acpAnchor)) {
      const block = readHere("patch-acp-call.txt");
      t = t.replace(acpAnchor, acpAnchor + block);
      // Anadir la funcion typesafeQuality al final del archivo (una sola vez).
      if (!t.includes("TSAFE-ACP-QUALITY")) {
        t = t.replace(/\s*$/, "\n\n" + readHere("patch-acp-fn.txt") + "\n");
      }
      changed = true;
    } else if (t.includes(acpMarker)) skip(`${rel}: validador ya presente.`);
    else skip(`${rel}: no encontre el punto de publicacion (text.length check).`);
  }

  if (changed) { write(p, t); ok(`${rel} actualizado (validador TypeSafe).`); }
}

console.log("\nComprobando sintaxis de los archivos tocados...");
const files = [
  "src/typesafe.js",
  "src/typesafe-questions.js",
  "assets/acct-radar.js",
  "assets/x-autopilot.js",
  "assets/acct-publisher.js",
];
let bad = [];
for (const f of files) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const r = check(f);
  if (r === true) ok(`node --check ${f}`);
  else bad.push(`${f}: ${r}`);
}
if (bad.length) fail("Algun archivo no compila:\n" + bad.join("\n"));

console.log("\nListo. TypeSafe queda como primera capa de decision (Fases 0-2).");
console.log("Si TypeSafe no tiene clave, la herramienta sigue funcionando igual que antes.");
