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

// Navigate directly to USPTO's trademark search app and use its search box
async function scrapeUsptoTrademark(markName) {
  const browser = await launchBrowser();
  const results = [];

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    // Go directly to the trademark search tool (not the main USPTO site search)
    const url = `https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(markName)}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`;
    console.log('[scrape] Trying TSDR direct URL...');

    // Actually use the proper trademark search
    // The new USPTO search is at tmsearch.uspto.gov
    await page.goto('https://tmsearch.uspto.gov/search/search-information', {
      waitUntil: 'networkidle2', timeout: 45000
    });
    await sleep(2000);

    console.log('[scrape] URL:', page.url());
    console.log('[scrape] Title:', await page.title());

    const inputInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, id: i.id, placeholder: i.placeholder, type: i.type, class: i.className.substring(0,50) }))
    );
    console.log('[scrape] Inputs:', JSON.stringify(inputInfo));

    // Find and fill the mark search input
    const searchSelectors = [
      'input[id*="mark"]',
      'input[name*="mark"]',
      'input[placeholder*="mark" i]',
      'input[placeholder*="trademark" i]',
      'input[placeholder*="search" i]',
      'input[type="text"]:not([type="hidden"])',
      'input[type="search"]',
    ];

    let typed = false;
    for (const sel of searchSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await el.click();
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await el.type(markName.toUpperCase(), { delay: 50 });
        console.log('[scrape] Typed into:', sel);
        typed = true;
        break;
      } catch (e) {
        console.log('[scrape] Selector failed:', sel, e.message.substring(0, 50));
      }
    }

    if (!typed) {
      const html = await page.content();
      console.log('[scrape] No input found. HTML (first 800):', html.substring(0, 800));
      throw new Error('Could not find search input');
    }

    // Submit
    const btnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const searchBtn = btns.find(b => (b.textContent || b.value || '').toLowerCase().includes('search'));
      if (searchBtn) { searchBtn.click(); return true; }
      return false;
    });
    if (!btnClicked) await page.keyboard.press('Enter');
    console.log('[scrape] Submitted, btn clicked:', btnClicked);

    await sleep(5000);
    console.log('[scrape] Post-search URL:', page.url());

    const pageText = await page.evaluate(() => document.body?.innerText || '');
    console.log('[scrape] Results text (first 800):', pageText.substring(0, 800));

    // Extract trademark records - look for serial numbers and mark names
    const rawData = await page.evaluate(() => {
      const rows = [];

      // Try table rows
      document.querySelectorAll('tr').forEach(tr => {
        const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 5) return;
        const serial = text.match(/\b(\d{8})\b/)?.[1];
        if (serial || text.length > 20) {
          rows.push({ text: text.substring(0, 400), serial: serial || null });
        }
      });

      if (rows.length > 2) return rows.slice(0, 15);

      // Try list items / cards
      const cards = document.querySelectorAll('[class*="result"], [class*="record"], [class*="item"], [class*="card"], li');
      cards.forEach(c => {
        const text = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 10) return;
        const serial = text.match(/\b(\d{8})\b/)?.[1];
        rows.push({ text: text.substring(0, 400), serial: serial || null });
      });

      return rows.slice(0, 15);
    });

    console.log(`[scrape] Raw rows: ${rawData.length}`);
    if (rawData[0]) console.log('[scrape] Sample:', JSON.stringify(rawData[0]).substring(0, 200));

    for (const r of rawData) {
      if (!r.text || r.text.length < 5) continue;
      results.push({
        source: 'tmsearch_scrape',
        serialNumber: r.serial,
        liveDeadStatus: r.text.toUpperCase().includes('DEAD') || r.text.toUpperCase().includes('ABANDON') ? 'DEAD' : 'LIVE',
        markName: null,
        owner: null,
        goodsServices: r.text,
        filingDate: null,
        registrationDate: null,
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
  console.log('[claude] Response start:', rawContent.substring(0, 150));
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
