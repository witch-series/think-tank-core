'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { queryOllama } = require('../explorers/crawler');
const { searchWeb, fetchPage } = require('../explorers/searcher');
const { sanitizeText } = require('./evolution');

const MAX_GATHER_STEPS = 6;

// --- JSON extraction helper ---

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
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAction(responseText) {
  const balanced = extractBalancedJson(responseText);
  if (balanced) {
    try {
      const parsed = JSON.parse(balanced);
      if (parsed.action) return parsed;
    } catch {}
  }
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
        if (results.length === 0) return { results: [], message: 'No results found.' };
        return { results };
      }
      case 'fetch_page': {
        if (!action.url) return { error: 'url is required' };
        return await fetchPage(action.url, 6000);
      }
      case 'read_file': {
        if (!action.path) return { error: 'path is required' };
        const filePath = path.resolve(repoPath, action.path);
        if (!filePath.startsWith(repoPath)) return { error: 'Access denied' };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${action.path}` };
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return { error: 'Use list_files for directories' };
        const content = fs.readFileSync(filePath, 'utf-8');
        return { path: action.path, content: content.slice(0, 5000) };
      }
      case 'list_files': {
        const dirPath = path.resolve(repoPath, action.path || '.');
        if (!dirPath.startsWith(repoPath)) return { error: 'Access denied' };
        if (!fs.existsSync(dirPath)) return { error: `Not found: ${action.path}` };
        const items = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(i => !i.name.startsWith('.') && i.name !== 'node_modules')
          .map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : 'file' }));
        return { items };
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
        if (!fs.existsSync(filePath)) return { error: `Not found: ${action.path}` };
        const code = fs.readFileSync(filePath, 'utf-8');
        const functions = extractFunctionsSimple(code);
        const imports = (code.match(/require\(['"]([^'"]+)['"]\)/g) || []).map(m => m.match(/['"]([^'"]+)['"]/)[1]);
        return { path: action.path, lines: code.split('\n').length, functions, imports, preview: code.slice(0, 1000) };
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

// --- Work log helpers ---

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

function cleanOldWorkLogs(workLogDir, maxAgeHours = 72) {
  if (!fs.existsSync(workLogDir)) return;
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  try {
    const files = fs.readdirSync(workLogDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(workLogDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch {}
}

// --- Two-phase agent: Gather → Summarize ---

/**
 * Phase 1: Gather data using tools.
 * The LLM decides what to search/fetch/read. We collect all raw data.
 */
async function gatherData(ollamaUrl, model, taskDescription, repoPath, workLogDir, onLog) {
  const recentLogs = loadRecentWorkLogs(workLogDir);

  const systemPrompt = `あなたはデータ収集エージェントです。
タスクに必要な情報を集めるために、ツールをJSON形式で呼び出してください。
説明文は不要です。JSONのみ出力してください。

利用可能なツール:
- {"action": "search_web", "query": "検索クエリ"}
- {"action": "fetch_page", "url": "URL"}
- {"action": "read_file", "path": "ファイルパス"}
- {"action": "list_files", "path": "ディレクトリ"}
- {"action": "git_log", "count": 10}
- {"action": "analyze_code", "path": "ファイルパス"}
- {"action": "done"}  ← 十分なデータが集まったら`;

  const collectedData = []; // [{type, source, content}]
  const executedActions = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < MAX_GATHER_STEPS; i++) {
    // Build a concise prompt for this turn
    let prompt = `# タスク\n${taskDescription}\n\n`;

    if (recentLogs) {
      prompt += `# 過去の調査メモ\n${recentLogs}\n\n`;
    }

    if (executedActions.length > 0) {
      prompt += `# 実行済みアクション\n`;
      for (const ea of executedActions) {
        prompt += `- ${ea.action}(${ea.detail}) → ${ea.summary}\n`;
      }
      prompt += `\nまだ情報が足りなければ次のアクションを、十分なら {"action": "done"} を返してください。\n`;
    } else {
      prompt += `まず最初のアクションをJSON形式で返してください。\n`;
    }

    onLog('debug', `Gather step ${i + 1}/${MAX_GATHER_STEPS}`);

    const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
    const responseText = (response.response || '').trim();
    const action = parseAction(responseText);

    if (!action) {
      consecutiveFailures++;
      onLog('debug', `Gather: parse failed (${consecutiveFailures}): ${responseText.slice(0, 80)}`);
      if (consecutiveFailures >= 2) break;
      continue;
    }

    consecutiveFailures = 0;

    if (action.action === 'done') {
      onLog('debug', 'Gather: LLM signaled done');
      break;
    }

    const detail = action.query || action.path || action.url || '';
    onLog('info', `Agent: ${action.action}${detail ? ` "${detail}"` : ''}`);

    const toolResult = await executeTool(action, repoPath, workLogDir);

    // Collect the raw data for summarization
    let contentForSummary = '';
    let summary = '';

    if (action.action === 'search_web' && toolResult.results) {
      contentForSummary = toolResult.results.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n');
      summary = `${toolResult.results.length}件の結果`;
    } else if (action.action === 'fetch_page' && toolResult.text) {
      contentForSummary = toolResult.text.slice(0, 3000);
      summary = `${toolResult.text.length}文字取得`;
    } else if (action.action === 'read_file' && toolResult.content) {
      contentForSummary = toolResult.content.slice(0, 2000);
      summary = `${toolResult.content.length}文字`;
    } else if (action.action === 'list_files' && toolResult.items) {
      contentForSummary = toolResult.items.map(i => `${i.type}: ${i.name}`).join(', ');
      summary = `${toolResult.items.length}項目`;
    } else if (action.action === 'git_log' && toolResult.commits) {
      contentForSummary = toolResult.commits.map(c => `${c.hash} ${c.message}`).join('\n');
      summary = `${toolResult.commits.length}件のコミット`;
    } else if (action.action === 'analyze_code' && toolResult.functions) {
      contentForSummary = `${toolResult.lines}行, 関数: ${toolResult.functions.join(', ')}\n${toolResult.preview}`;
      summary = `${toolResult.lines}行, ${toolResult.functions.length}関数`;
    } else if (toolResult.error) {
      summary = `エラー: ${toolResult.error.slice(0, 50)}`;
    }

    executedActions.push({ action: action.action, detail: detail.slice(0, 80), summary });

    if (contentForSummary) {
      collectedData.push({
        type: action.action,
        source: detail.slice(0, 100),
        content: contentForSummary
      });
    }
  }

  return { collectedData, executedActions };
}

