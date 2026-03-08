const WebSocket = require('ws');

async function testTargets() {
  const cdpPort = 18800;
  
  // Connect to the browser itself using the browser WebSocket endpoint
  const jsonResp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const versionInfo = await jsonResp.json();
  const browserWsUrl = versionInfo.webSocketDebuggerUrl;

  console.log("Browser WS:", browserWsUrl);
  
  if (!browserWsUrl) return;

  const ws = new WebSocket(browserWsUrl);
  
  let msgId = 1;
  const cdpSend = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  ws.on('open', async () => {
    const targetsResult = await cdpSend('Target.getTargets');
    const targets = targetsResult.targetInfos;
    
    // Find the ChatHub tab
    const chatHubTarget = targets.find(t => t.url.includes('chatHub.html'));
    console.log("ChatHub Target:", chatHubTarget);
    
    // Find the AI panels
    console.log("\nAll targets related to ChatGPT, etc:");
    for (const t of targets) {
      if (t.url.includes('chatgpt.com') || t.url.includes('claude.ai')) {
        console.log(`- ${t.type} | ${t.url} | id: ${t.targetId} | openerId: ${t.openerId} | browserContextId: ${t.browserContextId}`);
      }
    }
    
    ws.close();
  });
}

testTargets();
