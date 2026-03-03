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

// ── Double Metaphone ──────────────────────────────────────────────────────────
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
  if (substr(0, 2) === 'AE' || substr(0, 2) === 'GN' || substr(0, 2) === 'KN' || substr(0, 2) === 'PN' || substr(0, 2) === 'WR') { i = 1; }
  if (isVowel(0)) { pri += 'A'; sec += 'A'; i = 1; }
  while (i <= last) {
    const c = charAt(i);
    if ('AEIOU'.includes(c)) { i++; continue; }
    switch (c) {
      case 'B': pri += 'P'; sec += 'P'; i += (charAt(i+1)==='B')?2:1; break;
      case 'C':
        if (substr(i,4)==='CHIA'){pri+='K';sec+='K';i+=2;break;}
        if (substr(i,2)==='CH'){if(i>0&&isVowel(i-2)&&!isVowel(i+2)){pri+='K';sec+='K';}else{pri+='X';sec+='K';}i+=2;break;}
        if(substr(i,2)==='CI'||substr(i,2)==='CE'||substr(i,2)==='CY'){pri+='S';sec+='S';i+=2;break;}
        if(substr(i,2)==='CK'||substr(i,2)==='CG'||substr(i,2)==='CQ'){pri+='K';sec+='K';i+=2;break;}
        pri+='K';sec+='K';i+=(substr(i+1,2)==='CC')?3:(charAt(i+1)==='C'||charAt(i+1)==='K'||charAt(i+1)==='Q')?2:1;break;
      case 'D':
        if(substr(i,2)==='DG'&&'IEY'.includes(charAt(i+2))){pri+='J';sec+='J';i+=3;break;}
        if(substr(i,2)==='DT'||substr(i,2)==='DD'){pri+='T';sec+='T';i+=2;break;}
        pri+='T';sec+='T';i++;break;
      case 'F': pri+='F';sec+='F';i+=(charAt(i+1)==='F')?2:1;break;
      case 'G':
        if(charAt(i+1)==='H'){
          if(i>0&&!isVowel(i-1)){pri+='K';sec+='K';i+=2;break;}
          if(i===0){if(charAt(i+2)==='I'){pri+='J';sec+='J';}else{pri+='K';sec+='K';}i+=2;break;}
          if((i>1&&'BDH'.includes(charAt(i-2)))||(i>2&&'BDH'.includes(charAt(i-3)))||(i>3&&'BDH'.includes(charAt(i-4)))){i+=2;break;}
          if(i>2&&charAt(i-2)==='U'&&'CGLRT'.includes(charAt(i-3))){pri+='F';sec+='F';i+=2;break;}
          if(i>0&&charAt(i-1)!=='I'){pri+='K';sec+='K';}i+=2;break;
        }
        if(charAt(i+1)==='N'){if(i===1&&isVowel(0)){pri+='KN';sec+='N';}else{if(substr(i+1,3)!=='NAT'&&substr(i-1,2)!=='GN'){pri+='K';sec+='K';}}i+=2;break;}
        if('IEY'.includes(charAt(i+1))&&substr(i-1,2)!=='GG'){pri+='K';sec+='J';i+=2;break;}
        if(charAt(i+1)==='G'){pri+='K';sec+='K';i+=2;break;}
        pri+='K';sec+='K';i++;break;
      case 'H': if(isVowel(i+1)&&(i===0||isVowel(i-1))){pri+='H';sec+='H';i+=2;break;}i++;break;
      case 'J': pri+='J';sec+='J';i+=(charAt(i+1)==='J')?2:1;break;
      case 'K': pri+='K';sec+='K';i+=(charAt(i+1)==='K')?2:1;break;
      case 'L': if(charAt(i+1)==='L'){pri+='L';sec+='L';i+=2;break;}pri+='L';sec+='L';i++;break;
      case 'M': pri+='M';sec+='M';i+=(charAt(i+1)==='M')?2:1;break;
      case 'N': pri+='N';sec+='N';i+=(charAt(i+1)==='N')?2:1;break;
      case 'P': if(charAt(i+1)==='H'){pri+='F';sec+='F';i+=2;break;}pri+='P';sec+='P';i+=(charAt(i+1)==='P')?2:1;break;
      case 'Q': pri+='K';sec+='K';i+=(charAt(i+1)==='Q')?2:1;break;
      case 'R': if(i===last&&!isVowel(i-1)&&substr(i-2,2)!=='ME'&&substr(i-2,2)!=='MA'){pri+='R';sec+='';}else{pri+='R';sec+='R';}i+=(charAt(i+1)==='R')?2:1;break;
      case 'S':
        if(substr(i,2)==='SH'||(substr(i,3)==='SIO'||substr(i,3)==='SIA')){pri+='X';sec+='X';i+=2;break;}
        if(substr(i,2)==='SC'){pri+='SK';sec+='SK';i+=3;break;}
        pri+='S';sec+='S';i+=(charAt(i+1)==='S'||charAt(i+1)==='Z')?2:1;break;
      case 'T':
        if(substr(i,3)==='TIA'||substr(i,3)==='TCH'){pri+='X';sec+='X';i+=3;break;}
        if(substr(i,2)==='TH'||substr(i,3)==='TTH'){pri+='0';sec+='T';i+=2;break;}
        pri+='T';sec+='T';i+=(charAt(i+1)==='T'||charAt(i+1)==='D')?2:1;break;
      case 'V': pri+='F';sec+='F';i+=(charAt(i+1)==='V')?2:1;break;
      case 'W': if(substr(i,2)==='WR'){pri+='R';sec+='R';i+=2;break;}pri+='F';sec+='F';i++;break;
      case 'X': if(!(i===last&&(isVowel(i-3)||(substr(i-2,2)==='IA')||(substr(i-2,2)==='EA')))){pri+='KS';sec+='KS';}i+=(charAt(i+1)==='C'||charAt(i+1)==='X')?2:1;break;
      case 'Z': if(charAt(i+1)==='H'){pri+='J';sec+='J';i+=2;break;}pri+='S';sec+='S';i+=(charAt(i+1)==='Z')?2:1;break;
      default: i++;
    }
  }
  const codes = [pri];
  if (sec && sec !== pri) codes.push(sec);
  return codes.filter(Boolean);
}

