const path = require("path");
const { config } = require("./config");
const { DaemonController } = require("./daemon-controller");
const { InstagramDaemonController } = require("./instagram-daemon-controller");
const { YouTubeDaemonController } = require("./youtube-daemon-controller");
const { getAccountQueueDirs, ensureAccountDirs } = require("./account-manager");

/**
 * Central registry that manages per-profile daemon controller instances.
 * Each profile gets its own set of 3 daemon controllers (tiktok, instagram, youtube)
 * so they can run concurrently across profiles.
 *
 * Map<accountId, { tiktok, instagram, youtube }>
 */
const registry = new Map();

function getStateDir(accountId) {
    return path.resolve(config.projectRoot, ".scheduler-state", accountId);
}

/**
 * Get (or lazily create) the daemon controllers for a specific account.
 */
async function getDaemons(accountId) {
    if (registry.has(accountId)) {
        return registry.get(accountId);
    }

    // Ensure queue directories exist
    const dirs = await ensureAccountDirs(accountId);
    const queueDirs = getAccountQueueDirs(accountId);
    const stateDir = getStateDir(accountId);

    // Ensure state directory exists
    const fs = require("fs/promises");
    await fs.mkdir(stateDir, { recursive: true });

    const daemons = {
        tiktok: new DaemonController({
            accountId,
            queueDir: queueDirs.tiktok.pending,
            postedDir: queueDirs.tiktok.posted,
            failedDir: queueDirs.tiktok.failed,
            statePath: path.resolve(stateDir, "tiktok-scheduler-state.json"),
        }),
        instagram: new InstagramDaemonController({
            accountId,
            queueDir: queueDirs.instagram.pending,
            postedDir: queueDirs.instagram.posted,
            failedDir: queueDirs.instagram.failed,
            statePath: path.resolve(stateDir, "instagram-scheduler-state.json"),
        }),
        youtube: new YouTubeDaemonController({
            accountId,
            queueDir: queueDirs.youtube.pending,
            postedDir: queueDirs.youtube.posted,
            failedDir: queueDirs.youtube.failed,
            statePath: path.resolve(stateDir, "youtube-scheduler-state.json"),
        }),
    };

    for (const daemon of Object.values(daemons)) {
        daemon.resumeIfNeeded();
    }
    registry.set(accountId, daemons);
    return daemons;
}

/**
 * Get status for all registered profiles (for overview dashboard).
 */
async function getAllStatus() {
    const results = {};
    for (const [accountId, daemons] of registry) {
        results[accountId] = {
            tiktok: await daemons.tiktok.getStatus(),
            instagram: await daemons.instagram.getStatus(),
            youtube: await daemons.youtube.getStatus(),
        };
    }
    return results;
}

/**
 * Get all registered account IDs.
 */
function getRegisteredAccountIds() {
    return Array.from(registry.keys());
}

module.exports = {
    getDaemons,
    getAllStatus,
    getRegisteredAccountIds,
};
