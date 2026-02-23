'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 8080);

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── USPTO Search via their open search API ──────────────────────────────────
// Uses the USPTO Open Data Portal search endpoint - no browser needed
async function searchUsptoCdsApi(markName) {
  const encoded = encodeURIComponent(markName);
  
  // Try the USPTO TSDR/CDS search endpoint
  const url = `https://tsdrapi.uspto.gov/ts/cd/casestatus/sn/${encoded}/info.json`;
  
  // Actually use the trademark search API
  const searchUrl = `https://developer.uspto.gov/ds-api/opi/v1/applications/trademarks?searchText=markLiteral%3A%22${encoded}%22&start=0&rows=15&sort=appFilingDate+desc`;
  
  const resp = await fetch(searchUrl, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) throw new Error(`USPTO API ${resp.status}`);
  
  const data = await resp.json();
  const docs = data?.response?.docs || data?.results || [];
  
  if (!docs.length) throw new Error('No results from USPTO API');

  return docs.slice(0, 15).map(d => ({
    source: 'uspto_api',
    serialNumber: d.appSerialNumber || d.serialNumber || null,
    liveDeadStatus: d.appStatus ? (d.appStatus.toLowerCase().includes('dead') ? 'DEAD' : 'LIVE') : null,
    markName: d.markLiteral || d.markDescription || null,
    owner: d.applicantName || d.ownerName || null,
    goodsServices: d.goodsAndServices || d.goodsServicesDesc || null,
    filingDate: d.appFilingDate || null,
    registrationDate: d.regDate || null,
    detailUrl: null
  }));
}

// ─── Fallback: USPTO trademark search via public search endpoint ──────────────
async function searchUsptoPublic(markName) {
  const query = encodeURIComponent(`"${markName}"`);
  const url = `https://developer.uspto.gov/ds-api/opi/v1/applications/trademarks?searchText=markLiteral%3A${query}&start=0&rows=15`;

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) throw new Error(`USPTO public API ${resp.status}`);

  const data = await resp.json();
  const docs = data?.response?.docs || [];
  if (!docs.length) throw new Error('No results');

  return docs.slice(0, 15).map(d => ({
    source: 'uspto_public',
    serialNumber: d.appSerialNumber || null,
    liveDeadStatus: d.appStatus?.toLowerCase().includes('dead') ? 'DEAD' : 'LIVE',
    markName: d.markLiteral || null,
    owner: d.applicantName || null,
    goodsServices: d.goodsAndServices || null,
    filingDate: d.appFilingDate || null,
    registrationDate: d.regDate || null,
    detailUrl: null
  }));
}

// ─── Fallback: wildcard search ────────────────────────────────────────────────
async function searchUsptoWildcard(markName) {
  const upper = markName.toUpperCase().trim();
  // Search for marks containing similar words
  const query = encodeURIComponent(`markLiteral:${upper}*`);
  const url = `https://developer.uspto.gov/ds-api/opi/v1/applications/trademarks?searchText=${query}&start=0&rows=15`;

  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) throw new Error(`Wildcard search ${resp.status}`);

  const data = await resp.json();
  const docs = data?.response?.docs || [];
  if (!docs.length) throw new Error('No wildcard results');

  return docs.slice(0, 15).map(d => ({
    source: 'uspto_wildcard',
    serialNumber: d.appSerialNumber || null,
    liveDeadStatus: d.appStatus?.toLowerCase().includes('dead') ? 'DEAD' : 'LIVE',
    markName: d.markLiteral || null,
    owner: d.applicantName || null,
    goodsServices: d.goodsAndServices || null,
    filingDate: d.appFilingDate || null,
    detailUrl: null
  }));
}

// ─── Claude DuPont Analysis ───────────────────────────────────────────────────
async function callClaudeDupontAnalysis({ markName, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    temperature: 0.2,
    system: 'You are a trademark clearance assistant. Perform a DuPont factor likelihood-of-confusion analysis. Return ONLY valid JSON. No markdown, no explanation.',
    messages: [{
      role: 'user',
      content:
        `Analyze trademark risk for proposed mark: "${markName}".\n\n` +
        `Prior marks found in USPTO database:\n` +
        JSON.stringify(results || [], null, 2) +
        `\n\nReturn this exact JSON shape:\n` +
        `{\n` +
        `  "approvalScore": number (0-100),\n` +
        `  "verdict": "approve" | "caution" | "reject",\n` +
        `  "distinctiveness": string,\n` +
        `  "mainRisks": string[],\n` +
        `  "recommendation": string,\n` +
        `  "conflictAnalysis": [\n` +
        `    {\n` +
        `      "serialNumber": string|null,\n` +
        `      "markName": string|null,\n` +
        `      "status": string|null,\n` +
        `      "similarity": string,\n` +
        `      "goodsServicesOverlap": string,\n` +
        `      "riskLevel": "low" | "medium" | "high"\n` +
        `    }\n` +
        `  ]\n` +
        `}`
    }]
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API error (${resp.status}): ${truncate(text, 250)}`);

  const parsed = safeJsonParse(text);
  const contentText = parsed?.content?.[0]?.text;
  if (!contentText) throw new Error('Claude response missing content');

  const analysisJson = safeJsonParse(contentText);
  if (!analysisJson) throw new Error('Claude did not return valid JSON');

  return analysisJson;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName is required' });

  const meta = { markName, attempted: [], errors: [] };

  // Try exact match first
  for (const [name, fn] of [
    ['uspto_exact', () => searchUsptoCdsApi(markName)],
    ['uspto_public', () => searchUsptoPublic(markName)],
    ['uspto_wildcard', () => searchUsptoWildcard(markName)],
  ]) {
    try {
      meta.attempted.push(name);
      const results = await fn();
      console.log(`[search] ${name} returned ${results.length} results for "${markName}"`);
      return res.json({ mode: name, results, meta });
    } catch (e) {
      console.error(`[search] ${name} failed:`, e.message);
      meta.errors.push({ step: name, message: String(e?.message || e) });
    }
  }

  // AI only fallback
  console.log(`[search] all methods failed for "${markName}", returning ai_only`);
  return res.json({ mode: 'ai_only', results: [], meta });
});

app.post('/api/analyze', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!markName) return res.status(400).json({ error: 'markName is required' });

  try {
    const analysis = await callClaudeDupontAnalysis({ markName, results });
    return res.json(analysis);
  } catch (e) {
    return res.status(500).json({ error: 'Claude analysis failed', message: String(e?.message || e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT}`));
