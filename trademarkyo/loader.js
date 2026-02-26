'use strict';

/**
 * USPTO Trademark Bulk Data Loader
 * Uses the confirmed API endpoint from USPTO Open Data Portal
 */

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { parseStringPromise } = require('xml2js');
const unzipper = require('unzipper');
const { Pool } = require('pg');

const USPTO_API_KEY = process.env.USPTO_API_KEY || '';
const DATABASE_URL  = process.env.DATABASE_URL  || '';
const TMP_DIR = '/tmp/tyo_loader';

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 5,
});

function log(msg) { console.log(`[loader] ${new Date().toISOString()} — ${msg}`); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGetJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'trademarkyo/1.0',
      'Accept': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGetJson(res.headers.location, apiKey).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function downloadFile(url, dest, apiKey) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'trademarkyo/1.0' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, apiKey).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// ── File discovery ─────────────────────────────────────────────────────────────

function getDateRange(mode) {
  const today = new Date();
  const to = today.toISOString().split('T')[0];
  let from;
  if (mode === 'full') {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() - 2);
    from = d.toISOString().split('T')[0];
  } else if (mode === 'daily') {
    const d = new Date(today);
    d.setDate(d.getDate() - 2); // go back 2 days to catch yesterday reliably
    from = d.toISOString().split('T')[0];
  } else {
    const d = new Date(today);
    d.setDate(d.getDate() - 14);
    from = d.toISOString().split('T')[0];
  }
  return { from, to };
}

async function getFileList(mode) {
  const { from, to } = getDateRange(mode);
  log(`Fetching file list: ${from} to ${to}`);

  // Primary: confirmed working UI API endpoint
  const url = `https://data.uspto.gov/ui/datasets/products/trtdxfap?includeFiles=true&fileDataFromDate=${from}&fileDataToDate=${to}`;
  log(`Trying: ${url}`);

  try {
    const { status, body } = await httpGetJson(url, USPTO_API_KEY);
    log(`Response: ${status}, length: ${body.length}`);

    if (status === 200 && body.length > 10) {
      const data = JSON.parse(body);

      // Extract files from response — try multiple known shapes
      let files = [];
      if (Array.isArray(data?.productFiles)) files = data.productFiles;
      else if (Array.isArray(data?.files)) files = data.files;
      else if (Array.isArray(data?.bulkFiles)) files = data.bulkFiles;
      else if (Array.isArray(data?.results)) files = data.results;
      else if (Array.isArray(data)) files = data;

      log(`Raw response keys: ${Object.keys(data || {}).join(', ')}`);
      log(`Files found: ${files.length}`);

      if (files.length > 0) {
        const result = files.map(f => ({
          fileName: f.fileName || f.name || f.fileTitle || f.title || '',
          downloadUrl: f.fileDownloadUrl || f.downloadUrl || f.url || f.href || f.fileUrl || '',
        })).filter(f => f.downloadUrl);
        log(`Files with download URLs: ${result.length}`);
        return result;
      }

      // Log the full response structure so we can debug further if still empty
      log(`Full response sample: ${body.slice(0, 500)}`);
    } else {
      log(`Bad response: ${status} — ${body.slice(0, 200)}`);
    }
  } catch (e) {
    log(`Primary API error: ${e.message}`);
  }

  // Fallback: official API endpoint from the "API Query" button on the ODP page
  const apiUrl = `https://api.uspto.gov/api/v1/datasets/products/trtdxfap?fileDataFromDate=${from}&fileDataToDate=${to}&includeFiles=true`;
  log(`Trying official API: ${apiUrl}`);

  try {
    const { status, body } = await httpGetJson(apiUrl, USPTO_API_KEY);
    log(`Official API response: ${status}, length: ${body.length}`);

    if (status === 200 && body.length > 10) {
      const data = JSON.parse(body);
      let files = data?.productFiles || data?.files || data?.bulkFiles || data?.results || [];
      if (!Array.isArray(files)) files = [];

      log(`Official API files: ${files.length}`);
      log(`Official API sample: ${body.slice(0, 500)}`);

      if (files.length > 0) {
        return files.map(f => ({
          fileName: f.fileName || f.name || '',
          downloadUrl: f.fileDownloadUrl || f.downloadUrl || f.url || '',
        })).filter(f => f.downloadUrl);
      }
    }
  } catch (e) {
    log(`Official API error: ${e.message}`);
  }

  log('No files found from any source');
  return [];
}

