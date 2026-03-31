'use strict';

const express = require('express');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');

const PORT = process.env.UI_PORT || 2510;
const API_PORT = process.env.API_PORT || 2500;
const API_URL = process.env.API_URL || '';
const WHISPER_PORT = parseInt(process.env.WHISPER_PORT || '8300', 10);
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'auto';

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api-url', (req, res) => {
  if (API_URL) {
    res.json({ url: API_URL });
  } else {
    const host = req.hostname;
    const protocol = req.protocol;
    res.json({ url: `${protocol}://${host}:${API_PORT}` });
  }
});

// --- Whisper STT proxy ---
app.post('/transcribe', (req, res) => {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: WHISPER_PORT,
    path: '/transcribe',
    method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'],
      'Content-Length': req.headers['content-length']
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.status(503).json({ error: 'Whisper STT service unavailable. Is faster-whisper installed?' });
  });

  req.pipe(proxyReq);
});

app.get('/whisper-status', (req, res) => {
  const healthReq = http.request({
    hostname: '127.0.0.1',
    port: WHISPER_PORT,
    path: '/health',
    method: 'GET',
    timeout: 2000
  }, (healthRes) => {
    let body = '';
    healthRes.on('data', c => body += c);
    healthRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        res.json({ available: true, model: data.model || 'unknown' });
      } catch {
        res.json({ available: true });
      }
    });
  });
  healthReq.on('error', () => {
    res.json({ available: false });
  });
  healthReq.on('timeout', () => {
    healthReq.destroy();
    res.json({ available: false });
  });
  healthReq.end();
});

app.post('/whisper-reload', express.json(), (req, res) => {
  const model = req.body.model || 'base';
  const postData = JSON.stringify({ model });
  const reloadReq = http.request({
    hostname: '127.0.0.1',
    port: WHISPER_PORT,
    path: '/reload',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 120000 // model loading can be slow
  }, (reloadRes) => {
    let body = '';
    reloadRes.on('data', c => body += c);
    reloadRes.on('end', () => {
      try {
        res.json(JSON.parse(body));
      } catch {
        res.json({ ok: false, error: 'Invalid response' });
      }
    });
  });
  reloadReq.on('error', () => {
    res.status(503).json({ ok: false, error: 'Whisper service unavailable' });
  });
  reloadReq.on('timeout', () => {
    reloadReq.destroy();
    res.status(504).json({ ok: false, error: 'Model reload timed out' });
  });
  reloadReq.write(postData);
  reloadReq.end();
});

// --- Python & faster-whisper setup ---

function findPython() {
  const candidates = ['python', 'python3'];
  for (const cmd of candidates) {
    try {
      const ver = execFileSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
      console.log(`[setup] Found ${cmd}: ${ver}`);
      return cmd;
    } catch {}
  }
  return null;
}

function hasFasterWhisper(pythonCmd) {
  try {
    execFileSync(pythonCmd, ['-c', 'import faster_whisper'], { timeout: 10000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installFasterWhisper(pythonCmd) {
  console.log('[setup] Installing faster-whisper (this may take a few minutes on first run)...');
  try {
    execFileSync(pythonCmd, ['-m', 'pip', 'install', 'faster-whisper'], {
      stdio: 'inherit',
      timeout: 300000 // 5 minutes max
    });
    console.log('[setup] faster-whisper installed successfully.');
    return true;
  } catch (e) {
    console.error('[setup] Failed to install faster-whisper:', e.message);
    return false;
  }
}

// --- Start whisper subprocess ---
let whisperProcess = null;

function startWhisper() {
  const pythonCmd = findPython();
  if (!pythonCmd) {
    console.log('[whisper] Python not found. Voice input (STT) will be unavailable.');
    console.log('[whisper] Install Python 3.8+ to enable voice input.');
    return;
  }

  if (!hasFasterWhisper(pythonCmd)) {
    console.log('[whisper] faster-whisper not found. Starting auto-install...');
    if (!installFasterWhisper(pythonCmd)) {
      console.log('[whisper] Auto-install failed. Voice input will be unavailable.');
      console.log('[whisper] You can manually install: ' + pythonCmd + ' -m pip install faster-whisper');
      return;
    }
  } else {
    console.log('[whisper] faster-whisper is already installed.');
  }

  const scriptPath = path.join(__dirname, 'whisper-server.py');
  console.log(`[whisper] Starting whisper-server.py with ${pythonCmd}...`);

  const proc = spawn(pythonCmd, [scriptPath], {
    env: {
      ...process.env,
      WHISPER_PORT: String(WHISPER_PORT),
      WHISPER_MODEL: WHISPER_MODEL,
      WHISPER_DEVICE: WHISPER_DEVICE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  whisperProcess = proc;

  proc.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[whisper] ${msg}`);
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[whisper:err] ${msg}`);
  });

  proc.on('error', (err) => {
    console.error('[whisper] Failed to start process:', err.message);
    whisperProcess = null;
  });

  proc.on('exit', (code) => {
    console.log(`[whisper] Process exited with code ${code}`);
    whisperProcess = null;
  });
}

// --- Startup ---

// Ensure UI node_modules are installed
function ensureNodeModules() {
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(path.join(nodeModulesPath, 'express'))) {
    console.log('[setup] Installing UI dependencies (npm install)...');
    try {
      execSync('npm install', { cwd: __dirname, stdio: 'inherit', timeout: 60000 });
      console.log('[setup] UI dependencies installed.');
    } catch (e) {
      console.error('[setup] npm install failed:', e.message);
      process.exit(1);
    }
  }
}

ensureNodeModules();

app.listen(PORT, () => {
  console.log(`Think Tank UI running at http://localhost:${PORT}`);
  console.log(`API target: ${API_URL || `http://localhost:${API_PORT}`}`);
  startWhisper();
});

// Cleanup on exit
process.on('exit', () => {
  if (whisperProcess) whisperProcess.kill();
});
process.on('SIGINT', () => {
  if (whisperProcess) whisperProcess.kill();
  process.exit();
});
process.on('SIGTERM', () => {
  if (whisperProcess) whisperProcess.kill();
  process.exit();
});
