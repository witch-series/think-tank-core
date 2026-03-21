'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { queryOllama } = require('../explorers/crawler');
const { validateCode } = require('../lib/configurator');
const { runInSandbox } = require('../lib/sandbox');

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
        if (entry.timestamp && new Date(entry.timestamp).getTime() > since) entries.push(entry);
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

// --- Autonomous question generation ---

async function generateNextQuestion(ollamaUrl, model, context) {
  const prompt = `あなたは自律的な研究AIです。現在のコードベースと知識の状態を踏まえ、次に調査・改善すべきテーマを1つ提案してください。

## 現在の状態
- 解析済みファイル数: ${context.fileCount}
- 蓄積知識数: ${context.knowledgeCount}
- 直近の活動: ${context.recentActivity || 'なし'}

## 既知の関数一覧
${context.functionList || 'なし'}

以下のJSON形式で返答してください:
{
  "topic": "調査テーマ",
  "type": "research|refactor|explore",
  "reason": "このテーマを選んだ理由",
  "query": "具体的な調査クエリ"
}`;

  const response = await queryOllama(ollamaUrl, model, prompt,
    'あなたはソフトウェア改善を専門とする自律AIです。実用的で具体的な提案をしてください。');

  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return { topic: 'コードベースの品質改善', type: 'refactor', reason: 'デフォルト', query: 'コード品質の改善点を探す' };
}

// --- Dream Phase ---

async function dreamPhase(config, repoPath) {
  const { url, model, dreamModel } = config.ollama;
  const knowledgeDbPath = path.resolve(repoPath, config.knowledgeDb);

  const commits = await getRecentCommits(repoPath);
  const knowledge = getNewKnowledge(knowledgeDbPath);

  const diffs = [];
  for (const commit of commits.slice(0, 10)) {
    const diff = await getDiff(repoPath, commit.hash);
    if (diff) diffs.push({ commit: commit.message, diff: diff.slice(0, 2000) });
  }

  const prompt = `以下は直近24時間の活動記録です。これらから学習すべきパターンと改善点を分析してください。

## コミット履歴と差分
${diffs.map(d => `### ${d.commit}\n\`\`\`\n${d.diff}\n\`\`\``).join('\n\n')}

## 新規獲得知識
${knowledge.map(k => JSON.stringify(k)).join('\n')}

以下のJSON形式で返答してください:
{
  "patterns": ["学習パターン1"],
  "improvements": ["改善提案1"],
  "risks": ["注意点1"],
  "nextTasks": [{"topic": "タスク名", "type": "research|refactor", "query": "具体的な内容"}]
}`;

  const response = await queryOllama(url, dreamModel || model, prompt,
    '既存の安定したコード構造（JSDoc規約）を維持しつつ、改善案を提示してください。破壊的変更は提案しないでください。');

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

async function proposeRefactor(ollamaUrl, model, filePath) {
  const code = fs.readFileSync(filePath, 'utf-8');
  const validation = validateCode(code);

  const prompt = `以下のコードを分析し、改善提案をしてください。セキュリティ問題があれば必ず指摘してください。

ファイル: ${filePath}
既知の問題: ${JSON.stringify(validation.issues)}

\`\`\`javascript
${code}
\`\`\`

以下のJSON形式で返答してください:
{
  "suggestions": [{"type": "improvement", "description": "...", "priority": "high/medium/low"}],
  "refactoredCode": "改善後のコード全体（変更が必要な場合のみ。不要なら null）"
}`;

  const response = await queryOllama(ollamaUrl, model, prompt);

  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);

      if (result.refactoredCode && result.refactoredCode !== 'null') {
        const newValidation = validateCode(result.refactoredCode);
        if (!newValidation.valid) {
          return { suggestions: result.suggestions, applied: false, reason: 'Critical issues in refactored code' };
        }

        const sandboxResult = await runInSandbox(`
          const code = ${JSON.stringify(result.refactoredCode)};
          new Function(code);
          console.log('Syntax OK');
        `);

        if (!sandboxResult.success) {
          return { suggestions: result.suggestions, applied: false, reason: 'Sandbox validation failed' };
        }

        return { suggestions: result.suggestions, refactoredCode: result.refactoredCode, applied: false };
      }

      return { suggestions: result.suggestions, applied: false, reason: 'No code changes proposed' };
    }
  } catch {}

  return { suggestions: [], applied: false };
}

