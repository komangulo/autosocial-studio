const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID, createHash } = require("crypto");
const { StudioValidationError } = require("./validation");

const MEDIA_OPERATIONS = new Set(["proxy", "speech", "procedural-audio", "scopes", "local-relight", "flow-video"]);
const MAX_SPEECH_CHARS = 10000;
const MAX_PROMPT_CHARS = 2000;

function finite(value, fallback, min, max, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new StudioValidationError(`${label} must be between ${min} and ${max}.`);
  return number;
}
function integer(value, fallback, min, max, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new StudioValidationError(`${label} must be an integer between ${min} and ${max}.`);
  return number;
}
function safeText(value, label, max) {
  const text = String(value || "").trim();
  if (!text || text.length > max || text.includes("\0")) throw new StudioValidationError(`${label} must contain between 1 and ${max} characters.`);
  return text;
}
function commandWorks(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 3000);
    timer.unref?.();
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
async function findSpeechEngine() {
  if (process.platform === "win32") {
    const commands = ["powershell.exe", "powershell"];
    for (const command of commands) {
      if (await commandWorks(command, ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech"])) return { id: "windows-system-speech", command };
    }
    return null;
  }
  for (const command of ["espeak-ng", "espeak"]) if (await commandWorks(command, ["--version"])) return { id: command, command };
  return null;
}
function seededRandom(seed) {
  let state = createHash("sha256").update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
async function writeProceduralWav(filePath, options = {}) {
  const sampleRate = 44100;
  const durationSeconds = finite(options.durationSeconds, 5, 0.1, 120, "Procedural audio duration");
  const mode = String(options.mode || "music");
  if (!new Set(["music", "sfx"]).has(mode)) throw new StudioValidationError("Procedural audio mode must be music or sfx.");
  const samples = Math.floor(durationSeconds * sampleRate);
  const dataSize = samples * 2;
  const output = Buffer.allocUnsafe(44 + dataSize);
  output.write("RIFF", 0); output.writeUInt32LE(36 + dataSize, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write("data", 36); output.writeUInt32LE(dataSize, 40);
  const random = seededRandom(options.seed || "studio");
  const root = 110 + Math.floor(random() * 110);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    let sample;
    if (mode === "music") {
      const step = Math.floor(time * 2) % 8;
      const ratios = [1, 1.25, 1.5, 2, 1.5, 1.25, 1.125, 1.5];
      const frequency = root * ratios[step];
      const envelope = Math.min(1, (time * 2) % 1 * 8) * 0.22;
      sample = (Math.sin(2 * Math.PI * frequency * time) + 0.35 * Math.sin(2 * Math.PI * frequency * 2 * time)) * envelope;
    } else {
      const envelope = Math.exp(-4 * time / durationSeconds);
      sample = ((random() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * (root * 3) * time) * 0.5) * envelope * 0.6;
    }
    output.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + index * 2);
  }
  await fs.writeFile(filePath, output, { mode: 0o600, flag: "wx" });
  return { sampleRate, durationSeconds, samples };
}

class MediaService {
  constructor({ database, projectService, documentService, assetService, jobService, googleFlow, pollMs = 250 }) {
    Object.assign(this, { db: database.db, projectService, documentService, assetService, jobService, googleFlow });
    this.workerId = `media-${randomUUID()}`;
    this.pollMs = Math.max(25, Number(pollMs) || 250);
    this.closed = false;
    this.timer = null;
    this.running = false;
    this.children = new Map();
    this.jobService.recoverExpired(new Date(), { type: "media" });
    this.schedule(0);
  }

  validate(accountId, projectId, input = {}) {
    this.projectService.get(accountId, projectId);
    const operation = String(input.operation || "");
    if (!MEDIA_OPERATIONS.has(operation)) throw new StudioValidationError("Unsupported media operation.");
    const value = { operation };
    if (["proxy", "scopes", "local-relight"].includes(operation)) {
      const source = this.assetService.get(accountId, projectId, String(input.sourceAssetId || input.assetId || ""));
      value.sourceAssetId = source.id;
      if (operation === "proxy") {
        value.width = integer(input.width, 1280, 160, 1920, "Proxy width");
        value.height = integer(input.height, 720, 90, 1920, "Proxy height");
      } else if (operation === "scopes") {
        value.scope = String(input.scope || "waveform");
        if (!new Set(["waveform", "vectorscope"]).has(value.scope)) throw new StudioValidationError("Scope must be waveform or vectorscope.");
        if (source.kind !== "video") throw new StudioValidationError("Scopes require a video asset.");
      } else {
        if (!new Set(["video", "image"]).has(source.kind)) throw new StudioValidationError("Local FFmpeg grading requires a visual asset.");
        value.brightness = input.brightness !== undefined ? finite(input.brightness, 0, -1, 1, "Brightness") : finite(input.exposure, 0, -100, 100, "Exposure") / 100;
        value.contrast = finite(input.contrast, 1, 0, 2, "Contrast");
        value.saturation = finite(input.saturation, 1, 0, 3, "Saturation");
        value.temperature = finite(input.temperature, 0, -100, 100, "Temperature");
        value.tint = finite(input.tint, 0, -100, 100, "Tint");
        value.vignette = finite(input.vignette, 0, -100, 100, "Vignette");
      }
    } else if (operation === "speech") {
      value.text = safeText(input.text, "Speech text", MAX_SPEECH_CHARS);
      value.rate = integer(input.rate, 0, -10, 10, "Speech rate");
      if (input.voice !== undefined) value.voice = safeText(input.voice, "Speech voice", 100);
    } else if (operation === "procedural-audio") {
      value.mode = String(input.mode || input.audioKind || "music");
      if (!new Set(["music", "sfx"]).has(value.mode)) throw new StudioValidationError("Procedural audio mode must be music or sfx.");
      value.durationSeconds = input.durationSeconds !== undefined
        ? finite(input.durationSeconds, 5, 0.1, 120, "Procedural audio duration")
        : finite(input.durationMs, 5000, 100, 120000, "Procedural audio duration") / 1000;
      value.seed = String(input.seed || "studio").slice(0, 200);
    } else if (operation === "flow-video") {
      let prompts = Array.isArray(input.prompts) ? input.prompts : null;
      if (prompts && (prompts.length < 1 || prompts.length > 3)) throw new StudioValidationError("Flow video requires between one and three storyboard prompts.");
      if (!prompts && (!Array.isArray(input.shotIds) || input.shotIds.length < 1 || input.shotIds.length > 3)) throw new StudioValidationError("Flow video requires between one and three storyboard shots.");
      const project = this.projectService.get(accountId, projectId);
      if (project.aspectRatio !== "9:16") throw new StudioValidationError("Flow video supports only 9:16 projects.");
      if (!prompts && Array.isArray(input.shotIds)) {
        const board = this.documentService.list(accountId, projectId, "storyboard").find((item) => item.status === "approved");
        if (!board) throw new StudioValidationError("An approved storyboard is required for Flow generation.", 409);
        const ids = input.shotIds.map(String);
        if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length) throw new StudioValidationError("Flow video requires between one and three unique storyboard shots.");
        const shots = ids.map((shotId) => board.content.shots.find((shot) => shot.id === shotId));
        if (shots.some((shot) => !shot)) throw new StudioValidationError("Flow shot was not found in the approved storyboard.", 404);
        prompts = shots.map((shot) => shot.prompt || shot.action || shot.title);
        value.shotIds = ids;
        value.storyboardVersion = board.version;
      }
      if (!Array.isArray(prompts) || prompts.length < 1 || prompts.length > 3) throw new StudioValidationError("Flow video requires between one and three storyboard prompts.");
      value.prompts = prompts.map((prompt) => safeText(prompt, "Flow storyboard prompt", MAX_PROMPT_CHARS));
      value.aspectRatio = "9:16";
      if (input.referenceAssetId) {
        const reference = this.assetService.get(accountId, projectId, String(input.referenceAssetId));
        if (reference.kind !== "image") throw new StudioValidationError("Flow reference asset must be an image.");
        value.referenceAssetId = reference.id;
      }
    }
    return value;
  }

  enqueue(accountId, projectId, input = {}) {
    const payload = this.validate(accountId, projectId, input);
    const maxAttempts = input.maxAttempts === undefined ? 2 : input.maxAttempts;
    return this.jobService.enqueue(accountId, projectId, { type: "media", input: payload, maxAttempts, dedupeKey: input.idempotencyKey });
  }

  schedule(delay = this.pollMs) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick().catch(() => {}).finally(() => this.schedule()); }, delay);
    this.timer.unref?.();
  }

  async tick() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const job = this.jobService.claim(this.workerId, { type: "media", leaseMs: 30000 });
      if (job) await this.process(job);
    } finally { this.running = false; }
  }

  isCancelled(jobId) {
    return this.db.prepare("SELECT status FROM studio_jobs WHERE id=?").get(jobId)?.status === "cancelled";
  }

  async run(job, command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
      this.children.set(job.id, child);
      let stderr = "", settled = false;
      const heartbeat = setInterval(() => {
        if (this.closed || this.isCancelled(job.id)) child.kill("SIGTERM");
        else {
          try { this.jobService.heartbeat(job.id, this.workerId, { current: 0, total: 1, leaseMs: 30000 }); } catch { child.kill("SIGTERM"); }
        }
      }, 5000);
      heartbeat.unref?.();
      child.stderr.on("data", (chunk) => { if (stderr.length < 16000) stderr += chunk; });
      child.once("error", (error) => { if (!settled) { settled = true; clearInterval(heartbeat); this.children.delete(job.id); reject(error); } });
      child.once("close", (code) => {
        if (settled) return;
        settled = true; clearInterval(heartbeat); this.children.delete(job.id);
        if (this.isCancelled(job.id)) reject(Object.assign(new Error("Media job was cancelled."), { code: "cancelled" }));
        else if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-1000)}`));
      });
    });
  }

  async process(job) {
    const root = await this.projectService.ensureProjectFolders(job.accountId, job.projectId);
    const tempFiles = new Set();
    try {
      const result = await this.execute(job, root, tempFiles);
      if (!this.isCancelled(job.id)) this.jobService.complete(job.id, this.workerId, result);
    } catch (error) {
      if (!this.isCancelled(job.id)) {
        try { this.jobService.fail(job.id, this.workerId, { code: error.code || "media_failed", message: String(error.message || error).slice(0, 2000), partialAssetIds: error.partialAssetIds || [] }); } catch {}
      }
    } finally {
      await Promise.all([...tempFiles].map((file) => fs.rm(file, { recursive: true, force: true }).catch(() => {})));
    }
  }

  async execute(job, root, tempFiles) {
    const input = job.input;
    if (input.operation === "procedural-audio") {
      const output = path.join(root, "tmp", `${job.id}.wav`); tempFiles.add(output);
      await writeProceduralWav(output, input);
      if (this.isCancelled(job.id)) throw Object.assign(new Error("Media job was cancelled."), { code: "cancelled" });
      const asset = await this.assetService.importInternalFile(job.accountId, job.projectId, { filePath: output, mimeType: "audio/wav", originalName: `${input.mode}-${job.id}.wav`, storageArea: "originals" });
      return { operation: input.operation, assetIds: [asset.id] };
    }
    if (input.operation === "speech") return this.speech(job, root, tempFiles);
    if (input.operation === "flow-video") return this.flow(job, root, tempFiles);
    const source = this.assetService.contentPath(job.accountId, job.projectId, input.sourceAssetId);
    if (input.operation === "proxy") return this.proxy(job, source, root, tempFiles);
    if (input.operation === "scopes") return this.scopes(job, source, root, tempFiles);
    return this.localGrade(job, source, root, tempFiles);
  }

  async proxy(job, source, root, tempFiles) {
    const settings = { width: job.input.width, height: job.input.height };
    const cached = this.assetService.derivative(job.accountId, job.projectId, source.asset.id, "proxy", settings).asset;
    if (cached) return { operation: "proxy", assetIds: [cached.id], cached: true };
    let mimeType, extension, args;
    if (source.asset.kind === "video") {
      mimeType = "video/mp4"; extension = ".mp4";
      args = ["-y", "-i", source.filePath, "-vf", `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac"];
    } else if (source.asset.kind === "image") {
      mimeType = "image/jpeg"; extension = ".jpg";
      args = ["-y", "-i", source.filePath, "-vf", `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease`, "-frames:v", "1"];
    } else {
      mimeType = "audio/mpeg"; extension = ".mp3";
      args = ["-y", "-i", source.filePath, "-vn", "-c:a", "libmp3lame", "-b:a", "128k"];
    }
    const output = path.join(root, "tmp", `${job.id}-proxy${extension}`); tempFiles.add(output); args.push(output);
    await this.run(job, "ffmpeg", args);
    const asset = await this.assetService.registerDerivative(job.accountId, job.projectId, { sourceAssetId: source.asset.id, kind: "proxy", settings, filePath: output, mimeType, originalName: `${source.asset.originalName}-proxy${extension}` });
    return { operation: "proxy", assetIds: [asset.id] };
  }

  async scopes(job, source, root, tempFiles) {
    const kind = `analysis-${job.input.scope}`, settings = { scope: job.input.scope, width: 1280, height: 720 };
    const cached = this.assetService.derivative(job.accountId, job.projectId, source.asset.id, kind, settings).asset;
    if (cached) return { operation: "scopes", assetIds: [cached.id], cached: true };
    const output = path.join(root, "tmp", `${job.id}-${job.input.scope}.png`); tempFiles.add(output);
    const filter = job.input.scope === "waveform" ? "waveform=mode=column:display=overlay,scale=1280:720" : "vectorscope=mode=color2:graticule=green,scale=1280:720";
    await this.run(job, "ffmpeg", ["-y", "-i", source.filePath, "-vf", filter, "-frames:v", "1", output]);
    const asset = await this.assetService.registerDerivative(job.accountId, job.projectId, { sourceAssetId: source.asset.id, kind, settings, filePath: output, mimeType: "image/png", originalName: `${job.input.scope}.png` });
    return { operation: "scopes", scope: job.input.scope, assetIds: [asset.id] };
  }

  async localGrade(job, source, root, tempFiles) {
    const settings = { brightness: job.input.brightness, contrast: job.input.contrast, saturation: job.input.saturation, temperature: job.input.temperature, tint: job.input.tint, vignette: job.input.vignette };
    const kind = "local-ffmpeg-grade";
    const cached = this.assetService.derivative(job.accountId, job.projectId, source.asset.id, kind, settings).asset;
    if (cached) return { operation: "local-relight", method: "local-ffmpeg-grade", assetIds: [cached.id], cached: true };
    const image = source.asset.kind === "image", extension = image ? ".jpg" : ".mp4", mimeType = image ? "image/jpeg" : "video/mp4";
    const output = path.join(root, "tmp", `${job.id}-local-grade${extension}`); tempFiles.add(output);
    const temperature = settings.temperature / 500, tint = settings.tint / 500;
    const filters = [`eq=brightness=${settings.brightness}:contrast=${settings.contrast}:saturation=${settings.saturation}`];
    if (temperature || tint) filters.push(`colorbalance=rs=${temperature}:gs=${tint}:bs=${-temperature}:rh=${temperature}:gh=${tint}:bh=${-temperature}:pl=1`);
    if (settings.vignette) filters.push(`vignette=angle=${Math.abs(settings.vignette) / 100 * Math.PI / 5}:mode=${settings.vignette < 0 ? "backward" : "forward"}`);
    const args = ["-y", "-i", source.filePath, "-vf", filters.join(",")];
    if (image) args.push("-frames:v", "1"); else args.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy");
    args.push(output); await this.run(job, "ffmpeg", args);
    const asset = await this.assetService.registerDerivative(job.accountId, job.projectId, { sourceAssetId: source.asset.id, kind, settings, filePath: output, mimeType, originalName: `${source.asset.originalName}-local-grade${extension}` });
    return { operation: "local-relight", method: "local-ffmpeg-grade", assetIds: [asset.id] };
  }

  async speech(job, root, tempFiles) {
    const engine = await findSpeechEngine();
    if (!engine) throw new StudioValidationError("No local speech engine is available. Install espeak-ng or use Windows System.Speech.", 409);
    const textFile = path.join(root, "tmp", `${job.id}-speech.txt`), output = path.join(root, "tmp", `${job.id}-speech.wav`);
    tempFiles.add(textFile); tempFiles.add(output); await fs.writeFile(textFile, job.input.text, { mode: 0o600, flag: "wx" });
    if (engine.id === "windows-system-speech") {
      const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
        "$s.Rate=[int]$args[2];if($args[3]){$s.SelectVoice($args[3])};$s.SetOutputToWaveFile($args[1]);$s.Speak([IO.File]::ReadAllText($args[0]));$s.Dispose()";
      await this.run(job, engine.command, ["-NoProfile", "-NonInteractive", "-Command", script, textFile, output, String(job.input.rate), job.input.voice || ""]);
    } else {
      const args = ["-f", textFile, "-w", output, "-s", String(175 + job.input.rate * 10)];
      if (job.input.voice) args.push("-v", job.input.voice);
      await this.run(job, engine.command, args);
    }
    const asset = await this.assetService.importInternalFile(job.accountId, job.projectId, { filePath: output, mimeType: "audio/wav", originalName: `speech-${job.id}.wav`, storageArea: "originals" });
    return { operation: "speech", engine: engine.id, assetIds: [asset.id] };
  }

  async flow(job, root, tempFiles) {
    const generate = typeof this.googleFlow === "function" ? this.googleFlow : this.googleFlow?.generateVideos;
    if (typeof generate !== "function") throw new StudioValidationError("Google Flow adapter is unavailable.", 409);
    const outputDir = path.join(root, "tmp", `${job.id}-flow`); await fs.mkdir(outputDir, { mode: 0o700 }); tempFiles.add(outputDir);
    const imported = new Map();
    const importFiles = async (files) => {
      for (const file of files || []) {
        if (imported.has(file)) continue;
        const asset = await this.assetService.importInternalFile(job.accountId, job.projectId, { filePath: file, mimeType: "video/mp4", originalName: path.basename(file), storageArea: "originals" });
        imported.set(file, asset.id);
      }
    };
    const referenceImage = job.input.referenceAssetId ? this.assetService.contentPath(job.accountId, job.projectId, job.input.referenceAssetId).filePath : undefined;
    try {
      const files = await generate({ accountId: job.accountId, prompts: job.input.prompts, referenceImage, outputDir, shouldCancel: () => this.closed || this.isCancelled(job.id), onProgress: async (progress) => {
        if (this.closed || this.isCancelled(job.id)) throw Object.assign(new Error("Media job was cancelled."), { code: "cancelled" });
        await importFiles(progress.downloadedFiles);
        if (!this.isCancelled(job.id)) this.jobService.heartbeat(job.id, this.workerId, { current: Math.max(0, Number(progress.current) || 0), total: job.input.prompts.length, leaseMs: 30000 });
      } });
      await importFiles(files);
      return { operation: "flow-video", aspectRatio: "9:16", assetIds: [...imported.values()] };
    } catch (error) {
      await importFiles(error.completedFiles).catch(() => {});
      error.partialAssetIds = [...imported.values()];
      throw error;
    }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}

module.exports = { MediaService, MEDIA_OPERATIONS, MAX_SPEECH_CHARS, MAX_PROMPT_CHARS, findSpeechEngine, writeProceduralWav };
