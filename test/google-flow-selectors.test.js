const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  PROMPT_INPUT_SELECTORS,
  SUBMIT_BUTTON_SELECTORS,
  VIDEO_SETTINGS_SELECTORS,
  VIDEO_OPTION_SELECTORS,
  PORTRAIT_ASPECT_SELECTORS,
  assertNineSixteenDimensions,
  validateDownloadedVideo,
} = require("../src/google-flow");

test("Google Flow selectors support the current Slate editor and icon submit", () => {
  assert.equal(PROMPT_INPUT_SELECTORS[0], 'div[role="textbox"][data-slate-editor="true"]');
  assert.ok(SUBMIT_BUTTON_SELECTORS.some((selector) => selector.includes("arrow_forward")));
  assert.ok(SUBMIT_BUTTON_SELECTORS.every((selector) => !selector.includes("arrow_forward_ios")));
});

test("Google Flow selectors support current classic video settings", () => {
  assert.ok(VIDEO_SETTINGS_SELECTORS.some((selector) => selector.includes("settings-trigger-button:not([hidden])")));
  assert.ok(VIDEO_SETTINGS_SELECTORS.some((selector) => selector.includes("crop_9_16")));
  assert.ok(VIDEO_OPTION_SELECTORS.some((selector) => selector.includes("-trigger-VIDEO")));
  assert.ok(VIDEO_OPTION_SELECTORS.some((selector) => selector.includes("play_circle")));
  assert.ok(VIDEO_OPTION_SELECTORS.some((selector) => selector.includes("role='radio'") && selector.includes("videocam")));
  assert.ok(PORTRAIT_ASPECT_SELECTORS.some((selector) => selector.includes("-trigger-PORTRAIT")));
  assert.ok(PORTRAIT_ASPECT_SELECTORS.some((selector) => selector.includes("crop_9_16")));
});

test("Flow output validation accepts 9:16 and rejects horizontal video", () => {
  assert.deepEqual(assertNineSixteenDimensions({ width: 720, height: 1280 }), {
    width: 720,
    height: 1280,
    ratio: 0.5625,
  });
  assert.doesNotThrow(() => assertNineSixteenDimensions({ width: 1080, height: 1920 }));
  assert.throws(() => assertNineSixteenDimensions({ width: 768, height: 1376 }), /not 9:16 portrait/);
  assert.throws(() => assertNineSixteenDimensions({ width: 714, height: 1260 }), /not 9:16 portrait/);
  assert.throws(() => assertNineSixteenDimensions({ width: 1920, height: 1080 }), /not 9:16 portrait/);
  assert.throws(() => assertNineSixteenDimensions({ width: 720, height: 1200 }), /not 9:16 portrait/);
  assert.throws(() => assertNineSixteenDimensions({ width: 1080, height: 1080 }), /not 9:16 portrait/);
  assert.throws(() => assertNineSixteenDimensions({ width: 0, height: 0 }), /could not be verified/);
});

test("Flow never accepts an unverified downloaded video when ffprobe fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-probe-"));
  try {
    const filePath = path.join(root, "fake.mp4");
    const header = Buffer.alloc(2048);
    header.write("ftyp", 4, "ascii");
    await fs.writeFile(filePath, header);
    await assert.rejects(validateDownloadedVideo(filePath), /FFprobe/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
