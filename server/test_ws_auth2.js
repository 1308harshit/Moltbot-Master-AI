require('dotenv').config();
const { WSClient } = require('./dist/wsClient');

async function test() {
  const client = new WSClient();
  try {
    await client.connect();
    console.log('Connected! Sending mock Step 2a payload...');
    
    // A simplified step2a payload
    const prompt = `Below are the full AI panel responses extracted from Simple Chat Hub. Analyze them thoroughly.

ChatGPT Full Response:
Here is a test response with some text.

Using ONLY the information above, produce exactly these five sections:
1. Common Themes
2. Major Differences
3. Strengths and Weaknesses
4. Missing Areas
5. Preliminary Conclusion`;

    console.log('Calling sendToSession()...');
    const result = await client.sendToSession('test-session', prompt, 30000);
    console.log('Result received:', result.substring(0, 500));
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}

test();
