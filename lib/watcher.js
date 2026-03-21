'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function startWatcher(rootDir, options = {}) {
  const emitter = new EventEmitter();
  const ignore = options.ignore || ['node_modules', '.git', 'brain', 'ui'];
  const debounceMs = options.debounce || 500;

  let debounceTimer = null;
  let pendingFile = null;

  function shouldIgnore(filePath) {
    const rel = path.relative(rootDir, filePath);
    return ignore.some(dir => rel.startsWith(dir + path.sep) || rel === dir);
  }

  function isWatchable(filename) {
    return filename && (filename.endsWith('.js') || filename.endsWith('.json'));
  }

  try {
    const watcher = fs.watch(rootDir, { recursive: true }, (event, filename) => {
      if (!filename || !isWatchable(filename)) return;

      const fullPath = path.join(rootDir, filename);
      if (shouldIgnore(fullPath)) return;

      // summary.json files are generated, not source changes
      if (filename.endsWith('.summary.json')) return;

      pendingFile = filename;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        emitter.emit('change', { file: pendingFile, event });
        pendingFile = null;
      }, debounceMs);
    });

    watcher.on('error', (err) => {
      emitter.emit('error', err);
    });

    emitter.close = () => watcher.close();
  } catch (err) {
    // Fallback: watch specific directories individually
    const dirs = ['core', 'lib', 'explorers', 'config'].map(d => path.join(rootDir, d)).filter(d => {
      try { return fs.statSync(d).isDirectory(); } catch { return false; }
    });
    dirs.push(rootDir); // watch root for main.js

    const watchers = [];
    for (const dir of dirs) {
      try {
        const w = fs.watch(dir, (event, filename) => {
          if (!filename || !isWatchable(filename)) return;
          if (filename.endsWith('.summary.json')) return;
          pendingFile = path.join(path.relative(rootDir, dir), filename);
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            emitter.emit('change', { file: pendingFile, event });
            pendingFile = null;
          }, debounceMs);
        });
        watchers.push(w);
      } catch {}
    }

    emitter.close = () => watchers.forEach(w => w.close());
  }

  return emitter;
}

module.exports = { startWatcher };
