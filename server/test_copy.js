const fs = require('fs');
const path = require('path');
const os = require('os');

const src = 'C:\\Users\\harsh\\.openclaw\\browser\\openclaw\\user-data';
const dest = path.join(os.tmpdir(), `moltbot_test_${Date.now()}`);

console.log(`Copying from ${src} to ${dest}...`);

try {
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Copy success!`);
} catch (e) {
  console.error(`Copy failed:`, e.message);
}
