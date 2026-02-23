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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function truncate(s, n) { const str = String(s || ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }

function safeJsonParse(text) {
  if (!text) return null;
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome not found');
}

async function launchBrowser() {
  const executablePath = findChrome();
  console.log('[browser] Chrome:', executablePath);
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
}

async function scrapeTess(markName) {
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(45000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    console.log('[tess] Navigating to TESS...');
    await page.goto('https://tess2.uspto.gov/bin/gate.exe?f=searchss&state=4802:n19s2n.1.1', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });

    const query = `*${markName.toUpperCase().trim()}*[COMB]`;
    console.log('[tess] Query:', query);

    await page.waitForSelector('input[name="p_s_All"]', { timeout: 15000 });
    await page.click('input[name="p_s_All"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('input[name="p_s_All"]', query, { delay: 30 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.keyboard.press('Enter')
    ]);

    await sleep(1500);

    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
    console.log('[tess] Page text (first 400 chars):', pageText.substring(0, 400));

    if (pageText.includes('No TESS records') || pageText.includes('0 records')) {
      console.log('[tess] TESS returned 0 records');
      return [];
    }

    const rawRows = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('tr').forEach(tr => {
        const text = tr.innerText || '';
        const m = text.match(/\b(\d{8})\b/);
        if (!m) return;
        const link = tr.querySelector('a[href]');
        rows.push({
          serial: m[1],
          text: text.replace(/\s+/g, ' ').trim(),
          href: link ? link.getAttribute('href') : null,
          cells: Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim())
        });
      });

      if (rows.length === 0) {
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || '';
          const text = a.innerText.trim();
          const m = (href + ' ' + text).match(/\b(\d{8})\b/);
          if (m && (href.includes('f=doc') || href.includes('serial'))) {
            rows.push({ serial: m[1], text, href, cells: [text] });
          }
        });
      }
      return rows;
    });

    console.log(`[tess] Found ${rawRows.length} result rows`);

    if (rawRows.length === 0) {
      // Log full page HTML for debugging
      const html = await page.content();
      console.log('[tess] Full page HTML (first 800):', html.substring(0, 800));
      throw new Error('No result rows found in TESS page');
    }

    const baseUrl = page.url();
    for (const row of rawRows.slice(0, 10)) {
      try {
        const detailUrl = row.href
          ? new URL(row.href, baseUrl).toString()
          : `https://tess2.uspto.gov/bin/showfield?f=doc&state=4802:n19s2n.2.1&p_serial=${row.serial}`;

        const dp = await browser.newPage();
        dp.setDefaultTimeout(20000);
        await dp.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(300);

        const d = await dp.evaluate(() => {
          const body = document.body ? document.body.innerText : '';
          const get = (re) => { const m = body.match(re); return m ? m[1].trim() : null; };
          return {
            wordMark: get(/Word Mark[:\s]+([^\n]+)/i),
            liveDead: get(/\b(LIVE|DEAD)\b/i),
            owner: get(/Owner[:\s]+([^\n]+)/i),
            goods: get(/Goods and Services[:\s]+([^\n]{10,})/i),
            filingDate: get(/Filing Date[:\s]+([^\n]+)/i),
            regDate: get(/Registration Date[:\s]+([^\n]+)/i),
            serialNo: get(/Serial Number[:\s]+(\d{8})/i),
          };
        });

        results.push({
          source: 'tess_scrape',
          serialNumber: d.serialNo || row.serial,
          liveDeadStatus: d.liveDead ? d.liveDead.toUpperCase() : (row.text.includes('DEAD') ? 'DEAD' : 'LIVE'),
          markName: d.wordMark || row.cells.find(c => c && c.length > 1 && !/^\d+$/.test(c)) || null,
          owner: d.owner,
          goodsServices: d.goods,
          filingDate: d.filingDate,
          registrationDate: d.regDate,
          detailUrl,
        });

        await dp.close();
        await sleep(150);
      } catch (e) {
        console.error('[tess] Detail error for serial', row.serial, ':', e.message);
        results.push({
          source: 'tess_basic',
          serialNumber: row.serial,
          liveDeadStatus: row.text.toUpperCase().includes('DEAD') ? 'DEAD' : 'LIVE',
          markName: row.cells.find(c => c && !/^\d+$/.test(c) && c.length > 1) || null,
          owner: null, goodsServices: null, filingDate: null, registrationDate: null, detailUrl: null,
        });
      }
    }

    await page.close();
    console.log(`[tess] Returning ${results.length} results`);
    return results;

  } finally {
    await browser.close();
  }
}

async function callClaude({ markName, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      temperature: 0.2,
      system: 'You are a trademark clearance assistant. Perform DuPont factor analysis. You MUST return ONLY a raw JSON object. Do NOT use markdown code fences. Do NOT include any text before or after the JSON.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for: "${markName}".\n\nUSPTO records (${results.length} found):\n${JSON.stringify(results, null, 2)}\n\nRespond with ONLY this JSON object (no markdown, no explanation):\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high"}]}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);

  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  console.log('[claude] Raw response (first 200):', rawContent.substring(0, 200));

  // Strip markdown fences and parse
  const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  const result = safeJsonParse(stripped);
  if (!result) {
    console.error('[claude] Failed to parse JSON. Raw:', rawContent.substring(0, 500));
    throw new Error('Claude returned invalid JSON');
  }
  return result;
}

app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    const results = await scrapeTess(markName);
    return res.json({ mode: 'tess_scrape', results, meta: { markName } });
  } catch (e) {
    console.error('[search] TESS failed:', e.message);
    return res.json({ mode: 'ai_only', results: [], meta: { markName, error: e.message } });
  }
});

app.post('/api/analyze', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    return res.json(await callClaude({ markName, results }));
  } catch (e) {
    return res.status(500).json({ error: 'Claude failed', message: String(e?.message || e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT}`));
