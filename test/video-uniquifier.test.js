const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveUniquifyOptions,
  normalizeIntensity,
  INTENSITY_PRESETS,
} = require("../src/video-uniquifier");

test("normalizeIntensity maps aliases and defaults to suave", () => {
  assert.equal(normalizeIntensity("media"), "media");
  assert.equal(normalizeIntensity("medium"), "media");
  assert.equal(normalizeIntensity("FUERTE"), "fuerte");
  assert.equal(normalizeIntensity("strong"), "fuerte");
  assert.equal(normalizeIntensity(""), "suave");
  assert.equal(normalizeIntensity("nonsense"), "suave");
});

test("resolveUniquifyOptions picks preset values and applies overrides", () => {
  const strong = resolveUniquifyOptions({ intensity: "fuerte" });
  assert.equal(strong.cropPercent, INTENSITY_PRESETS.fuerte.cropPercent);
  assert.equal(strong.mirror, true);

  const overridden = resolveUniquifyOptions({ intensity: "suave", cropPercent: 9, mirror: true });
  assert.equal(overridden.cropPercent, 9);
  assert.equal(overridden.mirror, true);
  assert.equal(overridden.noiseStrength, INTENSITY_PRESETS.suave.noiseStrength);
});

test("timing changes are disabled and the start trim is always on", () => {
  for (const level of ["suave", "media", "fuerte"]) {
    const opts = resolveUniquifyOptions({
      intensity: level,
      speedFactor: 0.9,
      extendDuration: true,
      freezeFrames: true,
      trimSegments: false,
      removeAudio: false,
    });
    assert.equal(opts.speedFactor, undefined, "speed must be disabled");
    assert.equal(opts.extendDuration, undefined, "extendDuration must be disabled");
    assert.equal(opts.freezeFrames, false, "freeze frames must be off");
    assert.equal(opts.trimSegments, true, "start trim must always be on");
    assert.notEqual(opts.removeAudio, true, "audio must never be removed");
  }
});
