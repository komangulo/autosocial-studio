#!/usr/bin/env node
/**
 * AutoSocial Studio - Indicador en vivo del modelo activo
 * =======================================================
 * QUE HACE
 *   Anade un panel fijo en AutoClone que dice, EN TODO MOMENTO, que modelo
 *   esta trabajando en ese instante: si es uno de xKiro (y cual), DeepSeek,
 *   Gemini o OpenRouter. Ademas deja el historial del ultimo lote.
 *
 *   Tres piezas:
 *     1. src/autoclone/text-overlay.js
 *        - Registro unificado del modelo activo de TODA la cadena,
 *          no solo xKiro. Se actualiza en cada intento.
 *        - Exporta modelActivity() con el estado + historial.
 *     2. src/autoclone/index.js
 *        - GET /api/autoclone/modelo  ->  que modelo trabaja ahora
 *     3. web/index.html + web/autoclone.js
 *        - Panel fijo "Modelo en uso" que se refresca solo cada segundo,
 *          visible mientras AutoClone trabaja.
 *
 *   Idempotente: marcadores unicos. Si ya esta, no toca nada.
 *
 * REQUISITO
 *   Necesita la rotacion de xKiro instalada (instalar-xkiro-rotacion.js).
 *
 * USO
 *   node instalar-xkiro-indicador.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const M = "XKI[indicador]";

let cambios = 0, yaEstaba = 0;
const fallos = [];

const ok   = (m) => console.log("  [OK]   " + m);
const log  = (m) => console.log(m);

function leer(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fallos.push("No existe: " + rel); return null; }
  return { p, txt: fs.readFileSync(p, "utf8") };
}
function guardar(f, txt) {
  const tmp = f.p + ".xki-tmp";
  fs.writeFileSync(tmp, txt, "utf8");
  fs.renameSync(tmp, f.p);
}
function insertarTrasLinea(txt, ancla, bloque) {
  const i = txt.indexOf(ancla);
  if (i === -1) return null;
  const salto = txt.indexOf("\n", i);
  return txt.slice(0, salto) + bloque + txt.slice(salto);
}

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - Indicador en vivo del modelo");
console.log("============================================================");
console.log("");

// ------------------------------------------------------------- paso 0
log("[0/5] Comprobando el proyecto...");
if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.log("  [ERROR] No veo package.json. Ejecuta esto en la raiz del proyecto.");
  process.exit(1);
}
const overlayPath = path.join(ROOT, "src", "autoclone", "text-overlay.js");
if (!fs.existsSync(overlayPath)) {
  console.log("  [ERROR] No veo src/autoclone/text-overlay.js.");
  process.exit(1);
}
ok("Proyecto encontrado.");

// ------------------------------------------------------------- paso 1
log("");
log("[1/5] Registro del modelo activo (text-overlay.js)...");
{
  const f = leer("src/autoclone/text-overlay.js");
  if (f) {
    let t = f.txt, tocado = false;

    if (t.includes(M + "[state]")) {
      yaEstaba++;
      ok("El registro ya estaba puesto.");
    } else if (!t.includes("__xKiroEstado")) {
      console.log("  [ERROR] No encuentro la rotacion de xKiro.");
      console.log("          Ejecuta primero: node instalar-xkiro-rotacion.js");
      process.exit(1);
    } else {
      // Insertar el registro justo despues del bloque de constantes de xKiro.
      const ancla = "const XKIRO_MAX_ROUNDS = 3;";
      if (t.includes(ancla)) {
        const bloque =
          "\n\n// " + M + "[state] inicio - modelo activo de TODA la cadena\n" +
          "// Se actualiza en cada intento, venga de xKiro, DeepSeek, Gemini u OpenRouter.\n" +
          "// Sirve para que la app pueda decir en todo momento que modelo trabaja.\n" +
          "const __modeloActivo = {\n" +
          "  modelo: \"\",            // id completo, p.ej. \"minimax/minimax-m3:free\"\n" +
          "  corto: \"\",             // nombre legible\n" +
          "  proveedor: \"\",         // \"xKiro\" | \"DeepSeek\" | \"Gemini\" | \"OpenRouter\"\n" +
          "  detalle: \"\",           // texto largo para la interfaz\n" +
          "  desde: 0,               // cuando empezo este modelo (ms)\n" +
          "  lote: 0,                // lote de fotogramas actual\n" +
          "  totalLotes: 0,\n" +
          "  historial: [],          // ultimos modelos usados\n" +
          "};\n" +
          "if (typeof globalThis !== \"undefined\") globalThis.__modeloActivo = __modeloActivo;\n" +
          "\n" +
          "/** Marca que modelo esta trabajando ahora mismo. */\n" +
          "function marcarModelo(proveedor, modelo, { detalle = \"\", lote = 0, totalLotes = 0 } = {}) {\n" +
          "  const s = globalThis.__modeloActivo || __modeloActivo;\n" +
          "  const corto = String(modelo || \"\").split(\"/\").pop() || modelo || \"\";\n" +
          "  const cambio = s.modelo !== modelo;\n" +
          "  s.modelo = modelo || \"\";\n" +
          "  s.corto = corto;\n" +
          "  s.proveedor = proveedor || \"\";\n" +
          "  s.detalle = detalle || `${proveedor} usando ${corto}`;\n" +
          "  s.desde = Date.now();\n" +
          "  s.lote = lote;\n" +
          "  s.totalLotes = totalLotes;\n" +
          "  if (cambio) {\n" +
          "    s.historial.unshift({ proveedor, modelo: modelo || \"\", corto, at: new Date().toISOString() });\n" +
          "    if (s.historial.length > 12) s.historial.length = 12;\n" +
          "  }\n" +
          "  return s;\n" +
          "}\n" +
          "\n" +
          "/** Estado del modelo activo, para la app. */\n" +
          "function modelActivity() {\n" +
          "  const s = globalThis.__modeloActivo || __modeloActivo;\n" +
          "  return {\n" +
          "    modelo: s.modelo,\n" +
          "    corto: s.corto,\n" +
          "    proveedor: s.proveedor,\n" +
          "    detalle: s.detalle,\n" +
          "    segundos: s.desde ? Math.round((Date.now() - s.desde) / 1000) : 0,\n" +
          "    lote: s.lote,\n" +
          "    totalLotes: s.totalLotes,\n" +
          "    historial: s.historial.slice(0, 12),\n" +
          "  };\n" +
          "}\n" +
          "// " + M + "[state] fin";
        t = insertarTrasLinea(t, ancla, bloque);
        tocado = true;
      } else {
        fallos.push("No encontre XKIRO_MAX_ROUNDS para anclar el registro.");
      }
    }

    if (tocado) { guardar(f, t); ok("Registro del modelo activo anadido."); cambios++; }
  }
}

