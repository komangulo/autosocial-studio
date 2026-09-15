const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const Database = require("better-sqlite3");
const express = require("express");
const { StudioDatabase, SCHEMA_VERSION } = require("../src/studio/database");
const { createStudioModule } = require("../src/studio");

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-phases-"));
  const accounts = new Map([["account-a", { id: "account-a" }], ["account-b", { id: "account-b" }]]);
  const studio = createStudioModule({ rootPath: root, databasePath: path.join(root, "studio.db"), getActiveAccount: async () => accounts.get("account-a"), requireAccount: async (id) => { if (!accounts.has(id)) throw new Error("Account not found."); return accounts.get(id); }, flowConfig: async () => ({ geminiApiKey: "" }), ...options });
  async function project(account = "account-a") { return studio.projectService.create(account, { title: "Phases", prompt: "A concise story" }); }
  return { root, studio, project, async close() { studio.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test("sequential migration upgrades a pre-existing schema v1 database and brief", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-v1-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const file = path.join(root, "v1.db");
  const first = new StudioDatabase(file); const legacyNow = new Date().toISOString(); first.db.prepare("INSERT INTO studio_projects(id,account_id,title,content_type,target_duration_seconds,aspect_ratio,width,height,fps,created_at,updated_at) VALUES ('legacy-project','account-a','Legacy','story',60,'16:9',1920,1080,30,?,?)").run(legacyNow, legacyNow); first.db.prepare("INSERT INTO studio_documents(id,project_id,kind,version,content_json,approved_at,created_at,status) VALUES ('legacy-script-1','legacy-project','script',1,'{}',?,?,'approved')").run(legacyNow, legacyNow); first.db.prepare("INSERT INTO studio_documents(id,project_id,kind,version,content_json,approved_at,created_at,status) VALUES ('legacy-script-2','legacy-project','script',2,'{}',?,?,'approved')").run(legacyNow, legacyNow); first.close();
  const raw = new Database(file); raw.exec("DROP TABLE studio_asset_derivatives; DROP TABLE studio_publications; DROP TABLE studio_renders; DROP TABLE studio_assets; DROP INDEX studio_documents_status; DROP INDEX studio_events_account_id; DROP INDEX studio_jobs_project_created; DROP INDEX studio_job_dependencies_reverse; DROP INDEX studio_documents_versions; PRAGMA user_version=1");
  raw.exec("CREATE TABLE old_documents AS SELECT id,project_id,kind,version,content_json,approved_at,created_at FROM studio_documents; DROP TABLE studio_documents; ALTER TABLE old_documents RENAME TO studio_documents"); raw.close();
  const upgraded = new StudioDatabase(file); t.after(() => upgraded.close()); assert.equal(upgraded.db.pragma("user_version", { simple: true }), SCHEMA_VERSION); const columns = upgraded.db.pragma("table_info(studio_documents)").map((item) => item.name); assert.ok(columns.includes("status")); assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE name='studio_assets'").get()); assert.equal(upgraded.db.prepare("SELECT status FROM studio_documents WHERE id='legacy-script-2'").get().status, "approved"); assert.equal(upgraded.db.prepare("SELECT status FROM studio_documents WHERE id='legacy-script-1'").get().status, "superseded");
});

test("documents are immutable, revision guarded, gated, restorable, and account scoped", async (t) => {
  const f = await fixture(); t.after(() => f.close()); let project = await f.project(); const initial = f.studio.documentService.get("account-a", project.id, "brief", 1); assert.equal(initial.content.prompt, "A concise story");
  let approved = f.studio.documentService.approve("account-a", project.id, "brief", 1, { baseProjectRevision: project.revision }); project = approved.project;
  assert.throws(() => f.studio.documentService.create("account-a", project.id, "script", { content: { text: "x" }, baseVersion: 0, baseProjectRevision: project.revision - 1 }), /another session/);
  let created = f.studio.documentService.create("account-a", project.id, "script", { content: { text: "Scene" }, baseVersion: 0, baseProjectRevision: project.revision }); project = created.project;
  approved = f.studio.documentService.approve("account-a", project.id, "script", 1, { baseProjectRevision: project.revision }); project = approved.project;
  const restored = f.studio.documentService.restore("account-a", project.id, "script", 1, { baseProjectRevision: project.revision }); assert.equal(restored.document.version, 2); assert.equal(f.studio.documentService.get("account-a", project.id, "script", 1).content.text, "Scene");
  assert.throws(() => f.studio.documentService.list("account-b", project.id, "script"), /not found/);
});

test("jobs dedupe, dependencies, leases, cancellation, retry, and recovery atomically", async (t) => {
  const f = await fixture(); t.after(() => f.close()); const project = await f.project(), jobs = f.studio.jobService;
  const first = jobs.enqueue("account-a", project.id, { type: "generate-document", dedupeKey: "same", maxAttempts: 2 }); assert.equal(jobs.enqueue("account-a", project.id, { type: "generate-document", dedupeKey: "same" }).id, first.id);
  const dependent = jobs.enqueue("account-a", project.id, { type: "render", dependsOn: [first.id] }); assert.equal(jobs.claim("worker", { type: "render" }), null);
  const claimed = jobs.claim("worker", { type: "generate-document" }); jobs.heartbeat(claimed.id, "worker", { current: 1, total: 2 }); jobs.complete(claimed.id, "worker", { ok: true }); assert.equal(jobs.claim("worker", { type: "render" }).id, dependent.id);
  const blocked = jobs.enqueue("account-a", project.id, { type: "external-video", status: "blocked" }); assert.equal(jobs.cancel("account-a", project.id, blocked.id).status, "cancelled"); assert.equal(jobs.retry("account-a", project.id, blocked.id).status, "queued");
  jobs.db.prepare("UPDATE studio_jobs SET lease_expires_at=? WHERE id=?").run(new Date(0).toISOString(), dependent.id); assert.equal(jobs.recoverExpired(), 1);
});

test("asset import is contained, immutable, hashed, MIME restricted, and soft deleted", async (t) => {
  const f = await fixture(); t.after(() => f.close()); const project = await f.project();
  await assert.rejects(() => f.studio.assetService.importBuffer("account-a", project.id, { buffer: Buffer.from("x"), mimeType: "application/javascript", originalName: "../../bad.js" }), /Unsupported/);
  const asset = await f.studio.assetService.importBuffer("account-a", project.id, { buffer: Buffer.from("not-a-real-png"), mimeType: "image/png", originalName: "../../poster.png" }); assert.equal(asset.originalName, "poster.png"); assert.equal(asset.sha256.length, 64); const content = f.studio.assetService.contentPath("account-a", project.id, asset.id); assert.ok(content.filePath.includes(`${path.sep}originals${path.sep}`)); assert.equal((await fs.readFile(content.filePath)).toString(), "not-a-real-png"); assert.equal(f.studio.assetService.delete("account-a", project.id, asset.id).status, "deleted"); assert.throws(() => f.studio.assetService.get("account-a", project.id, asset.id), /not found/);
});

test("timeline validation and render preflight never fake completion", async (t) => {
  const f = await fixture(); t.after(() => f.close()); let project = await f.project();
  assert.throws(() => f.studio.documentService.create("account-a", project.id, "timeline", { content: { tracks: [{ id: "v", type: "video", clips: [{ id: "c", assetId: "bad", startMs: 0.5, durationMs: 10 }] }] }, baseVersion: 0, baseProjectRevision: project.revision }), /integer/);
  const now = new Date().toISOString(); for (const kind of ["script", "bible", "references", "storyboard"]) f.studio.database.db.prepare("INSERT INTO studio_documents(id,project_id,kind,version,content_json,status,change_note,created_at,approved_at) VALUES (?,?,?,?,?,'approved','',?,?)").run(randomUUID(), project.id, kind, 1, "{}", now, now); f.studio.database.db.prepare("UPDATE studio_documents SET status='approved',approved_at=? WHERE project_id=? AND kind='brief'").run(now, project.id); f.studio.database.db.prepare("UPDATE studio_documents SET content_json=? WHERE project_id=? AND kind='storyboard'").run(JSON.stringify({ shots: [], roughCutApproved: true }), project.id);
  const timeline = f.studio.documentService.create("account-a", project.id, "timeline", { content: { durationMs: 1000, tracks: [] }, baseVersion: 0, baseProjectRevision: project.revision }); project = timeline.project; const approved = f.studio.documentService.approve("account-a", project.id, "timeline", 1, { baseProjectRevision: project.revision }); const render = f.studio.renderService.create("account-a", project.id, { timelineVersion: 1, preset: "preview" }); const processed = await f.studio.renderService.process("account-a", project.id, render.id); assert.equal(processed.status, "blocked"); assert.match(processed.error.message, /no visual assets|FFmpeg|100 GB of free storage/); assert.notEqual(processed.status, "completed");
});

test("publication idempotency and missing queue integration persist a safe block", async (t) => {
  const f = await fixture(); t.after(() => f.close()); const project = await f.project(); const asset = await f.studio.assetService.importBuffer("account-a", project.id, { buffer: Buffer.from("master"), mimeType: "video/mp4", originalName: "master.mp4" }); const now = new Date().toISOString(), renderId = randomUUID(); f.studio.database.db.prepare("INSERT INTO studio_renders(id,project_id,account_id,timeline_version,preset,status,output_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?)").run(renderId, project.id, "account-a", 1, "preview", asset.id, now, now);
  const item = await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "youtube", idempotencyKey: "pub-1", caption: "caption" }); assert.equal(item.status, "blocked"); assert.match(item.blockedReason, /queue integration/); assert.equal((await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "youtube", idempotencyKey: "pub-1" })).id, item.id);
});

