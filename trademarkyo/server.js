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

// ── Double Metaphone — pure JS, no dependencies ───────────────────────────────
// Returns an array of phonetic codes for a word.
// Used to generate sound-alike search variants (KWIK → QUICK, FROOT → FRUIT).
function doubleMetaphone(str) {
  if (!str || typeof str !== 'string') return [];
  const word = str.toUpperCase().replace(/[^A-Z]/g, '');
  if (!word.length) return [];

  let pri = '', sec = '';
  let i = 0;
  const len = word.length;
  const last = len - 1;

  const charAt = pos => (pos >= 0 && pos < len) ? word[pos] : '';
  const substr = (pos, n) => word.substring(pos, pos + n);
  const isVowel = pos => 'AEIOU'.includes(charAt(pos));

  // Skip initial silent letters
  if ('GNKP'.includes(charAt(0)) && charAt(1) === '') {
    // single char edge case
  }
  if (substr(0, 2) === 'AE' || substr(0, 2) === 'GN' || substr(0, 2) === 'KN' || substr(0, 2) === 'PN' || substr(0, 2) === 'WR') {
    i = 1;
  }

  // Initial vowel maps to A
  if (isVowel(0)) { pri += 'A'; sec += 'A'; i = 1; }

  while (i <= last) {
    const c = charAt(i);

    if ('AEIOU'.includes(c)) {
      // vowels only matter at start (already handled)
      i++; continue;
    }

    switch (c) {
      case 'B':
        pri += 'P'; sec += 'P';
        i += (charAt(i + 1) === 'B') ? 2 : 1;
        break;
      case 'C':
        if (substr(i, 4) === 'CHIA') { pri += 'K'; sec += 'K'; i += 2; break; }
        if (substr(i, 2) === 'CH') {
          if (i > 0 && isVowel(i - 2) && !isVowel(i + 2)) { pri += 'K'; sec += 'K'; }
          else { pri += 'X'; sec += 'K'; }
          i += 2; break;
        }
        if (substr(i, 2) === 'CI' || substr(i, 2) === 'CE' || substr(i, 2) === 'CY') {
          pri += 'S'; sec += 'S'; i += 2; break;
        }
        if (substr(i, 2) === 'CK' || substr(i, 2) === 'CG' || substr(i, 2) === 'CQ') {
          pri += 'K'; sec += 'K'; i += 2; break;
        }
        pri += 'K'; sec += 'K';
        i += (substr(i + 1, 2) === 'CC') ? 3 : (charAt(i + 1) === 'C' || charAt(i + 1) === 'K' || charAt(i + 1) === 'Q') ? 2 : 1;
        break;
      case 'D':
        if (substr(i, 2) === 'DG' && 'IEY'.includes(charAt(i + 2))) { pri += 'J'; sec += 'J'; i += 3; break; }
        if (substr(i, 2) === 'DT' || substr(i, 2) === 'DD') { pri += 'T'; sec += 'T'; i += 2; break; }
        pri += 'T'; sec += 'T'; i++; break;
      case 'F':
        pri += 'F'; sec += 'F';
        i += (charAt(i + 1) === 'F') ? 2 : 1;
        break;
      case 'G':
        if (charAt(i + 1) === 'H') {
          if (i > 0 && !isVowel(i - 1)) { pri += 'K'; sec += 'K'; i += 2; break; }
          if (i === 0) {
            if (charAt(i + 2) === 'I') { pri += 'J'; sec += 'J'; } else { pri += 'K'; sec += 'K'; }
            i += 2; break;
          }
          if ((i > 1 && 'BDH'.includes(charAt(i - 2))) || (i > 2 && 'BDH'.includes(charAt(i - 3))) || (i > 3 && 'BDH'.includes(charAt(i - 4)))) { i += 2; break; }
          if (i > 2 && charAt(i - 2) === 'U' && 'CGLRT'.includes(charAt(i - 3))) { pri += 'F'; sec += 'F'; i += 2; break; }
          if (i > 0 && charAt(i - 1) !== 'I') { pri += 'K'; sec += 'K'; }
          i += 2; break;
        }
        if (charAt(i + 1) === 'N') {
          if (i === 1 && isVowel(0)) { pri += 'KN'; sec += 'N'; }
          else { if (substr(i + 1, 3) !== 'NAT' && substr(i - 1, 2) !== 'GN') { pri += 'K'; sec += 'K'; } }
          i += 2; break;
        }
        if ('IEY'.includes(charAt(i + 1)) && substr(i - 1, 2) !== 'GG') {
          if (['GER','GEL','GEY','GI','GE','GY'].some(p => substr(i - 1, p.length + 1).endsWith(p)) && i > 0) {
            pri += 'K'; sec += 'J';
          } else { pri += 'J'; sec += 'J'; }
          i += 2; break;
        }
        if (charAt(i + 1) === 'G') { pri += 'K'; sec += 'K'; i += 2; break; }
        pri += 'K'; sec += 'K'; i++; break;
      case 'H':
        if (isVowel(i + 1) && (i === 0 || isVowel(i - 1))) { pri += 'H'; sec += 'H'; i += 2; break; }
        i++; break;
      case 'J':
        pri += 'J'; sec += 'J';
        i += (charAt(i + 1) === 'J') ? 2 : 1;
        break;
      case 'K':
        pri += 'K'; sec += 'K';
        i += (charAt(i + 1) === 'K') ? 2 : 1;
        break;
      case 'L':
        if (charAt(i + 1) === 'L') {
          if ((i === len - 3 && 'AOU'.includes(charAt(i - 1)) && (charAt(i + 2) === 'A' || substr(len - 2, 2) === 'AS' || substr(len - 2, 2) === 'OS')) || (isVowel(i + 2) && ['ILLO','ILLA','ALLE'].includes(substr(i - 1, 4)))) {
            pri += 'L'; sec += '';
          } else { pri += 'L'; sec += 'L'; }
          i += 2; break;
        }
        pri += 'L'; sec += 'L'; i++; break;
      case 'M':
        pri += 'M'; sec += 'M';
        i += (charAt(i + 1) === 'M' || (charAt(i - 1) === 'U' && charAt(i + 1) === 'B' && (i + 1 === last || substr(i + 2, 2) === 'ER'))) ? 2 : 1;
        break;
      case 'N':
        pri += 'N'; sec += 'N';
        i += (charAt(i + 1) === 'N') ? 2 : 1;
        break;
      case 'P':
        if (charAt(i + 1) === 'H') { pri += 'F'; sec += 'F'; i += 2; break; }
        pri += 'P'; sec += 'P';
        i += (charAt(i + 1) === 'P') ? 2 : 1;
        break;
      case 'Q':
        pri += 'K'; sec += 'K';
        i += (charAt(i + 1) === 'Q') ? 2 : 1;
        break;
      case 'R':
        if (i === last && !isVowel(i - 1) && substr(i - 2, 2) !== 'ME' && substr(i - 2, 2) !== 'MA') {
          pri += 'R'; sec += '';
        } else { pri += 'R'; sec += 'R'; }
        i += (charAt(i + 1) === 'R') ? 2 : 1;
        break;
      case 'S':
        if ('IEY'.includes(charAt(i + 1)) && substr(i - 1, 4) === 'ISLAN') { i++; break; }
        if (substr(i, 2) === 'SH' || (substr(i, 3) === 'SIO' || substr(i, 3) === 'SIA')) { pri += 'X'; sec += 'X'; i += 2; break; }
        if ((substr(i, 4) === 'SCHE' || substr(i, 4) === 'SCHI') && (substr(i + 2, 2) === 'ER' || substr(i + 2, 2) === 'EN')) { pri += 'SK'; sec += 'SK'; i += 3; break; }
        if (substr(i, 2) === 'SC') { pri += 'SK'; sec += 'SK'; i += 3; break; }
        if (i === last && (substr(i - 2, 2) === 'AI' || substr(i - 2, 2) === 'OI')) { pri += ''; sec += 'S'; i++; break; }
        pri += 'S'; sec += 'S';
        i += (charAt(i + 1) === 'S' || charAt(i + 1) === 'Z') ? 2 : 1;
        break;
      case 'T':
        if (substr(i, 3) === 'TIA' || substr(i, 3) === 'TCH') { pri += 'X'; sec += 'X'; i += 3; break; }
        if (substr(i, 2) === 'TH' || substr(i, 3) === 'TTH') { pri += '0'; sec += 'T'; i += 2; break; }
        pri += 'T'; sec += 'T';
        i += (charAt(i + 1) === 'T' || charAt(i + 1) === 'D') ? 2 : 1;
        break;
      case 'V':
        pri += 'F'; sec += 'F';
        i += (charAt(i + 1) === 'V') ? 2 : 1;
        break;
      case 'W':
        if (substr(i, 2) === 'WR') { pri += 'R'; sec += 'R'; i += 2; break; }
        if (i === 0 && (isVowel(i + 1) || substr(i, 2) === 'WH')) { pri += 'A'; sec += 'F'; i++; break; }
        if ((i === last && isVowel(i - 1)) || ['EWSKI','EWSKY','OWSKI','OWSKY'].some(p => substr(i - 1, p.length) === p)) {
          pri += ''; sec += 'F'; i++; break;
        }
        pri += 'F'; sec += 'F'; i++; break;
      case 'X':
        if (!(i === last && (isVowel(i - 3) || (substr(i - 2, 2) === 'IA') || (substr(i - 2, 2) === 'EA')))) {
          pri += 'KS'; sec += 'KS';
        }
        i += (charAt(i + 1) === 'C' || charAt(i + 1) === 'X') ? 2 : 1;
        break;
      case 'Z':
        if (charAt(i + 1) === 'H') { pri += 'J'; sec += 'J'; i += 2; break; }
        pri += 'S'; sec += 'S';
        i += (charAt(i + 1) === 'Z') ? 2 : 1;
        break;
      default:
        i++;
    }
  }

  const codes = [pri];
  if (sec && sec !== pri) codes.push(sec);
  return codes.filter(Boolean);
}

