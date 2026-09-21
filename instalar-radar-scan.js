#!/usr/bin/env node
/*
 * instalar-radar-scan.js
 * ---------------------------------------------------------------------------
 * Arregla que el RADAR "no escanee": al pulsar "Escanear sin publicar" / "Escanear
 * y publicar ahora" no encontraba nada y no decia por que.
 *
 * Causas que corrige:
 *   1. scanKeyword solo buscaba `article[data-testid="tweet"]`, esperaba 3,5 s y
 *      NO hacia scroll ni detectaba el muro de login -> 0 resultados en silencio.
 *   2. El endpoint /now devolvia el historial antiguo en vez del resultado del
 *      escaneo, asi que la UI nunca mostraba cuantos tweets se leyeron.
 *   3. Si la ventana de login estaba abierta pero SIN sesion, se reutilizaba y
 *      se buscaba como invitado. Ahora avisa claro.
 *
 * Uso:  node instalar-radar-scan.js    (desde la raiz del proyecto)
 * Idempotente. Hace copia .bak-scan de lo que reemplaza.
 * ---------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
let changes = 0, errors = 0, skipped = 0;
function ok(m) { changes++; console.log("  [OK]    " + m); }
function skip(m) { skipped++; console.log("  [SKIP]  " + m); }
function fail(m) { errors++; console.error("  [FALLO] " + m); }
function read(rel) { const p = path.join(ROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; }
function write(rel, c) { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, "utf8"); }
function backup(rel) {
  const p = path.join(ROOT, rel);
  const b = p + ".bak-scan";
  if (fs.existsSync(p) && !fs.existsSync(b)) fs.writeFileSync(b, fs.readFileSync(p, "utf8"));
}
function readAsset(name) {
  for (const c of [path.join(__dirname, "assets", name), path.join(ROOT, "assets", name)]) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  throw new Error("Falta el asset: " + name);
}

console.log("\n=== Instalador: arreglar el escaneo del radar ===\n");
if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.error("No parece la raiz del proyecto (falta package.json).");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "src", "acct-radar.js"))) {
  console.error("No encuentro src/acct-radar.js. Ejecuta primero el instalador del radar.");
  process.exit(1);
}

// --- 1. Motor del radar ----------------------------------------------------
(function motor() {
  console.log("1) src/acct-radar.js");
  const cur = read("src/acct-radar.js");
  if (cur && cur.includes("ACCT-RADAR-v4")) { skip("el motor ya funciona sin analizar la cuenta"); return; }
  const asset = readAsset("acct-radar.js");
  if (!asset.includes("ACCT-RADAR-v4")) { fail("el asset no es la version v4"); return; }
  backup("src/acct-radar.js");
  write("src/acct-radar.js", asset);
  ok("motor reemplazado (sin cuenta analizada, con informe del escaneo)");
})();

// --- 2. Sesion de X: no reutilizar una ventana sin login -------------------
(function xauth() {
  console.log("2) src/x-auth.js");
  const cur = read("src/x-auth.js");
  if (!cur) { fail("no existe src/x-auth.js"); return; }
  if (cur.includes("XAP-AUTH-v3")) { skip("x-auth ya comprueba la sesion reutilizada"); return; }
  const asset = readAsset("x-auth.js");
  if (!asset.includes("XAP-AUTH-v3")) { fail("el asset x-auth no es la version v3"); return; }
  backup("src/x-auth.js");
  write("src/x-auth.js", asset);
  ok("x-auth actualizado (avisa si la ventana de login no tiene sesion)");
})();

// --- 3. UI del radar -------------------------------------------------------
(function ui() {
  console.log("3) web/acct-radar-ui.js");
  const cur = read("web/acct-radar-ui.js");
  if (!cur) { fail("no existe web/acct-radar-ui.js"); return; }
  if (cur.includes("ACCT-RADAR-UI-v4")) { skip("la UI ya funciona sin analizar la cuenta"); return; }
  const asset = readAsset("acct-radar-ui.js");
  if (!asset.includes("ACCT-RADAR-UI-v4")) { fail("el asset de UI no es la version v4"); return; }
  backup("web/acct-radar-ui.js");
  write("web/acct-radar-ui.js", asset);
  ok("UI actualizada (no pide cuenta; dice cuantos tweets se leyeron)");
})();

// --- 4. Endpoint /now ------------------------------------------------------
(function route() {
  console.log("4) src/dashboard-server.js");
  let cur = read("src/dashboard-server.js");
  if (!cur) { fail("no existe src/dashboard-server.js"); return; }

  const routeStart = cur.indexOf('  app.post("/api/acct-radar/:handle/now"');
  if (routeStart === -1) {
    fail("no se encontro la ruta /api/acct-radar/:handle/now");
    return;
  }
  // Fin de la ruta: el "  });" que cierra el handler, despues de "} catch".
  // No dependemos de que exista la ruta /stop (puede faltar o estar movida).
  const catchIdx = cur.indexOf("} catch", routeStart);
  let routeEnd = catchIdx === -1 ? -1 : cur.indexOf("\n  });", catchIdx);
  routeEnd = routeEnd === -1 ? -1 : routeEnd + "\n  });".length;
  if (routeEnd === -1 || routeEnd <= routeStart) {
    fail("no se encontro el cierre de la ruta /api/acct-radar/:handle/now");
    return;
  }

  // Reescribe SIEMPRE la ruta a la version buena. Es la unica forma segura de
  // eliminar restos de parches anteriores (p. ej. un `const profile` de mas).
  const routeNew = `  app.post("/api/acct-radar/:handle/now", async (req, res) => {
    try {
      const run = await acctRadar.runOnce(req.params.handle, { dryRun: req.body?.dryRun === true, force: true });
      const profile = acctRadar.getStatus(req.params.handle);
      res.json({ ok: true, result: { published: run.published || [], skipped: run.skipped || 0, scan: run.scan || null }, profile });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

`;
  const rebuilt = cur.slice(0, routeStart) + routeNew + cur.slice(routeEnd);
  const alreadyGood = cur.slice(routeStart, routeEnd).trim() ===
    `app.post("/api/acct-radar/:handle/now", async (req, res) => {
    try {
      const run = await acctRadar.runOnce(req.params.handle, { dryRun: req.body?.dryRun === true, force: true });
      const profile = acctRadar.getStatus(req.params.handle);
      res.json({ ok: true, result: { published: run.published || [], skipped: run.skipped || 0, scan: run.scan || null }, profile });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });`.trim();
  if (alreadyGood) {
    skip("la ruta /now ya es correcta");
    return;
  }
  backup("src/dashboard-server.js");
  write("src/dashboard-server.js", rebuilt);
  ok("ruta /now reescrita (se eliminan restos de parches anteriores)");
})();

// --- 0. Reparacion de emergencia: rutas /now duplicadas --------------------
// Detecta si el instalador grande reinserto una segunda ruta /now (porque falto
// su marcador) y deja el archivo con declaraciones duplicadas. Elimina copias
// extra dejando solo la que trae el informe del escaneo.
(function dedupeNowRoute() {
  console.log("0) comprobacion de rutas /now duplicadas");
  const p = path.join(ROOT, "src", "dashboard-server.js");
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, "utf8");
  const needle = 'app.post("/api/acct-radar/:handle/now"';
  const idx = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf(needle, from);
    if (i === -1) break;
    idx.push(i);
    from = i + needle.length;
  }
  if (idx.length <= 1) { skip("solo hay una ruta /now"); return; }
  const blocks = idx.map((i) => {
    const start = src.lastIndexOf("\n", i) + 1;
    const endMarker = "  });";
    const e = src.indexOf(endMarker, i);
    const end = e === -1 ? src.length : e + endMarker.length;
    return { start, end, text: src.slice(start, end) };
  });
  let keep = blocks.findIndex((b) => b.text.includes("run.published"));
  if (keep === -1) keep = 0;
  let out = src;
  const drop = blocks.filter((_, i) => i !== keep).sort((a, b) => b.start - a.start);
  for (const b of drop) out = out.slice(0, b.start) + out.slice(b.end);
  out = out.replace(/\n{3,}/g, "\n\n");
  backup("src/dashboard-server.js");
  write("src/dashboard-server.js", out);
  ok("eliminadas " + drop.length + " ruta(s) /now duplicada(s); se conserva la buena");
})();

console.log("\n=== Resumen ===");
console.log("  Cambios: " + changes + "   Omitidos: " + skipped + "   Errores: " + errors + "\n");
if (errors) {
  console.error("Hay errores. Revisa los [FALLO]. No reinicies aun.");
  process.exit(1);
}

// --- 5. Texto del panel: aclarar que no hace falta analizar -----------------
(function clarifyText() {
  console.log("5) web/index.html");
  const p = path.join(ROOT, "web", "index.html");
  if (!fs.existsSync(p)) { skip("no existe web/index.html"); return; }
  let html = fs.readFileSync(p, "utf8");
  const oldText = "El radar escanea X con tu sesion buscando las";
  if (!html.includes(oldText)) {
    if (html.includes("no hace falta analizar ninguna cuenta")) { skip("el texto ya esta aclarado"); return; }
    skip("no se encontro el texto del radar"); return;
  }
  html = html.replace(
    oldText,
    "El radar escanea X con <b>la sesion con la que ya estas logueado</b> (no hace falta analizar ninguna cuenta) buscando las"
  );
  fs.writeFileSync(p, html, "utf8");
  ok("texto del radar aclarado (solo necesita tu sesion de X)");
})();

// --- Verificacion final: que el servidor compila ---------------------------
(function verify() {
  const cp = require("child_process");
  const p = path.join(ROOT, "src", "dashboard-server.js");
  const check = () => {
    try { cp.execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); return null; }
    catch (e) { return String(e.stderr || e.message); }
  };
  let err = check();
  if (!err) {
    console.log("  [OK]    src/dashboard-server.js compila (node --check)");
    return;
  }

  // Red de seguridad: elimina declaraciones 'const X' repetidas en el mismo
  // bloque que sean EXACTAMENTE iguales (p. ej. 'const profile = ...;') y que
  // el parser marque como duplicadas.
  console.log("  [!]     aun no compila; intentando eliminar declaraciones duplicadas...");
  let src = read("src/dashboard-server.js");
  const dupRe = /([ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]+;)\s*\n(\s*)(?:\1)\s*\n/g;
  // Estrategia por bloques: dentro de cada `{ ... }` busca el mismo const dos veces.
  const lines = src.split("\n");
  const seen = new Map(); // bloque -> Map(nombre -> indices)
  // Aproximacion: recorre lineas y elimina la 2a declaracion identica consecutiva.
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && out.length) {
      const prev = out[out.length - 1];
      const prevTrim = prev.trim();
      if (prevTrim === lines[i].trim() && /^\s*(const|let)\s/.test(prevTrim)) {
        removed++;
        continue; // saltar la declaracion identica consecutiva
      }
    }
    out.push(lines[i]);
  }
  if (removed) {
    backup("src/dashboard-server.js");
    write("src/dashboard-server.js", out.join("\n"));
    err = check();
    if (!err) { ok("eliminadas " + removed + " declaracion(es) duplicada(s); ahora compila"); return; }
  }
  console.error("  [FALLO] src/dashboard-server.js sigue con errores de sintaxis:");
  console.error(String(err).split("\n").slice(0, 10).join("\n"));
  console.error("  Copia de seguridad: src/dashboard-server.js.bak-scan");
  process.exit(1);
})();

console.log("Listo. Reinicia el dashboard y pulsa Ctrl+F5.");
console.log("Al escanear, el cuadro azul te dira exactamente cuantos tweets se leyeron.");
