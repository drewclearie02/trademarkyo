'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = Number(process.env.PORT || 8080);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function parseJson(text) {
  if (!text) return null;
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(clean); } catch { return null; }
}

async function searchUSPTO(markName, classCode) {
  const name = markName.trim().toLowerCase();

  const body = {
    query: {
      bool: {
        must: [{
          bool: {
            should: [
              { match_phrase: { WM: { query: name, boost: 5 } } },
              { match: { WM: { query: name, boost: 2 } } },
              { match_phrase: { PM: { query: name, boost: 2 } } }
            ]
          }
        }]
      }
    },
    size: 100,
    from: 0,
    track_total_hits: true,
    _source: [
      'abandonDate','alive','attorney','cancelDate','coordinatedClass',
      'currentBasis','designCodeDescription','disclaimer','drawingCode',
      'filedDate','goodsAndServices','id','internationalClass',
      'markDescription','markType','originalBasis','ownerFullText',
      'ownerName','ownerType','priorityDate','publishForOppositionDate',
      'registrationDate','registrationId','registrationType',
      'supplementalRegistrationDate','translation','usClass',
      'wordmark','wordmarkPseudoText'
    ],
    aggs: {
      alive: { terms: { field: 'alive' } },
      cancelDate: { value_count: { field: 'cancelDate' } }
    }
  };

  if (classCode) {
    body.query.bool.must.push({ match: { internationalClass: classCode } });
  }

  console.log(`[uspto] Searching: "${name}"`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(
      'https://tmsearch.uspto.gov/api/search/prod-stage-v1-0-0/tmsearch',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://tmsearch.uspto.gov',
          'Referer': 'https://tmsearch.uspto.gov/search/search-results',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
        body: JSON.stringify(body),
      }
    );

    const text = await resp.text();
    if (!resp.ok) throw new Error(`USPTO API returned ${resp.status}: ${truncate(text, 200)}`);

    const data = parseJson(text);
    if (!data) throw new Error('USPTO API returned invalid JSON');

    const hits = data?.hits?.hits || [];
    console.log(`[uspto] total=${data?.hits?.total?.value}, returned=${hits.length}`);

    return hits.map(hit => {
      const s = hit._source || {};
      const alive = s.alive === true || s.alive === 'true' || s.alive === 1;
      return {
        source: 'uspto',
        serialNumber: s.id || hit._id || null,
        markName: (s.wordmark || s.wordmarkPseudoText || '').toUpperCase(),
        owner: s.ownerName || s.ownerFullText || null,
        liveDeadStatus: alive ? 'LIVE' : 'DEAD',
        goodsServices: Array.isArray(s.goodsAndServices) ? s.goodsAndServices.join('; ') : (s.goodsAndServices || ''),
        internationalClass: Array.isArray(s.internationalClass) ? s.internationalClass.join(', ') : (s.internationalClass || null),
        filingDate: s.filedDate || null,
        registrationDate: s.registrationDate || null,
        registrationId: s.registrationId || null,
        markType: s.markType || null,
        statusDescription: alive ? 'LIVE' : 'DEAD',
        isVariation: (s.wordmark || '').toLowerCase() !== name,
        matchedVariant: (s.wordmark || '').toUpperCase(),
      };
    });

  } finally {
    clearTimeout(timer);
  }
}

async function callClaude({ markName, classCode, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const classCtx = classCode
    ? `The applicant seeks registration in International Class ${classCode}.`
    : 'No specific class — analyze across all relevant classes.';

  const variantCount = results.filter(r => r.isVariation).length;
  const variantNote = variantCount > 0
    ? `\nIMPORTANT: ${variantCount} result(s) are plural/variation matches. Under USPTO practice, plural and singular forms are confusingly similar.`
    : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.2,
      system: 'You are a trademark clearance attorney assistant. Perform rigorous USPTO analysis. Return ONLY a raw JSON object — no markdown, no explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for: "${markName}".\n${classCtx}${variantNote}\n\nUSPTO records found (${results.length}):\n${JSON.stringify(results.slice(0, 30), null, 2)}\n\nAnalyze all USPTO rejection grounds:\n1. Likelihood of Confusion (Sec 2(d)) — DuPont factors\n2. Merely Descriptive (Sec 2(e)(1))\n3. Generic\n4. Geographic Descriptiveness (Sec 2(e)(2))\n5. Primarily a Surname (Sec 2(e)(4))\n6. Ornamental Use\n7. Deceptive Matter (Sec 2(a))\n\nReturn ONLY:\n{\n  "approvalScore": 0-100,\n  "verdict": "approve"|"caution"|"reject",\n  "distinctiveness": "string",\n  "mainRisks": ["string"],\n  "recommendation": "string",\n  "rejectionGrounds": {\n    "likelihoodOfConfusion": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "merelyDescriptive":    { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "generic":              { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "geographicDescriptiveness": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "primarilyASurname":    { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "ornamental":           { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "deceptiveMatter":      { "risk": "none"|"low"|"medium"|"high", "explanation": "string" }\n  },\n  "conflictAnalysis": [\n    { "serialNumber": "string|null", "markName": "string|null", "status": "string|null",\n      "similarity": "string", "goodsServicesOverlap": "string",\n      "riskLevel": "low"|"medium"|"high", "isVariation": false }\n  ]\n}`
      }]
    }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);

  const outer = parseJson(text);
  const raw = outer?.content?.[0]?.text || '';
  const result = parseJson(raw);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

app.post('/api/search', async (req, res) => {
  const markName  = String(req.body?.markName  || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    const results = await searchUSPTO(markName, classCode);
    console.log(`[search] "${markName}" → ${results.length} results`);
    return res.json({
      mode: results.length > 0 ? 'uspto' : 'ai_only',
      results,
      meta: { markName, classCode, source: 'USPTO tmsearch' },
    });
  } catch (e) {
    console.error('[search] Error:', e.message);
    return res.json({ mode: 'ai_only', results: [], meta: { markName, classCode, error: e.message } });
  }
});

app.post('/api/analyze', async (req, res) => {
  const markName  = String(req.body?.markName  || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  const results   = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    return res.json(await callClaude({ markName, classCode, results }));
  } catch (e) {
    return res.status(500).json({ error: 'Claude failed', message: String(e?.message || e) });
  }
});

app.post('/api/suggest', async (req, res) => {
  const markName  = String(req.body?.markName  || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  const score     = Number(req.body?.score     || 0);
  const risks     = String(req.body?.risks     || '');
  const conflicts = String(req.body?.conflicts || '');
  if (!markName) return res.status(400).json({ error: 'markName required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        temperature: 0.9,
        system: 'You are a creative trademark attorney and brand naming expert. Return ONLY a raw JSON object. No markdown.',
        messages: [{
          role: 'user',
          content: `Proposed mark "${markName}" scored ${score}% due to: ${conflicts}. Risks: ${risks}. ${classCode ? `Class ${classCode}.` : ''}\nGenerate 6 distinctive alternative brand names.\nReturn ONLY: {"suggestions":[{"name":"MARKNAME","reason":"one sentence why stronger"}]}`
        }]
      }),
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Claude API (${resp.status})`);
    const outer = JSON.parse(text);
    const raw = outer?.content?.[0]?.text || '';
    return res.json(parseJson(raw));
  } catch (e) {
    return res.status(500).json({ error: 'Suggestion failed', message: String(e?.message || e) });
  }
});

app.get('/api/db-status', (_req, res) => res.json({ source: 'USPTO tmsearch', status: 'live' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT}`));
