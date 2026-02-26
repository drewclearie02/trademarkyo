'use strict';

/**
 * USPTO Trademark Bulk Data Loader (ODP TRTDXFAP)
 *
 * This loader pulls USPTO trademark application bulk XML zips from the
 * USPTO Open Data Portal (ODP) and upserts them into PostgreSQL.
 *
 * Modes:
 *   node loader.js full    -> process many historical files (bootstraps DB)
 *   node loader.js daily   -> process latest available file(s)
 *   node loader.js         -> alias of daily
 *
 * Requirements:
 *   - DATABASE_URL set
 *   - USPTO_API_KEY set (ODP API key)
 *
 * Notes:
 *   - Uses streaming unzip + streaming SAX parsing to avoid OOM.
 *   - Tracks processed files in loader_state table to resume safely.
 */

const https = require('https');
const { Client } = require('pg');
const sax = require('sax');

const PRODUCT = 'TRTDXFAP';
const API_BASE = 'https://api.uspto.gov/api/v1';
const BATCH_SIZE = 500;

function log(msg) {
  console.log(`[loader] ${new Date().toISOString()} — ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers (ODP)
// ─────────────────────────────────────────────────────────────────────────────

function httpJson(url, { retries = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'TrademarkyoLoader/2.0',
      'Accept': 'application/json',
      // ODP key:
      'X-API-KEY': process.env.USPTO_API_KEY || '',
      'X-Api-Key': process.env.USPTO_API_KEY || '',
    };

    const req = https.request(url, { method: 'GET', headers }, async (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');

        if ([429, 500, 502, 503, 504].includes(res.statusCode)) {
          if (retries > 0) {
            const backoff = (7 - retries) * 1500 + Math.floor(Math.random() * 500);
            log(`[ODP] ${res.statusCode} retrying in ${backoff}ms: ${url}`);
            await sleep(backoff);
            try {
              return resolve(await httpJson(url, { retries: retries - 1 }));
            } catch (e) {
              return reject(e);
            }
          }
          return reject(new Error(`ODP error ${res.statusCode}: ${body.slice(0, 250)}`));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ODP ${res.statusCode}: ${body.slice(0, 250)}`));
        }

        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`ODP JSON parse failed: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function httpStream(url, { retries = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'TrademarkyoLoader/2.0',
      'Accept': '*/*',
      'X-API-KEY': process.env.USPTO_API_KEY || '',
      'X-Api-Key': process.env.USPTO_API_KEY || '',
    };

    const req = https.request(url, { method: 'GET', headers }, async (res) => {
      if ([429, 500, 502, 503, 504].includes(res.statusCode)) {
        res.resume();
        if (retries > 0) {
          const backoff = (7 - retries) * 1500 + Math.floor(Math.random() * 500);
          log(`[ODP] ${res.statusCode} retrying in ${backoff}ms: ${url}`);
          await sleep(backoff);
          try {
            return resolve(await httpStream(url, { retries: retries - 1 }));
          } catch (e) {
            return reject(e);
          }
        }
        return reject(new Error(`ODP stream error ${res.statusCode}`));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`ODP stream ${res.statusCode}`));
      }

      resolve(res);
    });

    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSchema(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS trademarks (
      serial_number   VARCHAR(20) PRIMARY KEY,
      mark_name       TEXT NOT NULL,
      owner           TEXT,
      status          VARCHAR(10),
      goods_services  TEXT,
      int_class       VARCHAR(50),
      filing_date     VARCHAR(20),
      reg_date        VARCHAR(20),
      updated_at      TIMESTAMP DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS loader_state (
      product TEXT NOT NULL,
      file_name TEXT NOT NULL,
      processed_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (product, file_name)
    );
  `);
}

async function isProcessed(pg, fileName) {
  const r = await pg.query(
    'SELECT 1 FROM loader_state WHERE product=$1 AND file_name=$2 LIMIT 1',
    [PRODUCT, fileName]
  );
  return r.rowCount > 0;
}

async function markProcessed(pg, fileName) {
  await pg.query(
    `INSERT INTO loader_state(product, file_name)
     VALUES ($1,$2)
     ON CONFLICT (product, file_name) DO NOTHING`,
    [PRODUCT, fileName]
  );
}

function liveDeadFromStatusCode(statusCodeRaw) {
  const s = String(statusCodeRaw || '').trim();
  // Simple heuristic: 8xx typically dead; otherwise assume live.
  if (s.startsWith('8')) return 'DEAD';
  return 'LIVE';
}

