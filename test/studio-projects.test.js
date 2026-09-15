const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { StudioDatabase } = require("../src/studio/database");
const { StudioEventHub } = require("../src/studio/event-hub");
const { StudioProjectService } = require("../src/studio/project-service");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-studio-projects-"));
  const database = new StudioDatabase(path.join(root, "studio.db"));
  const service = new StudioProjectService({ database, rootPath: root, eventHub: new StudioEventHub() });
  return { root, database, service };
}

test("studio projects persist 4K long-form settings per account", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const project = await service.create("account-a", {
    title: "Long story",
    contentType: "mini-film",
    objective: "Tell a complete story",
    prompt: "A mystery in Madrid",
    targetDurationSeconds: 3600,
    aspectRatio: "9:16",
    fps: 30,
  });

  assert.equal(project.width, 2160);
  assert.equal(project.height, 3840);
  assert.equal(project.targetDurationSeconds, 3600);
  assert.equal(project.pipeline[0].status, "ready");
  assert.equal(service.list("account-b").length, 0);
  await fs.access(path.join(root, "accounts", "account-a", "projects", project.id, "renders"));
});

test("studio project updates use optimistic revisions", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const project = await service.create("account-a", { title: "Draft" });
  const updated = service.update("account-a", project.id, { baseRevision: project.revision, title: "Approved title" });
  assert.equal(updated.title, "Approved title");
  assert.equal(updated.revision, 2);

  assert.throws(
    () => service.update("account-a", project.id, { baseRevision: 1, title: "Stale title" }),
    (error) => error.statusCode === 409,
  );
});

test("project changes roll back when durable event recording fails", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const project = await service.create("account-a", { title: "Original" });
  service.recordEvent = () => { throw new Error("event storage failed"); };
  assert.throws(
    () => service.update("account-a", project.id, { baseRevision: project.revision, title: "Must roll back" }),
    /event storage failed/,
  );
  const unchanged = service.get("account-a", project.id);
  assert.equal(unchanged.title, "Original");
  assert.equal(unchanged.revision, 1);
});

test("archived studio projects are hidden without deleting media", async (t) => {
  const { root, database, service } = await fixture();
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });

  const project = await service.create("account-a", { title: "Archive me" });
  service.archive("account-a", project.id, project.revision);
  assert.equal(service.list("account-a").length, 0);
  assert.equal(service.list("account-a", { includeArchived: true }).length, 1);
  await fs.access(path.join(root, "accounts", "account-a", "projects", project.id));
});
