'use strict';

/**
 * USPTO Trademark Bulk Data Loader
 * 
 * Downloads trademark data from USPTO's Open Data Portal API and loads
 * it into PostgreSQL. Run once for initial load, then daily via cron.
 * 
 * Usage:
 *   node loader.js          — loads last 30 days of data
 *   node loader.js full     — loads last 365 days (initial full load)
 *   node loader.js daily    — loads yesterday only
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseStringPromise } = require('xml2js');
const { Pool } = require('pg');

const USPTO_API_KEY = process.env.USPTO_API_KEY || 'kszlemudruwoiyirlwmtspkbnjvour';
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;
const TMP_DIR = path.join(__dirname, 'tmp');

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

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': USPTO_API_KEY,
        ...headers,
      },
    };
    protocol.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const options = {
      headers: {
        'x-api-key': USPTO_API_KEY,
        'Accept': 'application/octet-stream',
      },
    };
    protocol.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Get list of available trademark data files from USPTO API
 */
async function getFileList(fromDate, toDate) {
  const url = `https://api.uspto.gov/api/v1/datasets/products/TRTDXFAP?fileDataFromDate=${fromDate}&fileDataToDate=${toDate}&includeFiles=true`;
  log(`Fetching file list: ${fromDate} to ${toDate}`);

  const { status, body } = await httpGet(url);
  if (status !== 200) throw new Error(`USPTO API returned ${status}: ${body.slice(0, 200)}`);

  const data = JSON.parse(body);
  const files = data?.dataSetFiles || data?.files || [];
  log(`Found ${files.length} files`);
  return files;
}

/**
 * Parse USPTO trademark XML and extract records
 */
async function parseXmlFile(filePath) {
  const records = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // USPTO XML uses case-application elements
    const parsed = await parseStringPromise(content, {
      explicitArray: false,
      ignoreAttrs: false,
      trim: true,
    });

    // Navigate to trademark cases - USPTO XML structure varies
    const root = parsed['trademark-applications-daily'] ||
                 parsed['trademark-registrations-daily'] ||
                 parsed['case-file'] ||
                 parsed;

    const caseFiles = extractCaseFiles(root);
    log(`Parsing ${caseFiles.length} trademark cases from XML`);

    for (const cf of caseFiles) {
      const record = extractRecord(cf);
      if (record) records.push(record);
    }
  } catch (e) {
    log(`XML parse error: ${e.message}`);
  }
  return records;
}

function extractCaseFiles(root) {
  // Try common USPTO XML paths
  const paths = [
    root?.['case-file'],
    root?.['application-information']?.['case-file'],
    root?.['trademark-applications-daily']?.['application-information']?.['case-file'],
    root?.['trademark-registrations-daily']?.['registration-information']?.['case-file'],
  ];

  for (const p of paths) {
    if (p) return Array.isArray(p) ? p : [p];
  }

  // Deep search for case-file arrays
  const str = JSON.stringify(root);
  try {
    const re = /"case-file":\[/;
    if (re.test(str)) {
      const found = findKey(root, 'case-file');
      if (found) return Array.isArray(found) ? found : [found];
    }
  } catch { }

  return [];
}

function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found) return found;
  }
  return null;
}

function extractRecord(cf) {
  try {
    const serialNumber = cf?.['serial-number'] || cf?.serialNumber;
    if (!serialNumber) return null;

    const header = cf?.['case-file-header'] || {};
    const markText = header?.['mark-identification'] ||
                     cf?.['mark-identification'] ||
                     cf?.['word-mark'] || '';

    const statusCode = header?.['status-code'] || header?.['filing-status'] || '';
    const liveDeadStatus = isLive(statusCode) ? 'LIVE' : 'DEAD';

    const owner = extractOwner(cf);
    const goodsServices = extractGoods(cf);
    const intClass = extractClass(cf);
    const filingDate = header?.['filing-date'] || header?.['transaction-date'] || '';
    const regDate = header?.['registration-date'] || '';

    return {
      serial_number: String(serialNumber).replace(/[^0-9]/g, ''),
      mark_name: String(markText).trim().toUpperCase() || null,
      owner: String(owner || '').trim() || null,
      status: liveDeadStatus,
      goods_services: String(goodsServices || '').slice(0, 2000) || null,
      int_class: String(intClass || '').slice(0, 50) || null,
      filing_date: String(filingDate || '').replace(/[^0-9\-]/g, '') || null,
      reg_date: String(regDate || '').replace(/[^0-9\-]/g, '') || null,
    };
  } catch {
    return null;
  }
}

function isLive(statusCode) {
  const code = String(statusCode || '').toUpperCase();
  const deadCodes = ['DEAD', 'ABANDONED', 'CANCELLED', 'EXPIRED', '602', '603', '700', '800'];
  return !deadCodes.some(d => code.includes(d));
}

function extractOwner(cf) {
  try {
    const parties = cf?.['case-file-owners']?.['case-file-owner'] ||
                    cf?.['owners']?.['owner'] || [];
    const arr = Array.isArray(parties) ? parties : [parties];
    const first = arr[0];
    return first?.['party-name'] || first?.['name'] || first?.['entity-name'] || '';
  } catch { return ''; }
}

function extractGoods(cf) {
  try {
    const gs = cf?.['case-file-statements']?.['case-file-statement'] ||
               cf?.['goods-services'] || [];
    const arr = Array.isArray(gs) ? gs : [gs];
    return arr.map(g => g?.['text'] || g?.['description'] || '').filter(Boolean).join('; ');
  } catch { return ''; }
}

