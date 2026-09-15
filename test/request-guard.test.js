const test = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedDashboardRequest } = require("../src/request-guard");

const local = { host: "localhost:3028" };

test("dashboard request guard allows safe localhost methods", () => {
  assert.equal(isAllowedDashboardRequest({ method: "GET", headers: local, remoteAddress: "127.0.0.1" }), true);
});

test("dashboard request guard allows same-origin mutations", () => {
  assert.equal(isAllowedDashboardRequest({
    method: "POST",
    headers: { ...local, origin: "http://localhost:3028" },
    remoteAddress: "127.0.0.1",
  }), true);
});

test("dashboard request guard blocks mutations without origin", () => {
  assert.equal(isAllowedDashboardRequest({ method: "POST", headers: local, remoteAddress: "127.0.0.1" }), false);
});

test("dashboard request guard blocks cross-origin mutations", () => {
  assert.equal(isAllowedDashboardRequest({
    method: "POST",
    headers: { ...local, origin: "https://example.com" },
    remoteAddress: "127.0.0.1",
  }), false);
});

test("dashboard request guard blocks cross-site fetch metadata", () => {
  assert.equal(isAllowedDashboardRequest({
    method: "POST",
    headers: { ...local, origin: "http://localhost:3028", "sec-fetch-site": "cross-site" },
    remoteAddress: "127.0.0.1",
  }), false);
});

test("dashboard request guard blocks unapproved hosts and remote clients", () => {
  assert.equal(isAllowedDashboardRequest({ method: "GET", headers: { host: "evil.test:3028" }, remoteAddress: "127.0.0.1" }), false);
  assert.equal(isAllowedDashboardRequest({ method: "GET", headers: local, remoteAddress: "192.168.1.10" }), false);
});
