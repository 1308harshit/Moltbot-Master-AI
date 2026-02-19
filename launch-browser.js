/**
 * Playwright script: launches Chromium with persistent profile for manual login.
 * - Visible UI (not headless)
 * - Profile stored in ./moltbot-browser-profile
 * - Three tabs: ChatGPT, Claude, Gemini
 */

const { chromium } = require('playwright');
const path = require('path');

// Clearly named local directory for browser profile (cookies, localStorage, etc.)
const USER_DATA_DIR = path.join(__dirname, 'moltbot-browser-profile');

// AI app URLs (no prompts — just navigation)
const TABS = {
  chatgpt_tab: 'https://chatgpt.com',
  claude_tab: 'https://claude.ai',
  gemini_tab: 'https://gemini.google.com',
};

async function main() {
  console.log('Launching Chromium with persistent profile...');
  console.log(`Profile directory: ${USER_DATA_DIR}`);
  console.log('(Close any previous browser instance first if you see errors)\n');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: undefined, // use bundled Chromium
  });

  // Create three tabs with logical names
  const chatgpt_tab = context.pages()[0] ?? await context.newPage();
  const claude_tab = await context.newPage();
  const gemini_tab = await context.newPage();

  const tabs = { chatgpt_tab, claude_tab, gemini_tab };

  // Navigate each tab to its AI website
  const navOpts = { timeout: 30000, waitUntil: 'domcontentloaded' };
  console.log('Opening tabs and navigating...');
  await Promise.all([
    chatgpt_tab.goto(TABS.chatgpt_tab, navOpts),
    claude_tab.goto(TABS.claude_tab, navOpts),
    gemini_tab.goto(TABS.gemini_tab, navOpts),
  ]);

  console.log('Tabs opened:');
  for (const [name, page] of Object.entries(tabs)) {
    console.log(`  - ${name}: ${page.url()}`);
  }

  // --- Pause: print instructions ---
  console.log('\n' + '─'.repeat(60));
  console.log('BROWSER IS OPEN — MANUAL LOGIN INSTRUCTIONS');
  console.log('─'.repeat(60));
  console.log('1. Log in manually in each tab (ChatGPT, Claude, Gemini)');
  console.log('2. Sessions persist across runs (same profile directory)');
  console.log('3. When done, press Ctrl+C in this terminal to close');
  console.log('─'.repeat(60));

  // Wait indefinitely — user closes with Ctrl+C when finished
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
