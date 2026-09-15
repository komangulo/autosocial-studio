const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("./config");

const DEFAULT_VAULT_PATH = path.resolve(config.projectRoot, "account-vault.json");
const VAULT_VERSION = 1;
const ALLOWED_SECRET_FIELDS = new Set([
  "tempMailRecoveryKey",
  "tempMailAccessToken",
  "tiktokPassword",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function validateAccountId(value) {
  const accountId = sanitizeText(value, 60);
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(accountId)) {
    throw new Error("Invalid account identifier.");
  }
  return accountId;
}

function validateEmail(value) {
  const email = sanitizeText(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("The temporary email address is invalid.");
  }
  return email;
}

function generateTikTokPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const required = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%"]
    .map((set) => set[crypto.randomInt(set.length)]);
  const remaining = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  const characters = [...required, ...remaining];
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

function buildSummaries(data) {
  return Object.values(data.accounts || {})
    .map((item) => ({
      accountId: item.accountId,
      accountName: item.accountName,
      provider: item.provider,
      providerUrl: item.providerUrl,
      status: item.status,
      tempMailEmail: item.tempMailEmail || "",
      hasRecoveryKey: Boolean(item.tempMailRecoveryKey),
      hasTikTokPassword: Boolean(item.tiktokPassword),
      tiktokUsername: item.tiktokUsername || "",
      preparedAt: item.preparedAt || null,
      emailReadyAt: item.emailReadyAt || null,
    }))
    .sort((left, right) => String(right.preparedAt || "").localeCompare(String(left.preparedAt || "")));
}

function calculateWeeklyAvailability(summaries, now = new Date()) {
  const prepared = summaries
    .map((item) => item.preparedAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());
  if (!prepared.length) return { allowed: true, nextAllowedAt: null };
  const nextAllowedAt = new Date(prepared[0].getTime() + (7 * 24 * 60 * 60 * 1000));
  return {
    allowed: now.getTime() >= nextAllowedAt.getTime(),
    nextAllowedAt: nextAllowedAt.toISOString(),
  };
}

function runPowerShell(script, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows credential encryption timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Windows credential encryption is unavailable: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Windows credential encryption failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(input, "utf8");
  });
}

class WindowsDpapiProtector {
  constructor(platform = process.platform) {
    this.platform = platform;
    this.id = "windows-dpapi-current-user";
  }

  isAvailable() {
    return this.platform === "win32";
  }

  async protect(plainText) {
    if (!this.isAvailable()) {
      throw new Error("The credential vault requires Windows DPAPI.");
    }
    const input = Buffer.from(String(plainText), "utf8").toString("base64");
    return runPowerShell(
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
      "[Console]::Out.Write([Convert]::ToBase64String($p))",
      input
    );
  }

  async unprotect(protectedText) {
    if (!this.isAvailable()) {
      throw new Error("The credential vault requires Windows DPAPI.");
    }
    const output = await runPowerShell(
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
      "[Console]::Out.Write([Convert]::ToBase64String($p))",
      String(protectedText || "")
    );
    return Buffer.from(output, "base64").toString("utf8");
  }
}

class AccountVault {
  constructor({ filePath = DEFAULT_VAULT_PATH, protector = new WindowsDpapiProtector() } = {}) {
    this.filePath = path.resolve(filePath);
    this.protector = protector;
    this.mutation = Promise.resolve();
  }

  isAvailable() {
    return Boolean(this.protector?.isAvailable?.());
  }

