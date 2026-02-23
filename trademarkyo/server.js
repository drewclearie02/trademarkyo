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

async function scrapeUsptoTrademark(markName) {
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    await page.goto('https://tmsearch.uspto.gov/search/search-information', {
      waitUntil: 'networkidle2', timeout: 45000
    });
    await sleep(2000);

    // Type into the search bar (id="searchbar")
    await page.waitForSelector('#searchbar', { timeout: 10000 });
    await page.click('#searchbar');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('#searchbar', markName.toUpperCase(), { delay: 50 });
    console.log('[scrape] Typed mark:', markName.toUpperCase());

    // Click the search button
    const btnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, mat-icon'));
      const searchBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'search');
      if (searchBtn) { searchBtn.click(); return true; }
      // Try clicking button near the input
      const inputParent = document.querySelector('#searchbar')?.closest('form, mat-form-field, div');
      const btn = inputParent?.querySelector('button');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!btnClicked) await page.keyboard.press('Enter');
    console.log('[scrape] Search submitted');

    // Wait for results to load — wait for result cards to appear
    console.log('[scrape] Waiting for results...');
    await sleep(3000);

    // Wait for actual trademark result elements
    // tmsearch.uspto.gov uses Angular Material — results appear as mat-card or similar
    try {
      await page.waitForFunction(() => {
        // Look for elements containing 8-digit serial numbers (trademark serials)
        const body = document.body.innerText;
        return body.match(/\b\d{8}\b/) || document.querySelectorAll('[class*="result-item"], [class*="trademark-result"], mat-card, .result-row').length > 0;
      }, { timeout: 10000 });
      console.log('[scrape] Results appeared');
    } catch {
      console.log('[scrape] Timeout waiting for results, proceeding anyway');
    }

    await sleep(2000);

    // Log all class names on the page to identify result containers
    const classNames = await page.evaluate(() => {
      const classes = new Set();
      document.querySelectorAll('*').forEach(el => {
        el.className && String(el.className).split(' ').forEach(c => c && classes.add(c));
      });
      return Array.from(classes).filter(c => c.length > 3 && c.length < 50).slice(0, 80);
    });
    console.log('[scrape] Page classes:', classNames.join(', '));

    // Get full page text to find serial numbers
    const fullText = await page.evaluate(() => document.body?.innerText || '');
    console.log('[scrape] Full page text (first 1500):', fullText.substring(0, 1500));

    // Extract all 8-digit serial numbers from the page
    const serialMatches = [...fullText.matchAll(/\b(\d{8})\b/g)].map(m => m[1]);
    const uniqueSerials = [...new Set(serialMatches)].slice(0, 15);
    console.log('[scrape] Serials found:', uniqueSerials);

    // Try to extract structured data from result rows
    const rawData = await page.evaluate(() => {
      const items = [];

      // Try various Angular Material / custom selectors
      const selectors = [
        'app-result-item', 'app-search-result', 'app-trademark-result',
        '[class*="result-item"]', '[class*="search-result"]',
        'mat-list-item', 'mat-card',
        'tbody tr', 'table tr',
        '[role="listitem"]', '[role="row"]',
      ];

      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          console.log('Found', els.length, 'elements with selector:', sel);
          els.forEach(el => {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 5) return;
            const serial = text.match(/\b(\d{8})\b/)?.[1];
            items.push({ text: text.substring(0, 500), serial: serial || null, selector: sel });
          });
          if (items.length > 2) break;
        }
      }

      return items.slice(0, 20);
    });

    console.log(`[scrape] Structured items: ${rawData.length}`);
    if (rawData[0]) console.log('[scrape] First item:', JSON.stringify(rawData[0]).substring(0, 300));

    // If we found structured items with serials, use them
    const itemsWithSerials = rawData.filter(r => r.serial);
    if (itemsWithSerials.length > 0) {
      for (const r of itemsWithSerials) {
        results.push({
          source: 'tmsearch',
          serialNumber: r.serial,
          liveDeadStatus: /dead|abandon|cancel/i.test(r.text) ? 'DEAD' : 'LIVE',
          markName: null,
          owner: null,
          goodsServices: r.text,
          filingDate: null,
          registrationDate: null,
        });
      }
    } else if (uniqueSerials.length > 0) {
      // Fallback: use serial numbers found in page text
      // Build context around each serial
      for (const serial of uniqueSerials) {
        const idx = fullText.indexOf(serial);
        const context = fullText.substring(Math.max(0, idx - 100), idx + 200);
        results.push({
          source: 'tmsearch',
          serialNumber: serial,
          liveDeadStatus: /dead|abandon|cancel/i.test(context) ? 'DEAD' : 'LIVE',
          markName: null,
          owner: null,
          goodsServices: context.replace(/\s+/g, ' ').trim(),
          filingDate: null,
          registrationDate: null,
        });
      }
    }

    await page.close();
    console.log(`[scrape] Returning ${results.length} results`);
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
      system: 'You are a trademark clearance assistant. Perform DuPont factor analysis. Return ONLY a raw JSON object. No markdown. No explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for: "${markName}".\n\nUSPTO records (${results.length} found):\n${JSON.stringify(results, null, 2)}\n\nReturn ONLY this JSON:\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high"}]}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  const result = safeJsonParse(stripped);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });
  try {
    const results = await scrapeUsptoTrademark(markName);
    return res.json({ mode: results.length > 0 ? 'tess_scrape' : 'ai_only', results, meta: { markName } });
  } catch (e) {
    console.error('[search] Failed:', e.message);
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