async function upsertBatch(pg, rows) {
  if (!rows.length) return 0;

  const values = [];
  const params = [];
  let i = 1;

  for (const r of rows) {
    params.push(
      r.serial_number,
      r.mark_name,
      r.owner || null,
      r.status || null,
      r.goods_services || null,
      r.int_class || null,
      r.filing_date || null,
      r.reg_date || null
    );

    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
  }

  await pg.query(
    `
    INSERT INTO trademarks (
      serial_number, mark_name, owner, status, goods_services, int_class, filing_date, reg_date
    ) VALUES ${values.join(',')}
    ON CONFLICT (serial_number) DO UPDATE SET
      mark_name=EXCLUDED.mark_name,
      owner=EXCLUDED.owner,
      status=EXCLUDED.status,
      goods_services=EXCLUDED.goods_services,
      int_class=EXCLUDED.int_class,
      filing_date=EXCLUDED.filing_date,
      reg_date=EXCLUDED.reg_date,
      updated_at=NOW()
    `,
    params
  );

  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ODP file listing
// ─────────────────────────────────────────────────────────────────────────────

async function listFiles({ mode }) {
  // ODP "product detail" call with files included.
  // Response shape varies, so we accept multiple keys.
  const includeFiles = 'true';
  const latest = (mode === 'daily') ? 'true' : 'false';

  const url = `${API_BASE}/datasets/products/${PRODUCT}?includeFiles=${includeFiles}&latest=${latest}&limit=5000&offset=0`;
  const data = await httpJson(url);

  const files =
    data?.productFiles ||
    data?.files ||
    data?.bdssResponseProductBag?.productFiles ||
    data?.productFileBag ||
    [];

  const normalized = (Array.isArray(files) ? files : [])
    .map(f => ({
      fileName: f.fileName || f.name,
      fileDataDate: f.fileDataDate || f.dataDate || f.fileDate || '',
    }))
    .filter(f => f.fileName && String(f.fileName).toLowerCase().endsWith('.zip'));

  // Sort oldest -> newest
  normalized.sort((a, b) => String(a.fileDataDate).localeCompare(String(b.fileDataDate)));
  return normalized;
}

function downloadUrlForFile(fileName) {
  // ODP file download endpoint
  return `${API_BASE}/datasets/products/files/${PRODUCT}/${encodeURIComponent(fileName)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming parse of TRTDXFAP XML (SAX)
// ─────────────────────────────────────────────────────────────────────────────

async function parseXmlToDb(pg, xmlStream, fileName) {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });

    // Case state
    let inCase = false;
    let inHeader = false;
    let inOwner = false;
    let inStatements = false;

    let currentTag = '';

    let serial = '';
    let mark = '';
    let statusCode = '';
    let filingDate = '';
    let regDate = '';
    let owner = '';
    let goodsTexts = [];
    let classCodes = new Set();

    let batch = [];
    let total = 0;

    function resetCase() {
      serial = '';
      mark = '';
      statusCode = '';
      filingDate = '';
      regDate = '';
      owner = '';
      goodsTexts = [];
      classCodes = new Set();
    }

    async function flush() {
      if (!batch.length) return;
      const n = await upsertBatch(pg, batch);
      total += n;
      batch = [];
      if (total % 5000 === 0) log(`[${fileName}] upserted ${total}`);
    }

    parser.on('opentag', (node) => {
      currentTag = node.name;

      if (node.name === 'case-file') {
        inCase = true;
        resetCase();
      } else if (node.name === 'case-file-header') {
        inHeader = true;
      } else if (node.name === 'case-file-owner') {
        inOwner = true;
      } else if (node.name === 'case-file-statements') {
        inStatements = true;
      }
    });

    parser.on('text', (txt) => {
      if (!inCase) return;
      const t = String(txt || '').trim();
      if (!t) return;

      if (currentTag === 'serial-number') serial += t;

      if (inHeader && currentTag === 'mark-identification') mark += (mark ? ' ' : '') + t;
      if (inHeader && currentTag === 'status-code') statusCode += t;
      if (inHeader && currentTag === 'filing-date') filingDate += t;
      if (inHeader && currentTag === 'registration-date') regDate += t;

      if (inOwner && currentTag === 'party-name') {
        if (!owner) owner = t;
      }

      // Statements contain goods/services and other statements. Store text blocks.
      if (inStatements && currentTag === 'text') {
        goodsTexts.push(t);
      }

      // International class codes are commonly under international-code tags
      if (currentTag === 'international-code') {
        classCodes.add(t);
      }
    });

    parser.on('closetag', (name) => {
      if (name === 'case-file-header') inHeader = false;
      if (name === 'case-file-owner') inOwner = false;
      if (name === 'case-file-statements') inStatements = false;

      if (name === 'case-file') {
        inCase = false;

        const sn = serial.trim();
        const mk = mark.trim().toUpperCase();

        if (sn && mk) {
          batch.push({
            serial_number: sn.replace(/\D/g, '').slice(0, 20),
            mark_name: mk,
            owner: owner ? owner.slice(0, 255) : null,
            status: liveDeadFromStatusCode(statusCode),
            goods_services: goodsTexts.length ? goodsTexts.join(' | ').slice(0, 20000) : null,
            int_class: classCodes.size ? Array.from(classCodes).join(',').slice(0, 50) : null,
            filing_date: filingDate || null,
            reg_date: regDate || null,
          });
        }

        if (batch.length >= BATCH_SIZE) {
          parser.pause();
          flush()
            .then(() => parser.resume())
            .catch(reject);
        }
      }
    });

    parser.on('error', reject);

    parser.on('end', async () => {
      try {
        await flush();
        resolve(total);
      } catch (e) {
        reject(e);
      }
    });

    xmlStream.pipe(parser);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Zip processing
// ─────────────────────────────────────────────────────────────────────────────

async function processZipFromOdp(pg, fileName) {
  const url = downloadUrlForFile(fileName);
  log(`Downloading: ${fileName}`);

  const zipStream = await httpStream(url);

  const directory = zipStream.pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of directory) {
    const lower = entry.path.toLowerCase();
    if (lower.endsWith('.xml')) {
      log(`Unzipped XML: ${entry.path} — parsing`);
      const upserts = await parseXmlToDb(pg, entry, fileName);
      log(`Done: ${fileName} — upserts=${upserts}`);
      return upserts;
    } else {
      entry.autodrain();
    }
  }

  throw new Error(`No XML entry found inside ${fileName}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function run(mode) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.USPTO_API_KEY) throw new Error('USPTO_API_KEY not set');

  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  });

  await pg.connect();

  let totalRecords = 0;
  try {
    await ensureSchema(pg);

    const files = await listFiles({ mode });
    if (!files.length) {
      log('No ODP files returned');
      await pg.query(
        `INSERT INTO loader_log(status,records_processed,message) VALUES ('no_files',0,$1)`,
        ['No files returned by ODP list API']
      );
      return;
    }

    let queue = files;

    // full = a lot; daily = newest couple; default = newest few
    if (mode === 'full') {
      // Take a bigger slice, but not everything. You can raise this later.
      queue = files.slice(-200);
    } else {
      queue = files.slice(-3);
    }

    log(`Mode=${mode} — considering ${queue.length} file(s)`);

    let processedFiles = 0;

    for (const f of queue) {
      const fileName = f.fileName;
      if (!fileName) continue;

      if (await isProcessed(pg, fileName)) {
        continue;
      }

      try {
        const n = await processZipFromOdp(pg, fileName);
        totalRecords += n;
        await markProcessed(pg, fileName);
        processedFiles++;

        // gentle pacing for rate limiting
        await sleep(400);
      } catch (e) {
        log(`FAILED file=${fileName}: ${e.message}`);
        // Stop on first failure so you can see the logs and fix quickly.
        throw e;
      }
    }

    await pg.query(
      `INSERT INTO loader_log(status,records_processed,message) VALUES ('success',$1,$2)`,
      [totalRecords, `Processed ${processedFiles} file(s), upserted ${totalRecords} record(s)`]
    );
    log(`Complete — processed ${processedFiles} file(s), total upserts=${totalRecords}`);

  } catch (e) {
    try {
      await pg.query(
        `INSERT INTO loader_log(status,records_processed,message) VALUES ('error',0,$1)`,
        [String(e.message || e)]
      );
    } catch {}
    throw e;
  } finally {
    await pg.end();
  }
}

const mode = (process.argv[2] || 'daily').toLowerCase();
run(mode)
  .catch((e) => {
    console.error('[loader] fatal:', e.message || e);
    // Exit non-zero so Railway logs show failure clearly when run standalone.
    process.exit(1);
  });
