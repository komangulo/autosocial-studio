/**
 * Free-first model catalog.
 *
 * Providers that need no API key (browser-side):
 *   - puter      -> image + video, User-Pays, no key
 *   - pollinations -> image, no key
 *   - google-flow  -> video/image, browser automation of labs.google/fx/tools/flow
 * Providers with an optional free key:
 *   - google (Gemini / Nano Banana) -> image
 *   - huggingface -> image + video (free tier, low quota)
 */

const PROVIDERS = {
  puter: { id: "puter", label: "Puter.js", needsKey: false, runtime: "browser", docs: "https://developer.puter.com" },
  pollinations: { id: "pollinations", label: "Pollinations", needsKey: false, runtime: "any", docs: "https://pollinations.ai" },
  google: { id: "google", label: "Google AI Studio", needsKey: true, keyLabel: "Gemini API key", runtime: "server", docs: "https://aistudio.google.com/apikey" },
  huggingface: { id: "huggingface", label: "Hugging Face", needsKey: true, keyLabel: "HF token", runtime: "server", docs: "https://huggingface.co/settings/tokens" },
  flow: { id: "flow", label: "Google Flow", needsKey: false, runtime: "browser", docs: "https://labs.google/fx/tools/flow" },
};

const IMAGE_MODELS = [
  {
    id: "puter:nano-banana",
    provider: "puter",
    providerModel: "gemini-2.5-flash-image-preview",
    name: "Nano Banana (Gemini)",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    defaultRatio: "1:1",
    supportsReference: true,
    maxReferences: 3,
  },
  {
    id: "puter:gpt-image",
    provider: "puter",
    providerModel: "gpt-image-1-mini",
    name: "GPT Image 1 mini",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
  {
    id: "puter:flux",
    provider: "puter",
    providerModel: "flux-1.1-pro",
    name: "FLUX 1.1 Pro",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16", "3:2"],
    defaultRatio: "16:9",
    supportsReference: false,
  },
  {
    id: "puter:grok-image",
    provider: "puter",
    providerModel: "grok-imagine-image",
    name: "Grok Imagine Image",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
  {
    id: "pollinations:flux",
    provider: "pollinations",
    providerModel: "flux",
    name: "Pollinations FLUX",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
  {
    id: "pollinations:turbo",
    provider: "pollinations",
    providerModel: "turbo",
    name: "Pollinations Turbo",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
  {
    id: "google:nano-banana",
    provider: "google",
    providerModel: "gemini-2.5-flash-image-preview",
    name: "Nano Banana (Google AI Studio)",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    defaultRatio: "1:1",
    supportsReference: true,
    maxReferences: 3,
  },
  {
    id: "google:imagen-4",
    provider: "google",
    providerModel: "imagen-4.0-generate-001",
    name: "Imagen 4",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
  {
    id: "huggingface:flux",
    provider: "huggingface",
    providerModel: "black-forest-labs/FLUX.1-schnell",
    name: "FLUX.1 schnell (HF)",
    promptField: "prompt",
    ratios: ["1:1", "16:9", "9:16"],
    defaultRatio: "1:1",
    supportsReference: false,
  },
];

const VIDEO_MODELS = [
  // ---- Puter.js (User-Pays, no key) ----
  { id: "puter:sora-2", provider: "puter", providerModel: "sora-2", name: "Sora 2", promptField: "prompt", durations: [4, 8, 12], defaultDuration: 8, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1 },
  { id: "puter:veo-3.1", provider: "puter", providerModel: "veo-3.1-generate-preview", name: "Veo 3.1", promptField: "prompt", durations: [4, 6, 8], defaultDuration: 8, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 2 },
  { id: "puter:veo-3.1-fast", provider: "puter", providerModel: "veo-3.1-fast-generate-preview", name: "Veo 3.1 Fast", promptField: "prompt", durations: [4, 6, 8], defaultDuration: 8, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 2 },
  { id: "puter:veo-3.0", provider: "puter", providerModel: "veo-3.0-generate-001", name: "Veo 3.0", promptField: "prompt", durations: [4, 6, 8], defaultDuration: 8, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 2 },
  { id: "puter:veo-2.0", provider: "puter", providerModel: "veo-2.0-generate-001", name: "Veo 2.0", promptField: "prompt", durations: [5, 6, 8], defaultDuration: 5, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1 },
  { id: "puter:kling-2.1-master", provider: "puter", providerModel: "kwaivgi/kling-2.1-master", name: "Kling 2.1 Master", promptField: "prompt", durations: [5, 10], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1 },
  { id: "puter:kling-2.0-master", provider: "puter", providerModel: "kwaivgi/kling-2.0-master", name: "Kling 2.0 Master", promptField: "prompt", durations: [5, 10], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1 },
  { id: "puter:kling-1.6-standard", provider: "puter", providerModel: "kwaivgi/kling-1.6-standard", name: "Kling 1.6 Standard", promptField: "prompt", durations: [5, 10], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1 },
  { id: "puter:wan-2.7-t2v", provider: "puter", providerModel: "wan-ai/wan2.7-t2v", name: "Wan 2.7 Text-to-Video", promptField: "prompt", durations: [2, 5, 10, 15], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], defaultRatio: "16:9", resolutions: ["720P", "1080P"], defaultResolution: "720P", supportsReference: false },
  { id: "puter:wan-2.7-i2v", provider: "puter", providerModel: "wan-ai/wan2.7-i2v", name: "Wan 2.7 Image-to-Video", promptField: "prompt", durations: [2, 5, 10, 15], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], defaultRatio: "16:9", resolutions: ["720P", "1080P"], defaultResolution: "720P", supportsReference: true, maxReferences: 1, requiredReferences: 1 },
  { id: "puter:wan-2.7-r2v", provider: "puter", providerModel: "wan-ai/wan2.7-r2v", name: "Wan 2.7 Reference-to-Video", promptField: "prompt", durations: [2, 5, 10], defaultDuration: 5, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], defaultRatio: "16:9", resolutions: ["720P", "1080P"], defaultResolution: "720P", supportsReference: true, maxReferences: 4, requiredReferences: 1 },
  { id: "puter:vidu-q1", provider: "puter", providerModel: "vidu/vidu-q1", name: "Vidu Q1", promptField: "prompt", durations: [5], defaultDuration: 5, ratios: ["16:9", "1:1", "9:16"], defaultRatio: "16:9", resolutions: ["1920x1080", "1080x1080", "1080x1920"], defaultResolution: "1920x1080", supportsReference: true, maxReferences: 2 },
  { id: "puter:pixverse-v5", provider: "puter", providerModel: "pixverse/pixverse-v5", name: "PixVerse V5", promptField: "prompt", durations: [16, 24], defaultDuration: 16, ratios: ["16:9", "4:3", "1:1", "3:4", "9:16"], defaultRatio: "16:9", resolutions: ["360p", "540p", "720p", "1080p"], defaultResolution: "720p", supportsReference: true, maxReferences: 2 },
  // ---- Hugging Face free tier ----
  { id: "huggingface:wan-2.2-t2v", provider: "huggingface", providerModel: "Wan-AI/Wan2.2-T2V-A14B", name: "Wan 2.2 T2V (HF)", promptField: "prompt", durations: [5], defaultDuration: 5, ratios: ["16:9"], defaultRatio: "16:9", supportsReference: false, async: true },
  { id: "huggingface:ltx-video", provider: "huggingface", providerModel: "Lightricks/LTX-Video", name: "LTX-Video (HF)", promptField: "prompt", durations: [3, 5], defaultDuration: 3, ratios: ["16:9", "9:16"], defaultRatio: "16:9", supportsReference: true, maxReferences: 1, async: true },
];

const IMAGE_BY_ID = new Map(IMAGE_MODELS.map((m) => [m.id, m]));
const VIDEO_BY_ID = new Map(VIDEO_MODELS.map((m) => [m.id, m]));

function findImageModel(id) {
  return IMAGE_BY_ID.get(String(id || "")) || null;
}
function findVideoModel(id) {
  return VIDEO_BY_ID.get(String(id || "")) || null;
}

function sanitizeModel(model) {
  return model;
}

function imageModelCatalog() {
  return IMAGE_MODELS.map(sanitizeModel);
}
function videoModelCatalog() {
  return VIDEO_MODELS.map(sanitizeModel);
}

function allModels() {
  return [...IMAGE_MODELS, ...VIDEO_MODELS].map(sanitizeModel);
}

function providerCatalog() {
  return Object.values(PROVIDERS);
}

module.exports = {
  PROVIDERS,
  providerCatalog,
  IMAGE_MODELS,
  VIDEO_MODELS,
  allModels,
  findImageModel,
  findVideoModel,
  imageModelCatalog,
  videoModelCatalog,
};
