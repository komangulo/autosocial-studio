const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const overlay = require("../src/autoclone/text-overlay");
const { normalizeHandle, parseVideoUrl, writeJson, selectNextBatch, readHistory, writeHistory } = require("../src/autoclone/controller");

test("autoclone selectNextBatch continues after the already downloaded videos", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  // First run: 3 videos.
  const first = selectNextBatch(ids, [], 3);
  assert.deepEqual(first, ["a", "b", "c"]);
  // Second run: the next 3, not the same ones again.
  const second = selectNextBatch(ids, first, 3);
  assert.deepEqual(second, ["d", "e", "f"]);
  // Third run: nothing left.
  assert.deepEqual(selectNextBatch(ids, [...first, ...second], 3), []);
});

test("autoclone selectNextBatch with 0 takes every pending video", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(selectNextBatch(ids, ["a"], 0), ["b", "c", "d"]);
  assert.deepEqual(selectNextBatch(ids, [], 0), ids);
});

test("autoclone selectNextBatch keeps the order it is given", () => {
  // Newest-first listing: the next batch follows that order too.
  const newestFirst = ["f", "e", "d", "c", "b", "a"];
  assert.deepEqual(selectNextBatch(newestFirst, ["f", "e"], 2), ["d", "c"]);
});

test("autoclone history remembers downloaded ids per profile", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const original = process.env.AUTOSOCIAL_RUNTIME_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-history-"));
  try {
    // Point the history file into the temp dir by using a unique handle.
    const handle = `@agent-test-${Date.now()}`;
    await writeHistory(handle, ["1", "2", "2"]);
    const history = await readHistory(handle);
    assert.deepEqual(history.downloadedIds, ["1", "2"], "duplicates are removed");
    assert.equal(history.handle, handle);

    await writeHistory(handle, ["1", "2", "3"]);
    assert.deepEqual((await readHistory(handle)).downloadedIds, ["1", "2", "3"]);

    // An unknown profile has no memory.
    assert.deepEqual((await readHistory("@nadie-inexistente-xyz")).downloadedIds, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.AUTOSOCIAL_RUNTIME_DIR;
    else process.env.AUTOSOCIAL_RUNTIME_DIR = original;
  }
});

test("autoclone resetHistory forgets a profile's downloads", async () => {
  const { AutoCloneController } = require("../src/autoclone/controller");
  const controller = new AutoCloneController();
  const handle = `@agent-reset-${Date.now()}`;
  await writeHistory(handle, ["10", "11"]);
  assert.equal((await controller.getHistory(handle)).count, 2);
  await controller.resetHistory(handle);
  assert.equal((await controller.getHistory(handle)).count, 0);
  await assert.rejects(() => controller.resetHistory("  "), /nombre de usuario/i);
});