function getPhoneticVariants(markName) {
  const base = markName.trim().toUpperCase();
  const baseCodes = doubleMetaphone(base);
  if (!baseCodes.length) return [];
  const substitutions = [
    [/^K/, 'C'], [/^C(?=[EIY])/, 'S'], [/^PH/, 'F'], [/^F/, 'PH'],
    [/CK$/, 'C'], [/CK$/, 'K'], [/QU/, 'KW'], [/QU/, 'K'],
    [/^KN/, 'N'], [/GN$/, 'N'], [/WR/, 'R'],
    [/OO/, 'U'], [/OO/, 'EW'], [/EW/, 'OO'], [/EW/, 'U'],
    [/^E/, 'I'], [/^I/, 'E'],
    [/Y$/, 'IE'], [/IE$/, 'Y'], [/IE$/, 'EE'],
    [/EE$/, 'IE'], [/EE$/, 'Y'], [/EA/, 'EE'],
    [/PH/, 'F'], [/F/, 'PH'], [/SH/, 'CH'], [/CH/, 'SH'],
    [/X/, 'KS'], [/X/, 'Z'], [/Z/, 'S'], [/S$/, 'Z'],
  ];
  const candidates = new Set();
  for (const [pattern, replacement] of substitutions) {
    const candidate = base.replace(pattern, replacement);
    if (candidate !== base && candidate.length >= 2) candidates.add(candidate);
  }
  const phoneticMatches = [];
  for (const candidate of candidates) {
    const candidateCodes = doubleMetaphone(candidate);
    if (candidateCodes.some(cc => baseCodes.includes(cc))) phoneticMatches.push(candidate);
  }
  return phoneticMatches.slice(0, 4);
}

