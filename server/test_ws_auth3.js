require('dotenv').config();
const { WSClient } = require('./dist/wsClient');

async function test() {
  const client = new WSClient();
  try {
    await client.connect();
    console.log('Connected! Sending mock Step 2a payload...');
    
    // A simplified step2a payload
    let prompt = `Below are the full AI panel responses extracted from Simple Chat Hub. Analyze them thoroughly.\n\n`;
    // Add 40,000 characters of junk to simulate the 6 AI panels
    prompt += 'A'.repeat(40000);
    
    console.log('Calling sendToSession() with variable prompt length...', prompt.length);
    const result = await client.sendToSession('test-session', prompt, 30000);
    console.log('Result received:', result.substring(0, 500));
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}

test();
