'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// OllamaClient is passed as parameter to LLM-calling functions
const { searchWeb, fetchPage, searchArxiv, searchGitHub, classifySource } = require('../explorers/searcher');
const { sanitizeText, containsSensitiveData } = require('./evolution');
const { loadPrompt, fillPrompt } = require('../lib/prompt-loader');
const { validateSyntax } = require('../lib/sandbox');
const { validateCode } = require('../lib/configurator');
const { parseJsonSafe } = require('../lib/json-parser');

const MAX_GATHER_STEPS = 6;

/**
 * Parse a JSON action (object with "action" field) from LLM response.
 */
const parseAction = (responseText) => {
  const obj = parseJsonSafe(responseText);
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

const gitExec = (args, repoPath) => {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath, maxBuffer: 1024 * 512 }, (err, stdout) => {
      if (err) { resolve({ error: err.message }); return; }
      resolve({ output: stdout.trim() });
    });
  });
}

const extractFunctionsSimple = (code) => {
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

const executeTool = async (action, repoPath, workLogDir) => {
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
      case 'write_file': {
        if (!action.path) return { error: 'path is required' };
        if (!action.content && action.content !== '') return { error: 'content is required' };
        const filePath = path.resolve(repoPath, action.path);
        if (!filePath.startsWith(repoPath)) return { error: 'Access denied' };
        // Block writing outside allowed directories
        const relPath = path.relative(repoPath, filePath);
        const allowedPrefixes = ['brain/', 'scripts/', 'output/'];
        const isAllowed = allowedPrefixes.some(p => relPath.replace(/\\/g, '/').startsWith(p));
        if (!isAllowed) return { error: `Writing to ${relPath} is not allowed. Allowed: ${allowedPrefixes.join(', ')}` };
        // Check for sensitive data
        const sensitive = containsSensitiveData(action.content);
        if (sensitive.length > 0) return { error: 'Content contains sensitive data' };
        // Validate JS files: syntax + security
        if (filePath.endsWith('.js')) {
          const syntaxCheck = validateSyntax(action.content);
          if (!syntaxCheck.valid) return { error: `Syntax error: ${syntaxCheck.error}` };
          const codeCheck = validateCode(action.content);
          if (!codeCheck.valid) return { error: `Security issue: ${codeCheck.issues.filter(i => i.severity === 'critical').map(i => i.message).join(', ')}` };
        }
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, action.content, 'utf-8');
        return { path: action.path, written: true, size: action.content.length };
      }
      case 'edit_file': {
        if (!action.path) return { error: 'path is required' };
        if (!action.search) return { error: 'search string is required' };
        if (action.replace === undefined) return { error: 'replace string is required' };
        const filePath = path.resolve(repoPath, action.path);
        if (!filePath.startsWith(repoPath)) return { error: 'Access denied' };
        const relPath = path.relative(repoPath, filePath);
        const allowedPrefixes = ['brain/', 'scripts/', 'output/'];
        const isAllowed = allowedPrefixes.some(p => relPath.replace(/\\/g, '/').startsWith(p));
        if (!isAllowed) return { error: `Editing ${relPath} is not allowed. Allowed: ${allowedPrefixes.join(', ')}` };
        if (!fs.existsSync(filePath)) return { error: `File not found: ${action.path}` };
        let content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(action.search)) return { error: 'Search string not found in file' };
        content = content.replace(action.search, action.replace);
        // Validate JS files: syntax + security
        if (filePath.endsWith('.js')) {
          const syntaxCheck = validateSyntax(content);
          if (!syntaxCheck.valid) return { error: `Edit would cause syntax error: ${syntaxCheck.error}` };
          const codeCheck = validateCode(content);
          if (!codeCheck.valid) return { error: `Edit would introduce security issue: ${codeCheck.issues.filter(i => i.severity === 'critical').map(i => i.message).join(', ')}` };
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        return { path: action.path, edited: true };
      }
      case 'exec_command': {
        if (!action.command) return { error: 'command is required' };
        const cmd = action.command.trim();
        // Block dangerous commands
        const blockedPatterns = [
          /rm\s+-rf/i, /del\s+[/\\]/i, /format\s+/i, /mkfs/i,
          /shutdown/i, /reboot/i,
          /curl\s+.*\|\s*(sh|bash)/i, /wget\s+.*\|\s*(sh|bash)/i,
          /powershell/i, /cmd\s+\/c/i,
          /net\s+user/i, /net\s+localgroup/i,
          /reg\s+(add|delete)/i, /schtasks/i,
          />\s*\/dev\/sd/i, /dd\s+if=/i,
          /chmod\s+[0-7]*s/i, /chown\s+root/i,
          /npm\s+publish/i, /git\s+push/i,
          /ssh\s+/i, /scp\s+/i,
        ];
        for (const p of blockedPatterns) {
          if (p.test(cmd)) return { error: `Command blocked for safety: ${cmd.slice(0, 60)}` };
        }
        // Execute in isolated working directory (brain/output) instead of project root
        const safeCwd = path.resolve(repoPath, 'brain', 'output');
        if (!fs.existsSync(safeCwd)) fs.mkdirSync(safeCwd, { recursive: true });
        return new Promise((resolve) => {
          const { exec } = require('child_process');
          exec(cmd, { cwd: safeCwd, timeout: 30000, maxBuffer: 1024 * 256 }, (err, stdout, stderr) => {
            if (err) {
              resolve({ command: cmd, exitCode: err.code, stdout: (stdout || '').slice(0, 2000), stderr: (stderr || '').slice(0, 2000) });
            } else {
              resolve({ command: cmd, exitCode: 0, stdout: (stdout || '').slice(0, 2000), stderr: (stderr || '').slice(0, 500) });
            }
          });
        });
      }
      case 'search_code': {
        if (!action.pattern) return { error: 'pattern is required' };
        const searchDir = path.resolve(repoPath, action.path || '.');
        if (!searchDir.startsWith(repoPath)) return { error: 'Access denied' };
        const results = [];
        const searchPattern = action.pattern.toLowerCase();

        const searchInDir = (dir, depth) => {
          if (depth > 4 || results.length >= 20) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              searchInDir(fullPath, depth + 1);
            } else if (entry.isFile() && /\.(js|json|txt|md|html|css)$/.test(entry.name)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length && results.length < 20; i++) {
                  if (lines[i].toLowerCase().includes(searchPattern)) {
                    results.push({
                      file: path.relative(repoPath, fullPath),
                      line: i + 1,
                      text: lines[i].trim().slice(0, 200)
                    });
                  }
                }
              } catch {}
            }
          }
        }

        searchInDir(searchDir, 0);
        return { pattern: action.pattern, matches: results };
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

