'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const sax      = require('sax');
const unzipper = require('unzipper');
const { Pool } = require('pg');

const USPTO_API_KEY = process.env.USPTO_API_KEY || '';
const DATABASE_URL  = process.env.DATABASE_URL  || '';
const TMP_DIR = '/tmp/tyo_loader';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 3,
});

function log(msg) { console.log(`[loader] ${new Date().toISOString()} — ${msg}`); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGetJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'trademarkyo/1.0', 'Accept': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGetJson(res.headers.location, apiKey).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return downloadFile(res.headers.location, dest, apiKey).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// ── File list ─────────────────────────────────────────────────────────────────

function getDateRange(mode) {
  const today = new Date();
  const to = today.toISOString().split('T')[0];
  const d = new Date(today);
  if (mode === 'daily') d.setDate(d.getDate() - 2);
  else d.setDate(d.getDate() - 30);
  return { from: d.toISOString().split('T')[0], to };
}

async function getFileList(mode) {
  const { from, to } = getDateRange(mode);
  log(`Fetching file list: ${from} to ${to}`);
  const url = `https://api.uspto.gov/api/v1/datasets/products/trtdxfap?fileDataFromDate=${from}&fileDataToDate=${to}&includeFiles=true`;
  const { status, body } = await httpGetJson(url, USPTO_API_KEY);
  if (status !== 200) throw new Error(`API returned ${status}`);
  const data = JSON.parse(body);
  const files = [];
  for (const product of (data?.bulkDataProductBag || [])) {
    for (const f of (product?.productFileBag?.fileDataBag || [])) {
      if (f.fileDownloadURI) files.push({ fileName: f.fileName, downloadUrl: f.fileDownloadURI });
    }
  }
  log(`Found ${files.length} files`);
  return files;
}

// ── SAX streaming XML parser ──────────────────────────────────────────────────
// Processes one <case-file> at a time without loading full XML into memory

function parseXmlStream(xmlStream) {
  return new Promise((resolve, reject) => {
    const records = [];
    const parser = sax.createStream(false, { lowercase: true, trim: true });

    let inCaseFile = false;
    let currentTag = '';
    let current = {};
    let tagStack = [];
    const DEAD_CODES = new Set(['600','601','602','603','604','700','710','800','810','820','900']);

    parser.on('opentag', (node) => {
      tagStack.push(node.name);
      currentTag = node.name;
      if (node.name === 'case-file') {
        inCaseFile = true;
        current = {};
      }
    });

    parser.on('text', (text) => {
      if (!inCaseFile || !text.trim()) return;
      const t = text.trim();
      switch (currentTag) {
        case 'serial-number':       if (!current.serial_number) current.serial_number = t; break;
        case 'mark-identification': if (!current.mark_name) current.mark_name = t.toUpperCase(); break;
        case 'status-code':         if (!current.status_code) current.status_code = t; break;
        case 'filing-date':         if (!current.filing_date) current.filing_date = t; break;
        case 'registration-date':   if (!current.reg_date) current.reg_date = t; break;
        case 'party-name':          if (!current.owner) current.owner = t.slice(0, 255); break;
        case 'entity-name':         if (!current.owner) current.owner = t.slice(0, 255); break;
        case 'international-code':
          current.int_class = current.int_class ? current.int_class + ',' + t : t;
          break;
        case 'text':
          // only capture under case-file-statement context
          if (tagStack.includes('case-file-statement')) {
            current.goods_services = current.goods_services
              ? current.goods_services + '; ' + t
              : t;
          }
          break;
      }
    });

    parser.on('closetag', (name) => {
      tagStack.pop();
      currentTag = tagStack[tagStack.length - 1] || '';

      if (name === 'case-file' && inCaseFile) {
        inCaseFile = false;
        if (current.serial_number && current.mark_name) {
          const dead = DEAD_CODES.has((current.status_code || '').slice(0, 3));
          records.push({
            serial_number: current.serial_number.replace(/\D/g, '').slice(0, 20),
            mark_name:     current.mark_name.slice(0, 500),
            owner:         current.owner || null,
            status:        dead ? 'DEAD' : 'LIVE',
            goods_services: current.goods_services ? current.goods_services.slice(0, 2000) : null,
            int_class:     current.int_class ? current.int_class.slice(0, 50) : null,
            filing_date:   current.filing_date || null,
            reg_date:      current.reg_date || null,
          });
        }
        current = {};
      }
    });

    parser.on('error', (e) => {
      // SAX errors on malformed XML — just log and continue
      log(`SAX warning: ${e.message}`);
      parser._parser.error = null;
      parser._parser.resume();
    });

    parser.on('end', () => resolve(records));

    xmlStream.pipe(parser);
  });
}

// ── Process a ZIP file ────────────────────────────────────────────────────────

async function processZip(zipPath) {
  let total = 0;
  const dir = await unzipper.Open.file(zipPath);

  for (const entry of dir.files) {
    if (entry.type === 'Directory' || !entry.path.toLowerCase().endsWith('.xml')) continue;
    log(`  Parsing ${entry.path}...`);
    try {
      const xmlStream = entry.stream();
      const records = await parseXmlStream(xmlStream);
      log(`  ${entry.path}: ${records.length} records`);
      if (records.length > 0) {
        const n = await upsertRecords(records);
        total += n;
        log(`  Upserted ${n} — running total: ${total}`);
      }
    } catch (e) {
      log(`  Failed ${entry.path}: ${e.message}`);
    }
  }
  return total;
}

// ── DB ────────────────────────────────────────────────────────────────────────

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
        r.goods_services, r.int_class, r.filing_date, r.reg_date,
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
      await pool.query(`INSERT INTO loader_log (status,records_processed,message) VALUES ('no_files',0,'No files found')`);
      return;
    }
    // Cap at 30 files per run
    const batch = files.slice(0, 30);
    log(`Processing ${batch.length} files...`);

    for (const { fileName, downloadUrl } of batch) {
      const tmpPath = path.join(TMP_DIR, fileName || `dl_${Date.now()}.zip`);
      try {
        log(`Downloading: ${fileName}`);
        await downloadFile(downloadUrl, tmpPath, USPTO_API_KEY);
        const mb = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1);
        log(`Downloaded: ${fileName} (${mb} MB) — parsing...`);
        const n = await processZip(tmpPath);
        total += n;
        log(`Done ${fileName}: ${n} records — total: ${total}`);
      } catch (e) {
        log(`Failed ${fileName}: ${e.message}`);
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      }
    }

    await pool.query(
      `INSERT INTO loader_log (status,records_processed,message) VALUES ('success',$1,$2)`,
      [total, `Loaded ${total} records (${mode})`]
    );
    log(`Done — ${total} total records`);
  } catch (e) {
    log(`Fatal: ${e.message}`);
    try {
      await pool.query(`INSERT INTO loader_log (status,records_processed,message) VALUES ('error',0,$1)`, [e.message]);
    } catch {}
  } finally {
    await pool.end();
  }
}

const mode = process.argv[2] || 'incremental';
run(mode).catch(e => { console.error('[loader] Unhandled:', e.message); process.exit(0); });