// ------------------------------------------------------------- paso 2
log("");
log("[2/5] Marcando cada modelo en la cadena...");
{
  const f = leer("src/autoclone/text-overlay.js");
  if (f) {
    let t = f.txt, n = 0;

    const marcas = [
      {
        marker: M + "[xkiro]",
        // El mensaje varia segun la version de la rotacion instalada:
        //   "...xKiro ${corto} (modelo N/4)..." o "...xKiro ${corto}..."
        anclas: [
          'onProgress?.({ stage: "text-vision", detail: `Leyendo texto con xKiro ${corto} (modelo ${estado.indice + 1}/${XKIRO_MODELS.length})...` });',
          'onProgress?.({ stage: "text-vision", detail: `Leyendo texto con xKiro ${corto}...` });',
        ],
        inserta: '\n      marcarModelo("xKiro", elegido, { detalle: `xKiro ${corto}` }); // ' + M + "[xkiro]",
      },
      {
        marker: M + "[gemini-free]",
        // Paso 1: Gemini gratis. Marcamos antes de intentar el candidato.
        anclas: [
          "        try {\n          text = await callGeminiVision(apiKey, candidate, parts, width, height);",
        ],
        inserta: '\n          marcarModelo("Gemini", candidate, { detalle: `Gemini gratis (${candidate})` }); // ' + M + "[gemini-free]",
      },
      {
        marker: M + "[openrouter]",
        anclas: [
          'onProgress?.({ stage: "text-fallback", detail: `Traduciendo con OpenRouter (${orModel})...` });',
        ],
        inserta: '\n              marcarModelo("OpenRouter", orModel, { detalle: `OpenRouter (${orModel})` }); // ' + M + "[openrouter]",
      },
      {
        marker: M + "[deepseek]",
        anclas: [
          'onProgress?.({ stage: "text-fallback", detail: "Traduciendo con DeepSeek 4.1 Flash..." });',
        ],
        inserta: '\n          marcarModelo("DeepSeek", DEEPSEEK_MODEL, { detalle: "DeepSeek 4.1 Flash" }); // ' + M + "[deepseek]",
      },
      {
        marker: M + "[gemini-pago]",
        anclas: [
          'onProgress?.({ stage: "text-fallback", detail: "Cuota gratis agotada; usando Gemini de pago (gemini-3.6-flash)..." });',
        ],
        inserta: '\n      marcarModelo("Gemini", candidate || DEFAULT_VISION_MODEL, { detalle: "Gemini de pago" }); // ' + M + "[gemini-pago]",
      },
    ];

    for (const mk of marcas) {
      if (t.includes(mk.marker)) continue;
      const ancla = (mk.anclas || [mk.ancla]).find((a) => a && t.includes(a));
      if (!ancla) { fallos.push("No encontre el ancla " + mk.marker); continue; }
      const i = t.indexOf(ancla);
      const salto = t.indexOf("\n", i);
      t = t.slice(0, salto) + mk.inserta + t.slice(salto);
      n++;
    }

    if (n) { guardar(f, t); ok("Marcado " + n + " punto(s) de la cadena."); cambios++; }
    else if (t.includes(M + "[xkiro]") || t.includes(M + "[deepseek]")) ok("Las marcas ya estaban puestas.");
  }
}

