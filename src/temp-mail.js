const TEMP_MAIL_URL = "https://www.eztempmail.com/";
const TIKTOK_SIGNUP_URL = "https://www.tiktok.com/signup";

function isValidMailbox(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isValidRecoveryKey(value) {
  return /^[A-Za-z0-9_-]{16,500}$/.test(String(value || "").trim());
}

async function extractTempMailCredentials(page) {
  const data = await page.evaluate(() => ({
    email: document.querySelector("#mainEmail")?.value || "",
    recoveryKey: document.querySelector("#recoveryKeyText")?.textContent || "",
    accessToken: document.querySelector("#email_token")?.value || "",
  }));
  const email = String(data.email || "").trim().toLowerCase();
  const recoveryKey = String(data.recoveryKey || "").trim();
  const accessToken = String(data.accessToken || "").trim();
  if (!isValidMailbox(email)) {
    throw new Error("EZ Temp Mail did not provide a valid mailbox address.");
  }
  if (!isValidRecoveryKey(recoveryKey)) {
    throw new Error("EZ Temp Mail did not provide a valid recovery key.");
  }
  return { email, recoveryKey, accessToken };
}

async function waitForTempMailCredentials(page, { timeoutMs = 120000 } = {}) {
  await page.waitForFunction(
    () => {
      const email = document.querySelector("#mainEmail")?.value?.trim() || "";
      const recoveryKey = document.querySelector("#recoveryKeyText")?.textContent?.trim() || "";
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        /^[A-Za-z0-9_-]{16,500}$/.test(recoveryKey);
    },
    null,
    { timeout: timeoutMs }
  );
  return extractTempMailCredentials(page);
}

async function openOnboardingTabs(context, { timeoutMs = 120000, onTempMailPage } = {}) {
  const initialPages = context.pages();
  let tempMailPage = initialPages.find((page) => page.url() === "about:blank") || initialPages[0];
  if (!tempMailPage) tempMailPage = await context.newPage();

  await tempMailPage.goto(TEMP_MAIL_URL, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await onTempMailPage?.(tempMailPage);

  let tiktokPage = context.pages().find((page) => page !== tempMailPage && page.url().includes("tiktok.com"));
  if (!tiktokPage) tiktokPage = await context.newPage();
  await tiktokPage.goto(TIKTOK_SIGNUP_URL, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await tiktokPage.bringToFront();
  return { tempMailPage, tiktokPage };
}

module.exports = {
  TEMP_MAIL_URL,
  TIKTOK_SIGNUP_URL,
  extractTempMailCredentials,
  waitForTempMailCredentials,
  openOnboardingTabs,
  _private: {
    isValidMailbox,
    isValidRecoveryKey,
  },
};
