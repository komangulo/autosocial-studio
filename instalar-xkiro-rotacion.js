#!/usr/bin/env node
/*
 * instalar-xkiro-rotacion.js
 * ------------------------------------------------------------
 * xKiro con ROTACION AUTOMATICA entre 4 modelos gratis con vision.
 *
 * Orden de preferencia (segun pruebas reales de carga y rafaga):
 *   1. minimax/minimax-m3:free        <- aguanta 25/25 seguidas
 *   2. qwen/qwen3.7-flash:free        <- 10/10, respaldo solido
 *   3. mistralai/ministral-14b        <- el mas rapido (329ms)
 *   4. mistralai/mistral-small-2603   <- el mas rapido empatado
 *
 * COMO FUNCIONA
 * -------------
 * - El sistema recuerda QUE modelo esta funcionando (indice activo).
 * - Trabaja con el todo el tiempo, lote tras lote, sin cambiar.
 * - Solo cuando falla (rate limit, error del servidor, lo que sea)
 *   pasa al SIGUIENTE de la lista.
 * - El que fallo queda "en cuarentena" unos segundos para que se
 *   recupere, y luego vuelve a estar disponible.
 * - Si los 4 fallan a la vez, espera y reintenta desde el primero.
 *
 * Por que esto es rapido: el limite de xKiro es POR IP Y POR MINUTO,
 * asi que mientras trabajas con el modelo 2, el modelo 1 se esta
 * recuperando solo. La rotacion convierte el limite en una ventaja.
 *
 * Uso:
 *   1. Copia este archivo a la raiz de autosocial-studio.
 *   2. Ejecuta:  node instalar-xkiro-rotacion.js
 *   3. Pega tu API key de xKiro en la app (Ajustes de IA).
 *
 * Idempotente. Copia de seguridad antes de tocar. Sin keys dentro.
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const OVERLAY = path.join(ROOT, "src", "autoclone", "text-overlay.js");
const CONTROLLER = path.join(ROOT, "src", "autoclone", "controller.js");

const MK = "// XKR[xkiro-rotacion]";

function ok(m) { console.log("  [OK]   " + m); }
function info(m) { console.log("  [info] " + m); }
function die(m) { console.error("  [ERROR] " + m); process.exit(1); }

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - xKiro con rotacion de 4 modelos");
console.log("============================================================");
console.log("");

if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  die("No encuentro package.json. Copia este archivo a la raiz del proyecto.");
}
if (!fs.existsSync(OVERLAY)) die("No encuentro src/autoclone/text-overlay.js.");
ok("Proyecto encontrado.");

let src = fs.readFileSync(OVERLAY, "utf8");

console.log("");
console.log("[1/6] Comprobando si ya esta instalado...");
if (src.includes(MK)) {
  ok("La rotacion xKiro ya esta instalada. Nada que hacer.");
  console.log("");
  process.exit(0);
}

// --- 2. Constantes --------------------------------------------
console.log("");
console.log("[2/6] Anadiendo constantes de xKiro...");

const ANCLA_CONSTS = 'const DEEPSEEK_BASE = "https://api.deepseek.com/v1";';
if (!src.includes(ANCLA_CONSTS)) {
  die(
    "No encuentro las constantes esperadas en text-overlay.js.\n" +
      "         Tu version difiere. No toco nada. Prueba: git pull"
  );
}

const NUEVAS_CONSTS = [
  ANCLA_CONSTS,
  "",
  MK + " inicio - xKiro con rotacion automatica",
  "const XKIRO_BASE = \"https://api.xkiro.com/v1\";",
  "// Orden de preferencia, medido con carga y rafaga reales:",
  "//   1) MiniMax M3      aguanta 25/25 peticiones seguidas",
  "//   2) Qwen 3.7 Flash  10/10, respaldo solido",
  "//   3) Ministral 14B   el mas rapido (329ms)",
  "//   4) Mistral Small   el mas rapido empatado (336ms)",
  "const XKIRO_MODELS = [",
  "  \"minimax/minimax-m3:free\",",
  "  \"qwen/qwen3.7-flash:free\",",
  "  \"mistralai/ministral-14b\",",
  "  \"mistralai/mistral-small-2603\",",
  "];",
  "// Segundos de cuarentena para un modelo que acaba de fallar.",
  "const XKIRO_COOLDOWN_MS = 15000;",
  "// Espera antes de reintentar cuando los 4 han fallado.",
  "const XKIRO_ALL_FAILED_MS = 8000;",
  "const XKIRO_MAX_ROUNDS = 3;",
  MK + " fin",
].join("\n");

src = src.replace(ANCLA_CONSTS, NUEVAS_CONSTS);
ok("Constantes anadidas (4 modelos + tiempos).");

// --- 3. Funcion de llamada ------------------------------------
console.log("");
console.log("[3/6] Anadiendo la funcion de llamada a xKiro...");

const ANCLA_FN = "// DeepSeek V4.1 Flash (deepseek-flash): OpenAI-compatible, vision nativa.";
if (!src.includes(ANCLA_FN)) {
  die("No encuentro la funcion de DeepSeek para insertar antes. No toco nada.");
}

const NUEVA_FN = [
  MK + " call - formato OpenAI",
  "async function callXKiroVision(apiKey, model, frameParts, videoWidth, videoHeight) {",
  "  const content = [{ type: \"text\", text: `Resolucion del video: ${videoWidth}x${videoHeight}. Fotogramas:` }];",
  "  for (const part of frameParts) {",
  "    if (part.text) content.push({ type: \"text\", text: part.text });",
  "    else if (part.inline_data) content.push({ type: \"image_url\", image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });",
  "  }",
  "  const response = await fetch(`${XKIRO_BASE}/chat/completions`, {",
  "    method: \"POST\",",
  "    headers: { \"content-type\": \"application/json\", authorization: `Bearer ${apiKey}` },",
  "    body: JSON.stringify({",
  "      model,",
  "      messages: [{ role: \"system\", content: VISION_SYSTEM }, { role: \"user\", content }],",
  "      temperature: 0.1,",
  "      max_tokens: 8192,",
  "      response_format: { type: \"json_object\" },",
  "    }),",
  "  });",
  "  const data = await response.json().catch(() => ({}));",
  "  if (!response.ok) {",
  "    const message = data.error?.message || `xKiro respondio ${response.status}`;",
  "    const error = new Error(message);",
  "    if (response.status === 429 || /rate limit/i.test(message)) error.code = 429;",
  "    if (/api key|unauthor|invalid|authentication|permission/i.test(message)) error.code = 401;",
  "    throw error;",
  "  }",
  "  return data.choices?.[0]?.message?.content || \"\";",
  "}",
  "",
  "// El limite de xKiro es por IP y por minuto. Mantenemos el estado de",
  "// rotacion FUERA de la funcion, para que se recuerde entre lotes y entre",
  "// videos: el modelo que funciona se sigue usando, no se vuelve al primero.",
  "const __xKiroEstado = { indice: 0, cooldown: new Map(), usos: new Map() };",
  "",
  "/**",
  " * Inspecciona los fotogramas con ROTACION entre los modelos de xKiro.",
  " * Conserva el modelo activo entre llamadas: solo cambia al siguiente",
  " * cuando el actual falla. El que falla descansa y se recupera solo.",
  " */",
  "async function xKiroRotateVision(apiKey, parts, width, height, onProgress) {",
  "  const estado = __xKiroEstado;",
  "  let intentos = 0;",
  "  const maxIntentos = XKIRO_MODELS.length * XKIRO_MAX_ROUNDS;",
  "",
  "  while (intentos < maxIntentos) {",
  "    intentos += 1;",
  "    // Busca el modelo activo, o el primero disponible tras el.",
  "    let elegido = null;",
  "    for (let salto = 0; salto < XKIRO_MODELS.length; salto += 1) {",
  "      const i = (estado.indice + salto) % XKIRO_MODELS.length;",
  "      const modelo = XKIRO_MODELS[i];",
  "      const hasta = estado.cooldown.get(modelo) || 0;",
  "      if (Date.now() >= hasta) { elegido = modelo; estado.indice = i; break; }",
  "    }",
  "",
  "    // Todos en cuarentena: espera a que el primero se recupere.",
  "    if (!elegido) {",
  "      const tiempos = XKIRO_MODELS.map((m) => estado.cooldown.get(m) || 0).filter((t) => t > 0);",
  "      const proximo = tiempos.length ? Math.min(...tiempos) : 0;",
  "      const espera = Math.max(1500, Math.min(proximo - Date.now(), XKIRO_ALL_FAILED_MS));",
  "      onProgress?.({ stage: \"text-fallback\", detail: `Todos los modelos de xKiro ocupados; esperando ${Math.round(espera / 1000)}s...` });",
  "      await new Promise((r) => setTimeout(r, espera));",
  "      continue;",
  "    }",
  "",
  "    try {",
  "      const corto = elegido.split(\"/\").pop();",
  "      onProgress?.({ stage: \"text-vision\", detail: `Leyendo texto con xKiro ${corto}...` });",
  "      const answer = await callXKiroVision(apiKey, elegido, parts, width, height);",
  "      if (answer && answer.trim()) {",
  "        estado.usos.set(elegido, (estado.usos.get(elegido) || 0) + 1);",
  "        return answer;",
  "      }",
  "      // Respuesta vacia: tratamos como fallo suave.",
  "      estado.cooldown.set(elegido, Date.now() + XKIRO_COOLDOWN_MS);",
  "    } catch (error) {",
  "      // Error de clave: no tiene sentido seguir rotando.",
  "      if (error.code === 401) throw error;",
  "      // Cualquier otro fallo: cuarentena y siguiente modelo.",
  "      const seg = error.code === 429 ? 25000 : XKIRO_COOLDOWN_MS;",
  "      estado.cooldown.set(elegido, Date.now() + seg);",
  "      const corto = elegido.split(\"/\").pop();",
  "      onProgress?.({ stage: \"text-warning\", detail: `xKiro ${corto} fallo (${String(error.message).slice(0, 60)}); rotando al siguiente modelo...` });",
  "      await new Promise((r) => setTimeout(r, 800));",
  "    }",
  "  }",
  "",
  "  return null;",
  "}",
  "",
].join("\n");