// ------------------------------------------------------------- paso 3
log("");
log("[3/5] Marcando lote/fotogramas (contexto)...");
{
  const f = leer("src/autoclone/text-overlay.js");
  if (f) {
    if (f.txt.includes(M + "[lote]")) { ok("El contexto de lote ya estaba."); yaEstaba++; }
    else {
      const ancla = 'onProgress?.({ stage: "text-vision", detail: `Leyendo texto en pantalla (${index + batch.length}/${frames.length})...` });';
      if (f.txt.includes(ancla)) {
        const i = f.txt.indexOf(ancla);
        const salto = f.txt.indexOf("\n", i);
        const bloque =
          "\n    // " + M + "[lote] registro del lote para el indicador\n" +
          "    if (globalThis.__modeloActivo) {\n" +
          "      globalThis.__modeloActivo.lote = index + batch.length;\n" +
          "      globalThis.__modeloActivo.totalLotes = frames.length;\n" +
          "    }";
        const t = f.txt.slice(0, salto) + bloque + f.txt.slice(salto);
        guardar(f, t);
        ok("Contexto de lote anadido.");
        cambios++;
      } else {
        fallos.push("No encontre el mensaje de lote para el contexto.");
      }
    }
  }
}

// ------------------------------------------------------------- paso 4
log("");
log("[4/5] Endpoint + exportacion (text-overlay.js, index.js)...");
{
  const f = leer("src/autoclone/text-overlay.js");
  if (f) {
    if (f.txt.includes(M + "[export]")) { ok("La exportacion ya estaba."); yaEstaba++; }
    else {
      const ancla = "  xKiroRotateStatus,";
      if (f.txt.includes(ancla)) {
        const i = f.txt.indexOf(ancla);
        const salto = f.txt.indexOf("\n", i);
        const bloque = "\n  modelActivity, // " + M + "[export]";
        const t = f.txt.slice(0, salto) + bloque + f.txt.slice(salto);
        guardar(f, t);
        ok("modelActivity exportada.");
        cambios++;
      } else if (f.txt.includes("module.exports = {")) {
        const i = f.txt.indexOf("module.exports = {");
        const salto = f.txt.indexOf("\n", i);
        const bloque = "\n  modelActivity, // " + M + "[export]";
        const t = f.txt.slice(0, salto) + bloque + f.txt.slice(salto);
        guardar(f, t);
        ok("modelActivity exportada.");
        cambios++;
      } else {
        fallos.push("No encontre module.exports para exportar modelActivity.");
      }
    }
  }

  const g = leer("src/autoclone/index.js");
  if (g) {
    if (g.txt.includes(M + "[ruta]")) { ok("El endpoint ya estaba."); yaEstaba++; }
    else {
      // Anclamos en /progress, que existe siempre (no depende del panel).
      const ancla = 'router.get("/progress", route(async (req, res) => {';
      if (g.txt.includes(ancla)) {
        const i = g.txt.indexOf(ancla);
        const ini = g.txt.lastIndexOf("\n", i) + 1;
        const bloque =
          "  // Que modelo de la cadena esta trabajando ahora mismo. // " + M + "[ruta]\n" +
          "  router.get(\"/modelo\", route(async (req, res) => {\n" +
          "    try {\n" +
          "      const { modelActivity } = require(\"./text-overlay\");\n" +
          "      res.json({ ok: true, ...modelActivity() });\n" +
          "    } catch (error) {\n" +
          "      res.json({ ok: false, modelo: \"\", corto: \"\", proveedor: \"\", detalle: \"\", historial: [], error: error.message });\n" +
          "    }\n" +
          "  }));\n\n";
        const t = g.txt.slice(0, ini) + bloque + g.txt.slice(ini);
        guardar(g, t);
        ok("Endpoint GET /api/autoclone/modelo anadido.");
        cambios++;
      } else {
        fallos.push("No encontre la ruta /progress en index.js.");
      }
    }
  }
}

