/**
 * Turn an AI "Perfil de Competencia" into the final, reusable
 * "Prompt Maestro de Generación" for our own brand.
 */

function cleanText(value, fallback = "no observado") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value || "").trim();
  return text ? [text] : [];
}

/**
 * Build the master prompt deterministically from the analysis, so we always
 * have a usable template even if the model forgot to fill `masterPrompt`.
 * If the model DID provide one, it takes priority.
 */
function buildMasterPrompt(analysis, { brand = "nuestra marca", language = "es" } = {}) {
  const provided = String(analysis?.masterPrompt || "").trim();
  if (provided.length > 120) return provided;

  const style = analysis?.style || {};
  const narrative = analysis?.narrative || {};
  const categories = analysis?.categories || {};
  const topics = list(categories.mainTopics);

  return [
    `Eres un guionista y director de vídeo vertical para TikTok de ${brand}.`,
    `Genera un vídeo de 9:16 con una sola toma continua, estilo realista y limpio.`,
    ``,
    `OBJETIVO: replicar el patrón de éxito del competidor sin copiarlo, adaptado a ${brand}.`,
    `TEMÁTICA: ${topics.length ? topics.join(", ") : "definir por el cliente"}.`,
    ``,
    `GANCHO (primeros 3 segundos): ${cleanText(narrative.hooksFirst3s)}`,
    `ESTRUCTURA: ${cleanText(narrative.structure)}`,
    `RETENCIÓN: ${cleanText(narrative.retention)}`,
    `CTA FINAL: ${cleanText(narrative.ctas)}`,
    ``,
    `FORMATO VISUAL:`,
    `- Duración objetivo: ~${Number(style.avgDurationSeconds) || 9} s.`,
    `- Texto en pantalla: ${cleanText(style.onScreenText)}.`,
    `- Transiciones: ${cleanText(style.transitions)}.`,
    `- Música/efectos: ${cleanText(style.musicAndSfx)}.`,
    `- Paleta e iluminación: ${cleanText(style.paletteAndLighting)}.`,
    `- Encuadre: ${cleanText(style.framing)}.`,
    ``,
    `AUDIO: si el vídeo lleva voz, el sujeto habla mirando a cámara con lip sync perfecto, sin voz en off ni narrador.`,
    `IDIOMA: ${language}.`,
    `Devuelve solo el guion/prompt final, listo para pegar en un generador de vídeo por IA.`,
  ].join("\n");
}

/** Shape the stored report that the UI receives. */
function buildReport({ handle, url, collectedAt, summary, videos }, analysis, { brand, language, framesUsed }) {
  return {
    version: 1,
    handle,
    url,
    collectedAt,
    analyzedAt: new Date().toISOString(),
    brand: brand || "",
    language: language || "es",
    framesAnalyzed: framesUsed || 0,
    evidence: { summary, videoCount: videos.length },
    metrics: analysis?.metrics || {},
    style: analysis?.style || {},
    narrative: analysis?.narrative || {},
    categories: analysis?.categories || {},
    opportunities: list(analysis?.opportunities),
    summary: cleanText(analysis?.summary),
    masterPrompt: buildMasterPrompt(analysis, { brand, language }),
  };
}

module.exports = { buildMasterPrompt, buildReport };
