#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

function collectCleanupTargets(root = projectRoot) {
  const targets = [];

  if (!fs.existsSync(root)) {
    return targets;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    if (
      /^last-.*\.png$/i.test(entry.name) ||
      /^qa-.*\.png$/i.test(entry.name) ||
      /^\.dashboard\..*\.log$/i.test(entry.name)
    ) {
      targets.push(path.join(root, entry.name));
    }
  }

  const localLogDir = path.join(root, ".local");
  for (const logName of ["dashboard.out.log", "dashboard.err.log"]) {
    const logPath = path.join(localLogDir, logName);
    if (fs.existsSync(logPath)) {
      targets.push(logPath);
    }
  }

  return Array.from(new Set(targets)).sort();
}

function removeTargets(targets, { dryRun = false } = {}) {
  for (const target of targets) {
    if (dryRun) {
      console.log(`[dry-run] remove ${target}`);
      continue;
    }

    fs.rmSync(target, { force: true });
    console.log(`removed ${target}`);
  }
}

function printHelp() {
  console.log("Usage: npm run clean:debug -- [--dry-run]");
  console.log("");
  console.log("Removes local debug screenshots and dashboard logs only.");
  console.log("Profiles, queue media, account state, and .env are left untouched.");
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const dryRun = argv.includes("--dry-run");
  const targets = collectCleanupTargets(projectRoot);

  if (targets.length === 0) {
    console.log("No debug artifacts found.");
    return;
  }

  removeTargets(targets, { dryRun });
}

if (require.main === module) {
  main();
}

module.exports = {
  collectCleanupTargets,
  removeTargets,
};
