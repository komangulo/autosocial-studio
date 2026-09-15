#!/usr/bin/env node
/*
 * Launcher for the dashboard.
 *
 * Node 24 on Windows aborts with:
 *   Assertion failed: (env) != nullptr  (src/api/hooks.cc:142)
 * when a native module (better-sqlite3) runs its cleanup hook at teardown.
 * The flags below avoid that path. They are harmless on Node 22 and lower.
 *
 * We set them HERE, in the child env, so the dashboard is stable no matter
 * which shell started it (Git Bash, CMD, PowerShell) and no manual `export`
 * is ever needed.
 */
const { spawn } = require("child_process");
const path = require("path");

const server = path.join(__dirname, "..", "src", "dashboard-server.js");

const flags = ["--no-node-snapshot", "--no-force-async-hooks-checks"];
const existing = process.env.NODE_OPTIONS || "";
const merged = [existing, ...flags].filter(Boolean).join(" ").trim();

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: merged },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
child.on("error", (error) => {
  console.error("Could not start the dashboard:", error.message);
  process.exit(1);
});
