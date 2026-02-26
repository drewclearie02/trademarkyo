'use strict';

/**
 * USPTO Trademark Bulk Data Loader
 *
 * Downloads daily trademark XML files from USPTO/Reed Tech and loads into PostgreSQL.
 *
 * Daily files follow the naming pattern: apc######.zip (applications)
 * where ###### is a sequential number, newest files last.
 *
 * Usage:
 *   node loader.js full     — scrape available files and load recent ones
 *   node loader.js daily    — load yesterday's file only
 *   node loader.js          — load last 30 days
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;
const TMP_DIR = path.join('/tmp', 'tyo_loader');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
});

function log(msg) {
  console.log(`[loader] ${new Date().toISOString()} — ${msg}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGetText(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = protocol.get(url, { timeout: 300000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
      res.on('error', reject);
    });
    req.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── File discovery ────────────────────────────────────────────────────────────

/**
 * Scrape Reed Tech's trademark application XML page for download links.
 * Falls back to USPTO SOMS if Reed Tech fails.
 */
async function getAvailableFiles(limit = 30) {
  const sources = [
    'http://trademarks.reedtech.com/tmappxml.php',
    'https://eipweb.uspto.gov/SOMS/',
  ];

  for (const url of sources) {
    try {
      log(`Fetching file list from: ${url}`);
      const { status, body } = await httpGetText(url);
      log(`Response: ${status}, body length: ${body.length}`);

      if (status !== 200) continue;

      // Parse out .zip download links
      const zipLinks = [];
      const patterns = [
        /href="([^"]*apc\d+\.zip[^"]*)"/gi,
        /href="([^"]*\.zip[^"]*)"/gi,
        /"(https?:\/\/[^"]*\.zip)"/gi,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(body)) !== null) {
          let href = match[1];
          if (!href.startsWith('http')) {
            const base = new URL(url);
            href = `${base.protocol}//${base.host}${href.startsWith('/') ? '' : '/'}${href}`;
          }
          zipLinks.push(href);
        }
        if (zipLinks.length > 0) break;
      }

      // Dedupe
      const unique = [...new Set(zipLinks)];
      log(`Found ${unique.length} zip files at ${url}`);

      if (unique.length > 0) {
        // Return most recent N files
        return unique.slice(-limit).map(u => ({
          downloadUrl: u,
          fileName: u.split('/').pop(),
        }));
      }
    } catch (e) {
      log(`Source ${url} failed: ${e.message}`);
    }
  }

  // If both sources fail, try the Open Data Portal API
  log('Trying Open Data Portal API...');
  try {
    const apiUrl = 'https://data.uspto.gov/api/v1/dataset/TRTDXFAP/bulkfiles?pageSize=30&sortBy=date&sortOrder=desc';
    const { status, body } = await httpGetText(apiUrl);
    log(`ODP API: ${status} — ${body.slice(0, 200)}`);
    if (status === 200) {
      const data = JSON.parse(body);
      const files = (data?.bulkFiles || data?.files || data?.results || []);
      return files.map(f => ({
        downloadUrl: f.downloadUrl || f.url || f.fileUrl,
        fileName: f.fileName || f.name,
      })).filter(f => f.downloadUrl);
    }
  } catch (e) {
    log(`ODP API failed: ${e.message}`);
  }

  return [];
}

// ── XML parsing ───────────────────────────────────────────────────────────────

async function parseXmlFile(filePath) {
  const records = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = await parseStringPromise(content, {
      explicitArray: false,
      ignoreAttrs: false,
      trim: true,
    });

    const caseFiles = findCaseFiles(parsed);
    log(`  Parsing ${caseFiles.length} trademark cases`);

    for (const cf of caseFiles) {
      const rec = extractRecord(cf);
      if (rec) records.push(rec);
    }
  } catch (e) {
    log(`  XML parse error: ${e.message}`);
  }
  return records;
}