test("autoclone normalizeHandle accepts handles and http urls", () => {
  assert.equal(normalizeHandle("usuario"), "@usuario");
  assert.equal(normalizeHandle("@usuario"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario/video/123"), "@usuario");
  assert.equal(normalizeHandle("https://www.tiktok.com/@usuario?lang=es"), "@usuario");
  assert.equal(normalizeHandle("  "), "");
});

test("autoclone parseVideoUrl detects single-video links and rejects profiles", () => {
  const direct = parseVideoUrl("https://www.tiktok.com/@usuario/video/7412345678901234567");
  assert.ok(direct, "canonical video url is recognised");
  assert.equal(direct.username, "@usuario");
  assert.equal(direct.id, "7412345678901234567");
  assert.equal(direct.url, "https://www.tiktok.com/@usuario/video/7412345678901234567");

  // Query strings and mobile host are cleaned up.
  const withQuery = parseVideoUrl("https://m.tiktok.com/@juan/video/999?is_from_webapp=1");
  assert.equal(withQuery.id, "999");
  assert.equal(withQuery.username, "@juan");

  // Short share links are accepted (id resolved later by yt-dlp).
  assert.ok(parseVideoUrl("https://vm.tiktok.com/ZMabc123/"));
  assert.ok(parseVideoUrl("https://vt.tiktok.com/ZSxyz/"));

  // A profile url or plain handle is NOT a single video.
  assert.equal(parseVideoUrl("https://www.tiktok.com/@usuario"), null);
  assert.equal(parseVideoUrl("@usuario"), null);
  assert.equal(parseVideoUrl(""), null);
});

test("autoclone writeJson saves the final file and leaves no tmp behind", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-writejson-"));
  try {
    const target = path.join(dir, "job.json");
    await writeJson(target, { hello: "world" });
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { hello: "world" });
    await writeJson(target, { hello: "again" });
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { hello: "again" });
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autoclone buildAss hides the original text with an opaque box then draws the translation", () => {
  const ass = overlay.buildAss([
    { start: 1.2, end: 3.5, translated: "Hola mundo", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
  ], { width: 1080, height: 1920 });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(dialogues.length, 2, "one cover + one translated text");

  const cover = dialogues.find((line) => line.includes("Cover,"));
  const text = dialogues.find((line) => line.includes("Overlay,"));
  assert.ok(cover, "an opaque cover dialogue exists");
  assert.ok(cover.includes("\\p1"), "cover uses an ASS filled vector shape");
  assert.ok(cover.includes("\\c&H000000&"), "cover is black");
  assert.ok(/\bb \d/.test(cover), "cover uses bezier curves for rounded corners");
  assert.ok(cover.includes("0:00:01.20") && cover.includes("0:00:03.50"));
  assert.ok(text.includes("Hola mundo"));
  assert.ok(text.includes("0:00:01.20") && text.includes("0:00:03.50"));
});

test("autoclone buildAss never covers more than a sensible share of the frame", () => {
  // An oversized detected box must still be capped so the video stays visible.
  const ass = overlay.buildAss([
    { start: 0, end: 2, translated: "Texto", x: 0, y: 0, w: 1, h: 1 },
  ], { width: 1000, height: 1000 });
  const cover = ass.split("\n").find((line) => line.includes("Cover,"));
  const coords = [...cover.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  // The drawing path coordinates are all within the style block; the rectangle
  // should not span the full 1000x1000 frame.
  const maxCoord = Math.max(...coords);
  assert.ok(maxCoord <= 950, `cover should stay within caps, got max ${maxCoord}`);
});

test("autoclone text measurement wraps on real glyph widths, not a flat average", () => {
  // The proportional widths matter: "III" is far narrower than "WWW".
  assert.ok(overlay.measureEm("III") < overlay.measureEm("WWW"));
  assert.ok(overlay.measureEm("") === 0);

  const wrap = overlay.wrapText("Cuando tu talla de guante es XXL+", 47, 420);
  assert.ok(wrap.lines.length >= 2, "a long phrase wraps into at least two lines");
  assert.ok(wrap.width <= 420, "the widest rendered line fits the available width");
  assert.ok(wrap.lines.every((line) => !line.startsWith(" ") && !line.endsWith(" ")));
});

test("autoclone buildAss fits the cover to the rendered text so there is little dead black", () => {
  const width = 576;
  const height = 1024;
  // A vision box far wider than the phrase it actually, imprecisely detected.
  const ass = overlay.buildAss([
    { start: 0, end: 3, translated: "Increible", x: 0.25, y: 0.65, w: 0.45, h: 0.06 },
  ], { width, height });
  const cover = ass.split("\n").find((line) => line.includes(",Cover,"));
  // Coordinates of the vector shape start after the black-colour override.
  const path = cover.slice(cover.indexOf("&}")).replace(/[{}]/g, "");
  const xs = [...path.matchAll(/(-?\d+) (-?\d+)/g)].map((m) => Number(m[1]));
  const ys = [...path.matchAll(/(-?\d+) (-?\d+)/g)].map((m) => Number(m[2]));
  const coverW = Math.max(...xs);
  const coverH = Math.max(...ys);
  const rawW = 0.45 * width;
  const rawH = 0.06 * height;

  // The cover hugs the text: it is not much wider than the detected box would
  // imply once the real glyph widths are measured, and stays a small slice.
  assert.ok(coverW < rawW * 1.3, `cover ${coverW} should not balloon past the text`);
  assert.ok(coverH < rawH * 3, `cover ${coverH} should stay close to one text line`);
  assert.ok((coverW * coverH) / (width * height) < 0.06, "a short phrase covers a tiny share of the frame");
});

test("autoclone buildAss still hides the whole original box while keeping the black low", () => {
  const width = 576;
  const height = 1024;
  for (const box of [
    { start: 0, end: 3, translated: "Cuando tu talla de guante es XXL+", x: 0.06, y: 0.55, w: 0.88, h: 0.14 },
    { start: 0, end: 3, translated: "No puede ser real", x: 0.2, y: 0.6, w: 0.55, h: 0.08 },
    { start: 0, end: 3, translated: "Increible", x: 0.25, y: 0.65, w: 0.45, h: 0.06 },
  ]) {
    const ass = overlay.buildAss([box], { width, height });
    const cover = ass.split("\n").find((line) => line.includes(",Cover,"));
    const pos = cover.match(/pos\((-?\d+),(-?\d+)\)/);
    const path = cover.slice(cover.indexOf("&}")).replace(/[{}]/g, "");
    const pts = [...path.matchAll(/(-?\d+) (-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const left = Number(pos[1]);
    const top = Number(pos[2]);
    const coverW = Math.max(...pts.map((p) => p[0]));
    const coverH = Math.max(...pts.map((p) => p[1]));

    const origLeft = box.x * width;
    const origRight = (box.x + box.w) * width;
    const origTop = box.y * height;
    const origBottom = (box.y + box.h) * height;

    assert.ok(left <= origLeft + 1, "cover reaches the left edge of the original text");
    assert.ok(left + coverW >= origRight - 1, "cover reaches the right edge of the original text");
    assert.ok(top <= origTop + 1, "cover reaches the top of the original text");
    assert.ok(top + coverH >= origBottom - 1, "cover reaches the bottom of the original text");

    // And the black stays well under a third of the frame.
    assert.ok((coverW * coverH) / (width * height) < 0.30, "cover stays a small slice of the frame");
  }
});

test("autoclone cover is anchored on the original text and no taller than it", () => {
  const width = 576;
  const height = 1024;
  for (const box of [
    { start: 0, end: 3, translated: "Cuando tu talla de guante es XXL+", x: 0.06, y: 0.55, w: 0.88, h: 0.14 },
    { start: 0, end: 3, translated: "No puede ser real", x: 0.2, y: 0.6, w: 0.55, h: 0.08 },
    { start: 0, end: 3, translated: "Increible", x: 0.25, y: 0.65, w: 0.45, h: 0.06 },
  ]) {
    const ass = overlay.buildAss([box], { width, height });
    const cover = ass.split("\n").find((line) => line.includes(",Cover,"));
    const pos = cover.match(/pos\((-?\d+),(-?\d+)\)/);
    const path = cover.slice(cover.indexOf("&}")).replace(/[{}]/g, "");
    const pts = [...path.matchAll(/(-?\d+) (-?\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const left = Number(pos[1]);
    const top = Number(pos[2]);
    const coverW = Math.max(...pts.map((p) => p[0]));
    const coverH = Math.max(...pts.map((p) => p[1]));

    const origH = box.h * height;
    // The box is aligned depth-wise with the original text, not floating above
    // or below it, and never taller than the text it hides.
    assert.ok(coverH >= Math.round(origH) - 1, "cover reaches the bottom of the original text");
    // It may grow a little when a single line needs the room, but stays close.
    assert.ok(coverH <= Math.round(origH) * 1.3 + 2, `cover height ${coverH} should stay close to the original ${Math.round(origH)}`);
    const origCenterY = box.y * height + origH / 2;
    assert.ok(Math.abs((top + coverH / 2) - origCenterY) <= 2, "cover is vertically centred on the original text");
  }
});

test("autoclone karaoke splits a phrase into words and times them by length", () => {
  assert.deepEqual(overlay.karaokeWords("  "), []);
  assert.deepEqual(overlay.karaokeWords("... !!!"), [], "punctuation-only tokens get no beat");

  // A 3s block split across three similar words: near-equal beats, exact total.
  const timings = overlay.karaokeTimings(["Hola", "mundo", "grande"], 3);
  assert.equal(timings.length, 3);
  assert.equal(timings.reduce((a, b) => a + b, 0), 300, "the beats add up to the block duration");
  assert.ok(timings.every((value) => value >= 1), "no word gets a zero-length beat");
});

test("autoclone buildKaraokeAss replaces the black box with yellow word-by-word text", () => {
  const ass = overlay.buildKaraokeAss([
    { start: 1, end: 4, original: "Hello world", translated: "Hola mundo grande", x: 0.1, y: 0.7, w: 0.8, h: 0.1 },
  ], { width: 1080, height: 1920, duration: 10 });

  const dialogues = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  assert.equal(dialogues.length, 2, "one solid cover plus one karaoke line");

  const cover = dialogues.find((line) => line.includes("Cover,"));
  assert.ok(cover.includes("\\p1"), "cover is a filled vector shape");
  assert.ok(cover.includes("\\c&H000000&"), "cover is solid black");

  const karaoke = dialogues.find((line) => line.includes("Karaoke,"));
  assert.ok(karaoke, "a karaoke dialogue exists");
  assert.equal((karaoke.match(/\\k\d+/g) || []).length, 3, "one beat per word");
  assert.ok(karaoke.includes("Hola") && karaoke.includes("mundo") && karaoke.includes("grande"));
  assert.ok(/\{\\k\d+\}Hola/.test(karaoke), "the first word starts a karaoke beat");
  assert.ok(karaoke.includes("\\kf"), "the sweep is smooth");
  assert.ok(karaoke.includes("\\fs"), "the font size was computed to fit the box");
});

test("autoclone buildKaraokeAss keeps the box in the original text position", () => {
  const boxes = [
    { start: 0, end: 2, original: "Top", translated: "Arriba", x: 0.1, y: 0.1, w: 0.3, h: 0.08 },
    { start: 3, end: 5, original: "Bottom", translated: "Abajo", x: 0.2, y: 0.8, w: 0.4, h: 0.1 },
  ];
  const ass = overlay.buildKaraokeAss(boxes, { width: 1000, height: 1000, duration: 8 });
  const posLines = [...ass.matchAll(/\\pos\((\d+),(\d+)\)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  // Two covers + two karaoke lines, and the second block sits far below the first.
  const yValues = posLines.map((p) => p.y);
  assert.ok(Math.max(...yValues) - Math.min(...yValues) > 400, "each block keeps its own position");
  for (const y of yValues) assert.ok(y >= 0 && y <= 1000, "positions stay inside the frame");
});

test("autoclone dedupeBoxes merges the same phrase across adjacent frames", () => {
  const merged = overlay.dedupeBoxes([
    { start: 0, end: 1, original: "a", translated: "a", x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    { start: 1.1, end: 2, original: "a", translated: "a", x: 0.2, y: 0.2, w: 0.2, h: 0.1 },
    { start: 5, end: 6, original: "b", translated: "b", x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end, 2);
});

test("autoclone parseJson tolerates markdown fences", () => {
  const parsed = overlay.parseJson('```json\n[{"translated":"hola"}]\n```');
  assert.equal(parsed[0].translated, "hola");
});


const { spawnSync } = require("child_process");
const hasFfmpeg = (() => {
  try { return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; }
})();
const visionTest = hasFfmpeg ? test : test.skip;

visionTest("autoclone detectAndTranslate parses translated boxes from the vision model", async () => {
  const os = require("os");
  const path = require("path");
  const originalFetch = global.fetch;
  const payload = [{
    start: 0, end: 1.2,
    original: "Hello world",
    translated: "Hola mundo",
    x: 0.1, y: 0.7, w: 0.8, h: 0.1,
    confidence: 0.9,
  }];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
  });
  const workDir = require("fs").mkdtempSync(path.join(os.tmpdir(), "ac-vision-"));
  try {
    const result = await overlay.detectAndTranslate(
      path.resolve(__dirname, "fixtures", "tiny.mp4"),
      { apiKey: "test-key", workDir },
    );
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].translated, "Hola mundo");
    assert.equal(result.errors.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

visionTest("autoclone detectAndTranslate classifies an invalid key", async () => {
  const os = require("os");
  const path = require("path");
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "API key not valid. Please pass a valid API key." } }),
  });
  const workDir = require("fs").mkdtempSync(path.join(os.tmpdir(), "ac-badkey-"));
  try {
    const result = await overlay.detectAndTranslate(
      path.resolve(__dirname, "fixtures", "tiny.mp4"),
      { apiKey: "bad", workDir },
    );
    assert.equal(result.boxes.length, 0);
    assert.ok(result.errors.length >= 1);
    assert.match(result.errors[0], /API key/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("autoclone places finished videos in a per-user folder under the destination", async () => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const { AutoCloneController } = require("../src/autoclone/controller");
  const controller = new AutoCloneController();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "ac-dest-"));
  const job = { handle: "@Jay_Andrews69", options: { destinationRoot: dest } };
  assert.equal(controller._userDir(job), path.join(dest, "Jay_Andrews69"));
  const job2 = { handle: "@otro", options: { destinationRoot: "" } };
  assert.ok(controller._userDir(job2).endsWith(path.join("jobs", "", "outputs")) || /outputs$/.test(controller._userDir(job2)));
  const check = await controller.checkDestination(dest, "@Jay_Andrews69");
  assert.equal(check.valid, true);
  assert.equal(check.perUser, path.join(dest, "Jay_Andrews69"));
});

test("autoclone preserves thumbnail sidecars and download order metadata", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const { getMetaPath, getSidecarPaths, findThumbnailPath, readVideoMeta } = require("../src/queue");
  const { AutoCloneController } = require("../src/autoclone/controller");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-thumbnail-"));
  try {
    const source = path.join(dir, "source.mp4");
    const output = path.join(dir, "output.mp4");
    await fs.writeFile(source, Buffer.alloc(8));
    await fs.writeFile(output, Buffer.alloc(8));
    await fs.writeFile(path.join(dir, "source.webp"), Buffer.from("cover"));
    await fs.writeFile(getMetaPath(source), JSON.stringify({ title: "Video", downloadIndex: 3 }));

    assert.equal(await findThumbnailPath(source), path.join(dir, "source.webp"));
    assert.equal((await readVideoMeta(source)).downloadIndex, 3);
    assert.ok(getSidecarPaths(source).includes(path.join(dir, "source.webp")));

    await AutoCloneController.prototype._copyThumbnailSidecar.call({}, source, output);
    assert.equal(await fs.readFile(path.join(dir, "output.webp"), "utf8"), "cover");

    await fs.writeFile(path.join(dir, "output.jpg"), Buffer.from("old-cover"));
    await fs.rm(path.join(dir, "source.webp"));
    await AutoCloneController.prototype._copyThumbnailSidecar.call({}, source, output);
    await assert.rejects(() => fs.access(path.join(dir, "output.jpg")));
    await assert.rejects(() => fs.access(path.join(dir, "output.webp")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost listVideos follows Auto Clone downloadIndex order", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const sched = require("../src/autoclone/scheduler");
  const { getMetaPath } = require("../src/queue");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-order-"));
  try {
    const older = path.join(dir, "z-video.mp4");
    const newer = path.join(dir, "a-video.mp4");
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), older);
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), newer);
    await fs.writeFile(getMetaPath(older), JSON.stringify({ downloadIndex: 0 }));
    await fs.writeFile(getMetaPath(newer), JSON.stringify({ downloadIndex: 1 }));

    assert.deepEqual(await sched.listVideos(dir), [older, newer]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost nextSlots honors selected weekdays and times", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  // Monday 2026-09-14 09:00 UTC. Ask for Mon+Wed at 10:00 and 20:00.
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon", "wed"], times: ["10:00", "20:00"], timezone: "UTC", count: 4, now });
  assert.equal(slots.length, 4);
  assert.equal(slots[0].local, "2026-09-14 10:00");
  assert.equal(slots[1].local, "2026-09-14 20:00");
  assert.equal(slots[2].local, "2026-09-16 10:00");
  assert.equal(slots[3].local, "2026-09-16 20:00");
});

test("autopost nextSlots keeps a 15-minute TikTok lead time", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  // 09:55 and the only time is 10:00 -> too close, must roll to next week.
  const now = DateTime.fromISO("2026-09-14T09:55:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon"], times: ["10:00"], timezone: "UTC", count: 1, now });
  assert.equal(slots[0].local, "2026-09-21 10:00");
});

test("autopost nextSlots skips days that are not selected", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["fri"], times: ["12:00"], timezone: "UTC", count: 2, now });
  assert.equal(slots[0].local, "2026-09-18 12:00");
  assert.equal(slots[1].local, "2026-09-25 12:00");
});

test("autopost buildPlan maps one video per slot in order", () => {
  const sched = require("../src/autoclone/scheduler");
  const { DateTime } = require("luxon");
  const now = DateTime.fromISO("2026-09-14T09:00:00", { zone: "UTC" });
  const slots = sched.nextSlots({ days: ["mon"], times: ["10:00"], timezone: "UTC", count: 3, now });
  const plan = sched.buildPlan(["/v/a.mp4", "/v/b.mp4", "/v/c.mp4"], slots);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].videoName, "a.mp4");
  assert.equal(plan[2].videoName, "c.mp4");
});

test("tiktok schedule date/time use the Web Studio format", () => {
  const { _private } = require("../src/tiktok-uploader");
  const date = new Date(2026, 8, 12, 20, 5);
  assert.equal(_private.formatScheduleDate(date), "2026-09-12");
  assert.equal(_private.formatScheduleTime(date), "20:05");
});

test("tiktok schedule date/time honor the target timezone", () => {
  const { _private } = require("../src/tiktok-uploader");
  // 08:00 UTC is 10:00 in Madrid; near midnight it also changes the day.
  const morning = new Date("2026-09-15T08:00:00Z");
  assert.equal(_private.formatScheduleTime(morning, "Europe/Madrid"), "10:00");
  const nearMidnight = new Date("2026-09-15T23:30:00Z");
  assert.equal(_private.formatScheduleDate(nearMidnight, "Europe/Madrid"), "2026-09-16");
});

test("tiktok splitTime separates hours and minutes", () => {
  const { _private } = require("../src/tiktok-uploader");
  assert.deepEqual(_private.splitTime("10:05"), { hour: "10", minute: "05" });
  assert.deepEqual(_private.splitTime("9:5"), null);
  assert.equal(_private.splitTime(""), null);
});

test("autopost scheduleFolder runs now but schedules natively for the slot", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-native-"));
  for (const name of ["a.mp4", "b.mp4"]) {
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, name));
  }
  const result = await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    worker,
  });
  assert.equal(result.created.length, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const scheduledAt = new Date(call.scheduledAt).getTime();
    assert.ok(Math.abs(Date.now() - scheduledAt) < 60_000, "job must be due immediately");
    assert.ok(call.nativeScheduledAt, "native TikTok date must be present");
    assert.match(call.sourceFingerprint?.sha256 || "", /^[a-f0-9]{64}$/, "the queued job must identify the exact source bytes");
    assert.notEqual(new Date(call.nativeScheduledAt).getTime(), scheduledAt);
  }
  assert.notEqual(
    new Date(calls[0].nativeScheduledAt).getTime(),
    new Date(calls[1].nativeScheduledAt).getTime(),
    "each video must get a different native date"
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("autopost normalizeHashtags accepts array or string and strips #", () => {
  const sched = require("../src/autoclone/scheduler");
  assert.deepEqual(sched.normalizeHashtags(["#viral", "parati", "#madrid"]), ["viral", "parati", "madrid"]);
  assert.deepEqual(sched.normalizeHashtags("viral, #parati  madrid"), ["viral", "parati", "madrid"]);
  assert.deepEqual(sched.normalizeHashtags(["Viral", "#viral", "VIRAL"]), ["Viral"]);
  assert.deepEqual(sched.normalizeHashtags(""), []);
  assert.deepEqual(sched.normalizeHashtags(undefined), []);
});

test("autopost appendHashtags adds missing tags and avoids duplicates", () => {
  const sched = require("../src/autoclone/scheduler");
  assert.equal(sched.appendHashtags("Mira esto", ["viral", "madrid"]), "Mira esto #viral #madrid");
  assert.equal(sched.appendHashtags("", ["viral"]), "#viral");
  assert.equal(sched.appendHashtags("Ya va #viral", ["#viral", "madrid"]), "Ya va #viral #madrid");
  assert.equal(sched.appendHashtags("Sin tags", []), "Sin tags");
});

test("autopost scheduleFolder passes hashtags in the caption and location to the job", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-hashtags-"));
  await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, "a.mp4"));
  const result = await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    captionTemplate: "Hola {usuario}",
    hashtags: ["viral", "#parati"],
    location: "Madrid, Spain",
    worker,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].location, "Madrid, Spain");
  assert.ok(calls[0].caption.includes("#viral"));
  assert.ok(calls[0].caption.includes("#parati"));
  assert.equal(result.location, "Madrid, Spain");
  assert.deepEqual(result.hashtags, ["viral", "parati"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("autopost uses each video's own title/description/hashtags plus dashboard hashtags", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const { getMetaPath } = require("../src/queue");
  const calls = [];
  const worker = {
    async createReservedTikTokJob(input) {
      calls.push(input);
      return { id: `job-${calls.length}` };
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-meta-"));
  const video = path.join(dir, "clip.mp4");
  await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), video);
  await fs.writeFile(
    getMetaPath(video),
    JSON.stringify({
      title: "Mi titulo original",
      description: "Descripcion del video #propio",
      hashtags: ["propio"],
    })
  );
  await sched.scheduleFolder({
    accountId: "acct-1",
    folder: dir,
    days: ["mon"],
    times: ["10:00"],
    timezone: "UTC",
    captionTemplate: "Plantilla que no debe usarse {video}",
    hashtags: ["dashboard"],
    worker,
  });
  assert.equal(calls.length, 1);
  const caption = calls[0].caption;
  assert.ok(caption.includes("Mi titulo original"), "uses the video title");
  assert.ok(caption.includes("Descripcion del video"), "uses the video description");
  assert.ok(caption.includes("#propio"), "keeps the video's own hashtag");
  assert.ok(caption.includes("#dashboard"), "adds the dashboard hashtag");
  assert.ok(!caption.includes("Plantilla que no debe usarse"), "does not fall back to the template");
  await fs.rm(dir, { recursive: true, force: true });
});

test("autoclone _copyMetaSidecar always creates a .meta.json for the final video", async () => {
  const os = require("os");
  const fs = require("fs/promises");
  const { AutoCloneController } = require("../src/autoclone/controller");
  const { getMetaPath } = require("../src/queue");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ac-metasidecar-"));
  const call = (src, dst) => AutoCloneController.prototype._copyMetaSidecar.call({}, src, dst);
  try {
    // 1) Source already has a companion: it is copied as-is.
    const src1 = path.join(dir, "with-meta.mp4");
    const dst1 = path.join(dir, "out1.mp4");
    await fs.writeFile(src1, Buffer.alloc(8));
    await fs.writeFile(dst1, Buffer.alloc(8));
    await fs.writeFile(getMetaPath(src1), JSON.stringify({ title: "T", description: "D", hashtags: ["x"] }));
    await call(src1, dst1);
    const copied = JSON.parse(await fs.readFile(getMetaPath(dst1), "utf8"));
    assert.equal(copied.title, "T");

    // 2) No metadata anywhere: an (empty but present) companion is still created.
    const src2 = path.join(dir, "bare.mp4");
    const dst2 = path.join(dir, "out2.mp4");
    await fs.writeFile(src2, Buffer.alloc(8));
    await fs.writeFile(dst2, Buffer.alloc(8));
    await call(src2, dst2);
    const fallback = JSON.parse(await fs.readFile(getMetaPath(dst2), "utf8"));
    assert.deepEqual(fallback.hashtags, []);

    // 3) Only an info.json exists: the companion is built from it.
    const src3 = path.join(dir, "frominfo.mp4");
    const dst3 = path.join(dir, "out3.mp4");
    await fs.writeFile(src3, Buffer.alloc(8));
    await fs.writeFile(dst3, Buffer.alloc(8));
    await fs.writeFile(
      path.join(dir, "frominfo.info.json"),
      JSON.stringify({ title: "Info title", description: "Info desc #tag", tags: ["tag"] })
    );
    await call(src3, dst3);
    const built = JSON.parse(await fs.readFile(getMetaPath(dst3), "utf8"));
    assert.equal(built.title, "Info title");
    assert.deepEqual(built.hashtags, ["tag"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost scheduleFolder moves uploaded videos to a 'posted' folder so they are not sent twice", async () => {
  const sched = require("../src/autoclone/scheduler");
  const os = require("os");
  const fs = require("fs/promises");
  const worker = { async createReservedTikTokJob() { return { id: "job-1" }; } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autopost-sent-"));
  try {
    await fs.copyFile(path.join(__dirname, "fixtures", "tiny.mp4"), path.join(dir, "a.mp4"));
    await fs.writeFile(path.join(dir, "a.jpg"), Buffer.from("cover"));
    const result = await sched.scheduleFolder({
      accountId: "acct-1",
      folder: dir,
      days: ["mon"],
      times: ["10:00"],
      timezone: "UTC",
      worker,
    });
    assert.equal(result.created.length, 1);
    const remaining = (await fs.readdir(dir)).filter((n) => n.endsWith(".mp4"));
    assert.deepEqual(remaining, [], "the active folder no longer holds the video");
    const sent = await fs.readdir(path.join(dir, "posted"));
    assert.ok(sent.includes("a.mp4"), "the video is kept in posted");
    assert.ok(sent.includes("a.jpg"), "the cover is kept with the posted video");
    // A second run finds nothing new, so it cannot upload it again.
    await assert.rejects(
      () => sched.scheduleFolder({ accountId: "acct-1", folder: dir, days: ["mon"], times: ["10:00"], timezone: "UTC", worker }),
      /No hay videos/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("autopost puts 'posted' at the job level when the folder is an Auto Clone 'outputs' dir", () => {
  const sched = require("../src/autoclone/scheduler");
  const path = require("path");
  const jobDir = path.join("/tmp", "autoclone", "jobs", "kimwilliamm-123");
  const outputs = path.join(jobDir, "outputs");
  assert.equal(sched.resolvePostedDir(outputs), path.join(jobDir, "posted"));
  // Any other folder keeps "posted" inside it.
  const custom = path.join("/tmp", "videos", "kimwilliamm");
  assert.equal(sched.resolvePostedDir(custom), path.join(custom, "posted"));
});