src = src.replace(ANCLA_FN, NUEVA_FN + ANCLA_FN);
ok("Funcion de llamada + funcion de rotacion anadidas.");

// --- 4. Enganchar en la cadena --------------------------------
console.log("");
console.log("[4/6] Enganchando la rotacion como primera opcion...");

const ANCLA_FIRMA = 'openRouterKey = "", deepSeekKey = "", model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {';
if (!src.includes(ANCLA_FIRMA)) die("No encuentro la firma de detectAndTranslate. No toco nada.");
src = src.replace(
  ANCLA_FIRMA,
  'openRouterKey = "", deepSeekKey = "", xKiroKey = "", model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {'
);
ok("Firma actualizada (acepta xKiroKey).");

const ANCLA_SIG = 'if (!apiKey && !paidApiKey && !openRouterKey && !deepSeekKey) throw new Error("Falta la API key de IA para leer el texto en pantalla."); // DS[sig]';
if (!src.includes(ANCLA_SIG)) die("No encuentro la validacion de keys. No toco nada.");
src = src.replace(
  ANCLA_SIG,
  'if (!apiKey && !paidApiKey && !openRouterKey && !deepSeekKey && !xKiroKey) throw new Error("Falta la API key de IA para leer el texto en pantalla."); ' +
    MK
);
ok("Validacion de keys actualizada.");

