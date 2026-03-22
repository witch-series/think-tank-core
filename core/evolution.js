'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// OllamaClient is passed as parameter to all LLM-calling functions
const { validateCode } = require('../lib/configurator');
const { runInSandbox, validateSyntax, testFile } = require('../lib/sandbox');
const { loadPrompt, fillPrompt } = require('../lib/prompt-loader');

// --- Git helpers ---

function getRecentCommits(repoPath, hours = 24) {
  return new Promise((resolve) => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    execFile('git', ['log', `--since=${since}`, '--pretty=format:%H|%s|%ai', '--diff-filter=M'], {
      cwd: repoPath
    }, (error, stdout) => {
      if (error) { resolve([]); return; }
      const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, date] = line.split('|');
        return { hash, message, date };
      });
      resolve(commits);
    });
  });
}

function getLastCommit(repoPath) {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--pretty=format:%H|%s|%ai'], {
      cwd: repoPath
    }, (error, stdout) => {
      if (error || !stdout.trim()) { resolve(null); return; }
      const [hash, message, date] = stdout.trim().split('|');
      resolve({ hash, message, date });
    });
  });
}

function getDiff(repoPath, commitHash) {
  return new Promise((resolve) => {
    execFile('git', ['diff', `${commitHash}~1`, commitHash], {
      cwd: repoPath, maxBuffer: 1024 * 1024 * 5
    }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

// Patterns that must never appear in committed files
const SENSITIVE_PATTERNS = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,  // IPv4 addresses
  /\b[0-9a-fA-F]{4}(:[0-9a-fA-F]{4}){7}\b/,    // IPv6 addresses
  /password\s*[:=]\s*['"][^'"]+['"]/i,            // password literals
  /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i,         // API keys
  /secret\s*[:=]\s*['"][^'"]+['"]/i,              // secrets
  /token\s*[:=]\s*['"][^'"]+['"]/i,               // tokens
];

function containsSensitiveData(text) {
  const issues = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      issues.push({ pattern: pattern.source, matched: match[0] });
    }
  }
  return issues;
}

function autoCommit(repoPath, message, allowedPaths) {
  return new Promise((resolve) => {
    // Stage only specific paths instead of -A to prevent leaking config files
    const paths = allowedPaths || ['brain/modules'];
    const addArgs = ['add', '--', ...paths];

    execFile('git', addArgs, { cwd: repoPath }, (addErr) => {
      if (addErr) { resolve({ success: false, error: addErr.message }); return; }

      // Check staged diff for sensitive data
      execFile('git', ['diff', '--cached'], { cwd: repoPath, maxBuffer: 1024 * 1024 * 5 }, (diffErr, diffOut) => {
        if (diffErr && !diffOut) {
          resolve({ success: false, error: 'No changes to commit' });
          return;
        }

        const sensitiveIssues = containsSensitiveData(diffOut || '');
        if (sensitiveIssues.length > 0) {
          // Unstage and abort
          execFile('git', ['reset', 'HEAD', '--', ...paths], { cwd: repoPath }, () => {});
          resolve({
            success: false,
            error: `Commit blocked: sensitive data detected (${sensitiveIssues.map(i => i.pattern).join(', ')})`
          });
          return;
        }

        execFile('git', ['diff', '--cached', '--quiet'], { cwd: repoPath }, (quietErr) => {
          if (!quietErr) { resolve({ success: false, error: 'No changes to commit' }); return; }

          // Sanitize commit message
          const safeMessage = sanitizeText(message);

          execFile('git', ['commit', '-m', safeMessage], { cwd: repoPath }, (commitErr, stdout) => {
            if (commitErr) { resolve({ success: false, error: commitErr.message }); return; }
            resolve({ success: true, output: stdout.trim() });
          });
        });
      });
    });
  });
}

function sanitizeText(text) {
  // Remove IP addresses
  let safe = text.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '[REDACTED]');
  // Remove potential secrets
  safe = safe.replace(/(?:password|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]*['"]/gi, '[REDACTED]');
  return safe;
}

// --- Knowledge helpers ---

function getNewKnowledge(knowledgeDbPath, hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const entries = [];

  let files;
  try { files = fs.readdirSync(knowledgeDbPath).filter(f => f.endsWith('.jsonl')); }
  catch { return entries; }

  for (const file of files) {
    const lines = fs.readFileSync(path.join(knowledgeDbPath, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entry._category = file.replace('.jsonl', '');
        if (entry.timestamp && new Date(entry.timestamp).getTime() > since) entries.push(entry);
      } catch {}
    }
  }
  return entries;
}

/**
 * Get all knowledge entries from a directory (no time filter).
 */
function getAllKnowledge(knowledgeDbPath) {
  const entries = [];
  let files;
  try { files = fs.readdirSync(knowledgeDbPath).filter(f => f.endsWith('.jsonl')); }
  catch { return entries; }

  for (const file of files) {
    const lines = fs.readFileSync(path.join(knowledgeDbPath, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        entry._category = file.replace('.jsonl', '');
        entries.push(entry);
      } catch {}
    }
  }
  return entries;
}

function saveKnowledge(knowledgeDbPath, category, data) {
  if (!fs.existsSync(knowledgeDbPath)) fs.mkdirSync(knowledgeDbPath, { recursive: true });
  const filePath = path.join(knowledgeDbPath, `${category}.jsonl`);
  const entry = { ...data, timestamp: new Date().toISOString() };
  // Sanitize all string values to prevent sensitive data leakage
  const safeJson = sanitizeText(JSON.stringify(entry));
  fs.appendFileSync(filePath, safeJson + '\n', 'utf-8');
  return JSON.parse(safeJson);
}

// --- Knowledge compression ---

const COMPRESS_THRESHOLD = 20; // Compress when entries exceed this count

async function compressKnowledge(client, knowledgeDbPath) {
  let files;
  try { files = fs.readdirSync(knowledgeDbPath).filter(f => f.endsWith('.jsonl')); }
  catch { return { skipped: true }; }

  const results = [];

  for (const file of files) {
    const filePath = path.join(knowledgeDbPath, file);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length < COMPRESS_THRESHOLD) continue;

    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }

    // Build entries text for LLM
    const entriesText = entries.map((e, i) =>
      `### Entry ${i + 1}\nTopic: ${e.topic || 'unknown'}\nInsights: ${JSON.stringify(e.insights || [])}`
    ).join('\n\n');

    const prompt = fillPrompt('compress-knowledge.user', {
      entryCount: String(entries.length),
      entries: entriesText.slice(0, 8000)
    });

    try {
      const response = await client.query(prompt);
      const text = (response.response || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.entries || !Array.isArray(parsed.entries)) continue;

      // Rewrite the JSONL file with compressed entries
      const compressed = parsed.entries.map(e => {
        const safe = sanitizeText(JSON.stringify({ ...e, timestamp: new Date().toISOString() }));
        return safe;
      }).join('\n') + '\n';

      fs.writeFileSync(filePath, compressed, 'utf-8');
      results.push({ file, before: entries.length, after: parsed.entries.length });
    } catch {}
  }

  return { compressed: results };
}

