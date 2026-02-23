/* server.js
   Trademarkyo backend
   - TESS scrape via puppeteer-core + system Chromium
   - Fallback to USPTO IBD-ish endpoint (best-effort)
   - Fallback to AI-only if both fail
*/

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const puppeteer = require('puppeteer-core');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 8080);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromeExecutable() {
  // Allow override
  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Railway/Nixpacks typical system paths
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function launchBrowser() {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium executable not found. Tried CHROME_PATH, /usr/bin/google-chrome, /usr/bin/chromium-browser, /usr/bin/chromium.'
    );
  }

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
    ],
  });
}

function normalizeMarkForQuery(mark) {
  // TESS search: wildcard around mark, and [COMB] as user requested
  // Keep it simple: uppercase and collapse whitespace
  const cleaned = String(mark || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return cleaned;
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function scrapeTessDetailed(mark) {
  const browser = await launchBrowser();
  const results = [];
  const maxResults = 15;

  // URLs
  const startUrl =
    'https://tess2.uspto.gov/bin/gate.exe?f=searchss&state=4802:n19s2n.1.1';

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(60_000);

    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    );

    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    const queryMark = normalizeMarkForQuery(mark);
    const query = `*${queryMark}*[COMB]`;

    // Fill input[name="p_s_All"]
    await page.waitForSelector('input[name="p_s_All"]');
    await page.focus('input[name="p_s_All"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(query, { delay: 10 });

    // Submit: try common submit controls, else press Enter
    const didClickSubmit = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"]'));
      const candidates = btns.filter((b) => {
        const t = (b.value || b.textContent || '').toLowerCase();
        return t.includes('submit') || t.includes('search') || t.includes('query');
      });
      const target = candidates[0] || btns[0];
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (!didClickSubmit) {
      await page.keyboard.press('Enter');
    }

    // Wait for results page to render
    await page.waitForTimeout(1500);

    // Extract result links heuristically. TESS is old HTML; links often contain f=doc or f=docu
    const rows = await page.$$eval('a', (anchors) => {
      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();

        // Heuristic for doc links
        if (!href) continue;
        const hrefLower = href.toLowerCase();
        if (!hrefLower.includes('f=doc') && !hrefLower.includes('f=docu')) continue;

        const tr = a.closest('tr');
        const rowText = tr ? tr.innerText.replace(/\s+/g, ' ').trim() : '';
        out.push({
          href,
          anchorText: text,
          rowText,
        });
      }
      return out;
    });

    // Build a de-duped list of detail URLs
    const seen = new Set();
    const detailUrls = [];
    for (const r of rows) {
      try {
        const abs = new URL(r.href, page.url()).toString();
        if (!seen.has(abs)) {
          seen.add(abs);
          detailUrls.push({ url: abs, rowText: r.rowText });
        }
      } catch {
        // ignore
      }
      if (detailUrls.length >= maxResults) break;
    }

    // If no doc links found, attempt alternative: look for table rows that include serial-like numbers and click first link in row
    if (detailUrls.length === 0) {
      const alt = await page.$$eval('tr', (trs) => {
        const out = [];
        for (const tr of trs) {
          const t = tr.innerText.replace(/\s+/g, ' ').trim();
          if (!t) continue;
          // serial numbers are often 8 digits
          const m = t.match(/\b\d{8}\b/);
          if (!m) continue;
          const a = tr.querySelector('a[href]');
          if (!a) continue;
          out.push({
            href: a.getAttribute('href'),
            rowText: t,
          });
        }
        return out;
      });

      for (const r of alt) {
        try {
          const abs = new URL(r.href, page.url()).toString();
          if (!seen.has(abs)) {
            seen.add(abs);
            detailUrls.push({ url: abs, rowText: r.rowText });
          }
        } catch {
          // ignore
        }
        if (detailUrls.length >= maxResults) break;
      }
    }

    // Visit each detail page and pull fields from body text
    for (const item of detailUrls.slice(0, maxResults)) {
      const detail = await browser.newPage();
      detail.setDefaultNavigationTimeout(60_000);
      detail.setDefaultTimeout(60_000);

      await detail.goto(item.url, { waitUntil: 'domcontentloaded' });
      await detail.waitForTimeout(500);

      const bodyText = await detail.evaluate(() => {
        const t = document.body ? document.body.innerText : '';
        return t.replace(/\r/g, '');
      });

      // Parse common fields with regex (best-effort)
      const serial =
        (bodyText.match(/Serial Number:\s*([0-9]+)/i) || [])[1] ||
        (item.rowText.match(/\b\d{8}\b/) || [])[0] ||
        null;

      const liveDead =
        (bodyText.match(/\b(LIVE|DEAD)\b/i) || [])[1] ||
        (item.rowText.match(/\b(LIVE|DEAD)\b/i) || [])[1] ||
        null;

      const markName =
        (bodyText.match(/Word Mark:\s*([^\n]+)\n/i) || [])[1] ||
        (bodyText.match(/Mark:\s*([^\n]+)\n/i) || [])[1] ||
        null;

      // Owner can appear in various formats; capture a reasonable slice
      let owner = null;
      const ownerMatch =
        bodyText.match(/Owner:\s*([^\n]+)\n/i) ||
        bodyText.match(/Owner Name:\s*([^\n]+)\n/i) ||
        bodyText.match(/Current Owner:\s*([^\n]+)\n/i);
      if (ownerMatch) owner = ownerMatch[1].trim();

      // Goods/Services blocks can be large. Capture a section starting at "Goods and Services"
      let goodsServices = null;
      const gsIdx = bodyText.toLowerCase().indexOf('goods and services');
      if (gsIdx !== -1) {
        const slice = bodyText.slice(gsIdx, gsIdx + 2500);
        goodsServices = slice.split('\n').slice(0, 60).join('\n').trim();
      }

      // Filing / registration dates (best-effort)
      const filingDate = (bodyText.match(/Filing Date:\s*([^\n]+)\n/i) || [])[1] || null;
      const regDate = (bodyText.match(/Registration Date:\s*([^\n]+)\n/i) || [])[1] || null;

      results.push({
        source: 'tess_scrape',
        serialNumber: serial,
        liveDeadStatus: liveDead ? liveDead.toUpperCase() : null,
        markName: markName ? markName.trim() : null,
        owner: owner ? owner.trim() : null,
        filingDate: filingDate ? filingDate.trim() : null,
        registrationDate: regDate ? regDate.trim() : null,
        goodsServices: goodsServices || null,
        detailUrl: item.url,
        rawRow: item.rowText || null,
      });

      await detail.close();
      // be polite to TESS
      await sleep(250);
    }

    await page.close();

    if (results.length === 0) {
      throw new Error('TESS scrape returned 0 results (no parseable rows/links found).');
    }

    return results.slice(0, maxResults);
  } finally {
    await browser.close();
  }
}

