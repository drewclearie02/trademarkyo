'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const { spawn } = require('child_process');

const { initSchema, searchTrademarks, getLoaderStatus, getTrademarkCount } = require('./db');
const { startCron } = require('./cron');

const app  = express();
const PORT = Number(process.env.PORT || 8080);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function parseJson(text) {
  if (!text) return null;
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(clean); } catch { return null; }
}

async function callClaude({ markName, classCode, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const classCtx = classCode
    ? `The applicant seeks registration in International Class ${classCode}.`
    : 'No specific class — analyze across all relevant classes.';

  const variantCount = results.filter(r => r.isVariation).length;
  const variantNote = variantCount > 0
    ? `\nIMPORTANT: ${variantCount} result(s) matched via plural/variation search. Under USPTO practice, plural and singular forms are confusingly similar.`
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
        content: `Analyze trademark risk for: "${markName}".\n${classCtx}${variantNote}\n\nUSPTO database records (${results.length}):\n${JSON.stringify(results.slice(0, 30), null, 2)}\n\nAnalyze all USPTO rejection grounds:\n1. Likelihood of Confusion (Sec 2(d)) — DuPont factors\n2. Merely Descriptive (Sec 2(e)(1))\n3. Generic\n4. Geographic Descriptiveness (Sec 2(e)(2))\n5. Primarily a Surname (Sec 2(e)(4))\n6. Ornamental Use\n7. Deceptive Matter (Sec 2(a))\n\nReturn ONLY:\n{\n  "approvalScore": 0-100,\n  "verdict": "approve"|"caution"|"reject",\n  "distinctiveness": "string",\n  "mainRisks": ["string"],\n  "recommendation": "string",\n  "rejectionGrounds": {\n    "likelihoodOfConfusion": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "merelyDescriptive":    { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "generic":              { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "geographicDescriptiveness": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "primarilyASurname":    { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "ornamental":           { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },\n    "deceptiveMatter":      { "risk": "none"|"low"|"medium"|"high", "explanation": "string" }\n  },\n  "conflictAnalysis": [\n    { "serialNumber": "string|null", "markName": "string|null", "status": "string|null",\n      "similarity": "string", "goodsServicesOverlap": "string",\n      "riskLevel": "low"|"medium"|"high", "isVariation": false }\n  ]\n}`
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const markName  = String(req.body?.markName  || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    const results = await searchTrademarks(markName, classCode);
    console.log(`[search] "${markName}" → ${results.length} results`);
    return res.json({
      mode: results.length > 0 ? 'postgresql' : 'ai_only',
      results,
      meta: { markName, classCode, source: 'USPTO PostgreSQL database' },
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
    const result = parseJson(raw);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Suggestion failed', message: String(e?.message || e) });
  }
});

app.get('/api/db-status', async (_req, res) => {
  try {
    const count = await getTrademarkCount();
    const logs  = await getLoaderStatus();
    return res.json({ trademarkCount: count, recentRuns: logs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Startup ───────────────────────────────────────────────────────────────────

function spawnLoader(mode) {
  const child = spawn(process.execPath, ['loader.js', mode], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout.on('data', d => console.log(`[loader] ${String(d).trimEnd()}`));
  child.stderr.on('data', d => console.error(`[loader] ${String(d).trimEnd()}`));
  child.on('exit', code => console.log(`[startup] Loader exited code=${code}`));
  console.log(`[startup] Loader spawned pid=${child.pid} mode=${mode}`);
}

async function start() {
  // Bind port FIRST — Railway health check needs this immediately
  app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT}`));

  // Init DB schema
  try {
    await initSchema();
  } catch (e) {
    console.error('[startup] DB schema error:', e.message);
  }

  // Start daily cron
  startCron();

  // Auto-seed if DB is empty
  try {
    const count = await getTrademarkCount();
    if (count === 0) {
      console.log('[startup] Database empty — spawning background loader (full)...');
      spawnLoader('full');
    } else {
      console.log(`[startup] Database has ${count} records — ready`);
    }
  } catch (e) {
    console.error('[startup] Auto-seed check failed:', e.message);
  }
}

start();
