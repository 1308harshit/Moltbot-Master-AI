require('dotenv').config();
const { WSClient } = require('./dist/wsClient');

async function test() {
  console.log('Token from env:', process.env.OPENCLAW_GATEWAY_TOKEN?.substring(0, 10) + '...');
  const client = new WSClient();
  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected and authenticated successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }
}

test();
