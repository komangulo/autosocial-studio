#!/usr/bin/env node
/**
 * AutoSocial Studio - xKiro en el ANALISIS DEL PERFIL
 * ===================================================
 * PROBLEMA QUE RESUELVE
 *   El analisis del perfil (src/competitor/ai-analyst.js) NUNCA tuvo xKiro.
 *   Su cadena era: Gemini gratis -> Gemini pago -> OpenRouter.
 *   Cuando Google dice "This model is currently experiencing high demand"
 *   (cuota agotada), no habia respaldo y el analisis fallaba.
 *
 *   AutoClone SI tiene xKiro, pero el Competencia/analisis no. Este instalador
 *   los empareja: xKiro pasa a ser el PRIMER intento del analisis de perfil,
 *   con rotacion entre modelos gratis CON VISION.
 *
 * QUE HACE
 *   1. src/competitor/ai-analyst.js
 *      - Constantes de xKiro (base + lista de modelos gratis con vision)
 *      - callXKiro() para el formato del analista
 *      - analyzeWithXKiro() con rotacion
 *      - analyze() acepta xKiroKey y lo prueba PRIMERO
 *   2. src/competitor/controller.js
 *      - Pasa xKiroKey a aiAnalyst.analyze()
 *
 *   Idempotente: marcadores unicos.
 *
 * USO
 *   node instalar-xkiro-analisis.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const M = "XKA[analisis]";

let cambios = 0, yaEstaba = 0;
const fallos = [];

const ok  = (m) => console.log("  [OK]   " + m);
const log = (m) => console.log(m);

function leer(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fallos.push("No existe: " + rel); return null; }
  return { p, txt: fs.readFileSync(p, "utf8") };
}
function guardar(f, txt) {
  const tmp = f.p + ".xka-tmp";
  fs.writeFileSync(tmp, txt, "utf8");
  fs.renameSync(tmp, f.p);
}

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - xKiro en el analisis del perfil");
console.log("============================================================");
console.log("");

// ---------------------------------------------------------------- paso 0
log("[0/4] Comprobando el proyecto...");
if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.log("  [ERROR] No veo package.json. Ejecuta esto en la raiz del proyecto.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "src", "competitor", "ai-analyst.js"))) {
  console.log("  [ERROR] No veo src/competitor/ai-analyst.js.");
  process.exit(1);
}
ok("Proyecto encontrado.");

// ---------------------------------------------------------------- paso 1
log("");
log("[1/4] Motor de xKiro para el analisis (ai-analyst.js)...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;

    if (t.includes(M + "[motor]")) {
      ok("El motor de xKiro ya estaba instalado.");
      yaEstaba++;
    } else {
      // Anclamos en la declaracion del analyst, que existe siempre.
      const anclas = [
        "const OPENROUTER_BASE =",
        "const GEMINI_BASE =",
        "/** System prompt",
        "const SYSTEM_PROMPT =",
      ];
      const ancla = anclas.find((a) => t.includes(a));
      if (!ancla) { fallos.push("No encontre donde insertar el motor de xKiro."); }
      else {
        const i = t.indexOf(ancla);
        const ini = t.lastIndexOf("\n", i) + 1;
        const bloque =
          "// " + M + "[motor] inicio - xKiro para el analisis de perfil\n" +
          "// xKiro es OpenAI-compatible. Estos son modelos GRATIS con vision,\n" +
          "// ordenados por fiabilidad medida. Si uno falla, rota al siguiente.\n" +
          "const XKIRO_BASE = \"https://api.xkiro.com/v1\";\n" +
          "const XKIRO_ANALYSIS_MODELS = [\n" +
          "  \"minimax/minimax-m3:free\",\n" +
          "  \"qwen/qwen3.7-flash:free\",\n" +
          "  \"qwen/qwen3-vl-plus:free\",\n" +
          "  \"qwen/qwen3.5-flash:free\",\n" +
          "  \"mistralai/ministral-14b\",\n" +
          "  \"mistralai/mistral-small-2603\",\n" +
          "  \"qwen/qwen3.6-plus:free\",\n" +
          "  \"qwen/qwen3.7-plus:free\",\n" +
          "];\n" +
          "const XKIRO_ANALYSIS_COOLDOWN_MS = 15000;\n" +
          "const __xKiroAnalisis = { indice: 0, cooldown: new Map() };\n" +
          "if (typeof globalThis !== \"undefined\") globalThis.__xKiroAnalisis = __xKiroAnalisis;\n" +
          "\n" +
          "/**\n" +
          " * Llama a xKiro en el formato del analista.\n" +
          " * parts: [{ text } | { inline_data: { mime_type, data } }]\n" +
          " */\n" +
          "async function callXKiro(apiKey, model, parts) {\n" +
          "  const content = [];\n" +
          "  for (const part of parts) {\n" +
          "    if (part.text) content.push({ type: \"text\", text: part.text });\n" +
          "    else if (part.inline_data) {\n" +
          "      content.push({ type: \"image_url\", image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });\n" +
          "    }\n" +
          "  }\n" +
          "  const response = await fetch(`${XKIRO_BASE}/chat/completions`, {\n" +
          "    method: \"POST\",\n" +
          "    headers: { \"content-type\": \"application/json\", authorization: `Bearer ${apiKey}` },\n" +
          "    body: JSON.stringify({\n" +
          "      model,\n" +
          "      messages: [\n" +
          "        { role: \"system\", content: SYSTEM_PROMPT },\n" +
          "        { role: \"user\", content },\n" +
          "      ],\n" +
          "      temperature: 0.4,\n" +
          "      max_tokens: 8192,\n" +
          "      response_format: { type: \"json_object\" },\n" +
          "    }),\n" +
          "  });\n" +
          "  const data = await response.json().catch(() => ({}));\n" +
          "  if (!response.ok) {\n" +
          "    const message = data.error?.message || `xKiro respondio ${response.status}`;\n" +
          "    const error = new Error(message);\n" +
          "    if (response.status === 429 || /rate limit|high demand|demand/i.test(message)) error.code = 429;\n" +
          "    if (/api key|unauthor|invalid|authentication|permission|premium|deposited balance/i.test(message)) error.code = 401;\n" +
          "    throw error;\n" +
          "  }\n" +
          "  const text = data.choices?.[0]?.message?.content || \"\";\n" +
          "  if (!text.trim()) throw new Error(\"xKiro devolvio una respuesta vacia.\");\n" +
          "  return { text, usage: data.usage || null, model };\n" +
          "}\n" +
          "\n" +
          "/**\n" +
          " * Analiza el perfil con xKiro, rotando entre modelos gratis.\n" +
          " * Devuelve { analysis, usage, model } o lanza si todos fallan.\n" +
          " */\n" +
          "async function analyzeWithXKiro(xKiroKey, parts, onProgress) {\n" +
          "  const estado = globalThis.__xKiroAnalisis || __xKiroAnalisis;\n" +
          "  const ahora = Date.now();\n" +
          "  const total = XKIRO_ANALYSIS_MODELS.length;\n" +
          "  let ultimoError = null;\n" +
          "\n" +
          "  for (let ronda = 0; ronda < 2; ronda += 1) {\n" +
          "    for (let n = 0; n < total; n += 1) {\n" +
          "      const i = (estado.indice + n) % total;\n" +
          "      const modelo = XKIRO_ANALYSIS_MODELS[i];\n" +
          "      const corto = modelo.split(\"/\").pop();\n" +
          "      if ((estado.cooldown.get(modelo) || 0) > Date.now()) continue;\n" +
          "      try {\n" +
          "        onProgress?.({ stage: \"analysis\", detail: `Analizando perfil con xKiro ${corto} (${i + 1}/${total})...` });\n" +
          "        const r = await callXKiro(xKiroKey, modelo, parts);\n" +
          "        estado.indice = i;\n" +
          "        return { analysis: parseJsonResponse(r.text), usage: r.usage, model: `xKiro/${corto}` };\n" +
          "      } catch (error) {\n" +
          "        ultimoError = error;\n" +
          "        if (error.code === 401) throw error; // clave invalida: no insistir\n" +
          "        estado.cooldown.set(modelo, Date.now() + XKIRO_ANALYSIS_COOLDOWN_MS);\n" +
          "        estado.indice = (i + 1) % total;\n" +
          "        onProgress?.({ stage: \"analysis\", detail: `xKiro ${corto} fallo; probando el siguiente modelo...` });\n" +
          "      }\n" +
          "    }\n" +
          "    if (ronda === 0) await new Promise((r) => setTimeout(r, 5000));\n" +
          "  }\n" +
          "  throw ultimoError || new Error(\"Ningun modelo de xKiro pudo con el analisis.\");\n" +
          "}\n" +
          "// " + M + "[motor] fin\n\n";
        t = t.slice(0, ini) + bloque + t.slice(ini);
        guardar(f, t);
        ok("Motor de xKiro anadido al analista.");
        cambios++;
      }
    }
  }
}

