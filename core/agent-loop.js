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

/**
 * Parse any JSON object from LLM response text.
 * Looks for balanced JSON with or without "action" field.
 */
function parseJson(responseText) {
  const balanced = extractBalancedJson(responseText);
  if (balanced) {
    try { return JSON.parse(balanced); } catch {}
  }
  const simpleMatches = responseText.match(/\{[^{}]*\}/g);
  if (simpleMatches) {
    for (const jsonStr of simpleMatches) {
      try { return JSON.parse(jsonStr); } catch {}
    }
  }
  return null;
}

/**
 * Parse a JSON action (object with "action" field) from LLM response.
 */
function parseAction(responseText) {
  const obj = parseJson(responseText);
  if (obj && obj.action) return obj;

  // Fallback: look for any JSON with action field among multiple matches
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

// --- Phase 1: Smart data gathering ---

/**
 * Gather data for research tasks.
 * Uses a hybrid approach: LLM decides search queries, but the system
 * automatically fetches top search result pages (no LLM decision needed).
 */
async function gatherResearch(ollamaUrl, model, taskDescription, onLog) {
  const collectedData = [];
  const executedActions = [];

  // Step 1: Ask LLM for search queries based on the task
  onLog('info', 'Generating search queries...');
  const queryPrompt = `以下の調査テーマについて、ウェブ検索に使うクエリを3つ考えてください。
日本語と英語を混ぜて幅広く検索できるようにしてください。

テーマ: ${taskDescription}

以下のJSON形式で返してください。JSONのみ出力してください。
{"queries": ["検索クエリ1", "search query 2", "検索クエリ3"]}`;

  const queryResponse = await queryOllama(ollamaUrl, model, queryPrompt,
    'あなたは検索クエリの専門家です。JSONのみ出力してください。');
  const queryText = (queryResponse.response || '').trim();

  let queries = [];
  const parsed = parseJson(queryText);
  if (parsed && parsed.queries && Array.isArray(parsed.queries)) {
    queries = parsed.queries.slice(0, 3);
  }

  // Fallback: if LLM failed to generate queries, extract keywords from task
  if (queries.length === 0) {
    onLog('debug', 'Query generation failed, using task description as query');
    queries = [taskDescription.slice(0, 80)];
  }

  // Step 2: Execute searches and auto-fetch top results
  let totalSearchResults = 0;

  for (const query of queries) {
    onLog('info', `Searching: "${query}"`);
    const searchResults = await searchWeb(query, 3);
    executedActions.push({ action: 'search_web', detail: query, summary: `${searchResults.length}件` });
    totalSearchResults += searchResults.length;

    if (searchResults.length > 0) {
      // Save search result snippets
      collectedData.push({
        type: 'search_results',
        source: query,
        content: searchResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n')
      });

      // Auto-fetch the top 2 results (don't rely on LLM to call fetch_page)
      for (const result of searchResults.slice(0, 2)) {
        if (!result.url || result.url.includes('duckduckgo.com')) continue;

        onLog('info', `Fetching: ${result.url.slice(0, 80)}`);
        const page = await fetchPage(result.url, 4000);
        executedActions.push({ action: 'fetch_page', detail: result.url.slice(0, 80), summary: page.text ? `${page.text.length}文字` : (page.error || 'empty') });

        if (page.text && page.text.length > 100) {
          collectedData.push({
            type: 'web_page',
            source: `${result.title} (${result.url.slice(0, 60)})`,
            content: page.text.slice(0, 3000)
          });
        }
      }
    }
  }

  // Step 3: If search failed (rate limited), ask LLM for URLs to try directly
  if (totalSearchResults === 0) {
    onLog('info', 'Search returned no results, asking LLM for source URLs...');

    const urlPrompt = `「${taskDescription}」に関する情報を得られるウェブサイトのURLを5つ提案してください。
実在する主要なニュースサイト、技術ブログ、公式サイトのURLを返してください。

以下のJSON形式で返してください。JSONのみ出力してください。
{"urls": ["https://example.com/page1", "https://example.com/page2"]}`;

    const urlResponse = await queryOllama(ollamaUrl, model, urlPrompt,
      'あなたはウェブリサーチの専門家です。実在するURLのみを提案してください。JSONのみ出力してください。');
    const urlObj = parseJson((urlResponse.response || '').trim());

    if (urlObj && urlObj.urls && Array.isArray(urlObj.urls)) {
      for (const url of urlObj.urls.slice(0, 4)) {
        if (!url || !url.startsWith('http')) continue;

        onLog('info', `Direct fetch: ${url.slice(0, 80)}`);
        const page = await fetchPage(url, 4000);
        executedActions.push({ action: 'fetch_page', detail: url.slice(0, 80), summary: page.text ? `${page.text.length}文字` : (page.error || 'empty') });

        if (page.text && page.text.length > 100) {
          collectedData.push({
            type: 'web_page',
            source: url.slice(0, 80),
            content: page.text.slice(0, 3000)
          });
        }
      }
    }
  }

  return { collectedData, executedActions };
}

/**
 * Gather data for code analysis tasks.
 * Systematically reads project files without relying on LLM tool calls.
 */
async function gatherCodeAnalysis(repoPath, targetFolders, onLog) {
  const collectedData = [];
  const executedActions = [];

  // Step 1: List project structure
  const rootItems = fs.readdirSync(repoPath, { withFileTypes: true })
    .filter(i => !i.name.startsWith('.') && i.name !== 'node_modules')
    .map(i => `${i.isDirectory() ? 'dir' : 'file'}: ${i.name}`);

  collectedData.push({
    type: 'project_structure',
    source: 'root',
    content: rootItems.join('\n')
  });
  executedActions.push({ action: 'list_files', detail: '.', summary: `${rootItems.length}項目` });

  // Step 2: Analyze key source files
  const filesToAnalyze = [];
  const scanDirs = targetFolders.length > 0 ? targetFolders : ['.'];

  for (const dir of scanDirs) {
    const absDir = path.resolve(repoPath, dir);
    if (!fs.existsSync(absDir)) continue;

    const items = fs.readdirSync(absDir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name.endsWith('.js') && !item.name.includes('.summary.')) {
        filesToAnalyze.push(path.join(dir, item.name));
      }
      if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
        // One level deep
        try {
          const subItems = fs.readdirSync(path.join(absDir, item.name), { withFileTypes: true });
          for (const sub of subItems) {
            if (sub.isFile() && sub.name.endsWith('.js') && !sub.name.includes('.summary.')) {
              filesToAnalyze.push(path.join(dir, item.name, sub.name));
            }
          }
        } catch {}
      }
    }
  }

  // Analyze up to 5 files
  for (const relPath of filesToAnalyze.slice(0, 5)) {
    const absPath = path.resolve(repoPath, relPath);
    try {
      const code = fs.readFileSync(absPath, 'utf-8');
      const functions = extractFunctionsSimple(code);
      const imports = (code.match(/require\(['"]([^'"]+)['"]\)/g) || []).map(m => m.match(/['"]([^'"]+)['"]/)[1]);

      collectedData.push({
        type: 'code_analysis',
        source: relPath,
        content: `${code.split('\n').length}行, 関数: ${functions.join(', ')}\nimports: ${imports.join(', ')}\n---\n${code.slice(0, 800)}`
      });
      executedActions.push({ action: 'analyze_code', detail: relPath, summary: `${code.split('\n').length}行, ${functions.length}関数` });
    } catch {}
  }

  // Step 3: Recent git history
  const gitResult = await gitExec(['log', '-5', '--pretty=format:%h|%s|%ai'], repoPath);
  if (!gitResult.error && gitResult.output) {
    collectedData.push({
      type: 'git_history',
      source: 'recent commits',
      content: gitResult.output
    });
    executedActions.push({ action: 'git_log', detail: '5', summary: `${gitResult.output.split('\n').length}件` });
  }

  return { collectedData, executedActions };
}

