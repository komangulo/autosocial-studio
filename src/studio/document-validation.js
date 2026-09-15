const { StudioValidationError } = require("./validation");

const DOCUMENT_KINDS = new Set(["brief", "script", "bible", "references", "storyboard", "timeline", "graph"]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPTH = 20;
const MAX_ARRAY = 2000;

function assertJsonLimits(value, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) throw new StudioValidationError("Document JSON is too deeply nested.");
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new StudioValidationError("Document JSON must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value) && value.length > MAX_ARRAY) throw new StudioValidationError(`Document arrays may contain at most ${MAX_ARRAY} items.`);
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 200) throw new StudioValidationError("Document object keys are too long.");
    assertJsonLimits(child, depth + 1, seen);
  }
  seen.delete(value);
}

function stableId(value, label) {
  const result = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(result)) throw new StudioValidationError(`${label} requires a stable identifier.`);
  return result;
}
function ms(value, label, min = 0) {
  if (!Number.isInteger(value) || value < min || value > 86_400_000) throw new StudioValidationError(`${label} must be an integer number of milliseconds.`);
  return value;
}
function finite(value, label, min = -100000, max = 100000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new StudioValidationError(`${label} must be a finite number.`);
  return value;
}

function validateTimeline(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tracks)) throw new StudioValidationError("Timeline requires a tracks array.");
  if (value.tracks.length > 100) throw new StudioValidationError("Timeline supports at most 100 tracks.");
  const trackIds = new Set();
  const clipIds = new Set();
  for (const track of value.tracks) {
    const trackId = stableId(track?.id, "Track");
    if (trackIds.has(trackId)) throw new StudioValidationError("Timeline track identifiers must be unique.");
    trackIds.add(trackId);
    if (!["video", "audio", "subtitle"].includes(track.type)) throw new StudioValidationError("Unsupported timeline track type.");
    if (!Array.isArray(track.clips)) throw new StudioValidationError("Timeline tracks require clips arrays.");
    for (const clip of track.clips) {
      const clipId = stableId(clip?.id, "Clip");
      if (clipIds.has(clipId)) throw new StudioValidationError("Timeline clip identifiers must be unique.");
      clipIds.add(clipId);
      ms(clip.startMs, "Clip start");
      ms(clip.durationMs, "Clip duration", 1);
      if (track.type !== "subtitle") stableId(clip.assetId, "Clip asset");
      if (clip.trimStartMs !== undefined) ms(clip.trimStartMs, "Clip trim start");
      if (clip.trimEndMs !== undefined) ms(clip.trimEndMs, "Clip trim end");
      if (clip.trimStartMs !== undefined && clip.trimEndMs !== undefined && clip.trimEndMs <= clip.trimStartMs) throw new StudioValidationError("Clip trim end must follow trim start.");
      for (const [name, number] of Object.entries(clip.transform || {})) finite(number, `Transform ${name}`);
      for (const [name, number] of Object.entries(clip.color || {})) finite(number, `Color ${name}`);
      for (const [name, number] of Object.entries(clip.audio || {})) {
        if (["role", "normalization"].includes(name)) continue;
        finite(number, `Audio ${name}`);
      }
      if (clip.audio?.role !== undefined && !["dialogue", "voiceover", "music", "sfx"].includes(clip.audio.role)) throw new StudioValidationError("Unsupported audio role.");
      if (clip.audio?.normalization !== undefined && !["none", "peak", "loudness"].includes(clip.audio.normalization)) throw new StudioValidationError("Unsupported audio normalization.");
      if (clip.keyframes !== undefined) {
        if (!Array.isArray(clip.keyframes)) throw new StudioValidationError("Clip keyframes must be an array.");
        const properties = new Set(["opacity", "x", "y", "scale", "rotation", "exposure", "contrast", "gamma", "highlights", "shadows", "saturation", "temperature", "tint", "vignette"]);
        const points = new Set();
        for (const frame of clip.keyframes) {
          ms(frame.timeMs, "Keyframe time");
          const property = stableId(frame.property, "Keyframe property");
          if (!properties.has(property)) throw new StudioValidationError("Unsupported keyframe property.");
          if (frame.timeMs < clip.startMs || frame.timeMs > clip.startMs + clip.durationMs) throw new StudioValidationError("Keyframe time must be within its clip.");
          if (frame.easing !== undefined && !["linear", "ease-in", "ease-out", "ease-in-out"].includes(frame.easing)) throw new StudioValidationError("Unsupported keyframe easing.");
          finite(frame.value, "Keyframe value");
          const point = `${property}:${frame.timeMs}`;
          if (points.has(point)) throw new StudioValidationError("Keyframe property timestamps must be unique.");
          points.add(point);
        }
      }
      if (track.type === "subtitle") {
        if (typeof clip.text !== "string" || !clip.text.trim() || clip.text.length > 5000) throw new StudioValidationError("Subtitle clips require text.");
      }
    }
  }
  if (value.durationMs !== undefined) ms(value.durationMs, "Timeline duration", 1);
  if (value.subtitleStyle !== undefined) {
    const style = value.subtitleStyle;
    if (!style || typeof style !== "object" || Array.isArray(style)) throw new StudioValidationError("Subtitle style must be an object.");
    if (style.fontFamily !== undefined && (typeof style.fontFamily !== "string" || style.fontFamily.length > 120)) throw new StudioValidationError("Invalid subtitle font family.");
    if (style.fontSize !== undefined) finite(style.fontSize, "Subtitle font size", 8, 120);
    if (style.position !== undefined && !["top", "center", "bottom"].includes(style.position)) throw new StudioValidationError("Invalid subtitle position.");
    if (style.animation !== undefined && !["none", "fade", "pop", "karaoke", "slide-up"].includes(style.animation)) throw new StudioValidationError("Invalid subtitle animation.");
    for (const key of ["textColor", "backgroundColor", "primaryColor", "outlineColor"]) if (style[key] !== undefined && !/^#[0-9a-f]{6}$/i.test(style[key])) throw new StudioValidationError("Subtitle colors must use #RRGGBB.");
  }
  if (value.lutAssetId !== undefined) stableId(value.lutAssetId, "Timeline LUT asset");
  return value;
}

