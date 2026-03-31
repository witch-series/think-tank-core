'use strict';

const fs = require('fs');
const path = require('path');
const { saveJsonFile } = require('./file-utils');

function extractFunctions(code) {
  const functions = [];
  const patterns = [
    /function\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    /(\w+)\s*[:=]\s*(?:async\s+)?function\s*\(([^)]*)\)\s*\{/g,
    /(\w+)\s*[:=]\s*(?:async\s+)?\(([^)]*)\)\s*=>/g,
    /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const name = match[1];
      if (!functions.find(f => f.name === name) && !['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
        functions.push({ name, params: match[2] ? match[2].trim() : '', index: match.index });
      }
    }
  }

  functions.sort((a, b) => a.index - b.index);
  return functions;
}

const extractFunctionBody = (code, funcIndex, allFunctions, currentIdx) => {
  const nextStart = currentIdx + 1 < allFunctions.length ? allFunctions[currentIdx + 1].index : code.length;
  return code.slice(funcIndex, Math.min(funcIndex + 3000, nextStart)).trim();
}

const analyzeFile = (filePath) => {
  const code = fs.readFileSync(filePath, 'utf-8');
  const lines = code.split('\n');
  const functions = extractFunctions(code);

  const requires = [];
  for (const line of lines) {
    const reqMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (reqMatch) requires.push(reqMatch[1]);
  }

  const exports = [];
  const exportMatch = code.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (exportMatch) {
    exports.push(...exportMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean));
  }

  return {
    file: filePath,
    lines: lines.length,
    functions: functions.map(f => ({ name: f.name, params: f.params })),
    requires,
    exports,
    analyzedAt: new Date().toISOString()
  };
}

const scanDirectory = (dirPath, extension = '.js') => {
  const results = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.endsWith('.summary.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

const generateSummary = (filePath, functionSummaries) => {
  const analysis = analyzeFile(filePath);
  if (functionSummaries) {
    analysis.functions = analysis.functions.map(f => {
      const llmSummary = functionSummaries.find(s => s.name === f.name);
      return llmSummary ? { ...f, description: llmSummary.description } : f;
    });
  }
  const summaryPath = filePath.replace(/\.js$/, '.summary.md');
  saveJsonFile(summaryPath, analysis);
  return analysis;
}

const analyzeFolder = (folderPath) => {
  const files = scanDirectory(folderPath);
  const summaries = [];
  for (const file of files) {
    summaries.push(generateSummary(file));
  }
  return summaries;
}

const summarizeFunctionsWithLLM = async (client, filePath) => {
  const code = fs.readFileSync(filePath, 'utf-8');
  const functions = extractFunctions(code);

  if (functions.length === 0) return [];

  const summaries = [];
  for (let i = 0; i < functions.length; i++) {
    const func = functions[i];
    const body = extractFunctionBody(code, func.index, functions, i);

    try {
      const response = await client.query(
        `以下の関数を1-2文で簡潔に要約してください。関数名: ${func.name}\n\n\`\`\`javascript\n${body}\n\`\`\``,
        'コードアナリストとして、関数の目的と処理内容を日本語で簡潔に要約してください。');

      summaries.push({
        name: func.name,
        params: func.params,
        description: response.response.trim()
      });
    } catch {
      summaries.push({ name: func.name, params: func.params, description: '' });
    }
  }

  return summaries;
}

const analyzeFolderWithLLM = async (client, folderPath) => {
  const files = scanDirectory(folderPath);
  const summaries = [];
  for (const file of files) {
    const funcSummaries = await summarizeFunctionsWithLLM(client, file);
    summaries.push(generateSummary(file, funcSummaries));
  }
  return summaries;
}

module.exports = {
  analyzeFile, scanDirectory, generateSummary, analyzeFolder,
  extractFunctions, extractFunctionBody,
  summarizeFunctionsWithLLM, analyzeFolderWithLLM
};
