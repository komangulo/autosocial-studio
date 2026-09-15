const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

test("dashboard uses local scripts, fonts, and icons", () => {
  const html = fs.readFileSync(path.join(projectRoot, "web", "index.html"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+https?:\/\//i);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|unpkg\.com/i);
  assert.match(html, /vendor\/phosphor\/style\.css/);
  assert.match(html, /studio-assets\/studio\.js/);
});

test("both account selectors notify Studio after confirmed changes", () => {
  const app = fs.readFileSync(path.join(projectRoot, "web", "app.js"), "utf8");
  assert.equal((app.match(/autosocial:accountchange/g) || []).length, 2);
});

test("dashboard sends a restrictive content security policy", () => {
  const server = fs.readFileSync(path.join(projectRoot, "src", "dashboard-server.js"), "utf8");
  assert.match(server, /Content-Security-Policy/);
  assert.match(server, /script-src 'self'/);
  assert.match(server, /object-src 'none'/);
  assert.match(server, /frame-ancestors 'none'/);
});

test("long-form runtime is ignored and UI artifacts are distributable", () => {
  const ignored = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
  assert.match(ignored, /^\.runtime\/$/m);
  assert.doesNotMatch(ignored, /^web\/studio-assets\/$/m);
  assert.ok(fs.existsSync(path.join(projectRoot, "web", "studio-assets", "studio.js")));
  assert.ok(fs.existsSync(path.join(projectRoot, "web", "studio-assets", "studio.css")));
});