async function fallbackUsptoDeveloperApi(mark) {
  // Best-effort fallback. USPTO has had multiple trademark-related APIs over time.
  // This attempts an IBD-style endpoint that some community posts reference.
  // If it fails (404/403/changed schema), we throw and the caller will proceed to AI-only.
  const q = normalizeMarkForQuery(mark);

  // Common older pattern (may be deprecated): /ibd-api/v1/trademark/documents?text=...&start=0&rows=...
  const url =
    `https://developer.uspto.gov/ibd-api/v1/trademark/documents?text=${encodeURIComponent(q)}&start=0&rows=15`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`USPTO fallback API failed (${resp.status}): ${truncate(text, 180)}`);
  }

  const data = await resp.json();

  // Schema varies. We normalize defensively.
  const items =
    data?.results ||
    data?.response?.docs ||
    data?.docs ||
    data?.documents ||
    [];

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('USPTO fallback API returned no results or unknown schema.');
  }

  const normalized = items.slice(0, 15).map((it) => {
    const serial =
      it.serialNumber ||
      it.serial_no ||
      it.serial ||
      it['serial-number'] ||
      null;

    const markName =
      it.markLiteral ||
      it.mark_name ||
      it.wordMark ||
      it.markText ||
      it.title ||
      null;

    const status =
      it.status ||
      it.liveDeadStatus ||
      it.live_dead_ind ||
      it.state ||
      null;

    const owner =
      it.owner ||
      it.ownerName ||
      it.currentOwner ||
      it.partyName ||
      null;

    const goods =
      it.goodsAndServices ||
      it.goods_services ||
      it.description ||
      null;

    return {
      source: 'uspto_fallback_api',
      serialNumber: serial ? String(serial) : null,
      liveDeadStatus: status ? String(status).toUpperCase() : null,
      markName: markName ? String(markName) : null,
      owner: owner ? String(owner) : null,
      goodsServices: goods ? String(goods) : null,
      detailUrl: null,
      raw: it,
    };
  });

  return normalized;
}

