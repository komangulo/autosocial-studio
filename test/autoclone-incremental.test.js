const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePlaylistEntries,
  sortPlaylistEntries,
  entryIsNewerThanMarker,
  readPublicationState,
  writePublicationState,
  AutoCloneController,
} = require("../src/autoclone/controller");

test("autoclone incremental listing uses exact timestamps and oldest-first batches", () => {
  const entries = parsePlaylistEntries([
    "new\t1760000000\t20251009",
    "marker\t1759000000\t20250927",
    "old\t1758000000\t20250915",
  ].join("\n"));
  const marker = entries.find((entry) => entry.id === "marker");
  const newer = entries.filter((entry) => entryIsNewerThanMarker(entry, marker, true));

  assert.deepEqual(newer.map((entry) => entry.id), ["new"]);
  assert.deepEqual(sortPlaylistEntries(newer, "oldest").map((entry) => entry.id), ["new"]);
});

test("autoclone incremental ordering resolves same-day videos by timestamp", () => {
  const entries = parsePlaylistEntries([
    "later\t1760003600\t20251009",
    "earlier\t1760000000\t20251009",
  ].join("\n"));
  assert.deepEqual(sortPlaylistEntries(entries, "oldest").map((entry) => entry.id), ["earlier", "later"]);
});

test("autoclone includes a video listed before the marker when timestamps tie", () => {
  const entries = parsePlaylistEntries([
    "newer-same-second\t1760000000\t20251009",
    "marker\t1760000000\t20251009",
    "older-same-second\t1760000000\t20251009",
  ].join("\n"));
  const marker = entries.find((entry) => entry.id === "marker");
  assert.deepEqual(
    entries.filter((entry) => entryIsNewerThanMarker(entry, marker, true)).map((entry) => entry.id),
    ["newer-same-second"],
  );
});

test("autoclone uses the TikTok video id timestamp when playlist dates are missing", () => {
  const entries = parsePlaylistEntries([
    "7547724166770953474\tNA\tNA",
    "7568937929926577430\tNA\tNA",
    "7568613929308441878\tNA\tNA",
  ].join("\n"));
  const marker = entries.find((entry) => entry.id === "7568613929308441878");
  assert.deepEqual(
    entries.filter((entry) => entryIsNewerThanMarker(entry, marker, true)).map((entry) => entry.id),
    ["7568937929926577430"],
  );
});

test("autoclone marker fallback excludes the marker and uses profile order without timestamps", () => {
  const entries = parsePlaylistEntries([
    "new\tNA\tNA",
    "marker\tNA\tNA",
    "old\tNA\tNA",
  ].join("\n"));
  const marker = entries.find((entry) => entry.id === "marker");
  assert.deepEqual(
    entries.filter((entry) => entryIsNewerThanMarker(entry, marker, true)).map((entry) => entry.id),
    ["new"],
  );
});

test("autoclone publication state advances only to the successful video", async () => {
  const handle = `@agent-publication-${Date.now()}`;
  try {
    await writePublicationState(handle, {
      baseMarkerId: "base",
      baseMarkerUrl: "https://www.tiktok.com/@source/video/base",
      lastPublishedId: "first-success",
      lastPublishedUrl: "https://www.tiktok.com/@source/video/first-success",
      lastPublishedTimestamp: 1760000000,
      failedIds: ["failed-video"],
    });
    const state = await readPublicationState(handle);
    assert.equal(state.lastPublishedId, "first-success");
    assert.deepEqual(state.failedIds, ["failed-video"]);

    const controller = new AutoCloneController();
    await controller.resetHistory(handle);
    assert.equal((await readPublicationState(handle)).lastPublishedId, "");
  } finally {
    // resetHistory removes both download and publication memory for this test profile.
    const controller = new AutoCloneController();
    await controller.resetHistory(handle).catch(() => {});
  }
});
