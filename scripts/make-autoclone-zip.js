#!/usr/bin/env node
"use strict";

// Builds the Auto Clone delivery ZIP with the FULL runtime closure:
//   - every file under src/ (recursively)
//   - web/ (dashboard UI)
//   - scripts/ (helpers referenced by tests/checks)
//   - test/ (targeted suites)
//   - package.json, README.md and the top-level docs
// The archive is written to ../outputs/<name>.zip (see argv[2]).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const OUT_NAME = process.argv[2] || "autoclone-cover-order.zip";
const OUT = path.resolve(ROOT, "..", "outputs", OUT_NAME);

const INCLUDE_DIRS = ["src", "web", "scripts", "test"];
const INCLUDE_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "SETUP.md",
  "PLAN.md",
  "ROADMAP.md",
];

function walk(dir, base) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "outputs" ||
        entry.name === "downloads" ||
        entry.name === "queue"
      ) {
        continue;
      }
      out.push(...walk(abs, base));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function collect() {
  const files = new Set();
  for (const dir of INCLUDE_DIRS) {
    for (const rel of walk(path.join(ROOT, dir), ROOT)) {
      files.add(rel);
    }
  }
  for (const rel of INCLUDE_FILES) {
    if (fs.existsSync(path.join(ROOT, rel))) files.add(rel);
  }
  return [...files].sort();
}

// Minimal ZIP writer (store + deflate) so we do not depend on system zip.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { rel, data } of entries) {
    const name = Buffer.from(rel.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, end]);
}

function main() {
  const rels = collect();
  const entries = rels.map((rel) => ({
    rel,
    data: fs.readFileSync(path.join(ROOT, rel)),
  }));
  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zip);

  const missing = [];
  for (const rel of rels) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }

  console.log(`Wrote ${path.relative(ROOT, OUT)} (${entries.length} files, ${(zip.length / 1024).toFixed(0)}K)`);
  console.log(`Missing: ${missing.length}`);
  process.exitCode = missing.length ? 1 : 0;
}

main();
