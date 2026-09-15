const test = require("node:test");
const assert = require("node:assert");

const overlay = require("../src/autoclone/text-overlay");
const analyst = require("../src/competitor/ai-analyst");

test("text-overlay defaults to an available Gemini vision model", () => {
  assert.equal(overlay.DEFAULT_VISION_MODEL, "gemini-3.6-flash");
});

test("both modules expose the OpenRouter fallback pieces", () => {
  assert.equal(typeof overlay.callOpenRouterVision, "function");
  assert.equal(typeof overlay.isQuotaError, "function");
  assert.ok(overlay.OPENROUTER_VISION_MODELS.length > 0);
  assert.equal(typeof analyst.isQuotaError, "function");
  assert.ok(analyst.OPENROUTER_VISION_MODELS.length > 0);
});

test("isQuotaError flags quota failures and ignores auth ones", () => {
  assert.equal(overlay.isQuotaError({ message: "Se agoto la cuota de IA." }), true);
  assert.equal(overlay.isQuotaError({ code: 429 }), true);
  assert.equal(overlay.isQuotaError({ message: "La API key no es valida." }), false);
});

test("OpenRouter fallback models are free ids", () => {
  for (const model of overlay.OPENROUTER_VISION_MODELS) assert.match(model, /:free$/);
  for (const model of analyst.OPENROUTER_VISION_MODELS) assert.match(model, /:free$/);
});

test("buildAss closes short detection gaps in the black cover", () => {
  const ass = overlay.buildAss([
    { start: 0, end: 5, original: "same subtitle", translated: "mismo subtitulo", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
    { start: 6, end: 7, original: "same subtitle", translated: "mismo subtitulo", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
  ], { width: 720, height: 1280, duration: 7 });
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:06\.00,Cover/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:06\.00,Overlay/);
});

test("buildAss does not extend translated text across a different subtitle", () => {
  const ass = overlay.buildAss([
    { start: 0, end: 5, original: "first", translated: "primero", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
    { start: 6, end: 7, original: "second", translated: "segundo", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
  ], { width: 720, height: 1280, duration: 7 });
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:06\.00,Cover/);
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:05\.00,Overlay/);
});
