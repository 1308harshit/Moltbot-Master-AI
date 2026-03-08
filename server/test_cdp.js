const WebSocket = require('ws');

async function testCDP() {
  const cdpPort = 18800;
  // 1. Get targets
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  const tabs = await response.json();
  
  // Find chatHub tab
  const chatHubTab = tabs.find(t => t.url.includes('chatHub') || t.url.includes('simple-chat-hub'));
  if (!chatHubTab) {
    console.log("No chatHub tab found");
    return;
  }
  
  console.log("Found ChatHub Tab:", chatHubTab.title, chatHubTab.url);
  const ws = new WebSocket(chatHubTab.webSocketDebuggerUrl);
  
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
    console.log("Connected to parent tab");
    
    // Listen for execution contexts
    const contexts = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Runtime.executionContextCreated') {
        contexts.push(msg.params.context);
      }
    });

    await cdpSend('Runtime.enable');
    await cdpSend('Page.enable');
    
    console.log("Collected", contexts.length, "contexts...");
    
    // We need the frame tree to know the frame URLs
    const treeResult = await cdpSend('Page.getFrameTree');
    const walkTree = (frameNode) => {
      const list = [frameNode.frame];
      if (frameNode.childFrames) {
        for (const child of frameNode.childFrames) {
          list.push(...walkTree(child));
        }
      }
      return list;
    };
    
    const frames = walkTree(treeResult.frameTree);
    console.log("Frames found:", frames.length);
    
    for (const frame of frames) {
      console.log(`- Frame: ${frame.id} URL: ${frame.url}`);
      // Find matching context
      const ctx = contexts.find(c => c.auxData && c.auxData.frameId === frame.id);
      if (ctx) {
        try {
          const evalResult = await cdpSend('Runtime.evaluate', {
            expression: 'document.body ? document.body.innerText.substring(0, 50) : ""',
            contextId: ctx.id,
            returnByValue: true
          });
          console.log(`  -> Text: ${evalResult.result.value.replace(/\n/g, ' ')}`);
        } catch(e) {
          console.log(`  -> Error evaluating: ${e.message}`);
        }
      } else {
        console.log(`  -> No execution context found for this frame.`);
      }
    }
    
    ws.close();
  });
}

testCDP();
