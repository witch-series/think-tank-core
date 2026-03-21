'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { queryOllama } = require('../explorers/crawler');
const { searchWeb, fetchPage } = require('../explorers/searcher');
const { sanitizeText } = require('./evolution');

const MAX_ITERATIONS = 8;

// --- JSON extraction helper ---

/**
 * Extract a balanced JSON object string from text
 * Handles nested objects and arrays properly
 */
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }

    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse a JSON action from LLM response text
 */
function parseAction(responseText) {
  // First: try balanced extraction for nested JSON (done with insights array)
  const balanced = extractBalancedJson(responseText);
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced);
      if (parsed.action) return parsed;
    } catch {}
  }

  // Fallback: simple non-nested JSON objects
  const simpleMatches = responseText.match(/\{[^{}]*\}/g);
  if (simpleMatches) {
    for (const jsonStr of simpleMatches) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.action) return parsed;
      } catch {}
    }
  }

  return null;
}

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
        return { error: `Unknown action: ${action.action}` };
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

// --- Build a fresh prompt for each turn ---

/**
 * Build a concise prompt for one turn of the agent loop.
 * Instead of appending to a growing conversation, we send a compact
 * prompt each time: task + accumulated history summary + latest tool result.
 * This keeps the prompt small and works well with stateless Ollama API.
 */
function buildTurnPrompt(taskDescription, history, lastToolResult, recentLogs) {
  let prompt = `# タスク
${taskDescription}

`;

  if (recentLogs) {
    prompt += `# 過去の調査メモ
${recentLogs}

`;
  }

  // Include compact history of what was done so far
  if (history.length > 0) {
    prompt += `# これまでの実行履歴
`;
    for (const h of history) {
      if (h.resultSummary) {
        prompt += `${h.step}. ${h.action}(${h.detail}) → ${h.resultSummary}\n`;
      } else {
        prompt += `${h.step}. ${h.action}(${h.detail})\n`;
      }
    }
    prompt += `\n`;
  }

  // Include the latest tool result in full
  if (lastToolResult) {
    prompt += `# 直前のツール実行結果
${lastToolResult}

`;
  }

  prompt += `# 次のアクション
上記の情報に基づいて、次に実行すべきアクションを1つだけJSON形式で返してください。
説明文は不要です。JSONのみ返してください。

例: {"action": "search_web", "query": "physical AI robot 2025"}
例: {"action": "fetch_page", "url": "https://example.com"}
例: {"action": "save_note", "topic": "調査結果", "content": "発見した内容..."}
例: {"action": "done", "summary": "調査まとめ", "insights": ["発見1", "発見2"]}
`;

  return prompt;
}

/**
 * Summarize a tool result for the compact history
 */
function summarizeToolResult(action, result) {
  if (!result) return '';
  if (result.error) return `エラー: ${result.error.slice(0, 60)}`;

  switch (action) {
    case 'search_web':
      return result.results ? `${result.results.length}件の結果` : 'no results';
    case 'fetch_page':
      return result.text ? `${result.text.length}文字取得` : (result.error || 'empty');
    case 'read_file':
      return result.content ? `${result.content.length}文字` : 'empty';
    case 'list_files':
      return result.items ? `${result.items.length}項目` : 'empty';
    case 'git_log':
      return result.commits ? `${result.commits.length}件のコミット` : 'empty';
    case 'git_diff':
      return result.diff ? `差分あり` : 'no diff';
    case 'analyze_code':
      return result.functions ? `${result.lines}行, ${result.functions.length}関数` : 'empty';
    case 'save_note':
      return result.saved ? '保存完了' : 'failed';
    default:
      return JSON.stringify(result).slice(0, 60);
  }
}

// --- Main agent loop ---

/**
 * Run a multi-turn agent loop where the LLM can use tools.
 * Uses a fresh prompt each turn (not growing conversation) for reliability.
 */
