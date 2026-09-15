const CONTENT_TYPES = new Set([
  "story",
  "mini-film",
  "narrative-ad",
  "documentary",
  "educational",
  "custom",
]);
const ASPECT_RATIOS = new Set(["16:9", "9:16"]);
const FRAME_RATES = new Set([24, 25, 30, 50, 60]);
const PROJECT_STATUSES = new Set([
  "draft",
  "briefing",
  "script-review",
  "bible-review",
  "storyboard-review",
  "generating",
  "editing",
  "ready-to-render",
  "rendering",
  "completed",
  "publication-queued",
  "blocked",
  "archived",
]);

class StudioValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "StudioValidationError";
    this.statusCode = statusCode;
  }
}

function text(value, label, maxLength, required = false) {
  const result = String(value ?? "").trim().replace(/\r\n/g, "\n");
  if (required && !result) throw new StudioValidationError(`${label} is required.`);
  if (result.length > maxLength) throw new StudioValidationError(`${label} must be ${maxLength} characters or fewer.`);
  return result;
}

function integer(value, label, min, max, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new StudioValidationError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function enumValue(value, label, allowed, fallback) {
  const result = String(value ?? fallback);
  if (!allowed.has(result)) throw new StudioValidationError(`Unsupported ${label}.`);
  return result;
}

function dimensionsFor(aspectRatio) {
  return aspectRatio === "9:16"
    ? { width: 2160, height: 3840 }
    : { width: 3840, height: 2160 };
}

function normalizeCreateProject(input = {}) {
  const aspectRatio = enumValue(input.aspectRatio, "aspect ratio", ASPECT_RATIOS, "16:9");
  const dimensions = dimensionsFor(aspectRatio);
  const fps = integer(input.fps, "Frame rate", 24, 60, 30);
  if (!FRAME_RATES.has(fps)) throw new StudioValidationError("Frame rate must be 24, 25, 30, 50, or 60 fps.");
  return {
    title: text(input.title, "Project title", 120, true),
    contentType: enumValue(input.contentType, "content type", CONTENT_TYPES, "story"),
    objective: text(input.objective, "Objective", 2000),
    prompt: text(input.prompt, "Prompt", 10000),
    language: text(input.language || "es", "Language", 20, true).toLowerCase(),
    targetDurationSeconds: integer(input.targetDurationSeconds, "Target duration", 15, 3600, 300),
    aspectRatio,
    width: dimensions.width,
    height: dimensions.height,
    fps,
  };
}

function normalizeProjectPatch(input = {}) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(input, "title")) patch.title = text(input.title, "Project title", 120, true);
  if (Object.prototype.hasOwnProperty.call(input, "contentType")) patch.contentType = enumValue(input.contentType, "content type", CONTENT_TYPES);
  if (Object.prototype.hasOwnProperty.call(input, "objective")) patch.objective = text(input.objective, "Objective", 2000);
  if (Object.prototype.hasOwnProperty.call(input, "prompt")) patch.prompt = text(input.prompt, "Prompt", 10000);
  if (Object.prototype.hasOwnProperty.call(input, "language")) patch.language = text(input.language, "Language", 20, true).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(input, "targetDurationSeconds")) patch.targetDurationSeconds = integer(input.targetDurationSeconds, "Target duration", 15, 3600);
  if (Object.prototype.hasOwnProperty.call(input, "aspectRatio")) {
    patch.aspectRatio = enumValue(input.aspectRatio, "aspect ratio", ASPECT_RATIOS);
    Object.assign(patch, dimensionsFor(patch.aspectRatio));
  }
  if (Object.prototype.hasOwnProperty.call(input, "fps")) {
    patch.fps = integer(input.fps, "Frame rate", 24, 60);
    if (!FRAME_RATES.has(patch.fps)) throw new StudioValidationError("Frame rate must be 24, 25, 30, 50, or 60 fps.");
  }
  if (Object.prototype.hasOwnProperty.call(input, "status")) patch.status = enumValue(input.status, "project status", PROJECT_STATUSES);
  if (!Object.keys(patch).length) throw new StudioValidationError("No supported project fields were supplied.");
  return patch;
}

function normalizeBaseRevision(value) {
  return integer(value, "Base revision", 1, Number.MAX_SAFE_INTEGER);
}

module.exports = {
  CONTENT_TYPES,
  ASPECT_RATIOS,
  FRAME_RATES,
  PROJECT_STATUSES,
  StudioValidationError,
  normalizeCreateProject,
  normalizeProjectPatch,
  normalizeBaseRevision,
};
