const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ─── TESS SCRAPER ─────────────────────────────────────────────────────────────
async function scrapeUSPTOTESS(mark, classCode) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setDefaultNavigationTimeout(30000);

    console.log('Loading TESS search page...');
    await page.goto('https://tess2.uspto.gov/bin/gate.exe?f=searchss&state=4802:n19s2n.1.1', {
      waitUntil: 'networkidle2', timeout: 30000
    });

    // Build search query - wildcard search for the mark name
    let searchQuery = `*${mark.toUpperCase()}*[COMB]`;
    if (classCode) searchQuery += ` AND ${classCode.padStart(3, '0')}[IC]`;

    console.log('Search query:', searchQuery);

    await page.waitForSelector('input[name="p_s_All"]', { timeout: 10000 });
    await page.type('input[name="p_s_All"]', searchQuery);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('input[type="submit"]')
    ]);

    const content = await page.content();

    if (content.includes('No TESS records were found') || content.includes('0 records')) {
      return { totalFound: 0, conflicts: [], searchedMark: mark, liveSearch: true, source: 'USPTO TESS' };
    }

    // Get total count
    let totalFound = 0;
    const totalMatch = content.match(/(\d+)\s+records?\s+found/i) || content.match(/(\d+)\s+Results/i);
    if (totalMatch) totalFound = parseInt(totalMatch[1]);

    // Parse list page
    const results = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const items = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 4) {
          const serial = cells[0]?.innerText?.trim();
          const reg = cells[1]?.innerText?.trim();
          const liveDeadCode = cells[2]?.innerText?.trim();
          const markName = cells[3]?.innerText?.trim();
          if (serial && serial.match(/^\d{7,8}$/)) {
            items.push({
              mark: markName || '',
              serialNumber: serial,
              registrationNumber: reg || '',
              isLive: liveDeadCode === 'LIVE',
              status: liveDeadCode === 'LIVE' ? 'Live' : 'Dead',
              goods: '', owner: '', intClass: '', filingDate: ''
            });
          }
        }
      }
      return items;
    });

    if (totalFound === 0) totalFound = results.length;

    // Get details for top 15 results
    const detailed = [];
    const limit = Math.min(results.length, 15);
    const links = await page.$$('a[href*="showfield"]');

    for (let i = 0; i < limit; i++) {
      try {
        if (!links[i]) { detailed.push(results[i]); continue; }
        const href = await page.evaluate(el => el.href, links[i]);
        const detailPage = await browser.newPage();
        await detailPage.goto(href, { waitUntil: 'networkidle2', timeout: 15000 });

        const detail = await detailPage.evaluate(() => {
          const getText = (label) => {
            const rows = Array.from(document.querySelectorAll('tr'));
            for (const row of rows) {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 2 && cells[0]?.innerText?.toLowerCase().includes(label.toLowerCase())) {
                return cells[1]?.innerText?.trim() || '';
              }
            }
            return '';
          };
          return {
            mark: getText('Word Mark') || getText('Mark') || '',
            serialNumber: getText('Serial Number'),
            registrationNumber: getText('Registration Number'),
            status: getText('Live/Dead') || getText('Status') || '',
            isLive: (getText('Live/Dead') || '').toUpperCase().includes('LIVE'),
            goods: (getText('Goods and Services') || getText('Goods/Services') || '').substring(0, 200),
            owner: getText('Owner'),
            intClass: getText("Int'l Class") || getText('International Class') || '',
            filingDate: getText('Filing Date')
          };
        });

        if (detail.mark || detail.serialNumber) detailed.push(detail);
        else detailed.push(results[i]);
        await detailPage.close();
      } catch(e) {
        if (results[i]) detailed.push(results[i]);
      }
    }

    return {
      totalFound,
      conflicts: detailed.filter(r => r.mark),
      searchedMark: mark.toUpperCase(),
      liveSearch: true,
      source: 'USPTO TESS'
    };

  } catch(err) {
    console.error('TESS error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

// ─── FALLBACK: USPTO Developer API ───────────────────────────────────────────
async function queryUSPTOAPI(mark, classCode) {
  const params = new URLSearchParams({ searchText: `*${mark.toUpperCase()}*`, rows: 50, start: 0 });
  if (classCode) params.append('intClassCodes', classCode);

  const response = await fetch(`https://developer.uspto.gov/ds-api/opi/v1/applications/trademarks?${params}`,
    { headers: { 'Accept': 'application/json', 'User-Agent': 'Trademarkyo/1.0' } }
  );
  if (!response.ok) throw new Error(`USPTO API ${response.status}`);

  const data = await response.json();
  const items = data?.results || data?.response?.docs || [];

  return {
    totalFound: data?.totalFound || items.length,
    conflicts: items.slice(0, 25).map(item => ({
      mark: item.markVerbalElementText || item.mark || '',
      serialNumber: item.applicationNumberText || '',
      registrationNumber: item.registrationNumberText || '',
      status: item.caseStatusDescriptionText || 'Unknown',
      isLive: ['live','registered','pending','published','allowed'].some(s => (item.caseStatusDescriptionText||'').toLowerCase().includes(s)),
      goods: (item.goodsAndServicesText || '').substring(0, 200),
      filingDate: item.filingDate || '',
      owner: item.ownerText || '',
      intClass: item.internationalClassificationCode || ''
    })).filter(c => c.mark),
    searchedMark: mark.toUpperCase(),
    liveSearch: true,
    source: 'USPTO API'
  };
}

// ─── SEARCH ENDPOINT ──────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { mark, classCode } = req.query;
  if (!mark) return res.status(400).json({ error: 'Mark is required' });
  console.log(`Searching: ${mark} class:${classCode||'all'}`);

  try {
    const results = await scrapeUSPTOTESS(mark, classCode);
    console.log(`TESS: ${results.totalFound} results`);
    return res.json(results);
  } catch(tessErr) {
    console.log('TESS failed, trying API:', tessErr.message);
    try {
      const results = await queryUSPTOAPI(mark, classCode);
      console.log(`API: ${results.totalFound} results`);
      return res.json(results);
    } catch(apiErr) {
      console.log('Both failed:', apiErr.message);
      return res.json({ totalFound: 0, conflicts: [], searchedMark: mark.toUpperCase(), liveSearch: false, source: 'AI only' });
    }
  }
});

