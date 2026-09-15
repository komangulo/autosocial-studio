const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const express = require("express");
const { config } = require("./config");
const { ensureDirectories } = require("./fs-utils");
const { UniquifierController } = require("./uniquifier-controller");
const { AutoDownloadController } = require("./autodownload-controller");
const { ProfileDownloadController } = require("./profile-download-controller");
const { getDaemons, getAllStatus } = require("./daemon-registry");
const { migrateQueueIfNeeded } = require("./migrate-queue");
const { createDashboardRequestGuard } = require("./request-guard");
const { buildSetupHealth, getAllowedSetupFolderPath } = require("./setup-health");
const { JobStore } = require("./job-store");
const { AutonomousWorker } = require("./autonomous-worker");
const {
  startDashboardLoginSession: startTikTokLoginSession,
  startTempMailSetupSession,
  retryTempMailCapture,
  getTempMailSetupStatus,
  getLoginSessionStatus: getTikTokLoginSessionStatus,
  closeLoginSession: closeTikTokLoginSession,
} = require("./tiktok-uploader");
const {
  startLoginSession: startInstagramLoginSession,
  getLoginSessionStatus: getInstagramLoginSessionStatus,
  closeLoginSession: closeInstagramLoginSession,
} = require("./instagram-uploader");
const {
  startLoginSession: startYouTubeLoginSession,
  getLoginSessionStatus: getYouTubeLoginSessionStatus,
  closeLoginSession: closeYouTubeLoginSession,
} = require("./youtube-uploader");
const {
  getState,
  addAccount,
  selectAccount,
  getActiveAccount,
  getAllAccounts,
  ensureAccountDirs,
  getAccountQueueDirs,
  requireAccount,
} = require("./account-manager");
const { accountVault, generateTikTokPassword } = require("./account-vault");
const googleFlow = require("./google-flow");
const { getFlowConfig, saveFlowConfig } = require("./flow-config");
const { listFlowDownloads, resolveFlowDownload } = require("./flow-downloads");
const { generateUniqueDynamicPhrases, renderFlowPrompt } = require("./flow-prompt");
const xAutopilot = require("./x-autopilot");
const { createStudioModule } = require("./studio");
const { createHeliosRouter } = require("./helios");
const { createCompetitorRouter } = require("./competitor");
const { createAndroidCloneRouter } = require("./androidclone");

