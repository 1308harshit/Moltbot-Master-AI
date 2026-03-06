const WebSocket = require('ws');

const CDP_PORT = 18800;
const PANEL_DOMAINS = [
  { domain: 'chatgpt.com', name: 'ChatGPT' },
  { domain: 'gemini.google.com', name: 'Gemini' },
  { domain: 'grok.com', name: 'Grok' },
  { domain: 'claude.ai', name: 'Claude' },
  { domain: 'perplexity.ai', name: 'Perplexity' },
  { domain: 'chat.qwen.ai', name: 'Qwen' },
];

async function readFromTab(tab) {
  return new Promise(async (resolve) => {
    try {
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      let mid = 1;

      const cdp = (method, params = {}) => new Promise((res, rej) => {
        const id = mid++;
        const t = setTimeout(() => rej(new Error('Timeout')), 10000);
        const h = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) { clearTimeout(t); ws.off('message', h); msg.error ? rej(msg.error) : res(msg.result); }
        };
        ws.on('message', h);
        ws.send(JSON.stringify({ id, method, params }));
      });

      await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); setTimeout(() => j(new Error('connect timeout')), 5000); });

      const result = await cdp('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : "NO BODY"',
        returnByValue: true,
      });

      ws.close();
      resolve(result.result.value || 'No content');
    } catch (e) {
      resolve('Error reading: ' + (e.message || JSON.stringify(e)));
    }
  });
}

async function main() {
  console.log('Fetching tabs from CDP...');
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const tabs = await res.json();

  console.log(`Found ${tabs.length} tabs:\n`);

  // List all tabs
  tabs.forEach((t, i) => {
    const match = PANEL_DOMAINS.find(p => t.url.includes(p.domain));
    const marker = match ? `  ★ ${match.name}` : '';
    console.log(`  [${i}] ${t.url.substring(0, 80)}${marker}`);
  });

  console.log('\n=== Reading Panel Content ===\n');

  for (const panel of PANEL_DOMAINS) {
    // Find tabs matching this AI service
    const matchingTabs = tabs.filter(t => t.url.includes(panel.domain) && t.webSocketDebuggerUrl);

    if (matchingTabs.length === 0) {
      console.log(`--- ${panel.name}: NO TAB FOUND ---\n`);
      continue;
    }

    // Use the first matching tab
    const tab = matchingTabs[0];
    console.log(`--- ${panel.name} (${tab.url.substring(0, 60)}...) ---`);
    
    const content = await readFromTab(tab);
    // Print first 300 chars
    console.log(content.substring(0, 300));
    console.log(`... [${content.length} total chars]\n`);
  }

  console.log('Done!');
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
