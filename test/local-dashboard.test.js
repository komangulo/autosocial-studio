const test = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("../src/config");

test("dashboard address is fixed to localhost port 3028", () => {
  assert.equal(config.dashboardHost, "127.0.0.1");
  assert.equal(config.dashboardPort, 3028);
  assert.equal(Object.prototype.hasOwnProperty.call(config, "dashboardAllowRemote"), false);
});
