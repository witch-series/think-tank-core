// ------------------------------------------------------------
//  sandbox.js (refactored version)
// ------------------------------------------------------------

'use strict';

const vm = require('vm');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');

/**
 * Executes arbitrary JavaScript code inside a sandboxed VM context.
 * The sandbox captures console.log/error output and enforces a timeout.
 *
 * @param {string} code - The user supplied code to execute.
 * @param {number} timeoutMs - Maximum execution time in milliseconds.
 * @returns {Promise<Object>} Result object with `success`, `stdout`, `stderr`, and `error` fields.
 */
async function runInSandbox(code, timeoutMs = 10_000) {
  // Prepare a temporary directory for optional debugging (kept for parity with the original API).
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  const tmpFile = path.join(tmpDir, 'script.js');

  // Wrap the user code to capture console output without calling process.exit.
  const wrappedCode = `
${code}
`;

  // Write the file for debugging/verification purposes; it will be removed after execution.
  await fs.writeFile(tmpFile, wrappedCode, 'utf8');

  // Build a very small sandboxed global object.
  const sandbox = {
    console: {
      _stdout: [],
      _stderr: [],
      log: (...args) => sandbox.console._stdout.push(args.join(' ')),
      error: (...args) => sandbox.console._stderr.push(args.join(' ')),
    },
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name: path.basename(tmpFile),
  });

  const script = new vm.Script(wrappedCode, { filename: tmpFile });

  const result = {
    success: false,
    stdout: '',
    stderr: '',
    error: null,
  };

  const timer = setTimeout(() => {
    result.error = 'Execution timed out';
    resolve(result);
  }, timeoutMs);

  try {
    // `runInContext` accepts an options object with a `timeout` property (in ms).
    script.runInContext(context, { timeout: timeoutMs });
    clearTimeout(timer);
    result.success = true;
  } catch (e) {
    clearTimeout(timer);
    result.error = e.message;
    result.stderr = e.stack || '';
  }

  result.stdout = sandbox.console._stdout.join('\n');
  result.stderr += sandbox.console._stderr.join('\n');

  // Clean up the temporary file and directory.
  try {
    await fs.unlink(tmpFile);
    await fs.rmdir(tmpDir);
  } catch (_) {
    // ignore cleanup errors
  }

  return result;
}

/**
 * Validates a JavaScript file by checking syntax with Node's `-c` flag.
 * Does not execute the file.
 *
 * @param {string} filePath - Path to the JavaScript file.
 * @param {number} timeoutMs - Maximum time to wait for the check.
 * @returns {Promise<Object>} Object containing `valid` and optional `error`.
 */
async function testFile(filePath, timeoutMs = 10_000) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('node', ['--no-warnings', '-c', filePath], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ valid: false, error: stderr.trim() });
      } else {
        resolve({ valid: true });
      }
    });
  });
}

module.exports = { runInSandbox, testFile };
