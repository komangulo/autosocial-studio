const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  metaFromInfoJson,
  normalizeTagList,
  translateMetaToSpanish,
  writeMetaFromInfoJson,
  enrichRecentVideos,
} = require("../src/video-meta");
const { readCaption, readVideoMeta, getMetaPath, buildCaptionFromMeta } = require("../src/queue");

test("video-meta metaFromInfoJson keeps the description as the caption", () => {
  const meta = metaFromInfoJson({
    title: "Receta de tortilla",
    description: "La mejor tortilla #receta #cocina",
    tags: ["receta", "cocina"],
    upload_date: "20260912",
  });
  // Solo se conserva la descripcion (que ya incluye los hashtags). El titulo de
  // TikTok viene truncado, asi que se descarta.
  assert.equal(meta.title, undefined);
  assert.equal(meta.description, "La mejor tortilla #receta #cocina");
  assert.equal(meta.caption, "La mejor tortilla #receta #cocina");
  assert.equal(meta.uploadedAt, new Date(Date.UTC(2026, 8, 12)).toISOString());
});

test("video-meta metaFromInfoJson always sets uploadedAt (fallback to file date)", () => {
  // Sin upload_date ni timestamp: se usa la fecha de respaldo.
  const meta = metaFromInfoJson(
    { title: "Sin fecha", description: "Texto #x" },
    { fallbackIso: "2026-01-02T03:04:05.000Z" },
  );
  assert.equal(meta.uploadedAt, "2026-01-02T03:04:05.000Z");
  // Sin respaldo tampoco: el campo existe pero vacio.
  const empty = metaFromInfoJson({ description: "Texto" });
  assert.equal(empty.uploadedAt, "");
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
    assert.equal(meta.description, "Mundo #tag");
    const stored = JSON.parse(await fs.readFile(getMetaPath(video), "utf8"));
    assert.equal(stored.description, "Mundo #tag");
    assert.equal(stored.title, undefined);
    // El .meta.json siempre trae description, caption y uploadedAt.
    assert.equal(stored.caption, "Mundo #tag");
    assert.equal(typeof stored.uploadedAt, "string");
    assert.ok(stored.uploadedAt.length > 0);
    // readCaption must prefer the companion metadata (the description).
    const caption = await readCaption(video);
    assert.ok(caption.includes("Mundo"));
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
    assert.equal(meta.description, "Desc #x");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("video-meta buildCaptionFromMeta uses the description as the caption", () => {
  const caption = buildCaptionFromMeta({
    title: "Receta",
    description: "Receta facil #cocina",
    hashtags: ["cocina", "viral"],
  });
  // El caption es exactamente la descripcion; el titulo no se duplica.
  assert.equal(caption, "Receta facil #cocina");
  // Sin descripcion, cae al titulo como ultimo recurso.
  assert.equal(buildCaptionFromMeta({ title: "Solo titulo" }), "Solo titulo");
});

test("video-meta translates only the description while preserving hashtags", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify({
          description: "Voy a mantenerlo asi.",
        }) }] } }] };
      },
    };
  };
  try {
    const translated = await translateMetaToSpanish({
      title: "She still does not know",
      description: "I am going to keep it that way. #booktok #bookgirlies",
    }, { apiKey: "free-key" });
    assert.equal(translated.title, undefined);
    assert.equal(translated.description, "Voy a mantenerlo asi. #booktok #bookgirlies");
    assert.equal(translated.caption, "Voy a mantenerlo asi. #booktok #bookgirlies");
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("video-meta keeps uploadedAt when the description is translated", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { candidates: [{ content: { parts: [{ text: JSON.stringify({
        description: "Voy a mantenerlo asi.",
      }) }] } }] };
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "video-meta-uploaded-"));
  try {
    const video = path.join(dir, "clip.mp4");
    await fs.writeFile(video, Buffer.alloc(16));
    await fs.writeFile(
      path.join(dir, "clip.info.json"),
      JSON.stringify({ title: "T", description: "Keep it #x", upload_date: "20260912" }),
    );
    const meta = await writeMetaFromInfoJson(video, { language: "es", apiKey: "free-key" });
    assert.equal(meta.description, "Voy a mantenerlo asi. #x");
    assert.equal(meta.uploadedAt, new Date(Date.UTC(2026, 8, 12)).toISOString());
  } finally {
    global.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
