'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { initSchema, searchTrademarks, getLoaderStatus, getTrademarkCount } = require('./db');
const { startCron } = require('./cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 8080);

function truncate(s, n) { const str = String(s || ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }

function safeJsonParse(text) {
  if (!text) return null;
  const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function callClaude({ markName, classCode, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const classContext = classCode
    ? `The applicant is seeking registration in International Class ${classCode}.`
    : 'No specific class specified - analyze across all relevant classes.';

  const variantCount = results.filter(r => r.isVariation).length;
  const variantNote = variantCount > 0
    ? `\nIMPORTANT: ${variantCount} result(s) were found by searching plural/variation forms of the mark. Under established USPTO practice and DuPont factors, plural and singular forms are treated as confusingly similar.`
    : '';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.2,
      system: 'You are a trademark clearance attorney assistant. Perform rigorous analysis covering ALL USPTO rejection grounds. Return ONLY a raw JSON object. No markdown. No explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for proposed mark: "${markName}".
${classContext}${variantNote}

USPTO database records found (${results.length}):
${JSON.stringify(results.slice(0, 30), null, 2)}

Analyze ALL of the following USPTO rejection grounds:

1. LIKELIHOOD OF CONFUSION (Sec 2(d)) — DuPont factors
2. MERELY DESCRIPTIVE (Sec 2(e)(1)) — directly describes a feature/quality
3. GENERIC — common name for the goods/services
4. GEOGRAPHICALLY DESCRIPTIVE (Sec 2(e)(2)) — primarily denotes a geographic location
5. PRIMARILY A SURNAME (Sec 2(e)(4)) — primarily a last name
6. ORNAMENTAL USE — for clothing/accessories, used as decoration not source identifier
7. DECEPTIVE MATTER (Sec 2(a)) — falsely suggests a connection or deceives consumers
8. DISTINCTIVENESS — Fanciful > Arbitrary > Suggestive > Descriptive > Generic

Return ONLY this JSON:
{
  "approvalScore": 0-100,
  "verdict": "approve"|"caution"|"reject",
  "distinctiveness": "string",
  "mainRisks": ["string"],
  "recommendation": "string",
  "rejectionGrounds": {
    "likelihoodOfConfusion": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "merelyDescriptive": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "generic": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "geographicDescriptiveness": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "primarilyASurname": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "ornamental": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" },
    "deceptiveMatter": { "risk": "none"|"low"|"medium"|"high", "explanation": "string" }
  },
  "conflictAnalysis": [
    {
      "serialNumber": "string|null",
      "markName": "string|null",
      "status": "string|null",
      "similarity": "string",
      "goodsServicesOverlap": "string",
      "riskLevel": "low"|"medium"|"high",
      "isVariation": false
    }
  ]
}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  const result = safeJsonParse(rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    const results = await searchTrademarks(markName, classCode);
    console.log(`[search] "${markName}" → ${results.length} results from PostgreSQL`);
    return res.json({
      mode: results.length > 0 ? 'postgresql' : 'ai_only',
      results,
      meta: { markName, classCode, source: 'USPTO PostgreSQL database' }
    });
  } catch (e) {
    console.error('[search] Failed:', e.message);
    return res.json({
      mode: 'ai_only',
      results: [],
      meta: { markName, classCode, error: e.message }
    });
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
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        temperature: 0.9,
        system: 'You are a creative trademark attorney and brand naming expert. Return ONLY a raw JSON object. No markdown.',
        messages: [{
          role: 'user',
          content: `Proposed mark "${markName}" scored ${score}% due to: ${conflicts}. Risks: ${risks}. ${classCode ? `Class ${classCode}.` : ''}
Generate 6 distinctive alternative brand names.
Return ONLY: {"suggestions":[{"name":"MARKNAME","reason":"one sentence why stronger"}]}`
        }]
      })
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Claude API (${resp.status})`);
    const parsed = JSON.parse(text);
    const rawContent = parsed?.content?.[0]?.text || '';
    const result = JSON.parse(rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim());
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: 'Suggestion failed', message: String(e?.message || e) });
  }
});

app.get('/api/db-status', async (req, res) => {
  try {
    const count = await getTrademarkCount();
    const logs = await getLoaderStatus();
    return res.json({ trademarkCount: count, recentRuns: logs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── STARTUP ────────────────────────────────────────────────────────────────

async function start() {
  // Start server FIRST — never block on DB or loader
  app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT}`));

  // Init schema
  try {
    await initSchema();
    console.log('[startup] Database schema initialized');
  } catch (e) {
    console.error('[startup] DB init failed:', e.message);
  }

  // Start daily cron
  startCron();

  // If DB is empty, kick off initial load in background without blocking
  try {
    const count = await getTrademarkCount();
    if (count === 0) {
      console.log('[startup] Database empty — launching background loader...');
      const { spawn } = require('child_process');
      const child = spawn('node', ['loader.js', 'full'], {
        detached: true,
        stdio: 'inherit',
        cwd: __dirname,
        env: { ...process.env },
      });
      child.unref();
      console.log(`[startup] Loader running in background (PID: ${child.pid})`);
    } else {
      console.log(`[startup] Database has ${count} records — ready`);
    }
  } catch (e) {
    console.error('[startup] Background loader error:', e.message);
  }
}

start();