// ------------------------------------------------------------- paso 5
log("");
log("[5/5] Panel en la interfaz (web/index.html, web/autoclone.js)...");
{
  const h = leer("web/index.html");
  if (h) {
    if (h.txt.includes(M + "[html]")) { ok("El panel ya estaba en el HTML."); yaEstaba++; }
    else {
      // Insertar tras la tarjeta de Progreso, dentro de autoclone-main
      const ancla = '<p id="autocloneStage" class="autoclone-stage">';
      if (h.txt.includes(ancla)) {
        // buscar el cierre del div de la tarjeta de progreso
        const i = h.txt.indexOf(ancla);
        const cierre = h.txt.indexOf("</div>", h.txt.indexOf("</p>", i));
        const salto = h.txt.indexOf("\n", cierre);
        const bloque =
          "\n          <div class=\"card autoclone-model-card\">\n" +
          "            <div class=\"card-title\">Modelo en uso ahora</div>\n" +
          "            <div id=\"autocloneModeloActivo\" class=\"autoclone-modelo\">\n" +
          "              <span class=\"autoclone-modelo-prov\">—</span>\n" +
          "              <span class=\"autoclone-modelo-id\">Sin actividad</span>\n" +
          "            </div>\n" +
          "            <p id=\"autocloneModeloDetalle\" class=\"helios-hint\">Cuando empiece el trabajo, aqui vera que modelo esta leyendo los fotogramas en ese instante.</p>\n" +
          "            <div id=\"autocloneModeloHistorial\" class=\"autoclone-modelo-hist\"></div>\n" +
          "          </div> <!-- " + M + "[html] -->";
        const t = h.txt.slice(0, salto) + bloque + h.txt.slice(salto);
        guardar(h, t);
        ok("Panel anadido a la interfaz.");
        cambios++;
      } else {
        fallos.push("No encontre la tarjeta de Progreso en index.html.");
      }
    }
  }

  const j = leer("web/autoclone.js");
  if (j) {
    let t = j.txt, tocado = false;

    // referencias a los elementos
    if (!t.includes(M + "[els]")) {
      const ancla = 'stage: $("autocloneStage"),';
      if (t.includes(ancla)) {
        const i = t.indexOf(ancla);
        const salto = t.indexOf("\n", i);
        const bloque =
          "\n    modeloActivo: $(\"autocloneModeloActivo\"), // " + M + "[els]\n" +
          "    modeloDetalle: $(\"autocloneModeloDetalle\"),\n" +
          "    modeloHistorial: $(\"autocloneModeloHistorial\"),";
        t = t.slice(0, salto) + bloque + t.slice(salto);
        tocado = true;
      } else {
        fallos.push("No encontre las referencias de elementos en autoclone.js.");
      }
    }

    // funcion de sondeo
    if (!t.includes(M + "[poll]")) {
      const ancla = "async function refreshKeyState() {";
      if (t.includes(ancla)) {
        const i = t.indexOf(ancla);
        const bloque =
          "// " + M + "[poll] inicio - preguntar al backend que modelo va\n" +
          "  let modeloPollTimer = null;\n" +
          "  async function refrescarModelo() {\n" +
          "    if (!els.modeloActivo) return;\n" +
          "    try {\n" +
          "      const d = await API.get(\"/api/autoclone/modelo\");\n" +
          "      const prov = d.proveedor || \"—\";\n" +
          "      const corto = d.corto || \"\";\n" +
          "      const provEl = els.modeloActivo.querySelector(\".autoclone-modelo-prov\");\n" +
          "      const idEl = els.modeloActivo.querySelector(\".autoclone-modelo-id\");\n" +
          "      if (provEl) provEl.textContent = prov;\n" +
          "      if (idEl) idEl.textContent = corto || \"Sin actividad\";\n" +
          "      els.modeloActivo.classList.toggle(\"activo\", Boolean(d.modelo));\n" +
          "      els.modeloActivo.classList.toggle(\"es-deepseek\", prov === \"DeepSeek\");\n" +
          "      els.modeloActivo.classList.toggle(\"es-xkiro\", prov === \"xKiro\");\n" +
          "      els.modeloActivo.classList.toggle(\"es-gemini\", prov === \"Gemini\");\n" +
          "      if (els.modeloDetalle) {\n" +
          "        els.modeloDetalle.textContent = d.modelo\n" +
          "          ? `${d.detalle || prov} · hace ${d.segundos}s` + (d.totalLotes ? ` · lote ${d.lote}/${d.totalLotes}` : \"\")\n" +
          "          : \"Sin actividad. Cuando empiece el trabajo, vera aqui el modelo en uso.\";\n" +
          "      }\n" +
          "      if (els.modeloHistorial) {\n" +
          "        const h = (d.historial || []).slice(0, 6);\n" +
          "        els.modeloHistorial.innerHTML = h.length\n" +
          "          ? h.map(x => `<span class=\"autoclone-chip\">${x.proveedor}: ${escapeHtmlJs(x.corto)}</span>`).join(\"\")\n" +
          "          : \"\";\n" +
          "      }\n" +
          "    } catch { /* si falla, no molestamos */ }\n" +
          "  }\n" +
          "  function escapeHtmlJs(s) { return String(s == null ? \"\" : s).replace(/[&<>\\\"']/g, c => ({ \"&\":\"&amp;\", \"<\":\"&lt;\", \">\":\"&gt;\", \"\\\"\":\"&quot;\", \"'\":\"&#39;\" }[c])); }\n" +
          "  function iniciarIndicadorModelo() {\n" +
          "    if (modeloPollTimer) return;\n" +
          "    refrescarModelo();\n" +
          "    modeloPollTimer = setInterval(refrescarModelo, 1000);\n" +
          "  }\n" +
          "  function pararIndicadorModelo() {\n" +
          "    if (modeloPollTimer) { clearInterval(modeloPollTimer); modeloPollTimer = null; }\n" +
          "  }\n" +
          "  // " + M + "[poll] fin\n\n  ";
        t = t.slice(0, i) + bloque + t.slice(i);
        tocado = true;
      } else {
        fallos.push("No encontre refreshKeyState() para colocar el sondeo.");
      }
    }

    // arrancar el sondeo al entrar en la vista y al cargar la pagina
    if (!t.includes(M + "[start]")) {
      const ancla = 'if (data.running) connectEvents();';
      if (t.includes(ancla)) {
        const i = t.indexOf(ancla);
        const salto = t.indexOf("\n", i);
        const bloque =
          "\n      if (typeof iniciarIndicadorModelo === \"function\") iniciarIndicadorModelo(); // " + M + "[start]";
        t = t.slice(0, salto) + bloque + t.slice(salto);
        tocado = true;
      }
    }

    if (tocado) { guardar(j, t); ok("Logica del panel anadida."); cambios++; }
    else if (t.includes(M + "[els]")) ok("La logica del panel ya estaba.");
  }
}

