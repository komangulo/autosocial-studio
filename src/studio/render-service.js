const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");
const { StudioValidationError } = require("./validation");
const { commandAvailable } = require("./provider-service");
const { getStorageStatus } = require("./storage");
const { runProbe } = require("./asset-service");

const PRESETS = {
  preview: { width: 854, height: 480, crf: 28, storageBytes: 1024 ** 3 },
  "1080p": { width: 1920, height: 1080, crf: 22, storageBytes: 100 * 1024 ** 3 },
  "1080p-horizontal": { width: 1920, height: 1080, crf: 22, storageBytes: 100 * 1024 ** 3 },
  "1080p-vertical": { width: 1080, height: 1920, crf: 22, storageBytes: 100 * 1024 ** 3 },
  "4k-landscape": { width: 3840, height: 2160, crf: 20, storageBytes: 100 * 1024 ** 3 },
  "4k-horizontal": { width: 3840, height: 2160, crf: 20, storageBytes: 100 * 1024 ** 3 },
  "4k-vertical": { width: 2160, height: 3840, crf: 20, storageBytes: 100 * 1024 ** 3 },
};
const CODECS = {
  h264: { encoder: "libx264", pixelFormat: "yuv420p" },
  hevc: { encoder: "libx265", pixelFormat: "yuv420p" },
};
const SUBTITLE_ANIMATIONS = new Set(["none", "fade", "slide-up", "pop", "karaoke"]);
const EASINGS = new Set(["linear", "ease-in", "ease-out", "ease-in-out"]);

function parse(value, fallback = null) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
function numberText(value) { return Number(Number(value).toFixed(6)).toString(); }
function srtTime(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor(value / 60000) % 60;
  const seconds = Math.floor(value / 1000) % 60;
  const millis = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}
function assTime(milliseconds) {
  const centiseconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 10));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const seconds = Math.floor(centiseconds / 100) % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
