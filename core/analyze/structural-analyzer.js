'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeFile } = require('../../lib/analyzer');
const { fillPrompt } = require('../../lib/prompt-loader');
const { parseJsonSafe } = require('../../lib/json-parser');

/**
 * Structural Analyzer: analyzes file-level structure using unit analysis results.
 */

/**
 * Perform structural analysis on a file.
 *
 * @param {object} client - OllamaClient instance
 * @param {string} filePath - Path to the .js file
 * @param {Array} unitResults - Results from unit-analyzer
 * @param {function} [log] - Optional logger function(level, message)
 * @returns {Promise<object>} Complete analysis summary
 */
const analyzeStructure = async (client, filePath, unitResults, log) => {
  const staticAnalysis = analyzeFile(filePath);

  // Build function summaries text for the prompt
  const functionSummaries = unitResults.map(f =>
    `- ${f.name}(${f.params}): ${f.purpose || '(no description)'}`
  ).join('\n');

  let structureResult = {
    role: '',
    dependencyHealth: 'good',
    issues: [],
    refactorSuggestions: []
  };

  try {
    const systemPrompt = fillPrompt('analyze-struct.system', {});
    const userPrompt = fillPrompt('analyze-struct.user', {
      filePath,
      lineCount: String(staticAnalysis.lines),
      requires: JSON.stringify(staticAnalysis.requires),
      exports: JSON.stringify(staticAnalysis.exports),
      functionSummaries: functionSummaries || '(no functions)'
    });

    const response = await client.query(userPrompt, systemPrompt, {
      json: true,
      priority: false
    });

    const text = (response.response || '').trim();
    const parsed = parseJsonSafe(text);

    if (parsed) {
      structureResult = {
        role: parsed.role || '',
        dependencyHealth: parsed.dependencyHealth || 'good',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        refactorSuggestions: Array.isArray(parsed.refactorSuggestions) ? parsed.refactorSuggestions : []
      };
    }

    if (log) log('debug', `Structural analysis complete: ${filePath}`);
  } catch (err) {
    if (log) log('warn', `Structural analysis failed for ${filePath}: ${err.message}`);
  }

  // Compose the full summary
  const summary = {
    file: filePath,
    analyzedAt: new Date().toISOString(),
    lines: staticAnalysis.lines,
    role: structureResult.role,
    requires: staticAnalysis.requires,
    exports: staticAnalysis.exports,
    functions: unitResults,
    structure: {
      dependencyHealth: structureResult.dependencyHealth,
      issues: structureResult.issues,
      refactorSuggestions: structureResult.refactorSuggestions
    }
  };

  return summary;
}

/**
 * Convert a summary object to human-readable Markdown.
 * Embeds the raw JSON in an HTML comment for machine parsing.
 */
const summaryToMarkdown = (summary, relativeFile) => {
  const lines = [];

  // Hidden JSON block for machine parsing
  lines.push(`<!-- @analysis-data`);
  lines.push(JSON.stringify(summary));
  lines.push(`-->`);
  lines.push('');

  // Header
  lines.push(`# ${relativeFile}`);
  lines.push('');
  lines.push(`| 項目 | 値 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 解析日時 | ${summary.analyzedAt} |`);
  lines.push(`| 行数 | ${summary.lines} |`);
  if (summary.role) {
    lines.push(`| 役割 | ${summary.role} |`);
  }
  if (summary.structure?.dependencyHealth) {
    lines.push(`| 依存健全性 | ${summary.structure.dependencyHealth} |`);
  }
  lines.push('');

  // Dependencies
  if (summary.requires?.length > 0) {
    lines.push(`## require`);
    lines.push('');
    for (const r of summary.requires) {
      lines.push(`- \`${r}\``);
    }
    lines.push('');
  }

  if (summary.exports?.length > 0) {
    lines.push(`## exports`);
    lines.push('');
    for (const e of summary.exports) {
      lines.push(`- \`${e}\``);
    }
    lines.push('');
  }

  // Functions
  if (summary.functions?.length > 0) {
    lines.push(`## 関数一覧`);
    lines.push('');
    for (const f of summary.functions) {
      lines.push(`### \`${f.name}(${f.params || ''})\``);
      lines.push('');
      if (f.purpose) lines.push(`${f.purpose}`);
      if (f.purpose) lines.push('');

      const details = [];
      if (f.inputs && Object.keys(f.inputs).length > 0) {
        details.push(`- **入力**: ${Object.entries(f.inputs).map(([k, v]) => `\`${k}\` — ${v}`).join(', ')}`);
      }
      if (f.returns) details.push(`- **戻り値**: ${f.returns}`);
      if (f.sideEffects?.length > 0) details.push(`- **副作用**: ${f.sideEffects.join(', ')}`);
      if (f.calls?.length > 0) details.push(`- **呼び出し**: ${f.calls.map(c => `\`${c}\``).join(', ')}`);
      details.push(`- **エラーハンドリング**: ${f.errorHandling ? 'あり' : 'なし'}`);

      if (f.security && !f.security.valid) {
        details.push(`- **セキュリティ問題**: ${f.security.issues.join(', ')}`);
      }

      if (details.length > 0) {
        lines.push(...details);
        lines.push('');
      }
    }
  }

  // Structure issues
  if (summary.structure?.issues?.length > 0) {
    lines.push(`## 問題点`);
    lines.push('');
    for (const issue of summary.structure.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (summary.structure?.refactorSuggestions?.length > 0) {
    lines.push(`## リファクタリング提案`);
    lines.push('');
    for (const sug of summary.structure.refactorSuggestions) {
      lines.push(`- ${sug}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Extract the embedded JSON data from a summary Markdown file.
 */
const parseSummaryMarkdown = (mdContent) => {
  const match = mdContent.match(/<!-- @analysis-data\n([\s\S]*?)\n-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Save a summary to the analyze-result/ output directory as Markdown.
 * Mirrors the source directory structure.
 *
 * @param {string} rootDir - Project root directory
 * @param {string} filePath - Original source file path
 * @param {object} summary - Analysis summary object
 */
const saveSummary = (rootDir, filePath, summary) => {
  const relative = path.relative(rootDir, filePath);
  const summaryName = relative.replace(/\.js$/, '.summary.md');
  const outputPath = path.join(rootDir, 'analyze-result', summaryName);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const markdown = summaryToMarkdown(summary, relative);
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  return outputPath;
}

/**
 * Load existing summary if it exists and is newer than the source file.
 *
 * @param {string} rootDir - Project root directory
 * @param {string} filePath - Source file path
 * @returns {object|null} Existing summary or null if stale/missing
 */
const loadExistingSummary = (rootDir, filePath) => {
  const relative = path.relative(rootDir, filePath);
  const summaryName = relative.replace(/\.js$/, '.summary.md');
  const outputPath = path.join(rootDir, 'analyze-result', summaryName);

  try {
    if (!fs.existsSync(outputPath)) return null;

    const sourceStat = fs.statSync(filePath);
    const summaryStat = fs.statSync(outputPath);

    // Summary is stale if source is newer
    if (sourceStat.mtimeMs > summaryStat.mtimeMs) return null;

    const content = fs.readFileSync(outputPath, 'utf-8');
    return parseSummaryMarkdown(content);
  } catch {
    return null;
  }
}

module.exports = { analyzeStructure, saveSummary, loadExistingSummary, summaryToMarkdown, parseSummaryMarkdown };
