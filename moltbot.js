/**
 * Moltbot — API-based parallel execution
 * Sends same prompt to OpenAI, Anthropic, Google Gemini.
 * Stable, repeatable, client-grade.
 *
 * Requires env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY
 */

require('dotenv').config();

const { OpenAI } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Configuration ---
const MODELS = {
  chatgpt: 'gpt-4o-mini',
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.5-flash',
};

/**
 * Call OpenAI ChatGPT API
 */
async function callChatGPT(prompt) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({
    model: MODELS.chatgpt,
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.choices[0]?.message?.content ?? '';
}

/**
 * Call Anthropic Claude API
 */
async function callClaude(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: MODELS.claude,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = message.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * Call Google Gemini API
 */
async function callGemini(prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: MODELS.gemini });
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text() ?? '';
}

const PROVIDERS = { openai: callChatGPT, claude: callClaude, gemini: callGemini };

/**
 * Moltbot: send prompt to all APIs in parallel, collect structured responses
 */
async function moltbot(prompt) {
  const tasks = [
    callChatGPT(prompt).then((content) => ({ provider: 'chatgpt', content, error: null })),
    callClaude(prompt).then((content) => ({ provider: 'claude', content, error: null })),
    callGemini(prompt).then((content) => ({ provider: 'gemini', content, error: null })),
  ];

  const results = await Promise.allSettled(tasks);

  return results.map((r, i) => {
    const provider = ['chatgpt', 'claude', 'gemini'][i];
    if (r.status === 'fulfilled') {
      return r.value;
    }
    return {
      provider,
      content: null,
      error: r.reason?.message ?? String(r.reason),
    };
  });
}

/**
 * API orchestrate: { prompt, models } → { openai: { text, latency_ms }, ... }
 */
async function orchestrate(prompt, models = ['openai', 'claude', 'gemini']) {
  const valid = models.filter((m) => PROVIDERS[m]);
  if (valid.length === 0) valid.push('openai', 'claude', 'gemini');

  const tasks = valid.map(async (name) => {
    const start = Date.now();
    try {
      const text = await PROVIDERS[name](prompt);
      return [name, { text, latency_ms: Date.now() - start }];
    } catch (err) {
      return [name, { text: null, error: err?.message ?? String(err), latency_ms: Date.now() - start }];
    }
  });

  const results = await Promise.all(tasks);
  return Object.fromEntries(results);
}

// --- CLI ---
async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'Say "hello" in one sentence.';

  const keys = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };

  const missing = Object.entries(keys).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('Missing API keys:', missing.join(', '));
    console.error('Set them in .env or environment variables.');
    process.exit(1);
  }

  console.log('Moltbot — parallel API execution');
  console.log('Prompt:', prompt);
  console.log('');

  const start = Date.now();
  const responses = await moltbot(prompt);
  const elapsed = Date.now() - start;

  console.log(JSON.stringify({ prompt, elapsed_ms: elapsed, responses }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { moltbot, orchestrate };
