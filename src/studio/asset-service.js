const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { randomUUID, createHash } = require("crypto");
const { spawn } = require("child_process");
const { StudioValidationError } = require("./validation");

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/gif", ".gif"],
  ["video/mp4", ".mp4"], ["video/webm", ".webm"], ["video/quicktime", ".mov"],
  ["audio/mpeg", ".mp3"], ["audio/wav", ".wav"], ["audio/x-wav", ".wav"], ["audio/mp4", ".m4a"], ["audio/ogg", ".ogg"],
  ["application/x-cube", ".cube"],
]);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_INTERNAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const STORAGE_AREAS = new Set(["originals", "renders", "proxies"]);
const DERIVATIVE_KINDS = new Set(["proxy", "analysis-waveform", "analysis-vectorscope", "local-ffmpeg-grade"]);

function sanitizeName(value) {
  const base = path.basename(String(value || "asset")).normalize("NFKC")
    .replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 180);
  return base || "asset";
}
function parse(value) { return value == null ? null : JSON.parse(value); }
function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, accountId: row.account_id, kind: row.kind,
    mimeType: row.mime_type, originalName: row.original_name, sizeBytes: row.size_bytes,
    sha256: row.sha256, status: row.status, storageArea: row.storage_area || "originals",
    metadata: parse(row.metadata_json), createdAt: row.created_at, deletedAt: row.deleted_at,
  };
}
function runProbe(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration,size,format_name:stream=codec_type,codec_name,width,height,sample_rate,avg_frame_rate,r_frame_rate", "-of", "json", filePath], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => { if (out.length < 1024 * 1024) out += chunk; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function validateCube(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 4 * 1024 * 1024 || buffer.includes(0)) throw new StudioValidationError("CUBE LUT must be UTF-8 text smaller than 4 MiB.");
  const lines = buffer.toString("utf8").split(/\r?\n/);
  let size = 0, dimensions = 0, rows = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^TITLE\s+/i.test(line) || /^DOMAIN_(?:MIN|MAX)\s+/i.test(line)) continue;
    let match = /^LUT_([13])D_SIZE\s+(\d+)$/i.exec(line);
    if (match) {
      if (size) throw new StudioValidationError("CUBE LUT must declare exactly one grid size.");
      dimensions = Number(match[1]); size = Number(match[2]);
      if (size < 2 || (dimensions === 3 ? size > 64 : size > 65536)) throw new StudioValidationError("CUBE LUT grid size is unsupported.");
      continue;
    }
    const values = line.split(/\s+/).map(Number);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < -100 || value > 100)) throw new StudioValidationError("CUBE LUT contains invalid sample data.");
    rows += 1;
  }
  const expected = dimensions === 3 ? size ** 3 : size;
  if (!size || rows !== expected) throw new StudioValidationError("CUBE LUT sample count does not match its declared grid.");
  return { dimensions, size, rows };
}

class AssetService {
  constructor({ database, projectService, rootPath }) {
    this.db = database.db;
    this.projectService = projectService;
    this.rootPath = path.resolve(rootPath);
  }

  list(accountId, projectId, options = {}) {
    this.projectService.get(accountId, projectId);
    return this.db.prepare(`SELECT * FROM studio_assets WHERE account_id=? AND project_id=? ${options.includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY created_at DESC`)
      .all(accountId, projectId).map(mapAsset);
  }

