const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { createStudioModule } = require("../src/studio");
const { SCHEMA_VERSION } = require("../src/studio/database");
const { validateCube } = require("../src/studio/asset-service");
const { validateGraph, validateTimeline } = require("../src/studio/document-validation");
const { keyframeExpression, makeAss, normalizeRenderOptions } = require("../src/studio/render-service");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-advanced-"));
  const queues = {};
  const studio = createStudioModule({ rootPath: root, databasePath: path.join(root, "studio.db"), mediaPollMs: 60000, getActiveAccount: async () => ({ id: "account-a" }), requireAccount: async (id) => ({ id }), flowConfig: async () => ({}), getAccountQueueDirs: (accountId) => {
    const base = path.join(root, "queues", accountId);
    for (const platform of ["youtube", "tiktok", "instagram"]) queues[platform] = { pending: path.join(base, platform, "pending"), scheduled: path.join(base, platform, "scheduled"), posted: path.join(base, platform, "posted"), failed: path.join(base, platform, "failed") };
    return queues;
  } });
  return { root, studio, async close() { studio.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test("schema v9 persists render options and remote publication receipts", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal(f.studio.database.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.ok(f.studio.database.db.pragma("table_info(studio_renders)").some((column) => column.name === "options_json"));
  assert.ok(f.studio.database.db.pragma("table_info(studio_publications)").some((column) => column.name === "confirmation_json"));
});

test("editable graph validation rejects duplicate, missing, self and cyclic edges", () => {
  const graph = { nodes: [{ id: "a", label: "A", type: "step", x: 0, y: 0 }, { id: "b", label: "B", type: "step", x: 1, y: 1 }], edges: [{ id: "ab", from: "a", to: "b" }], settings: { autoRun: false } };
  assert.deepEqual(validateGraph(graph), graph);
  assert.throws(() => validateGraph({ ...graph, edges: [{ id: "ab", from: "a", to: "a" }] }), /self/);
  assert.throws(() => validateGraph({ ...graph, edges: [{ id: "ab", from: "a", to: "b" }, { id: "ba", from: "b", to: "a" }] }), /acyclic/);
});

test("CUBE LUT parser enforces declared grid and finite samples", () => {
  const valid = Buffer.from("TITLE identity\nLUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n");
  assert.deepEqual(validateCube(valid), { dimensions: 3, size: 2, rows: 8 });
  assert.throws(() => validateCube(Buffer.from("LUT_3D_SIZE 2\n0 0 NaN\n")), /invalid|count/);
});

test("timeline keyframes validate easing and compile piecewise expressions", () => {
  const clip = { id: "clip", assetId: "asset", startMs: 0, durationMs: 1000, transform: {}, color: {}, audio: {}, keyframes: [{ property: "x", timeMs: 0, value: 0, easing: "linear" }, { property: "x", timeMs: 1000, value: 100, easing: "ease-in-out" }] };
  validateTimeline({ durationMs: 1000, tracks: [{ id: "v", type: "video", clips: [clip] }] });
  const expression = keyframeExpression(clip, "x", 0);
  assert.match(expression, /pow/);
  assert.match(expression, /100/);
  assert.throws(() => validateTimeline({ tracks: [{ id: "v", type: "video", clips: [{ ...clip, keyframes: [{ property: "x", timeMs: 1001, value: 0 }] }] }] }), /within/);
});

test("ASS generation escapes content and applies controlled animation", () => {
  const options = normalizeRenderOptions({ subtitleMode: "burn", subtitleStyle: { animation: "pop", fontFamily: "Arial", fontSize: 36, textColor: "#ffffff", backgroundColor: "#000000", position: "bottom" } });
  const ass = makeAss([{ startMs: 0, endMs: 1000, text: "a{b}\\c\nnext" }], { width: 1920, height: 1080 }, options);
  assert.match(ass, /fscx70/);
  assert.match(ass, /a\\\{b\\\}\\\\c\\Nnext/);
});

test("chunked uploads resume by offset and finalize validated assets", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const project = await f.studio.projectService.create("account-a", { title: "Upload" });
  const uploadId = randomUUID(), body = Buffer.from("long-form-source");
  await f.studio.assetService.appendUpload("account-a", project.id, uploadId, { buffer: body.subarray(0, 5), offset: 0, total: body.length, mimeType: "video/mp4", originalName: "source.mp4" });
  await assert.rejects(() => f.studio.assetService.finalizeUpload("account-a", project.id, uploadId), /incomplete/);
  await f.studio.assetService.appendUpload("account-a", project.id, uploadId, { buffer: body.subarray(5), offset: 5, total: body.length, mimeType: "video/mp4", originalName: "source.mp4" });
  const asset = await f.studio.assetService.finalizeUpload("account-a", project.id, uploadId);
  assert.equal(asset.sizeBytes, body.length);
  assert.equal((await fs.readFile(f.studio.assetService.contentPath("account-a", project.id, asset.id).filePath)).toString(), body.toString());
});

test("publication handoff writes manifest and only explicit evidence confirms remote publication", async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const project = await f.studio.projectService.create("account-a", { title: "Publish" });
  const root = await f.studio.projectService.ensureProjectFolders("account-a", project.id);
  const master = path.join(root, "renders", "master.mp4"); await fs.writeFile(master, Buffer.alloc(2048, 1));
  const asset = await f.studio.assetService.registerOutput("account-a", project.id, master, "video/mp4", "master.mp4");
  const now = new Date().toISOString(), renderId = randomUUID();
  f.studio.database.db.prepare("INSERT INTO studio_renders(id,project_id,account_id,timeline_version,preset,status,output_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?)").run(renderId, project.id, "account-a", 1, "preview", asset.id, now, now);
  const publication = await f.studio.publicationService.create("account-a", project.id, { renderId, platform: "youtube", idempotencyKey: "receipt-1", caption: "Caption" });
  const manifest = JSON.parse(await fs.readFile(publication.queuePath.replace(/\.mp4$/, ".studio.json"), "utf8"));
  assert.equal(manifest.publicationId, publication.id);
  assert.throws(() => f.studio.publicationService.confirm("account-a", project.id, publication.id, { status: "published" }), /requires/);
  const confirmed = f.studio.publicationService.confirm("account-a", project.id, publication.id, { status: "published", remoteUrl: "https://example.com/video/1", evidence: { confirmed: true } });
  assert.equal(confirmed.status, "published");
  assert.equal(confirmed.remoteStatus, "published");
});
