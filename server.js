/**
 * Moltbot API — POST /orchestrate
 * JSON in → JSON out. No UI, no browser, no auth.
 */

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { orchestrate } = require('./moltbot');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post('/orchestrate', async (req, res) => {
  const { prompt, models } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "prompt" (string required)' });
  }

  try {
    const start = Date.now();
    const result = await orchestrate(prompt, models);
    const total_latency_ms = Date.now() - start;

    const withText = Object.values(result).filter((r) => r?.text != null && r.text !== '').length;
    const total = Object.keys(result).length;
    const status = total === 0 ? 'failed' : withText === total ? 'success' : withText > 0 ? 'partial' : 'failed';

    const request_id = crypto.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    res.json({ request_id, total_latency_ms, status, ...result });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Moltbot API running at http://localhost:${PORT}`);
  console.log('POST /orchestrate — body: { "prompt": "...", "models": ["openai","claude","gemini"] }');
});
