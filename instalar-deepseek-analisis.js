#!/usr/bin/env node
/**
 * AutoSocial Studio - DeepSeek en el ANALISIS DEL PERFIL
 * ======================================================
 * QUE HACE
 *   DeepSeek 4.1 Flash ya funcionaba en AutoClone (texto en pantalla), pero
 *   el analisis del perfil es un modulo aparte (src/competitor/ai-analyst.js)
 *   que NUNCA lo tuvo. Este instalador lo empareja.
 *
 *   Posicion: entre Gemini gratis y Gemini de pago, igual que en AutoClone.
 *
 *   Antes:  xKiro -> Gemini gratis -> Gemini pago -> OpenRouter
 *   Ahora:  xKiro -> Gemini gratis -> DeepSeek -> Gemini pago -> OpenRouter
 *
 * QUE TOCA
 *   1. src/competitor/ai-analyst.js
 *      - DEEPSEEK_BASE y DEEPSEEK_MODEL
 *      - callDeepSeek() en el formato del analista
 *      - analyze() acepta deepSeekKey y lo prueba tras Gemini gratis
 *   2. src/competitor/controller.js
 *      - Pasa deepSeekKey a aiAnalyst.analyze()
 *
 *   Idempotente: marcadores unicos.
 *
 * REQUISITO
 *   Funciona con o sin instalar-xkiro-analisis.js. No depende de el.
 *
 * USO
 *   node instalar-deepseek-analisis.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const M = "DSA[analisis]";

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
  const tmp = f.p + ".dsa-tmp";
  fs.writeFileSync(tmp, txt, "utf8");
  fs.renameSync(tmp, f.p);
}

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - DeepSeek en el analisis del perfil");
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
log("[1/4] Motor de DeepSeek (ai-analyst.js)...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[motor]")) { ok("El motor de DeepSeek ya estaba."); yaEstaba++; }
    else {
      const anclas = [
        "const OPENROUTER_BASE =",
        "const GEMINI_BASE =",
        "/** System prompt",
        "const SYSTEM_PROMPT =",
      ];
      const ancla = anclas.find((a) => t.includes(a));
      if (!ancla) { fallos.push("No encontre donde insertar el motor de DeepSeek."); }
      else {
        const i = t.indexOf(ancla);
        const ini = t.lastIndexOf("\n", i) + 1;
        const bloque =
          "// " + M + "[motor] inicio - DeepSeek 4.1 Flash para el analisis\n" +
          "// OpenAI-compatible, vision nativa. ~6.7x mas barato que Gemini de pago.\n" +
          "const DEEPSEEK_BASE = \"https://api.deepseek.com/v1\";\n" +
          "const DEEPSEEK_ANALYSIS_MODEL = \"deepseek-flash\";\n" +
          "\n" +
          "/**\n" +
          " * Llama a DeepSeek en el formato del analista.\n" +
          " * parts: [{ text } | { inline_data: { mime_type, data } }]\n" +
          " */\n" +
          "async function callDeepSeek(apiKey, model, parts) {\n" +
          "  const content = [];\n" +
          "  for (const part of parts) {\n" +
          "    if (part.text) content.push({ type: \"text\", text: part.text });\n" +
          "    else if (part.inline_data) {\n" +
          "      content.push({ type: \"image_url\", image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });\n" +
          "    }\n" +
          "  }\n" +
          "  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {\n" +
          "    method: \"POST\",\n" +
          "    headers: { \"content-type\": \"application/json\", authorization: `Bearer ${apiKey}` },\n" +
          "    body: JSON.stringify({\n" +
          "      model: model || DEEPSEEK_ANALYSIS_MODEL,\n" +
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
          "    const message = data.error?.message || `DeepSeek respondio ${response.status}`;\n" +
          "    const error = new Error(message);\n" +
          "    if (response.status === 429 || /rate limit|quota|high demand/i.test(message)) error.code = 429;\n" +
          "    if (/api key|unauthor|invalid|authentication|permission|insufficient|balance/i.test(message)) error.code = 401;\n" +
          "    throw error;\n" +
          "  }\n" +
          "  const text = data.choices?.[0]?.message?.content || \"\";\n" +
          "  if (!text.trim()) throw new Error(\"DeepSeek devolvio una respuesta vacia.\");\n" +
          "  return { text, usage: data.usage || null, model: model || DEEPSEEK_ANALYSIS_MODEL };\n" +
          "}\n" +
          "// " + M + "[motor] fin\n\n";
        t = t.slice(0, ini) + bloque + t.slice(ini);
        guardar(f, t);
        ok("Motor de DeepSeek anadido al analista.");
        cambios++;
      }
    }
  }
}

