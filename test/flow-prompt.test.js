const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  DYNAMIC_MARKER,
  renderFlowPrompt,
  phraseKey,
  parseGeminiPhrases,
  generateUniqueDynamicPhrases,
} = require("../src/flow-prompt");
const { normalizeConfig, publicConfig } = require("../src/flow-config");
const { normalizePrompts } = require("../src/google-flow");

function geminiResponse(phrases) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ phrases }) }] } }],
      };
    },
  };
}

test("fixed Flow prompt renders the dynamic marker everywhere", () => {
  const rendered = renderFlowPrompt(`Title: ${DYNAMIC_MARKER}\nText: ${DYNAMIC_MARKER}`, "Never fear desire");
  assert.equal(rendered, "Title: Never fear desire\nText: Never fear desire");
  assert.throws(() => renderFlowPrompt("No marker", "Phrase"), /must contain/);
  assert.throws(() => renderFlowPrompt(`${"x".repeat(10001)}${DYNAMIC_MARKER}`, "Phrase"), /10,000/);
});

test("phrase comparison ignores case, accents, and punctuation", () => {
  assert.equal(phraseKey("  Pasi\u00f3n, OSCURA! "), phraseKey("pasion oscura"));
});

test("Gemini structured phrase responses are parsed safely", () => {
  const values = parseGeminiPhrases({
    candidates: [{ content: { parts: [{ text: '{"phrases":["First phrase","Second phrase"]}' }] } }],
  });
  assert.deepEqual(values, ["First phrase", "Second phrase"]);
  assert.throws(() => parseGeminiPhrases({ candidates: [] }), /did not return text/);
});

test("dynamic phrases never repeat persisted account history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-flow-prompt-"));
  const historyFile = path.join(root, "history.json");
  await fs.writeFile(historyFile, JSON.stringify({
    version: 1,
    phrases: [{ text: "La noche conoce mi deseo", key: "ignored", createdAt: new Date().toISOString() }],
  }));
  const batches = [
    ["La noche conoce mi deseo"],
    ["El peligro pronuncia mi nombre", "Su sombra despierta mi fuego"],
  ];
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return geminiResponse(batches.shift());
  };

  const phrases = await generateUniqueDynamicPhrases({
    accountId: "dark-romance",
    apiKey: "secret-key",
    instructions: "Frases originales de dark romance para mujeres",
    count: 2,
    fetchImpl,
    historyFile,
  });

  assert.deepEqual(phrases, ["El peligro pronuncia mi nombre", "Su sombra despierta mi fuego"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers["x-goog-api-key"], "secret-key");
  assert.equal(requests[0].url.includes("secret-key"), false);
  const history = JSON.parse(await fs.readFile(historyFile, "utf8"));
  assert.equal(history.phrases.length, 3);
  await fs.rm(root, { recursive: true, force: true });
});

test("Flow config migrates legacy prompts and hides Gemini keys", () => {
  const value = normalizeConfig("default", {
    prompt: "A fixed visual style",
    dynamicInstructions: "Original romance phrases",
    geminiApiKey: "private-key",
  });
  assert.equal(value.fixedPromptTemplate, `A fixed visual style\n\n${DYNAMIC_MARKER}`);
  const migratedLimit = normalizeConfig("default", { prompt: "x".repeat(10000) });
  assert.equal(migratedLimit.fixedPromptTemplate.length, 10000);
  assert.equal(migratedLimit.fixedPromptTemplate.endsWith(DYNAMIC_MARKER), true);
  const exposed = publicConfig(value);
  assert.equal(exposed.geminiApiKeyConfigured, true);
  assert.equal(Object.hasOwn(exposed, "geminiApiKey"), false);
});

test("Google Flow requires one distinct final prompt per video", () => {
  assert.deepEqual(normalizePrompts(["Prompt one", "Prompt two"]), ["Prompt one", "Prompt two"]);
  assert.throws(() => normalizePrompts(["Same", "same"]), /different prompt/);
  assert.throws(() => normalizePrompts([]), /between one and three/);
});
