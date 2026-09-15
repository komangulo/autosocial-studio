const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { ensureDirectories } = require("./fs-utils");
const { uniquifyVideo, checkFfmpeg, resolveUniquifyOptions } = require("./video-uniquifier");

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

function nowIso() {
  return new Date().toISOString();
}

class UniquifierController {
  constructor() {
    this.inputDir = config.uniquifyInputDir;
    this.outputDir = config.uniquifyOutputDir;
    this.logoImage = config.uniquifyLogoImage || "";
    this.intensity = "suave";
    this.uniquifyOptions = {};
    this.running = false;
    this.stopRequested = false;
    this.startedAt = null;
    this.finishedAt = null;
    this.currentFile = null;
    this.processed = 0;
    this.total = 0;
    this.succeeded = 0;
    this.failed = 0;
    this.logs = [];
  }

  log(message, level = "info") {
    this.logs.unshift({
      at: nowIso(),
      level,
      message,
    });
    this.logs = this.logs.slice(0, 200);
    const prefix = `[${this.logs[0].at}] [uniquifier]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  resolveFolder(folderPath, fallbackPath) {
    if (!folderPath || typeof folderPath !== "string") {
      return fallbackPath;
    }
    const trimmed = folderPath.trim();
    if (!trimmed) return fallbackPath;
    return path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.resolve(config.projectRoot, trimmed);
  }

  resolveOptionalFile(filePath, fallbackPath) {
    if (filePath === undefined) {
      return fallbackPath;
    }
    if (filePath === null) {
      return "";
    }
    const trimmed = String(filePath).trim();
    if (!trimmed) {
      return "";
    }
    return path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.resolve(config.projectRoot, trimmed);
  }

  async setFolders({ inputDir, outputDir, logoImage, intensity, options } = {}) {
    this.inputDir = this.resolveFolder(inputDir, this.inputDir);
    this.outputDir = this.resolveFolder(outputDir, this.outputDir);
    this.logoImage = this.resolveOptionalFile(logoImage, this.logoImage);
    if (intensity !== undefined) {
      this.intensity = intensity;
    }
    if (options && typeof options === "object") {
      this.uniquifyOptions = { ...this.uniquifyOptions, ...options };
    }
    await ensureDirectories([this.inputDir, this.outputDir]);

    if (this.logoImage) {
      await fs.access(this.logoImage);
    }

    return {
      ok: true,
      inputDir: this.inputDir,
      outputDir: this.outputDir,
      logoImage: this.logoImage,
      intensity: this.intensity,
      options: this.uniquifyOptions,
    };
  }

  /** Full option set handed to the video engine for one file. */
  buildEngineOptions() {
    return resolveUniquifyOptions({
      ...this.uniquifyOptions,
      intensity: this.intensity,
      overlayImage: this.logoImage || null,
      removeAudio: false,
    });
  }

  async listVideoFiles(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  buildOutputPath(inputFileName, index) {
    return path.join(this.outputDir, inputFileName);
  }

  getSidecarPaths(filePath) {
    const parsed = path.parse(filePath);
    return [
      path.join(parsed.dir, `${parsed.name}.description`),
      path.join(parsed.dir, `${parsed.name}.txt`),
    ];
  }

  async copySidecarsToOutput(inputPath, outputPath) {
    const outputParsed = path.parse(outputPath);
    const copied = [];

    for (const sourcePath of this.getSidecarPaths(inputPath)) {
      try {
        await fs.access(sourcePath);
      } catch {
        continue;
      }

      const sidecarExt = path.extname(sourcePath);
      const destinationPath = path.join(
        outputParsed.dir,
        `${outputParsed.name}${sidecarExt}`
      );

      await fs.copyFile(sourcePath, destinationPath);
      copied.push(path.basename(destinationPath));
    }

    return copied;
  }

  async start({ inputDir, outputDir, logoImage, intensity, options } = {}) {
    if (this.running) {
      return { ok: true, alreadyRunning: true };
    }

    await this.setFolders({ inputDir, outputDir, logoImage, intensity, options });

    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      throw new Error("ffmpeg is not installed or not in PATH.");
    }

    const files = await this.listVideoFiles(this.inputDir);
    this.running = true;
    this.stopRequested = false;
    this.startedAt = nowIso();
    this.finishedAt = null;
    this.currentFile = null;
    this.processed = 0;
    this.total = files.length;
    this.succeeded = 0;
    this.failed = 0;

    this.log(
      `Batch started. Input: ${this.inputDir}, Output: ${this.outputDir}, Files: ${files.length}`
    );
    this.log(
      this.logoImage
        ? `Logo overlay: ${this.logoImage}`
        : "Logo overlay disabled."
    );

    this.runBatch(files).catch((error) => {
      this.log(`Unexpected batch error: ${error.message}`, "error");
      this.running = false;
      this.currentFile = null;
      this.finishedAt = nowIso();
    });

    return {
      ok: true,
      alreadyRunning: false,
      total: files.length,
    };
  }

  async runBatch(files) {
    if (files.length === 0) {
      this.log("No video files found in input folder.");
      this.running = false;
      this.finishedAt = nowIso();
      return;
    }

    for (let i = 0; i < files.length; i += 1) {
      if (this.stopRequested) {
        this.log("Stop requested. Batch halted.");
        break;
      }

      const fileName = files[i];
      const inputPath = path.join(this.inputDir, fileName);
      const outputPath = this.buildOutputPath(fileName, i);
      this.currentFile = fileName;
      this.log(`Processing ${i + 1}/${files.length}: ${fileName}`);

      try {
        await uniquifyVideo(inputPath, outputPath, this.buildEngineOptions());

        const copiedSidecars = await this.copySidecarsToOutput(inputPath, outputPath);
        if (copiedSidecars.length > 0) {
          this.log(`Copied sidecar files: ${copiedSidecars.join(", ")}`);
        }

        this.succeeded += 1;
        this.log(`Done: ${path.basename(outputPath)}`);
      } catch (error) {
        this.failed += 1;
        this.log(`Failed: ${fileName} - ${error.message}`, "error");
      } finally {
        this.processed += 1;
      }
    }

    this.running = false;
    this.currentFile = null;
    this.finishedAt = nowIso();
    this.log(
      `Batch finished. Success: ${this.succeeded}, Failed: ${this.failed}, Processed: ${this.processed}/${this.total}`
    );
  }

  stop() {
    if (!this.running) {
      return { ok: true, alreadyStopped: true };
    }
    this.stopRequested = true;
    this.log("Stop requested by dashboard.");
    return { ok: true, alreadyStopped: false };
  }

  async getStatus() {
    await ensureDirectories([this.inputDir, this.outputDir]);
    const [inputEntries, outputEntries] = await Promise.all([
      fs.readdir(this.inputDir, { withFileTypes: true }),
      fs.readdir(this.outputDir, { withFileTypes: true }),
    ]);

    const inputFiles = inputEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const outputFiles = outputEntries
      .filter(
        (entry) =>
          entry.isFile() &&
          VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      )
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));

    return {
      running: this.running,
      stopRequested: this.stopRequested,
      inputDir: this.inputDir,
      outputDir: this.outputDir,
      logoImage: this.logoImage,
      intensity: this.intensity,
      options: this.uniquifyOptions,
      currentFile: this.currentFile,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      progress: {
        processed: this.processed,
        total: this.total,
        succeeded: this.succeeded,
        failed: this.failed,
      },
      counts: {
        input: inputFiles.length,
        output: outputFiles.length,
      },
      inputFiles: inputFiles.slice(0, 100),
      outputFiles: outputFiles.slice(0, 100),
      logs: this.logs,
    };
  }
}

module.exports = {
  UniquifierController,
};