const loadRecentWorkLogs = (workLogDir, maxEntries = 5) => {
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

const cleanOldWorkLogs = (workLogDir, maxAgeHours = 72) => {
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
const gatherResearch = async (client, taskDescription, onLog, options = {}) => {
  const collectedData = [];
  const executedActions = [];
  const visitedUrls = new Set(options.visitedUrls || []);
  const newlyVisited = [];

  // Build context notes for query generation
  let visitedNote = '';
  if (visitedUrls.size > 0) {
    const sample = [...visitedUrls].slice(-20).map(u => u.slice(0, 60));
    visitedNote = '## 注意: 以下のURLは既に訪問済みです。異なる情報源を見つけるクエリにしてください。\n' + sample.join('\n');
  }

  let similarNote = '';
  if (options.recentTopics && options.recentTopics.length > 3) {
    similarNote = '## 注意: 最近の検索結果が似通っています。関連するが異なる視点のキーワードで検索してください。\n最近のトピック: ' + options.recentTopics.slice(-5).join(', ');
  }

  let goalNote = '';
  if (options.goalPrompt && options.goalPrompt !== 'なし') {
    goalNote = '## 最終目標（検索結果がこの目標に関連するようにしてください）\n' + options.goalPrompt;
  }

  // Build keyword combination context from graph search pairs
  let keywordPairsNote = '';
  if (options.searchPairs && options.searchPairs.length > 0) {
    keywordPairsNote = '## キーワード組み合わせ検索（以下のキーワードペアを組み合わせたクエリを必ず1つ以上含めてください）\n' +
      options.searchPairs.map(p => `- 「${p.weak}」と「${p.strong}」の関連性を調べるクエリ`).join('\n') +
      '\n※ 孤立したキーワードではなく、複数キーワードを組み合わせて関連性を発見するクエリにしてください。';
  }

  // Step 1: Ask LLM for search queries based on the task
  onLog('info', 'Generating search queries...');
  const queryPrompt = fillPrompt('search-queries.user', {
    taskDescription,
    visitedNote,
    similarNote,
    goalNote,
    keywordPairsNote
  });

  let queryResponse;
  try {
    queryResponse = await client.query(queryPrompt);
  } catch (e) {
    onLog('warn', `Query generation LLM call failed: ${e.message}`);
    queryResponse = { response: '' };
  }
  const queryText = (queryResponse.response || '').trim();

  let queries = [];
  const parsed = parseJsonSafe(queryText);
  if (parsed && parsed.queries && Array.isArray(parsed.queries)) {
    queries = parsed.queries.slice(0, 3);
  }

  // Fallback: if LLM failed to generate queries, extract keywords from task
  if (queries.length === 0) {
    onLog('debug', 'Query generation failed, using task description as query');
    queries = [taskDescription.slice(0, 80)];
  }

  // Step 2: Execute searches in parallel, then batch-fetch pages
  let totalSearchResults = 0;

  // Run all web searches + arxiv + github concurrently
  const englishQuery = queries.map(q => q.replace(/[^\x20-\x7E]/g, '').trim())
    .find(q => q.length >= 3) || taskDescription.replace(/[^\x20-\x7E]/g, '').trim();

  const searchPromises = queries.map(q => searchWeb(q, 5).catch(() => []));
  if (englishQuery && englishQuery.length >= 3) {
    searchPromises.push(searchArxiv(englishQuery, 5).catch(() => []));
    searchPromises.push(searchGitHub(englishQuery, 3).catch(() => []));
  }

  onLog('info', `Searching ${searchPromises.length} sources in parallel (web + arxiv + github)...`);
  const searchResultSets = await Promise.all(searchPromises);

  // Collect search results and URLs to fetch
  const pagesToFetch = [];
  const hasGitHub = englishQuery && englishQuery.length >= 3;
  const hasArxiv = englishQuery && englishQuery.length >= 3;
  const webResultCount = queries.length;

  for (let i = 0; i < webResultCount && i < searchResultSets.length; i++) {
    const searchResults = searchResultSets[i];
    totalSearchResults += searchResults.length;

    if (searchResults.length > 0) {
      collectedData.push({
        type: 'search_results',
        source: queries[i],
        content: searchResults.map(r => `- ${r.title}: ${r.snippet || ''}`).join('\n')
      });

      for (const result of searchResults) {
        if (!result.url || result.url.includes('duckduckgo.com')) continue;
        if (visitedUrls.has(result.url)) continue;
        const srcInfo = classifySource(result.url);
        pagesToFetch.push({
          url: result.url,
          title: result.title,
          type: 'web_page',
          credibility: srcInfo.credibility,
          sourceType: srcInfo.type
        });
      }
    }
  }

  // Handle arxiv results
  if (hasArxiv) {
    const arxivIdx = webResultCount;
    const papers = searchResultSets[arxivIdx] || [];
    if (papers.length > 0) {
      collectedData.push({
        type: 'arxiv_papers',
        source: `arxiv: ${englishQuery.slice(0, 60)}`,
        content: papers.map(p => `- ${p.title}: ${(p.summary || '').slice(0, 600)}`).join('\n')
      });

      for (const paper of papers.slice(0, 3)) {
        if (paper.url && !visitedUrls.has(paper.url)) {
          // Use abs URL for richer HTML content
          const absUrl = paper.url.replace('/pdf/', '/abs/').replace(/\.pdf$/, '');
          pagesToFetch.push({
            url: absUrl,
            title: paper.title,
            type: 'arxiv_page',
            maxLen: 6000,
            credibility: 1.0,
            sourceType: 'academic'
          });
        }
      }
    }
  }

  // Handle GitHub results
  if (hasGitHub) {
    const ghIdx = webResultCount + (hasArxiv ? 1 : 0);
    const repos = searchResultSets[ghIdx] || [];
    if (repos.length > 0) {
      collectedData.push({
        type: 'github_repos',
        source: `github: ${englishQuery.slice(0, 60)}`,
        content: repos.map(r => `- ${r.title}: ${r.snippet || ''}`).join('\n')
      });

      for (const repo of repos.slice(0, 2)) {
        if (repo.url && !visitedUrls.has(repo.url)) {
          pagesToFetch.push({
            url: repo.url,
            title: repo.title,
            type: 'github_page',
            credibility: 0.9,
            sourceType: 'repository'
          });
        }
      }
    }
  }

  // Sort pages by credibility: academic > github > docs > other > blogs
  pagesToFetch.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));

  // Fetch top pages (limit to avoid overload, but prioritize high-credibility)
  const maxPages = 7;
  const toFetch = pagesToFetch.slice(0, maxPages);

  if (toFetch.length > 0) {
    const typeBreakdown = {};
    for (const p of toFetch) { typeBreakdown[p.sourceType || 'other'] = (typeBreakdown[p.sourceType || 'other'] || 0) + 1; }
    onLog('info', `Fetching ${toFetch.length} pages by credibility: ${Object.entries(typeBreakdown).map(([k,v]) => `${k}:${v}`).join(', ')}`);

    const fetchResults = await Promise.all(
      toFetch.map(p => fetchPage(p.url, p.maxLen || 4000).catch(() => ({ url: p.url, error: 'fetch failed' })))
    );

    for (let i = 0; i < fetchResults.length; i++) {
      const page = fetchResults[i];
      const meta = toFetch[i];
      newlyVisited.push(meta.url);

      if (page.text && page.text.length > 100) {
        collectedData.push({
          type: meta.type,
          source: `[${meta.sourceType}] ${(meta.title || meta.url.split('/').slice(2, 4).join('/')).slice(0, 60)}`,
          url: meta.url,
          content: page.text.slice(0, 3000),
          credibility: meta.credibility,
          sourceType: meta.sourceType
        });
      }
    }
  }

  // Step 3: If search failed (rate limited), ask LLM for URLs to try directly
  if (totalSearchResults === 0) {
    onLog('info', 'Search returned no results, asking LLM for source URLs...');

    const urlPrompt = fillPrompt('search-fallback-urls.user', { taskDescription });

    const urlResponse = await client.query(urlPrompt);
    const urlObj = parseJsonSafe((urlResponse.response || '').trim());

    if (urlObj && urlObj.urls && Array.isArray(urlObj.urls)) {
      const urlsToFetch = urlObj.urls.slice(0, 4).filter(url => url && url.startsWith('http') && !visitedUrls.has(url));
      if (urlsToFetch.length > 0) {
        onLog('info', `Direct fetch (parallel): ${urlsToFetch.length} URLs`);
        const pages = await Promise.all(
          urlsToFetch.map(url => fetchPage(url, 4000).catch(() => ({ url, text: '' })))
        );
        for (let i = 0; i < urlsToFetch.length; i++) {
          newlyVisited.push(urlsToFetch[i]);
          if (pages[i].text && pages[i].text.length > 100) {
            collectedData.push({
              type: 'web_page',
              source: urlsToFetch[i].slice(0, 80),
              content: pages[i].text.slice(0, 3000)
            });
          }
        }
      }
    }
  }

  return { collectedData, executedActions, visitedUrls: newlyVisited };
}