  async readDocument() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const document = JSON.parse(raw);
      if (document.version !== VAULT_VERSION || document.protector !== this.protector.id) {
        throw new Error("The account vault format is unsupported.");
      }
      const plainText = await this.protector.unprotect(document.protectedData);
      const data = JSON.parse(plainText);
      return {
        accounts: data && typeof data.accounts === "object" && !Array.isArray(data.accounts)
          ? data.accounts
          : {},
        updatedAt: data?.updatedAt || null,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { accounts: {}, updatedAt: null };
      throw new Error(`Account vault is unreadable: ${error.message}`);
    }
  }

  async writeDocument(data) {
    if (!this.isAvailable()) {
      throw new Error("Encrypted account storage is available only on Windows for this application.");
    }
    const payload = {
      accounts: data.accounts || {},
      updatedAt: new Date().toISOString(),
    };
    const protectedData = await this.protector.protect(JSON.stringify(payload));
    const document = JSON.stringify({
      version: VAULT_VERSION,
      protector: this.protector.id,
      protectedData,
    }, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const backupPath = `${this.filePath}.bak`;
    try {
      await fs.copyFile(this.filePath, backupPath);
      await fs.chmod(backupPath, 0o600).catch(() => {});
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(tempPath, document, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => {});
    return payload;
  }

  mutate(mutator) {
    const operation = this.mutation.then(async () => {
      const data = await this.readDocument();
      const result = await mutator(data);
      await this.writeDocument(data);
      return result;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  async prepareAccount({ accountId, accountName, tiktokPassword }) {
    const safeId = validateAccountId(accountId);
    const password = sanitizeText(tiktokPassword, 200);
    if (!password) throw new Error("A TikTok password is required.");
    return this.mutate((data) => {
      const previous = data.accounts[safeId] || {};
      const now = new Date().toISOString();
      data.accounts[safeId] = {
        ...previous,
        accountId: safeId,
        accountName: sanitizeText(accountName, 60) || safeId,
        provider: "eztempmail",
        providerUrl: "https://www.eztempmail.com/",
        status: previous.tempMailEmail ? previous.status : "preparing-email",
        preparedAt: previous.preparedAt || now,
        tiktokPassword: password,
        tiktokUsername: previous.tiktokUsername || "",
      };
      return clone(data.accounts[safeId]);
    });
  }

  async prepareAccountIfWeeklyAllowed({ accountId, accountName, tiktokPassword }, now = new Date()) {
    const safeId = validateAccountId(accountId);
    const password = sanitizeText(tiktokPassword, 200);
    if (!password) throw new Error("A TikTok password is required.");
    return this.mutate((data) => {
      const previous = data.accounts[safeId];
      if (previous) return clone(previous);
      const weeklyAvailability = calculateWeeklyAvailability(buildSummaries(data), now);
      if (!weeklyAvailability.allowed) {
        const error = new Error(`The one-account-per-week limit is active until ${weeklyAvailability.nextAllowedAt}.`);
        error.code = "WEEKLY_LIMIT";
        error.nextAllowedAt = weeklyAvailability.nextAllowedAt;
        throw error;
      }
      data.accounts[safeId] = {
        accountId: safeId,
        accountName: sanitizeText(accountName, 60) || safeId,
        provider: "eztempmail",
        providerUrl: "https://www.eztempmail.com/",
        status: "preparing-email",
        preparedAt: now.toISOString(),
        tiktokPassword: password,
        tiktokUsername: "",
      };
      return clone(data.accounts[safeId]);
    });
  }

  async saveTempMail({ accountId, email, recoveryKey, accessToken }) {
    const safeId = validateAccountId(accountId);
    const safeEmail = validateEmail(email);
    const key = sanitizeText(recoveryKey, 500);
    if (!/^[A-Za-z0-9_-]{16,500}$/.test(key)) {
      throw new Error("The temporary email recovery key is invalid.");
    }
    return this.mutate((data) => {
      const previous = data.accounts[safeId];
      if (!previous) throw new Error("The account was not prepared in the local vault.");
      const now = new Date().toISOString();
      data.accounts[safeId] = {
        ...previous,
        status: "email-ready",
        tempMailEmail: safeEmail,
        tempMailRecoveryKey: key,
        tempMailAccessToken: sanitizeText(accessToken, 1000),
        emailReadyAt: now,
      };
      return clone(data.accounts[safeId]);
    });
  }

  async getSnapshot(now = new Date()) {
    if (!this.isAvailable()) {
      return {
        summaries: [],
        weeklyAvailability: { allowed: true, nextAllowedAt: null },
      };
    }
    const data = await this.readDocument();
    const summaries = buildSummaries(data);
    return {
      summaries,
      weeklyAvailability: calculateWeeklyAvailability(summaries, now),
    };
  }

  async listSummaries() {
    return (await this.getSnapshot()).summaries;
  }

  async getAccount(accountId) {
    const safeId = validateAccountId(accountId);
    if (!this.isAvailable()) return null;
    const data = await this.readDocument();
    return data.accounts[safeId] ? clone(data.accounts[safeId]) : null;
  }

  async getSecret(accountId, field) {
    const safeId = validateAccountId(accountId);
    if (!ALLOWED_SECRET_FIELDS.has(field)) throw new Error("Unsupported secret field.");
    const account = await this.getAccount(safeId);
    if (!account) throw new Error("Stored account credentials were not found.");
    const value = sanitizeText(account[field], 1000);
    if (!value) throw new Error("That credential has not been saved yet.");
    return value;
  }

  async getWeeklyAvailability(now = new Date()) {
    return (await this.getSnapshot(now)).weeklyAvailability;
  }
}

const accountVault = new AccountVault();

module.exports = {
  AccountVault,
  WindowsDpapiProtector,
  accountVault,
  generateTikTokPassword,
  _private: {
    validateEmail,
    validateAccountId,
  },
};
