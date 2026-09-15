const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeDailyTimes,
  getLocalTimeKey,
} = require("../src/daemon-controller");

test("normalizeDailyTimes validates, pads, de-duplicates and sorts times", () => {
  assert.deepEqual(
    normalizeDailyTimes(["9:05", "21:30", "09:05", " 7:00 "]),
    ["07:00", "09:05", "21:30"]
  );
});

test("normalizeDailyTimes rejects invalid or empty schedules", () => {
  assert.throws(() => normalizeDailyTimes([]), /at least one/);
  assert.throws(() => normalizeDailyTimes(["24:00"]), /Invalid time/);
  assert.throws(() => normalizeDailyTimes(["12:99"]), /Invalid time/);
});

test("getLocalTimeKey formats a date in the requested timezone", () => {
  const date = new Date("2026-06-03T10:15:00.000Z");
  assert.equal(getLocalTimeKey(date, "Europe/Berlin"), "12:15");
  assert.equal(getLocalTimeKey(date, "UTC"), "10:15");
});