// ---------------------------------------------------------------- paso 2
log("");
log("[2/4] Firma de analyze() (acepta deepSeekKey)...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[firma]")) { ok("La firma ya estaba actualizada."); yaEstaba++; }
    else {
      // La firma puede o no tener ya xKiroKey. Soportamos ambas.
      const firmas = [
        {
          vieja: "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", xKiroKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [], onProgress = null } = {}) {",
          nueva: "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", xKiroKey = \"\", deepSeekKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [], onProgress = null } = {}) { // " + M + "[firma]",
        },
        {
          vieja: "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [] } = {}) {",
          nueva: "async function analyze(report, { apiKey, paidApiKey = \"\", paidModel = DEFAULT_MODEL, openRouterKey = \"\", deepSeekKey = \"\", model = DEFAULT_MODEL, brand = \"\", language = \"es\", frames = [] } = {}) { // " + M + "[firma]",
        },
      ];
      const cual = firmas.find((x) => t.includes(x.vieja));
      if (cual) {
        t = t.replace(cual.vieja, cual.nueva);
        // actualizar la guarda de claves
        t = t.replace(
          "if (!apiKey && !paidApiKey && !openRouterKey && !xKiroKey) throw",
          "if (!apiKey && !paidApiKey && !openRouterKey && !xKiroKey && !deepSeekKey) throw"
        );
        t = t.replace(
          "if (!apiKey && !paidApiKey && !openRouterKey) throw",
          "if (!apiKey && !paidApiKey && !openRouterKey && !deepSeekKey) throw"
        );
        guardar(f, t);
        ok("Firma de analyze() actualizada (acepta deepSeekKey).");
        cambios++;
      } else {
        fallos.push("No encontre la firma de analyze() para actualizar.");
      }
    }
  }
}

// ---------------------------------------------------------------- paso 3
log("");
log("[3/4] Insertar DeepSeek tras Gemini gratis (paso 2)...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    let t = f.txt;
    if (t.includes(M + "[paso2]")) { ok("El paso de DeepSeek ya estaba."); yaEstaba++; }
    else {
      // El ancla es el comentario del paso de Gemini de pago. Insertamos antes.
      const anclas = [
        "  // 2) Free quota gone: paid key (gemini-3.6-flash).",
        "  // 2) Free quota gone: paid key",
        "  // 2b) Free quota exhausted",
      ];
      const ancla = anclas.find((a) => t.includes(a));
      if (!ancla) { fallos.push("No encontre el paso de Gemini de pago para anclar DeepSeek."); }
      else {
        const i = t.indexOf(ancla);
        const bloque =
          "  // 2) DeepSeek 4.1 Flash (deepseek-flash) - pago, con vision nativa y\n" +
          "  //    ~6.7x mas barato que Gemini de pago. Se usa cuando la cuota gratis\n" +
          "  //    de Gemini se agota. Despues caen Gemini de pago y OpenRouter.\n" +
          "  if (deepSeekKey && !deepSeekDown) { // " + M + "[paso2]\n" +
          "    try {\n" +
          "      onProgress?.({ stage: \"analysis\", detail: \"Cuota gratis agotada; usando DeepSeek 4.1 Flash...\" });\n" +
          "      const r = await callDeepSeek(deepSeekKey, DEEPSEEK_ANALYSIS_MODEL, parts);\n" +
          "      return { analysis: parseJsonResponse(r.text), usage: r.usage, model: \"DeepSeek 4.1 Flash\" };\n" +
          "    } catch (error) {\n" +
          "      const esClave = error.code === 401 || /api key|unauthor|invalid|balance|insufficient/i.test(String(error.message));\n" +
          "      if (esClave) deepSeekDown = true;\n" +
          "      onProgress?.({ stage: \"analysis\", detail: `DeepSeek no pudo (${String(error.message).slice(0, 80)}); probando Gemini de pago...` });\n" +
          "    }\n" +
          "  }\n\n";
        t = t.slice(0, i) + bloque + t.slice(i);
        // declarar deepSeekDown antes del paso 0
        const anclaDown = "  const parts = [{ text: buildUserPrompt(";
        if (t.includes(anclaDown) && !t.includes("let deepSeekDown")) {
          const j = t.indexOf(anclaDown);
          t = t.slice(0, j) + "  let deepSeekDown = false; // " + M + "[paso2]\n" + t.slice(j);
        }
        guardar(f, t);
        ok("DeepSeek insertado como paso 2 del analisis.");
        cambios++;
      }
    }
  }
}