test("scheduled publication handoff writes captions and cancellation removes queued files", async (t) => {
  const queues = {};
  const f = await fixture({
    getAccountQueueDirs: (accountId) => {
      const base = path.join(f.root, "queues", accountId);
      for (const platform of ["youtube", "tiktok", "instagram"]) {
        queues[platform] = { pending: path.join(base, platform, "pending"), scheduled: path.join(base, platform, "scheduled") };
      }
      return queues;
    },
  });
  t.after(() => f.close());
  const project = await f.project();
  const asset = await f.studio.assetService.importBuffer("account-a", project.id, { buffer: Buffer.from("master"), mimeType: "video/mp4", originalName: "master.mp4" });
  const now = new Date().toISOString();
  const renderId = randomUUID();
  f.studio.database.db.prepare("INSERT INTO studio_renders(id,project_id,account_id,timeline_version,preset,status,output_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?)")
    .run(renderId, project.id, "account-a", 1, "preview", asset.id, now, now);
  const scheduled = await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "youtube", idempotencyKey: "scheduled-1", caption: "A caption", scheduledAt: new Date(Date.now() + 60000).toISOString() });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(await fs.readFile(scheduled.queuePath.replace(/\.mp4$/, ".description"), "utf8"), "A caption");
  await f.studio.publicationService.cancel("account-a", project.id, scheduled.id);
  await assert.rejects(() => fs.access(scheduled.queuePath), /ENOENT/);
  await assert.rejects(() => fs.access(scheduled.queuePath.replace(/\.mp4$/, ".description")), /ENOENT/);
  const due = await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "instagram", idempotencyKey: "due-1", caption: "Later", scheduledAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(due.status, "scheduled");
  assert.equal(await f.studio.publicationService.promoteDue(new Date(Date.now() + 2000)), 1);
  const promoted = f.studio.publicationService.get("account-a", project.id, due.id);
  assert.equal(promoted.status, "handed-off");
  assert.ok(promoted.queuePath.includes(`${path.sep}pending${path.sep}`));
  assert.equal(await fs.readFile(promoted.queuePath.replace(/\.mp4$/, ".description"), "utf8"), "Later");
  const immediate = await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "tiktok", idempotencyKey: "immediate-1", caption: "Now" });
  assert.equal(immediate.status, "handed-off");
  assert.equal(await fs.readFile(immediate.queuePath.replace(/\.mp4$/, ".description"), "utf8"), "Now");
  f.studio.database.db.prepare("UPDATE studio_publications SET status='preparing',queue_path=NULL WHERE id=?").run(immediate.id);
  assert.equal(await f.studio.publicationService.reconcile(), 1);
  assert.equal(f.studio.publicationService.get("account-a", project.id, immediate.id).status, "handed-off");
  await assert.rejects(() => f.studio.publicationService.cancel("account-a", project.id, immediate.id), /no longer be cancelled/);
});