// ── Persistent browser ────────────────────────────────────────────────────────
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
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process','--disable-extensions','--disable-background-networking'],
    });
    browserInstance.on('disconnected', () => { console.log('[browser] Disconnected'); browserInstance = null; });
    console.log('[browser] Chrome ready');
    return browserInstance;
  } finally {
    browserLaunching = false;
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCached(markName, classCode) {
  const key = `${markName.toUpperCase()}::${classCode || ''}`;
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { searchCache.delete(key); return null; }
  console.log(`[cache] HIT for "${markName}"`);
  return entry.results;
}

function setCache(markName, classCode, results) {
  const key = `${markName.toUpperCase()}::${classCode || ''}`;
  searchCache.set(key, { results, timestamp: Date.now() });
  if (searchCache.size > 200) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    searchCache.delete(oldest[0]);
  }
}

// ── Mark variations ───────────────────────────────────────────────────────────
function getMarkVariations(markName) {
  const base = markName.trim().toUpperCase();
  const variations = new Set([base]);
  if (base.endsWith('IES') && base.length > 4) variations.add(base.slice(0,-3)+'Y');
  else if (base.endsWith('ES') && base.length > 3) variations.add(base.slice(0,-2));
  else if (base.endsWith('S') && base.length > 2) variations.add(base.slice(0,-1));
  if (!base.endsWith('S')) {
    variations.add(base+'S');
    if (/[XZ]$/.test(base)||/CH$/.test(base)||/SH$/.test(base)) variations.add(base+'ES');
    if (base.endsWith('Y') && base.length > 1) variations.add(base.slice(0,-1)+'IES');
  }
  if (base.endsWith('ING') && base.length > 4) { variations.add(base.slice(0,-3)); variations.add(base.slice(0,-3)+'E'); }
  for (const pv of getPhoneticVariants(base)) variations.add(pv);
  return [...variations].filter(v => v.length >= 2);
}

// ── Scrape single variant ─────────────────────────────────────────────────────
async function scrapeVariant(browser, markName, classCode) {
  const results = [];
  let page;
  try {
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    await page.goto('https://tmsearch.uspto.gov/search/search-information', { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('#searchbar', { timeout: 15000 });
    await page.click('#searchbar');
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.type('#searchbar', markName.toUpperCase(), { delay: 50 });
    const btnClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, mat-icon'));
      const searchBtn = btns.find(b => (b.textContent||'').trim().toLowerCase() === 'search');
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
    await sleep(500);
    const fullText = await page.evaluate(() => document.body?.innerText || '');
    const serialMatches = [...fullText.matchAll(/\b(\d{8})\b/g)].map(m => m[1]);
    const uniqueSerials = [...new Set(serialMatches)].slice(0, 50);
    const rawData = await page.evaluate(() => {
      const items = [];
      const selectors = ['app-result-item','app-search-result','[class*="result-item"]','mat-list-item','mat-card','tbody tr','[role="listitem"]','[role="row"]'];
      function getStatus(el) {
        const t = (el.innerText||'').substring(0,120).toUpperCase();
        if (/\bLIVE\b/.test(t)) return 'LIVE';
        if (/\bDEAD\b|\bCANCEL|\bABANDON/.test(t)) return 'DEAD';
        return 'UNKNOWN';
      }
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 1) {
          els.forEach(el => {
            const text = (el.innerText||'').replace(/\s+/g,' ').trim();
            if (text.length < 5) return;
            const serial = text.match(/\b(\d{8})\b/)?.[1];
            items.push({ text: text.substring(0,500), serial: serial||null, status: getStatus(el) });
          });
          if (items.length > 2) break;
        }
      }
      return items.slice(0,50);
    });
    const itemsWithSerials = rawData.filter(r => r.serial);
    if (itemsWithSerials.length > 0) {
      for (const r of itemsWithSerials) {
        results.push({ source:'tmsearch', serialNumber:r.serial, liveDeadStatus:r.status!=='UNKNOWN'?r.status:(/dead|abandon|cancel/i.test(r.text)?'DEAD':'LIVE'), markName:null, owner:null, goodsServices:r.text, internationalClass:classCode||null, filingDate:null, registrationDate:null });
      }
    } else if (uniqueSerials.length > 0) {
      for (const serial of uniqueSerials) {
        const idx = fullText.indexOf(serial);
        const context = fullText.substring(idx, idx+400);
        const snippet = context.substring(0,120).toUpperCase();
        const status = /\bDEAD\b|\bCANCEL|\bABANDON/.test(snippet)?'DEAD':'LIVE';
        results.push({ source:'tmsearch', serialNumber:serial, liveDeadStatus:status, markName:null, owner:null, goodsServices:context.replace(/\s+/g,' ').trim(), internationalClass:classCode||null, filingDate:null, registrationDate:null });
      }
    }
    return results;
  } catch (e) {
    console.log(`[scrape] Variant "${markName}" failed:`, e.message);
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Main scrape ───────────────────────────────────────────────────────────────
async function scrapeUsptoTrademark(markName, classCode) {
  const cached = getCached(markName, classCode);
  if (cached) return cached;
  const browser = await getBrowser();
  const variations = getMarkVariations(markName);
  console.log(`[scrape] Searching ${variations.length} variations: ${variations.join(', ')}`);
  const variantResults = await Promise.all(
    variations.map(async (variant) => {
      const results = await scrapeVariant(browser, variant, classCode);
      return results.map(r => ({ ...r, matchedVariant: variant, isVariation: variant !== markName.toUpperCase() }));
    })
  );
  const allResults = variantResults.flat();
  const seen = new Set();
  const deduped = allResults.filter(r => { if (seen.has(r.serialNumber)) return false; seen.add(r.serialNumber); return true; });
  console.log(`[scrape] Total unique results: ${deduped.length}`);
  setCache(markName, classCode, deduped);
  return deduped;
}

// ── Claude helpers ────────────────────────────────────────────────────────────
function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  return key;
}

async function claudeJSON(system, userContent, maxTokens = 1500, temperature = 0.2) {
  const apiKey = getApiKey();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: userContent }] })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  const result = safeJsonParse(rawContent);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