// Generate phonetic search variants for a mark
// Returns terms that sound like the mark but look different
function getPhoneticVariants(markName) {
  const base = markName.trim().toUpperCase();
  const baseCodes = doubleMetaphone(base);
  if (!baseCodes.length) return [];

  // Common sound-alike substitution patterns
  // These generate candidates that may sound like the mark
  const substitutions = [
    [/^K/, 'C'], [/^C(?=[EIY])/, 'S'], [/^PH/, 'F'], [/^F/, 'PH'],
    [/CK$/, 'C'], [/CK$/, 'K'], [/QU/, 'KW'], [/QU/, 'K'],
    [/^KN/, 'N'], [/GN$/, 'N'], [/WR/, 'R'],
    [/OO/, 'U'], [/OO/, 'EW'], [/EW/, 'OO'], [/EW/, 'U'],
    [/AW/, 'AU'], [/AU/, 'AW'],
    [/^E/, 'I'], [/^I/, 'E'],
    [/Y$/, 'IE'], [/IE$/, 'Y'], [/IE$/, 'EE'],
    [/EE$/, 'IE'], [/EE$/, 'Y'], [/EA/, 'EE'],
    [/ER$/, 'OR'], [/OR$/, 'ER'],
    [/X/, 'KS'], [/X/, 'Z'],
    [/Z/, 'S'], [/S$/, 'Z'],
    [/NN/, 'N'], [/TT/, 'T'], [/SS/, 'S'],
    [/PH/, 'F'], [/F/, 'PH'],
    [/SH/, 'CH'], [/CH/, 'SH'],
    [/V/, 'B'], [/B/, 'V'],
    [/W/, 'V'], [/V/, 'W'],
  ];

  const candidates = new Set();
  for (const [pattern, replacement] of substitutions) {
    const candidate = base.replace(pattern, replacement);
    if (candidate !== base && candidate.length >= 2) {
      candidates.add(candidate);
    }
  }

  // Filter: only keep candidates whose Double Metaphone code matches the original
  const phoneticMatches = [];
  for (const candidate of candidates) {
    const candidateCodes = doubleMetaphone(candidate);
    const hasMatch = candidateCodes.some(cc => baseCodes.includes(cc));
    if (hasMatch) {
      phoneticMatches.push(candidate);
    }
  }

  return phoneticMatches.slice(0, 4); // cap at 4 phonetic variants
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

// ── Mark variations (plural/suffix) ──────────────────────────────────────────
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
  }

  // Add phonetic variants
  const phoneticVars = getPhoneticVariants(base);
  for (const pv of phoneticVars) {
    variations.add(pv);
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
    await page.waitForSelector('#searchbar', { timeout: 15000 });
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

    await page.waitForFunction(
      () => document.body.innerText.match(/\b\d{8}\b/) || document.body.innerText.match(/no results|0 results|not found/i),
      { timeout: 15000 }
    ).catch(() => {});

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
        if (classApplied) {
          await page.waitForFunction(
            () => document.body.innerText.match(/\b\d{8}\b/) || document.body.innerText.match(/no results|0 results|not found/i),
            { timeout: 8000 }
          ).catch(() => {});
        }
      } catch (e) {
        console.log('[scrape] Could not apply class filter:', e.message);
      }
    }

    await sleep(500);

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

      function getStatusFromCard(el) {
        const statusSelectors = [
          '[class*="status"]', '[class*="badge"]', '[class*="chip"]',
          'mat-chip', 'span.status',
        ];
        for (const sel of statusSelectors) {
          const statusEl = el.querySelector(sel);
          if (statusEl) {
            const t = (statusEl.innerText || statusEl.textContent || '').trim().toUpperCase();
            if (t === 'LIVE' || t === 'DEAD') return t;
            if (/^LIVE/.test(t)) return 'LIVE';
            if (/^DEAD|CANCEL|ABANDON/.test(t)) return 'DEAD';
          }
        }
        const snippet = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 120).toUpperCase();
        if (/\bLIVE\b/.test(snippet)) return 'LIVE';
        if (/\bDEAD\b|\bCANCEL|\bABANDON/.test(snippet)) return 'DEAD';
        return 'UNKNOWN';
      }

      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 1) {
          els.forEach(el => {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length < 5) return;
            const serial = text.match(/\b(\d{8})\b/)?.[1];
            const status = getStatusFromCard(el);
            items.push({ text: text.substring(0, 500), serial: serial || null, status });
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
          liveDeadStatus: r.status !== 'UNKNOWN'
            ? r.status
            : (/dead|abandon|cancel/i.test(r.text) ? 'DEAD' : 'LIVE'),
          markName: null, owner: null, goodsServices: r.text,
          internationalClass: classCode || null, filingDate: null, registrationDate: null,
        });
      }
    } else if (uniqueSerials.length > 0) {
      for (const serial of uniqueSerials) {
        const idx = fullText.indexOf(serial);
        const context = fullText.substring(idx, idx + 400);
        const snippet = context.substring(0, 120).toUpperCase();
        let status = 'LIVE';
        if (/\bDEAD\b|\bCANCEL|\bABANDON/.test(snippet)) status = 'DEAD';
        else if (/\bLIVE\b/.test(snippet)) status = 'LIVE';
        results.push({
          source: 'tmsearch', serialNumber: serial,
          liveDeadStatus: status,
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

// ── Main scrape — parallel variations + phonetic ──────────────────────────────
async function scrapeUsptoTrademark(markName, classCode) {
  const cached = getCached(markName, classCode);
  if (cached) return cached;

  const browser = await getBrowser();
  const variations = getMarkVariations(markName);
  console.log(`[scrape] Searching ${variations.length} variations (incl. phonetic) in parallel: ${variations.join(', ')}`);

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
    ? `\nIMPORTANT: ${variantCount} result(s) were found by searching plural/variation/phonetic forms of the mark. Under established USPTO practice and DuPont factors, phonetically similar, plural, and singular forms of a mark are treated as confusingly similar. Weight these results accordingly.`
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

app.post('/api/draft', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  const productContext = String(req.body?.productContext || '').trim();
  const analysis = req.body?.analysis || {};

  if (!markName) return res.status(400).json({ error: 'markName required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        temperature: 0.2,
        system: 'You are a USPTO trademark attorney. Generate precise, legally accurate TEAS application draft content. The goods and services description must match USPTO ID Manual style — specific, not vague. Return ONLY a raw JSON object. No markdown. No backticks. No explanation.',
        messages: [{
          role: 'user',
          content: `Generate a USPTO TEAS application draft for the following mark.

Mark: "${markName}"
International Class: ${classCode || 'not specified'}
Product/Service Description: ${productContext || 'not provided'}
AI Analysis Summary: ${analysis.recommendation || 'not provided'}
Distinctiveness: ${analysis.distinctiveness || 'not provided'}

Return ONLY this JSON:
{
  "summary": "2-3 sentence plain English overview of this application",
  "goodsServicesDescription": "USPTO ID Manual style description of the goods/services. Must be specific and legally precise.",
  "filingBasis": "Section 1(a) — Use in Commerce OR Section 1(b) — Intent to Use, with one sentence explanation",
  "ownershipNote": "Guidance on how to fill in the owner field based on common entity types",
  "specimenGuidance": "Specific guidance on what specimen to submit for this type of mark and goods/services",
  "disclaimerSuggestion": "Any descriptive terms in the mark that should be disclaimed, or empty string if none",
  "filingSteps": ["Step text here", "..."],
  "additionalNotes": "Any other relevant notes for this specific application"
}`
        }]
      })
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
    const parsed = safeJsonParse(text);
    const rawContent = parsed?.content?.[0]?.text || '';
    const result = safeJsonParse(rawContent);
    if (!result) throw new Error('Claude returned invalid JSON');
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Draft generation failed', message: String(e?.message || e) });
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