function validateGraph(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new StudioValidationError("Graph requires nodes and edges arrays.");
  }
  if (value.nodes.length > 200 || value.edges.length > 1000) throw new StudioValidationError("Graph is too large.");
  const nodeIds = new Set();
  for (const node of value.nodes) {
    const nodeId = stableId(node?.id, "Graph node");
    if (nodeIds.has(nodeId)) throw new StudioValidationError("Graph node identifiers must be unique.");
    nodeIds.add(nodeId);
    if (typeof node.label !== "string" || !node.label.trim() || node.label.length > 120) throw new StudioValidationError("Graph nodes require a bounded label.");
    if (typeof node.type !== "string" || !node.type.trim() || node.type.length > 60) throw new StudioValidationError("Graph nodes require a bounded type.");
    finite(node.x, "Graph node x", -100000, 100000);
    finite(node.y, "Graph node y", -100000, 100000);
    if (node.workspace !== undefined && (typeof node.workspace !== "string" || node.workspace.length > 60)) throw new StudioValidationError("Invalid graph workspace.");
  }
  const edgeIds = new Set();
  const adjacency = new Map([...nodeIds].map((nodeId) => [nodeId, []]));
  for (const edge of value.edges) {
    const edgeId = stableId(edge?.id, "Graph edge");
    if (edgeIds.has(edgeId)) throw new StudioValidationError("Graph edge identifiers must be unique.");
    edgeIds.add(edgeId);
    const from = stableId(edge?.from, "Graph edge source");
    const to = stableId(edge?.to, "Graph edge target");
    if (!nodeIds.has(from) || !nodeIds.has(to)) throw new StudioValidationError("Graph edges must reference existing nodes.");
    if (from === to) throw new StudioValidationError("Graph edges cannot be self-referential.");
    adjacency.get(from).push(to);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new StudioValidationError("Graph must remain acyclic.");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId)) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId);
  if (value.settings !== undefined && (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings))) throw new StudioValidationError("Graph settings must be an object.");
  return value;
}

function validateDocument(kind, content) {
  if (!DOCUMENT_KINDS.has(kind)) throw new StudioValidationError("Unsupported document kind.");
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new StudioValidationError("Document content must be a JSON object.");
  assertJsonLimits(content);
  let encoded;
  try { encoded = JSON.stringify(content); } catch { throw new StudioValidationError("Document content must be valid JSON."); }
  if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new StudioValidationError("Document content exceeds 1 MB.");
  if (kind === "brief" && ![content.objective, content.prompt, content.summary].some((v) => typeof v === "string")) throw new StudioValidationError("Brief requires objective, prompt, or summary text.");
  if (kind === "script" && !(typeof content.text === "string" || Array.isArray(content.scenes))) throw new StudioValidationError("Script requires text or scenes.");
  if (kind === "bible" && !(typeof content.summary === "string" || Array.isArray(content.characters) || content.style)) throw new StudioValidationError("Bible requires summary, characters, or style.");
  if (kind === "references" && !Array.isArray(content.items)) throw new StudioValidationError("References require an items array.");
  if (kind === "storyboard" && !Array.isArray(content.shots)) throw new StudioValidationError("Storyboard requires a shots array.");
  if (kind === "timeline") validateTimeline(content);
  if (kind === "graph") validateGraph(content);
  return JSON.parse(encoded);
}

module.exports = { DOCUMENT_KINDS, validateDocument, validateTimeline, validateGraph, MAX_JSON_BYTES };
