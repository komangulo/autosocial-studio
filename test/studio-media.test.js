const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const { StudioDatabase, SCHEMA_VERSION } = require("../src/studio/database");
const { createStudioModule } = require("../src/studio");
const { writeProceduralWav } = require("../src/studio/media-service");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-media-"));
  const accounts = new Map([["account-a", { id: "account-a" }], ["account-b", { id: "account-b" }]]);
  const studio = createStudioModule({
    rootPath: root,
    databasePath: path.join(root, "studio.db"),
    getActiveAccount: async () => accounts.get("account-a"),
    requireAccount: async (id) => {
      if (!accounts.has(id)) throw new Error("Account not found.");
      return accounts.get(id);
    },
    flowConfig: async () => ({ geminiApiKey: "" }),
    googleFlow: { generateVideos: async () => [] },
    mediaPollMs: 60000,
  });
  return {
    root,
    studio,
    project: (accountId = "account-a") => studio.projectService.create(accountId, { title: "Media" }),
    async close() { studio.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

async function fakeAsset(f, project, accountId = "account-a", name = "frame.png") {
  return f.studio.assetService.importBuffer(accountId, project.id, { buffer: Buffer.from(`image-${name}`), mimeType: "image/png", originalName: name });
}

test("v8 migration creates durable derivative keys and indexes without changing assets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-v7-media-"));
  const file = path.join(root, "studio.db");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = new StudioDatabase(file);
  initial.db.exec("DROP TABLE studio_asset_derivatives; PRAGMA user_version=7");
  initial.close();
  const upgraded = new StudioDatabase(file);
  t.after(() => upgraded.close());
  assert.equal(upgraded.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const columns = upgraded.db.pragma("table_info(studio_asset_derivatives)").map((column) => column.name);
  assert.deepEqual(columns, ["id", "account_id", "project_id", "source_asset_id", "derivative_asset_id", "kind", "settings_hash", "settings_json", "created_at"]);
  assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='studio_asset_derivatives_source'").get());
});

test("internal derivative registration is account scoped, idempotent, and rejects symlinks", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const project = await f.project(), source = await fakeAsset(f, project);
  const root = await f.studio.projectService.ensureProjectFolders("account-a", project.id);
  const output = path.join(root, "tmp", "proxy.jpg");
  await fs.writeFile(output, "proxy");
  const first = await f.studio.assetService.registerDerivative("account-a", project.id, { sourceAssetId: source.id, kind: "proxy", settings: { width: 640 }, filePath: output, mimeType: "image/jpeg", originalName: "proxy.jpg" });
  const second = await f.studio.assetService.registerDerivative("account-a", project.id, { sourceAssetId: source.id, kind: "proxy", settings: { width: 640 }, filePath: output, mimeType: "image/jpeg", originalName: "proxy.jpg" });
  assert.equal(second.id, first.id);
  assert.equal(f.studio.database.db.prepare("SELECT COUNT(*) count FROM studio_asset_derivatives").get().count, 1);
  assert.throws(() => f.studio.assetService.latestDerivative("account-b", project.id, source.id), /not found/);
  const outside = path.join(f.root, "outside.jpg"); await fs.writeFile(outside, "outside");
  const link = path.join(root, "tmp", "link.jpg"); await fs.symlink(outside, link);
  await assert.rejects(() => f.studio.assetService.importInternalFile("account-a", project.id, { filePath: link, mimeType: "image/jpeg" }), /regular file/);
});

test("procedural WAV generation is deterministic and structurally valid", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "procedural-wav-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const one = path.join(root, "one.wav"), two = path.join(root, "two.wav");
  await writeProceduralWav(one, { seed: "fixed", mode: "sfx", durationSeconds: 0.1 });
  await writeProceduralWav(two, { seed: "fixed", mode: "sfx", durationSeconds: 0.1 });
  const [a, b] = await Promise.all([fs.readFile(one), fs.readFile(two)]);
  assert.deepEqual(a, b);
  assert.equal(a.subarray(0, 4).toString(), "RIFF");
  assert.equal(a.subarray(8, 12).toString(), "WAVE");
  assert.equal(a.readUInt32LE(40), 4410 * 2);
});