// ─── CLAUDE ANALYSIS ──────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { mark, classCode, usptoData } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const classNames = { '':'all classes','5':'Class 5 (Pharmaceuticals/Supplements)','29':'Class 29 (Processed Food)','30':'Class 30 (Staple Food)','32':'Class 32 (Beverages)','35':'Class 35 (Business/Retail)','42':'Class 42 (Software/Tech)','25':'Class 25 (Clothing)','3':'Class 3 (Cosmetics)','9':'Class 9 (Electronics)','41':'Class 41 (Education)','44':'Class 44 (Medical/Health)' };
  const className = classNames[classCode] || 'all classes';

  const conflictSummary = usptoData.conflicts?.length > 0
    ? usptoData.conflicts.map(c => `- "${c.mark}" | Serial: ${c.serialNumber} | Status: ${c.status} | Live: ${c.isLive} | Class: ${c.intClass} | Goods: ${c.goods?.substring(0,100)||'N/A'} | Owner: ${c.owner}`).join('\n')
    : 'No conflicts found in USPTO database.';

  const prompt = `You are a senior USPTO trademark attorney performing a professional clearance analysis.

Mark: "${mark.toUpperCase()}"
Class: ${className}
Total USPTO records found: ${usptoData.totalFound || 0}
Data source: ${usptoData.source || 'unknown'} | Live search: ${usptoData.liveSearch ? 'YES' : 'NO'}

USPTO RESULTS:
${conflictSummary}

Analyze using DuPont factors. Be specific. Reference actual serial numbers. Don't hedge.

Return ONLY this JSON (no markdown):
{
  "approvalScore": <0-100>,
  "verdict": "<STRONG PROCEED|PROCEED WITH CAUTION|HIGH RISK|DO NOT FILE>",
  "distinctiveness": "<FANCIFUL|ARBITRARY|SUGGESTIVE|DESCRIPTIVE|GENERIC>",
  "distinctivenessExplain": "<1 sentence>",
  "mainRisks": ["<risk>","<risk>","<risk>"],
  "recommendation": "<3-4 sentences direct advice>",
  "totalEstimatedConflicts": <number>,
  "conflictAnalysis": [{"mark":"","status":"","isLive":true,"goods":"","riskLevel":"<HIGH|MEDIUM|LOW>","reason":"","serialNumber":""}]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch(err) {
    res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Trademarkyo server running on port ${PORT}`));