async function applyRefactor(repoPath, filePath, refactoredCode) {
  // Check refactored code for sensitive data before writing
  const sensitiveIssues = containsSensitiveData(refactoredCode);
  if (sensitiveIssues.length > 0) {
    return { success: false, reason: `Refactored code contains sensitive data: ${sensitiveIssues.map(i => i.pattern).join(', ')}` };
  }

  const backupCode = fs.readFileSync(filePath, 'utf-8');

  fs.writeFileSync(filePath, refactoredCode, 'utf-8');

  const sandboxResult = await runInSandbox(`require(${JSON.stringify(filePath)})`);
  if (!sandboxResult.success) {
    fs.writeFileSync(filePath, backupCode, 'utf-8');
    return { success: false, reason: 'Runtime validation failed, reverted' };
  }

  // Only stage the specific file's parent directory
  const relDir = path.relative(repoPath, path.dirname(filePath));
  const commitResult = await autoCommit(repoPath, `refactor: auto-improve ${path.basename(filePath)}`, [relDir || '.']);
  return { success: commitResult.success, commit: commitResult.output || commitResult.error };
}

// --- Code generation from knowledge ---

async function generateModule(ollamaUrl, model, topic, knowledge, modulesDir) {
  const safeName = topic.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40).toLowerCase();
  const filePath = path.join(modulesDir, `${safeName}.js`);

  // Skip if already exists
  if (fs.existsSync(filePath)) return { skipped: true, file: filePath };

  const prompt = `以下の研究結果に基づいて、実用的なNode.jsモジュールを生成してください。

## テーマ: ${topic}

## 研究結果:
${JSON.stringify(knowledge, null, 2)}

要件:
- 'use strict' で始める
- Node.js標準ライブラリのみ使用
- module.exports で関数をエクスポート
- JSDocコメントを含める
- 実用的で再利用可能なコード

コードのみを返してください（説明不要）。`;

  const response = await queryOllama(ollamaUrl, model, prompt,
    'あなたはNode.jsの専門家です。安全で堅牢なコードを生成してください。evalやnew Functionは絶対に使わないでください。');

  // Extract code from response
  let code = response.response;
  const codeBlockMatch = code.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    code = codeBlockMatch[1];
  }

  // Validate
  const validation = validateCode(code);
  if (!validation.valid) {
    return { success: false, reason: 'Generated code has critical issues', issues: validation.issues };
  }

  const sensitiveIssues = containsSensitiveData(code);
  if (sensitiveIssues.length > 0) {
    return { success: false, reason: 'Generated code contains sensitive data' };
  }

  // Sandbox test
  const sandboxResult = await runInSandbox(`
    const code = ${JSON.stringify(code)};
    new Function(code);
    console.log('Syntax OK');
  `);

  if (!sandboxResult.success) {
    return { success: false, reason: 'Sandbox validation failed' };
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

async function chat(ollamaUrl, model, userMessage, context) {
  const systemPrompt = context?.systemPrompt ||
    'あなたは自律思考エンジンのアシスタントです。ユーザーの質問に簡潔に回答してください。現在のシステム状態に基づいて回答してください。';

  const prompt = context?.knowledge
    ? `## システムの知識:\n${context.knowledge}\n\n## ユーザーの質問:\n${userMessage}`
    : userMessage;

  const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
  return response.response;
}

module.exports = {
  getRecentCommits, getLastCommit, getDiff, autoCommit,
  getNewKnowledge, saveKnowledge,
  generateNextQuestion, dreamPhase,
  proposeRefactor, applyRefactor,
  sanitizeText, containsSensitiveData,
  generateModule, chat
};
