const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");
const { ensureAccountDirs } = require("./account-manager");

const QUEUE_ROOT = path.resolve(config.projectRoot, "queue");
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

/**
 * Migrate old flat queue layout to new per-profile structure.
 *
 * Old:  queue/pending/  queue/posted/  queue/failed/
 *       queue/instagram/pending/  queue/instagram/posted/  queue/instagram/failed/
 *       queue/youtube/pending/    queue/youtube/posted/    queue/youtube/failed/
 *
 * New:  queue/default/tiktok/pending/  ...
 *       queue/default/instagram/pending/  ...
 *       queue/default/youtube/pending/  ...
 */
async function migrateQueueIfNeeded() {
    // Check if migration is needed: old layout has queue/pending as a direct child
    const oldPendingDir = path.resolve(QUEUE_ROOT, "pending");
    const newDefaultDir = path.resolve(QUEUE_ROOT, "default", "tiktok");

    let needsMigration = false;
    try {
        const stat = await fs.stat(oldPendingDir);
        if (stat.isDirectory()) {
            needsMigration = true;
        }
    } catch {
        // No old pending dir = no migration needed
    }

    // Also check if old instagram/ youtube dirs exist at queue level
    const oldIgDir = path.resolve(QUEUE_ROOT, "instagram");
    const oldYtDir = path.resolve(QUEUE_ROOT, "youtube");

    let hasOldIg = false;
    let hasOldYt = false;
    try {
        const stat = await fs.stat(path.resolve(oldIgDir, "pending"));
        hasOldIg = stat.isDirectory();
    } catch { }
    try {
        const stat = await fs.stat(path.resolve(oldYtDir, "pending"));
        hasOldYt = stat.isDirectory();
    } catch { }

    if (!needsMigration && !hasOldIg && !hasOldYt) {
        return { migrated: false, reason: "No old layout detected" };
    }

    console.log("[migrate] Old queue layout detected. Migrating to per-profile structure...");

    // Ensure new default dirs exist
    await ensureAccountDirs("default");

    const moved = { tiktok: 0, instagram: 0, youtube: 0 };

    // Migrate TikTok: queue/pending -> queue/default/tiktok/pending
    if (needsMigration) {
        for (const sub of ["pending", "posted", "failed"]) {
            const src = path.resolve(QUEUE_ROOT, sub);
            const dst = path.resolve(QUEUE_ROOT, "default", "tiktok", sub);
            moved.tiktok += await moveFiles(src, dst);
        }
    }

    // Migrate Instagram: queue/instagram/pending -> queue/default/instagram/pending
    if (hasOldIg) {
        for (const sub of ["pending", "posted", "failed"]) {
            const src = path.resolve(oldIgDir, sub);
            const dst = path.resolve(QUEUE_ROOT, "default", "instagram", sub);
            moved.instagram += await moveFiles(src, dst);
        }
    }

    // Migrate YouTube: queue/youtube/pending -> queue/default/youtube/pending  
    if (hasOldYt) {
        for (const sub of ["pending", "posted", "failed"]) {
            const src = path.resolve(oldYtDir, sub);
            const dst = path.resolve(QUEUE_ROOT, "default", "youtube", sub);
            moved.youtube += await moveFiles(src, dst);
        }
    }

    // Clean up empty old directories
    await cleanupOldDirs();

    console.log(`[migrate] Done. Moved: TikTok=${moved.tiktok}, Instagram=${moved.instagram}, YouTube=${moved.youtube}`);
    return { migrated: true, moved };
}

async function moveFiles(srcDir, dstDir) {
    let count = 0;
    try {
        const entries = await fs.readdir(srcDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const srcPath = path.resolve(srcDir, entry.name);
            const dstPath = path.resolve(dstDir, entry.name);
            try {
                await fs.rename(srcPath, dstPath);
                count++;
            } catch (err) {
                // If rename fails (cross-device), copy + delete
                try {
                    await fs.copyFile(srcPath, dstPath);
                    await fs.unlink(srcPath);
                    count++;
                } catch (copyErr) {
                    console.warn(`[migrate] Failed to move ${entry.name}: ${copyErr.message}`);
                }
            }
        }
    } catch {
        // Source dir doesn't exist, nothing to move
    }
    return count;
}

async function cleanupOldDirs() {
    // Remove old flat dirs if they're now empty
    const dirsToClean = [
        path.resolve(QUEUE_ROOT, "pending"),
        path.resolve(QUEUE_ROOT, "posted"),
        path.resolve(QUEUE_ROOT, "failed"),
        path.resolve(QUEUE_ROOT, "instagram", "pending"),
        path.resolve(QUEUE_ROOT, "instagram", "posted"),
        path.resolve(QUEUE_ROOT, "instagram", "failed"),
        path.resolve(QUEUE_ROOT, "instagram"),
        path.resolve(QUEUE_ROOT, "youtube", "pending"),
        path.resolve(QUEUE_ROOT, "youtube", "posted"),
        path.resolve(QUEUE_ROOT, "youtube", "failed"),
        path.resolve(QUEUE_ROOT, "youtube"),
    ];

    for (const dir of dirsToClean) {
        try {
            const entries = await fs.readdir(dir);
            if (entries.length === 0) {
                await fs.rmdir(dir);
                console.log(`[migrate] Removed empty dir: ${path.relative(QUEUE_ROOT, dir)}`);
            }
        } catch {
            // Dir doesn't exist or not empty, skip
        }
    }
}

module.exports = { migrateQueueIfNeeded };
