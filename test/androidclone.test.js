const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const express = require("express");

const store = require("../src/androidclone/store");
const scaffold = require("../src/androidclone/scaffold");
const { createAndroidCloneRouter } = require("../src/androidclone");

async function startFixture() {
  const app = express();
  app.use(express.json());
  app.use("/api/androidclone", createAndroidCloneRouter(express));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/api/androidclone` };
}

test("androidclone router is exported and mounts its health endpoint", async () => {
  const fixture = await startFixture();
  try {
    const res = await fetch(`${fixture.baseUrl}/health`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.ok(data.vision && data.vision.provider);
    assert.equal(Object.prototype.hasOwnProperty.call(data, "providerKeys"), true);
  } finally {
    fixture.server.close();
  }
});

test("androidclone settings never return raw provider keys", async () => {
  const settings = await store.readSettings();
  const publicView = store.publicSettings({ ...settings, providerKeys: { gemini: "AIzaSecret1234567890" } });
  assert.deepEqual(publicView.providerKeys.gemini, {
    configured: true,
    masked: "AIza******7890",
  });
  assert.equal(JSON.stringify(publicView).includes("Secret"), false);
});

test("androidclone safeId produces filesystem-safe project identifiers", () => {
  assert.equal(store.safeId("My App / Demo?"), "My-App-Demo");
  assert.match(store.safeId(""), /^project-[a-z0-9]+$/);
});

test("androidclone scaffold writes a compilable Kotlin baseline", async () => {
  const id = `androidclone-test-${Date.now()}`;
  const dir = store.projectDir(id);
  await fs.mkdir(dir, { recursive: true });
  const plan = {
    appName: "Demo App",
    packageName: "com.example.demo",
    summary: "A demo.",
    screens: [
      { id: "home", title: "Home", composable: "HomeScreen", description: "Start screen", components: ["Play"] },
      { id: "play", title: "Play", composable: "PlayScreen", description: "Game screen", components: [] },
    ],
  };
  await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(plan), "utf8");
  const project = { id, name: "Demo", activePhase: 4 };
  await store.saveProject(project);
  try {
    const result = await scaffold.scaffold(project);
    assert.equal(result.screens, 2);
    const files = [
      "android/settings.gradle.kts",
      "android/build.gradle.kts",
      "android/app/build.gradle.kts",
      "android/app/src/main/AndroidManifest.xml",
      "android/app/src/main/java/com/example/demo/MainActivity.kt",
      "android/app/src/main/java/com/example/demo/AppNavigation.kt",
      "android/app/src/main/java/com/example/demo/screens/HomeScreen.kt",
    ];
    for (const file of files) {
      const content = await fs.readFile(path.join(dir, file), "utf8");
      assert.ok(content.length > 0, `${file} should not be empty`);
    }
    const manifest = await fs.readFile(path.join(dir, "android/app/src/main/AndroidManifest.xml"), "utf8");
    assert.ok(manifest.includes("com.example.demo.MainActivity"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("androidclone rejects path traversal on artifact reads", async () => {
  const controller = require("../src/androidclone/controller").getAndroidCloneController();
  await assert.rejects(() => controller.readProjectArtifact("does-not-exist", "../../../etc/passwd"));
});

test("androidclone recognizes direct media URLs such as adscan.ai", () => {
  const { isDirectMediaUrl } = require("../src/androidclone/phases");
  assert.equal(isDirectMediaUrl("https://files.adscan.ai/109847608702429/737849678913948-4.mp4"), true);
  assert.equal(isDirectMediaUrl("https://files.adscan.ai/x/clip.mp4?token=abc"), true);
  assert.equal(isDirectMediaUrl("https://cdn.example.com/a.webm"), true);
  assert.equal(isDirectMediaUrl("https://www.tiktok.com/@user/video/123"), false);
  assert.equal(isDirectMediaUrl("https://www.instagram.com/reel/abc/"), false);
  assert.equal(isDirectMediaUrl("not a url"), false);
});
