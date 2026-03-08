const WebSocket = require('ws');

async function testAutoAttach() {
  const cdpPort = 18800;
  
  // 1. Get targets
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  const Array = await (await response).json();
  const tabs = Array;
  // Find chatHub tab
  const chatHubTab = tabs.find(t => t.url.includes('chatHub') || t.url.includes('simple-chat-hub'));
  if (!chatHubTab) {
    console.log("No chatHub tab found");
    return;
  }
  
  console.log("Found ChatHub Tab:", chatHubTab.title, chatHubTab.url);
  const ws = new WebSocket(chatHubTab.webSocketDebuggerUrl);
  
  let msgId = 1;
  const cdpSend = (method, params = {}, sessionId = undefined) => {
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
      
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      
      ws.send(JSON.stringify(payload));
    });
  };

  ws.on('open', async () => {
    console.log("Connected to parent tab. Setting autoAttach...");
    
    const childTargets = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Target.attachedToTarget') {
        const targetInfo = msg.params.targetInfo;
        const sessionId = msg.params.sessionId;
        childTargets.push({ targetInfo, sessionId });
        console.log(`Attached to child: ${targetInfo.url} (sessionId: ${sessionId})`);
      }
    });

    await cdpSend('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    
    // Wait a moment to receive attachments
    await new Promise(r => setTimeout(r, 2000));
    
    console.log(`Total children found: ${childTargets.length}`);
    
    // Test evaluating in one of the children
    for (const child of childTargets) {
      if (child.targetInfo.url.includes('chatgpt.com') || child.targetInfo.url.includes('claude.ai')) {
        console.log(`Evaluating in ${child.targetInfo.url}...`);
        try {
          const evalResult = await cdpSend('Runtime.evaluate', {
            expression: 'document.body ? document.body.innerText.substring(0, 50) : ""',
            returnByValue: true
          }, child.sessionId);
          
          if (evalResult && evalResult.result) {
            console.log(`-> Text result: ${evalResult.result.value.replace(/\\n/g, ' ')}`);
          }
        } catch(e) {
          console.log(`Error:`, e.message);
        }
      }
    }
    
    await new Promise(r => setTimeout(r, 2000));
    ws.close();
  });
}

testAutoAttach();