// ---------------------------------------------------------------- paso 2
log("");
log("[2/4] Conectar xKiro como PRIMER intento de analyze()...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[firma]")) { ok("La firma ya estaba actualizada."); yaEstaba++; }
    else {
      const firmaVieja = "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [] } = {}) {";
      if (t.includes(firmaVieja)) {
        const firmaNueva = "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", xKiroKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [], onProgress = null } = {}) { // " + M + "[firma]";
        t = t.replace(firmaVieja, firmaNueva);
        const guardaVieja = "if (!apiKey && !paidApiKey && !openRouterKey) throw new Error(\"Falta la API key de IA. Añádela en la sección Competencia.\");";
        const guardaNueva = "if (!apiKey && !paidApiKey && !openRouterKey && !xKiroKey) throw new Error(\"Falta la API key de IA. Añádela en la sección Competencia.\"); // " + M + "[firma]";
        if (t.includes(guardaVieja)) t = t.replace(guardaVieja, guardaNueva);
        guardar(f, t);
        ok("Firma de analyze() actualizada (acepta xKiroKey).");
        cambios++;
      } else {
        fallos.push("No encontre la firma de analyze() para actualizar.");
      }
    }
  }
}

// ---------------------------------------------------------------- paso 3
log("");
log("[3/4] Insertar xKiro como paso 0 del analisis...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[paso0]")) { ok("El paso 0 ya estaba."); yaEstaba++; }
    else {
      const ancla = "  // 1) Free key (gemini-2.5-flash) first.";
      if (t.includes(ancla)) {
        const i = t.indexOf(ancla);
        const bloque =
          "  // 0) xKiro con rotacion entre modelos GRATIS con vision. Primer intento. // " + M + "[paso0]\n" +
          "  //    Antes que Gemini, para no depender de su cuota gratuita.\n" +
          "  if (xKiroKey) {\n" +
          "    try {\n" +
          "      return await analyzeWithXKiro(xKiroKey, parts, onProgress);\n" +
          "    } catch (error) {\n" +
          "      const esClave = error.code === 401 || /api key|unauthor|invalid|premium|deposited/i.test(String(error.message));\n" +
          "      if (esClave) {\n" +
          "        onProgress?.({ stage: \"analysis\", detail: `xKiro no usable (${String(error.message).slice(0, 80)}); usando Gemini...` });\n" +
          "      } else {\n" +
          "        onProgress?.({ stage: \"analysis\", detail: `xKiro no disponible (${String(error.message).slice(0, 80)}); usando Gemini...` });\n" +
          "      }\n" +
          "    }\n" +
          "  }\n\n";
        t = t.slice(0, i) + bloque + t.slice(i);
        guardar(f, t);
        ok("xKiro insertado como paso 0 del analisis.");
        cambios++;
      } else {
        fallos.push("No encontre el comentario de Gemini gratis para anclar el paso 0.");
      }
    }
  }
}

