const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const STATE_FILE = path.resolve(config.projectRoot, "accounts-state.json");
const DEFAULT_ACCOUNT = { id: "default", name: "Default" };
const LEGACY_PROFILE_DIRS = {
  tiktok: config.profileDir,
  instagram: config.instagramProfileDir,
  youtube: config.youtubeProfileDir,
};

let state = {
  activeAccountId: DEFAULT_ACCOUNT.id,
  accounts: [DEFAULT_ACCOUNT],
};
let loaded = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(raw) {
  const accounts = Array.isArray(raw?.accounts)
    ? raw.accounts
      .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
      .map((item) => ({ id: item.id, name: item.name }))
    : [];
  if (!accounts.length) {
    accounts.push({ ...DEFAULT_ACCOUNT });
  }

  const activeExists = accounts.some((item) => item.id === raw?.activeAccountId);
  const activeAccountId = activeExists ? raw.activeAccountId : accounts[0].id;
  return { accounts, activeAccountId };
}

function sanitizeName(name) {
  return (name || "").toString().trim().replace(/\s+/g, " ").slice(0, 60);
}

function makeId(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "account";
}

function ensureUniqueId(baseId, existing) {
  if (!existing.has(baseId)) return baseId;
  let index = 2;
  while (existing.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

async function saveState() {
  const temp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try { await fs.copyFile(STATE_FILE, `${STATE_FILE}.bak`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(temp, STATE_FILE);
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    state = normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Account state is unreadable: ${error.message}`);
    state = normalizeState(state);
    await saveState();
  }
  loaded = true;
}

async function getState() {
  await ensureLoaded();
  return clone(state);
}

// Queue directory helpers

const PLATFORMS = ["tiktok", "instagram", "youtube"];
const SUBDIRS = ["pending", "scheduled", "processing", "posted", "failed"];

function assertSafeAccountId(accountId) {
  const value = String(accountId || "");
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(value)) {
    throw new Error("Invalid account identifier.");
  }
  return value;
}

function getAccountQueueDirs(accountId) {
  const safeId = assertSafeAccountId(accountId);
  const base = path.resolve(config.projectRoot, "queue", safeId);
  const dirs = {};
  for (const platform of PLATFORMS) {
    dirs[platform] = {};
    for (const sub of SUBDIRS) {
      dirs[platform][sub] = path.resolve(base, platform, sub);
    }
  }
  return dirs;
}

async function ensureAccountDirs(accountId) {
  const safeId = assertSafeAccountId(accountId);
  const dirs = getAccountQueueDirs(safeId);
  const allPaths = [];
  for (const platform of PLATFORMS) {
    for (const sub of SUBDIRS) {
      allPaths.push(dirs[platform][sub]);
    }
  }
  // Also ensure browser profile dirs
  const profileBase = path.resolve(config.projectRoot, ".profiles", safeId);
  for (const platform of [...PLATFORMS, "google-flow"]) {
    allPaths.push(path.resolve(profileBase, platform));
  }
  await Promise.all(allPaths.map((d) => fs.mkdir(d, { recursive: true })));
  return dirs;
}

// Account CRUD

async function addAccount(name) {
  await ensureLoaded();
  const cleanName = sanitizeName(name);
  if (!cleanName) {
    throw new Error("Account name is required.");
  }

  const existingIds = new Set(state.accounts.map((item) => item.id));
  const id = ensureUniqueId(makeId(cleanName), existingIds);
  const account = { id, name: cleanName };
  state.accounts.push(account);
  state.activeAccountId = account.id;
  await saveState();

  // Create queue and profile directories for the new account
  await ensureAccountDirs(id);

  return clone(account);
}

async function selectAccount(accountId) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  state.activeAccountId = target.id;
  await saveState();
  return clone(target);
}

async function getActiveAccount() {
  await ensureLoaded();
  return clone(
    state.accounts.find((item) => item.id === state.activeAccountId) || state.accounts[0]
  );
}

async function getAllAccounts() {
  await ensureLoaded();
  return clone(state.accounts);
}

async function requireAccount(accountId) {
  const safeId = assertSafeAccountId(accountId);
  await ensureLoaded();
  const account = state.accounts.find((item) => item.id === safeId);
  if (!account) throw new Error("Account not found.");
  return clone(account);
}

async function removeAccount(accountId) {
  await ensureLoaded();
  const safeId = assertSafeAccountId(accountId);
  if (safeId === DEFAULT_ACCOUNT.id) {
    throw new Error("La cuenta por defecto no se puede eliminar.");
  }
  const index = state.accounts.findIndex((item) => item.id === safeId);
  if (index < 0) throw new Error("Account not found.");

  const [removed] = state.accounts.splice(index, 1);
  if (state.activeAccountId === safeId) {
    state.activeAccountId = state.accounts[0].id;
  }
  await saveState();

  const queueDir = path.resolve(config.projectRoot, "queue", safeId);
  const profileDir = path.resolve(config.projectRoot, ".profiles", safeId);
  await fs.rm(queueDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});

  return clone(removed);
}

async function getPlatformProfileDir(platform, accountId) {
  const acctId = assertSafeAccountId(accountId || (await getActiveAccount()).id);
  if (acctId === DEFAULT_ACCOUNT.id && LEGACY_PROFILE_DIRS[platform]) {
    try {
      await fs.stat(LEGACY_PROFILE_DIRS[platform]);
      return LEGACY_PROFILE_DIRS[platform];
    } catch {
      // Fall through to new path
    }
  }
  return path.resolve(config.projectRoot, ".profiles", acctId, platform);
}

async function hasSavedPlatformSession(platform, accountId) {
  const profileDir = await getPlatformProfileDir(platform, accountId);
  const cookieCandidates = [
    path.resolve(profileDir, "Default", "Cookies"),
    path.resolve(profileDir, "Cookies"),
    path.resolve(profileDir, "Network", "Cookies"),
  ];

  for (const filePath of cookieCandidates) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        return true;
      }
    } catch {
      // continue
    }
  }

  return false;
}

module.exports = {
  getState,
  addAccount,
  selectAccount,
  getActiveAccount,
  getAllAccounts,
  getAccountQueueDirs,
  ensureAccountDirs,
  getPlatformProfileDir,
  hasSavedPlatformSession,
  requireAccount,
  removeAccount,
  assertSafeAccountId,
  PLATFORMS,
};
