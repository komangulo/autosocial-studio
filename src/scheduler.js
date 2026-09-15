const cron = require("node-cron");
const { config } = require("./config");
const { postNextFromQueue } = require("./post-service");

function now() {
  return new Date().toISOString();
}

async function runScheduledPost() {
  console.log(`[${now()}] Checking queue...`);
  const result = await postNextFromQueue();
  if (result.skipped) {
    console.log(`[${now()}] ${result.reason}`);
    return;
  }

  if (result.ok) {
    console.log(`[${now()}] Posted successfully: ${result.movedVideo}`);
  } else {
    console.error(`[${now()}] Post failed: ${result.error}`);
    if (result.screenshotPath) {
      console.error(`[${now()}] Screenshot: ${result.screenshotPath}`);
    }
  }
}

function startDaemon() {
  if (!cron.validate(config.cronExpression)) {
    throw new Error(`Invalid CRON_EXPRESSION: ${config.cronExpression}`);
  }

  console.log(`Starting scheduler: ${config.cronExpression} (${config.timezone})`);
  console.log("Press Ctrl+C to stop.");

  cron.schedule(
    config.cronExpression,
    async () => {
      await runScheduledPost();
    },
    {
      timezone: config.timezone,
    }
  );
}

module.exports = {
  startDaemon,
  runScheduledPost,
};