  row(accountId, projectId, assetId, includeDeleted = false) {
    this.projectService.get(accountId, projectId);
    const row = this.db.prepare(`SELECT * FROM studio_assets WHERE id=? AND account_id=? AND project_id=? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(assetId, accountId, projectId);
    if (!row) throw new StudioValidationError("Asset not found.", 404);
    return row;
  }

  get(accountId, projectId, assetId, options) { return mapAsset(this.row(accountId, projectId, assetId, options?.includeDeleted)); }

  contentPath(accountId, projectId, assetId) {
    const row = this.row(accountId, projectId, assetId);
    const root = path.resolve(this.projectService.projectPath(accountId, projectId));
    const area = row.storage_area || "originals";
    if (!STORAGE_AREAS.has(area)) throw new StudioValidationError("Unsafe asset storage area.", 500);
    const areaRoot = path.resolve(root, area);
    const filePath = path.resolve(areaRoot, row.storage_name);
    if (!contained(areaRoot, filePath)) throw new StudioValidationError("Unsafe asset path.", 500);
    try {
      const areaStat = fs.lstatSync(areaRoot), fileStat = fs.lstatSync(filePath);
      if (areaStat.isSymbolicLink() || !areaStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("unsafe");
      const realArea = fs.realpathSync(areaRoot), realFile = fs.realpathSync(filePath);
      if (!contained(realArea, realFile)) throw new Error("unsafe");
    } catch {
      throw new StudioValidationError("Asset content path is missing or unsafe.", 500);
    }
    return { asset: mapAsset(row), filePath };
  }

  async insertAsset(accountId, projectId, { id, storageName, storageArea, mimeType, originalName, size, sha256, filePath, source }) {
    const metadata = await runProbe(filePath);
    const now = new Date().toISOString();
    const kind = mimeType === "application/x-cube" ? "lut" : mimeType.split("/")[0];
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO studio_assets(id,project_id,account_id,kind,mime_type,original_name,storage_name,size_bytes,sha256,status,metadata_json,storage_area,created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?,?)")
        .run(id, projectId, accountId, kind, mimeType, sanitizeName(originalName || storageName), storageName, size, sha256, metadata ? JSON.stringify(metadata) : null, storageArea, now);
      this.projectService.recordEvent(accountId, projectId, "asset.created", { assetId: id, kind, source }, now);
    })();
    return this.get(accountId, projectId, id);
  }

  async importBuffer(accountId, projectId, { buffer, mimeType, originalName }) {
    this.projectService.get(accountId, projectId);
    let type = String(mimeType || "").toLowerCase().split(";")[0].trim();
    if (/\.cube$/i.test(String(originalName || "")) && ["", "text/plain", "application/octet-stream", "application/x-cube"].includes(type)) type = "application/x-cube";
    const extension = MIME_EXTENSIONS.get(type);
    if (!extension) throw new StudioValidationError("Unsupported asset MIME type. Only image, video, audio, and validated CUBE LUT files are accepted.", 415);
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new StudioValidationError("Asset body is required.");
    if (buffer.length > MAX_ASSET_BYTES) throw new StudioValidationError("Asset exceeds 100 MB.", 413);
    if (type === "application/x-cube") validateCube(buffer);
    const id = randomUUID(), storageName = `${id}${extension}`;
    const root = await this.projectService.ensureProjectFolders(accountId, projectId);
    const target = path.join(root, "originals", storageName), temp = path.join(root, "tmp", `${id}.partial`);
    await fsp.writeFile(temp, buffer, { mode: 0o600, flag: "wx" });
    await fsp.rename(temp, target);
    try {
      return await this.insertAsset(accountId, projectId, { id, storageName, storageArea: "originals", mimeType: type, originalName, size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), filePath: target, source: "upload" });
    } catch (error) {
      await fsp.rm(target, { force: true });
      throw error;
    }
  }

  async importInternalFile(accountId, projectId, { filePath, mimeType, originalName, storageArea = "proxies" }) {
    this.projectService.get(accountId, projectId);
    const type = String(mimeType || "").toLowerCase().split(";")[0].trim();
    const extension = MIME_EXTENSIONS.get(type);
    if (!extension) throw new StudioValidationError("Unsupported internal asset MIME type.");
    if (!STORAGE_AREAS.has(storageArea)) throw new StudioValidationError("Unsupported internal asset storage area.");
    const projectRoot = await this.projectService.ensureProjectFolders(accountId, projectId);
    const realRoot = await fsp.realpath(projectRoot);
    const requested = path.resolve(String(filePath || ""));
    const sourceStat = await fsp.lstat(requested).catch(() => null);
    if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size <= 0) throw new StudioValidationError("Internal asset source must be a non-empty regular file.");
    if (sourceStat.size > MAX_INTERNAL_ASSET_BYTES) throw new StudioValidationError("Internal asset exceeds 2 GB.", 413);
    if (type === "application/x-cube") validateCube(await fsp.readFile(requested));
    const realSource = await fsp.realpath(requested);
    if (!contained(realRoot, realSource)) throw new StudioValidationError("Internal asset source is outside the project directory.");
    const sourceHandle = await fsp.open(requested, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)).catch(() => null);
    if (!sourceHandle) throw new StudioValidationError("Internal asset source could not be opened safely.");
    const openedStat = await sourceHandle.stat();
    if (!openedStat.isFile() || openedStat.size !== sourceStat.size) { await sourceHandle.close(); throw new StudioValidationError("Internal asset changed while it was opened.", 409); }
    const areaRoot = path.join(realRoot, storageArea);
    const realArea = await fsp.realpath(areaRoot);
    if (!contained(realRoot, realArea)) { await sourceHandle.close(); throw new StudioValidationError("Unsafe internal asset destination."); }
    const id = randomUUID(), storageName = `${id}${extension}`;
    const target = path.join(realArea, storageName), temp = path.join(realRoot, "tmp", `${id}.partial`);
    const hash = createHash("sha256");
    let copied = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) { copied += chunk.length; hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(sourceHandle.createReadStream(), meter, fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
      if (copied !== sourceStat.size) throw new StudioValidationError("Internal asset changed while it was imported.", 409);
      await fsp.rename(temp, target);
      return await this.insertAsset(accountId, projectId, { id, storageName, storageArea, mimeType: type, originalName, size: copied, sha256: hash.digest("hex"), filePath: target, source: "internal" });
    } catch (error) {
      await Promise.all([fsp.rm(temp, { force: true }), fsp.rm(target, { force: true })]);
      throw error;
    }
  }

  async appendUpload(accountId, projectId, uploadId, input = {}) {
    this.projectService.get(accountId, projectId);
    if (!/^[0-9a-f-]{36}$/i.test(String(uploadId || ""))) throw new StudioValidationError("Invalid upload identifier.");
    const offset = Number(input.offset), total = Number(input.total);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(total) || total < 1 || total > MAX_UPLOAD_BYTES || offset >= total) throw new StudioValidationError("Invalid chunk upload range.");
    if (!Buffer.isBuffer(input.buffer) || !input.buffer.length || input.buffer.length > MAX_UPLOAD_CHUNK_BYTES || offset + input.buffer.length > total) throw new StudioValidationError("Invalid upload chunk.");
    const root = await this.projectService.ensureProjectFolders(accountId, projectId);
    const filePath = path.join(root, "tmp", `${uploadId}.upload`), metadataPath = `${filePath}.json`;
    const metadata = { mimeType: String(input.mimeType || "application/octet-stream"), originalName: sanitizeName(input.originalName), total };
    if (offset === 0) {
      await Promise.all([fsp.rm(filePath, { force: true }), fsp.rm(metadataPath, { force: true })]);
      await fsp.writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
      await fsp.writeFile(filePath, input.buffer, { mode: 0o600, flag: "wx" });
    } else {
      let stored;
      try { stored = JSON.parse(await fsp.readFile(metadataPath, "utf8")); } catch { throw new StudioValidationError("Chunk upload session was not found.", 404); }
      if (stored.total !== total || stored.mimeType !== metadata.mimeType || stored.originalName !== metadata.originalName) throw new StudioValidationError("Chunk upload metadata changed.", 409);
      const stat = await fsp.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== offset) throw new StudioValidationError("Chunk upload offset conflict.", 409);
      await fsp.appendFile(filePath, input.buffer);
    }
    return { uploadId, received: offset + input.buffer.length, total, complete: offset + input.buffer.length === total };
  }

  async finalizeUpload(accountId, projectId, uploadId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(uploadId || ""))) throw new StudioValidationError("Invalid upload identifier.");
    const root = await this.projectService.ensureProjectFolders(accountId, projectId);
    const filePath = path.join(root, "tmp", `${uploadId}.upload`), metadataPath = `${filePath}.json`;
    let metadata;
    try { metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8")); } catch { throw new StudioValidationError("Chunk upload session was not found.", 404); }
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== metadata.total) throw new StudioValidationError("Chunk upload is incomplete.", 409);
    try { return await this.importInternalFile(accountId, projectId, { filePath, mimeType: metadata.mimeType, originalName: metadata.originalName, storageArea: "originals" }); }
    finally { await Promise.all([fsp.rm(filePath, { force: true }), fsp.rm(metadataPath, { force: true })]); }
  }

  derivative(accountId, projectId, sourceAssetId, kind, settings = {}) {
    this.row(accountId, projectId, sourceAssetId);
    if (!DERIVATIVE_KINDS.has(kind)) throw new StudioValidationError("Unsupported derivative kind.");
    const settingsJson = stableJson(settings || {});
    const settingsHash = createHash("sha256").update(settingsJson).digest("hex");
    const row = this.db.prepare("SELECT a.* FROM studio_asset_derivatives d JOIN studio_assets a ON a.id=d.derivative_asset_id WHERE d.account_id=? AND d.project_id=? AND d.source_asset_id=? AND d.kind=? AND d.settings_hash=? AND a.deleted_at IS NULL")
      .get(accountId, projectId, sourceAssetId, kind, settingsHash);
    return { asset: mapAsset(row), settingsHash, settingsJson };
  }

  async registerDerivative(accountId, projectId, { sourceAssetId, kind, settings = {}, filePath, mimeType, originalName }) {
    const existing = this.derivative(accountId, projectId, sourceAssetId, kind, settings);
    if (existing.asset) return existing.asset;
    const asset = await this.importInternalFile(accountId, projectId, { filePath, mimeType, originalName, storageArea: "proxies" });
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO studio_asset_derivatives(id,account_id,project_id,source_asset_id,derivative_asset_id,kind,settings_hash,settings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(randomUUID(), accountId, projectId, sourceAssetId, asset.id, kind, existing.settingsHash, existing.settingsJson, now);
      this.projectService.recordEvent(accountId, projectId, "asset.derivative.created", { sourceAssetId, derivativeAssetId: asset.id, kind }, now);
      return asset;
    } catch (error) {
      const winner = this.derivative(accountId, projectId, sourceAssetId, kind, settings).asset;
      if (!winner) throw error;
      const imported = this.contentPath(accountId, projectId, asset.id);
      this.db.prepare("DELETE FROM studio_assets WHERE id=?").run(asset.id);
      await fsp.rm(imported.filePath, { force: true });
      return winner;
    }
  }

  latestDerivative(accountId, projectId, sourceAssetId, kind = "proxy") {
    this.row(accountId, projectId, sourceAssetId);
    const row = this.db.prepare("SELECT a.* FROM studio_asset_derivatives d JOIN studio_assets a ON a.id=d.derivative_asset_id WHERE d.account_id=? AND d.project_id=? AND d.source_asset_id=? AND d.kind=? AND a.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 1").get(accountId, projectId, sourceAssetId, kind);
    if (!row) throw new StudioValidationError("Asset proxy not found.", 404);
    return mapAsset(row);
  }

  delete(accountId, projectId, assetId) {
    this.row(accountId, projectId, assetId);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE studio_assets SET deleted_at=?,status='deleted' WHERE id=? AND deleted_at IS NULL").run(now, assetId);
      this.projectService.recordEvent(accountId, projectId, "asset.deleted", { assetId }, now);
    })();
    return this.get(accountId, projectId, assetId, { includeDeleted: true });
  }

  async registerOutput(accountId, projectId, filePath, mimeType, originalName) {
    const type = String(mimeType || "").toLowerCase().split(";")[0].trim();
    if (!MIME_EXTENSIONS.has(type)) throw new StudioValidationError("Unsupported output MIME type.");
    const root = path.resolve(this.projectService.projectPath(accountId, projectId));
    const renderRoot = path.resolve(root, "renders"), resolved = path.resolve(filePath);
    if (!contained(renderRoot, resolved)) throw new StudioValidationError("Render output is outside the project render directory.");
    const stat = await fsp.stat(resolved);
    if (!stat.isFile() || stat.size <= 0) throw new StudioValidationError("Render output is not a valid file.");
    return this.insertAsset(accountId, projectId, { id: randomUUID(), storageName: path.basename(resolved), storageArea: "renders", mimeType: type, originalName, size: stat.size, sha256: await hashFile(resolved), filePath: resolved, source: "render" });
  }
}

module.exports = { AssetService, MIME_EXTENSIONS, MAX_ASSET_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES, MAX_INTERNAL_ASSET_BYTES, DERIVATIVE_KINDS, sanitizeName, mapAsset, runProbe, hashFile, stableJson, validateCube };