// --- Dream Phase ---

async function dreamPhase(client, config, repoPath) {
  const commits = await getRecentCommits(repoPath);
  const researchKnowledge = getNewKnowledge(path.resolve(repoPath, 'brain', 'research'));
  const analysisKnowledge = getNewKnowledge(path.resolve(repoPath, 'brain', 'analysis'));
  const knowledge = [...researchKnowledge, ...analysisKnowledge];

  const diffs = [];
  for (const commit of commits.slice(0, 10)) {
    const diff = await getDiff(repoPath, commit.hash);
    if (diff) diffs.push({ commit: commit.message, diff: diff.slice(0, 2000) });
  }

  const prompt = fillPrompt('dream-phase.user', {
    commitDiffs: diffs.map(d => `### ${d.commit}\n\`\`\`\n${d.diff}\n\`\`\``).join('\n\n'),
    knowledge: knowledge.map(k => JSON.stringify(k)).join('\n')
  });

  const response = await client.query(prompt, null,
    { model: client.dreamModel });

  let analysis;
  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: response.response, nextTasks: [] };
  } catch {
    analysis = { raw: response.response, nextTasks: [] };
  }

  return {
    timestamp: new Date().toISOString(),
    commitsAnalyzed: commits.length,
    knowledgeEntries: knowledge.length,
    analysis
  };
}

// --- Refactoring ---

