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

// ── Persistent browser instance ───────────────────────────────────────────────
let browserInstance = null;
let browserLaunching = false;

async function getBrowser() {
  if (browserInstance) {
    try { await browserInstance.version(); return browserInstance; } catch { browserInstance = null; }
  }
  if (browserLaunching) {
    while (browserLaunching) await sleep(200);
    return browserInstance;
  }
  browserLaunching = true;
  try {
    const executablePath = findChrome();
    console.log('[browser] Launching Chrome:', executablePath);
    browserInstance = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--no-zygote', '--single-process',
        '--disable-extensions', '--disable-background-networking',
      ],
    });
    browserInstance.on('disconnected', () => {
      console.log('[browser] Disconnected - will relaunch on next request');
      browserInstance = null;
    });
    console.log('[browser] Chrome ready');
    return browserInstance;
  } finally {
    browserLaunching = false;
  }
}

// ── Search cache (24 hour TTL) ────────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCacheKey(markName, classCode) {
  return `${markName.toUpperCase()}::${classCode || ''}`;
}

function getCached(markName, classCode) {
  const key = getCacheKey(markName, classCode);
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  console.log(`[cache] HIT for "${markName}" (${searchCache.size} entries cached)`);
  return entry.results;
}

function setCache(markName, classCode, results) {
  const key = getCacheKey(markName, classCode);
  searchCache.set(key, { results, timestamp: Date.now() });
  console.log(`[cache] STORED "${markName}" (${searchCache.size} entries cached)`);
  if (searchCache.size > 200) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    searchCache.delete(oldest[0]);
  }
}

// ── Mark variations ───────────────────────────────────────────────────────────
function getMarkVariations(markName) {
  const base = markName.trim().toUpperCase();
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
    if (/[XZ]$/.test(base) || /CH$/.test(base) || /SH$/.test(base)) variations.add(base + 'ES');
    if (base.endsWith('Y') && base.length > 1) variations.add(base.slice(0, -1) + 'IES');
  }

  if (base.endsWith('ING') && base.length > 4) {
    variations.add(base.slice(0, -3));
    variations.add(base.slice(0, -3) + 'E');
  } else if (!base.includes(' ') && base.length <= 8 && !base.endsWith('ING')) {
    variations.add(base + 'ING');
  }

  return [...variations].filter(v => v.length >= 2);
}