function openFolder(folderPath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    if (platform === "win32") {
      const child = spawn("explorer", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    if (platform === "darwin") {
      const child = spawn("open", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    const child = spawn("xdg-open", [folderPath], { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

/**
 * Helper: resolve the active account and get its daemons from the registry.
 */
async function getActiveDaemons() {
  const active = await getActiveAccount();
  return getDaemons(active.id);
}

function getNextTikTokAccountName(accounts) {
  const used = new Set((accounts || []).map((account) => String(account.name || "").toLowerCase()));
  let index = 1;
  while (used.has(`tiktok account ${index}`)) index += 1;
  return `TikTok account ${index}`;
}

let tempAccountCreationQueue = Promise.resolve();
function runSerializedTempAccountCreation(operation) {
  const run = tempAccountCreationQueue.then(operation);
  tempAccountCreationQueue = run.catch(() => {});
  return run;
}

async function buildManagedAccountsResponse() {
  const [state, vaultSnapshot] = await Promise.all([
    getState(),
    accountVault.getSnapshot(),
  ]);
  const summaries = vaultSnapshot.summaries;
  const summaryById = new Map(summaries.map((item) => [item.accountId, item]));
  return {
    ok: true,
    vaultAvailable: accountVault.isAvailable(),
    vaultProtection: "Windows DPAPI (current Windows user)",
    weeklyAvailability: vaultSnapshot.weeklyAvailability,
    activeAccountId: state.activeAccountId,
    onboarding: getTempMailSetupStatus(),
    accounts: state.accounts.map((account) => ({
      ...account,
      credentials: summaryById.get(account.id) || null,
    })),
  };
}

const SETTINGS_ENV_KEYS = new Set([
  "AUTO_ADD_SOUND",
  "DEFAULT_CAPTION",
  "DEFAULT_SOUND_QUERY",
  "RANDOM_QUEUE_ORDER",
]);

function serializeEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@,-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function applyRuntimeSetting(envKey, value) {
  if (envKey === "AUTO_ADD_SOUND") {
    config.autoAddSound = String(value).toLowerCase() === "true";
  } else if (envKey === "DEFAULT_CAPTION") {
    config.defaultCaption = String(value ?? "");
  } else if (envKey === "DEFAULT_SOUND_QUERY") {
    config.defaultSoundQuery = String(value ?? "");
  } else if (envKey === "RANDOM_QUEUE_ORDER") {
    config.randomQueueOrder = String(value).toLowerCase() === "true";
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function ensureDashboardBindAllowed() {
  if (config.dashboardHost !== "127.0.0.1" || config.dashboardPort !== 3028) {
    throw new Error("The dashboard must listen only on http://localhost:3028.");
  }
}

async function createServer() {
  // Run migration from old flat queue layout to per-profile structure
  await migrateQueueIfNeeded();

  // Ensure dirs for all existing accounts
  const allAccounts = await getAllAccounts();
  for (const acct of allAccounts) {
    await ensureAccountDirs(acct.id);
  }

  // Ensure uniquifier dirs
  await ensureDirectories([
    config.uniquifyInputDir,
    config.uniquifyOutputDir,
  ]);

  // Pre-initialize daemons for all existing accounts
  for (const acct of allAccounts) {
    await getDaemons(acct.id);
  }

  const jobStore = new JobStore(config.autonomousStatePath);
  const autonomousWorker = new AutonomousWorker({ store: jobStore, pollMs: config.autonomousPollMs });
  await autonomousWorker.init();
  autonomousWorker.start();

  const app = express();
  const uniquifier = new UniquifierController();
  const autoDownloader = new AutoDownloadController();
  const profileDownloader = new ProfileDownloadController();
  const studio = createStudioModule({
    rootPath: config.studioRoot,
    databasePath: config.studioDatabasePath,
    getActiveAccount,
    requireAccount,
    getAccountQueueDirs,
  });
  const helios = require("./helios/controller").getHeliosController();
  await helios.init();
  const competitor = require("./competitor/controller").getCompetitorController();
  await competitor.init();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "15mb" }));
  app.use(createDashboardRequestGuard());
  app.use("/api/studio", studio.router);
  app.use("/api/helios", createHeliosRouter(express));
  app.use("/api/competitor", createCompetitorRouter(express));
  app.use("/api/androidclone", createAndroidCloneRouter(express));

  app.get("/api/helios/media/:name", async (req, res) => {
    try {
      const filePath = helios.resolveUpload(req.params.name);
      res.sendFile(filePath);
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });
  app.use(express.static(path.join(__dirname, "..", "web")));

  app.get("/api/google-flow/status", async (req, res) => {
    res.json(await googleFlow.getSessionStatus());
  });

  app.post("/api/google-flow/login", async (req, res) => {
    try {
      res.json(await googleFlow.startLoginSession());
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/google-flow/close", async (req, res) => {
    res.json(await googleFlow.closeLoginSession());
  });

  app.get("/api/google-flow/config", async (req, res) => {
    const active = await getActiveAccount();
    res.json(await getFlowConfig(active.id));
  });

  app.post("/api/google-flow/config", async (req, res) => {
    try {
      const active = await getActiveAccount();
      res.json({ ok: true, config: await saveFlowConfig(active.id, req.body || {}) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/google-flow/preview", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const flow = await getFlowConfig(active.id, { includePrivate: true });
      if (!flow.dynamicInstructions) throw new Error("Save dynamic content instructions first.");
      if (!flow.geminiApiKey) throw new Error("Save a Gemini API key for this account first.");
      const [phrase] = await generateUniqueDynamicPhrases({
        accountId: active.id,
        apiKey: flow.geminiApiKey,
        instructions: flow.dynamicInstructions,
        count: 1,
      });
      res.json({
        ok: true,
        phrase,
        prompt: renderFlowPrompt(flow.fixedPromptTemplate, phrase),
        model: config.geminiModel,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/google-flow/run-now", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const flow = await getFlowConfig(active.id, { includePrivate: true });
      if (!flow.fixedPromptTemplate) throw new Error("Save a fixed Google Flow prompt first.");
      if (!flow.dynamicInstructions) throw new Error("Save dynamic content instructions first.");
      if (!flow.geminiApiKey) throw new Error("Save a Gemini API key for this account first.");
      const job = await jobStore.createJob({
        type: "flow-generate",
        accountId: active.id,
        scheduledAt: new Date(),
        maxAttempts: 1,
        payload: { source: "manual" },
      });
      res.json({ ok: true, job });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/google-flow/downloads", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const downloads = await listFlowDownloads(active.id);
      res.json({
        ok: true,
        accountId: active.id,
        folder: downloads.root,
        videos: downloads.videos.map((video) => ({
          ...video,
          url: `/api/google-flow/downloads/${encodeURIComponent(video.jobId)}/${encodeURIComponent(video.name)}`,
        })),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/google-flow/downloads/open", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const downloads = await listFlowDownloads(active.id);
      await openFolder(downloads.root);
      res.json({ ok: true, folder: downloads.root });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/google-flow/downloads/:jobId/:fileName", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const filePath = await resolveFlowDownload(active.id, req.params.jobId, req.params.fileName);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Flow video not found.");
      res.setHeader("Cache-Control", "no-store");
      res.type(path.extname(filePath));
      res.sendFile(filePath);
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/jobs", async (req, res) => {
    try {
      const active = await getActiveAccount();
      res.json({
        worker: autonomousWorker.getStatus(),
        jobs: await jobStore.listJobs({ accountId: active.id, type: req.query.type, status: req.query.status, limit: req.query.limit }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    let job;
    try {
      const active = await getActiveAccount();
      const videoName = path.basename(String(req.body?.videoName || ""));
      if (!videoName || videoName !== String(req.body?.videoName || "")) throw new Error("Select a valid pending video.");
      const scheduledAt = new Date(req.body?.scheduledAt);
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 1000) {
        throw new Error("Choose a future date and time.");
      }
      const sourcePath = path.join(getAccountQueueDirs(active.id).tiktok.pending, videoName);
      job = await autonomousWorker.createReservedTikTokJob({
        accountId: active.id,
        sourcePath,
        scheduledAt,
        caption: String(req.body?.caption || "").slice(0, 2200),
        source: "dashboard",
      });
      res.json({ ok: true, job });
    } catch (error) {
      if (job) await jobStore.fail(job.id, error).catch(() => {});
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/jobs/:id/cancel", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const job = await jobStore.getJob(req.params.id);
      if (!job || job.accountId !== active.id) throw new Error("Job not found.");
      await jobStore.beginCancel(job.id, active.id);
      await autonomousWorker.releaseReservation(job);
      res.json({ ok: true, job: await jobStore.finishCancel(job.id, active.id) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/jobs/:id/retry", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const job = await jobStore.getJob(req.params.id);
      if (!job || job.accountId !== active.id) throw new Error("Job not found.");
      if (job.type !== "flow-generate") throw new Error("Failed TikTok posts must be reviewed and re-queued manually to prevent duplicates.");
      const savedVideos = Array.isArray(job.progress?.savedVideos) ? job.progress.savedVideos : [];
      const downloadedFiles = Array.isArray(job.progress?.downloadedFiles) ? job.progress.downloadedFiles : [];
      if (savedVideos.length || downloadedFiles.length) {
        throw new Error("This Flow run already downloaded completed videos before failing. Review the permanent files instead of generating duplicates.");
      }
      const downloads = await listFlowDownloads(active.id);
      if (downloads.videos.some((video) => video.jobId === job.id)) {
        throw new Error("This Flow run already has a permanent video file. Review or remove it before generating a replacement.");
      }
      const children = (await jobStore.listJobs({ accountId: active.id, limit: 500 }))
        .filter((item) => item.payload?.parentJobId === job.id && item.status !== "cancelled");
      if (children.length) throw new Error("This Flow run already created TikTok jobs. Review those jobs instead of generating duplicates.");
      res.json({ ok: true, job: await jobStore.retryJob(job.id, active.id, new Date()) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // TikTok endpoints (profile-aware)

  app.get("/api/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.tiktok.getStatus();
    res.json(status);
  });

  app.post("/api/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.start();
    res.json(result);
  });

  app.post("/api/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.stop();
    res.json(result);
  });

  app.post("/api/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.tiktok.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Settings

  app.post("/api/settings/save", async (req, res) => {
    try {
      const { payload } = req.body || {};
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid payload." });
      }

      const envPath = path.resolve(config.projectRoot, ".env");
      let envContent = "";
      try {
        envContent = await fs.readFile(envPath, "utf-8");
      } catch (err) {
        // file might not exist
      }

      const lines = envContent.split("\n");
      for (const [key, value] of Object.entries(payload)) {
        const envKey = key.toUpperCase();
        if (!SETTINGS_ENV_KEYS.has(envKey)) {
          return res.status(400).json({ ok: false, error: `Unsupported setting: ${envKey}` });
        }

        const serializedValue = serializeEnvValue(value);
        let found = false;

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith(`${envKey}=`)) {
            lines[i] = `${envKey}=${serializedValue}`;
            found = true;
            break;
          }
        }

        if (!found) {
          lines.push(`${envKey}=${serializedValue}`);
        }

        applyRuntimeSetting(envKey, value);
      }

      await fs.writeFile(envPath, lines.join("\n").replace(/\n{2,}/g, "\n"));
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Account endpoints

  app.get("/api/account-manager", async (req, res) => {
    try {
      res.json(await buildManagedAccountsResponse());
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account-manager/create-temp-mail", async (req, res) => {
    try {
      const result = await runSerializedTempAccountCreation(async () => {
        if (!accountVault.isAvailable()) {
          throw new Error("Encrypted account creation requires Windows DPAPI. Run the application on Windows 11.");
        }
        const vaultSnapshot = await accountVault.getSnapshot();
        if (!vaultSnapshot.weeklyAvailability.allowed) {
          throw new Error(`The one-account-per-week limit is active until ${vaultSnapshot.weeklyAvailability.nextAllowedAt}.`);
        }

        const accounts = await getAllAccounts();
        const storedIds = new Set(vaultSnapshot.summaries.map((item) => item.accountId));
        let account = accounts.find((item) => /^TikTok account \d+$/i.test(item.name) && !storedIds.has(item.id));
        if (account) {
          account = await selectAccount(account.id);
        } else {
          account = await addAccount(getNextTikTokAccountName(accounts));
        }
        const password = generateTikTokPassword();
        await accountVault.prepareAccountIfWeeklyAllowed({
          accountId: account.id,
          accountName: account.name,
          tiktokPassword: password,
        });
        await getDaemons(account.id);
        const browser = await startTempMailSetupSession({
          accountId: account.id,
          onCaptured: (credentials) => accountVault.saveTempMail({
            accountId: account.id,
            ...credentials,
          }),
        });
        return { account, browser };
      });
      res.json({
        ok: true,
        ...result,
        manager: await buildManagedAccountsResponse(),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account-manager/open", async (req, res) => {
    try {
      if (!accountVault.isAvailable()) {
        throw new Error("Encrypted account storage requires Windows DPAPI.");
      }
      const account = await requireAccount(req.body?.accountId);
      const stored = await accountVault.getAccount(account.id);
      if (!stored) throw new Error("This account does not have stored temporary email data.");
      await selectAccount(account.id);
      const browser = await startTempMailSetupSession({
        accountId: account.id,
        onCaptured: async (credentials) => {
          if (stored.tempMailEmail && credentials.email !== stored.tempMailEmail) {
            throw new Error("EZ Temp Mail opened a different mailbox. Use the saved recovery key to restore the expected inbox.");
          }
          return accountVault.saveTempMail({ accountId: account.id, ...credentials });
        },
      });
      res.json({ ok: true, account, browser });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account-manager/retry-capture", async (req, res) => {
    try {
      res.json(await retryTempMailCapture());
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account-manager/close", async (req, res) => {
    try {
      res.json(await closeTikTokLoginSession());
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/account-manager/reveal", async (req, res) => {
    try {
      const account = await requireAccount(req.body?.accountId);
      const field = String(req.body?.field || "");
      const value = await accountVault.getSecret(account.id, field);
      res.json({ ok: true, field, value });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/accounts", async (req, res) => {
    const state = await getState();
    const active = await getActiveAccount();
    res.json({ ...state, activeAccount: active });
  });

  app.post("/api/accounts/add", async (req, res) => {
    try {
      const account = await addAccount(req.body?.name);
      // Pre-initialize daemons for the new account
      await getDaemons(account.id);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/select", async (req, res) => {
    try {
      const account = await selectAccount(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/x-autopilot", async (req, res) => {
    try { res.json(await xAutopilot.getStatus((await getActiveAccount()).id)); }
    catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  });
  app.post("/api/x-autopilot/configure", async (req, res) => {
    try { res.json({ ok: true, data: await xAutopilot.configure((await getActiveAccount()).id, req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post("/api/x-autopilot/reference", async (req, res) => {
    try { res.json({ ok: true, data: await xAutopilot.addReference((await getActiveAccount()).id, req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post("/api/x-autopilot/generate", async (req, res) => {
    try { res.json({ ok: true, data: await xAutopilot.generate((await getActiveAccount()).id, req.body?.count) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post("/api/x-autopilot/clear-queue", async (req, res) => {
    try { res.json({ ok: true, data: await xAutopilot.clearQueue((await getActiveAccount()).id) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  // Login endpoints (TikTok)

  app.post("/api/tiktok/login", async (req, res) => {
    try {
      const result = await startTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/tiktok/login/status", async (req, res) => {
    res.json(await getTikTokLoginSessionStatus());
  });

  app.post("/api/tiktok/login/close", async (req, res) => {
    try {
      const result = await closeTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Instagram endpoints (profile-aware)

  app.get("/api/instagram/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.instagram.getStatus();
    res.json(status);
  });

  app.post("/api/instagram/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.start();
    res.json(result);
  });

  app.post("/api/instagram/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.stop();
    res.json(result);
  });

  app.post("/api/instagram/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.instagram.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/instagram/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (Instagram)

  app.post("/api/instagram/login", async (req, res) => {
    try {
      const result = await startInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/instagram/login/status", async (req, res) => {
    res.json(await getInstagramLoginSessionStatus());
  });

  app.post("/api/instagram/login/close", async (req, res) => {
    try {
      const result = await closeInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // YouTube endpoints (profile-aware)

  app.get("/api/youtube/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.youtube.getStatus();
    res.json(status);
  });

  app.post("/api/youtube/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.start();
    res.json(result);
  });

  app.post("/api/youtube/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.stop();
    res.json(result);
  });

  app.post("/api/youtube/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.youtube.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/youtube/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (YouTube)

  app.post("/api/youtube/login", async (req, res) => {
    try {
      const result = await startYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/youtube/login/status", async (req, res) => {
    res.json(await getYouTubeLoginSessionStatus());
  });

  app.post("/api/youtube/login/close", async (req, res) => {
    try {
      const result = await closeYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Overview endpoint (aggregates all profiles)

  app.get("/api/overview", async (req, res) => {
    try {
      const allStatus = await getAllStatus();
      res.json(allStatus);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // First-run setup and health endpoints

  app.get("/api/setup/health", async (req, res) => {
    try {
      res.json(await buildSetupHealth());
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/setup/open-folder", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const folderPath = getAllowedSetupFolderPath(req.body?.key, active.id);
      if (!folderPath) {
        return res.status(400).json({ ok: false, error: "Unsupported setup folder key." });
      }

      await fs.mkdir(folderPath, { recursive: true });
      await openFolder(folderPath);
      res.json({ ok: true, path: folderPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Uniquifier endpoints

  app.get("/api/uniquifier/status", async (req, res) => {
    const status = await uniquifier.getStatus();
    res.json(status);
  });

  app.post("/api/uniquifier/start", async (req, res) => {
    try {
      const { inputDir, outputDir, logoImage } = req.body || {};
      const result = await uniquifier.start({ inputDir, outputDir, logoImage });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/uniquifier/stop", (req, res) => {
    const result = uniquifier.stop();
    res.json(result);
  });

  app.post("/api/uniquifier/open-folder", async (req, res) => {
    try {
      const { kind, folderPath } = req.body || {};
      const status = await uniquifier.getStatus();
      const targetPath =
        folderPath ||
        (kind === "output" ? status.outputDir : kind === "input" ? status.inputDir : null);
      if (!targetPath) {
        return res.status(400).json({ ok: false, error: "Missing folder path or kind." });
      }
      await openFolder(targetPath);
      res.json({ ok: true, path: targetPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Auto-download endpoints
  app.get("/api/autodownload/status", (req, res) => {
    res.json(autoDownloader.getStatus());
  });

  app.post("/api/autodownload/start", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const requestedAccount = req.body?.accountId || active.id;
      await requireAccount(requestedAccount);
      const result = await autoDownloader.start({ accountId: requestedAccount });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/autodownload/stop", (req, res) => {
    const result = autoDownloader.stop();
    res.json(result);
  });

  app.post("/api/autodownload/configure", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const payload = { ...(req.body || {}) };
      if (!payload.accountId) {
        payload.accountId = active.id;
      }
      await requireAccount(payload.accountId);
      const result = await autoDownloader.configure(payload);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Profile download endpoints
  app.get("/api/profile-download/status", (req, res) => {
    res.json(profileDownloader.getStatus());
  });

  app.post("/api/profile-download/start", async (req, res) => {
    try {
      const { channel, minViews, maxVideos, scanOnly } = req.body || {};
      const result = await profileDownloader.start({ channel, minViews, maxVideos, scanOnly });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/profile-download/open-folder", async (req, res) => {
    try {
      const status = profileDownloader.getStatus();
      await openFolder(status.downloadsDir);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  });

  ensureDashboardBindAllowed();
  app.listen(config.dashboardPort, config.dashboardHost, () => {
    console.log(
      `Dashboard running at http://localhost:${config.dashboardPort}`
    );
  });
}

createServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