// Estado de rotacion compartido: se crea aqui y se recuerda entre lotes.
const ANCLA_STATS = "    let quotaHit = false;";
if (!src.includes(ANCLA_STATS)) die("No encuentro el punto de stats. No toco nada.");
src = src.replace(
  ANCLA_STATS,
  ANCLA_STATS + "\n    // El estado vive en __xKiroEstado, fuera del bucle: se conserva entre lotes. " + MK
);
ok("Estado de rotacion compartido preparado.");

const ANCLA_ESCALON1 = "    // 1) Free Gemini key first (gemini-2.5-flash). Once its quota is gone we";
if (!src.includes(ANCLA_ESCALON1)) die("No encuentro el escalon 1 de la cadena. No toco nada.");

const ESCALON_ROT = [
  "    // 0) xKiro con ROTACION entre 4 modelos gratis. Primera eleccion.",
  "    //    El resto de la cadena (Gemini gratis -> DeepSeek -> Gemini pago",
  "    //    -> OpenRouter) queda intacta como respaldo final.",
  "    if (text === null && xKiroKey) {",
  "      " + MK + " escalon",
  "      try {",
  "        const answer = await xKiroRotateVision(xKiroKey, parts, width, height, onProgress);",
  "        if (answer && answer.trim()) text = answer;",
  "      } catch (error) {",
  "        lastError = error;",
  "        onProgress?.({ stage: \"text-warning\", detail: `xKiro no disponible: ${error.message}` });",
  "      }",
  "    }",
  "",
].join("\n");

src = src.replace(ANCLA_ESCALON1, ESCALON_ROT + ANCLA_ESCALON1);
ok("Rotacion insertada como paso 0.");