// ── Scrape a single variant ───────────────────────────────────────────────────
async function scrapeVariant(browser, markName, classCode) {
  const results = [];
  let page;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    await page.goto('https://tmsearch.uspto.gov/search/search-information', {
      waitUntil: 'networkidle2', timeout: 45000
    });
    await sleep(2000);

    await page.waitForSelector('#searchbar', { timeout: 10000 });
    await page.click('#searchbar');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('#searchbar', markName.toUpperCase(), { delay: 50 });
    console.log('[scrape] Typed mark:', markName.toUpperCase());

    const btnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, mat-icon'));
      const searchBtn = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'search');
      if (searchBtn) { searchBtn.click(); return true; }
      const inputParent = document.querySelector('#searchbar')?.closest('form, mat-form-field, div');
      const btn = inputParent?.querySelector('button');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!btnClicked) await page.keyboard.press('Enter');

    await sleep(4000);

    if (classCode) {
      try {
        const classApplied = await page.evaluate((cls) => {
          const inputs = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
          const classInput = inputs.find(i => {
            const label = i.closest('label') || document.querySelector(`label[for="${i.id}"]`);
            const text = (label?.innerText || i.value || i.id || '').toLowerCase();
            return text.includes(cls) || text.includes(`class ${cls}`);
          });
          if (classInput && !classInput.checked) { classInput.click(); return true; }
          return false;
        }, classCode);
        if (classApplied) await sleep(2000);
      } catch (e) {
        console.log('[scrape] Could not apply class filter:', e.message);
      }
    }

    try {
      await page.waitForFunction(() => document.body.innerText.match(/\b\d{8}\b/), { timeout: 10000 });
    } catch {
      console.log('[scrape] Timeout waiting for serial numbers');
    }

    await sleep(2000);

    const fullText = await page.evaluate(() => document.body?.innerText || '');
    const serialMatches = [...fullText.matchAll(/\b(\d{8})\b/g)].map(m => m[1]);
    const uniqueSerials = [...new Set(serialMatches)].slice(0, 50);
    console.log('[scrape] Serials found:', uniqueSerials.length);

    const rawData = await page.evaluate(() => {
      const items = [];
      const selectors = [
        'app-result-item', 'app-search-result', 'app-trademark-result',
        '[class*="result-item"]', '[class*="search-result"]',
        'mat-list-item', 'mat-card', 'tbody tr', '[role="listitem"]', '[role="row"]',
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 1) {
          els.forEach(el => {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 5) return;
            const serial = text.match(/\b(\d{8})\b/)?.[1];
            items.push({ text: text.substring(0, 500), serial: serial || null });
          });
          if (items.length > 2) break;
        }
      }
      return items.slice(0, 50);
    });

    const itemsWithSerials = rawData.filter(r => r.serial);

    if (itemsWithSerials.length > 0) {
      for (const r of itemsWithSerials) {
        results.push({
          source: 'tmsearch', serialNumber: r.serial,
          liveDeadStatus: /dead|abandon|cancel/i.test(r.text) ? 'DEAD' : 'LIVE',
          markName: null, owner: null, goodsServices: r.text,
          internationalClass: classCode || null, filingDate: null, registrationDate: null,
        });
      }
    } else if (uniqueSerials.length > 0) {
      for (const serial of uniqueSerials) {
        const idx = fullText.indexOf(serial);
        const context = fullText.substring(Math.max(0, idx - 100), idx + 300);
        results.push({
          source: 'tmsearch', serialNumber: serial,
          liveDeadStatus: /dead|abandon|cancel/i.test(context) ? 'DEAD' : 'LIVE',
          markName: null, owner: null, goodsServices: context.replace(/\s+/g, ' ').trim(),
          internationalClass: classCode || null, filingDate: null, registrationDate: null,
        });
      }
    }

    console.log(`[scrape] Variant "${markName}" returning ${results.length} results`);
    return results;
  } catch (e) {
    console.log(`[scrape] Variant "${markName}" failed:`, e.message);
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Main scrape — parallel variations ─────────────────────────────────────────
async function scrapeUsptoTrademark(markName, classCode) {
  const cached = getCached(markName, classCode);
  if (cached) return cached;

  const browser = await getBrowser();
  const variations = getMarkVariations(markName);
  console.log(`[scrape] Searching ${variations.length} variations in parallel: ${variations.join(', ')}`);

  // Run all variations concurrently instead of sequentially
  const variantResults = await Promise.all(
    variations.map(async (variant) => {
      const results = await scrapeVariant(browser, variant, classCode);
      return results.map(r => ({
        ...r,
        matchedVariant: variant,
        isVariation: variant !== markName.toUpperCase(),
      }));
    })
  );

  const allResults = variantResults.flat();

  // Deduplicate by serial number
  const seen = new Set();
  const deduped = allResults.filter(r => {
    if (seen.has(r.serialNumber)) return false;
    seen.add(r.serialNumber);
    return true;
  });

  console.log(`[scrape] Total unique results: ${deduped.length}`);
  setCache(markName, classCode, deduped);
  return deduped;
}

// ── Claude analysis ───────────────────────────────────────────────────────────
async function callClaude({ markName, classCode, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const classContext = classCode
    ? `The applicant is seeking registration in International Class ${classCode}.`
    : 'No specific class specified - analyze across all relevant classes.';

  const variantCount = results.filter(r => r.isVariation).length;
  const variantNote = variantCount > 0
    ? `\nIMPORTANT: ${variantCount} result(s) were found by searching plural/variation forms of the mark. Under established USPTO practice and DuPont factors, plural and singular forms of a mark are treated as confusingly similar. Weight these results accordingly.`
    : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      temperature: 0.2,
      system: 'You are a trademark clearance attorney assistant. Perform rigorous DuPont factor likelihood-of-confusion analysis. Return ONLY a raw JSON object. No markdown. No explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for proposed mark: "${markName}".\n${classContext}${variantNote}\n\nUSPTO records found (${results.length}):\n${JSON.stringify(results, null, 2)}\n\nReturn ONLY this JSON:\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high","isVariation":boolean}]}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  const result = safeJsonParse(rawContent);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });
  try {
    const results = await scrapeUsptoTrademark(markName, classCode);
    return res.json({ mode: results.length > 0 ? 'tess_scrape' : 'ai_only', results, meta: { markName, classCode } });
  } catch (e) {
    console.error('[search] Failed:', e.message);
    return res.json({ mode: 'ai_only', results: [], meta: { markName, classCode, error: e.message } });
  }
});

app.post('/api/analyze', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!markName) return res.status(400).json({ error: 'markName required' });
  try {
    return res.json(await callClaude({ markName, classCode, results }));
  } catch (e) {
    return res.status(500).json({ error: 'Claude failed', message: String(e?.message || e) });
  }
});

app.post('/api/suggest', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  const score = Number(req.body?.score || 0);
  const risks = String(req.body?.risks || '');
  const conflicts = String(req.body?.conflicts || '');
  if (!markName) return res.status(400).json({ error: 'markName required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        temperature: 0.9,
        system: 'You are a creative trademark attorney and brand naming expert. Return ONLY a raw JSON object. No markdown. No backticks. No explanation. Just the JSON.',
        messages: [{
          role: 'user',
          content: `The proposed trademark "${markName}" scored ${score}% approval likelihood due to: ${conflicts}. Risks: ${risks}. ${classCode ? `Class ${classCode}.` : ''}\nGenerate 6 distinctive alternative brand names.\nReturn ONLY this JSON with no other text:\n{"suggestions":[{"name":"MARKNAME","reason":"one sentence why stronger"}]}`
        }]
      })
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Claude API (${resp.status})`);
    const parsed = JSON.parse(text);
    const rawContent = parsed?.content?.[0]?.text || '';
    const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const result = safeJsonParse(stripped);
    if (!result || !Array.isArray(result.suggestions)) throw new Error('Claude returned invalid JSON structure');
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Suggestion failed', message: String(e?.message || e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, cacheSize: searchCache.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`Trademarkyo running on port ${PORT}`);
  try {
    await getBrowser();
    console.log('[browser] Pre-warmed and ready');
  } catch (e) {
    console.error('[browser] Pre-warm failed:', e.message);
  }
});
