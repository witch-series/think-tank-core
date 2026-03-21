'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { queryOllama } = require('../explorers/crawler');
const { searchWeb, fetchPage } = require('../explorers/searcher');
const { sanitizeText } = require('./evolution');

const MAX_ITERATIONS = 10;

// --- Tool descriptions for LLM ---
const TOOL_DESCRIPTIONS = `## 利用可能なツール
各ステップでは、以下のツールの中から1つを選び、JSON形式で返してください。

1. **search_web** — ウェブ検索
   {"action": "search_web", "query": "検索クエリ"}

2. **fetch_page** — ウェブページの内容を取得
   {"action": "fetch_page", "url": "https://example.com/page"}

3. **read_file** — プロジェクト内のファイルを読む
   {"action": "read_file", "path": "relative/path/to/file.js"}

4. **list_files** — ディレクトリ内のファイル一覧
   {"action": "list_files", "path": "."}

5. **git_log** — Gitコミット履歴
   {"action": "git_log", "count": 10}

6. **git_diff** — 直近の変更差分
   {"action": "git_diff"}

7. **analyze_code** — ファイルの構造を解析
   {"action": "analyze_code", "path": "relative/path/to/file.js"}

8. **save_note** — 調査メモを保存（後の調査で参照可能）
   {"action": "save_note", "topic": "トピック名", "content": "メモ内容"}

9. **done** — 調査完了、結果を報告
   {"action": "done", "summary": "調査結果のまとめ", "insights": ["発見1", "発見2"]}
`;

// --- Tool execution ---

function gitExec(args, repoPath) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: 1024 * 512 }, (err, stdout) => {
      if (err) { resolve({ error: err.message }); return; }
      resolve({ output: stdout.trim() });
    });
  });
}

function extractFunctionsSimple(code) {
  const functions = [];
  const patterns = [
    /(?:async\s+)?function\s+(\w+)\s*\(/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/g,
    /(\w+)\s*:\s*(?:async\s+)?function/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      functions.push(match[1]);
    }
  }
  return [...new Set(functions)];
}

async function executeTool(action, repoPath, workLogDir) {
  try {
    switch (action.action) {
      case 'search_web': {
        if (!action.query) return { error: 'query is required' };
        const results = await searchWeb(action.query, 5);
        if (results.length === 0) return { results: [], message: 'No results found. Try a different query.' };
        return { results };
      }

      case 'fetch_page': {
        if (!action.url) return { error: 'url is required' };
        const page = await fetchPage(action.url, 6000);
        return page;
      }

      case 'read_file': {
        if (!action.path) return { error: 'path is required' };
        const filePath = path.resolve(repoPath, action.path);
        if (!filePath.startsWith(repoPath)) return { error: 'Access denied: path outside repository' };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${action.path}` };
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return { error: 'Path is a directory, use list_files instead' };
        const content = fs.readFileSync(filePath, 'utf-8');
        return { path: action.path, content: content.slice(0, 5000), truncated: content.length > 5000 };
      }

      case 'list_files': {
        const dirPath = path.resolve(repoPath, action.path || '.');
        if (!dirPath.startsWith(repoPath)) return { error: 'Access denied' };
        if (!fs.existsSync(dirPath)) return { error: `Directory not found: ${action.path}` };
        const items = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(i => !i.name.startsWith('.') && i.name !== 'node_modules')
          .map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }));
        return { path: action.path || '.', items };
      }

      case 'git_log': {
        const count = Math.min(action.count || 10, 30);
        const result = await gitExec(['log', `-${count}`, '--pretty=format:%h|%s|%ai'], repoPath);
        if (result.error) return result;
        const commits = result.output.split('\n').filter(Boolean).map(line => {
          const parts = line.split('|');
          return { hash: parts[0], message: parts[1], date: parts[2] };
        });
        return { commits };
      }

      case 'git_diff': {
        const result = await gitExec(['diff', 'HEAD~1', 'HEAD', '--stat'], repoPath);
        if (result.error) {
          // Try diff of working tree instead
          const wt = await gitExec(['diff', '--stat'], repoPath);
          return wt.error ? { diff: 'No changes' } : { diff: wt.output };
        }
        return { diff: result.output };
      }

      case 'analyze_code': {
        if (!action.path) return { error: 'path is required' };
        const filePath = path.resolve(repoPath, action.path);
        if (!filePath.startsWith(repoPath)) return { error: 'Access denied' };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${action.path}` };
        const code = fs.readFileSync(filePath, 'utf-8');
        const lines = code.split('\n').length;
        const functions = extractFunctionsSimple(code);
        const imports = (code.match(/require\(['"]([^'"]+)['"]\)/g) || []).map(m => m.match(/['"]([^'"]+)['"]/)[1]);
        return {
          path: action.path,
          lines,
          functions,
          imports,
          preview: code.slice(0, 1000)
        };
      }

      case 'save_note': {
        if (!action.topic || !action.content) return { error: 'topic and content are required' };
        if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeTopic = (action.topic || 'note').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        const fileName = `${timestamp}_${safeTopic}.json`;
        const logPath = path.join(workLogDir, fileName);
        const entry = {
          topic: action.topic,
          content: sanitizeText(action.content),
          timestamp: new Date().toISOString()
        };
        fs.writeFileSync(logPath, JSON.stringify(entry, null, 2), 'utf-8');
        return { saved: true, file: fileName };
      }

      case 'done':
        return { done: true };

      default:
        return { error: `Unknown action: ${action.action}. Available: search_web, fetch_page, read_file, list_files, git_log, git_diff, analyze_code, save_note, done` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// --- Load recent work logs ---

function loadRecentWorkLogs(workLogDir, maxEntries = 5) {
  if (!fs.existsSync(workLogDir)) return '';

  const logFiles = fs.readdirSync(workLogDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-maxEntries);

  const entries = [];
  for (const file of logFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(workLogDir, file), 'utf-8'));
      if (content.topic) {
        entries.push(`- [${content.topic}] ${(content.content || content.result?.summary || '').slice(0, 200)}`);
      } else if (content.task) {
        entries.push(`- [${content.task.slice(0, 50)}] ${(content.result?.summary || '').slice(0, 200)}`);
      }
    } catch {}
  }

  return entries.join('\n');
}

