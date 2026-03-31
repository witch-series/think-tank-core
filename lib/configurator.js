'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./file-utils');

const ensureConfig = (configPath) => {
  if (fs.existsSync(configPath)) return false;

  const defaultPath = configPath.replace(/settings\.json$/, 'settings.default.json');
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`Neither ${configPath} nor ${defaultPath} found`);
  }

  ensureDir(path.dirname(configPath));
  fs.copyFileSync(defaultPath, configPath);
  return true;
}

const loadConfig = (configPath) => {
  const created = ensureConfig(configPath);
  if (created) {
    console.log(`Created ${configPath} from default. Edit it to match your environment.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

const validateCode = (code) => {
  const issues = [];

  // Critical: code execution via string evaluation
  if (/eval\s*\(/.test(code)) {
    issues.push({ type: 'security', message: 'eval() usage detected', severity: 'critical' });
  }
  if (/new\s+Function\s*\(/.test(code)) {
    issues.push({ type: 'security', message: 'new Function() usage detected', severity: 'critical' });
  }
  if (/vm\s*\.\s*(runInNewContext|compileFunction|Script)/.test(code)) {
    issues.push({ type: 'security', message: 'vm code execution detected', severity: 'critical' });
  }

  // Critical: process spawning
  if (/child_process/.test(code)) {
    issues.push({ type: 'security', message: 'child_process usage detected', severity: 'critical' });
  }
  if (/\.exec\s*\(/.test(code) && /require/.test(code)) {
    issues.push({ type: 'security', message: 'exec() call detected', severity: 'critical' });
  }

  // Critical: network exfiltration patterns
  if (/https?:\/\//.test(code) && /(\.write|\.send|\.post|fetch)\s*\(/.test(code)) {
    issues.push({ type: 'security', message: 'Potential data exfiltration (HTTP write/send)', severity: 'critical' });
  }

  // Warning: process manipulation
  if (/process\.exit/.test(code)) {
    issues.push({ type: 'safety', message: 'process.exit() call detected', severity: 'warning' });
  }
  if (/process\.env/.test(code)) {
    issues.push({ type: 'safety', message: 'process.env access detected', severity: 'warning' });
  }

  // Warning: filesystem operations outside safe paths
  if (/fs\.\s*(unlink|rmdir|rm)Sync?\s*\(/.test(code)) {
    issues.push({ type: 'safety', message: 'File deletion operation detected', severity: 'warning' });
  }

  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 200) {
      issues.push({ type: 'style', message: `Line ${i + 1} exceeds 200 characters`, severity: 'info' });
    }
  }

  return {
    valid: !issues.some(i => i.severity === 'critical'),
    issues
  };
}

const formatMetadata = (filePath) => {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    extension: path.extname(filePath)
  };
}

module.exports = { ensureConfig, loadConfig, validateCode, formatMetadata };
