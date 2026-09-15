const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../src/tiktok-uploader");

const { getPublishCandidateScore, isLikelyPublishCandidateInfo } = _private;

test("TikTok publish candidate rejects the Studio sidebar Posts item", () => {
  const candidate = {
    disabled: false,
    inNavigation: true,
    rect: { left: 48, top: 300, width: 120, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate accepts the main upload Post button", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 900, right: 1060, top: 780, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});

test("TikTok publish candidate rejects ambiguous left-side Post controls", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 200, top: 320, width: 120, height: 36 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), false);
});

test("TikTok publish candidate allows Post controls in the main content area", () => {
  const candidate = {
    disabled: false,
    inNavigation: false,
    rect: { left: 300, right: 460, top: 760, width: 160, height: 44 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 900,
    viewportWidth: 1200,
  };

  assert.equal(isLikelyPublishCandidateInfo(candidate), true);
});

test("TikTok publish candidate scores bottom Post button above sidebar Posts", () => {
  const sidebar = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 190, top: 248, width: 110, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const bottomButton = {
    className: "TUXButton TUXButton--primary",
    disabled: false,
    inNavigation: false,
    rect: { left: 340, right: 540, top: 884, width: 200, height: 38 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 940,
    viewportWidth: 1154,
  };

  assert.equal(getPublishCandidateScore(sidebar), -1);
  assert.ok(getPublishCandidateScore(bottomButton) > 0);
});

test("TikTok secondary confirm terms reject plain Post and sidebar Posts", () => {
  const sidebar = {
    disabled: false,
    inNavigation: false,
    rect: { left: 80, right: 190, top: 248, width: 110, height: 36 },
    role: "button",
    tagName: "button",
    text: "Posts",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const bottomButton = {
    className: "TUXButton TUXButton--primary",
    disabled: false,
    inNavigation: false,
    rect: { left: 340, right: 540, top: 884, width: 200, height: 38 },
    role: "",
    tagName: "button",
    text: "Post",
    viewportHeight: 940,
    viewportWidth: 1154,
  };
  const secondaryTerms = ["publish", "confirm", "continue"];

  assert.equal(getPublishCandidateScore(sidebar, secondaryTerms), -1);
  assert.equal(getPublishCandidateScore(bottomButton, secondaryTerms), -1);
});

test("TikTok schedule helpers are exported for DOM scheduling", () => {
  const { findScheduleControls, setTikTokTime, setTikTokDate } = _private;

  assert.equal(typeof findScheduleControls, "function");
  assert.equal(typeof setTikTokTime, "function");
  assert.equal(typeof setTikTokDate, "function");
});

test("TikTok schedule date/time are formatted in the requested timezone", () => {
  const { formatScheduleDate, formatScheduleTime } = _private;
  const instant = new Date("2026-09-14T22:30:00Z");

  assert.equal(formatScheduleDate(instant, "Europe/Madrid"), "2026-09-15");
  assert.equal(formatScheduleTime(instant, "Europe/Madrid"), "00:30");
  assert.equal(formatScheduleDate(instant, "UTC"), "2026-09-14");
  assert.equal(formatScheduleTime(instant, "UTC"), "22:30");
});

test("TikTok uploader exposes the optional custom cover step", () => {
  assert.equal(typeof _private.setTikTokCover, "function");
});
