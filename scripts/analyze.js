'use strict';

/**
 * One-shot code analysis script.
 * Runs the two-stage JavaScript Analyzer on the project codebase.
 *
 * Usage:
 *   node scripts/analyze.js [--static] [folder1] [folder2] ...
 *   (defaults to: core lib explorers)
 *
 * Options:
 *   --static   Skip LLM analysis, run formatting + static analysis only
 */

const fs = require('fs');
const path = require('path');
const { OllamaClient } = require('../lib/ollama-client');
const { loadConfig } = require('../lib/configurator');
const { scanDirectory, analyzeFile } = require('../lib/analyzer');
const { formatCode } = require('../core/analyze/formatter');
const { analyzeUnits } = require('../core/analyze/unit-analyzer');
const { analyzeStructure, saveSummary } = require('../core/analyze/structural-analyzer');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');

const log = (level, msg) => {
  if (level !== 'debug') console.log(`[${level}] ${msg}`);
};

async function checkOllamaConnection(client) {
  try {
    const http = require('http');
    const url = new URL(client.url);
    return new Promise((resolve) => {
      const req = http.get(`${client.url}/api/tags`, { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  } catch {
    return false;
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const staticOnly = rawArgs.includes('--static');
  const folderArgs = rawArgs.filter(a => a !== '--static');

  // Determine folders to analyze
  const folders = folderArgs.length > 0
    ? folderArgs.map(f => path.resolve(ROOT, f))
    : ['core', 'lib', 'explorers'].map(f => path.join(ROOT, f));

  // Ensure analyze-result/ output directory exists
  const analyzeDir = path.join(ROOT, 'analyze-result');
  if (!fs.existsSync(analyzeDir)) fs.mkdirSync(analyzeDir, { recursive: true });

  // Set up LLM client (unless static-only)
  let client = null;
  let useLLM = !staticOnly;

  if (useLLM) {
    try {
      const config = loadConfig(CONFIG_PATH);
      client = new OllamaClient(config.ollama);
      const connected = await checkOllamaConnection(client);
      if (!connected) {
        console.log('Ollama not available — falling back to static analysis only.\n');
        useLLM = false;
      }
    } catch (err) {
      console.log(`Config not found (${err.message}) — running static analysis only.\n`);
      useLLM = false;
    }
  }

  if (staticOnly) {
    console.log('Running in static-only mode (no LLM).\n');
  }

  // Collect all .js files
  const allFiles = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) {
      console.log(`Skipping (not found): ${folder}`);
      continue;
    }
    allFiles.push(...scanDirectory(folder, '.js'));
  }

  console.log(`Found ${allFiles.length} JavaScript files to analyze.\n`);

  let analyzed = 0;
  let formatted = 0;
  let errors = 0;

  for (const filePath of allFiles) {
    const rel = path.relative(ROOT, filePath);
    process.stdout.write(`[${analyzed + 1}/${allFiles.length}] ${rel}...`);

    try {
      // Step 1: Format
      const code = fs.readFileSync(filePath, 'utf-8');
      const formatResult = formatCode(code);
      if (formatResult.success && formatResult.changes.length > 0) {
        fs.writeFileSync(filePath, formatResult.code, 'utf-8');
        formatted++;
        process.stdout.write(` formatted(${formatResult.changes.length})`);
      }

      if (useLLM) {
        // Step 2: Unit Analysis (LLM)
        const unitResults = await analyzeUnits(client, filePath, log);
        process.stdout.write(` units(${unitResults.length})`);

        // Step 3: Structural Analysis (LLM)
        const summary = await analyzeStructure(client, filePath, unitResults, log);

        // Step 4: Save
        const outputPath = saveSummary(ROOT, filePath, summary);
        analyzed++;
        console.log(` → ${path.relative(ROOT, outputPath)}`);
      } else {
        // Static-only: use analyzeFile for basic summary
        const staticResult = analyzeFile(filePath);
        const summary = {
          file: filePath,
          analyzedAt: new Date().toISOString(),
          lines: staticResult.lines,
          role: '',
          requires: staticResult.requires,
          exports: staticResult.exports,
          functions: staticResult.functions.map(f => ({
            name: f.name,
            params: f.params,
            purpose: '',
            inputs: {},
            returns: '',
            sideEffects: [],
            calls: [],
            errorHandling: false,
            security: { valid: true, issues: [] }
          })),
          structure: {
            dependencyHealth: 'unknown',
            issues: [],
            refactorSuggestions: []
          }
        };

        const outputPath = saveSummary(ROOT, filePath, summary);
        analyzed++;
        console.log(` → ${path.relative(ROOT, outputPath)}`);
      }

    } catch (err) {
      errors++;
      console.log(` ERROR: ${err.message}`);
    }
  }

  console.log(`\nDone. Analyzed: ${analyzed}, Formatted: ${formatted}, Errors: ${errors}`);
  console.log(`Mode: ${useLLM ? 'LLM + static' : 'static only'}`);
  console.log(`Results saved to: ${path.relative(ROOT, analyzeDir)}/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
