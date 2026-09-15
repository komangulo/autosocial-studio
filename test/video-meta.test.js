const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  metaFromInfoJson,
  normalizeTagList,
  translateMetaToSpanish,
  preserveTitleHashtags,
  writeMetaFromInfoJson,
  enrichRecentVideos,
} = require("../src/video-meta");
const { readCaption, readVideoMeta, getMetaPath, buildCaptionFromMeta } = require("../src/queue");

test("video-meta metaFromInfoJson keeps title, description and hashtags", () => {
  const meta = metaFromInfoJson({
    title: "Receta de tortilla",
    description: "La mejor tortilla #receta #cocina",
    tags: ["receta", "cocina"],
  });
  assert.equal(meta.title, "Receta de tortilla");
  assert.equal(meta.description, "La mejor tortilla #receta #cocina");
  assert.deepEqual(meta.hashtags, ["receta", "cocina"]);
  // The caption merges title + description and already has the hashtags present.
  assert.ok(meta.caption.includes("Receta de tortilla"));
  assert.ok(meta.caption.includes("#receta"));
});

test("video-meta falls back to hashtags embedded in the text", () => {
  const meta = metaFromInfoJson({
    title: "Truco",
    description: "Mira esto #viral #parati",
  });
  assert.deepEqual(meta.hashtags, ["viral", "parati"]);
});

test("video-meta normalizeTagList strips # and dedupes", () => {
  assert.deepEqual(normalizeTagList(["#viral", "viral", "Madrid"]), ["viral", "Madrid"]);
  assert.deepEqual(normalizeTagList("viral #parati,viral"), ["viral", "parati"]);
  assert.deepEqual(normalizeTagList(undefined), []);
});

test("video-meta writes a .meta.json companion from an info.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "video-meta-"));
  try {
    const video = path.join(dir, "2026-09-12_123.mp4");
    await fs.writeFile(video, Buffer.alloc(16));
    await fs.writeFile(
      path.join(dir, "2026-09-12_123.info.json"),
      JSON.stringify({ title: "Hola", description: "Mundo #tag", tags: ["tag"] }),
      "utf8"
    );
    const meta = await writeMetaFromInfoJson(video);
    assert.equal(meta.title, "Hola");
    const stored = JSON.parse(await fs.readFile(getMetaPath(video), "utf8"));
    assert.equal(stored.title, "Hola");
    assert.deepEqual(stored.hashtags, ["tag"]);
    // readCaption must prefer the companion metadata.
    const caption = await readCaption(video);
    assert.ok(caption.includes("Hola"));
    assert.ok(caption.includes("#tag"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("video-meta enrichRecentVideos creates companions only for recent files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "video-enrich-"));
  try {
    const sub = path.join(dir, "uploader");
    await fs.mkdir(sub, { recursive: true });
    const video = path.join(sub, "clip.mp4");
    await fs.writeFile(video, Buffer.alloc(8));
    await fs.writeFile(
      path.join(sub, "clip.info.json"),
      JSON.stringify({ title: "Clip", description: "Desc #x", tags: ["x"] })
    );
    const summary = await enrichRecentVideos(dir, 0);
    assert.equal(summary.processed, 1);
    const meta = await readVideoMeta(video);
    assert.equal(meta.title, "Clip");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("video-meta buildCaptionFromMeta does not duplicate the title", () => {
  const caption = buildCaptionFromMeta({
    title: "Receta",
    description: "Receta facil #cocina",
    hashtags: ["cocina", "viral"],
  });
  assert.equal((caption.match(/Receta/g) || []).length, 1);
  assert.ok(caption.includes("#viral"));
});

test("video-meta translates title and description while preserving hashtags", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({
          title: "Ella todavia no lo sabe",
           description: "Voy a mantenerlo asi.",
          hashtags: ["booktok", "bookgirlies"],
        }) }] } }] };
      },
    };
  };
  try {
    const translated = await translateMetaToSpanish({
      title: "She still does not know",
       description: "I am going to keep it that way. #booktok #bookgirlies",
      hashtags: ["booktok", "bookgirlies"],
    }, { apiKey: "free-key" });
    assert.equal(translated.title, "Ella todavia no lo sabe");
    assert.equal(translated.description, "Voy a mantenerlo asi. #booktok #bookgirlies");
    assert.deepEqual(translated.hashtags, ["booktok", "bookgirlies"]);
    assert.ok(translated.caption.includes("Ella todavia no lo sabe"));
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("video-meta preserves hashtags embedded in a truncated title", () => {
  assert.equal(
    preserveTitleHashtags("Titulo traducido", "Titulo original #booktok #m..."),
    "Titulo traducido #booktok #m..."
  );
});
