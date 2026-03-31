'use strict';

const vm = require('vm');
const { promises: fs } = require('fs');
const path = require('path');
const os = require('os');

/**
 * Validate JavaScript syntax without executing the code.
 * Uses vm.Script which throws SyntaxError for invalid code.
 *
 * @param {string} code - The JavaScript code to validate.
 * @returns {{valid: boolean, error?: string}}
 */
const validateSyntax = (code) => {
  try {
    new vm.Script(code, { filename: 'syntax-check.js' });
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Executes arbitrary JavaScript code inside a sandboxed VM context.
 * The sandbox captures console.log/error output and enforces a timeout.
 * Only standard Node.js built-in modules are available via require.
 *
 * @param {string} code - The user supplied code to execute.
 * @param {number} timeoutMs - Maximum execution time in milliseconds.
 * @returns {Promise<Object>} Result object with `success`, `stdout`, `stderr`, and `error` fields.
 */
const runInSandbox = async (code, timeoutMs = 10_000) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-'));
  const tmpFile = path.join(tmpDir, 'script.js');

  await fs.writeFile(tmpFile, code, 'utf8');

  // Only allow Node.js built-in modules
  // child_process is intentionally excluded — generated code must not spawn processes
  const allowedBuiltins = new Set([
    'fs', 'path', 'http', 'https', 'url', 'util', 'stream', 'os',
    'crypto', 'events', 'buffer', 'querystring', 'zlib'
  ]);

  const sandbox = {
    console: {
      _stdout: [],
      _stderr: [],
      log: (...args) => sandbox.console._stdout.push(args.join(' ')),
      error: (...args) => sandbox.console._stderr.push(args.join(' ')),
    },
    require: (moduleName) => {
      if (allowedBuiltins.has(moduleName)) return require(moduleName);
      throw new Error(`Module not allowed in sandbox: ${moduleName}`);
    },
    module: { exports: {} },
    exports: {},
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    Buffer,
    __filename: tmpFile,
    __dirname: tmpDir,
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name: path.basename(tmpFile),
  });

  const script = new vm.Script(code, { filename: tmpFile });

  const result = {
    success: false,
    stdout: '',
    stderr: '',
    error: null,
  };

  try {
    script.runInContext(context, { timeout: timeoutMs });
    result.success = true;
  } catch (e) {
    result.error = e.message;
    result.stderr = e.stack || '';
  }

  result.stdout = sandbox.console._stdout.join('\n');
  result.stderr += sandbox.console._stderr.join('\n');

  try {
    await fs.unlink(tmpFile);
    await fs.rmdir(tmpDir);
  } catch (_) {}

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
const testFile = async (filePath, timeoutMs = 10_000) => {
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

module.exports = { runInSandbox, validateSyntax, testFile };
