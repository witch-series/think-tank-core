'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runInSandbox(code, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `sandbox_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);

    const wrappedCode = `
'use strict';
try {
  ${code}
  process.exit(0);
} catch (e) {
  console.error(JSON.stringify({ error: e.message, stack: e.stack }));
  process.exit(1);
}
`;

    fs.writeFileSync(tmpFile, wrappedCode, 'utf-8');

    const child = execFile('node', ['--no-warnings', tmpFile], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'sandbox' }
    }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      if (error) {
        resolve({
          success: false,
          error: error.message,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          killed: error.killed || false
        });
      } else {
        resolve({
          success: true,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      }
    });
  });
}

function testFile(filePath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile('node', ['--no-warnings', '-c', filePath], {
      timeout: timeoutMs
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ valid: false, error: stderr.trim() });
      } else {
        resolve({ valid: true });
      }
    });
  });
}

module.exports = { runInSandbox, testFile };
