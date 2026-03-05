const WebSocket = require('ws');

const CDP_PORT = 18800;
const QUERY = 'what is the current trend of AI?';

async function main() {
  // Step 1: Get tab list
  console.log('Fetching tabs from CDP port 18800...');
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const tabs = await res.json();
  
  console.log(`Found ${tabs.length} tabs:`);
  tabs.forEach((t, i) => console.log(`  [${i}] ${t.title} => ${t.url}`));
  
  const tab = tabs.find(t => t.url.includes('chatHub') || t.url.includes('dpfkgaedamhcmkkgeiajeggihmfjhhlj'));
  if (!tab) { console.error('chatHub tab not found!'); process.exit(1); }
  
  console.log(`\nUsing: ${tab.title}\nWS: ${tab.webSocketDebuggerUrl}`);
  
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let mid = 1;
  
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = mid++;
    const t = setTimeout(() => reject(new Error('Timeout: ' + method)), 10000);
    const h = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { clearTimeout(t); ws.off('message', h); msg.error ? reject(msg.error) : resolve(msg.result); }
    };
    ws.on('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
  
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  console.log('Connected to tab WebSocket!');
  
  // Step 2: Focus the textarea
  console.log('\nFocusing textarea...');
  const focusResult = await cdp('Runtime.evaluate', {
    expression: `(function(){
      var ta = document.querySelector('textarea.ant-input');
      if (!ta) return 'NO_TEXTAREA';
      ta.focus();
      ta.click();
      return 'FOCUSED';
    })()`,
    returnByValue: true,
  });
  console.log('Focus result:', JSON.stringify(focusResult.result));

  await new Promise(r => setTimeout(r, 300));

  // Step 3: Type using CDP Input.insertText (native browser-level typing)
  console.log(`\nTyping via Input.insertText: "${QUERY}"`);
  await cdp('Input.insertText', { text: QUERY });
  console.log('Text inserted!');

  await new Promise(r => setTimeout(r, 500));

  // Step 4: Verify the value was set
  const verifyResult = await cdp('Runtime.evaluate', {
    expression: `(function(){
      var ta = document.querySelector('textarea.ant-input');
      return ta ? 'VALUE:' + ta.value : 'NO_TEXTAREA';
    })()`,
    returnByValue: true,
  });
  console.log('Verify:', JSON.stringify(verifyResult.result));

  await new Promise(r => setTimeout(r, 500));

  // Step 5: Press Enter using CDP Input.dispatchKeyEvent (native key press)
  console.log('\nPressing Enter via Input.dispatchKeyEvent...');
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  console.log('Enter pressed!');

  ws.close();
  console.log('\nDone! Check the browser — query should be submitted.');
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