function escapeAssText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");
}
function escapeFilterPath(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
function normalizeRenderOptions(input = {}) {
  const subtitleMode = input.subtitleMode === "burn" ? "burn" : "embed";
  const codec = CODECS[input.codec] ? input.codec : "h264";
  const animation = SUBTITLE_ANIMATIONS.has(input.subtitleStyle?.animation) ? input.subtitleStyle.animation : "none";
  const fontSize = Math.round(clamp(input.subtitleStyle?.fontSize ?? 42, 12, 120));
  const marginV = Math.round(clamp(input.subtitleStyle?.marginV ?? 64, 0, 1000));
  const primaryColorValue = input.subtitleStyle?.primaryColor || input.subtitleStyle?.textColor;
  const outlineColorValue = input.subtitleStyle?.outlineColor || input.subtitleStyle?.backgroundColor;
  const primaryColor = /^#[0-9a-f]{6}$/i.test(String(primaryColorValue || "")) ? primaryColorValue : "#FFFFFF";
  const outlineColor = /^#[0-9a-f]{6}$/i.test(String(outlineColorValue || "")) ? outlineColorValue : "#000000";
  const position = ["top", "center", "bottom"].includes(input.subtitleStyle?.position) ? input.subtitleStyle.position : "bottom";
  const fontFamily = String(input.subtitleStyle?.fontFamily || "Arial").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 120) || "Arial";
  const lutAssetId = input.lutAssetId == null || input.lutAssetId === "" ? null : String(input.lutAssetId);
  if (lutAssetId && !/^[0-9a-f-]{36}$/i.test(lutAssetId)) throw new StudioValidationError("Invalid LUT asset identifier.");
  return { subtitleMode, codec, lutAssetId, subtitleStyle: { animation, fontSize, marginV, primaryColor, outlineColor, position, fontFamily } };
}
function hexToAss(color) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return match ? `&H00${match[3]}${match[2]}${match[1]}`.toUpperCase() : "&H00FFFFFF";
}
function subtitleOverride(animation, width, height, durationMs) {
  if (animation === "fade") return "{\\fad(180,180)}";
  if (animation === "slide-up") return `{\\move(${Math.round(width / 2)},${height + 80},${Math.round(width / 2)},${Math.round(height * 0.88)},0,260)}`;
  if (animation === "pop") return `{\\fscx70\\fscy70\\t(0,180,\\fscx100\\fscy100)\\fad(80,120)}`;
  if (animation === "karaoke") return `{\\k${Math.max(1, Math.round(durationMs / 10))}}`;
  return "";
}
function makeAss(subtitles, preset, options) {
  const style = options.subtitleStyle;
  const alignment = style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${preset.width}\nPlayResY: ${preset.height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,${style.fontFamily},${style.fontSize},${hexToAss(style.primaryColor)},${hexToAss(style.primaryColor)},${hexToAss(style.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,3,1,${alignment},48,48,${style.marginV},1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  return header + subtitles.map((cue) => `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${subtitleOverride(style.animation, preset.width, preset.height, cue.endMs - cue.startMs)}${escapeAssText(cue.text)}`).join("\n") + "\n";
}
function easeExpression(easing, p) {
  if (easing === "ease-in") return `pow(${p},2)`;
  if (easing === "ease-out") return `(1-pow(1-${p},2))`;
  if (easing === "ease-in-out") return `if(lt(${p},0.5),2*pow(${p},2),1-pow(-2*${p}+2,2)/2)`;
  return p;
}
function keyframeExpression(clip, property, fallback) {
  const frames = (Array.isArray(clip.keyframes) ? clip.keyframes : [])
    .filter((frame) => frame && frame.property === property && Number.isFinite(frame.value) && Number.isInteger(frame.timeMs))
    .sort((left, right) => left.timeMs - right.timeMs);
  if (!frames.length) return numberText(fallback);
  const unique = [];
  for (const frame of frames) {
    const normalized = { ...frame, easing: EASINGS.has(frame.easing) ? frame.easing : "linear" };
    if (unique.at(-1)?.timeMs === normalized.timeMs) unique[unique.length - 1] = normalized;
    else unique.push(normalized);
  }
  if (unique.length === 1) return numberText(unique[0].value);
  let expression = numberText(unique.at(-1).value);
  for (let index = unique.length - 2; index >= 0; index -= 1) {
    const left = unique[index];
    const right = unique[index + 1];
    const start = left.timeMs / 1000;
    const end = right.timeMs / 1000;
    const progress = `(t-${numberText(start)})/${numberText(end - start)}`;
    const eased = easeExpression(right.easing, progress);
    const segment = `${numberText(left.value)}+(${numberText(right.value)}-${numberText(left.value)})*${eased}`;
    expression = `if(lt(t,${numberText(start)}),${numberText(left.value)},if(lte(t,${numberText(end)}),${segment},${expression}))`;
  }
  return expression;
}
function mapRender(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    accountId: row.account_id,
    timelineVersion: row.timeline_version,
    preset: row.preset,
    options: parse(row.options_json, {}),
    status: row.status,
    jobId: row.job_id,
    outputAssetId: row.output_asset_id,
    error: parse(row.error_json),
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}
function probeVideoStream(metadata) {
  return metadata?.streams?.find((stream) => stream.codec_type === "video");
}
function parseRate(value) {
  const [numerator, denominator] = String(value || "0/1").split("/").map(Number);
  return denominator ? numerator / denominator : 0;
}
async function verifyRenderOutput(filePath, preset, fps, durationSeconds) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1024) throw new Error("FFmpeg output is empty or incomplete.");
  const metadata = await runProbe(filePath);
  const video = probeVideoStream(metadata);
  if (!video || Number(video.width) !== preset.width || Number(video.height) !== preset.height) throw new Error("Rendered dimensions do not match the selected preset.");
  const actualFps = parseRate(video.avg_frame_rate || video.r_frame_rate);
  if (!Number.isFinite(actualFps) || Math.abs(actualFps - fps) > 0.1) throw new Error("Rendered frame rate does not match the project.");
  const actualDuration = Number(metadata?.format?.duration);
  if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - durationSeconds) > Math.max(0.25, 2 / fps)) throw new Error("Rendered duration failed verification.");
  return metadata;
}

