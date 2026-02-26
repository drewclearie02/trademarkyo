'use strict';

/**
 * Cron job — runs daily to pull latest USPTO trademark data
 * Required by server.js on startup
 *
 * NOTE:
 * - node-cron runs in the server timezone. Railway is typically UTC.
 * - If you want 2am Eastern, set env TZ=America/New_York in Railway.
 */

const cron = require('node-cron');
const { spawn } = require('child_process');

let isRunning = false;

function startCron() {
  // Every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    if (isRunning) {
      console.log('[cron] Skipping — loader already running');
      return;
    }

    isRunning = true;
    console.log('[cron] Starting daily USPTO update (ODP latest files)...');

    try {
      const child = spawn(process.execPath, ['loader.js', 'daily'], {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (d) => console.log(`[cron:loader] ${String(d).trimEnd()}`));
      child.stderr.on('data', (d) => console.error(`[cron:loader] ${String(d).trimEnd()}`));

      child.on('exit', (code) => {
        console.log(`[cron] Loader exited code=${code}`);
        isRunning = false;
      });

    } catch (e) {
      console.error('[cron] Daily update failed:', e.message);
      isRunning = false;
    }
  });

  console.log('[cron] Scheduled daily USPTO update at 2:00 AM');
}

module.exports = { startCron };
