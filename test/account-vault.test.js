const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  AccountVault,
  generateTikTokPassword,
} = require("../src/account-vault");

class TestProtector {
  constructor() {
    this.id = "test-protector";
  }

  isAvailable() {
    return true;
  }

  async protect(value) {
    return Buffer.from(`protected:${value}`, "utf8").toString("base64");
  }

  async unprotect(value) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    assert.match(decoded, /^protected:/);
    return decoded.slice("protected:".length);
  }
}

async function makeVault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-account-vault-"));
  return {
    root,
    filePath: path.join(root, "account-vault.json"),
    vault: new AccountVault({
      filePath: path.join(root, "account-vault.json"),
      protector: new TestProtector(),
    }),
  };
}

test("generated TikTok passwords include all required character groups", () => {
  const password = generateTikTokPassword();
  assert.equal(password.length, 20);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[!@#$%]/);
});

test("account vault stores all credentials in one protected document", async (t) => {
  const { root, filePath, vault } = await makeVault();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await vault.prepareAccount({
    accountId: "tiktok-account-1",
    accountName: "TikTok account 1",
    tiktokPassword: "Abcd1234!secure",
  });
  await vault.saveTempMail({
    accountId: "tiktok-account-1",
    email: "sample@rapidmailai.com",
    recoveryKey: "abcdef1234567890abcdef1234567890",
    accessToken: "mail-access-token-123456",
  });

  const raw = await fs.readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /sample@rapidmailai\.com/);
  assert.doesNotMatch(raw, /Abcd1234!secure/);
  assert.doesNotMatch(raw, /abcdef1234567890/);

  const summaries = await vault.listSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].tempMailEmail, "sample@rapidmailai.com");
  assert.equal(summaries[0].hasRecoveryKey, true);
  assert.equal(summaries[0].hasTikTokPassword, true);
  assert.equal(
    await vault.getSecret("tiktok-account-1", "tempMailRecoveryKey"),
    "abcdef1234567890abcdef1234567890"
  );
  assert.equal(
    await vault.getSecret("tiktok-account-1", "tiktokPassword"),
    "Abcd1234!secure"
  );
});

test("weekly account preparation limit starts when a record is prepared", async (t) => {
  const { root, vault } = await makeVault();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal((await vault.getWeeklyAvailability(new Date("2026-01-01T00:00:00Z"))).allowed, true);
  await vault.prepareAccount({
    accountId: "weekly-account",
    accountName: "Weekly account",
    tiktokPassword: "Abcd1234!secure",
  });
  const summaries = await vault.listSummaries();
  const preparedAt = new Date(summaries[0].preparedAt);
  const early = await vault.getWeeklyAvailability(new Date(preparedAt.getTime() + (6 * 24 * 60 * 60 * 1000)));
  const due = await vault.getWeeklyAvailability(new Date(preparedAt.getTime() + (7 * 24 * 60 * 60 * 1000)));
  assert.equal(early.allowed, false);
  assert.equal(due.allowed, true);
});

test("weekly reservation is enforced inside the serialized vault mutation", async (t) => {
  const { root, vault } = await makeVault();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date("2026-06-01T12:00:00Z");
  const results = await Promise.allSettled([
    vault.prepareAccountIfWeeklyAllowed({
      accountId: "concurrent-one",
      accountName: "Concurrent one",
      tiktokPassword: "Abcd1234!secure",
    }, now),
    vault.prepareAccountIfWeeklyAllowed({
      accountId: "concurrent-two",
      accountName: "Concurrent two",
      tiktokPassword: "Abcd1234!secure",
    }, now),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /one-account-per-week/);
  assert.equal((await vault.listSummaries()).length, 1);
});

test("account vault rejects unsupported secret fields", async (t) => {
  const { root, vault } = await makeVault();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    vault.getSecret("valid-account", "accountName"),
    /Unsupported secret field/
  );
});