function extractClass(cf) {
  try {
    const classifications = cf?.['classifications']?.['classification'] ||
                            cf?.['case-file-class-numbers']?.['class-number'] || [];
    const arr = Array.isArray(classifications) ? classifications : [classifications];
    return arr.map(c => c?.['international-code'] || c?.['class-number'] || c || '').filter(Boolean).join(',');
  } catch { return ''; }
}

/**
 * Upsert records into PostgreSQL in batches
 */
async function upsertBatch(records) {
  if (records.length === 0) return 0;

  const client = await pool.connect();
  let inserted = 0;

  try {
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE).filter(r => r.serial_number && r.mark_name);

      if (batch.length === 0) continue;

      const values = batch.map((r, idx) => {
        const base = idx * 8;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},NOW())`;
      }).join(',');

      const params = batch.flatMap(r => [
        r.serial_number, r.mark_name, r.owner, r.status,
        r.goods_services, r.int_class, r.filing_date, r.reg_date
      ]);

      await client.query(`
        INSERT INTO trademarks
          (serial_number, mark_name, owner, status, goods_services, int_class, filing_date, reg_date, updated_at)
        VALUES ${values}
        ON CONFLICT (serial_number) DO UPDATE SET
          mark_name = EXCLUDED.mark_name,
          owner = EXCLUDED.owner,
          status = EXCLUDED.status,
          goods_services = EXCLUDED.goods_services,
          int_class = EXCLUDED.int_class,
          filing_date = EXCLUDED.filing_date,
          reg_date = EXCLUDED.reg_date,
          updated_at = NOW()
      `, params);

      inserted += batch.length;
    }
  } finally {
    client.release();
  }

  return inserted;
}

async function logRun(status, recordsProcessed, message) {
  try {
    await pool.query(
      'INSERT INTO loader_log (status, records_processed, message) VALUES ($1, $2, $3)',
      [status, recordsProcessed, message]
    );
  } catch { }
}

/**
 * Main loader function
 */
async function runLoader(mode = 'incremental') {
  log(`Starting loader — mode: ${mode}`);

  const today = new Date();
  let fromDate;

  if (mode === 'full') {
    // Initial load — go back 2 years
    fromDate = new Date(today);
    fromDate.setFullYear(fromDate.getFullYear() - 2);
  } else if (mode === 'daily') {
    // Just yesterday
    fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 1);
  } else {
    // Default — last 30 days
    fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 30);
  }

  const fromStr = formatDate(fromDate);
  const toStr = formatDate(today);

  let totalRecords = 0;

  try {
    // Ensure schema exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trademarks (
        serial_number VARCHAR(20) PRIMARY KEY,
        mark_name TEXT,
        owner TEXT,
        status VARCHAR(10),
        goods_services TEXT,
        int_class VARCHAR(50),
        filing_date VARCHAR(20),
        reg_date VARCHAR(20),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_trademarks_mark_name_lower ON trademarks (lower(mark_name));
      CREATE INDEX IF NOT EXISTS idx_trademarks_status ON trademarks (status);
      CREATE TABLE IF NOT EXISTS loader_log (
        id SERIAL PRIMARY KEY,
        run_date TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20),
        records_processed INTEGER DEFAULT 0,
        message TEXT
      );
    `);

    const files = await getFileList(fromStr, toStr);

    if (files.length === 0) {
      log('No files found for date range');
      await logRun('no_files', 0, `No files found for ${fromStr} to ${toStr}`);
      return;
    }

    for (const file of files) {
      const fileUrl = file.downloadUrl || file.url || file.fileUrl;
      const fileName = file.fileName || file.name || `trademark_${Date.now()}.zip`;

      if (!fileUrl) {
        log(`Skipping file with no URL: ${JSON.stringify(file)}`);
        continue;
      }

      log(`Downloading: ${fileName}`);
      const tmpZip = path.join(TMP_DIR, fileName);

      try {
        await downloadFile(fileUrl, tmpZip);
        log(`Downloaded: ${fileName} (${(fs.statSync(tmpZip).size / 1024 / 1024).toFixed(1)} MB)`);

        // Extract and parse
        const records = await extractAndParse(tmpZip);
        log(`Extracted ${records.length} records from ${fileName}`);

        if (records.length > 0) {
          const inserted = await upsertBatch(records);
          totalRecords += inserted;
          log(`Upserted ${inserted} records`);
        }

        // Clean up temp file
        fs.unlinkSync(tmpZip);

      } catch (e) {
        log(`Failed to process ${fileName}: ${e.message}`);
      }
    }

    await logRun('success', totalRecords, `Loaded ${totalRecords} records from ${fromStr} to ${toStr}`);
    log(`Done — ${totalRecords} total records processed`);

  } catch (e) {
    log(`Loader failed: ${e.message}`);
    await logRun('error', totalRecords, e.message);
    throw e;
  } finally {
    await pool.end();
  }
}

async function extractAndParse(zipPath) {
  const AdmZip = require('adm-zip');
  const records = [];

  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.toLowerCase();

      if (name.endsWith('.xml')) {
        log(`Parsing XML: ${entry.entryName}`);
        const xmlContent = entry.getData().toString('utf8');
        const tmpXml = path.join(TMP_DIR, `tmp_${Date.now()}.xml`);
        fs.writeFileSync(tmpXml, xmlContent);
        const parsed = await parseXmlFile(tmpXml);
        fs.unlinkSync(tmpXml);
        records.push(...parsed);
        log(`Got ${parsed.length} records from ${entry.entryName}`);
      }
    }
  } catch (e) {
    log(`Zip extraction error: ${e.message}`);
  }

  return records;
}

// Run if called directly
const mode = process.argv[2] || 'incremental';
runLoader(mode).catch(e => {
  console.error('[loader] Fatal error:', e.message);
  process.exit(1);
});