test("automatic rough cut preserves approved storyboard order and detects revision conflicts", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const project = await f.project(), first = await fakeAsset(f, project, "account-a", "one.png"), second = await fakeAsset(f, project, "account-a", "two.png");
  const now = new Date().toISOString();
  f.studio.database.db.prepare("INSERT INTO studio_documents(id,project_id,kind,version,content_json,status,change_note,created_at,approved_at) VALUES (?,?,?,?,?,'approved','',?,?)")
    .run(randomUUID(), project.id, "storyboard", 1, JSON.stringify({ shots: [{ id: "second-shot", generatedAssetId: second.id, durationMs: 2000 }, { id: "first-shot", referenceAssetIds: [first.id], durationMs: 1000 }] }), now, now);
  const rough = f.studio.timelineService.createRoughCut("account-a", project.id, { baseVersion: 0, baseProjectRevision: project.revision });
  const clips = rough.document.content.tracks[0].clips;
  assert.deepEqual(clips.map((clip) => [clip.shotId, clip.assetId, clip.startMs, clip.durationMs]), [["second-shot", second.id, 0, 2000], ["first-shot", first.id, 2000, 1000]]);
  assert.equal(rough.document.status, "draft");
  assert.equal(rough.document.content.durationMs, 3000);
  assert.throws(() => f.studio.timelineService.createRoughCut("account-a", project.id, { baseVersion: 0, baseProjectRevision: project.revision }), /another session|Current version/);
});

test("media job validation bounds input and isolates referenced assets", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const projectA = await f.project("account-a"), projectB = await f.project("account-b");
  const assetB = await fakeAsset(f, projectB, "account-b");
  assert.throws(() => f.studio.mediaService.enqueue("account-a", projectA.id, { operation: "proxy", sourceAssetId: assetB.id }), /not found/);
  assert.throws(() => f.studio.mediaService.enqueue("account-a", projectA.id, { operation: "speech", text: "x".repeat(10001) }), /10000/);
  assert.throws(() => f.studio.mediaService.enqueue("account-a", projectA.id, { operation: "flow-video", prompts: ["shot"], aspectRatio: "16:9" }), /only 9:16/);
  assert.throws(() => f.studio.mediaService.enqueue("account-a", projectA.id, { operation: "flow-video", prompts: [] }), /one and three/);
  const job = f.studio.mediaService.enqueue("account-a", projectA.id, { operation: "procedural-audio", seed: "fixed", durationSeconds: 0.1 });
  assert.equal(job.type, "media"); assert.equal(job.status, "queued");
});

test("media and proxy route contracts remain account scoped", async (t) => {
  const f = await fixture();
  const app = express(); app.use(express.json()); app.use("/api/studio", f.studio.router);
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await f.close(); });
  const project = await f.project(), asset = await fakeAsset(f, project);
  const base = `http://127.0.0.1:${server.address().port}/api/studio/projects/${project.id}`;
  const headers = { "content-type": "application/json", "x-autosocial-account-id": "account-a" };
  const queued = await fetch(`${base}/media-jobs`, { method: "POST", headers, body: JSON.stringify({ operation: "procedural-audio", durationSeconds: 0.1, seed: "route" }) });
  assert.equal(queued.status, 202); const body = await queued.json(); assert.equal(body.job.type, "media");
  const invalid = await fetch(`${base}/media-jobs`, { method: "POST", headers, body: JSON.stringify({ operation: "flow-video", prompts: ["x"], aspectRatio: "1:1" }) });
  assert.equal(invalid.status, 400);
  const missingProxy = await fetch(`${base}/assets/${asset.id}/proxy-content`, { headers: { "x-autosocial-account-id": "account-a" } });
  assert.equal(missingProxy.status, 404);
  const hidden = await fetch(`${base}/assets/${asset.id}/proxy-content`, { headers: { "x-autosocial-account-id": "account-b" } });
  assert.equal(hidden.status, 404);
});
