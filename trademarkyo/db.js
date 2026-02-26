'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS trademarks (
        serial_number   VARCHAR(20) PRIMARY KEY,
        mark_name       TEXT,
        owner           TEXT,
        status          VARCHAR(10),
        goods_services  TEXT,
        int_class       VARCHAR(50),
        filing_date     VARCHAR(20),
        reg_date        VARCHAR(20),
        updated_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_trademarks_mark_name
        ON trademarks USING gin(to_tsvector('english', COALESCE(mark_name, '')));

      CREATE INDEX IF NOT EXISTS idx_trademarks_mark_name_lower
        ON trademarks (lower(mark_name));

      CREATE INDEX IF NOT EXISTS idx_trademarks_status
        ON trademarks (status);

      CREATE TABLE IF NOT EXISTS loader_log (
        id          SERIAL PRIMARY KEY,
        run_date    TIMESTAMP DEFAULT NOW(),
        status      VARCHAR(20),
        records_processed INTEGER DEFAULT 0,
        message     TEXT
      );
    `);
    console.log('[db] Schema ready');
  } finally {
    client.release();
  }
}

/**
 * Search trademarks by mark name, with optional class filter.
 * Returns up to 50 results, live marks first.
 */
async function searchTrademarks(markName, classCode) {
  const name = markName.trim().toUpperCase();

  // Build variations (same logic as before)
  const variations = getVariations(name);
  console.log(`[db] Searching for: ${variations.join(', ')}`);

  // Build query with OR across all variations
  const conditions = variations.map((_, i) => `lower(mark_name) = lower($${i + 1})`);
  const likeConditions = [`lower(mark_name) LIKE lower($${variations.length + 1})`];

  let params = [...variations, `${name}%`];
  let classFilter = '';

  if (classCode) {
    classFilter = ` AND (int_class LIKE $${params.length + 1} OR int_class IS NULL)`;
    params.push(`%${classCode}%`);
  }

  const query = `
    SELECT *
    FROM trademarks
    WHERE (${[...conditions, ...likeConditions].join(' OR ')})
    ${classFilter}
    ORDER BY
      CASE WHEN status = 'LIVE' THEN 0 ELSE 1 END,
      mark_name
    LIMIT 50
  `;

  const result = await pool.query(query, params);

  return result.rows.map(r => ({
    source: 'postgresql',
    serialNumber: r.serial_number,
    markName: r.mark_name,
    owner: r.owner,
    liveDeadStatus: r.status || 'UNKNOWN',
    goodsServices: r.goods_services || '',
    internationalClass: r.int_class || null,
    filingDate: r.filing_date || null,
    registrationDate: r.reg_date || null,
    isVariation: r.mark_name?.toUpperCase() !== name,
    matchedVariant: r.mark_name?.toUpperCase(),
  }));
}

function getVariations(base) {
  const variations = new Set([base]);

  if (base.endsWith('IES') && base.length > 4) {
    variations.add(base.slice(0, -3) + 'Y');
  } else if (base.endsWith('ES') && base.length > 3) {
    variations.add(base.slice(0, -2));
  } else if (base.endsWith('S') && base.length > 2) {
    variations.add(base.slice(0, -1));
  }

  if (!base.endsWith('S')) {
    variations.add(base + 'S');
    if (/[XZ]$/.test(base) || /CH$/.test(base) || /SH$/.test(base)) {
      variations.add(base + 'ES');
    }
    if (base.endsWith('Y') && base.length > 1) {
      variations.add(base.slice(0, -1) + 'IES');
    }
  }

  if (base.endsWith('ING') && base.length > 4) {
    variations.add(base.slice(0, -3));
    variations.add(base.slice(0, -3) + 'E');
  } else if (!base.includes(' ') && base.length <= 8 && !base.endsWith('ING')) {
    variations.add(base + 'ING');
  }

  return [...variations].filter(v => v.length >= 2);
}

async function getLoaderStatus() {
  try {
    const result = await pool.query(
      'SELECT * FROM loader_log ORDER BY run_date DESC LIMIT 5'
    );
    return result.rows;
  } catch {
    return [];
  }
}

async function getTrademarkCount() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM trademarks');
    return parseInt(result.rows[0].count, 10);
  } catch {
    return 0;
  }
}

module.exports = { pool, initSchema, searchTrademarks, getLoaderStatus, getTrademarkCount };
