const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// USPTO Trademark Search API - live database
app.get('/api/search', async (req, res) => {
  const { mark, classCode } = req.query;

  if (!mark) return res.status(400).json({ error: 'Mark is required' });

  try {
    // USPTO's public trademark search API
    const params = new URLSearchParams({
      searchText: `*${mark.toUpperCase()}*`,
      rows: 50,
      start: 0,
      ...(classCode && { intClassCodes: classCode })
    });

    const usptoRes = await fetch(
      `https://developer.uspto.gov/ds-api/opi/v1/applications/trademarks?${params}`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Trademarkyo/1.0' } }
    );

    if (!usptoRes.ok) {
      // Fallback to TESS-style search
      return await fallbackSearch(mark, classCode, res);
    }

    const data = await usptoRes.json();
    const results = processResults(data, mark);
    res.json(results);

  } catch (err) {
    console.error('USPTO API error:', err.message);
    return await fallbackSearch(mark, classCode, res);
  }
});

async function fallbackSearch(mark, classCode, res) {
  try {
    // Try USPTO TSDR API as fallback
    const query = encodeURIComponent(`mark.name:*${mark.toUpperCase()}*`);
    const url = `https://developer.uspto.gov/ds-api/trademarks/v1/application?q=${query}&rows=50&start=0`;

    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Trademarkyo/1.0' }
    });

    if (r.ok) {
      const data = await r.json();
      return res.json(processResults(data, mark));
    }
  } catch (e) {}

  // Return empty but valid response — Claude will still analyze
  res.json({ totalFound: 0, conflicts: [], searchedMark: mark, liveSearch: false });
}

function processResults(data, mark) {
  const items = data?.results || data?.response?.docs || data?.hits?.hits?.map(h => h._source) || [];

  const conflicts = items.slice(0, 25).map(item => ({
    mark: item.markVerbalElementText || item.mark || item.wordMark || item.markText || '',
    serialNumber: item.applicationNumberText || item.serialNumber || item.sn || '',
    registrationNumber: item.registrationNumberText || item.registrationNumber || '',
    status: item.caseStatusDescriptionText || item.status || 'Unknown',
    isLive: isLiveMark(item),
    goods: item.goodsAndServicesText || item.goods || '',
    filingDate: item.filingDate || item.applicationDate || '',
    owner: item.ownerText || item.ownerName || item.owner || '',
    intClass: item.internationalClassificationCode || item.intClass || ''
  })).filter(c => c.mark && c.mark.length > 0);

  return {
    totalFound: data?.totalFound || data?.response?.numFound || data?.hits?.total?.value || items.length,
    conflicts,
    searchedMark: mark.toUpperCase(),
    liveSearch: true
  };
}

function isLiveMark(item) {
  const status = (item.caseStatusDescriptionText || item.status || '').toLowerCase();
  return status.includes('live') || status.includes('registered') ||
         status.includes('pending') || status.includes('published') ||
         status.includes('allowed');
}

// Claude AI analysis endpoint
app.post('/api/analyze', async (req, res) => {
  const { mark, classCode, usptoData } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const classNames = {
    '': 'all classes', '5': 'Class 5 (Pharmaceuticals/Supplements)',
    '29': 'Class 29 (Processed Food)', '30': 'Class 30 (Staple Food)',
    '32': 'Class 32 (Beverages)', '35': 'Class 35 (Business/Retail)',
    '42': 'Class 42 (Software/Tech)', '25': 'Class 25 (Clothing)',
    '3': 'Class 3 (Cosmetics)', '9': 'Class 9 (Electronics)',
    '41': 'Class 41 (Education)', '44': 'Class 44 (Medical/Health)'
  };

  const className = classNames[classCode] || 'all classes';
  const conflictSummary = usptoData.conflicts?.length > 0
    ? usptoData.conflicts.map(c =>
        `- "${c.mark}" | Status: ${c.status} | Live: ${c.isLive} | Goods: ${c.goods?.substring(0, 100) || 'N/A'} | Owner: ${c.owner}`
      ).join('\n')
    : 'No conflicts returned from USPTO live search.';

  const prompt = `You are a senior USPTO trademark attorney performing a professional clearance analysis.

Mark being searched: "${mark.toUpperCase()}"
Trademark class: ${className}
Total USPTO records found: ${usptoData.totalFound || 0}
Live USPTO search performed: ${usptoData.liveSearch ? 'YES - real database results' : 'NO - use your training knowledge'}

LIVE USPTO RESULTS:
${conflictSummary}

Perform a thorough clearance analysis using the DuPont factors:
1. Analyze the distinctiveness of the mark (fanciful/arbitrary/suggestive/descriptive/generic)
2. Assess similarity to the conflicts above — phonetic, visual, conceptual
3. Relatedness of goods/services
4. Evaluate the commercial strength of any conflicting marks
5. Give an honest, direct approval likelihood score

Be specific and direct. Name real conflicts. Don't hedge.

Respond in this exact JSON format only (no markdown, no backticks):
{
  "approvalScore": <0-100 integer>,
  "verdict": "<STRONG PROCEED | PROCEED WITH CAUTION | HIGH RISK | DO NOT FILE>",
  "distinctiveness": "<FANCIFUL|ARBITRARY|SUGGESTIVE|DESCRIPTIVE|GENERIC>",
  "distinctivenessExplain": "<1 sentence>",
  "mainRisks": ["<specific risk>", "<specific risk>", "<specific risk if applicable>"],
  "recommendation": "<3-4 sentences, direct and actionable>",
  "totalEstimatedConflicts": <number>,
  "conflictAnalysis": [
    {
      "mark": "<mark name>",
      "status": "<LIVE|DEAD|PENDING>",
      "isLive": <true|false>,
      "goods": "<brief goods>",
      "riskLevel": "<HIGH|MEDIUM|LOW>",
      "reason": "<specific reason>",
      "serialNumber": "<serial if known>"
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));

  } catch (err) {
    res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`Trademarkyo server running on port ${PORT}`));