// --- Clean old work logs ---

function cleanOldWorkLogs(workLogDir, maxAgeHours = 72) {
  if (!fs.existsSync(workLogDir)) return;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  try {
    const files = fs.readdirSync(workLogDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(workLogDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

// --- Main agent loop ---

/**
 * Run a multi-turn agent loop where the LLM can use tools
 * @param {string} ollamaUrl - Ollama API URL
 * @param {string} model - Model name
 * @param {string} taskDescription - What the agent should do
 * @param {string} repoPath - Repository root path
 * @param {object} options - { workLogDir, onLog, systemContext }
 * @returns {Promise<{summary: string, insights: Array, steps: number, actions: Array}>}
 */
async function runAgentLoop(ollamaUrl, model, taskDescription, repoPath, options = {}) {
  const workLogDir = options.workLogDir || path.join(repoPath, 'brain', 'work-logs');
  const onLog = options.onLog || (() => {});

  // Clean old logs periodically
  cleanOldWorkLogs(workLogDir);

  // Build context from recent work logs
  const recentLogs = loadRecentWorkLogs(workLogDir);

  const systemPrompt = `あなたは自律的な研究・開発AIエージェントです。
与えられたタスクを達成するために、ツールを使って情報を収集し、分析を行ってください。

${TOOL_DESCRIPTIONS}

## ルール
- 各レスポンスでは必ず1つのアクションをJSON形式（{...}）で返してください
- ウェブ検索で情報を集めてから分析してください
- 検索結果は必ず元ページ（fetch_page）で内容を確認してください
- 十分な情報が集まったら save_note でメモを残し、done で完了してください
- コードベースの改善タスクの場合は、まず read_file や list_files で現状を把握してください
- 日本語で回答してください`;

  let conversation = `## タスク\n${taskDescription}\n`;

  if (options.systemContext) {
    conversation += `\n## 現在のシステム状態\n${options.systemContext}\n`;
  }

  if (recentLogs) {
    conversation += `\n## 過去の調査メモ\n${recentLogs}\n`;
  }

  conversation += `\nまず何から始めますか？JSON形式でアクションを返してください。`;

  const executedActions = [];
  let finalResult = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    onLog('debug', `Agent iteration ${i + 1}/${MAX_ITERATIONS}`);

    const response = await queryOllama(ollamaUrl, model, conversation, systemPrompt);
    const responseText = (response.response || '').trim();

    // Parse JSON action from response
    let action = null;
    try {
      // Find the last JSON object in the response (LLM sometimes explains before the JSON)
      const jsonMatches = responseText.match(/\{[^{}]*\}/g);
      if (jsonMatches) {
        // Try each match, preferring ones with "action" field
        for (const jsonStr of jsonMatches) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.action) { action = parsed; break; }
          } catch {}
        }
        // If no action field found, try the first valid JSON
        if (!action) {
          for (const jsonStr of jsonMatches) {
            try { action = JSON.parse(jsonStr); break; } catch {}
          }
        }
      }
    } catch {}

    if (!action || !action.action) {
      // LLM didn't return valid JSON — nudge it
      conversation += `\n\n[AI応答]\n${responseText.slice(0, 300)}\n\n[システム] JSON形式でアクションを返してください。例: {"action": "search_web", "query": "..."}`;
      continue;
    }

    executedActions.push({ action: action.action, detail: action.query || action.path || action.url || action.topic || '' });

    // Check for done
    if (action.action === 'done') {
      finalResult = {
        summary: action.summary || responseText,
        insights: action.insights || [],
        steps: executedActions.length
      };
      break;
    }

    // Execute the tool
    onLog('info', `Agent: ${action.action}${action.query ? ` "${action.query}"` : ''}${action.url ? ` ${action.url}` : ''}${action.path ? ` ${action.path}` : ''}`);

    const toolResult = await executeTool(action, repoPath, workLogDir);

    // Build result string, truncated to prevent context overflow
    const resultStr = JSON.stringify(toolResult).slice(0, 4000);

    conversation += `\n\n[AI応答]\n${responseText.slice(0, 400)}\n\n[ツール結果: ${action.action}]\n${resultStr}\n\n次のアクションをJSON形式で返してください。`;
  }

  // If max iterations reached without done
  if (!finalResult) {
    finalResult = {
      summary: 'エージェントループが最大反復回数に達しました',
      insights: [],
      steps: executedActions.length,
      actions: executedActions.map(a => a.action)
    };
  }

  // Save the run result as a work log
  if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(workLogDir, `${timestamp}_agent-result.json`);
  const safeResult = JSON.parse(sanitizeText(JSON.stringify({
    task: taskDescription,
    result: finalResult,
    actions: executedActions,
    timestamp: new Date().toISOString()
  })));
  fs.writeFileSync(logFile, JSON.stringify(safeResult, null, 2), 'utf-8');

  return finalResult;
}

module.exports = { runAgentLoop, executeTool, loadRecentWorkLogs };