/**
 * Generic gather using LLM tool calls (fallback for non-standard tasks).
 */
async function gatherGeneric(ollamaUrl, model, taskDescription, repoPath, workLogDir, onLog) {
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
- {"action": "done"}`;

  const collectedData = [];
  const executedActions = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < MAX_GATHER_STEPS; i++) {
    let prompt = `# タスク\n${taskDescription}\n\n`;
    if (recentLogs) prompt += `# 過去の調査メモ\n${recentLogs}\n\n`;

    if (executedActions.length > 0) {
      prompt += `# 実行済み\n`;
      for (const ea of executedActions) {
        prompt += `- ${ea.action}(${ea.detail}) → ${ea.summary}\n`;
      }
      prompt += `\n次のアクションをJSON形式で返してください。十分なら {"action": "done"}\n`;
    } else {
      prompt += `最初のアクションをJSON形式で返してください。\n`;
    }

    const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
    const action = parseAction((response.response || '').trim());

    if (!action) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) break;
      continue;
    }
    consecutiveFailures = 0;
    if (action.action === 'done') break;

    const detail = action.query || action.path || action.url || '';
    onLog('info', `Agent: ${action.action}${detail ? ` "${detail}"` : ''}`);

    const toolResult = await executeTool(action, repoPath, workLogDir);
    let contentForSummary = '';
    let summary = '';

    if (action.action === 'search_web' && toolResult.results) {
      contentForSummary = toolResult.results.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n');
      summary = `${toolResult.results.length}件`;
    } else if (action.action === 'fetch_page' && toolResult.text) {
      contentForSummary = toolResult.text.slice(0, 3000);
      summary = `${toolResult.text.length}文字`;
    } else if (action.action === 'read_file' && toolResult.content) {
      contentForSummary = toolResult.content.slice(0, 2000);
      summary = `${toolResult.content.length}文字`;
    } else if (action.action === 'list_files' && toolResult.items) {
      contentForSummary = toolResult.items.map(i => `${i.type}: ${i.name}`).join(', ');
      summary = `${toolResult.items.length}項目`;
    } else if (action.action === 'git_log' && toolResult.commits) {
      contentForSummary = toolResult.commits.map(c => `${c.hash} ${c.message}`).join('\n');
      summary = `${toolResult.commits.length}件`;
    } else if (action.action === 'analyze_code' && toolResult.functions) {
      contentForSummary = `${toolResult.lines}行, 関数: ${toolResult.functions.join(', ')}\n${toolResult.preview}`;
      summary = `${toolResult.lines}行, ${toolResult.functions.length}関数`;
    } else if (toolResult.error) {
      summary = `エラー: ${toolResult.error.slice(0, 50)}`;
    }

    executedActions.push({ action: action.action, detail: detail.slice(0, 80), summary });
    if (contentForSummary) {
      collectedData.push({ type: action.action, source: detail.slice(0, 100), content: contentForSummary });
    }
  }

  return { collectedData, executedActions };
}