// ---------------------------------------------------------------- paso 4
log("");
log("[4/4] Pasar la clave desde el controller...");
{
  const f = leer("src/competitor/controller.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[controller]")) { ok("El controller ya pasaba la clave."); yaEstaba++; }
    else {
      const ancla = "openRouterKey: this.settings.openRouterApiKey,";
      if (t.includes(ancla)) {
        const i = t.indexOf(ancla);
        const salto = t.indexOf("\n", i);
        const bloque =
          "\n        xKiroKey: this.settings.xKiroApiKey || process.env.XKIRO_API_KEY || \"\", // " + M + "[controller]\n" +
          "        onProgress: (p) => this._report(p.stage || \"analysis\", p.detail || \"\"),";
        t = t.slice(0, salto) + bloque + t.slice(salto);
        guardar(f, t);
        ok("El controller ahora pasa xKiroKey al analista.");
        cambios++;
      } else {
        fallos.push("No encontre openRouterKey en la llamada a analyze().");
      }
    }
  }
}

// ---------------------------------------------------------------- sintaxis
log("");
log("Comprobando sintaxis...");
const { execFileSync } = require("child_process");
let sintaxisOK = true;
for (const rel of ["src/competitor/ai-analyst.js", "src/competitor/controller.js"]) {
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
    console.log("  El analisis con xKiro ya estaba instalado.");
  } else {
    console.log("  Analisis de perfil con xKiro instalado.");
    console.log("");
    console.log("  HAZ ESTO:");
    console.log("    1. Para el dashboard (Ctrl+C) y reinicialo:");
    console.log("         node scripts/run-dashboard.js");
    console.log("    2. Recarga el navegador con Ctrl+F5.");
    console.log("    3. Vuelve a lanzar el analisis del perfil.");
    console.log("");
    console.log("  Ahora el orden es:");
    console.log("    0) xKiro (modelos gratis con vision, rota entre varios)");
    console.log("    1) Gemini gratis");
    console.log("    2) Gemini de pago");
    console.log("    3) OpenRouter");
  }
  console.log("");
}
