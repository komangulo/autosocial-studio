const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const os = require("os");

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(`${cmd} failed with code ${code}\n${stderr}`);
      error.code = code;
      finish(reject, error);
    });
  });
}

function runFfmpeg(args) {
  return runProcess("ffmpeg", args);
}

function runFfprobe(args) {
  return runProcess("ffprobe", args);
}

async function getVideoInfo(inputPath) {
  const { stdout } = await runFfprobe([
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);
  return JSON.parse(stdout);
}

async function checkFfmpeg() {
  try {
    await runFfmpeg(["-version"]);
    return true;
  } catch {
    return false;
  }
}

function buildMetadataArgs() {
  const now = new Date();
  const fakeDate = new Date(
    now.getTime() + randInt(-365, 365) * 86400000 + randInt(-23, 23) * 3600000
  );

  const titles = [
    "",
    `clip_${crypto.randomBytes(8).toString("hex")}`,
    `VID_${randInt(20200101, 20261231)}_${randInt(100000, 999999)}`,
    `IMG_${randInt(1000, 9999)}`,
  ];

  const encoders = [
    `Lavf ${randInt(57, 61)}.${randInt(10, 99)}.${randInt(100, 999)}`,
    `HandBrake ${randInt(1, 2)}.${randInt(0, 8)}.${randInt(0, 4)}`,
    "",
  ];

  return [
    "-metadata", `title=${pick(titles)}`,
    "-metadata", `comment=${crypto.randomBytes(12).toString("hex")}`,
    "-metadata", `creation_time=${fakeDate.toISOString()}`,
    "-metadata", `encoder=${pick(encoders)}`,
    "-metadata", `description=`,
    "-metadata", `artist=`,
  ];
}

/**
 * Video filters: each one changes the pixel data in a different way.
 * Kept lean to avoid CPU overload.
 */
function buildVideoFilters(options = {}) {
  const filters = [];

  // Drop a fixed 0.30s from the very start (the opening seconds are the most
  // heavily fingerprinted). Audio mirrors this cut so both stay in sync.
  if (options.trimSegments) {
    const cutStart = "0.30";
    filters.push(`trim=start=${cutStart}`);
    filters.push(`setpts=PTS-STARTPTS`);
    options.__videoTrimStart = cutStart;
  }

  // Real frame crop + rescale. This is the strongest anti-fingerprint move:
  // it removes the outer border and re-frames every pixel of the video.
  if (options.cropPercent && options.cropPercent > 0) {
    const pct = Math.min(Math.max(Number(options.cropPercent), 0), 15) / 100;
    const keep = (1 - pct).toFixed(4);
    const offsetX = (pct / 2).toFixed(4);
    const offsetY = (pct / 2).toFixed(4);
    // Crop then scale back to even dimensions so encoders are happy.
    filters.push(`crop=trunc(iw*${keep}/2)*2:trunc(ih*${keep}/2)*2:iw*${offsetX}:ih*${offsetY}`);
    filters.push(`scale=trunc(iw/${keep}/2)*2:trunc(ih/${keep}/2)*2`);
  }

  // Horizontal mirror. Flips the composition entirely.
  if (options.mirror) {
    filters.push(`hflip`);
  }

  // Freeze-clone first/last frame for a short bit. Off by default: it changes
  // the video duration without touching audio, which drifts the sync.
  if (options.freezeFrames === true) {
    const s = randFloat(0.05, 0.3).toFixed(2);
    const e = randFloat(0.05, 0.3).toFixed(2);
    filters.push(`tpad=start_duration=${s}:start_mode=clone:stop_duration=${e}:stop_mode=clone`);
  }

  // Brightness / contrast / saturation
  if (options.colorShift !== false) {
    filters.push(
      `eq=brightness=${randFloat(-0.03, 0.03).toFixed(3)}` +
      `:contrast=${randFloat(0.97, 1.03).toFixed(3)}` +
      `:saturation=${randFloat(0.95, 1.05).toFixed(3)}` +
      `:gamma=${randFloat(0.97, 1.03).toFixed(3)}`
    );
  }

  // Hue rotation
  if (options.hueShift !== false) {
    filters.push(`hue=h=${randFloat(-4, 4).toFixed(2)}:s=${randFloat(0.96, 1.04).toFixed(3)}`);
  }

  // Color channel bleed
  if (options.channelMix !== false) {
    const rr = randFloat(0.97, 1.0).toFixed(3);
    const rg = randFloat(0.0, 0.02).toFixed(3);
    const rb = randFloat(0.0, 0.02).toFixed(3);
    const gr = randFloat(0.0, 0.02).toFixed(3);
    const gg = randFloat(0.97, 1.0).toFixed(3);
    const gb = randFloat(0.0, 0.02).toFixed(3);
    const br = randFloat(0.0, 0.02).toFixed(3);
    const bg = randFloat(0.0, 0.02).toFixed(3);
    const bb = randFloat(0.97, 1.0).toFixed(3);
    filters.push(`colorchannelmixer=${rr}:${rg}:${rb}:0:${gr}:${gg}:${gb}:0:${br}:${bg}:${bb}:0`);
  }

  // Subtle noise
  if (options.noise !== false) {
    const maxNoise = options.noiseStrength ? Number(options.noiseStrength) : 3;
    filters.push(`noise=alls=${randInt(1, Math.max(1, maxNoise))}:allf=t`);
  }

  // Micro crop + pad (shifts pixel grid)
  if (options.pixelShift !== false) {
    const px = randInt(1, 2);
    filters.push(`crop=iw-${px * 2}:ih-${px * 2}:${px}:${px}`);
    filters.push(`pad=iw+${px * 2}:ih+${px * 2}:${px}:${px}:black`);
  }

  // Color balance nudge
  if (options.colorOverlay !== false) {
    filters.push(
      `colorbalance=rs=${randFloat(-0.04, 0.04).toFixed(3)}` +
      `:gs=${randFloat(-0.04, 0.04).toFixed(3)}` +
      `:bs=${randFloat(-0.04, 0.04).toFixed(3)}`
    );
  }

  // Ensure even dimensions
  filters.push(`crop=trunc(iw/2)*2:trunc(ih/2)*2`);
  filters.push(`format=yuv420p`);

  return filters;
}

/**
 * Audio filters: change the audio fingerprint without sounding noticeably different.
 */
function buildAudioFilters(options = {}) {
  const filters = [];

  // Mirror the video's start trim so audio and video stay in sync.
  if (options.trimSegments && options.__videoTrimStart) {
    filters.push(`atrim=start=${options.__videoTrimStart}`);
    filters.push(`asetpts=PTS-STARTPTS`);
  }

  // Pitch shift via asetrate -> aresample
  if (options.audioPitch !== false) {
    const dir = Math.random() > 0.5 ? 1 : -1;
    const pct = randFloat(1.5, 3.5);
    const rate = Math.round(44100 * (1 + (dir * pct / 100)));
    filters.push(`asetrate=${rate}`);
    filters.push(`aresample=44100`);
  }

  // 3-band EQ
  if (options.audioEq !== false) {
    filters.push(`bass=g=${randFloat(-2.5, 2.5).toFixed(1)}:f=80`);
    filters.push(`equalizer=f=1000:t=h:w=500:g=${randFloat(-2, 2).toFixed(1)}`);
    filters.push(`treble=g=${randFloat(-2.5, 2.5).toFixed(1)}:f=5000`);
  }

  // Subtle echo
  if (options.audioReverb !== false) {
    filters.push(`aecho=0.8:0.8:${randInt(10, 35)}:${randFloat(0.04, 0.12).toFixed(3)}`);
  }

  // Volume
  if (options.volumeShift !== false) {
    filters.push(`volume=${randFloat(0.95, 1.05).toFixed(3)}`);
  }

  // Highpass / lowpass
  if (options.audioFilter !== false) {
    filters.push(`highpass=f=${randInt(15, 40)}`);
    filters.push(`lowpass=f=${randInt(16000, 19000)}`);
  }

  return filters;
}

/**
 * Encoding: fast preset, reasonable CRF, hard bitrate cap.
 */
function buildEncodingArgs(options = {}) {
  const args = [];

  args.push("-c:v", "libx264");
  args.push("-crf", String(randInt(23, 27)));
  args.push("-preset", pick(["fast", "medium"]));
  args.push("-profile:v", pick(["high", "main"]));

  // Hard cap: max 2 Mbps so files stay small
  args.push("-maxrate", "2M");
  args.push("-bufsize", "4M");

  // Randomize some x264 internals for uniqueness
  const x264Params = [
    `ref=${randInt(2, 5)}`,
    `bframes=${randInt(2, 4)}`,
    `keyint=${randInt(120, 300)}`,
    `scenecut=${randInt(30, 45)}`,
    `aq-mode=${randInt(1, 3)}`,
    `aq-strength=${randFloat(0.8, 1.3).toFixed(2)}`,
  ];
  args.push("-x264-params", x264Params.join(":"));

  // Limit threads so it doesn't freeze the PC
  const maxThreads = Math.max(2, Math.floor(os.cpus().length / 2));
  args.push("-threads", String(maxThreads));

  // Audio (skip when no-audio output requested)
  if (!options.removeAudio) {
    args.push("-c:a", "aac");
    args.push("-b:a", `${pick([96, 128, 160])}k`);
    args.push("-ar", "44100");
    args.push("-ac", "2");
  }

  return args;
}

/**
 * Subtle static logo overlay filter.
 */
function buildOverlayFilter(options = {}) {
  const logoSize = options.overlaySize || randInt(60, 100);
  // Very low opacity; barely visible but enough to change the hash.
  const opacity = options.overlayOpacity || randFloat(0.08, 0.15).toFixed(2);
  const margin = randInt(12, 28);

  // Pick a random fixed corner: 0=top-right, 1=bottom-left, 2=bottom-right, 3=top-left
  const corner = randInt(0, 3);
  const xExpr = (corner === 0 || corner === 2)
    ? `main_w-overlay_w-${margin}`
    : `${margin}`;
  const yExpr = (corner === 1 || corner === 2)
    ? `main_h-overlay_h-${margin}`
    : `${margin}`;

  const logoChain = `[1:v]scale=${logoSize}:-1,format=rgba,colorchannelmixer=aa=${opacity}[logo]`;
  const overlayChain =
    `[processed][logo]overlay=${xExpr}:${yExpr}:eof_action=repeat[out]`;

  return { logoChain, overlayChain };
}

function getPrimaryVideoStream(videoInfo) {
  const streams = Array.isArray(videoInfo?.streams) ? videoInfo.streams : [];
  return streams.find((stream) => stream.codec_type === "video") || null;
}

function parsePositiveNumber(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function buildRecipeFilterGraph({
  width,
  height,
  introSeconds,
  endHoldSeconds,
}) {
  const speedFactor = randFloat(0.985, 0.995).toFixed(4);
  const brightness = randFloat(0.004, 0.016).toFixed(3);
  const contrast = randFloat(1.01, 1.03).toFixed(3);
  const saturation = randFloat(1.015, 1.045).toFixed(3);
  const noiseStrength = randInt(1, 2);
  const watermarkOpacity = randFloat(0.2, 0.3).toFixed(2);
  const cornerSegment = randFloat(2.4, 3.4).toFixed(2);
  const margin = randInt(14, 24);
  const logoWidth = Math.max(180, Math.round(width * 0.24));
  const introLogoWidth = Math.max(260, Math.round(width * 0.42));
  const watermarkCycle = (Number(cornerSegment) * 4).toFixed(2);

  const xExpr =
    `'if(lt(mod(t\\,${watermarkCycle})\\,${cornerSegment})\\,main_w-overlay_w-${margin},` +
    `if(lt(mod(t\\,${watermarkCycle})\\,${(Number(cornerSegment) * 2).toFixed(2)})\\,${margin},` +
    `if(lt(mod(t\\,${watermarkCycle})\\,${(Number(cornerSegment) * 3).toFixed(2)})\\,main_w-overlay_w-${margin},` +
    `${margin})))'`;
  const yExpr =
    `'if(lt(mod(t\\,${watermarkCycle})\\,${cornerSegment})\\,${margin},` +
    `if(lt(mod(t\\,${watermarkCycle})\\,${(Number(cornerSegment) * 2).toFixed(2)})\\,main_h-overlay_h-${margin},` +
    `if(lt(mod(t\\,${watermarkCycle})\\,${(Number(cornerSegment) * 3).toFixed(2)})\\,main_h-overlay_h-${margin},` +
    `${margin})))'`;

  const filterGraph = [
    `[0:v]setpts=PTS/${speedFactor},` +
    `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation},` +
    `noise=alls=${noiseStrength}:allf=t,` +
    `tpad=stop_duration=${endHoldSeconds.toFixed(2)}:stop_mode=clone,` +
    `format=yuv420p[main]`,
    `[1:v]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${watermarkOpacity}[wm]`,
    `[main][wm]overlay=${xExpr}:${yExpr}:shortest=1[watermarked]`,
    `[1:v]scale=${introLogoWidth}:-1,format=rgba[intro_logo]`,
    `color=c=black:s=${width}x${height}:d=${introSeconds.toFixed(2)}[intro_bg]`,
    `[intro_bg][intro_logo]overlay=(W-w)/2:(H-h)/2:shortest=1[intro]`,
    `[intro][watermarked]concat=n=2:v=1:a=0[outv]`,
  ].join(";");

  return {
    filterGraph,
    modifications: [
      `logo-intro-${introSeconds.toFixed(2)}s`,
      `end-hold-${endHoldSeconds.toFixed(2)}s`,
      "visual-randomization-light",
      "watermark-corners-no-flicker",
      "audio-removed",
      "re-encode-h264-capped",
    ],
  };
}

/**
 * Main uniquification function.
 */
async function uniquifyVideo(inputPath, outputPath, options = {}) {
  const resolvedInput = path.resolve(inputPath);
  await fs.access(resolvedInput);

  const overlayImage = options.overlayImage || null;
  if (overlayImage) {
    await fs.access(path.resolve(overlayImage));
  }

  if (!outputPath) {
    const parsed = path.parse(resolvedInput);
    const hash = crypto.randomBytes(4).toString("hex");
    outputPath = path.join(parsed.dir, `${parsed.name}_unique_${hash}${parsed.ext}`);
  }
  const resolvedOutput = path.resolve(outputPath);
  const removeAudio = options.removeAudio === true;
  const useNewRecipe = options.mode === "logo-intro-watermark-noaudio";

  const modifications = [];
  const args = ["-y"];

  if (useNewRecipe) {
    if (!overlayImage) {
      throw new Error("Recipe mode requires overlayImage (logo file).");
    }

    const videoInfo = await getVideoInfo(resolvedInput);
    const primaryVideo = getPrimaryVideoStream(videoInfo);
    if (!primaryVideo) {
      throw new Error("Could not read primary video stream from input.");
    }

    const width = parsePositiveNumber(primaryVideo.width, 1080);
    const height = parsePositiveNumber(primaryVideo.height, 1920);
    const introSeconds = Math.min(
      parsePositiveNumber(options.introSeconds, 1),
      1
    );
    const endHoldSeconds = parsePositiveNumber(options.endHoldSeconds, 0.4);

    args.push("-i", resolvedInput);
    args.push("-loop", "1", "-i", path.resolve(overlayImage));

    const recipe = buildRecipeFilterGraph({
      width,
      height,
      introSeconds,
      endHoldSeconds,
    });
    args.push("-filter_complex", recipe.filterGraph);
    args.push("-map", "[outv]");

    const encArgs = buildEncodingArgs({
      ...options,
      removeAudio: true,
    });
    args.push(...encArgs);
    args.push("-an");

    const metaArgs = buildMetadataArgs();
    args.push(...metaArgs);
    args.push("-map_metadata", "-1");
    args.push("-fflags", "+bitexact");
    args.push("-movflags", "+faststart");
    args.push(resolvedOutput);

    modifications.push(...recipe.modifications);
  } else {
    args.push("-i", resolvedInput);

    // Add overlay as second input (single frame, no -loop needed)
    if (overlayImage) {
      args.push("-i", path.resolve(overlayImage));
    }

    const vFilters = buildVideoFilters(options);
    const aFilters = removeAudio ? [] : buildAudioFilters(options);

    if (overlayImage && vFilters.length > 0) {
      const { logoChain, overlayChain } = buildOverlayFilter(options);
      const videoChain = `[0:v]${vFilters.join(",")}[processed]`;
      const audioChain = aFilters.length > 0 ? `[0:a]${aFilters.join(",")}[aout]` : null;

      const filterParts = [videoChain, logoChain, overlayChain];
      if (audioChain) filterParts.push(audioChain);

      args.push("-filter_complex", filterParts.join(";"));
      args.push("-map", "[out]");
      if (!removeAudio) {
        args.push("-map", audioChain ? "[aout]" : "0:a");
      }
      modifications.push("flickering-logo-overlay");
    } else {
      if (vFilters.length > 0) args.push("-vf", vFilters.join(","));
      if (!removeAudio && aFilters.length > 0) args.push("-af", aFilters.join(","));
    }

    modifications.push(
      "color-shift",
      "hue-shift",
      "channel-mix",
      "noise",
      "pixel-shift",
      "color-balance"
    );
    if (options.cropPercent) modifications.push(`crop-${options.cropPercent}pct`);
    if (options.mirror) modifications.push("mirror");
    if (options.trimSegments) modifications.push("trim-start-0.30");
    if (options.noiseStrength) modifications.push(`noise-strength-${options.noiseStrength}`);
    if (!removeAudio) {
      modifications.push(
        "pitch-shift",
        "3-band-eq",
        "echo",
        "volume-shift",
        "freq-bounds"
      );
    } else {
      modifications.push("audio-removed");
    }

    const encArgs = buildEncodingArgs(options);
    args.push(...encArgs);
    modifications.push("re-encode");

    if (removeAudio) {
      args.push("-an");
    }

    const metaArgs = buildMetadataArgs();
    args.push(...metaArgs);
    args.push("-map_metadata", "-1");
    args.push("-fflags", "+bitexact");
    args.push("-movflags", "+faststart");
    modifications.push("metadata-randomize");

    args.push(resolvedOutput);
  }

  console.log(`Uniquifying video...`);
  console.log(`  Input:  ${resolvedInput}`);
  if (overlayImage) console.log(`  Overlay: ${path.resolve(overlayImage)}`);
  console.log(`  Output: ${resolvedOutput}`);

  await runFfmpeg(args);

  const stat = await fs.stat(resolvedOutput);
  // A very short clip can be emptied by the start trim; retry once without it.
  if (stat.size < 1024 && !useNewRecipe && options.trimSegments) {
    console.log("  Output looked empty after the start trim; retrying without the cut.");
    const safeOptions = { ...options, trimSegments: false };
    return uniquifyVideo(resolvedInput, resolvedOutput, safeOptions);
  }

  console.log(`  Output size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Done.`);

  return { outputPath: resolvedOutput, modifications };
}

async function uniquifyInPlace(inputPath, options = {}) {
  const resolvedInput = path.resolve(inputPath);
  const parsed = path.parse(resolvedInput);
  const tempPath = path.join(parsed.dir, `${parsed.name}_tmp_${crypto.randomBytes(4).toString("hex")}${parsed.ext}`);

  const result = await uniquifyVideo(resolvedInput, tempPath, options);

  await fs.unlink(resolvedInput);
  await fs.rename(tempPath, resolvedInput);

  console.log(`  Replaced original file.`);
  return { outputPath: resolvedInput, modifications: result.modifications };
}

async function uniquifyDirectory(dirPath, options = {}) {
  const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);
  const resolvedDir = path.resolve(dirPath);
  const entries = await fs.readdir(resolvedDir, { withFileTypes: true });

  const videos = entries
    .filter((e) => e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(resolvedDir, e.name));

  if (videos.length === 0) {
    console.log("No video files found in directory.");
    return [];
  }

  console.log(`Found ${videos.length} video(s) to uniquify.\n`);
  const results = [];

  for (const videoPath of videos) {
    try {
      const result = options.inPlace
        ? await uniquifyInPlace(videoPath, options)
        : await uniquifyVideo(videoPath, null, options);
      results.push({ videoPath, ...result, ok: true });
    } catch (error) {
      console.error(`  Failed: ${error.message}`);
      results.push({ videoPath, ok: false, error: error.message });
    }
    console.log("");
  }

  const succeeded = results.filter((r) => r.ok).length;
  console.log(`Uniquified ${succeeded}/${videos.length} video(s).`);
  return results;
}

/**
 * Intensity presets. Each preset bundles the transforms that actually defeat
 * perceptual (visual) fingerprinting that TikTok uses for duplicate detection.
 * Audio is never removed here; the user keeps the original soundtrack.
 */
const INTENSITY_PRESETS = {
  suave: {
    cropPercent: 2,
    mirror: false,
    trimSegments: true,
    noiseStrength: 3,
  },
  media: {
    cropPercent: 4,
    mirror: true,
    trimSegments: true,
    noiseStrength: 5,
  },
  fuerte: {
    cropPercent: 6,
    mirror: true,
    trimSegments: true,
    noiseStrength: 7,
  },
};

function normalizeIntensity(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "media" || key === "medium") return "media";
  if (key === "fuerte" || key === "strong" || key === "high") return "fuerte";
  return "suave";
}

/**
 * Merge an intensity preset with explicit per-video overrides. Explicit values
 * win, so the UI can start from a preset and tweak individual switches.
 */
function resolveUniquifyOptions({ intensity, ...overrides } = {}) {
  const preset = INTENSITY_PRESETS[normalizeIntensity(intensity)];
  const merged = { ...preset };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  // Timing changes are intentionally disabled: they desync the audio the user
  // wants to keep. The start trim always stays on (fixed at 0.30s).
  delete merged.speedFactor;
  delete merged.extendDuration;
  merged.trimSegments = true;
  merged.freezeFrames = false;
  return merged;
}

module.exports = {
  uniquifyVideo,
  uniquifyInPlace,
  uniquifyDirectory,
  checkFfmpeg,
  getVideoInfo,
  INTENSITY_PRESETS,
  normalizeIntensity,
  resolveUniquifyOptions,
};