/**
 * Phase 2: Summarize collected data into structured insights.
 * This is a single dedicated LLM call with all gathered content.
 */
async function summarizeFindings(ollamaUrl, model, taskDescription, collectedData, onLog) {
  if (collectedData.length === 0) {
    return { summary: 'データを収集できませんでした', insights: [] };
  }

  // Build the data section, keeping total size manageable
  let dataSection = '';
  let totalLen = 0;
  const maxDataLen = 6000;

  for (const d of collectedData) {
    const entry = `\n## [${d.type}] ${d.source}\n${d.content}\n`;
    if (totalLen + entry.length > maxDataLen) {
      // Truncate remaining entries
      const remaining = maxDataLen - totalLen;
      if (remaining > 200) {
        dataSection += entry.slice(0, remaining) + '\n...(truncated)\n';
      }
      break;
    }
    dataSection += entry;
    totalLen += entry.length;
  }

  const prompt = `以下の収集データを分析し、重要な発見を日本語でまとめてください。

# タスク
${taskDescription}

# 収集データ（${collectedData.length}件）
${dataSection}

# 出力形式
以下のJSON形式で出力してください。必ずJSONのみ返してください。
{"summary": "全体のまとめ（200文字以内）", "insights": ["重要な発見1", "重要な発見2", "重要な発見3"]}`;

  const systemPrompt = 'あなたはデータ分析の専門家です。収集されたデータから重要な知見を抽出し、JSON形式で返してください。JSONのみ出力してください。';

  onLog('info', `Summarizing ${collectedData.length} data sources...`);

  const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
  const responseText = (response.response || '').trim();

  // Parse the summary JSON
  const parsed = parseAction(responseText);
  if (parsed && parsed.summary) {
    return {
      summary: parsed.summary,
      insights: parsed.insights || []
    };
  }

  // Try extractBalancedJson for more complex responses
  const balanced = extractBalancedJson(responseText);
  if (balanced) {
    try {
      const obj = JSON.parse(balanced);
      if (obj.summary || obj.insights) {
        return { summary: obj.summary || '', insights: obj.insights || [] };
      }
    } catch {}
  }

  // Last resort: use the raw response as summary
  onLog('debug', 'Summary: failed to parse JSON, using raw text');
  return {
    summary: responseText.slice(0, 300),
    insights: [responseText.slice(0, 500)]
  };
}

// --- Main agent loop ---

/**
 * Run a two-phase agent loop:
 * 1. Gather: LLM uses tools to collect data (search, fetch, read)
 * 2. Summarize: Dedicated LLM call to analyze all collected data into insights
 */
async function runAgentLoop(ollamaUrl, model, taskDescription, repoPath, options = {}) {
  const workLogDir = options.workLogDir || path.join(repoPath, 'brain', 'work-logs');
  const onLog = options.onLog || (() => {});

  cleanOldWorkLogs(workLogDir);

  // Phase 1: Gather
  onLog('info', 'Agent Phase 1: Gathering data...');
  const { collectedData, executedActions } = await gatherData(
    ollamaUrl, model, taskDescription, repoPath, workLogDir, onLog
  );
  onLog('info', `Gathered ${collectedData.length} data sources in ${executedActions.length} steps`);

  // Phase 2: Summarize
  onLog('info', 'Agent Phase 2: Summarizing findings...');
  const { summary, insights } = await summarizeFindings(
    ollamaUrl, model, taskDescription, collectedData, onLog
  );
  onLog('info', `Summary: ${insights.length} insights extracted`);

  const finalResult = {
    summary,
    insights,
    steps: executedActions.length,
    actions: executedActions.map(a => a.action),
    dataSourceCount: collectedData.length
  };

  // Save work log
  if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(workLogDir, `${timestamp}_agent-result.json`);
  const safeResult = JSON.parse(sanitizeText(JSON.stringify({
    task: taskDescription.slice(0, 200),
    result: finalResult,
    actions: executedActions,
    collectedSources: collectedData.map(d => ({ type: d.type, source: d.source })),
    timestamp: new Date().toISOString()
  })));
  fs.writeFileSync(logFile, JSON.stringify(safeResult, null, 2), 'utf-8');

  return finalResult;
}

module.exports = { runAgentLoop, executeTool, loadRecentWorkLogs };