// ── XML Parsing ────────────────────────────────────────────────────────────────

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (Array.isArray(node)) return extractText(node[0]);
  if (typeof node === 'object' && node._) return String(node._).trim();
  return String(node).trim();
}

function extractRecord(cf) {
  try {
    const sn = extractText(
      cf['serial-number'] || cf.serialNumber || cf['application-serial-number']
    );
    if (!sn || sn.length < 5) return null;

    const header = cf['case-file-header'] || cf.header || {};
    const markName = extractText(
      header['mark-identification'] || cf['mark-identification'] ||
      cf['word-mark'] || header['mark-text']
    ).toUpperCase();
    if (!markName) return null;

    const statusCode = extractText(header['status-code'] || header['filing-status'] || '');
    const deadCodes = ['600','601','602','603','604','700','710','800'];
    const isLive = !deadCodes.some(c => statusCode.includes(c));

    let owner = '';
    try {
      const owners = cf['case-file-owners']?.['case-file-owner'] || [];
      const arr = Array.isArray(owners) ? owners : [owners];
      owner = extractText(arr[0]?.['party-name'] || arr[0]?.['entity-name'] || '').slice(0, 255);
    } catch {}

    let goodsServices = '';
    try {
      const stmts = cf['case-file-statements']?.['case-file-statement'] || [];
      const arr = Array.isArray(stmts) ? stmts : [stmts];
      goodsServices = arr.map(s => extractText(s?.text || '')).filter(Boolean).join('; ').slice(0, 2000);
    } catch {}

    let intClass = '';
    try {
      const cls = cf?.classifications?.classification || [];
      const arr = Array.isArray(cls) ? cls : [cls];
      intClass = arr.map(c => extractText(c?.['international-code'] || '')).filter(Boolean).join(',').slice(0, 50);
    } catch {}

    return {
      serial_number: sn.replace(/\D/g, '').slice(0, 20),
      mark_name: markName.slice(0, 500),
      owner: owner || null,
      status: isLive ? 'LIVE' : 'DEAD',
      goods_services: goodsServices || null,
      int_class: intClass || null,
      filing_date: extractText(header['filing-date'] || '').replace(/\D/g, '').slice(0, 20) || null,
      reg_date: extractText(header['registration-date'] || '').replace(/\D/g, '').slice(0, 20) || null,
    };
  } catch { return null; }
}

function findCaseFiles(obj, depth = 0) {
  if (depth > 4 || !obj || typeof obj !== 'object') return [];
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'case-file') return Array.isArray(val) ? val : [val];
    const found = findCaseFiles(val, depth + 1);
    if (found.length) return found;
  }
  return [];
}

async function parseXml(content) {
  const records = [];
  try {
    const parsed = await parseStringPromise(content, {
      explicitArray: false, mergeAttrs: false, trim: true,
    });
    const caseFiles = findCaseFiles(parsed);
    for (const cf of caseFiles) {
      const rec = extractRecord(cf);
      if (rec) records.push(rec);
    }
  } catch (e) {
    log(`XML parse error: ${e.message}`);
  }
  return records;
}

async function processZip(zipPath) {
  const records = [];
  const dir = await unzipper.Open.file(zipPath);
  for (const entry of dir.files) {
    if (entry.type === 'Directory' || !entry.path.toLowerCase().endsWith('.xml')) continue;
    try {
      const buf = await entry.buffer();
      const parsed = await parseXml(buf.toString('utf8'));
      records.push(...parsed);
      log(`  ${entry.path}: ${parsed.length} records`);
    } catch (e) {
      log(`  Failed ${entry.path}: ${e.message}`);
    }
  }
  return records;
}