async function runAgentLoop(ollamaUrl, model, taskDescription, repoPath, options = {}) {
  const workLogDir = options.workLogDir || path.join(repoPath, 'brain', 'work-logs');
  const onLog = options.onLog || (() => {});

  cleanOldWorkLogs(workLogDir);

  const recentLogs = loadRecentWorkLogs(workLogDir);

  const systemPrompt = `あなたはツールを使って調査を行うAIエージェントです。
必ずJSON形式で1つのアクションを返してください。説明文は不要です。JSONのみ出力してください。
利用可能なアクション: search_web, fetch_page, read_file, list_files, git_log, git_diff, analyze_code, save_note, done`;

  const history = []; // compact history: [{step, action, detail, resultSummary}]
  const executedActions = [];
  let lastToolResultStr = null;
  let finalResult = null;
  let consecutiveFailures = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    onLog('debug', `Agent iteration ${i + 1}/${MAX_ITERATIONS}`);

    const prompt = buildTurnPrompt(taskDescription, history, lastToolResultStr, recentLogs);

    const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
    const responseText = (response.response || '').trim();

    // Parse action
    const action = parseAction(responseText);

    if (!action) {
      consecutiveFailures++;
      onLog('debug', `Agent: failed to parse action (attempt ${consecutiveFailures}): ${responseText.slice(0, 100)}`);

      // After 2 consecutive failures, try to auto-decide next action based on history
      if (consecutiveFailures >= 2) {
        // If we have search results but haven't fetched pages, do that
        // If we've done enough, force done
        if (history.length >= 3) {
          onLog('info', 'Agent: forcing completion after parse failures');
          finalResult = {
            summary: `${history.length}ステップの調査を実行（LLM応答パース失敗で自動完了）`,
            insights: collectInsightsFromHistory(history, workLogDir),
            steps: executedActions.length
          };
          break;
        }
      }

      // Add a hint to lastToolResult for the next prompt
      lastToolResultStr = `[システム注意] 前回の応答がJSON形式ではありませんでした。必ず {"action": "..."} の形式で返してください。`;
      continue;
    }

    consecutiveFailures = 0;

    const detail = action.action === 'save_note'
      ? `${action.topic || ''}: ${(action.content || '').slice(0, 200)}`
      : (action.query || action.path || action.url || action.topic || '');
    executedActions.push({ action: action.action, detail });

    // Check for done
    if (action.action === 'done') {
      finalResult = {
        summary: action.summary || '',
        insights: action.insights || [],
        steps: executedActions.length
      };
      // If LLM returned empty insights but we have save_notes, supplement
      if (finalResult.insights.length === 0) {
        finalResult.insights = collectInsightsFromHistory(history, workLogDir);
      }
      break;
    }

    // Execute the tool
    onLog('info', `Agent: ${action.action}${action.query ? ` "${action.query}"` : ''}${action.url ? ` ${action.url}` : ''}${action.path ? ` ${action.path}` : ''}`);

    const toolResult = await executeTool(action, repoPath, workLogDir);

    // Save compact history entry
    const resultSummary = summarizeToolResult(action.action, toolResult);
    history.push({
      step: i + 1,
      action: action.action,
      detail: detail.slice(0, 80),
      resultSummary
    });

    // Set full result for next prompt (only the latest result in detail)
    lastToolResultStr = JSON.stringify(toolResult).slice(0, 4000);
  }

  // If max iterations reached, collect what we have
  if (!finalResult) {
    const collectedInsights = collectInsightsFromHistory(history, workLogDir);
    finalResult = {
      summary: `エージェントが${executedActions.length}ステップの調査を完了`,
      insights: collectedInsights,
      steps: executedActions.length,
      actions: executedActions.map(a => a.action)
    };
  }

  // Save the run result as a work log
  if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(workLogDir, `${timestamp}_agent-result.json`);
  const safeResult = JSON.parse(sanitizeText(JSON.stringify({
    task: taskDescription.slice(0, 200),
    result: finalResult,
    actions: executedActions,
    timestamp: new Date().toISOString()
  })));
  fs.writeFileSync(logFile, JSON.stringify(safeResult, null, 2), 'utf-8');

  return finalResult;
}

/**
 * Collect insights from save_note entries in work logs
 */
function collectInsightsFromHistory(history, workLogDir) {
  const insights = [];

  // From save_note actions in history
  for (const h of history) {
    if (h.action === 'save_note' && h.detail) {
      insights.push(h.detail);
    }
  }

  // Also read recent save_note work logs (written during this run)
  if (fs.existsSync(workLogDir)) {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const logFiles = fs.readdirSync(workLogDir).filter(f => f.endsWith('.json') && !f.includes('agent-result'));
    for (const file of logFiles) {
      try {
        const filePath = path.join(workLogDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > fiveMinAgo) {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (content.topic && content.content) {
            insights.push(`${content.topic}: ${content.content.slice(0, 200)}`);
          }
        }
      } catch {}
    }
  }

  return insights;
}

module.exports = { runAgentLoop, executeTool, loadRecentWorkLogs };
