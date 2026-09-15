#!/usr/bin/env node
/*
 * Startup bisector for the "Assertion failed: (env) != nullptr" crash.
 *
 * It loads the parts of the server one group at a time and reports the last
 * group that loaded, so we know which one kills the process. Run it with:
 *
 *   node scripts/diagnose-startup.js
 *
 * Every step prints a line BEFORE loading, so the last printed line names the
 * module that never came back.
 */
const steps = [
  ["core: config", () => require("../src/config")],
  ["core: account-manager", () => require("../src/account-manager")],
  ["studio: sqlite module", () => require("../src/studio")],
  ["studio: open database", () => {
    const { createStudioModule } = require("../src/studio");
    const cfg = require("../src/config");
    return createStudioModule({
      rootPath: cfg.studioRoot,
      databasePath: cfg.studioDatabasePath,
      getActiveAccount: async () => null,
      requireAccount: async () => null,
      getAccountQueueDirs: () => ({}),
    });
  }],
  ["helios", () => require("../src/helios/controller").getHeliosController()],
  ["competitor", () => require("../src/competitor/controller").getCompetitorController()],
  ["autoclone router", () => require("../src/autoclone")],
  ["tiktok uploader", () => require("../src/tiktok-uploader")],
  ["video uniquifier", () => require("../src/video-uniquifier")],
];

(async () => {
  console.log("node", process.version, "| NODE_OPTIONS:", process.env.NODE_OPTIONS || "(none)");
  for (const [label, fn] of steps) {
    console.log("[diag] loading:", label);
    try {
      await fn();
      console.log("[diag]   ok:", label);
    } catch (error) {
      console.log("[diag]   FAILED:", label, "-", error.message);
    }
  }
  console.log("[diag] all steps done, process still alive");
})();