async function claudeText(system, userContent, maxTokens = 2500, temperature = 0.3) {
  const apiKey = getApiKey();
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: userContent }] })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  return parsed?.content?.[0]?.text || '';
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
    const classContext = classCode ? `The applicant is seeking registration in International Class ${classCode}.` : 'No specific class specified.';
    const variantCount = results.filter(r => r.isVariation).length;
    const variantNote = variantCount > 0 ? `\nIMPORTANT: ${variantCount} result(s) were found via phonetic/plural variants. Under DuPont, these are treated as confusingly similar.` : '';
    const result = await claudeJSON(
      'You are a trademark clearance attorney assistant. Perform rigorous DuPont factor likelihood-of-confusion analysis. Return ONLY a raw JSON object. No markdown. No explanation.',
      `Analyze trademark risk for proposed mark: "${markName}".\n${classContext}${variantNote}\n\nUSPTO records found (${results.length}):\n${JSON.stringify(results, null, 2)}\n\nReturn ONLY this JSON:\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"officeActionScore":0-100,"officeActionBasis":"2d"|"2e_descriptive"|"2e_geographic"|"2e_surname"|"2e_ornamental"|"none","officeActionExplanation":string,"officeActionFactors":[{"factor":string,"impact":"high"|"medium"|"low","detail":string}],"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high","isVariation":boolean}]}`
    );
    return res.json(result);
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
  try {
    const result = await claudeJSON(
      'You are a creative trademark attorney and brand naming expert. Return ONLY a raw JSON object. No markdown. No backticks. No explanation. Just the JSON.',
      `The proposed trademark "${markName}" scored ${score}% approval due to: ${conflicts}. Risks: ${risks}. ${classCode ? `Class ${classCode}.` : ''}\nGenerate 6 distinctive alternative brand names.\nReturn ONLY: {"suggestions":[{"name":"MARKNAME","reason":"one sentence why stronger"}]}`
    );
    if (!Array.isArray(result.suggestions)) throw new Error('Invalid structure');
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
  try {
    const result = await claudeJSON(
      'You are a USPTO trademark attorney. Generate precise, legally accurate TEAS application draft content. Return ONLY a raw JSON object. No markdown. No backticks.',
      `Generate a USPTO TEAS application draft.\nMark: "${markName}"\nClass: ${classCode || 'not specified'}\nProduct/Service: ${productContext || 'not provided'}\nAnalysis: ${analysis.recommendation || ''}\nDistinctiveness: ${analysis.distinctiveness || ''}\n\nReturn ONLY:\n{"summary":string,"goodsServicesDescription":string,"filingBasis":string,"ownershipNote":string,"specimenGuidance":string,"disclaimerSuggestion":string,"filingSteps":string[],"additionalNotes":string}`
    );
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Draft generation failed', message: String(e?.message || e) });
  }
});