/**
 * Gather data for code analysis tasks.
 * Systematically reads project files without relying on LLM tool calls.
 */
const gatherCodeAnalysis = async (repoPath, targetFolders, onLog) => {
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
const gatherGeneric = async (client, taskDescription, repoPath, workLogDir, onLog) => {
  const recentLogs = loadRecentWorkLogs(workLogDir);

  const systemPrompt = loadPrompt('gather-generic.system');

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

    const response = await client.query(prompt, systemPrompt);
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
    } else if (action.action === 'search_code' && toolResult.matches) {
      contentForSummary = toolResult.matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
      summary = `${toolResult.matches.length}件`;
    } else if (action.action === 'exec_command') {
      contentForSummary = (toolResult.stdout || toolResult.stderr || '').slice(0, 2000);
      summary = `exit=${toolResult.exitCode}`;
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

/**
 * Gather data and execute actions for development tasks.
 * Uses LLM tool calls with the full tool set including write_file, exec_command, etc.
 */
const gatherDevelop = async (client, taskDescription, repoPath, workLogDir, onLog, options = {}) => {
  const recentLogs = loadRecentWorkLogs(workLogDir);
  const systemPrompt = loadPrompt('gather-develop.system');
  const MAX_DEV_STEPS = 10;

  const collectedData = [];
  const executedActions = [];
  let consecutiveFailures = 0;

  for (let i = 0; i < MAX_DEV_STEPS; i++) {
    let prompt = `# タスク\n${taskDescription}\n\n`;

    if (options.goalContext) {
      prompt += `# ゴール進捗\n${options.goalContext}\n\n`;
    }

    if (recentLogs) prompt += `# 過去の作業メモ\n${recentLogs}\n\n`;

    if (executedActions.length > 0) {
      prompt += `# 実行済みアクション\n`;
      for (const ea of executedActions) {
        prompt += `- ${ea.action}(${ea.detail}) → ${ea.summary}\n`;
      }
      prompt += `\n次のアクションをJSON形式で返してください。完了なら {"action": "done"}\n`;
    } else {
      prompt += `最初のアクションをJSON形式で返してください。\n`;
    }

    let response = await client.query(prompt, systemPrompt, { model: options.model });
    let action = parseAction((response.response || '').trim());

    // If parsing failed, retry once with explicit JSON-only instruction
    if (!action) {
      onLog('debug', 'Dev action parse failed, retrying with JSON reminder');
      const retryPrompt = prompt + '\n\n前回の応答がJSONとして解析できませんでした。説明文なしでJSON形式のみで回答してください。例: {"action": "read_file", "path": "brain/"}';
      response = await client.query(retryPrompt, systemPrompt, { model: options.model });
      action = parseAction((response.response || '').trim());
    }

    if (!action) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) break;
      continue;
    }
    consecutiveFailures = 0;
    if (action.action === 'done') break;

    const detail = action.query || action.path || action.url || action.command || action.pattern || '';
    onLog('info', `Dev Agent: ${action.action}${detail ? ` "${detail.slice(0, 60)}"` : ''}`);

    const toolResult = await executeTool(action, repoPath, workLogDir);
    let contentForSummary = '';
    let summary = '';

    if (toolResult.error) {
      summary = `エラー: ${toolResult.error.slice(0, 80)}`;
      contentForSummary = toolResult.error;
    } else if (action.action === 'write_file' && toolResult.written) {
      summary = `${toolResult.size}文字書き込み`;
      contentForSummary = `Written: ${toolResult.path} (${toolResult.size} chars)`;
    } else if (action.action === 'edit_file' && toolResult.edited) {
      summary = '編集成功';
      contentForSummary = `Edited: ${toolResult.path}`;
    } else if (action.action === 'exec_command') {
      summary = `exit=${toolResult.exitCode}`;
      contentForSummary = (toolResult.stdout || toolResult.stderr || '').slice(0, 2000);
    } else if (action.action === 'search_code' && toolResult.matches) {
      summary = `${toolResult.matches.length}件`;
      contentForSummary = toolResult.matches.map(m => `${m.file}:${m.line}: ${m.text}`).join('\n');
    } else if (action.action === 'read_file' && toolResult.content) {
      contentForSummary = toolResult.content.slice(0, 2000);
      summary = `${toolResult.content.length}文字`;
    } else if (action.action === 'list_files' && toolResult.items) {
      contentForSummary = toolResult.items.map(i => `${i.type}: ${i.name}`).join(', ');
      summary = `${toolResult.items.length}項目`;
    } else if (action.action === 'search_web' && toolResult.results) {
      contentForSummary = toolResult.results.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
      summary = `${toolResult.results.length}件`;
    } else if (action.action === 'analyze_code' && toolResult.functions) {
      contentForSummary = `${toolResult.lines}行, 関数: ${toolResult.functions.join(', ')}\n${toolResult.preview}`;
      summary = `${toolResult.lines}行, ${toolResult.functions.length}関数`;
    } else if (action.action === 'fetch_page' && toolResult.text) {
      contentForSummary = toolResult.text.slice(0, 3000);
      summary = `${toolResult.text.length}文字`;
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
const summarizeFindings = async (client, taskDescription, collectedData, onLog) => {
  if (collectedData.length === 0) {
    return { summary: '', insights: [], empty: true };
  }

  // Prioritize actual page content over search result metadata (links)
  // Sort: fetched pages first, then arxiv/github content, search result listings last
  const contentPriority = { web_page: 0, arxiv_page: 0, github_page: 0, code_analysis: 1, git_history: 1, arxiv_papers: 2, github_repos: 2, search_results: 3 };
  const sorted = [...collectedData].sort((a, b) =>
    (contentPriority[a.type] ?? 1) - (contentPriority[b.type] ?? 1)
  );

  // Build the data section, keeping total size manageable
  let dataSection = '';
  let totalLen = 0;
  const maxDataLen = 6000;

  for (const d of sorted) {
    // For search_results type, only include a brief mention, not the full link list
    let content = d.content;
    if (d.type === 'search_results') {
      content = content.slice(0, 300);
    }
    const entry = `\n### ${d.source}\n${content}\n`;
    if (totalLen + entry.length > maxDataLen) {
      const remaining = maxDataLen - totalLen;
      if (remaining > 200) dataSection += entry.slice(0, remaining) + '\n...\n';
      break;
    }
    dataSection += entry;
    totalLen += entry.length;
  }

  const prompt = fillPrompt('summarize-findings.user', {
    taskDescription,
    sourceCount: String(collectedData.length),
    dataSection
  });

  onLog('info', `Summarizing ${collectedData.length} sources...`);

  // Retry up to 2 times on LLM failure
  const MAX_SUMMARIZE_RETRIES = 2;
  let responseText = '';

  for (let attempt = 1; attempt <= MAX_SUMMARIZE_RETRIES; attempt++) {
    try {
      const response = await client.query(prompt);
      responseText = (response.response || '').trim();
      break;
    } catch (e) {
      onLog('warn', `Summarize LLM call failed (attempt ${attempt}/${MAX_SUMMARIZE_RETRIES}): ${e.message}`);
      if (attempt === MAX_SUMMARIZE_RETRIES) {
        onLog('warn', 'Summarization failed after retries, discarding');
        return { summary: '', insights: [], empty: true };
      }
    }
  }

  if (!responseText) {
    return { summary: '', insights: [], empty: true };
  }

  // Try to parse JSON (with or without "action" field)
  const obj = parseJsonSafe(responseText);
  if (obj && (obj.summary || obj.insights)) {
    return {
      summary: obj.summary || '',
      insights: Array.isArray(obj.insights) ? obj.insights : []
    };
  }

  // Last resort: use the raw response as summary if it looks like content (not error/garbage)
  if (responseText.length > 20 && !/^[\s\{\[<]/.test(responseText)) {
    return {
      summary: responseText.slice(0, 300),
      insights: [responseText.slice(0, 500)]
    };
  }

  onLog('debug', `Summary parse failed, discarding: ${responseText.slice(0, 80)}`);
  return { summary: '', insights: [], empty: true };
}

// --- Main entry point ---

/**
 * Run a two-phase agent loop:
 * 1. Gather: Collect data (web search, file reading, etc.)
 * 2. Summarize: Dedicated LLM call to produce structured insights
 *
 * @param {import('../lib/ollama-client').OllamaClient} client - Ollama client
 * @param {string} taskDescription - What to investigate
 * @param {string} repoPath - Repository root path
 * @param {object} options - { workLogDir, onLog, mode: 'research'|'analyze'|'develop'|'generic' }
 */
const runAgentLoop = async (client, taskDescription, repoPath, options = {}) => {
  const workLogDir = options.workLogDir || path.join(repoPath, 'brain', 'work-logs');
  const onLog = options.onLog || (() => {});
  const mode = options.mode || 'generic';

  cleanOldWorkLogs(workLogDir);

  // Phase 1: Gather data based on mode
  let gatherResult;
  onLog('info', `Agent Phase 1: Gathering (${mode})...`);

  if (mode === 'research') {
    gatherResult = await gatherResearch(client, taskDescription, onLog, {
      visitedUrls: options.visitedUrls || [],
      recentTopics: options.recentTopics || [],
      goalPrompt: options.goalPrompt,
      searchPairs: options.searchPairs || []
    });
  } else if (mode === 'analyze') {
    const targetFolders = options.targetFolders || ['.'];
    gatherResult = await gatherCodeAnalysis(repoPath, targetFolders, onLog);
  } else if (mode === 'develop') {
    gatherResult = await gatherDevelop(client, taskDescription, repoPath, workLogDir, onLog, {
      goalContext: options.goalContext || '',
      model: options.model
    });
  } else {
    gatherResult = await gatherGeneric(client, taskDescription, repoPath, workLogDir, onLog);
  }

  const { collectedData, executedActions } = gatherResult;
  onLog('info', `Gathered ${collectedData.length} sources in ${executedActions.length} steps`);

  // Phase 2: Summarize
  onLog('info', 'Agent Phase 2: Summarizing...');
  const summarizeResult = await summarizeFindings(
    client, taskDescription, collectedData, onLog
  );
  const { summary, insights } = summarizeResult;
  if (summarizeResult.empty) {
    onLog('info', 'Summary empty (LLM failed or no data), skipping persistence');
  } else {
    onLog('info', `Summary complete: ${insights.length} insights`);
  }

  // Extract source URLs from collected data
  const sourceUrls = [];
  for (const d of collectedData) {
    if (d.url) { sourceUrls.push(d.url); continue; }
    const urlMatch = (d.source || '').match(/https?:\/\/[^\s)]+/);
    if (urlMatch) sourceUrls.push(urlMatch[0]);
  }

  // Build credibility map from collected data
  const credibilityMap = {};
  for (const d of collectedData) {
    if (d.credibility !== undefined) {
      const url = d.url || ((d.source || '').match(/https?:\/\/[^\s)]+/) || [])[0];
      if (url) credibilityMap[url] = d.credibility;
    }
  }

  const finalResult = {
    summary,
    insights,
    empty: summarizeResult.empty || false,
    sources: [...new Set(sourceUrls)],
    visitedUrls: gatherResult.visitedUrls || [],
    credibilityMap,
    dataSourceCount: collectedData.length,
    executedActions: executedActions || []
  };

  // Save work log (skip if summary was empty/failed)
  if (!summarizeResult.empty) {
    if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(workLogDir, `${timestamp}_agent-result.json`);
    const safeResult = JSON.parse(sanitizeText(JSON.stringify({
      task: taskDescription.slice(0, 200),
      summary: finalResult.summary,
      insights: finalResult.insights,
      sources: collectedData.map(d => d.source)
    })));
    fs.writeFileSync(logFile, JSON.stringify(safeResult, null, 2), 'utf-8');
  }

  return finalResult;
}

module.exports = { runAgentLoop, executeTool, loadRecentWorkLogs };