// ── DB upsert ──────────────────────────────────────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trademarks (
      serial_number VARCHAR(20) PRIMARY KEY,
      mark_name TEXT NOT NULL, owner TEXT, status VARCHAR(10),
      goods_services TEXT, int_class VARCHAR(50),
      filing_date VARCHAR(20), reg_date VARCHAR(20),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tm_mark_lower ON trademarks (lower(mark_name));
    CREATE INDEX IF NOT EXISTS idx_tm_status ON trademarks (status);
    CREATE TABLE IF NOT EXISTS loader_log (
      id SERIAL PRIMARY KEY, run_date TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20), records_processed INTEGER DEFAULT 0, message TEXT
    );
  `);
}

async function upsertRecords(records) {
  if (!records.length) return 0;
  const client = await pool.connect();
  let count = 0;
  try {
    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH).filter(r => r.serial_number && r.mark_name);
      if (!batch.length) continue;
      const vals = batch.map((_, j) => {
        const b = j * 8;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},NOW())`;
      }).join(',');
      const params = batch.flatMap(r => [
        r.serial_number, r.mark_name, r.owner, r.status,
        r.goods_services, r.int_class, r.filing_date, r.reg_date
      ]);
      await client.query(`
        INSERT INTO trademarks
          (serial_number,mark_name,owner,status,goods_services,int_class,filing_date,reg_date,updated_at)
        VALUES ${vals}
        ON CONFLICT (serial_number) DO UPDATE SET
          mark_name=EXCLUDED.mark_name, owner=EXCLUDED.owner, status=EXCLUDED.status,
          goods_services=EXCLUDED.goods_services, int_class=EXCLUDED.int_class,
          filing_date=EXCLUDED.filing_date, reg_date=EXCLUDED.reg_date, updated_at=NOW()
      `, params);
      count += batch.length;
    }
  } finally {
    client.release();
  }
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(mode) {
  log(`Starting — mode: ${mode}`);
  let total = 0;

  try {
    await ensureSchema();

    const files = await getFileList(mode);

    if (!files.length) {
      log('No files found');
      await pool.query(
        `INSERT INTO loader_log (status,records_processed,message) VALUES ('no_files',0,'No files available')`
      );
      return;
    }

    log(`Processing ${files.length} file(s)...`);

    for (const { fileName, downloadUrl } of files) {
      const tmpPath = path.join(TMP_DIR, fileName || `dl_${Date.now()}.zip`);
      try {
        log(`Downloading: ${fileName}`);
        await downloadFile(downloadUrl, tmpPath, USPTO_API_KEY);
        const mb = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1);
        log(`Downloaded: ${fileName} (${mb} MB)`);

        const records = await processZip(tmpPath);
        log(`Parsed: ${records.length} records`);

        if (records.length > 0) {
          const n = await upsertRecords(records);
          total += n;
          log(`Upserted: ${n} — total: ${total}`);
        }
      } catch (e) {
        log(`Failed on ${fileName}: ${e.message}`);
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      }
    }

    await pool.query(
      `INSERT INTO loader_log (status,records_processed,message) VALUES ('success',$1,$2)`,
      [total, `Loaded ${total} records (${mode} mode)`]
    );
    log(`Done — ${total} total records`);

  } catch (e) {
    log(`Fatal: ${e.message}`);
    try {
      await pool.query(
        `INSERT INTO loader_log (status,records_processed,message) VALUES ('error',0,$1)`,
        [e.message]
      );
    } catch {}
  } finally {
    await pool.end();
  }
}

const mode = process.argv[2] || 'incremental';
run(mode).catch(e => { console.error('[loader] Unhandled:', e.message); process.exit(0); });
