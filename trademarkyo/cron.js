'use strict';

const cron = require('node-cron');
const { spawn } = require('child_process');

let isRunning = false;

function startCron() {
  // Every day at 2:00 AM UTC
  cron.schedule('0 2 * * *', () => {
    if (isRunning) {
      console.log('[cron] Skipping — loader already running');
      return;
    }
    isRunning = true;
    console.log('[cron] Starting daily USPTO update...');

    const child = spawn(process.execPath, ['loader.js', 'daily'], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', d => console.log(`[cron:loader] ${String(d).trimEnd()}`));
    child.stderr.on('data', d => console.error(`[cron:loader] ${String(d).trimEnd()}`));
    child.on('exit', code => {
      console.log(`[cron] Loader exited code=${code}`);
      isRunning = false;
    });
  });

  console.log('[cron] Daily USPTO update scheduled at 2:00 AM UTC');
}

module.exports = { startCron };