// --- 5. Exportar ----------------------------------------------
console.log("");
console.log("[5/6] Exportando para pruebas...");

if (src.includes("  OPENROUTER_VISION_MODELS,")) {
  src = src.replace(
    "  OPENROUTER_VISION_MODELS,",
    "  OPENROUTER_VISION_MODELS,\n  XKIRO_BASE, XKIRO_MODELS, xKiroVision: callXKiroVision, xKiroRotateVision,"
  );
  ok("Exportado.");
} else {
  info("No encontre el bloque de exports; no es critico.");
}

// --- Guardar --------------------------------------------------
const backup = OVERLAY + ".backup-" + Date.now();
try { fs.copyFileSync(OVERLAY, backup); }
catch (e) { die("No pude crear copia de seguridad: " + e.message); }
info("Copia de seguridad: " + path.basename(backup));

const tmp = OVERLAY + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, src, "utf8");
  fs.renameSync(tmp, OVERLAY);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  die("No pude escribir text-overlay.js: " + e.message);
}

const chk = spawnSync(process.execPath, ["--check", OVERLAY], { encoding: "utf8" });
if (chk.status !== 0) {
  console.error(chk.stderr || chk.stdout);
  die("Sintaxis incorrecta. Restaura: " + path.basename(backup));
}
ok("Sintaxis de text-overlay.js correcta.");

// --- 6. controller: leer y pasar la key -----------------------
console.log("");
console.log("[6/6] Haciendo que la app lea la key de xKiro...");

if (!fs.existsSync(CONTROLLER)) {
  info("No encontre controller.js; revisa a mano.");
} else {
  let ctl = fs.readFileSync(CONTROLLER, "utf8");
  if (ctl.includes("xKiroKey")) {
    ok("controller.js ya lee xKiroKey. Sin cambios.");
  } else {
    const ANCLA_RET = '      deepSeekKey: competitorSettings.deepSeekApiKey || process.env.DEEPSEEK_API_KEY || "", // DS[ac-read]';
    if (!ctl.includes(ANCLA_RET)) {
      info("No encontre el punto exacto en controller.js; anade xKiroKey a mano.");
    } else {
      ctl = ctl.replace(
        ANCLA_RET,
        ANCLA_RET +
          "\n      xKiroKey: competitorSettings.xKiroApiKey || process.env.XKIRO_API_KEY || \"\", " +
          MK
      );
      ctl = ctl.replace(
        /openRouterKey: ai\.openRouterKey,/g,
        "openRouterKey: ai.openRouterKey,\n            xKiroKey: ai.xKiroKey,"
      );
      const cbackup = CONTROLLER + ".backup-" + Date.now();
      fs.copyFileSync(CONTROLLER, cbackup);
      const ctmp = CONTROLLER + ".tmp-" + process.pid;
      fs.writeFileSync(ctmp, ctl, "utf8");
      fs.renameSync(ctmp, CONTROLLER);
      const cchk = spawnSync(process.execPath, ["--check", CONTROLLER], { encoding: "utf8" });
      if (cchk.status !== 0) {
        console.error(cchk.stderr || cchk.stdout);
        die("Sintaxis de controller.js incorrecta. Restaura: " + path.basename(cbackup));
      }
      ok("controller.js lee y pasa xKiroKey.");
    }
  }
}

console.log("");
console.log("============================================================");
console.log("  Listo. Rotacion automatica activa:");
console.log("");
console.log("    1. minimax/minimax-m3:free       (el que mas aguanta)");
console.log("    2. qwen/qwen3.7-flash:free");
console.log("    3. mistralai/ministral-14b       (el mas rapido)");
console.log("    4. mistralai/mistral-small-2603");
console.log("");
console.log("  Comportamiento:");
console.log("    - Trabaja con MiniMax todo el rato.");
console.log("    - Si falla, pasa solo al siguiente.");
console.log("    - El que falla descansa 15s (25s si es limite de tasa).");
console.log("    - Si los 4 fallan, espera y reintenta.");
console.log("    - Un error de clave (401) para todo, no rota.");
console.log("");
console.log("  FALTA: pegar tu API key de xKiro en la app (Ajustes de IA).");
console.log("");
console.log("  IMPORTANTE: revoca la key que pegaste en el chat.");
console.log("      https://xkiro.com/dashboard/api/keys");
console.log("");
console.log("  Deshacer: restaura los .backup-*");
console.log("============================================================");
console.log("");