test("phase routes expose documents, generation, jobs, assets and enforce account authorization", async (t) => {
  const f = await fixture(); const app = express(); app.use(express.json()); app.use("/api/studio", f.studio.router); const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); }); t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await f.close(); }); const base = `http://127.0.0.1:${server.address().port}/api/studio`, headers = { "content-type": "application/json", "x-autosocial-account-id": "account-a" };
  const created = await fetch(`${base}/projects`, { method: "POST", headers, body: JSON.stringify({ title: "Routes" }) }).then((r) => r.json()); const generated = await fetch(`${base}/projects/${created.project.id}/generate`, { method: "POST", headers, body: JSON.stringify({ kind: "script", provider: "local", baseVersion: 0, baseProjectRevision: created.project.revision }) }); assert.equal(generated.status, 201); const generatedBody = await generated.json(); assert.equal(generatedBody.document.content.acts.length, 3); assert.equal(generatedBody.project.revision, created.project.revision + 1); const hidden = await fetch(`${base}/projects/${created.project.id}/documents/script`, { headers: { "x-autosocial-account-id": "account-b" } }); assert.equal(hidden.status, 404);
  const upload = await fetch(`${base}/projects/${created.project.id}/assets`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "poster.png", "x-autosocial-account-id": "account-a" }, body: Buffer.from("png") }); assert.equal(upload.status, 201);
});
