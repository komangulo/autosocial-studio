const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEMP_MAIL_URL,
  TIKTOK_SIGNUP_URL,
  extractTempMailCredentials,
  openOnboardingTabs,
  _private,
} = require("../src/temp-mail");

test("temporary mail integration uses verified provider and official TikTok URLs", () => {
  assert.equal(TEMP_MAIL_URL, "https://www.eztempmail.com/");
  assert.equal(TIKTOK_SIGNUP_URL, "https://www.tiktok.com/signup");
});

test("temporary mailbox and recovery key validation is strict", () => {
  assert.equal(_private.isValidMailbox("name@rapidmailai.com"), true);
  assert.equal(_private.isValidMailbox("not-an-email"), false);
  assert.equal(_private.isValidRecoveryKey("abcdef1234567890abcdef1234567890"), true);
  assert.equal(_private.isValidRecoveryKey("short"), false);
  assert.equal(_private.isValidRecoveryKey("invalid key with spaces"), false);
});

test("extractTempMailCredentials reads the mailbox, recovery key, and access token", async () => {
  const page = {
    evaluate: async () => ({
      email: "Test123@RapidMailAI.com",
      recoveryKey: "abcdef1234567890abcdef1234567890",
      accessToken: "access-token-123456789",
    }),
  };
  assert.deepEqual(await extractTempMailCredentials(page), {
    email: "test123@rapidmailai.com",
    recoveryKey: "abcdef1234567890abcdef1234567890",
    accessToken: "access-token-123456789",
  });
});

test("the temp-mail page is retained before TikTok navigation completes", async () => {
  let tempUrl = "about:blank";
  const tempPage = {
    url: () => tempUrl,
    goto: async (url) => { tempUrl = url; },
  };
  const tiktokPage = {
    url: () => "about:blank",
    goto: async () => { throw new Error("TikTok unavailable"); },
    bringToFront: async () => {},
  };
  const pages = [tempPage];
  const context = {
    pages: () => pages,
    newPage: async () => {
      pages.push(tiktokPage);
      return tiktokPage;
    },
  };
  let retained = null;
  await assert.rejects(
    openOnboardingTabs(context, { onTempMailPage: (page) => { retained = page; } }),
    /TikTok unavailable/
  );
  assert.equal(retained, tempPage);
  assert.equal(tempUrl, TEMP_MAIL_URL);
});

test("extractTempMailCredentials refuses incomplete provider data", async () => {
  const page = {
    evaluate: async () => ({
      email: "test@example.com",
      recoveryKey: "",
      accessToken: "token",
    }),
  };
  await assert.rejects(
    extractTempMailCredentials(page),
    /valid recovery key/
  );
});