class RenderService {
  constructor({ database, projectService, documentService, assetService, jobService, rootPath }) {
    Object.assign(this, { db: database.db, projectService, documentService, assetService, jobService, rootPath: path.resolve(rootPath) });
    this.children = new Map();
  }

  list(accountId, projectId) {
    this.projectService.get(accountId, projectId);
    return this.db.prepare("SELECT * FROM studio_renders WHERE account_id=? AND project_id=? ORDER BY created_at DESC").all(accountId, projectId).map(mapRender);
  }
  get(accountId, projectId, renderId) {
    this.projectService.get(accountId, projectId);
    const row = this.db.prepare("SELECT * FROM studio_renders WHERE id=? AND account_id=? AND project_id=?").get(renderId, accountId, projectId);
    if (!row) throw new StudioValidationError("Render not found.", 404);
    return mapRender(row);
  }
  create(accountId, projectId, input = {}) {
    const preset = String(input.preset || "preview");
    if (!PRESETS[preset]) throw new StudioValidationError("Unsupported render preset.");
    const timelineVersion = Number(input.timelineVersion);
    const timeline = this.documentService.get(accountId, projectId, "timeline", timelineVersion);
    if (timeline.status !== "approved") throw new StudioValidationError("Timeline version must be approved before rendering.", 409);
    const storyboard = this.documentService.list(accountId, projectId, "storyboard").find((item) => item.status === "approved");
    if (!storyboard || storyboard.content?.roughCutApproved !== true) throw new StudioValidationError("An approved storyboard with rough-cut approval is required before rendering.", 409);
    const options = normalizeRenderOptions({ ...(input.options || input), lutAssetId: (input.options || input).lutAssetId || timeline.content?.lutAssetId });
    if (options.lutAssetId) {
      const lut = this.assetService.get(accountId, projectId, options.lutAssetId);
      if (lut.kind !== "lut" && lut.mimeType !== "application/x-cube") throw new StudioValidationError("Selected asset is not a validated CUBE LUT.");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    let job;
    this.db.transaction(() => {
      job = this.jobService.enqueue(accountId, projectId, { type: "render", dedupeKey: `render:${id}`, input: { renderId: id } });
      this.db.prepare("INSERT INTO studio_renders(id,project_id,account_id,timeline_version,preset,options_json,status,job_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)")
        .run(id, projectId, accountId, timelineVersion, preset, JSON.stringify(options), job.id, now, now);
    })();
    return this.get(accountId, projectId, id);
  }
  setBlocked(render, reason) {
    const now = new Date().toISOString();
    const error = JSON.stringify({ code: "blocked", message: reason });
    this.db.transaction(() => {
      this.db.prepare("UPDATE studio_renders SET status='blocked',error_json=?,updated_at=? WHERE id=?").run(error, now, render.id);
      this.db.prepare("UPDATE studio_jobs SET status='blocked',error_json=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(error, now, render.jobId);
    })();
    return this.get(render.accountId, render.projectId, render.id);
  }

  async process(accountId, projectId, renderId) {
    const project = this.projectService.get(accountId, projectId);
    const render = this.get(accountId, projectId, renderId);
    if (render.status !== "queued") throw new StudioValidationError("Render is not queued.", 409);
    if (!(await commandAvailable("ffmpeg")) || !(await commandAvailable("ffprobe"))) return this.setBlocked(render, "FFmpeg and ffprobe must be available on PATH.");
    const preset = PRESETS[render.preset];
    const storage = await getStorageStatus(this.rootPath);
    if (!storage.known || Number(storage.freeBytes) < preset.storageBytes) return this.setBlocked(render, render.preset === "preview" ? "At least 1 GiB of free storage is required for preview rendering." : "At least 100 GiB of free storage is required for final long-form rendering.");

    const timeline = this.documentService.get(accountId, projectId, "timeline", render.timelineVersion).content;
    const videoTracks = timeline.tracks.filter((track) => track.type === "video");
    const audioTracks = timeline.tracks.filter((track) => track.type === "audio");
    const activeVideoTracks = videoTracks.some((track) => track.solo) ? videoTracks.filter((track) => track.solo && !track.muted) : videoTracks.filter((track) => !track.muted);
    const activeAudioTracks = audioTracks.some((track) => track.solo) ? audioTracks.filter((track) => track.solo && !track.muted) : audioTracks.filter((track) => !track.muted);
    const visual = activeVideoTracks.flatMap((track) => [...track.clips].sort((a, b) => a.startMs - b.startMs));
    const audio = activeAudioTracks.flatMap((track) => [...track.clips].sort((a, b) => a.startMs - b.startMs));
    if (!visual.length) return this.setBlocked(render, "Timeline has no visual assets to render.");
    let assets;
    try { assets = new Map([...visual, ...audio].map((clip) => [clip.assetId, this.assetService.contentPath(accountId, projectId, clip.assetId)])); }
    catch (error) { return this.setBlocked(render, error.message); }

    let lutPath = null;
    if (render.options?.lutAssetId) {
      try { lutPath = this.assetService.contentPath(accountId, projectId, render.options.lutAssetId).filePath; }
      catch (error) { return this.setBlocked(render, error.message); }
    }
    const projectRoot = await this.projectService.ensureProjectFolders(accountId, projectId);
    const worker = `render-${randomUUID()}`;
    const now = new Date().toISOString();
    const claimed = this.db.prepare("UPDATE studio_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,heartbeat_at=?,updated_at=? WHERE id=? AND status='queued'")
      .run(worker, new Date(Date.now() + 300000).toISOString(), now, now, render.jobId);
    if (!claimed.changes) throw new StudioValidationError("Render job is not available.", 409);
    this.db.prepare("UPDATE studio_renders SET status='running',error_json=NULL,updated_at=? WHERE id=?").run(now, render.id);

    const fps = project.fps;
    const output = path.join(projectRoot, "tmp", `${render.id}.mp4.partial`);
    const final = path.join(projectRoot, "renders", `${render.id}.mp4`);
    const args = ["-y"];
    const all = [...visual, ...audio];
    for (const clip of all) {
      const item = assets.get(clip.assetId);
      if (item.asset.kind === "image") args.push("-loop", "1");
      if (clip.trimStartMs) args.push("-ss", String(clip.trimStartMs / 1000));
      args.push("-t", String(clip.durationMs / 1000), "-i", item.filePath);
    }
    const subtitles = Array.isArray(timeline.subtitles) ? timeline.subtitles.filter((cue) => cue && Number.isInteger(cue.startMs) && Number.isInteger(cue.endMs) && cue.endMs > cue.startMs && String(cue.text || "").trim()) : [];
    const subtitleMode = render.options?.subtitleMode === "burn" ? "burn" : "embed";
    const subtitlePath = subtitles.length ? path.join(projectRoot, "tmp", `${render.id}.${subtitleMode === "burn" ? "ass" : "srt"}`) : null;
    if (subtitlePath) {
      const body = subtitleMode === "burn"
        ? makeAss(subtitles, preset, normalizeRenderOptions(render.options))
        : subtitles.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${String(cue.text).replace(/\r/g, "")}\n`).join("\n");
      await fs.writeFile(subtitlePath, body, { encoding: "utf8", mode: 0o600 });
      if (subtitleMode === "embed") args.push("-i", subtitlePath);
    }
    const durationMs = Math.max(Number(timeline.durationMs) || 0, ...visual.map((clip) => clip.startMs + clip.durationMs), ...audio.map((clip) => clip.startMs + clip.durationMs));
    const durationSeconds = Math.max(0.1, durationMs / 1000);
    const filters = [`color=c=black:s=${preset.width}x${preset.height}:r=${fps}:d=${durationSeconds}[base0]`];
    let previous = "base0";
    visual.forEach((clip, index) => {
      const color = clip.color || {};
      const transform = clip.transform || {};
      const exposureExpression = `(${keyframeExpression(clip, "exposure", color.exposure || 0)})/10`;
      const contrastExpression = `(${keyframeExpression(clip, "contrast", color.contrast || 0)})/100+1`;
      const saturationExpression = `(${keyframeExpression(clip, "saturation", color.saturation === undefined ? 100 : color.saturation)})/100`;
      const gammaExpression = keyframeExpression(clip, "gamma", color.gamma === undefined ? 1 : color.gamma);
      const highlights = clamp(color.highlights, -100, 100) / 500;
      const shadows = clamp(color.shadows, -100, 100) / 500;
      const temperature = clamp(color.temperature, -100, 100) / 500;
      const tint = clamp(color.tint, -100, 100) / 500;
      const vignette = clamp(color.vignette, -100, 100);
      const opacityExpression = keyframeExpression(clip, "opacity", transform.opacity === undefined ? 100 : transform.opacity);
      const rotationExpression = keyframeExpression(clip, "rotation", transform.rotation || 0);
      const scaleExpression = keyframeExpression(clip, "scale", transform.scale === undefined ? 100 : transform.scale);
      const start = clip.startMs / 1000;
      const end = (clip.startMs + clip.durationMs) / 1000;
      const chain = [
        `[${index}:v]trim=duration=${clip.durationMs / 1000}`,
        `setpts=PTS-STARTPTS+${start}/TB`,
        `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease`,
        `scale=w='trunc(iw*(${scaleExpression})/100/2)*2':h='trunc(ih*(${scaleExpression})/100/2)*2':eval=frame`,
        `crop=min(iw\\,${preset.width}):min(ih\\,${preset.height})`,
        `eq=brightness='${exposureExpression}':contrast='${contrastExpression}':saturation='${saturationExpression}':gamma='${gammaExpression}':eval=frame`,
      ];
      if (highlights || shadows || temperature || tint) chain.push(`colorbalance=rs=${numberText(shadows + temperature)}:gs=${numberText(shadows + tint)}:bs=${numberText(shadows - temperature)}:rh=${numberText(highlights + temperature)}:gh=${numberText(highlights + tint)}:bh=${numberText(highlights - temperature)}:pl=1`);
      if (lutPath) chain.push(`lut3d=file='${escapeFilterPath(lutPath)}'`);
      if (vignette) chain.push(`vignette=angle=${numberText((Math.PI / 5) * Math.abs(vignette) / 100)}:mode=${vignette < 0 ? "backward" : "forward"}:eval=frame`);
      chain.push("format=rgba");
      chain.push(`rotate='(${rotationExpression})*PI/180':ow=iw:oh=ih:c=none`);
      chain.push(`pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      chain.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacityExpression})/100'[v${index}]`);
      filters.push(chain.join(","));
      const next = `base${index + 1}`;
      const x = keyframeExpression(clip, "x", transform.x || 0);
      const y = keyframeExpression(clip, "y", transform.y || 0);
      filters.push(`[${previous}][v${index}]overlay=x='${x}':y='${y}':eval=frame:eof_action=pass:shortest=0:enable='between(t,${start},${end})'[${next}]`);
      previous = next;
    });
    if (subtitlePath && subtitleMode === "burn") {
      const burned = "burned";
      filters.push(`[${previous}]subtitles=filename='${escapeFilterPath(subtitlePath)}'[${burned}]`);
      previous = burned;
    }
    if (audio.length) {
      const dialogue = audio.filter((clip) => ["dialogue", "voiceover"].includes(clip.audio?.role));
      audio.forEach((clip, index) => {
        const input = visual.length + index;
        const volume = Math.max(0, Number(clip.audio?.volume ?? 1));
        const delay = Math.max(0, clip.startMs);
        const fadeIn = Math.max(0, Number(clip.audio?.fadeInMs || 0)) / 1000;
        const fadeOut = Math.max(0, Number(clip.audio?.fadeOutMs || 0)) / 1000;
        const clipSeconds = clip.durationMs / 1000;
        const chain = [`atrim=duration=${clipSeconds}`, "asetpts=PTS-STARTPTS", "aformat=sample_fmts=fltp:channel_layouts=stereo"];
        const ducking = clamp(clip.audio?.ducking, 0, 100);
        const overlaps = ducking && ["music", "sfx"].includes(clip.audio?.role)
          ? dialogue.map((voice) => [Math.max(0, voice.startMs - clip.startMs) / 1000, Math.min(clip.durationMs, voice.startMs + voice.durationMs - clip.startMs) / 1000]).filter(([a, b]) => b > a)
          : [];
        const duckFactor = Math.max(0.02, 1 - ducking / 100);
        const duckExpression = overlaps.reduce((expression, [a, b]) => `if(between(t,${numberText(a)},${numberText(b)}),${numberText(duckFactor)},${expression})`, "1");
        chain.push(`volume='${numberText(volume)}*(${duckExpression})':eval=frame`);
        const pan = clamp(clip.audio?.pan, -100, 100) / 100;
        if (pan) chain.push(`pan=stereo|c0=${numberText(pan > 0 ? 1 - pan : 1)}*c0|c1=${numberText(pan < 0 ? 1 + pan : 1)}*c1`);
        if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${Math.min(fadeIn, clipSeconds)}`);
        if (fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, clipSeconds - fadeOut)}:d=${Math.min(fadeOut, clipSeconds)}`);
        chain.push(`adelay=${delay}:all=1`);
        filters.push(`[${input}:a]${chain.join(",")}[a${index}]`);
      });
      const normalization = audio.some((clip) => clip.audio?.normalization === "loudness") ? "loudness" : audio.some((clip) => clip.audio?.normalization === "peak") ? "peak" : "none";
      let mix = `${audio.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audio.length}:duration=longest:normalize=0`;
      if (normalization === "loudness") mix += ",loudnorm=I=-16:LRA=11:TP=-1.5";
      else if (normalization === "peak") mix += ",alimiter=limit=0.891251:attack=5:release=50";
      else mix += ",alimiter=limit=0.977237:attack=5:release=50";
      filters.push(`${mix}[aout]`);
    }
    args.push("-filter_complex", filters.join(";"), "-map", `[${previous}]`);
    if (audio.length) args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
    else args.push("-an");
    if (subtitlePath && subtitleMode === "embed") args.push("-map", `${all.length}:s:0`, "-c:s", "mov_text");
    const codec = CODECS[render.options?.codec] || CODECS.h264;
    args.push("-c:v", codec.encoder, "-preset", "veryfast", "-crf", String(preset.crf), "-r", String(fps), "-pix_fmt", codec.pixelFormat, "-movflags", "+faststart", "-t", String(durationSeconds), "-progress", "pipe:2", "-f", "mp4", output);

    let stderr = "";
    let heartbeat;
    let cancellation;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        this.children.set(render.id, child);
        heartbeat = setInterval(() => {
          const timestamp = new Date();
          this.db.prepare("UPDATE studio_jobs SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=?")
            .run(timestamp.toISOString(), new Date(timestamp.getTime() + 300000).toISOString(), timestamp.toISOString(), render.jobId, worker);
        }, 30000);
        heartbeat.unref?.();
        cancellation = setInterval(() => {
          const status = this.db.prepare("SELECT status FROM studio_jobs WHERE id=?").get(render.jobId)?.status;
          if (status === "cancelled") child.kill("SIGTERM");
        }, 1000);
        cancellation.unref?.();
        child.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr = (stderr + text).slice(-12000);
          const matches = [...text.matchAll(/out_time_(?:ms|us)=(\d+)/g)];
          const match = matches.at(-1);
          if (match) {
            const progress = Math.min(99, Math.floor((Number(match[1]) / 1000 / durationMs) * 100));
            this.db.prepare("UPDATE studio_renders SET progress=?,updated_at=? WHERE id=?").run(progress, new Date().toISOString(), render.id);
          }
        });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(code === null ? "FFmpeg was cancelled." : `FFmpeg exited with code ${code}: ${stderr}`)));
      });
      await verifyRenderOutput(output, preset, fps, durationSeconds);
      await fs.rename(output, final);
      const outputAsset = await this.assetService.registerOutput(accountId, projectId, final, "video/mp4", `${render.id}.mp4`);
      const finished = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare("UPDATE studio_renders SET status='completed',output_asset_id=?,progress=100,updated_at=?,finished_at=? WHERE id=?").run(outputAsset.id, finished, finished, render.id);
        this.db.prepare("UPDATE studio_jobs SET status='completed',result_json=?,progress_current=100,progress_total=100,updated_at=?,finished_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND lease_owner=?")
          .run(JSON.stringify({ outputAssetId: outputAsset.id, verified: true }), finished, finished, render.jobId, worker);
      })();
      return this.get(accountId, projectId, render.id);
    } catch (error) {
      await fs.rm(output, { force: true });
      const current = this.db.prepare("SELECT status FROM studio_jobs WHERE id=?").get(render.jobId);
      const status = current?.status === "cancelled" ? "cancelled" : "failed";
      const ended = new Date().toISOString();
      const detail = JSON.stringify({ message: String(error.message).slice(0, 4000) });
      this.db.transaction(() => {
        this.db.prepare("UPDATE studio_renders SET status=?,error_json=?,updated_at=?,finished_at=? WHERE id=?").run(status, detail, ended, ended, render.id);
        if (status === "failed") this.db.prepare("UPDATE studio_jobs SET status='failed',error_json=?,updated_at=?,finished_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?").run(detail, ended, ended, render.jobId, worker);
      })();
      return this.get(accountId, projectId, render.id);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (cancellation) clearInterval(cancellation);
      this.children.delete(render.id);
      if (subtitlePath) await fs.rm(subtitlePath, { force: true });
    }
  }
  cancel(accountId, projectId, renderId) {
    const render = this.get(accountId, projectId, renderId);
    if (!["queued", "running", "blocked", "failed"].includes(render.status)) throw new StudioValidationError("Render cannot be cancelled.", 409);
    this.jobService.cancel(accountId, projectId, render.jobId);
    this.children.get(render.id)?.kill("SIGTERM");
    const now = new Date().toISOString();
    this.db.prepare("UPDATE studio_renders SET status='cancelled',updated_at=?,finished_at=? WHERE id=?").run(now, now, render.id);
    return this.get(accountId, projectId, render.id);
  }
  retry(accountId, projectId, renderId) {
    const render = this.get(accountId, projectId, renderId);
    if (!["failed", "blocked", "cancelled"].includes(render.status)) throw new StudioValidationError("Render cannot be retried.", 409);
    this.jobService.retry(accountId, projectId, render.jobId);
    this.db.prepare("UPDATE studio_renders SET status='queued',error_json=NULL,progress=0,updated_at=?,finished_at=NULL WHERE id=?").run(new Date().toISOString(), render.id);
    return this.get(accountId, projectId, render.id);
  }
  content(accountId, projectId, renderId) {
    const render = this.get(accountId, projectId, renderId);
    if (render.status !== "completed" || !render.outputAssetId) throw new StudioValidationError("Render content is not available.", 409);
    return this.assetService.contentPath(accountId, projectId, render.outputAssetId);
  }
  reconcileInterrupted() {
    const now = new Date().toISOString();
    const rows = this.db.prepare("SELECT * FROM studio_renders WHERE status='running'").all();
    for (const row of rows) {
      const job = row.job_id ? this.db.prepare("SELECT status FROM studio_jobs WHERE id=?").get(row.job_id) : null;
      if (!job || job.status !== "running") this.db.prepare("UPDATE studio_renders SET status='failed',error_json=?,updated_at=?,finished_at=? WHERE id=?").run(JSON.stringify({ code: "interrupted", message: "Render was interrupted and can be retried." }), now, now, row.id);
    }
    return rows.length;
  }
  close() {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}

module.exports = { RenderService, PRESETS, CODECS, mapRender, normalizeRenderOptions, keyframeExpression, makeAss, escapeAssText, verifyRenderOutput };
