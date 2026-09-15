const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");
const { createStudioModule } = require("../src/studio");

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-studio-api-"));
  let activeAccount = { id: "account-a", name: "Account A" };
  const accounts = new Map([
    ["account-a", activeAccount],
    ["account-b", { id: "account-b", name: "Account B" }],
  ]);
  const studio = createStudioModule({
    rootPath: root,
    databasePath: path.join(root, "studio.db"),
    getActiveAccount: async () => activeAccount,
    requireAccount: async (id) => {
      const account = accounts.get(id);
      if (!account) throw new Error("Account not found.");
      return account;
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/studio", studio.router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  return {
    root,
    studio,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/studio`,
    selectAccount: (id) => { activeAccount = accounts.get(id); },
  };
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test("studio API creates and isolates projects by active account", async (t) => {
  const fixture = await startFixture();
  t.after(async () => {
    fixture.server.closeAllConnections?.();
    await new Promise((resolve) => fixture.server.close(resolve));
    fixture.studio.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const created = await json(`${fixture.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-autosocial-account-id": "account-a" },
    body: JSON.stringify({ title: "API story", targetDurationSeconds: 900, aspectRatio: "16:9" }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.project.width, 3840);

  fixture.selectAccount("account-b");
  const otherAccount = await json(`${fixture.baseUrl}/projects`, { headers: { "x-autosocial-account-id": "account-b" } });
  assert.equal(otherAccount.body.projects.length, 0);

  const originalAccount = await json(`${fixture.baseUrl}/projects`, { headers: { "x-autosocial-account-id": "account-a" } });
  assert.equal(originalAccount.body.projects.length, 1);

  const missingAccount = await json(`${fixture.baseUrl}/projects`);
  assert.equal(missingAccount.response.status, 400);
  assert.match(missingAccount.body.error, /explicit Studio account/);
});

test("studio API rejects unsupported durations", async (t) => {
  const fixture = await startFixture();
  t.after(async () => {
    fixture.server.closeAllConnections?.();
    await new Promise((resolve) => fixture.server.close(resolve));
    fixture.studio.database.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const result = await json(`${fixture.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-autosocial-account-id": "account-a" },
    body: JSON.stringify({ title: "Too long", targetDurationSeconds: 3601 }),
  });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /between 15 and 3600/);
});