// --- Phase 2: Summarize collected data ---

/**
 * Summarize collected data into structured insights.
 * Uses a single dedicated LLM call with all gathered content.
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
    const entry = `\n### ${d.source}\n${d.content}\n`;
    if (totalLen + entry.length > maxDataLen) {
      const remaining = maxDataLen - totalLen;
      if (remaining > 200) dataSection += entry.slice(0, remaining) + '\n...\n';
      break;
    }
    dataSection += entry;
    totalLen += entry.length;
  }

  const prompt = `以下のデータを分析して、重要な発見を日本語でまとめてください。

# テーマ
${taskDescription}

# 収集データ（${collectedData.length}件のソース）
${dataSection}

# 指示
上記のデータから重要な知見を抽出し、以下のJSON形式で返してください。
説明文は不要です。JSONのみ出力してください。

{"summary": "全体の要約を200文字以内で", "insights": ["具体的な発見1", "具体的な発見2", "具体的な発見3"]}`;

  const systemPrompt = 'データ分析の専門家として、収集データから知見を抽出してJSON形式で出力してください。JSONのみ返してください。余計な説明は不要です。';

  onLog('info', `Summarizing ${collectedData.length} sources...`);

  const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);
  const responseText = (response.response || '').trim();

  // Try to parse JSON (with or without "action" field)
  const obj = parseJson(responseText);
  if (obj && (obj.summary || obj.insights)) {
    return {
      summary: obj.summary || '',
      insights: Array.isArray(obj.insights) ? obj.insights : []
    };
  }

  // Last resort: use the raw response as both summary and insight
  onLog('debug', `Summary JSON parse failed, using raw text: ${responseText.slice(0, 80)}`);
  return {
    summary: responseText.slice(0, 300),
    insights: [responseText.slice(0, 500)]
  };
}

// --- Main entry point ---

/**
 * Run a two-phase agent loop:
 * 1. Gather: Collect data (web search, file reading, etc.)
 * 2. Summarize: Dedicated LLM call to produce structured insights
 *
 * @param {string} ollamaUrl - Ollama API URL
 * @param {string} model - Model name
 * @param {string} taskDescription - What to investigate
 * @param {string} repoPath - Repository root path
 * @param {object} options - { workLogDir, onLog, mode: 'research'|'analyze'|'generic' }
 */
async function runAgentLoop(ollamaUrl, model, taskDescription, repoPath, options = {}) {
  const workLogDir = options.workLogDir || path.join(repoPath, 'brain', 'work-logs');
  const onLog = options.onLog || (() => {});
  const mode = options.mode || 'generic';

  cleanOldWorkLogs(workLogDir);

  // Phase 1: Gather data based on mode
  let gatherResult;
  onLog('info', `Agent Phase 1: Gathering (${mode})...`);

  if (mode === 'research') {
    gatherResult = await gatherResearch(ollamaUrl, model, taskDescription, onLog);
  } else if (mode === 'analyze') {
    const targetFolders = options.targetFolders || ['.'];
    gatherResult = await gatherCodeAnalysis(repoPath, targetFolders, onLog);
  } else {
    gatherResult = await gatherGeneric(ollamaUrl, model, taskDescription, repoPath, workLogDir, onLog);
  }

  const { collectedData, executedActions } = gatherResult;
  onLog('info', `Gathered ${collectedData.length} sources in ${executedActions.length} steps`);

  // Phase 2: Summarize
  onLog('info', 'Agent Phase 2: Summarizing...');
  const { summary, insights } = await summarizeFindings(
    ollamaUrl, model, taskDescription, collectedData, onLog
  );
  onLog('info', `Summary complete: ${insights.length} insights`);

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