// ------------------------------------------------------------- paso 6
log("");
log("[+] Estilos del panel (style.css)...");
{
  const c = leer("web/style.css");
  if (c) {
    if (c.txt.includes(M + "[css]")) { ok("Los estilos ya estaban."); yaEstaba++; }
    else {
      const bloque = "\n\n/* " + M + "[css] inicio - panel del modelo en vivo */\n" +
        ".autoclone-model-card { padding: 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--bg-card); }\n" +
        ".autoclone-modelo { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 2px; }\n" +
        ".autoclone-modelo-prov { font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: var(--bg-hover, #1d2a38); color: var(--text-muted); border: 1px solid var(--border-color); }\n" +
        ".autoclone-modelo-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 15px; font-weight: 600; color: var(--text-muted); }\n" +
        ".autoclone-modelo.activo .autoclone-modelo-id { color: var(--text-primary, #e8eef6); }\n" +
        ".autoclone-modelo.es-xkiro .autoclone-modelo-prov { background: #10324a; color: #7ec8ff; border-color: #1d5b85; }\n" +
        ".autoclone-modelo.es-deepseek .autoclone-modelo-prov { background: #1a2b46; color: #9db8ff; border-color: #2f4d80; }\n" +
        ".autoclone-modelo.es-gemini .autoclone-modelo-prov { background: #2a2410; color: #ffd479; border-color: #6b5a1e; }\n" +
        ".autoclone-modelo-hist { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }\n" +
        ".autoclone-chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: var(--bg-hover, #1d2a38); color: var(--text-muted); border: 1px solid var(--border-color); }\n" +
        "/* " + M + "[css] fin */";
      guardar(c, c.txt + bloque);
      ok("Estilos del panel anadidos.");
      cambios++;
    }
  }
}