// ── CLIENT OPINION LETTER ─────────────────────────────────────────────────────
app.post('/api/letter', async (req, res) => {
  const {
    mark, classCode, classLabel, firm, attyName, client, matterNo, date,
    approvalScore, verdict, oaScore, oaBasis, distinctiveness, recommendation,
    mainRisks, conflictCount, liveConflictCount, highRiskCount, conflictSummary, totalFound
  } = req.body;

  if (!mark) return res.status(400).json({ error: 'mark required' });

  const scoreLabel = approvalScore >= 70 ? 'relatively low' : approvalScore >= 40 ? 'moderate' : 'elevated';
  const proceedRec = approvalScore >= 70
    ? 'I recommend proceeding with filing, subject to the caveats noted above.'
    : approvalScore >= 40
    ? 'I recommend proceeding cautiously. Consider the conflicts identified herein before filing, and consult with counsel regarding strategies to distinguish your mark.'
    : 'I recommend against filing this mark in its current form without significant modification or further clearance work. The identified conflicts present a substantial risk of refusal.';

  const systemPrompt = `You are a senior trademark attorney drafting a formal client opinion letter. Write in precise, professional legal prose. The letter must be structured with clearly labeled sections and written entirely in the voice of the attorney signing it. Do not use markdown formatting — use plain text with section headers in ALL CAPS followed by a blank line. Write complete, substantive paragraphs — not bullet points. The letter should read exactly like a real attorney opinion letter that could be delivered to a client.`;

  const userPrompt = `Draft a complete trademark clearance opinion letter with the following details:

MATTER DETAILS:
- Proposed mark: "${mark.toUpperCase()}"
- Class: ${classLabel || 'all classes'}
- Attorney: ${attyName || '[Attorney Name]'}
- Firm: ${firm || '[Firm Name]'}
- Client: ${client || '[Client Name]'}
${matterNo ? `- Matter No.: ${matterNo}` : ''}
- Date: ${date}

SEARCH RESULTS:
- Total USPTO records reviewed: ${totalFound || 0}
- Total conflicts identified: ${conflictCount || 0}
- Live active conflicts: ${liveConflictCount || 0}
- High-risk conflicts: ${highRiskCount || 0}
- Approval likelihood score: ${approvalScore}% (${verdict})
- Office action risk score: ${oaScore}%
- Primary refusal basis if filed: ${oaBasis}

MARK ANALYSIS:
- Distinctiveness: ${distinctiveness}
- Key risks: ${(mainRisks || []).join('; ')}
- AI recommendation: ${recommendation}

NOTABLE LIVE CONFLICTS:
${conflictSummary || 'None identified.'}

Write the letter with these sections:
1. Opening paragraph (Dear ${client || 'Client'}, explaining purpose)
2. SEARCH METHODOLOGY (how the USPTO search was conducted)
3. DUPONT FACTOR ANALYSIS (analyze each relevant DuPont factor substantively — similarity of marks, relatedness of goods/services, strength and distinctiveness of the mark, channels of trade, sophistication of consumers)
4. IDENTIFIED CONFLICTS (discuss the specific live conflicts and their risk level)
5. OFFICE ACTION RISK (discuss probability and basis of USPTO refusal)
6. CONCLUSION AND RECOMMENDATION (${proceedRec})
7. Closing (Very truly yours, signature block placeholder)

The overall risk assessment is: ${scoreLabel} risk of refusal.
Write a complete, professional letter. Use formal legal language throughout.`;

  try {
    const letter = await claudeText(systemPrompt, userPrompt, 2800, 0.25);
    return res.json({ letter });
  } catch (e) {
    return res.status(500).json({ error: 'Letter generation failed', message: String(e?.message || e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, cacheSize: searchCache.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`Trademarkyo running on port ${PORT}`);
  try { await getBrowser(); console.log('[browser] Pre-warmed and ready'); }
  catch (e) { console.error('[browser] Pre-warm failed:', e.message); }
});
