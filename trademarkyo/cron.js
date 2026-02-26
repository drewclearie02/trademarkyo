'use strict';

/**
 * Cron job — runs daily at 2am to pull latest USPTO trademark data
 * This file is required by server.js on startup
 */

const cron = require('node-cron');

let isRunning = false;

function startCron() {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    if (isRunning) {
      console.log('[cron] Skipping — loader already running');
      return;
    }
    isRunning = true;
    console.log('[cron] Starting daily USPTO trademark update...');
    try {
      // Dynamically require so it runs fresh each time
      const { execSync } = require('child_process');
      execSync('node loader.js daily', {
        cwd: __dirname,
        stdio: 'inherit',
        timeout: 30 * 60 * 1000, // 30 min max
        env: { ...process.env },
      });
      console.log('[cron] Daily update complete');
    } catch (e) {
      console.error('[cron] Daily update failed:', e.message);
    } finally {
      isRunning = false;
    }
  });

  console.log('[cron] Scheduled daily USPTO update at 2:00 AM');
}

module.exports = { startCron };
