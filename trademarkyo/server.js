'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');

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

// ─── MARKER API CONFIG ────────────────────────────────────────────────────────
const MARKER_USER = process.env.MARKER_USERNAME || 'drewclearie2002';
const MARKER_PASS = process.env.MARKER_PASSWORD || '4T6M9tJzBP';
const MARKER_BASE = 'https://markerapi.com/api/v2/trademarks';

/**
 * Generate plural/singular/common variations of a mark name.
 * USPTO treats plural and singular forms as confusingly similar.
 */
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
    if (/[XZ]$/.test(base) || /CH$/.test(base) || /SH$/.test(base)) {
      variations.add(base + 'ES');
    }
    if (base.endsWith('Y') && base.length > 1) {
      variations.add(base.slice(0, -1) + 'IES');
    }
  }

  if (base.endsWith('ING') && base.length > 4) {
    variations.add(base.slice(0, -3));
    variations.add(base.slice(0, -3) + 'E');
  } else if (!base.includes(' ') && base.length <= 8 && !base.endsWith('ING')) {
    variations.add(base + 'ING');
  }

  return [...variations].filter(v => v.length >= 2);
}

/**
 * Search MarkerAPI for a single mark term.
 * Returns structured trademark records.
 */
async function searchMarkerAPI(markName, status = 'all') {
  const encoded = encodeURIComponent(markName);
  const url = `${MARKER_BASE}/trademark/${encoded}/status/${status}/start/1/username/${MARKER_USER}/password/${MARKER_PASS}`;

  console.log(`[marker] Searching: ${markName}`);

  const resp = await fetch(url);
  if (!resp.ok) {
    console.log(`[marker] HTTP ${resp.status} for "${markName}"`);
    return [];
  }

  const data = await resp.json();

  if (!data || !Array.isArray(data.trademarks)) {
    console.log(`[marker] No results for "${markName}"`);
    return [];
  }

  console.log(`[marker] Found ${data.trademarks.length} results for "${markName}"`);

  return data.trademarks.map(t => ({
    source: 'markerapi',
    serialNumber: t.serialnumber || null,
    markName: t.wordmark || t.trademark || null,
    owner: t.owner || null,
    liveDeadStatus: String(t.status || '').toLowerCase().includes('dead') ? 'DEAD' : 'LIVE',
    goodsServices: t.description || '',
    internationalClass: t.gscode || t.code || null,
    filingDate: t.filingdate || null,
    registrationDate: t.registrationdate || null,
    isVariation: false,
    matchedVariant: markName.toUpperCase(),
  }));
}

/**
 * Search all variations (exact + plurals) and deduplicate by serial number.
 */
async function searchAllVariations(markName, classCode) {
  const variations = getMarkVariations(markName);
  console.log(`[search] Variations to search: ${variations.join(', ')}`);

  // Run all variation searches in parallel for speed
  const allResults = await Promise.all(
    variations.map(async (variant) => {
      const results = await searchMarkerAPI(variant);
      return results.map(r => ({
        ...r,
        isVariation: variant !== markName.toUpperCase(),
        matchedVariant: variant,
      }));
    })
  );

  const flat = allResults.flat();

  // Deduplicate by serial number
  const seen = new Set();
  const deduped = flat.filter(r => {
    if (!r.serialNumber) return true;
    if (seen.has(r.serialNumber)) return false;
    seen.add(r.serialNumber);
    return true;
  });

  // Filter by class if specified
  let filtered = deduped;
  if (classCode) {
    filtered = deduped.filter(r => {
      if (!r.internationalClass) return true; // keep if no class info
      const cls = String(r.internationalClass).replace(/\D/g, '');
      return cls === String(classCode);
    });
    // If class filter removes everything, return unfiltered (class data may be missing)
    if (filtered.length === 0) filtered = deduped;
  }

  console.log(`[search] Total unique results: ${filtered.length}`);
  return filtered;
}

/**
 * Call Claude for DuPont analysis.
 */
async function callClaude({ markName, classCode, results }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const classContext = classCode
    ? `The applicant is seeking registration in International Class ${classCode}.`
    : 'No specific class specified — analyze across all relevant classes.';

  const variantCount = results.filter(r => r.isVariation).length;
  const variantNote = variantCount > 0
    ? `\nIMPORTANT: ${variantCount} result(s) were found by searching plural/variation forms of the mark. Under USPTO practice and DuPont factors, plural and singular forms are treated as confusingly similar.`
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
      max_tokens: 1500,
      temperature: 0.2,
      system: 'You are a trademark clearance attorney assistant. Perform rigorous DuPont factor likelihood-of-confusion analysis. Return ONLY a raw JSON object. No markdown. No explanation.',
      messages: [{
        role: 'user',
        content: `Analyze trademark risk for proposed mark: "${markName}".\n${classContext}${variantNote}\n\nUSPTO records found (${results.length}):\n${JSON.stringify(results, null, 2)}\n\nPerform thorough DuPont analysis: similarity of marks (including plural/singular variations), relatedness of goods/services, strength of mark, channels of trade.\n\nReturn ONLY this JSON:\n{"approvalScore":0-100,"verdict":"approve"|"caution"|"reject","distinctiveness":string,"mainRisks":string[],"recommendation":string,"conflictAnalysis":[{"serialNumber":string|null,"markName":string|null,"status":string|null,"similarity":string,"goodsServicesOverlap":string,"riskLevel":"low"|"medium"|"high"}]}`
      }]
    })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Claude API (${resp.status}): ${truncate(text, 250)}`);
  const parsed = safeJsonParse(text);
  const rawContent = parsed?.content?.[0]?.text || '';
  const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  const result = safeJsonParse(stripped);
  if (!result) throw new Error('Claude returned invalid JSON');
  return result;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const markName = String(req.body?.markName || '').trim();
  const classCode = String(req.body?.classCode || '').trim();
  if (!markName) return res.status(400).json({ error: 'markName required' });

  try {
    const results = await searchAllVariations(markName, classCode);
    return res.json({
      mode: results.length > 0 ? 'markerapi' : 'ai_only',
      results,
      meta: { markName, classCode },
    });
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

  const classContext = classCode ? `The mark will be used in International Class ${classCode}.` : '';

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
        system: 'You are a creative trademark attorney and brand naming expert. Generate distinctive, trademarkable brand name alternatives. Return ONLY a raw JSON object. No markdown. No explanation.',
        messages: [{
          role: 'user',
          content: `The proposed trademark "${markName}" scored ${score}% approval likelihood due to these conflicts: ${conflicts}. Risk factors: ${risks}. ${classContext}\n\nGenerate 6 alternative brand names that:\n1. Evoke a similar brand concept or sound to "${markName}"\n2. Avoid the identified conflicts\n3. Are highly distinctive and fanciful (invented/coined words score best)\n4. Would be strong trademark candidates\n\nReturn ONLY this JSON:\n{"suggestions":[{"name":"MARKNAME","reason":"Brief explanation of why this is stronger (1 sentence)"}]}`
        }]
      })
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Claude API (${resp.status})`);
    const parsed = JSON.parse(text);
    const rawContent = parsed?.content?.[0]?.text || '';
    const stripped = rawContent.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    return res.json(JSON.parse(stripped));
  } catch (e) {
    return res.status(500).json({ error: 'Suggestion failed', message: String(e?.message || e) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, mode: 'markerapi' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Trademarkyo running on port ${PORT} — using MarkerAPI`));
