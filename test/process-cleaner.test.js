const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const cleaner = require("../src/process-cleaner");

test("process-cleaner exposes the media process helpers", () => {
  assert.equal(typeof cleaner.findMediaProcesses, "function");
  assert.equal(typeof cleaner.killMediaProcesses, "function");
  assert.equal(typeof cleaner.killPid, "function");
});

test("process-cleaner finds media processes without throwing", async () => {
  const found = await cleaner.findMediaProcesses();
  assert.ok(Array.isArray(found));
  for (const proc of found) {
    assert.ok(Number.isInteger(proc.pid) && proc.pid > 0);
    assert.equal(typeof proc.name, "string");
  }
});

test("process-cleaner killPid rejects invalid pids", async () => {
  assert.equal(await cleaner.killPid(0), false);
  assert.equal(await cleaner.killPid(-5), false);
  assert.equal(await cleaner.killPid("x"), false);
});

test("process-cleaner cleanup returns killed and failed arrays", async () => {
  const result = await cleaner.killMediaProcesses();
  assert.ok(Array.isArray(result.killed));
  assert.ok(Array.isArray(result.failed));
});
