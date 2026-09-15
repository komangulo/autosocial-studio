/**
 * Phase 4 — Plan: Gemini acts as a senior Android architect and produces a
 * phased development plan (JSON + markdown) from the vision analysis.
 */

const path = require("path");
const ai = require("./ai-providers");
const { projectDir, readJson, writeJson, saveProject, readSettings, apiKeyFor } = require("./store");

const PLAN_SYSTEM = `Eres un arquitecto de software y desarrollador senior de Android con más de 15 años de experiencia, especializado en Kotlin, Jetpack Compose y videojuegos móviles.
Recibes el análisis visual de un anuncio y debes diseñar un plan de desarrollo realista para una app Android ORIGINAL inspirada en el concepto (no copies nombres, logos ni arte).
El proyecto usará Kotlin + Jetpack Compose, Gradle Kotlin DSL, minsdk 24, y debe compilar con assembleDebug.
Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin markdown.

Esquema:
{
  "appName": "nombre original para nuestra app",
  "packageName": "com.ejemplo.app",
  "summary": "visión en 2-3 frases",
  "appType": "game | utility | social | tool",
  "stack": {
    "language": "Kotlin",
    "ui": "Jetpack Compose",
    "minSdk": 24,
    "targetSdk": 34,
    "dependencies": ["androidx...", "..."],
    "assetsPlan": "cómo se generarán los gráficos (formas, Canvas, vectores)"
  },
  "screens": [
    { "id": "home", "title": "Inicio", "composable": "HomeScreen", "description": "...", "components": ["..."] }
  ],
  "navigation": [ { "from": "home", "to": "game", "action": "..." } ],
  "dataModel": [ { "name": "PlayerState", "fields": [ { "name": "score", "type": "Int" } ] } ],
  "gameplay": [
    { "name": "regla o mecánica", "description": "cómo se implementa", "priority": "must|should|could" }
  ],
  "phases": [
    { "number": 1, "name": "Base troncal", "goal": "...", "tasks": ["..."], "definitionOfDone": "...", "files": ["..."] }
  ],
  "risks": ["riesgos técnicos y cómo mitigarlos"],
  "assumptions": ["supuestos sobre lo que no se ve en el anuncio"],
  "outOfScope": ["lo que NO haremos en la v1"]
}

Reglas:
- Máximo 5-8 pantallas. Prioriza un MVP jugable/funcional.
- Las fases deben empezar por una base troncal compilable y crecer.
- No propongas backend propio si el anuncio no lo muestra.
- Los assets deben poder generarse con Canvas/formas/vectores, sin arte externo.`;

async function buildPlan(project, { answers } = {}) {
  const settings = await readSettings();
  const providerId = settings.code.provider;
  const apiKey = await apiKeyFor(providerId);
  if (!apiKey) {
    throw new Error(`Falta la API key de ${ai.getProvider(providerId).label}. Añádela en Configuración.`);
  }

  const dir = projectDir(project.id);
  const vision = await readJson(path.join(dir, "vision.json"), null);
  if (!vision) throw new Error("Falta el análisis visual. Ejecuta la fase 3 primero.");

  const payload = {
    nombre_proyecto: project.name,
    url_tienda: project.storeUrl || null,
    notas_del_usuario: answers || project.answers || "",
    idioma_app: settings.language,
    prefijo_paquetes: settings.packagePrefix,
    analisis_visual: vision,
  };

  const { text, usage } = await ai.generate({
    providerId,
    apiKey,
    model: settings.code.model,
    system: PLAN_SYSTEM,
    parts: [{ text: `Diseña el plan de desarrollo a partir de este análisis:\n${JSON.stringify(payload, null, 2)}` }],
    json: true,
    temperature: 0.4,
    maxOutputTokens: 8192,
  });

  const plan = ai.parseJson(text);
  plan._meta = { provider: providerId, model: settings.code.model, usage, generatedAt: new Date().toISOString() };
  await writeJson(path.join(dir, "plan.json"), plan);
  await writeJson(path.join(dir, "vision.json"), vision);
  await require("fs/promises").writeFile(path.join(dir, "plan.md"), renderPlanMarkdown(plan), "utf8");
  project.plan = { appName: plan.appName, appType: plan.appType, phaseCount: (plan.phases || []).length, generatedAt: plan._meta.generatedAt };
  project.activePhase = 5;
  await saveProject(project);
  return plan;
}

function renderPlanMarkdown(plan) {
  const lines = [];
  lines.push(`# ${plan.appName || "App"}`, "", plan.summary || "", "");
  lines.push(`- **Paquete:** \`${plan.packageName || ""}\``);
  lines.push(`- **Tipo:** ${plan.appType || ""}`);
  if (plan.stack) lines.push(`- **Stack:** ${plan.stack.language} + ${plan.stack.ui} (minSdk ${plan.stack.minSdk})`);
  lines.push("", "## Pantallas", "");
  for (const screen of plan.screens || []) {
    lines.push(`### ${screen.title} (\`${screen.composable}\`)`, screen.description || "");
    for (const c of screen.components || []) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push("## Navegación", "");
  for (const nav of plan.navigation || []) lines.push(`- ${nav.from} → ${nav.to}: ${nav.action}`);
  lines.push("", "## Mecánicas / Reglas", "");
  for (const g of plan.gameplay || []) lines.push(`- **${g.name}** (${g.priority}): ${g.description}`);
  lines.push("", "## Fases", "");
  for (const phase of plan.phases || []) {
    lines.push(`### Fase ${phase.number} — ${phase.name}`, phase.goal || "");
    for (const t of phase.tasks || []) lines.push(`- [ ] ${t}`);
    if (phase.definitionOfDone) lines.push(`- **Terminado cuando:** ${phase.definitionOfDone}`);
    lines.push("");
  }
  lines.push("## Riesgos", "");
  for (const r of plan.risks || []) lines.push(`- ${r}`);
  lines.push("", "## Supuestos", "");
  for (const a of plan.assumptions || []) lines.push(`- ${a}`);
  lines.push("", "## Fuera de alcance", "");
  for (const o of plan.outOfScope || []) lines.push(`- ${o}`);
  return lines.join("\n");
}

module.exports = { buildPlan, PLAN_SYSTEM, renderPlanMarkdown };
