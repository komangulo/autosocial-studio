/**
 * Instalador de DeepSeek 4.1 Flash (vision) para AutoClone.
 *
 * Uso: copia este archivo a la raiz del proyecto (donde esta package.json)
 * y ejecuta:   node instalar-deepseek.js
 *
 * Orden de proveedores que instala:
 *   Gemini gratis -> DeepSeek pago -> Gemini pago -> OpenRouter gratis
 *
 * Anade un casillero de API key de DeepSeek en AutoClone. No borra ni cambia
 * ninguna configuracion existente. Se puede ejecutar dos veces sin duplicar.
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DEEPSEEK_MODEL = "deepseek-flash";

let added = 0;
let present = 0;
const failures = [];

function read(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`\n  ERROR: falta ${rel}`);
    console.error("  Copia este archivo a la raiz del proyecto (donde esta package.json) y vuelve a ejecutarlo.\n");
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

function write(rel, text) {
  fs.writeFileSync(path.join(ROOT, rel), text, "utf8");
}

function patch(rel, id, label, from, to) {
  const idMark = `DS[${id}]`;
  let text = read(rel);
  if (text.includes(idMark)) {
    console.log(`  ya estaba  ${label}`);
    present += 1;
    return;
  }
  const index = text.indexOf(from);
  if (index === -1) {
    console.error(`  FALLO      ${label}  (${rel})`);
    failures.push(`${label} -> ${rel}`);
    return;
  }
  text = text.slice(0, index) + to + ` // ${idMark}` + text.slice(index + from.length);
  write(rel, text);
  added += 1;
  console.log(`  aplicado   ${label}`);
}

console.log("\nInstalando DeepSeek 4.1 Flash en AutoClone...\n");

// ---------------------------------------------------------- vision
patch(
  "src/autoclone/text-overlay.js",
  "consts",
  "vision: constantes",
  `const OPENROUTER_BASE = "https://openrouter.ai/api/v1";`,
  `const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = "${DEEPSEEK_MODEL}";`,
);

patch(
  "src/autoclone/text-overlay.js",
  "fn",
  "vision: funcion de llamada",
  `async function fileToBase64(filePath) {`,
  `// DeepSeek V4.1 Flash (deepseek-flash): OpenAI-compatible, vision nativa.
// Cada imagen cuesta como maximo 384 tokens de entrada.
async function callDeepSeekVision(apiKey, model, frameParts, videoWidth, videoHeight) {
  const content = [{ type: "text", text: \`Resolucion del video: \${videoWidth}x\${videoHeight}. Fotogramas:\` }];
  for (const part of frameParts) {
    if (part.text) content.push({ type: "text", text: part.text });
    else if (part.inline_data) content.push({ type: "image_url", image_url: { url: \`data:\${part.inline_data.mime_type};base64,\${part.inline_data.data}\` } });
  }
  const response = await fetch(\`\${DEEPSEEK_BASE}/chat/completions\`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${apiKey}\` },
    body: JSON.stringify({
      model: model || DEEPSEEK_MODEL,
      messages: [{ role: "system", content: VISION_SYSTEM }, { role: "user", content }],
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || \`DeepSeek respondio \${response.status}\`;
    if (/api key|unauthor|invalid|authentication/i.test(message)) throw new Error("La API key de DeepSeek no es valida.");
    const error = new Error(message);
    if (response.status === 429) error.code = 429;
    throw error;
  }
  return data.choices?.[0]?.message?.content || "";
}

async function fileToBase64(filePath) {`,
);

patch(
  "src/autoclone/text-overlay.js",
  "sig",
  "vision: firma de detectAndTranslate",
  `async function detectAndTranslate(videoPath, { apiKey, paidApiKey = "", paidModel = DEFAULT_VISION_MODEL, openRouterKey = "", model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {
  if (!apiKey && !paidApiKey && !openRouterKey) throw new Error("Falta la API key de IA para leer el texto en pantalla.");`,
  `async function detectAndTranslate(videoPath, { apiKey, paidApiKey = "", paidModel = DEFAULT_VISION_MODEL, openRouterKey = "", deepSeekKey = "", model = DEFAULT_VISION_MODEL, workDir, onProgress } = {}) {
  if (!apiKey && !paidApiKey && !openRouterKey && !deepSeekKey) throw new Error("Falta la API key de IA para leer el texto en pantalla.");`,
);

patch(
  "src/autoclone/text-overlay.js",
  "flag",
  "vision: bandera de proveedor caido",
  `  let openRouterDown = false;`,
  `  let openRouterDown = false;
  let deepSeekDown = false;`,
);

patch(
  "src/autoclone/text-overlay.js",
  "chain",
  "vision: paso 2 (DeepSeek) en la cadena",
  `    // 2) Free quota exhausted: switch to the paid Gemini key (gemini-3.6-flash)`,
  `    // 2) DeepSeek V4.1 Flash (deepseek-flash) — pago, con vision nativa y
    //    ~6.7x mas barato que Gemini de pago. Se usa cuando la cuota gratis
    //    de Gemini se agota. Si falla, se cae a Gemini de pago y luego a
    //    OpenRouter.
    if (text === null && deepSeekKey && !deepSeekDown) {
      try {
        onProgress?.({ stage: "text-fallback", detail: "Cuota gratis agotada; usando DeepSeek 4.1 Flash..." });
        const answer = await callDeepSeekVision(deepSeekKey, DEEPSEEK_MODEL, parts, width, height);
        if (answer && answer.trim()) {
          text = answer;
          onProgress?.({ stage: "text-fallback", detail: "Traduciendo con DeepSeek 4.1 Flash..." });
        }
      } catch (error) {
        lastError = error;
        if (/no es valida/i.test(error.message)) deepSeekDown = true;
        onProgress?.({ stage: "text-warning", detail: \`DeepSeek no pudo leer el lote: \${error.message}\` });
      }
    }

    // 2b) Free quota exhausted: switch to the paid Gemini key (gemini-3.6-flash)`,
);

// ---------------------------------------------------------- autoclone backend
patch(
  "src/autoclone/controller.js",
  "ac-read",
  "autoclone: leer la key",
  `      openRouterKey: competitorSettings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",`,
  `      openRouterKey: competitorSettings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
      deepSeekKey: competitorSettings.deepSeekApiKey || process.env.DEEPSEEK_API_KEY || "",`,
);

patch(
  "src/autoclone/controller.js",
  "ac-pass",
  "autoclone: pasar la key a la vision",
  `        const result = await textOverlay.detectAndTranslate(current, {
          apiKey: ai.apiKey,
          paidApiKey: ai.paidApiKey,
          paidModel: ai.paidModel,
          openRouterKey: ai.openRouterKey,
          model: ai.visionModel,`,
  `        const result = await textOverlay.detectAndTranslate(current, {
          apiKey: ai.apiKey,
          paidApiKey: ai.paidApiKey,
          paidModel: ai.paidModel,
          openRouterKey: ai.openRouterKey,
          deepSeekKey: ai.deepSeekKey,
          model: ai.visionModel,`,
);

patch(
  "src/autoclone/controller.js",
  "ac-guard",
  "autoclone: permitir arrancar con DeepSeek",
  `      if (!ai.apiKey && !ai.paidApiKey && !ai.openRouterKey) {`,
  `      if (!ai.apiKey && !ai.paidApiKey && !ai.openRouterKey && !ai.deepSeekKey) {`,
);

// ---------------------------------------------------------- settings
patch(
  "src/competitor/controller.js",
  "settings",
  "settings: campo deepSeekApiKey",
  `this.settings = { geminiApiKey: "", paidGeminiApiKey: "", freeGeminiApiKey: "", openRouterApiKey: "", model: aiAnalyst.DEFAULT_MODEL, brand: "", language: "es" };`,
  `this.settings = { geminiApiKey: "", paidGeminiApiKey: "", freeGeminiApiKey: "", openRouterApiKey: "", deepSeekApiKey: "", model: aiAnalyst.DEFAULT_MODEL, brand: "", language: "es" };`,
);

patch(
  "src/competitor/controller.js",
  "status",
  "settings: estado de la key",
  `      hasOpenRouterKey: Boolean(this.settings.openRouterApiKey),`,
  `      hasOpenRouterKey: Boolean(this.settings.openRouterApiKey),
      hasDeepSeekKey: Boolean(this.settings.deepSeekApiKey),
      deepSeekKeyMasked: this.settings.deepSeekApiKey ? \`\${this.settings.deepSeekApiKey.slice(0, 6)}...\${this.settings.deepSeekApiKey.slice(-4)}\` : "",
      deepSeekModel: "${DEEPSEEK_MODEL}",`,
);

patch(
  "src/competitor/controller.js",
  "save",
  "settings: guardar la key",
  `    if (patch.removeOpenRouter) this.settings.openRouterApiKey = "";`,
  `    if (patch.removeOpenRouter) this.settings.openRouterApiKey = "";
    if (typeof patch.deepSeekApiKey === "string") {
      if (patch.deepSeekApiKey.trim()) this.settings.deepSeekApiKey = patch.deepSeekApiKey.trim();
      else if (patch.deepSeekApiKey === "") this.settings.deepSeekApiKey = "";
    }
    if (patch.removeDeepSeek) this.settings.deepSeekApiKey = "";`,
);

// ---------------------------------------------------------- interfaz
patch(
  "web/index.html",
  "ui-panel",
  "interfaz: casillero",
  `          <p class="helios-hint" id="autocloneKeyStatus"></p>
        </div>`,
  `          <p class="helios-hint" id="autocloneKeyStatus"></p>

          <div class="card-title" style="margin-top:18px;">API key de DeepSeek (4.1 Flash)</div>
          <p class="form-hint">Se usa cuando se agota la cuota gratis de Gemini. En vision sale ~6.7x mas barato que Gemini de pago. Se guarda localmente.</p>
          <div class="helios-key-row">
            <input id="autocloneDeepSeekKey" class="control-input" type="password" placeholder="sk-..." />
            <button id="autocloneSaveDeepSeekKeyBtn" class="control-btn-small primary" type="button">Guardar</button>
          </div>
          <p class="helios-hint" id="autocloneDeepSeekStatus"></p>
        </div>`,
);

patch(
  "web/autoclone.js",
  "ui-els",
  "interfaz: elementos",
  `    openFolderBtn: $("autocloneOpenFolderBtn"),`,
  `    openFolderBtn: $("autocloneOpenFolderBtn"),
    deepSeekKey: $("autocloneDeepSeekKey"),
    saveDeepSeekKeyBtn: $("autocloneSaveDeepSeekKeyBtn"),
    deepSeekStatus: $("autocloneDeepSeekStatus"),`,
);

patch(
  "web/autoclone.js",
  "ui-state",
  "interfaz: mostrar estado",
  `          : "No hay API key. Sin ella no se puede traducir el texto en pantalla.";
      }`,
  `          : "No hay API key. Sin ella no se puede traducir el texto en pantalla.";
      }
      if (els.deepSeekStatus) {
        els.deepSeekStatus.textContent = data.settings?.hasDeepSeekKey
          ? \`DeepSeek configurado (\${data.settings?.deepSeekKeyMasked || "oculta"}).\`
          : "DeepSeek sin configurar.";
      }`,
);

patch(
  "web/autoclone.js",
  "ui-save",
  "interfaz: guardar la key",
  `  function renderJob(job) {`,
  `  async function saveDeepSeekKey() {
    const key = els.deepSeekKey.value.trim();
    if (!key) { els.deepSeekStatus.textContent = "Escribe la API key de DeepSeek."; return; }
    els.saveDeepSeekKeyBtn.disabled = true;
    try {
      await API.post("/api/competitor/settings", { deepSeekApiKey: key });
      els.deepSeekKey.value = "";
      els.deepSeekStatus.textContent = "API key de DeepSeek guardada.";
      await refreshKeyState();
    } catch (error) {
      els.deepSeekStatus.textContent = error.message;
    } finally {
      els.saveDeepSeekKeyBtn.disabled = false;
    }
  }

  function renderJob(job) {`,
);

patch(
  "web/autoclone.js",
  "ui-bind",
  "interfaz: enlazar el boton",
  `  els.saveKeyBtn.addEventListener("click", saveKey);`,
  `  els.saveKeyBtn.addEventListener("click", saveKey);
  els.saveDeepSeekKeyBtn?.addEventListener("click", saveDeepSeekKey);`,
);

// ---------------------------------------------------------- resultado
if (failures.length) {
  console.error(`\n  ${failures.length} cambio(s) NO se pudieron aplicar:`);
  for (const f of failures) console.error(`    - ${f}`);
  console.error("\n  Tu version de esos archivos es distinta a la esperada.");
  console.error("  Pasa este mensaje completo y lo ajusto.\n");
  process.exit(1);
}

console.log(`\nListo. ${added} cambios aplicados, ${present} ya estaban.\n`);
console.log("Cadena de proveedores instalada:");
console.log("  Gemini gratis -> DeepSeek pago -> Gemini pago -> OpenRouter gratis\n");
console.log("Siguientes pasos:");
console.log("  1. node scripts/check-syntax.js   (debe decir Syntax OK)");
console.log("  2. arranca la app y abre AutoClone > Configurar API key");
console.log("  3. pega tu key de DeepSeek en el casillero nuevo y guarda\n");