function findCaseFiles(root) {
  if (!root || typeof root !== 'object') return [];

  // Try known paths
  const tries = [
    root?.['trademark-applications-daily']?.['application-information']?.['case-file'],
    root?.['trademark-registrations-daily']?.['registration-information']?.['case-file'],
    root?.['case-file'],
  ];

  for (const t of tries) {
    if (t) return Array.isArray(t) ? t : [t];
  }

  // Deep search
  for (const v of Object.values(root)) {
    if (v && typeof v === 'object') {
      const found = findCaseFiles(v);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function extractRecord(cf) {
  try {
    const sn = cf?.['serial-number'] || cf?.serialNumber;
    if (!sn) return null;

    const header = cf?.['case-file-header'] || {};
    const markText = (
      header?.['mark-identification'] ||
      cf?.['mark-identification'] ||
      cf?.['word-mark'] || ''
    ).trim().toUpperCase();

    if (!markText) return null;

    const statusCode = String(header?.['status-code'] || header?.['filing-status'] || '');
    const isLive = !['600','601','602','603','604','700','800','DEAD','ABANDONED','CANCELLED','EXPIRED']
      .some(c => statusCode.toUpperCase().includes(c));

    return {
      serial_number: String(sn).replace(/\D/g, ''),
      mark_name: markText,
      owner: extractOwner(cf),
      status: isLive ? 'LIVE' : 'DEAD',
      goods_services: extractGoods(cf),
      int_class: extractClass(cf),
      filing_date: String(header?.['filing-date'] || '').replace(/\D/g, '') || null,
      reg_date: String(header?.['registration-date'] || '').replace(/\D/g, '') || null,
    };
  } catch { return null; }
}

function extractOwner(cf) {
  try {
    const parties = cf?.['case-file-owners']?.['case-file-owner'] || [];
    const arr = Array.isArray(parties) ? parties : [parties];
    const first = arr[0];
    return String(first?.['party-name'] || first?.['entity-name'] || '').slice(0, 255) || null;
  } catch { return null; }
}

function extractGoods(cf) {
  try {
    const gs = cf?.['case-file-statements']?.['case-file-statement'] || [];
    const arr = Array.isArray(gs) ? gs : [gs];
    return arr.map(g => g?.['text'] || '').filter(Boolean).join('; ').slice(0, 2000) || null;
  } catch { return null; }
}

function extractClass(cf) {
  try {
    const cls = cf?.['classifications']?.['classification'] ||
                cf?.['case-file-class-numbers']?.['class-number'] || [];
    const arr = Array.isArray(cls) ? cls : [cls];
    return arr.map(c => c?.['international-code'] || c?.['class-number'] || String(c)).filter(Boolean).join(',').slice(0, 50) || null;
  } catch { return null; }
}

// ── Database ─────────────────────────────────────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trademarks (
      serial_number VARCHAR(20) PRIMARY KEY,
      mark_name     TEXT NOT NULL,
      owner         TEXT,
      status        VARCHAR(10),
      goods_services TEXT,
      int_class     VARCHAR(50),
      filing_date   VARCHAR(20),
      reg_date      VARCHAR(20),
      updated_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tm_mark_lower ON trademarks (lower(mark_name));
    CREATE INDEX IF NOT EXISTS idx_tm_status     ON trademarks (status);
    CREATE TABLE IF NOT EXISTS loader_log (
      id         SERIAL PRIMARY KEY,
      run_date   TIMESTAMP DEFAULT NOW(),
      status     VARCHAR(20),
      records_processed INTEGER DEFAULT 0,
      message    TEXT
    );
  `);
}

async function upsertBatch(records) {
  if (!records.length) return 0;
  const client = await pool.connect();
  let count = 0;
  try {
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE).filter(r => r.serial_number && r.mark_name);
      if (!batch.length) continue;
      const vals = batch.map((_, j) => {
        const b = j * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},NOW())`;
      }).join(',');
      const params = batch.flatMap(r => [r.serial_number, r.mark_name, r.owner, r.status, r.goods_services, r.int_class, r.filing_date, r.reg_date]);
      await client.query(`
        INSERT INTO trademarks (serial_number,mark_name,owner,status,goods_services,int_class,filing_date,reg_date,updated_at)
        VALUES ${vals}
        ON CONFLICT (serial_number) DO UPDATE SET
          mark_name=EXCLUDED.mark_name, owner=EXCLUDED.owner, status=EXCLUDED.status,
          goods_services=EXCLUDED.goods_services, int_class=EXCLUDED.int_class,
          filing_date=EXCLUDED.filing_date, reg_date=EXCLUDED.reg_date, updated_at=NOW()
      `, params);
      count += batch.length;
    }
  } finally { client.release(); }
  return count;
}

// ── Zip extraction ────────────────────────────────────────────────────────────

async function processZip(zipPath) {
  const AdmZip = require('adm-zip');
  const records = [];
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml'));
    for (const entry of entries) {
      const tmpXml = path.join(TMP_DIR, `tmp_${Date.now()}.xml`);
      try {
        fs.writeFileSync(tmpXml, entry.getData().toString('utf8'));
        const parsed = await parseXmlFile(tmpXml);
        records.push(...parsed);
      } finally {
        if (fs.existsSync(tmpXml)) fs.unlinkSync(tmpXml);
      }
    }
  } catch (e) {
    log(`  Zip error: ${e.message}`);
  }
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runLoader(mode = 'incremental') {
  log(`Starting — mode: ${mode}`);
  let total = 0;

  try {
    await ensureSchema();

    const limit = mode === 'full' ? 60 : mode === 'daily' ? 1 : 10;
    const files = await getAvailableFiles(limit);

    if (files.length === 0) {
      log('No files found. Logging and exiting gracefully.');
      await pool.query(`INSERT INTO loader_log (status,records_processed,message) VALUES ('no_files',0,'No files available from USPTO sources')`);
      return;
    }

    log(`Processing ${files.length} files...`);

    for (const file of files) {
      const url = file.downloadUrl;
      const name = file.fileName || url.split('/').pop();
      if (!url) { log(`Skipping file with no URL`); continue; }

      const tmpZip = path.join(TMP_DIR, name);
      try {
        log(`Downloading: ${name}`);
        await downloadFile(url, tmpZip);
        const sizeMb = (fs.statSync(tmpZip).size / 1024 / 1024).toFixed(1);
        log(`Downloaded: ${name} (${sizeMb} MB)`);

        const records = await processZip(tmpZip);
        log(`  Extracted ${records.length} records`);

        if (records.length > 0) {
          const n = await upsertBatch(records);
          total += n;
          log(`  Upserted ${n} records (running total: ${total})`);
        }
      } catch (e) {
        log(`  Failed: ${name} — ${e.message}`);
      } finally {
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
      }
    }

    await pool.query(`INSERT INTO loader_log (status,records_processed,message) VALUES ('success',$1,$2)`, [total, `Loaded ${total} records`]);
    log(`Done — ${total} total records`);

  } catch (e) {
    log(`Fatal: ${e.message}`);
    try { await pool.query(`INSERT INTO loader_log (status,records_processed,message) VALUES ('error',0,$1)`, [e.message]); } catch {}
  } finally {
    await pool.end();
  }
}

const mode = process.argv[2] || 'incremental';
runLoader(mode).catch(e => {
  console.error('[loader] Unhandled error:', e.message);
  process.exit(0); // exit 0 so && node server.js still runs
});
