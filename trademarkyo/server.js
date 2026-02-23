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

async function scrapeUsptoSearch(markName) {
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    // USPTO's new trademark search
    const searchUrl = `https://www.uspto.gov/trademarks/search`;
    console.log('[scrape] Navigating to USPTO trademark search...');
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(2000);

    console.log('[scrape] Page title:', await page.title());
    console.log('[scrape] URL:', page.url());

    // Find search input
    const inputInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type="hidden"])'));
      return inputs.map(i => ({ name: i.name, id: i.id, placeholder: i.placeholder, type: i.type }));
    });
    console.log('[scrape] Inputs:', JSON.stringify(inputInfo));

    // Type in the search box - try multiple selectors
    const searchSelectors = [
      'input[placeholder*="Search"]',
      'input[placeholder*="trademark"]',
      'input[placeholder*="mark"]',
      'input[type="search"]',
      'input[id*="search"]',
      'input[name*="search"]',
      'input[type="text"]:not([type="hidden"])',
    ];

    let typed = false;
    for (const sel of searchSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.click(sel);
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.type(sel, markName.toUpperCase(), { delay: 50 });
        console.log('[scrape] Typed into:', sel);
        typed = true;
        break;
      } catch {}
    }

    if (!typed) {
      const html = await page.content();
      console.log('[scrape] Could not find input. HTML snippet:', html.substring(0, 600));
      throw new Error('Could not find search input on USPTO search page');
    }

    await sleep(500);
    await page.keyboard.press('Enter');
    console.log('[scrape] Submitted search');

    // Wait for results to load
    await sleep(5000);
    console.log('[scrape] Post-search URL:', page.url());

    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
    console.log('[scrape] Results page text (first 600):', pageText.substring(0, 600));

    // Extract results - the new USPTO search renders results as cards/rows
    const rawResults = await page.evaluate(() => {
      const results = [];

      // Try to find result items - USPTO new UI uses various structures
      const selectors = [
        '[data-testid*="result"]',
        '[class*="result"]',
        '[class*="trademark"]',
        'table tr',
        '[role="row"]',
        'li[class*="item"]',
      ];

      for (const sel of selectors) {
        const items = document.querySelectorAll(sel);
        if (items.length > 1) {
          items.forEach(item => {
            const text = item.innerText || item.textContent || '';
            if (!text.trim() || text.length < 5) return;
            // Look for serial numbers (8 digits)
            const serialMatch = text.match(/\b(\d{8})\b/);
            results.push({
              text: text.replace(/\s+/g, ' ').trim().substring(0, 300),
              serial: serialMatch ? serialMatch[1] : null,
              selector: sel
            });
          });
          if (results.length > 0) break;
        }
      }

      // Fallback: grab all text with serial-number patterns
      if (results.length === 0) {
        const allText = document.body ? document.body.innerText : '';
        const lines = allText.split('\n').filter(l => l.match(/\b\d{8}\b/));
        lines.forEach(line => {
          const m = line.match(/\b(\d{8})\b/);
          if (m) results.push({ text: line.trim(), serial: m[1], selector: 'text_parse' });
        });
      }

      return results.slice(0, 15);
    });

    console.log(`[scrape] Found ${rawResults.length} raw results`);
    if (rawResults.length > 0) {
      console.log('[scrape] Sample result:', JSON.stringify(rawResults[0]));
    }

    // Convert to structured format
    for (const r of rawResults) {
      const isLive = !r.text.toUpperCase().includes('DEAD') && !r.text.toUpperCase().includes('ABANDONED');
      results.push({
        source: 'uspto_scrape',
        serialNumber: r.serial,
        liveDeadStatus: isLive ? 'LIVE' : 'DEAD',
        markName: null, // Will be filled by detail if possible
        owner: null,
        goodsServices: r.text,
        filingDate: null,
        registrationDate: null,
        detailUrl: null,
        rawText: r.text,
      });
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
      system: 'You are a trademark clearance assistant. Perform DuPont factor analysis. Return ONLY a raw JSON object. No markdown fences. No explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for: "${markName}".\n\nUSPTO records (${results.length} found):\n${JSON.stringify(results, null, 2)}\n\nReturn ONLY this JSON (no markdown):\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high"}]}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);

  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  console.log('[claude] Raw response (first 200):', rawContent.substring(0, 200));

  const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  const result = safeJsonParse(stripped);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });
  try {
    const results = await scrapeUsptoSearch(markName);
    return res.json({ mode: results.length > 0 ? 'uspto_scrape' : 'ai_only', results, meta: { markName } });
  } catch (e) {
    console.error('[search] Scrape failed:', e.message);
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
