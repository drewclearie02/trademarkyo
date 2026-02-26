'use strict';

/**
 * USPTO Trademark Bulk Data Loader
 *
 * Downloads daily trademark XML files from USPTO Open Data Portal
 * and loads them into PostgreSQL.
 *
 * Usage:
 *   node loader.js full    — loads up to 60 recent files (~2 years)
 *   node loader.js daily   — loads yesterday's file only
 *   node loader.js         — loads last 10 files (~2 weeks)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = { headers: { 'User-Agent': 'trademarkyo/1.0', ...headers } };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
    req.on('error', reject);
  });
}

function downloadBinary(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = { headers: { 'User-Agent': 'trademarkyo/1.0', ...headers } };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBinary(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// ── File discovery via USPTO Open Data Portal ─────────────────────────────────

async function getFileList(limit) {
  // Primary: ODP bulk files API
  const apiHeaders = USPTO_API_KEY ? { 'x-api-key': USPTO_API_KEY } : {};
  const odp = `https://data.uspto.gov/api/v1/dataset/TRTDXFAP/bulkfiles?pageSize=${limit}&sortBy=date&sortOrder=desc`;

  log(`Fetching file list from ODP API...`);
  try {
    const { status, body } = await httpGet(odp, apiHeaders);
    log(`ODP response: ${status}`);
    if (status === 200) {
      const data = JSON.parse(body);
      // ODP returns array of file objects
      const files = data?.bulkFiles || data?.files || data?.results || data || [];
      const arr = Array.isArray(files) ? files : [];
      log(`ODP returned ${arr.length} files`);
      if (arr.length > 0) {
        return arr.map(f => ({
          fileName: f.fileName || f.name || f.fileTitle || String(f),
          downloadUrl: f.downloadUrl || f.url || f.fileUrl || f.href,
        })).filter(f => f.downloadUrl);
      }
    }
  } catch (e) {
    log(`ODP API error: ${e.message}`);
  }

  // Fallback: scrape Reed Tech page for zip links
  log('Trying Reed Tech fallback...');
  try {
    const { status, body } = await httpGet('https://trademarks.reedtech.com/tmappxml.php');
    log(`Reed Tech: ${status}, body length: ${body.length}`);
    if (status === 200 && body.length > 100) {
      const matches = [...body.matchAll(/href="([^"]*apc\d+\.zip[^"]*)"/gi)];
      if (matches.length > 0) {
        const files = matches.map(m => {
          let href = m[1];
          if (!href.startsWith('http')) href = 'https://trademarks.reedtech.com/' + href.replace(/^\//, '');
          return { fileName: href.split('/').pop(), downloadUrl: href };
        });
        // Sort by filename desc (newest last in name = highest number)
        files.sort((a, b) => b.fileName.localeCompare(a.fileName));
        log(`Reed Tech found ${files.length} files, returning last ${limit}`);
        return files.slice(0, limit);
      }
    }
  } catch (e) {
    log(`Reed Tech error: ${e.message}`);
  }

  // Last fallback: try the USPTO SOMS system
  log('Trying USPTO SOMS fallback...');
  try {
    const { status, body } = await httpGet('https://eipweb.uspto.gov/SOMS/', apiHeaders);
    log(`SOMS: ${status}, body length: ${body.length}`);
    if (status === 200) {
      const matches = [...body.matchAll(/href="([^"]*\.zip[^"]*)"/gi)];
      const files = matches.map(m => {
        let href = m[1];
        if (!href.startsWith('http')) href = 'https://eipweb.uspto.gov' + (href.startsWith('/') ? '' : '/') + href;
        return { fileName: href.split('/').pop(), downloadUrl: href };
      }).filter(f => f.fileName.toLowerCase().endsWith('.zip'));
      log(`SOMS found ${files.length} zip files`);
      if (files.length > 0) return files.slice(0, limit);
    }
  } catch (e) {
    log(`SOMS error: ${e.message}`);
  }

  log('All file sources exhausted — no files found');
  return [];
}

// ── XML Parsing ────────────────────────────────────────────────────────────────

function extractText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'object') {
    if (node._) return String(node._).trim();
    if (Array.isArray(node)) return extractText(node[0]);
  }
  return String(node).trim();
}

function extractRecord(cf) {
  try {
    // Serial number — multiple possible paths
    const sn = extractText(
      cf['serial-number'] || cf.serialNumber || cf['application-serial-number']
    );
    if (!sn || sn.length < 5) return null;

    // Mark name — multiple possible paths
    const header = cf['case-file-header'] || cf.header || {};
    const markName = extractText(
      header['mark-identification'] || cf['mark-identification'] ||
      cf['word-mark'] || cf['mark-name'] || header['mark-text']
    ).toUpperCase();
    if (!markName) return null;

    // Status — codes 600+ are dead/abandoned
    const statusCode = extractText(header['status-code'] || header['filing-status'] || cf['status-code'] || '');
    const deadCodes = ['600','601','602','603','604','700','710','800','DEAD','ABAND','CANCEL','EXPIR'];
    const isLive = !deadCodes.some(c => statusCode.toUpperCase().includes(c));

    // Owner
    let owner = '';
    try {
      const owners = cf['case-file-owners']?.['case-file-owner'] || [];
      const ownerArr = Array.isArray(owners) ? owners : [owners];
      owner = extractText(ownerArr[0]?.['party-name'] || ownerArr[0]?.['entity-name'] || '').slice(0, 255);
    } catch {}

    // Goods & services
    let goodsServices = '';
    try {
      const stmts = cf['case-file-statements']?.['case-file-statement'] || [];
      const stmtArr = Array.isArray(stmts) ? stmts : [stmts];
      goodsServices = stmtArr.map(s => extractText(s?.text || s?.['goods-services'] || '')).filter(Boolean).join('; ').slice(0, 2000);
    } catch {}

    // International class
    let intClass = '';
    try {
      const clsList = cf?.classifications?.classification || cf?.['case-file-class-numbers']?.['class-number'] || [];
      const clsArr = Array.isArray(clsList) ? clsList : [clsList];
      intClass = clsArr.map(c => extractText(c?.['international-code'] || c?.['class-number'] || c)).filter(Boolean).join(',').slice(0, 50);
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
  } catch (e) {
    return null;
  }
}

function findCaseFiles(obj) {
  if (!obj || typeof obj !== 'object') return [];

  // Known exact paths
  const paths = [
    obj?.['trademark-applications-daily']?.['application-information']?.['case-file'],
    obj?.['trademark-registrations-daily']?.['registration-information']?.['case-file'],
    obj?.['trademark-applications-weekly']?.['application-information']?.['case-file'],
    obj?.['case-file'],
    obj?.['case-files']?.['case-file'],
  ];
  for (const p of paths) {
    if (p) return Array.isArray(p) ? p : [p];
  }

  // Recursive search — only go 3 levels deep to avoid infinite loops
  function search(node, depth) {
    if (depth > 3 || !node || typeof node !== 'object') return [];
    for (const [key, val] of Object.entries(node)) {
      if (key === 'case-file') return Array.isArray(val) ? val : [val];
      const found = search(val, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  return search(obj, 0);
}

async function parseXmlBuffer(xmlContent) {
  const records = [];
  try {
    const parsed = await parseStringPromise(xmlContent, {
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
      normalize: true,
    });
    const caseFiles = findCaseFiles(parsed);
    for (const cf of caseFiles) {
      const rec = extractRecord(cf);
      if (rec && rec.serial_number && rec.mark_name) records.push(rec);
    }
  } catch (e) {
    log(`  XML parse error: ${e.message}`);
  }
  return records;
}

// ── Unzip and parse ────────────────────────────────────────────────────────────

async function processZipFile(zipPath) {
  const records = [];
  const dir = await unzipper.Open.file(zipPath);
  for (const entry of dir.files) {
    if (entry.type === 'Directory') continue;
    if (!entry.path.toLowerCase().endsWith('.xml')) continue;
    try {
      const buf = await entry.buffer();
      const xml = buf.toString('utf8');
      const parsed = await parseXmlBuffer(xml);
      records.push(...parsed);
      log(`  ${entry.path}: ${parsed.length} records`);
    } catch (e) {
      log(`  Failed to parse ${entry.path}: ${e.message}`);
    }
  }
  return records;
}

// ── Database upsert ────────────────────────────────────────────────────────────

const BATCH = 500;

async function upsertRecords(records) {
  if (!records.length) return 0;
  const client = await pool.connect();
  let count = 0;
  try {
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
          mark_name=EXCLUDED.mark_name, owner=EXCLUDED.owner,
          status=EXCLUDED.status, goods_services=EXCLUDED.goods_services,
          int_class=EXCLUDED.int_class, filing_date=EXCLUDED.filing_date,
          reg_date=EXCLUDED.reg_date, updated_at=NOW()
      `, params);
      count += batch.length;
    }
  } finally {
    client.release();
  }
  return count;
}

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
    CREATE INDEX IF NOT EXISTS idx_tm_status ON trademarks (status);
    CREATE TABLE IF NOT EXISTS loader_log (
      id SERIAL PRIMARY KEY,
      run_date TIMESTAMP DEFAULT NOW(),
      status VARCHAR(20),
      records_processed INTEGER DEFAULT 0,
      message TEXT
    );
  `);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runLoader(mode) {
  log(`Starting — mode: ${mode}`);
  let totalLoaded = 0;

  try {
    await ensureSchema();

    const limit = mode === 'full' ? 60 : mode === 'daily' ? 1 : 10;
    const files = await getFileList(limit);

    if (files.length === 0) {
      log('No files found from any source. Exiting.');
      await pool.query(
        `INSERT INTO loader_log (status,records_processed,message) VALUES ('no_files',0,'No files available')` 
      );
      return;
    }

    log(`Processing ${files.length} files...`);

    for (const file of files) {
      const { fileName, downloadUrl } = file;
      if (!downloadUrl) { log(`Skipping — no URL for ${fileName}`); continue; }

      const tmpPath = path.join(TMP_DIR, fileName || `download_${Date.now()}.zip`);
      try {
        log(`Downloading: ${fileName} from ${downloadUrl}`);
        const apiHeaders = USPTO_API_KEY ? { 'x-api-key': USPTO_API_KEY } : {};
        await downloadBinary(downloadUrl, tmpPath, apiHeaders);
        const sizeMB = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1);
        log(`Downloaded: ${fileName} (${sizeMB} MB)`);

        const records = await processZipFile(tmpPath);
        log(`Parsed ${records.length} records from ${fileName}`);

        if (records.length > 0) {
          const n = await upsertRecords(records);
          totalLoaded += n;
          log(`Upserted ${n} records — running total: ${totalLoaded}`);
        }
      } catch (e) {
        log(`Failed on ${fileName}: ${e.message}`);
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      }
    }

    await pool.query(
      `INSERT INTO loader_log (status,records_processed,message) VALUES ('success',$1,$2)`,
      [totalLoaded, `Loaded ${totalLoaded} records in ${mode} mode`]
    );
    log(`Complete — ${totalLoaded} total records loaded`);

  } catch (e) {
    log(`Fatal error: ${e.message}`);
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
runLoader(mode).catch(e => {
  console.error('[loader] Unhandled:', e.message);
  process.exit(0); // exit 0 so server.js still starts if chained
});