async function callClaudeDupontAnalysis({ markName, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 900,
    temperature: 0.2,
    system:
      'You are a trademark clearance assistant. Perform a DuPont factor likelihood-of-confusion analysis. ' +
      'Return ONLY valid JSON that matches the requested schema. No markdown.',
    messages: [
      {
        role: 'user',
        content:
          `Analyze trademark risk for proposed mark: "${markName}".\n\n` +
          `Potentially relevant prior marks (from search):\n` +
          JSON.stringify(results || [], null, 2) +
          `\n\nReturn JSON in this exact shape:\n` +
          `{\n` +
          `  "approvalScore": number (0-100),\n` +
          `  "verdict": "approve" | "caution" | "reject",\n` +
          `  "distinctiveness": string,\n` +
          `  "mainRisks": string[],\n` +
          `  "recommendation": string,\n` +
          `  "conflictAnalysis": [\n` +
          `    {\n` +
          `      "serialNumber": string|null,\n` +
          `      "markName": string|null,\n` +
          `      "status": string|null,\n` +
          `      "similarity": string,\n` +
          `      "goodsServicesOverlap": string,\n` +
          `      "riskLevel": "low" | "medium" | "high"\n` +
          `    }\n` +
          `  ]\n` +
          `}\n`,
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Claude API error (${resp.status}): ${truncate(text, 250)}`);
  }

  const parsed = safeJsonParse(text);
  // Anthropic returns a JSON envelope; the assistant content is inside content[].text
  const contentText = parsed?.content?.[0]?.text;
  if (!contentText) {
    throw new Error('Claude response missing content text.');
  }

  const analysisJson = safeJsonParse(contentText);
  if (!analysisJson) {
    throw new Error('Claude did not return valid JSON in content text.');
  }

  return analysisJson;
}

/**
 * POST /api/search
 * body: { markName: string }
 * returns: { mode: 'tess_scrape'|'uspto_fallback_api'|'ai_only', results: [], meta: {} }
 */
app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName is required' });

  const meta = {
    markName,
    attempted: [],
    errors: [],
  };

  // 1) TESS scrape
  try {
    meta.attempted.push('tess_scrape');
    const results = await scrapeTessDetailed(markName);
    return res.json({
      mode: 'tess_scrape',
      results,
      meta,
    });
  } catch (e) {
    meta.errors.push({ step: 'tess_scrape', message: String(e?.message || e) });
  }

  // 2) USPTO developer API fallback (best-effort)
  try {
    meta.attempted.push('uspto_fallback_api');
    const results = await fallbackUsptoDeveloperApi(markName);
    return res.json({
      mode: 'uspto_fallback_api',
      results,
      meta,
    });
  } catch (e) {
    meta.errors.push({ step: 'uspto_fallback_api', message: String(e?.message || e) });
  }

  // 3) AI-only
  meta.attempted.push('ai_only');
  return res.json({
    mode: 'ai_only',
    results: [],
    meta,
  });
});

/**
 * POST /api/analyze
 * body: { markName: string, results?: array }
 * returns Claude JSON analysis
 */
app.post('/api/analyze', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const results = Array.isArray(req.body?.results) ? req.body.results : [];

  if (!markName) return res.status(400).json({ error: 'markName is required' });

  try {
    const analysis = await callClaudeDupontAnalysis({ markName, results });
    return res.json(analysis);
  } catch (e) {
    return res.status(500).json({
      error: 'Claude analysis failed',
      message: String(e?.message || e),
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Trademarkyo running on port ${PORT}`);
});
