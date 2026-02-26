'use strict';

const https = require('https');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');
const { initSchema, upsertTrademark } = require('./db');

const REEDTECH_URL = 'https://trademarks.reedtech.com/tmappxml.php';

function log(...args) {
  console.log('[loader]', ...args);
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          'user-agent': 'trademarkyo-loader',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    ).on('error', reject);
  });
}

async function getLatestZipUrl() {
  log('Fetching ReedTech file list...');
  const htmlBuffer = await fetch(REEDTECH_URL);
  const html = htmlBuffer.toString();

  const matches = [...html.matchAll(/href="(apc\d+\.zip)"/gi)];

  if (!matches.length) {
    throw new Error('No zip files found on ReedTech page');
  }

  const files = matches.map((m) => m[1]);

  files.sort((a, b) => {
    const na = parseInt(a.replace(/\D/g, ''), 10);
    const nb = parseInt(b.replace(/\D/g, ''), 10);
    return nb - na;
  });

  const latest = files[0];
  log('Latest file:', latest);

  return `https://trademarks.reedtech.com/${latest}`;
}

async function processZip(url) {
  log('Downloading:', url);
  const zipBuffer = await fetch(url);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  log('Files in ZIP:', entries.length);

  for (const entry of entries) {
    if (!entry.entryName.endsWith('.xml')) continue;

    const xml = entry.getData().toString();

    const parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: false,
      mergeAttrs: true,
    });

    const apps =
      parsed?.uspto_tm_applications?.uspto_tm_application || [];

    const list = Array.isArray(apps) ? apps : [apps];

    for (const app of list) {
      const markName =
        app?.mark_identification || app?.markIdentification || null;
      const serial =
        app?.serial_number || app?.serialNumber || null;
      const status =
        app?.status || app?.status_code || null;
      const classes =
        app?.classification?.international_class ||
        app?.classification?.internationalClass ||
        null;

      if (!markName || !serial) continue;

      await upsertTrademark({
        serial_number: serial,
        mark_name: markName,
        status,
        international_class: classes
          ? JSON.stringify(classes)
          : null,
      });
    }
  }
}

async function run() {
  try {
    await initSchema();

    const latestZipUrl = await getLatestZipUrl();
    await processZip(latestZipUrl);

    log('Loader complete.');
    process.exit(0);
  } catch (e) {
    console.error('[loader] ERROR:', e.message);
    process.exit(1);
  }
}

run();
