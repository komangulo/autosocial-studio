const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

test(".env.example ships without personal content defaults", () => {
  const envExamplePath = path.resolve(__dirname, "..", ".env.example");
  const parsed = dotenv.parse(fs.readFileSync(envExamplePath));

  assert.equal(parsed.AUTO_ADD_SOUND, "false");
  assert.equal(parsed.DEFAULT_CAPTION, "");
  assert.equal(parsed.DEFAULT_SOUND_QUERY, "");
  assert.equal(parsed.WATCH_CHANNEL, "");
});