async function proposeRefactor(client, filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');
  const validation = validateCode(code);

  const prompt = fillPrompt('propose-refactor.user', {
    filePath,
    issues: JSON.stringify(validation.issues),
    code
  });

  const response = await client.query(prompt);
  const responseText = (response.response || '').trim();

  // Try to parse JSON result
  let result = null;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) result = JSON.parse(jsonMatch[0]);
  } catch {}

  // If JSON parse failed, try to extract code block as refactored code
  if (!result) {
    const codeMatch = responseText.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    if (codeMatch) {
      result = { suggestions: [{ type: 'improvement', description: 'LLM-proposed refactor', priority: 'medium' }], refactoredCode: codeMatch[1] };
    }
  }

  if (!result) return { suggestions: [], applied: false, reason: 'Failed to parse LLM response' };

  if (result.refactoredCode && result.refactoredCode !== 'null' && result.refactoredCode !== null) {
    const newValidation = validateCode(result.refactoredCode);
    if (!newValidation.valid) {
      return { suggestions: result.suggestions || [], applied: false, reason: 'Critical issues in refactored code' };
    }

    const syntaxCheck = validateSyntax(result.refactoredCode);
    if (!syntaxCheck.valid) {
      return { suggestions: result.suggestions || [], applied: false, reason: `Syntax error: ${syntaxCheck.error}` };
    }

    return { suggestions: result.suggestions || [], refactoredCode: result.refactoredCode, applied: false };
  }

  return { suggestions: result.suggestions || [], applied: false, reason: result.reason || 'No code changes proposed' };
}

async function applyRefactor(repoPath, filePath, refactoredCode, allowedPaths) {
  // Safety: only allow editing files within explicitly allowed paths (targetFolders)
  const relPath = path.relative(repoPath, filePath);
  const allowed = (allowedPaths || ['brain/modules']).map(p => p.replace(/^\.\//, ''));
  const isAllowed = allowed.some(p => relPath.startsWith(p));
  if (!isAllowed) {
    return { success: false, reason: `Editing ${relPath} is not allowed. Only files in [${allowed.join(', ')}] can be auto-modified.` };
  }

  // Check refactored code for sensitive data before writing
  const sensitiveIssues = containsSensitiveData(refactoredCode);
  if (sensitiveIssues.length > 0) {
    return { success: false, reason: `Refactored code contains sensitive data: ${sensitiveIssues.map(i => i.pattern).join(', ')}` };
  }

  const backupCode = fs.readFileSync(filePath, 'utf-8');

  fs.writeFileSync(filePath, refactoredCode, 'utf-8');

  // Validate the written file with node -c (syntax check)
  const fileCheck = await testFile(filePath);
  if (!fileCheck.valid) {
    fs.writeFileSync(filePath, backupCode, 'utf-8');
    return { success: false, reason: `Syntax validation failed, reverted: ${fileCheck.error}` };
  }

  // Only stage allowed paths
  const commitResult = await autoCommit(repoPath, `refactor: auto-improve ${path.basename(filePath)}`, allowed);
  return { success: commitResult.success, commit: commitResult.output || commitResult.error };
}

// --- Code generation from knowledge ---

async function generateModule(client, topic, knowledge, modulesDir) {
  const prompt = fillPrompt('generate-module.user', {
    topic,
    knowledge: JSON.stringify(knowledge, null, 2)
  });

  const response = await client.query(prompt);

  // Extract JSON response with filename and code
  let code = '';
  let suggestedName = '';

  const responseText = (response.response || '').trim();
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.filename) suggestedName = parsed.filename;
      if (parsed.code) code = parsed.code;
    }
  } catch {}

  // Fallback: extract code block if JSON parse failed
  if (!code) {
    code = responseText;
    const codeBlockMatch = code.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1];
    }
  }

  // Sanitize suggested filename, fallback to topic-based name
  if (suggestedName) {
    suggestedName = suggestedName.replace(/\.js$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40).toLowerCase();
  }
  if (!suggestedName || suggestedName.length < 3) {
    // Fallback: use topic but filter only ASCII parts
    const asciiParts = topic.match(/[a-zA-Z0-9]+/g);
    suggestedName = asciiParts ? asciiParts.join('-').slice(0, 40).toLowerCase() : `module-${Date.now()}`;
  }

  const safeName = suggestedName;
  const filePath = path.join(modulesDir, `${safeName}.js`);

  // Skip if already exists
  if (fs.existsSync(filePath)) return { skipped: true, file: filePath };

  // Validate
  const validation = validateCode(code);
  if (!validation.valid) {
    return { success: false, reason: 'Generated code has critical issues', issues: validation.issues };
  }

  const sensitiveIssues = containsSensitiveData(code);
  if (sensitiveIssues.length > 0) {
    return { success: false, reason: 'Generated code contains sensitive data' };
  }

  // Syntax validation
  const syntaxCheck = validateSyntax(code);
  if (!syntaxCheck.valid) {
    return { success: false, reason: `Syntax error: ${syntaxCheck.error}` };
  }

  // Sandbox execution test (checks require dependencies, runtime errors)
  const sandboxResult = await runInSandbox(code);
  if (!sandboxResult.success) {
    return { success: false, reason: `Runtime validation failed: ${sandboxResult.error}` };
  }

  // Write and commit
  if (!fs.existsSync(modulesDir)) fs.mkdirSync(modulesDir, { recursive: true });
  fs.writeFileSync(filePath, code, 'utf-8');

  const commitResult = await autoCommit(
    path.resolve(modulesDir, '..', '..'),
    `feat: generate module ${safeName} from research`,
    ['brain/modules']
  );

  return { success: true, file: filePath, committed: commitResult.success };
}