// ------------------------------------------------------------- paso 7
log("");
log("[+] Conectar arranque/parada del sondeo...");
{
  const j = leer("web/autoclone.js");
  if (j && !j.txt.includes(M + "[bind]")) {
    let t = j.txt;
    const ancla = "const running = ![\"idle\", \"done\", \"error\", \"cancelled\"].includes(progress.stage);";
    if (t.includes(ancla)) {
      const i = t.indexOf(ancla);
      const salto = t.indexOf("\n", i);
      const bloque =
        "\n      if (typeof iniciarIndicadorModelo === \"function\") {\n" +
        "        if (running) iniciarIndicadorModelo(); else pararIndicadorModelo();\n" +
        "      } // " + M + "[bind]";
      t = t.slice(0, salto) + bloque + t.slice(salto);
      guardar(j, t);
      ok("Arranque/parada del panel conectado al progreso.");
      cambios++;
    } else {
      fallos.push("No encontre el bloque de progreso para conectar el panel.");
    }
  }
}

// ------------------------------------------------------------- sintaxis
log("");
log("Comprobando sintaxis...");
const { execFileSync } = require("child_process");
let sintaxisOK = true;
for (const rel of ["src/autoclone/text-overlay.js", "src/autoclone/index.js", "web/autoclone.js"]) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    ok(rel + " compila.");
  } catch (e) {
    sintaxisOK = false;
    console.log("  [ERROR] " + rel + ":");
    console.log("          " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message));
  }
}

// ------------------------------------------------------------- resumen
log("");
console.log("============================================================");
if (fallos.length) {
  console.log("  TERMINADO CON AVISOS");
  console.log("============================================================");
  for (const x of fallos) console.log("  - " + x);
  process.exit(1);
} else if (!sintaxisOK) {
  console.log("  ERROR DE SINTAXIS");
  console.log("============================================================");
  console.log("  Restaura con git y avisa para revisarlo.");
  process.exit(1);
} else {
  console.log("  LISTO");
  console.log("============================================================");
  console.log("");
  if (cambios === 0) {
    console.log("  El indicador ya estaba instalado.");
  } else {
    console.log("  Indicador en vivo instalado.");
    console.log("");
    console.log("  HAZ ESTO:");
    console.log("    1. Para el dashboard (Ctrl+C) y reinicialo:");
    console.log("         node scripts/run-dashboard.js");
    console.log("    2. Recarga el navegador con Ctrl+F5.");
    console.log("    3. En AutoClone vera una tarjeta nueva:");
    console.log("         «Modelo en uso ahora»");
    console.log("       mientras trabaja, dice el modelo exacto.");
    console.log("");
    console.log("  Tambien puede consultarlo a mano:");
    console.log("         http://localhost:3028/api/autoclone/modelo");
  }
  console.log("");
}