// ---------------------------------------------------------------- paso 3b
log("");
log("[3b/4] Arreglar isQuotaError (no detectaba 'high demand')...");
{
  const f = leer("src/competitor/ai-analyst.js");
  if (f) {
    if (f.txt.includes(M + "[quota]")) { ok("isQuotaError ya estaba arreglado."); yaEstaba++; }
    else {
      const viejo = "  return /cuota|quota|rate.?limit|exceeded|429/i.test(String(error?.message || \"\"));";
      if (f.txt.includes(viejo)) {
        const nuevo =
          "  // " + M + "[quota] Google devuelve 'high demand' / 'overloaded' cuando la cuota\n" +
          "  // esta agotada, y no incluia esas palabras: por eso reintentaba en vano.\n" +
          "  return /cuota|quota|rate.?limit|exceeded|429|high demand|overloaded|temporarily|try again later|unavailable/i.test(String(error?.message || \"\"));";
        guardar(f, f.txt.replace(viejo, nuevo));
        ok("isQuotaError ahora detecta 'high demand'.");
        cambios++;
      } else {
        fallos.push("No encontre la linea de isQuotaError para arreglar.");
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
      // Puede estar con o sin xKiroKey ya instalado.
      const anclas = [
        "        xKiroKey: this.settings.xKiroApiKey || process.env.XKIRO_API_KEY || \"\",",
        "openRouterKey: this.settings.openRouterApiKey,",
      ];
      const ancla = anclas.find((a) => t.includes(a));
      if (ancla) {
        const i = t.indexOf(ancla);
        const salto = t.indexOf("\n", i);
        const bloque =
          "\n        deepSeekKey: this.settings.deepSeekApiKey || process.env.DEEPSEEK_API_KEY || \"\", // " + M + "[controller]";
        t = t.slice(0, salto) + bloque + t.slice(salto);
        guardar(f, t);
        ok("El controller ahora pasa deepSeekKey al analista.");
        cambios++;
      } else {
        fallos.push("No encontre donde pasar deepSeekKey en el controller.");
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
    console.log("  DeepSeek en el analisis ya estaba instalado.");
  } else {
    console.log("  DeepSeek anadido al analisis del perfil.");
    console.log("");
    console.log("  Orden ahora:");
    console.log("    0) xKiro (modelos gratis con vision)");
    console.log("    1) Gemini gratis");
    console.log("    2) DeepSeek 4.1 Flash        <-- NUEVO");
    console.log("    2b) Gemini de pago");
    console.log("    3) OpenRouter");
    console.log("");
    console.log("  HAZ ESTO:");
    console.log("    1. Para el dashboard (Ctrl+C) y reinicialo:");
    console.log("         node scripts/run-dashboard.js");
    console.log("    2. Recarga el navegador con Ctrl+F5.");
    console.log("    3. Vuelve a lanzar el analisis del perfil.");
  }
  console.log("");
}
