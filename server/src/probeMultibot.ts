/**
 * Sequential boot probe — sends boot commands one at a time.
 * Step 1: "open browser"
 * Step 2: SimpleChatHub + panels setup
 * 
 * Usage:  npm run probe             → runs boot step 1 ("open browser")
 *         npm run probe -- boot2    → runs boot step 2 (SimpleChatHub setup)
 *         npm run probe -- step1    → runs actual step1 research prompt
 */
import { wsClient } from './wsClient';
import { promptPlaceholders } from './config';
import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = path.resolve(__dirname, '../../probe_log.txt');

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const PROBES: Record<string, { prompt: string; timeout: number; description: string }> = {
  // Boot step 1: just open the browser
  boot1: {
    prompt: 'Open browser',
    timeout: 3 * 60 * 1000,
    description: 'Open browser (simple command)',
  },

  // Boot step 2: set up SimpleChatHub with 6 panels
  boot2: {
    prompt: `Now ensure the SimpleChatHub extension UI is open in the browser.
Ensure 6 parallel chat panels are visible and ready.
Focus Panel 1.
Confirm the system is ready for input.

OUTPUT FORMAT:
Return a short structured confirmation:

STATUS: READY
BROWSER: OK
EXTENSION: OK
PANELS: 6 READY

=== END OF STEP 0 ===`,
    timeout: 5 * 60 * 1000,
    description: 'Set up SimpleChatHub + 6 panels',
  },

  // Full boot (original prompt from config)
  step0: {
    prompt: promptPlaceholders.default_prompt_boot,
    timeout: 5 * 60 * 1000,
    description: 'Full boot prompt (from config)',
  },

  // Step 1 — search with sample context
  step1: {
    prompt: `${promptPlaceholders.default_prompt_step1}\n\nResearch topic: What are the latest breakthroughs in quantum computing in 2025-2026?`,
    timeout: 5 * 60 * 1000,
    description: 'Step 1 SEARCH with sample topic',
  },
};

async function main() {
  const step = process.argv[2] || 'boot1';
  const config = PROBES[step];

  if (!config) {
    console.error(`Unknown probe: ${step}. Available: ${Object.keys(PROBES).join(', ')}`);
    process.exit(1);
  }

  // Reset log
  fs.writeFileSync(LOG_FILE, `=== PROBE "${step}" — ${new Date().toISOString()} ===\n`);

  log(`📋  PROBE: ${step} — ${config.description}`);
  log(`📋  TIMEOUT: ${config.timeout / 1000}s`);
  log(`📋  PROMPT:\n${config.prompt}\n`);
  log(`⏳  Sending to MoltBot (session: agent:main:main)...\n`);

  try {
    const reply = await wsClient.sendToSession('agent:main:main', config.prompt, config.timeout);

    log(`\n✅ RESPONSE (${reply.length} chars):`);
    log('─'.repeat(50));
    log(reply);
    log('─'.repeat(50));

    // Check for markers
    if (reply.includes('=== END OF STEP 0 ===')) {
      log('\n🔍 Marker "=== END OF STEP 0 ===": ✅ FOUND');
    } else if (step === 'boot2' || step === 'step0') {
      log('\n🔍 Marker "=== END OF STEP 0 ===": ❌ NOT FOUND');
    }

    log(`\n✅ Probe "${step}" complete!`);
    process.exit(0);
  } catch (err) {
    log(`\n❌ Probe FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
