/**
 * Phase 3 — Vision: send frames to Gemini and get a structured read of the app.
 */

const fs = require("fs/promises");
const path = require("path");
const ai = require("./ai-providers");
const { projectDir, saveProject, readSettings, apiKeyFor } = require("./store");

const VISION_SYSTEM = `Eres un analista experto de producto móvil. Recibes fotogramas de un anuncio de una app o videojuego Android.
Tu trabajo es deducir, SOLO de la evidencia visual, qué es la aplicación y cómo funciona.
Si algo no se ve, marca null o "no observado"; nunca lo inventes.
Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin markdown.

Esquema:
{
  "appNameGuess": "nombre probable o null",
  "category": "juego-puzzle | juego-arcade | juego-3d | utilidad | social | finanzas | educativo | otro",
  "oneLiner": "qué hace la app en una frase",
  "genreReference": "a qué juego/app conocida se parece, sin afirmar que sea un clon",
  "monetization": ["anuncios", "compras", "suscripción", "no observado"],
  "screens": [
    { "name": "nombre de la pantalla", "purpose": "para qué sirve", "elements": ["botones", "hud", "textos", "iconos"] }
  ],
  "userFlow": ["paso 1", "paso 2"],
  "gameplayOrFeatures": [
    { "name": "mecánica o función", "description": "cómo funciona", "evidenceFrame": 3 }
  ],
  "visualStyle": { "palette": "colores", "typography": "tipos de letra", "art": "2D/3D, pixel, flat...", "ui": "minimalista, densa..." },
  "controls": "táctil, swipe, botones, joystick virtual...",
  "audioHints": "texto en pantalla sobre música/sonido, o no observado",
  "confidence": { "overall": 0.0, "notes": "qué limita la certeza" },
  "framewiseNotes": [ { "frame": 1, "note": "qué se ve" } ]
}`;

async function analyzeVision(project, { frames, onProgress } = {}) {
  const settings = await readSettings();
  const providerId = settings.vision.provider;
  const apiKey = await apiKeyFor(providerId);
  if (!apiKey) {
    throw new Error(`Falta la API key de ${ai.getProvider(providerId).label}. Añádela en Configuración.`);
  }
  const modelInfo = ai.resolveModel(providerId, settings.vision.model);
  if (!modelInfo.vision) {
    throw new Error(`El modelo "${settings.vision.model}" no acepta imágenes. Elige un modelo con visión para esta fase.`);
  }

  const dir = projectDir(project.id);
  let framePaths = frames;
  if (!framePaths) {
    const framesDir = path.join(dir, "frames");
    const names = (await fs.readdir(framesDir).catch(() => [])).filter((n) => n.endsWith(".jpg")).sort();
    framePaths = names.map((n) => path.join(framesDir, n));
  }
  if (!framePaths.length) throw new Error("No hay fotogramas. Ejecuta la fase 2 primero.");

  const limit = Math.min(Number(settings.maxFrames) || 40, framePaths.length);
  const selected = spread(framePaths, limit);
  onProgress?.({ stage: "vision", detail: `Enviando ${selected.length} fotogramas a Gemini…` });

  const parts = [{
    text: `Analiza estos ${selected.length} fotogramas del anuncio "${project.name}". ` +
      (project.storeUrl ? `URL de tienda aportada: ${project.storeUrl}. ` : "") +
      `Idioma del informe: ${settings.language}. Devuelve el JSON del esquema.`,
  }];
  for (let i = 0; i < selected.length; i += 1) {
    const buffer = await fs.readFile(selected[i]);
    parts.push({ text: `Fotograma ${i + 1} de ${selected.length}:` });
    parts.push({ image: { base64: buffer.toString("base64"), mimeType: "image/jpeg" } });
  }

  const { text, usage } = await ai.generate({
    providerId,
    apiKey,
    model: settings.vision.model,
    system: VISION_SYSTEM,
    parts,
    json: true,
    temperature: 0.2,
    maxOutputTokens: 8192,
  });

  const vision = ai.parseJson(text);
  vision._meta = { framesSent: selected.length, provider: providerId, model: settings.vision.model, usage, analyzedAt: new Date().toISOString() };
  await geminiJsonWrite(path.join(dir, "vision.json"), vision);
  project.vision = { framesSent: selected.length, category: vision.category, appNameGuess: vision.appNameGuess, analyzedAt: vision._meta.analyzedAt };
  project.activePhase = 4;
  await saveProject(project);
  return vision;
}

function spread(list, count) {
  if (list.length <= count) return list;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(list[Math.floor((i * (list.length - 1)) / (count - 1))]);
  }
  return Array.from(new Set(out));
}

async function geminiJsonWrite(filePath, value) {
  const { writeJson } = require("./store");
  await writeJson(filePath, value);
}

module.exports = { analyzeVision, VISION_SYSTEM };
