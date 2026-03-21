'use strict';

const fs = require('fs');
const path = require('path');

function ensureConfig(configPath) {
  if (fs.existsSync(configPath)) return false;

  const defaultPath = configPath.replace(/settings\.json$/, 'settings.default.json');
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`Neither ${configPath} nor ${defaultPath} found`);
  }

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.copyFileSync(defaultPath, configPath);
  return true;
}

function loadConfig(configPath) {
  const created = ensureConfig(configPath);
  if (created) {
    console.log(`Created ${configPath} from default. Edit it to match your environment.`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function validateCode(code) {
  const issues = [];

  if (/eval\s*\(/.test(code)) {
    issues.push({ type: 'security', message: 'eval() usage detected', severity: 'critical' });
  }
  if (/new\s+Function\s*\(/.test(code)) {
    issues.push({ type: 'security', message: 'new Function() usage detected', severity: 'critical' });
  }
  if (/child_process/.test(code) && !/require\s*\(\s*['"]child_process['"]\s*\)/.test(code)) {
    issues.push({ type: 'security', message: 'Suspicious child_process reference', severity: 'warning' });
  }
  if (/process\.exit/.test(code)) {
    issues.push({ type: 'safety', message: 'process.exit() call detected', severity: 'warning' });
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

function formatMetadata(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    extension: path.extname(filePath)
  };
}

module.exports = { ensureConfig, loadConfig, validateCode, formatMetadata };
