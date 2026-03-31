'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { scanDirectory } = require('../../lib/analyzer');
const { startWatcher } = require('../../lib/watcher');
const { formatCode } = require('./formatter');
const { analyzeUnits } = require('./unit-analyzer');
const { analyzeStructure, saveSummary, loadExistingSummary, parseSummaryMarkdown } = require('./structural-analyzer');

const REPAIR_LIST_PATH_REL = 'analyze-result/repair-list.json';
const MAX_REPAIR_RETRIES = 3;
const DAILY_HOUR = 5; // 05:00 for daily learning data generation

/**
 * AnalyzeLoop: autonomous code analysis system.
 *
 * Watches directories for changes, auto-formats, runs two-stage analysis,
 * and generates daily learning data.
 *
 * Events:
 *   'analyzed' - { file, summary } when a file is analyzed
 *   'formatted' - { file, changes } when a file is formatted
 *   'error' - { file, error } on analysis errors
 *   'daily' - { summaries } when daily learning data is generated
 */
class AnalyzeLoop extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.client - OllamaClient instance
   * @param {string} options.rootDir - Project root directory
   * @param {function} [options.log] - Logger function(level, message)
   * @param {boolean} [options.autoFormat] - Enable auto-formatting (default: true)
   */
  constructor(options) {
    super();
    this.client = options.client;
    this.rootDir = options.rootDir;
    this.log = options.log || (() => {});
    this.autoFormat = options.autoFormat !== false;

    this._queue = [];
    this._processing = false;
    this._watcher = null;
    this._dailyTimer = null;
    this._stopped = false;

    // Watch directories (relative to rootDir)
    this._watchDirs = ['core', 'lib', 'explorers'];
    // Also watch brain/modules if it exists
    const modulesDir = path.join(this.rootDir, 'brain', 'modules');
    if (fs.existsSync(modulesDir)) {
      this._watchDirs.push(path.join('brain', 'modules'));
    }
  }

  /**
   * Start the analyze loop: initial scan + file watching + daily schedule.
   */
  async start() {
    this._stopped = false;
    this.log('info', 'AnalyzeLoop starting...');

    // Initial scan: find files needing analysis
    await this._initialScan();

    // Start file watcher
    this._startWatcher();

    // Schedule daily learning data generation
    this._scheduleDailyRun();

    // Start processing queue
    this._processNext();

    this.log('info', `AnalyzeLoop started. Queue: ${this._queue.length} files`);
  }

  /**
   * Stop the analyze loop.
   */
  stop() {
    this._stopped = true;
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._dailyTimer) {
      clearTimeout(this._dailyTimer);
      this._dailyTimer = null;
    }
    this._queue = [];
    this.log('info', 'AnalyzeLoop stopped');
  }

  /**
   * Scan all watched directories for files needing analysis.
   */
  async _initialScan() {
    for (const dir of this._watchDirs) {
      const fullDir = path.join(this.rootDir, dir);
      if (!fs.existsSync(fullDir)) continue;

      const files = scanDirectory(fullDir, '.js');
      for (const file of files) {
        // Skip if summary exists and is fresh
        const existing = loadExistingSummary(this.rootDir, file);
        if (!existing) {
          this._enqueue(file);
        }
      }
    }
  }

  /**
   * Start watching for file changes.
   */
  _startWatcher() {
    this._watcher = startWatcher(this.rootDir, {
      ignore: ['node_modules', '.git', 'brain', 'ui', 'analyze-result', 'docs'],
      debounce: 1000
    });

    this._watcher.on('change', ({ file }) => {
      if (!file.endsWith('.js')) return;
      if (file.endsWith('.summary.md')) return;

      const fullPath = path.join(this.rootDir, file);
      this.log('debug', `File changed: ${file}`);
      this._enqueue(fullPath);
    });

    this._watcher.on('error', (err) => {
      this.log('warn', `Watcher error: ${err.message}`);
    });

    // Also watch brain/modules separately if it exists
    const modulesDir = path.join(this.rootDir, 'brain', 'modules');
    if (fs.existsSync(modulesDir)) {
      try {
        const modulesWatcher = startWatcher(modulesDir, {
          ignore: [],
          debounce: 1000
        });
        modulesWatcher.on('change', ({ file }) => {
          if (!file.endsWith('.js')) return;
          const fullPath = path.join(modulesDir, file);
          this.log('debug', `Module changed: ${file}`);
          this._enqueue(fullPath);
        });
        // Store reference for cleanup
        const origClose = this._watcher.close.bind(this._watcher);
        this._watcher.close = () => {
          origClose();
          modulesWatcher.close();
        };
      } catch (err) {
        this.log('debug', `Could not watch brain/modules: ${err.message}`);
      }
    }
  }

  /**
   * Add a file to the analysis queue (deduplicating).
   */
  _enqueue(filePath) {
    if (this._stopped) return;
    if (this._queue.includes(filePath)) return;
    this._queue.push(filePath);
    this._processNext();
  }

  /**
   * Process the next file in the queue.
   */
  async _processNext() {
    if (this._processing || this._stopped || this._queue.length === 0) return;

    this._processing = true;
    const filePath = this._queue.shift();

    try {
      await this._analyzeFile(filePath);
    } catch (err) {
      this.log('warn', `Analysis failed for ${filePath}: ${err.message}`);
      this.emit('error', { file: filePath, error: err.message });
      this._addToRepairList(filePath, err.message);
    } finally {
      this._processing = false;
      if (this._queue.length > 0 && !this._stopped) {
        setImmediate(() => this._processNext());
      }
    }
  }

  /**
   * Full analysis pipeline for a single file: format → unit → structural → save.
   */
  async _analyzeFile(filePath) {
    if (!fs.existsSync(filePath)) return;

    this.log('info', `Analyzing: ${path.relative(this.rootDir, filePath)}`);

    // Step 1: Auto-format (if enabled)
    if (this.autoFormat) {
      try {
        const code = fs.readFileSync(filePath, 'utf-8');
        const formatResult = formatCode(code);

        if (formatResult.success && formatResult.changes.length > 0) {
          fs.writeFileSync(filePath, formatResult.code, 'utf-8');
          this.log('info', `Formatted ${path.relative(this.rootDir, filePath)}: ${formatResult.changes.length} changes`);
          this.emit('formatted', { file: filePath, changes: formatResult.changes });
        } else if (!formatResult.success) {
          this.log('warn', `Format failed for ${filePath}: ${formatResult.error}`);
          this._addToRepairList(filePath, formatResult.error);
          // Continue with analysis even if formatting fails
        }
      } catch (err) {
        this.log('warn', `Format error for ${filePath}: ${err.message}`);
      }
    }

    // Step 2: Unit Analysis
    const unitResults = await analyzeUnits(this.client, filePath, this.log);

    // Step 3: Structural Analysis
    const summary = await analyzeStructure(this.client, filePath, unitResults, this.log);

    // Step 4: Save summary
    const outputPath = saveSummary(this.rootDir, filePath, summary);
    this.log('info', `Summary saved: ${path.relative(this.rootDir, outputPath)}`);

    // Remove from repair list on success
    this._removeFromRepairList(filePath);

    this.emit('analyzed', { file: filePath, summary });
    return summary;
  }

  // --- Repair List ---

  _getRepairListPath() {
    return path.join(this.rootDir, REPAIR_LIST_PATH_REL);
  }

  _loadRepairList() {
    const listPath = this._getRepairListPath();
    try {
      if (fs.existsSync(listPath)) {
        return JSON.parse(fs.readFileSync(listPath, 'utf-8'));
      }
    } catch {}
    return { files: [] };
  }

  _saveRepairList(list) {
    const listPath = this._getRepairListPath();
    const dir = path.dirname(listPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(listPath, JSON.stringify(list, null, 2), 'utf-8');
  }

  _addToRepairList(filePath, error) {
    const list = this._loadRepairList();
    const existing = list.files.find(f => f.path === filePath);
    if (existing) {
      existing.error = error;
      existing.failedAt = new Date().toISOString();
    } else {
      list.files.push({
        path: filePath,
        error,
        failedAt: new Date().toISOString(),
        retryCount: 0,
        lastRetry: null
      });
    }
    this._saveRepairList(list);
  }

  _removeFromRepairList(filePath) {
    const list = this._loadRepairList();
    const idx = list.files.findIndex(f => f.path === filePath);
    if (idx !== -1) {
      list.files.splice(idx, 1);
      this._saveRepairList(list);
    }
  }

  /**
   * Retry files in the repair list.
   */
  async _retryRepairList() {
    const list = this._loadRepairList();
    const toRetry = list.files.filter(f => f.retryCount < MAX_REPAIR_RETRIES);

    for (const entry of toRetry) {
      if (this._stopped) break;

      try {
        this.log('info', `Retrying repair: ${entry.path} (attempt ${entry.retryCount + 1})`);
        entry.retryCount++;
        entry.lastRetry = new Date().toISOString();

        // For files that failed formatting 3 times, skip formatting
        const origAutoFormat = this.autoFormat;
        if (entry.retryCount >= MAX_REPAIR_RETRIES) {
          this.autoFormat = false;
        }

        await this._analyzeFile(entry.path);

        this.autoFormat = origAutoFormat;
        // Success: _analyzeFile already removes from repair list
      } catch (err) {
        this.log('warn', `Repair retry failed for ${entry.path}: ${err.message}`);
        entry.error = err.message;
      }
    }

    this._saveRepairList(list);
  }

  // --- Daily Learning Data ---

  _scheduleDailyRun() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(DAILY_HOUR, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    this._dailyTimer = setTimeout(() => {
      this._runDailyLearning();
      // Reschedule for next day
      this._scheduleDailyRun();
    }, delay);

    this.log('debug', `Daily learning data scheduled for ${next.toISOString()}`);
  }

  /**
   * Generate daily learning data from all summaries.
   */
  async _runDailyLearning() {
    if (this._stopped) return;

    this.log('info', 'Running daily learning data generation...');

    try {
      // 1. Collect all summaries from analyze-result/
      const analyzeDir = path.join(this.rootDir, 'analyze-result');
      const summaries = this._collectSummaries(analyzeDir);

      if (summaries.length === 0) {
        this.log('info', 'No summaries found for daily learning');
        return;
      }

      // 2. Build dependency graph
      const depGraph = this._buildDependencyGraph(summaries);

      // 3. Generate learning data entry
      const learningEntry = {
        timestamp: new Date().toISOString(),
        type: 'code-analysis',
        totalFiles: summaries.length,
        totalFunctions: summaries.reduce((sum, s) => sum + (s.functions?.length || 0), 0),
        dependencyGraph: depGraph,
        issues: summaries.flatMap(s =>
          (s.structure?.issues || []).map(issue => ({
            file: s.file,
            issue
          }))
        ),
        refactorSuggestions: summaries.flatMap(s =>
          (s.structure?.refactorSuggestions || []).map(sug => ({
            file: s.file,
            suggestion: sug
          }))
        ),
        securityIssues: summaries.flatMap(s =>
          (s.functions || []).flatMap(f =>
            (f.security?.issues || []).map(issue => ({
              file: s.file,
              function: f.name,
              issue
            }))
          )
        )
      };

      // 4. Save to brain/analysis/ as JSONL
      const analysisDir = path.join(this.rootDir, 'brain', 'analysis');
      if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true });

      const dateStr = new Date().toISOString().slice(0, 10);
      const outputPath = path.join(analysisDir, `code-analysis-${dateStr}.jsonl`);
      fs.appendFileSync(outputPath, JSON.stringify(learningEntry) + '\n', 'utf-8');

      this.log('info', `Daily learning data saved: ${outputPath}`);
      this.emit('daily', { summaries: summaries.length, outputPath });

      // 5. Retry repair list
      await this._retryRepairList();

    } catch (err) {
      this.log('warn', `Daily learning data generation failed: ${err.message}`);
    }
  }

  /**
   * Collect all .summary.md files recursively from a directory.
   */
  _collectSummaries(dir) {
    const summaries = [];
    if (!fs.existsSync(dir)) return summaries;

    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.summary.md')) {
          try {
            const mdContent = fs.readFileSync(full, 'utf-8');
            const data = parseSummaryMarkdown(mdContent);
            if (data) summaries.push(data);
          } catch {}
        }
      }
    };

    walk(dir);
    return summaries;
  }

  /**
   * Build a simple dependency graph from summaries.
   */
  _buildDependencyGraph(summaries) {
    const graph = {};

    for (const summary of summaries) {
      const file = summary.file;
      graph[file] = {
        requires: summary.requires || [],
        exports: summary.exports || [],
        functionCount: (summary.functions || []).length,
        dependencyHealth: summary.structure?.dependencyHealth || 'unknown'
      };
    }

    return graph;
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      running: !this._stopped,
      queueLength: this._queue.length,
      processing: this._processing,
      repairList: this._loadRepairList().files.length
    };
  }
}

module.exports = { AnalyzeLoop };