// --- Chat with LLM ---

async function chat(client, userMessage, context) {
  const systemPrompt = context?.systemPrompt || loadPrompt('chat.system');

  const parts = [];
  if (context?.systemDocs) {
    parts.push(`## このシステムのドキュメント:\n${context.systemDocs}`);
  }
  if (context?.knowledge) {
    parts.push(`## システムの知識:\n${context.knowledge}`);
  }
  parts.push(`## ユーザーの質問:\n${userMessage}`);

  const prompt = parts.join('\n\n');

  const response = await client.query(prompt, systemPrompt);
  return response.response;
}

// --- Script review and cleanup ---

async function reviewScripts(client, modulesDir) {
  if (!fs.existsSync(modulesDir)) return { reviewed: 0, deleted: 0 };

  const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
  if (files.length === 0) return { reviewed: 0, deleted: 0 };

  // Build summaries for LLM review
  const scriptSummaries = [];
  for (const file of files) {
    const filePath = path.join(modulesDir, file);
    try {
      const code = fs.readFileSync(filePath, 'utf-8');
      const syntaxCheck = validateSyntax(code);
      const sandbox = await runInSandbox(code);

      scriptSummaries.push({
        file,
        lines: code.split('\n').length,
        syntaxValid: syntaxCheck.valid,
        runsInSandbox: sandbox.success,
        sandboxError: sandbox.error || null,
        preview: code.slice(0, 300)
      });
    } catch (e) {
      scriptSummaries.push({ file, error: e.message });
    }
  }

  // Ask LLM to review
  const prompt = `以下の${files.length}個のスクリプトを精査してください。\n\n` +
    scriptSummaries.map(s =>
      `### ${s.file}\n` +
      (s.error ? `エラー: ${s.error}\n` :
        `行数: ${s.lines}, 構文: ${s.syntaxValid ? 'OK' : 'NG'}, 実行: ${s.runsInSandbox ? 'OK' : 'NG'}${s.sandboxError ? ` (${s.sandboxError.slice(0, 80)})` : ''}\n` +
        `\`\`\`\n${s.preview}\n\`\`\`\n`)
    ).join('\n');

  let deleted = 0;
  try {
    const response = await client.query(prompt, loadPrompt('review-scripts.system'));
    const text = (response.response || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { reviewed: files.length, deleted: 0 };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.reviews || !Array.isArray(parsed.reviews)) return { reviewed: files.length, deleted: 0 };

    for (const review of parsed.reviews) {
      if (!review.keep && review.file) {
        const filePath = path.join(modulesDir, review.file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          // Also remove .summary.json if it exists
          const summaryPath = filePath.replace(/\.js$/, '.summary.json');
          if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);
          deleted++;
        }
      }
    }

    return { reviewed: files.length, deleted, reviews: parsed.reviews };
  } catch {
    return { reviewed: files.length, deleted: 0 };
  }
}

module.exports = {
  getRecentCommits, getLastCommit, getDiff, autoCommit,
  getNewKnowledge, getAllKnowledge, saveKnowledge, compressKnowledge,
  dreamPhase, reviewScripts,
  proposeRefactor, applyRefactor,
  sanitizeText, containsSensitiveData,
  generateModule, chat
};
