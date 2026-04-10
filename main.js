'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { TaskManager, createTask } = require('./core/task-manager');
const {
  dreamPhase, proposeRefactor, applyRefactor,
  getLastCommit,
  saveKnowledge, autoCommit, sanitizeText,
  generateModule, chat, getNewKnowledge, getAllKnowledge, compressKnowledge,
  reviewScripts
} = require('./core/evolution');
const { doubleCheck } = require('./explorers/verifier');
const { OllamaClient } = require('./lib/ollama-client');
const { analyzeFolder, analyzeFolderWithLLM, scanDirectory } = require('./lib/analyzer');
const { runAgentLoop } = require('./core/agent-loop');
const { loadConfig } = require('./lib/configurator');
const { loadPrompt, fillPrompt } = require('./lib/prompt-loader');
const { parseJsonSafe } = require('./lib/json-parser');
const { runSetup } = require('./lib/setup');
const { startWatcher } = require('./lib/watcher');
const { startCLI } = require('./lib/cli');
const { updateGraph, reviewGraph, pruneGraph, processUnindexedEntries, getUnderExplored, getSuggestedSearchPairs, strengthenSearchPairConnections, getGraphStats, getGraphData, deleteNode, autoConnect, searchGraphNodes } = require('./core/knowledge-graph');
const { decomposeGoal, getNextSubtask, updateSubtask, evaluateProgress, getGoalSummary } = require('./core/goal-manager');
const { recordOutcome, getFeedbackSummary, isActionUnreliable } = require('./core/feedback-tracker');
const { execSync } = require('child_process');
const { AnalyzeLoop } = require('./core/analyze/analyze-loop');
const { parseSummaryMarkdown } = require('./core/analyze/structural-analyzer');
const { loadJsonFile, saveJsonFile, ensureDir } = require('./lib/file-utils');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');

// --- State ---
const logs = [];
const maxLogs = 500;
let logWriter = null; // overridable by CLI

const log = (level, message, data) => {
  const entry = { timestamp: new Date().toISOString(), level, message, data };
  logs.push(entry);
  if (logs.length > maxLogs) logs.shift();
  if (logWriter) {
    logWriter(level, message, data);
  } else if (level !== 'debug') {
    console.log(`[${entry.timestamp}] [${level}] ${message}`);
  }
};

// --- Chat History ---
const CHAT_HISTORY_PATH = path.join(ROOT, 'brain', 'chat-history.json');
const MAX_CHAT_HISTORY = 200;

const loadChatHistory = () => {
  return loadJsonFile(CHAT_HISTORY_PATH, []);
}

let _chatWriting = false;

const saveChatMessage = (role, text) => {
  // Simple guard to prevent interleaved reads/writes
  if (_chatWriting) {
    setTimeout(() => saveChatMessage(role, text), 50);
    return;
  }
  _chatWriting = true;
  try {
    const history = loadChatHistory();
    history.push({ role, text, timestamp: new Date().toISOString() });
    while (history.length > MAX_CHAT_HISTORY) history.shift();
    saveJsonFile(CHAT_HISTORY_PATH, history, false);
  } finally {
    _chatWriting = false;
  }
}

// --- Chat Report: buffered batch reporting ---
// Accumulate findings and report periodically instead of after every action.
// Flushes when: buffer reaches REPORT_BATCH_SIZE, or REPORT_INTERVAL_MS elapses.

const REPORT_BATCH_SIZE = 3;
const REPORT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let reportBuffer = [];
let reportTimer = null;

const bufferChatReport = (topic, findings) => {
  if (findings && findings.empty) return;
  const findingsText = typeof findings === 'string' ? findings
    : `${findings.summary || ''}\n${
        Array.isArray(findings.insights)
          ? findings.insights.map(i => typeof i === 'string' ? i : (i.insight || i.finding || JSON.stringify(i))).slice(0, 5).join('\n')
          : ''
      }`;
  reportBuffer.push({ topic, text: findingsText.trim(), timestamp: new Date().toISOString() });

  // Flush if buffer is full
  if (reportBuffer.length >= REPORT_BATCH_SIZE) {
    flushChatReport();
  } else if (!reportTimer) {
    // Start timer for partial buffer flush
    reportTimer = setTimeout(flushChatReport, REPORT_INTERVAL_MS);
  }
};

const flushChatReport = () => {
  if (reportTimer) { clearTimeout(reportTimer); reportTimer = null; }
  if (reportBuffer.length === 0 || !ollamaClient) return;
  const items = reportBuffer.splice(0);
  // Fire-and-forget
  (async () => {
    try {
      const history = loadChatHistory();
      // Include enough history to detect what was already reported
      const assistantMessages = history
        .filter(m => m.role === 'assistant')
        .slice(-10)
        .map(m => m.text.slice(0, 300));
      const recentChat = history.slice(-6).map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 200)}`
      ).join('\n');
      const alreadyReported = assistantMessages.join('\n');

      // Format all buffered findings
      const findingsSummary = items.map((item, i) =>
        `### 調査${i + 1}: ${item.topic}\n${item.text.slice(0, 800)}`
      ).join('\n\n');

      const prompt = `## 最近のチャット履歴:\n${recentChat || '(履歴なし)'}\n\n## 過去の報告済み内容（これらと重複する内容は絶対に報告しないでください）:\n${alreadyReported.slice(0, 2000) || '(なし)'}\n\n## 最近の調査結果（${items.length}件）:\n${findingsSummary.slice(0, 3000)}\n\n上記の調査結果のうち、「過去の報告済み内容」にまだ含まれていない新しい発見だけを報告してください。既に報告した内容を繰り返してはいけません。全て既知であれば「新しい発見はありませんでした」と一言だけ返してください。`;
      const systemPrompt = loadPrompt('chat-report.system');
      const response = await ollamaClient.query(prompt, systemPrompt);
      let reply = (response.response || '').trim();
      // Strip any file name/path references that the LLM may have included
      reply = reply.replace(/[A-Za-z0-9_\-]+\.(txt|json|jsonl|csv|md|js|py|yaml|yml|xml|bak|log|tmp)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
      // Skip trivial/no-news replies
      if (reply && reply.length > 10 && !/^新しい発見はありませんでした/.test(reply)) {
        saveChatMessage('assistant', reply);
      }
    } catch (e) {
      log('debug', `Batch chat report failed: ${e.message}`);
    }
  })();
};

// --- Curiosity System ---
const CURIOSITIES_PATH = path.join(ROOT, 'brain', 'curiosities.json');
const MAX_CURIOSITIES = 100;

const loadCuriosities = () => {
  return loadJsonFile(CURIOSITIES_PATH, []);
}

const saveCuriosities = (items) => {
  saveJsonFile(CURIOSITIES_PATH, items.slice(-MAX_CURIOSITIES));
}

const addCuriosity = (topic, source) => {
  const items = loadCuriosities();
  const isDupe = items.some(c => !c.explored && c.topic.slice(0, 30) === topic.slice(0, 30));
  if (isDupe) return;
  items.push({ topic, source, timestamp: new Date().toISOString(), explored: false });
  saveCuriosities(items);
}

const getNextCuriosity = () => {
  const items = loadCuriosities();
  return items.find(c => !c.explored) || null;
}

const markCuriosityExplored = (topic) => {
  const items = loadCuriosities();
  const item = items.find(c => c.topic === topic && !c.explored);
  if (item) {
    item.explored = true;
    item.exploredAt = new Date().toISOString();
    saveCuriosities(items);
  }
}

// --- Config ---
let config;
let ollamaClient = null;

// --- Server & Timer state (for restart) ---
let httpServer = null;
let dreamTimer = null;
let restarting = false;
let analyzeLoop = null;

// --- Task Manager ---
const taskManager = new TaskManager();

taskManager.on('task:start', (task) => log('debug', `Task started: ${task?.name}`));
taskManager.on('task:complete', ({ task }) => log('debug', `Task completed: ${task?.name}`));
taskManager.on('task:error', ({ task, error }) => log('error', `Task failed: ${task?.name || 'unknown'} — ${error?.message}`));

taskManager.on('idle', () => {
  if (restarting) return;
  try {
    scheduleAutonomousTasks();
  } catch (e) {
    log('error', `Failed to schedule autonomous cycle: ${e.message}`);
    // Safety: retry after delay to prevent permanent stall
    setTimeout(() => {
      if (!restarting && !taskManager.currentTask && taskManager.queue.length === 0) {
        log('info', 'Recovery: re-seeding autonomous loop after idle failure');
        try { scheduleAutonomousTasks(); } catch (e2) {
          log('error', `Recovery also failed: ${e2.message}`);
        }
      }
    }, 10000);
  }
});

// --- Watchdog: detect and recover from stalled loops ---
const WATCHDOG_INTERVAL = 120000; // check every 2 minutes
const WATCHDOG_STALL_THRESHOLD = 600000; // 10 minutes with no activity = stalled

setInterval(() => {
  if (restarting || taskManager.paused) return;

  const now = Date.now();
  const lastActivity = taskManager.lastActivityTime || now;
  const elapsed = now - lastActivity;
  const hasWork = taskManager.currentTask || taskManager.queue.length > 0;

  // Case 1: No current task and empty queue — loop died
  if (!taskManager.currentTask && taskManager.queue.length === 0 && taskManager.running) {
    log('warn', `Watchdog: loop idle with empty queue (last activity ${Math.round(elapsed / 1000)}s ago). Re-seeding...`);
    try { scheduleAutonomousTasks(); } catch (e) {
      log('error', `Watchdog re-seed failed: ${e.message}`);
    }
    return;
  }

  // Case 2: A task has been running for too long (stuck)
  if (taskManager.currentTask && elapsed > WATCHDOG_STALL_THRESHOLD) {
    log('warn', `Watchdog: task '${taskManager.currentTask.name}' appears stalled (${Math.round(elapsed / 1000)}s). Force-cycling...`);
    // Force clear and re-seed
    taskManager.currentTask = null;
    taskManager.queue = [];
    try { scheduleAutonomousTasks(); } catch (e) {
      log('error', `Watchdog force-cycle failed: ${e.message}`);
    }
  }
}, WATCHDOG_INTERVAL);

// --- Helper: visited URL tracking (with quality metadata) ---
const VISITED_URLS_PATH = path.join(ROOT, 'brain', 'visited-urls.json');

const loadVisitedUrlsRaw = () => {
  const data = loadJsonFile(VISITED_URLS_PATH, []);
  // Support migration from old format (plain array of strings)
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
    return data.map(url => ({ url, credibility: 0.5, visitedAt: new Date().toISOString() }));
  }
  return Array.isArray(data) ? data : [];
}

const loadVisitedUrls = () => {
  return loadVisitedUrlsRaw().map(e => typeof e === 'string' ? e : e.url);
}

const saveVisitedUrlsRaw = (entries) => {
  saveJsonFile(VISITED_URLS_PATH, entries);
}

const addVisitedUrls = (newUrls, credibilityMap) => {
  const existing = loadVisitedUrlsRaw();
  const urlIndex = new Map(existing.map(e => [e.url, e]));
  const now = new Date().toISOString();

  for (const url of newUrls) {
    if (!url || typeof url !== 'string') continue;
    if (!urlIndex.has(url)) {
      urlIndex.set(url, {
        url,
        credibility: (credibilityMap && credibilityMap[url]) || 0.5,
        visitedAt: now
      });
    }
  }

  saveVisitedUrlsRaw([...urlIndex.values()]);
}

// Periodic cleanup: remove low-quality URLs older than 30 days, keep high-quality ones
const cleanupVisitedUrls = () => {
  const entries = loadVisitedUrlsRaw();
  if (entries.length < 1000) return; // no need to clean small lists

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cleaned = entries.filter(e => {
    const age = new Date(e.visitedAt || 0).getTime();
    // Keep: high-credibility (>= 0.7), or recent (< 30 days), or unknown age
    if ((e.credibility || 0.5) >= 0.7) return true;
    if (!e.visitedAt) return true;
    return age > thirtyDaysAgo;
  });

  if (cleaned.length < entries.length) {
    log('info', `URL cleanup: removed ${entries.length - cleaned.length} low-quality old URLs (${cleaned.length} remaining)`);
    saveVisitedUrlsRaw(cleaned);
  }
};

// --- Helper: detect research intent from user chat and store as curiosity ---

const detectAndStoreCuriosity = (client, userMessage, recentHistory) => {
  // Fire-and-forget — don't block the chat response
  (async () => {
    try {
      const systemPrompt = loadPrompt('detect-research-intent.system');
      // Include recent conversation context so intent detection considers the full exchange
      let prompt = userMessage;
      if (recentHistory && recentHistory.length > 0) {
        const historyStr = recentHistory.map(m =>
          `${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${m.text.slice(0, 200)}`
        ).join('\n');
        prompt = `## 直近の会話:\n${historyStr}\n\n## 最新のメッセージ:\n${userMessage}`;
      }
      const response = await client.query(prompt, systemPrompt);
      const text = (response.response || '').trim();
      const parsed = parseJsonSafe(text);
      if (!parsed) return;
      if (parsed.isResearch && parsed.searchPrompt && parsed.searchPrompt !== 'null') {
        addCuriosity(parsed.searchPrompt, 'user_chat');
        log('info', `Curiosity recorded from chat: "${parsed.searchPrompt.slice(0, 80)}"`);

        // Update searchPrompt so the next research cycle targets this topic
        try {
          const settingsPath = path.join(ROOT, 'config', 'settings.json');
          const current = loadJsonFile(settingsPath, {});
          current.searchPrompt = parsed.searchPrompt;
          saveJsonFile(settingsPath, current);
          config.searchPrompt = parsed.searchPrompt;
          log('info', `searchPrompt updated from chat: "${parsed.searchPrompt.slice(0, 80)}"`);
        } catch (e2) {
          log('warn', `Failed to update searchPrompt: ${e2.message}`);
        }
      }
    } catch (e) {
      log('debug', `Research intent detection failed: ${e.message}`);
    }
  })();
};

// --- Helper: supplement chat with background search ---
const supplementChatWithSearch = (client, userMessage, initialReply, existingKnowledge) => {
  // Fire-and-forget: check if reply indicates insufficient knowledge, then search
  (async () => {
    try {
      const checkPrompt = `以下の質問と回答を分析してください。
回答が明確に「わかりません」「情報がありません」「調査します」等と述べている場合のみ needsSearch: true を返してください。
回答に何らかの具体的な情報が含まれている場合は needsSearch: false です。

質問: ${userMessage.slice(0, 200)}
回答: ${initialReply.slice(0, 300)}

JSON形式で返してください: {"needsSearch": true/false, "searchQuery": "検索クエリ（needsSearchがtrueの場合）"}`;

      const response = await client.query(checkPrompt, 'JSONのみ出力してください。');
      const text = (response.response || '').trim();
      const parsed = parseJsonSafe(text);
      if (!parsed) return;
      if (!parsed.needsSearch || !parsed.searchQuery) return;

      log('info', `Supplementing chat with search: "${parsed.searchQuery.slice(0, 60)}"`);

      // Run a quick research loop
      const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
      const result = await runAgentLoop(client, parsed.searchQuery, ROOT, {
        workLogDir, onLog: log, mode: 'research',
        visitedUrls: loadVisitedUrls()
      });

      if (result.visitedUrls && result.visitedUrls.length > 0) {
        addVisitedUrls(result.visitedUrls, result.credibilityMap);
      }

      if (result.empty) return;

      // Save the supplementary research
      const hasData = !result.empty &&
                      ((result.insights && result.insights.length > 0) ||
                       (result.summary && result.summary.length > 10));
      if (hasData) {
        saveKnowledge(path.resolve(ROOT, 'brain', 'research'), 'research', {
          topic: parsed.searchQuery.slice(0, 50),
          insights: result.insights || [],
          summary: result.summary || '',
          sources: result.sources || []
        });
        log('info', `Supplementary research saved: ${(result.insights || []).length} insights for user query`);

        // Notify user in chat with context-aware report
        bufferChatReport(parsed.searchQuery, result);
      }
    } catch (e) {
      log('debug', `Supplement search failed: ${e.message}`);
    }
  })();
};

// --- Helper: collect codebase context ---
const collectContext = () => {
  const folders = config.targetFolders || [];
  let fileCount = 0;
  const functionNames = [];
  let analyzerIssues = 0;
  let analyzerSuggestions = 0;

  for (const folder of folders) {
    const absPath = path.resolve(ROOT, folder);
    const files = scanDirectory(absPath);
    fileCount += files.length;

    for (const file of files) {
      // Check new analyze-result/ directory first, then fall back to old .summary.md beside source
      const relative = path.relative(ROOT, file);
      const newSummaryPath = path.join(ROOT, 'analyze-result', relative.replace(/\.js$/, '.summary.md'));
      const oldSummaryPath = file.replace(/\.js$/, '.summary.md');
      const summaryPath = fs.existsSync(newSummaryPath) ? newSummaryPath : oldSummaryPath;

      if (fs.existsSync(summaryPath)) {
        try {
          const mdContent = fs.readFileSync(summaryPath, 'utf-8');
          const summary = summaryPath.endsWith('.md') ? parseSummaryMarkdown(mdContent) : JSON.parse(mdContent);
          if (!summary) throw new Error('parse failed');
          for (const fn of summary.functions || []) {
            const desc = fn.purpose ? ` (${fn.purpose.slice(0, 40)})` : '';
            functionNames.push(`${path.basename(file)}:${fn.name}${desc}`);
          }
          // Count structural issues for context
          analyzerIssues += (summary.structure?.issues || []).length;
          analyzerSuggestions += (summary.structure?.refactorSuggestions || []).length;
        } catch {}
      }
    }
  }

  let knowledgeCount = 0;
  for (const kbDir of [path.resolve(ROOT, 'brain', 'research'), path.resolve(ROOT, 'brain', 'analysis')]) {
    if (fs.existsSync(kbDir)) {
      const dbFiles = fs.readdirSync(kbDir).filter(f => f.endsWith('.jsonl'));
      for (const file of dbFiles) {
        knowledgeCount += fs.readFileSync(path.join(kbDir, file), 'utf-8').split('\n').filter(Boolean).length;
      }
    }
  }

  const recentLogs = logs.filter(l => l.level === 'info').slice(-3).map(l => l.message).join('; ');

  return {
    fileCount,
    knowledgeCount,
    recentActivity: recentLogs || 'システム起動直後',
    functionList: functionNames.slice(0, 50).join(', ') || 'なし',
    analyzerIssues,
    analyzerSuggestions
  };
};

// --- Activity Phase Tracking ---
let activityPhase = { phase: 'idle', detail: '', startedAt: null };

const setPhase = (phase, detail = '') => {
  activityPhase = { phase, detail, startedAt: new Date().toISOString() };
  log('debug', `Phase: ${phase}${detail ? ' — ' + detail : ''}`);
}

// --- LLM-Driven Autonomous Cycle ---
let cycleCount = 0;
let lastAnalysisCycle = 0;

const getResearchDbPath = () => { return path.resolve(ROOT, 'brain', 'research'); }
const getAnalysisDbPath = () => { return path.resolve(ROOT, 'brain', 'analysis'); }

const gitPull = () => {
  try {
    const result = execSync('git pull --ff-only', { cwd: ROOT, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const msg = result.trim();
    if (msg && msg !== 'Already up to date.') {
      log('info', `git pull: ${msg.split('\n')[0]}`);
    }
  } catch (e) {
    log('debug', `git pull skipped: ${e.message.split('\n')[0]}`);
  }
}

const scheduleAutonomousTasks = () => {
  cycleCount++;

  // Pull latest code before each cycle
  gitPull();

  // Single task: LLM decides what to do next
  taskManager.enqueue(createTask('autonomous:plan', async () => {
   try {
    const researchDbPath = getResearchDbPath();
    const analysisDbPath = getAnalysisDbPath();
    const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
    const folders = config.targetFolders || [];

    // Gather current state for LLM
    const recentResearch = getNewKnowledge(researchDbPath, 48);
    const recentTopics = recentResearch.map(e => e.topic).filter(Boolean);
    const recentInsights = recentResearch.slice(-3).map(e => {
      const ins = Array.isArray(e.insights) ? e.insights : typeof e.insights === 'string' ? [e.insights] : [];
      return `[${e.topic || '?'}] ${ins.slice(0, 2).join('; ').slice(0, 150)}`;
    }).join('\n') || 'なし';

    const modulesDir = path.resolve(ROOT, 'brain', 'modules');
    let moduleCount = 0;
    try { moduleCount = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js')).length; } catch {}

    const visitedUrls = loadVisitedUrls();
    const context = collectContext();
    const graphStats = getGraphStats(recentTopics);

    // Collect active user curiosities (unexplored, from user_chat)
    const activeCuriosities = loadCuriosities()
      .filter(c => !c.explored && c.source === 'user_chat')
      .map(c => c.topic);
    const userCuriosityStr = activeCuriosities.length > 0
      ? activeCuriosities.map(t => t.slice(0, 80)).join(' / ')
      : '';

    // Goal decomposition: break goal into subtasks if needed
    const goalText = config.finalGoal || config.searchPrompt || '';
    let goalSummary = null;
    let nextSubtaskInfo = 'なし';
    let currentSubtask = null;

    if (goalText && goalText !== 'なし') {
      try {
        // Run decomposition and evaluation in parallel when both are needed
        const goalPromises = [
          decomposeGoal(ollamaClient, goalText, {
            knowledgeCount: context.knowledgeCount,
            moduleCount,
            graphNodeCount: graphStats.nodeCount,
            existingFiles: context.functionList
          }, { goalPrompt: goalText })
        ];
        if (cycleCount % 5 === 0) {
          goalPromises.push(evaluateProgress(ollamaClient, { goalPrompt: goalText }));
        }
        await Promise.all(goalPromises);

        goalSummary = getGoalSummary();
        const { subtask } = getNextSubtask();
        currentSubtask = subtask;
        if (subtask) {
          nextSubtaskInfo = `[${subtask.id}] (${subtask.type}) ${subtask.description}`;
        }
      } catch (e) {
        log('debug', `Goal decomposition failed: ${e.message}`);
      }
    }

    const goalProgressStr = goalSummary
      ? `${goalSummary.progress} (${goalSummary.percentage}%) 完了`
      : 'ゴール未設定';

    const feedbackStr = getFeedbackSummary() || 'データなし';

    const prompt = fillPrompt('plan-next-action.user', {
      cycleCount: String(cycleCount),
      knowledgeCount: String(context.knowledgeCount),
      moduleCount: String(moduleCount),
      visitedUrlCount: String(visitedUrls.length),
      lastAnalysis: lastAnalysisCycle ? `${cycleCount - lastAnalysisCycle}サイクル前` : '未実施',
      recentActivity: context.recentActivity,
      userPrompt: goalText || 'なし',
      goalProgress: goalProgressStr,
      nextSubtask: nextSubtaskInfo,
      feedbackSummary: feedbackStr,
      recentTopics: recentTopics.slice(-10).join(', ') || 'なし',
      recentInsights,
      graphNodeCount: String(graphStats.nodeCount),
      graphEdgeCount: String(graphStats.edgeCount),
      graphScore: String(graphStats.score || 0),
      graphRecentScores: graphStats.recentScores || 'なし',
      graphScoreChange: graphStats.scoreChange > 0 ? `+${graphStats.scoreChange}` : String(graphStats.scoreChange || 0),
      graphStagnant: graphStats.stagnant ? '停滞中 — 異なるキーワード・視点で検索すること' : '',
      graphDensity: String(graphStats.density || 0),
      graphCategories: String(graphStats.categories || 0),
      topKeywords: graphStats.topKeywords || 'なし',
      underExplored: graphStats.underExplored || 'なし',
      searchSuggestions: graphStats.searchSuggestions || 'なし',
      overResearched: graphStats.overResearched || 'なし',
      userCuriosities: userCuriosityStr || 'なし'
    });

    let action = 'research'; // fallback
    let topic = '';
    let reason = '';

    setPhase('planning', 'Deciding next action');
    try {
      const { parsed } = await ollamaClient.queryForJson(
        prompt, loadPrompt('plan-next-action.system')
      );
      if (parsed) {
        if (parsed.action) action = parsed.action;
        if (parsed.topic) topic = parsed.topic;
        if (parsed.reason) reason = parsed.reason;
      }
    } catch (e) {
      log('debug', `Plan parsing failed, defaulting to research: ${e.message}`);
    }

    // --- Topic diversity enforcement ---
    // Skip diversity enforcement when user curiosities are pending (user intent takes priority)
    // If the LLM chose research and the topic overlaps with recent topics, force a different one
    if ((action === 'research' || action === 'deep_research') && topic && activeCuriosities.length === 0) {
      const topicLower = topic.toLowerCase();
      const topicWords = topicLower.split(/[\s,、。・\-\/]+/).filter(w => w.length >= 3);
      const recent10 = recentTopics.slice(-10).map(t => t.toLowerCase());
      // Build word set from recent topics for overlap detection
      const recentWordSet = new Set();
      for (const rt of recent10) {
        for (const w of rt.split(/[\s,、。・\-\/]+/).filter(w => w.length >= 3)) recentWordSet.add(w);
      }
      // Duplicate if: exact match, or >50% of topic words appeared in recent searches
      const wordOverlapCount = topicWords.filter(w => recentWordSet.has(w)).length;
      const isDuplicate = recent10.some(rt => rt === topicLower) ||
        (topicWords.length > 0 && wordOverlapCount / topicWords.length > 0.5);

      if (isDuplicate) {
        const alternatives = getUnderExplored(10, recentTopics);
        // Pick from top 3 scored alternatives (they're already diversity-sorted)
        if (alternatives.length > 0) {
          const pick = alternatives[Math.floor(Math.random() * Math.min(alternatives.length, 3))];
          const goalRef = config.finalGoal || config.searchPrompt || '';
          const goalSuffix = goalRef && goalRef !== 'なし'
            ? ` と ${goalRef.slice(0, 30)} の関連性`
            : ' の最新動向';
          log('info', `Topic diversity: "${topic}" is repetitive (${wordOverlapCount}/${topicWords.length} word overlap), switching to "${pick.label}"`);
          topic = pick.label + goalSuffix;
          reason = `多様性確保: ${pick.label}（調査${pick.count}回/接続${pick.connections}）を優先`;
        }
      }
    }

    // If LLM chose an action type that has been unreliable, fall back
    // Use wider window for develop/execute to avoid permanently blocking code generation
    const unreliableWindow = (action === 'develop' || action === 'execute') ? 10 : 5;
    if (isActionUnreliable(action, unreliableWindow) && action !== 'research' && action !== 'idle') {
      log('info', `Action "${action}" has high failure rate, falling back to research`);
      action = 'research';
    }

    // Mark current subtask as in_progress if the action matches
    if (currentSubtask && currentSubtask.status === 'pending') {
      updateSubtask(currentSubtask.id, { status: 'in_progress' });
    }

    log('info', `Autonomous decision: ${action}${topic ? ` (${topic.slice(0, 50)})` : ''} — ${reason.slice(0, 60)}`);
    setPhase(action, topic || reason.slice(0, 60));

    // Execute the chosen action
    let actionResult;
    let actionSuccess = false;
    let actionReason = '';

    try {
      switch (action) {
        case 'research':
        case 'deep_research': {
          // Prioritize unexplored user curiosities over LLM-chosen topic
          let searchPrompt = topic || config.searchPrompt || '最新の技術トレンドを調査してください';
          if (activeCuriosities.length > 0) {
            searchPrompt = activeCuriosities[0];
            log('info', `Using user curiosity as research topic: "${searchPrompt.slice(0, 80)}"`);
          }

          setPhase('searching', searchPrompt.slice(0, 60));
          const searchPairs = getSuggestedSearchPairs(3, recentTopics);
          const result = await runAgentLoop(ollamaClient, searchPrompt, ROOT, {
            workLogDir, onLog: log, mode: 'research',
            visitedUrls, recentTopics,
            goalPrompt: config.finalGoal || config.searchPrompt || '',
            searchPairs
          });

          if (result.visitedUrls && result.visitedUrls.length > 0) {
            addVisitedUrls(result.visitedUrls, result.credibilityMap);
          }

          if (result.empty) {
            log('debug', 'Research cycle produced no data (possibly interrupted)');
            setPhase('idle');
            actionReason = 'no data';
            actionResult = result;
            break;
          }

          const hasData = !result.empty &&
                          ((result.insights && result.insights.length > 0) ||
                           (result.summary && result.summary.length > 10));
          if (hasData) {
            setPhase('saving', 'Research results');
            const entry = {
              topic: topic || searchPrompt.slice(0, 50),
              insights: result.insights || [],
              summary: result.summary || '',
              sources: result.sources || []
            };
            saveKnowledge(researchDbPath, 'research', entry);
            log('info', `Research saved: ${(result.insights || []).length} insights`);
            actionSuccess = true;
            actionReason = `${(result.insights || []).length} insights`;

            // Post context-aware research report to chat
            bufferChatReport(topic || searchPrompt.slice(0, 40), result);

            // Run graph update and connection strengthening in parallel (fire-and-forget)
            const graphPromises = [
              updateGraph(ollamaClient, entry).catch(e =>
                log('warn', `Graph update failed: ${e.message}`)
              )
            ];
            if (searchPairs.length > 0) {
              graphPromises.push(
                Promise.resolve().then(() => {
                  const strengthened = strengthenSearchPairConnections(searchPairs, topic || searchPrompt.slice(0, 50));
                  if (strengthened > 0) log('info', `Strengthened ${strengthened} keyword pair connections from combined search`);
                }).catch(e => log('debug', `Connection strengthening failed: ${e.message}`))
              );
            }
            Promise.all(graphPromises).catch(() => {});
          }

          // Mark user curiosity as explored only after successful research
          if (activeCuriosities.length > 0 && hasData) {
            markCuriosityExplored(activeCuriosities[0]);
            log('info', `Curiosity explored via main research: "${activeCuriosities[0].slice(0, 60)}"`);
          }

          actionResult = result;
          break;
        }

        case 'develop': {
          const devTask = topic || (currentSubtask ? currentSubtask.description : '');
          if (!devTask) {
            log('info', 'No development task specified');
            actionResult = { skipped: true };
            break;
          }

          setPhase('developing', devTask.slice(0, 60));
          log('info', `Developing: ${devTask.slice(0, 80)}`);

          const goalCtx = goalSummary
            ? `目標: ${goalSummary.finalGoal}\n進捗: ${goalSummary.progress}\nサブタスク:\n${goalSummary.subtasks.map(t => `  [${t.status}] ${t.description}`).join('\n')}`
            : '';

          const result = await runAgentLoop(ollamaClient, devTask, ROOT, {
            workLogDir, onLog: log, mode: 'develop',
            goalContext: goalCtx,
            model: ollamaClient.model
          });

          const devHasData = !result.empty &&
                             ((result.insights && result.insights.length > 0) ||
                              (result.summary && result.summary.length > 10));
          // Count as success if tools were actually executed (even if summary failed)
          const devDidWork = Array.isArray(result.executedActions) && result.executedActions.length > 0;
          if (devDidWork) actionSuccess = true;
          if (devHasData) {
            saveKnowledge(analysisDbPath, 'development', {
              topic: devTask.slice(0, 50),
              insights: result.insights || [],
              summary: result.summary || '',
              sources: result.sources || []
            });
            actionSuccess = true;

            // Post context-aware dev report to chat
            bufferChatReport(devTask.slice(0, 40), result);
            actionReason = result.summary ? result.summary.slice(0, 100) : 'completed';
          }
          actionResult = result;
          break;
        }

        case 'execute': {
          const execTask = topic || '';
          if (!execTask) {
            log('info', 'No execution task specified');
            actionResult = { skipped: true };
            break;
          }

          setPhase('executing', execTask.slice(0, 60));
          log('info', `Executing: ${execTask.slice(0, 80)}`);

          // Use develop mode for execution tasks (has exec_command tool)
          const result = await runAgentLoop(ollamaClient, execTask, ROOT, {
            workLogDir, onLog: log, mode: 'develop',
            model: ollamaClient.model
          });

          actionSuccess = !result.empty;
          actionReason = result.summary ? result.summary.slice(0, 100) : '';
          actionResult = result;
          break;
        }

        case 'organize': {
          setPhase('organizing', 'Compressing knowledge');
          log('info', 'Organizing knowledge...');
          const [r1, r2] = await Promise.all([
            compressKnowledge(ollamaClient, researchDbPath),
            compressKnowledge(ollamaClient, analysisDbPath)
          ]);
          const total = [...(r1.compressed || []), ...(r2.compressed || [])];
          if (total.length > 0) {
            log('info', `Compressed: ${total.map(c => `${c.file} ${c.before}→${c.after}`).join(', ')}`);
          } else {
            log('info', 'No compression needed');
          }

          setPhase('organizing', 'Pruning knowledge graph');
          await pruneGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
          setPhase('organizing', 'Reviewing knowledge graph');
          await reviewGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
          // Only auto-connect if graph is small — large graphs are already well-connected
const _acStats = getGraphStats();
if (_acStats.nodeCount <= 500) autoConnect(log);
else log('info', `Auto-connect skipped: graph has ${_acStats.nodeCount} nodes (threshold: 500)`);

          actionSuccess = true;
          actionReason = `compressed ${total.length} files`;
          actionResult = { action: 'organize', compressed: total };
          break;
        }

        case 'generate_script': {
          const knowledge = getNewKnowledge(researchDbPath, 48);
          const researchEntries = knowledge.filter(k =>
            (Array.isArray(k.insights) && k.insights.length > 0) || (k.summary && k.summary.length > 20)
          );
          if (researchEntries.length === 0) {
            log('info', 'No knowledge available for script generation');
            actionResult = { skipped: true };
            break;
          }

          let entry;
          if (topic) {
            entry = researchEntries.find(e => e.topic && e.topic.includes(topic)) || researchEntries[researchEntries.length - 1];
          } else {
            entry = researchEntries[researchEntries.length - 1];
          }

          const entryTopic = topic || entry.topic || 'utility';
          setPhase('generating', entryTopic);
          log('info', `Generating script: ${entryTopic}`);
          const result = await generateModule(ollamaClient, entryTopic, entry, modulesDir);

          if (result.success) {
            log('info', `Script generated: ${path.basename(result.file)}`);
            actionSuccess = true;
            actionReason = path.basename(result.file);
          } else if (!result.skipped) {
            log('info', `Script generation failed: ${result.reason}`);
            actionReason = result.reason;
          }
          actionResult = result;
          break;
        }

        case 'analyze_code': {
          lastAnalysisCycle = cycleCount;
          setPhase('analyzing', 'Codebase analysis');
          log('info', 'Analyzing codebase...');

          // Use the new AnalyzeLoop to queue all target files
          if (analyzeLoop) {
            const filesToAnalyze = [];
            for (const folder of folders) {
              filesToAnalyze.push(...scanDirectory(path.resolve(ROOT, folder), '.js'));
            }
            // Also include core system files
            for (const sysFolder of ['core', 'lib', 'explorers']) {
              const sysPath = path.resolve(ROOT, sysFolder);
              if (fs.existsSync(sysPath)) {
                for (const f of scanDirectory(sysPath, '.js')) {
                  if (!filesToAnalyze.includes(f)) filesToAnalyze.push(f);
                }
              }
            }
            for (const f of filesToAnalyze) analyzeLoop._enqueue(f);
            log('info', `Queued ${filesToAnalyze.length} files for analysis`);
            actionSuccess = true;
            actionReason = `${filesToAnalyze.length} files queued`;
            actionResult = { filesQueued: filesToAnalyze.length };
          } else {
            // Fallback to old agent-based analysis
            const result = await runAgentLoop(ollamaClient,
              'プロジェクトのコードベースを解析し、品質・構造・改善点を分析してください。', ROOT, {
              workLogDir, onLog: log, mode: 'analyze', targetFolders: folders
            });

            const hasData = !result.empty &&
                            ((result.insights && result.insights.length > 0) ||
                             (result.summary && result.summary.length > 10));
            if (hasData) {
              saveKnowledge(analysisDbPath, 'analysis', {
                topic: 'コードベース解析',
                insights: result.insights || [],
                summary: result.summary || '',
                sources: result.sources || []
              });
              log('info', `Analysis saved: ${(result.insights || []).length} findings`);
              actionSuccess = true;
              actionReason = `${(result.insights || []).length} findings`;

              // Post context-aware analysis report to chat
              bufferChatReport('コードベース解析', result);
            }
            actionResult = result;
          }
          break;
        }

        case 'improve_code': {
          const allFiles = [];
          for (const folder of folders) {
            allFiles.push(...scanDirectory(path.resolve(ROOT, folder)));
          }
          if (allFiles.length === 0) {
            log('info', 'No files to improve');
            actionResult = { skipped: true };
            break;
          }

          const targetFile = allFiles[Math.floor(Math.random() * allFiles.length)];
          const relPath = path.relative(ROOT, targetFile);
          setPhase('improving', relPath);
          log('info', `Improving: ${relPath}`);
          const proposal = await proposeRefactor(ollamaClient, targetFile);

          if (proposal.refactoredCode) {
            const result = await applyRefactor(ROOT, targetFile, proposal.refactoredCode, folders);
            if (result.success) {
              log('info', `Refactor applied: ${relPath}`);
              actionSuccess = true;
              actionReason = relPath;
            } else {
              log('info', `Refactor skipped: ${result.reason}`);
              actionReason = result.reason;
            }
            actionResult = result;
          } else {
            actionResult = { suggestions: proposal.suggestions };
          }
          break;
        }

        case 'idle':
        default:
          setPhase('idle');
          log('info', 'Autonomous cycle: idle (waiting for next cycle)');
          actionSuccess = true;
          actionResult = { action: 'idle' };
          break;
      }
    } catch (e) {
      log('error', `Action "${action}" failed: ${e.message}`);
      actionReason = e.message;
    }

    // Curiosity exploration: explore user-submitted topics when idle or periodically
    if (action === 'idle' || (cycleCount % 5 === 0 && !actionSuccess)) {
      const curiosity = getNextCuriosity();
      if (curiosity) {
        try {
          log('info', `Exploring curiosity: "${curiosity.topic.slice(0, 60)}"`);
          setPhase('curiosity', curiosity.topic.slice(0, 60));
          const curiosityResult = await runAgentLoop(ollamaClient, curiosity.topic, ROOT, {
            workLogDir, onLog: log, mode: 'research',
            visitedUrls: loadVisitedUrls(), recentTopics: [],
            goalPrompt: config.finalGoal || config.searchPrompt || ''
          });
          if (curiosityResult.visitedUrls && curiosityResult.visitedUrls.length > 0) {
            addVisitedUrls(curiosityResult.visitedUrls, curiosityResult.credibilityMap);
          }
          const hasData = !curiosityResult.empty &&
                          ((curiosityResult.insights && curiosityResult.insights.length > 0) ||
                           (curiosityResult.summary && curiosityResult.summary.length > 10));
          if (hasData) {
            saveKnowledge(researchDbPath, 'curiosity', {
              topic: curiosity.topic.slice(0, 50),
              insights: curiosityResult.insights || [],
              summary: curiosityResult.summary || '',
              sources: curiosityResult.sources || []
            });
            updateGraph(ollamaClient, { topic: curiosity.topic, insights: curiosityResult.insights || [], summary: curiosityResult.summary || '' })
              .catch(e => log('warn', `Curiosity graph update failed: ${e.message}`));

            // Post context-aware curiosity report to chat
            bufferChatReport(curiosity.topic.slice(0, 40), curiosityResult);
          }
          markCuriosityExplored(curiosity.topic);
        } catch (e) {
          log('debug', `Curiosity exploration failed: ${e.message}`);
          markCuriosityExplored(curiosity.topic);
        }
      }
    }

    // Record feedback
    recordOutcome(action, topic || '', actionSuccess, actionReason);

    // Update subtask status based on result
    if (currentSubtask) {
      if (actionSuccess) {
        updateSubtask(currentSubtask.id, {
          status: 'completed',
          result: actionReason.slice(0, 200)
        });
        log('info', `Subtask completed: ${currentSubtask.id} — ${currentSubtask.description.slice(0, 50)}`);
      }
      // If failed, status stays in_progress for retry (max 3 attempts handled by getNextSubtask)
    }

    setPhase('idle');
    return actionResult;
   } catch (e) {
    log('error', `Autonomous cycle catastrophic failure: ${e.message}`);
    setPhase('idle');
    return { error: e.message };
   }
  }));
}

// --- Dream Phase Scheduler ---
const scheduleDream = () => {
  const now = new Date();
  const dreamHour = config.dreamHour || 5;
  const next = new Date(now);
  next.setHours(dreamHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delay = next.getTime() - now.getTime();
  log('info', `Dream phase scheduled at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  dreamTimer = setTimeout(async () => {
    // Daily maintenance: clean up low-quality old URLs
    try { cleanupVisitedUrls(); } catch (e) { log('debug', `URL cleanup failed: ${e.message}`); }

    log('info', 'Dream phase starting');
    taskManager.prioritize(createTask('dream:phase', async () => {
      const result = await dreamPhase(ollamaClient, config, ROOT);
      log('info', 'Dream phase completed', result);

      const dreamResearchDb = path.resolve(ROOT, 'brain', 'research');
      saveKnowledge(dreamResearchDb, 'dreams', result);

      // Feed nextTasks back into the task queue
      const nextTasks = result.analysis?.nextTasks || [];
      for (const task of nextTasks) {
        if (task.type === 'refactor' && task.query) {
          taskManager.enqueue(createTask(`dream:refactor:${task.topic}`, async () => {
            const files = [];
            for (const folder of (config.targetFolders || [])) {
              files.push(...scanDirectory(path.resolve(ROOT, folder)));
            }
            if (files.length === 0) return { skipped: true };

            const targetFile = files[Math.floor(Math.random() * files.length)];
            log('info', `Dream-driven refactor: ${task.topic} on ${path.basename(targetFile)}`);
            const proposal = await proposeRefactor(ollamaClient, targetFile);
            if (proposal.refactoredCode) {
              return await applyRefactor(ROOT, targetFile, proposal.refactoredCode, config.targetFolders || []);
            }
            return { suggestions: proposal.suggestions };
          }));
        } else if (task.query) {
          taskManager.enqueue(createTask(`dream:research:${task.topic}`, async () => {
            log('info', `Dream-driven research: ${task.topic}`);
            const res = await doubleCheck(ollamaClient, task.query);
            if (res.accepted) {
              saveKnowledge(dreamResearchDb, 'research', {
                topic: task.topic,
                insights: res.insights || []
              });
              log('info', `Dream knowledge saved: ${task.topic}`);
            }
            return res;
          }));
        }
      }

      if (nextTasks.length > 0) {
        log('info', `Dream phase queued ${nextTasks.length} follow-up tasks`);
      }

      // Daily script review: check if generated scripts are valid and useful
      const modulesDir = path.resolve(ROOT, 'brain', 'modules');
      log('info', 'Reviewing generated scripts...');
      const reviewResult = await reviewScripts(ollamaClient, modulesDir);
      if (reviewResult.deleted > 0) {
        log('info', `Script review: ${reviewResult.reviewed} reviewed, ${reviewResult.deleted} deleted`);
        await autoCommit(ROOT, `chore: remove ${reviewResult.deleted} obsolete scripts`, ['brain/modules']);
      } else {
        log('info', `Script review: ${reviewResult.reviewed} scripts OK`);
      }

      return result;
    }));

    scheduleDream();
  }, delay);
};

// --- API Server ---
const startServer = (port) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const method = req.method;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') { res.end(); return; }

    try {
      if (method === 'GET' && url.pathname === '/status') {
        let knowledgeStats = { files: 0, entries: 0 };
        for (const kbDir of [path.resolve(ROOT, 'brain', 'research'), path.resolve(ROOT, 'brain', 'analysis')]) {
          if (fs.existsSync(kbDir)) {
            const files = fs.readdirSync(kbDir).filter(f => f.endsWith('.jsonl'));
            knowledgeStats.files += files.length;
            for (const file of files) {
              knowledgeStats.entries += fs.readFileSync(path.join(kbDir, file), 'utf-8').split('\n').filter(Boolean).length;
            }
          }
        }

        const lastCommit = await getLastCommit(ROOT);

        res.end(JSON.stringify({
          taskManager: taskManager.getStatus(),
          ollama: ollamaClient ? ollamaClient.getStatus() : null,
          analyzer: analyzeLoop ? analyzeLoop.getStatus() : null,
          knowledge: knowledgeStats,
          lastCommit,
          activity: activityPhase,
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        }));

      } else if (method === 'GET' && url.pathname === '/logs') {
        const count = parseInt(url.searchParams.get('count') || '50', 10);
        res.end(JSON.stringify(logs.slice(-count)));

      } else if (method === 'GET' && url.pathname === '/chat-history') {
        res.end(JSON.stringify(loadChatHistory()));

      } else if (method === 'POST' && url.pathname === '/analyze') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { folder } = JSON.parse(body);

        if (!folder) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'folder is required' }));
          return;
        }

        const absPath = path.resolve(ROOT, folder);
        // Queue files from the folder into the AnalyzeLoop
        if (analyzeLoop) {
          const filesToAnalyze = scanDirectory(absPath, '.js');
          for (const f of filesToAnalyze) analyzeLoop._enqueue(f);
          res.end(JSON.stringify({ queued: true, folder: absPath, files: filesToAnalyze.length }));
        } else {
          // Fallback to old system if analyze loop not running
          taskManager.prioritize(createTask(`manual:analyze:${folder}`, async () => {
            return analyzeFolderWithLLM(ollamaClient, absPath);
          }));
          res.end(JSON.stringify({ queued: true, folder: absPath }));
        }

      } else if (method === 'POST' && url.pathname === '/pause') {
        taskManager.pause();
        log('info', 'System paused via UI');
        res.end(JSON.stringify({ ok: true, paused: true }));

      } else if (method === 'POST' && url.pathname === '/resume') {
        taskManager.resume();
        log('info', 'System resumed via UI');
        res.end(JSON.stringify({ ok: true, paused: false }));

      } else if (method === 'POST' && url.pathname === '/inject') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { topic } = JSON.parse(body);
        if (!topic) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'topic is required' }));
          return;
        }
        const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
        taskManager.prioritize(createTask(`inject:research`, async () => {
          log('info', `Injected research: ${topic.slice(0, 80)}`);
          setPhase('research', topic.slice(0, 60));
          const result = await runAgentLoop(ollamaClient, topic, ROOT, {
            workLogDir, onLog: log, mode: 'research',
            visitedUrls: loadVisitedUrls(), recentTopics: [],
            goalPrompt: config.finalGoal || config.searchPrompt || ''
          });
          if (result.visitedUrls && result.visitedUrls.length > 0) {
            addVisitedUrls(result.visitedUrls, result.credibilityMap);
          }
          const hasData = !result.empty &&
                          ((result.insights && result.insights.length > 0) ||
                           (result.summary && result.summary.length > 10));
          if (hasData) {
            saveKnowledge(path.resolve(ROOT, 'brain', 'research'), 'research', {
              topic: topic.slice(0, 50),
              insights: result.insights || [],
              summary: result.summary || '',
              sources: result.sources || []
            });
          }
          setPhase('idle');
          return result;
        }));
        log('info', `Research task injected via UI: "${topic.slice(0, 80)}"`);
        res.end(JSON.stringify({ queued: true, topic }));

      } else if (method === 'POST' && url.pathname === '/chat') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { message } = JSON.parse(body);

        if (!message) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        // Gather knowledge relevant to the user's question
        const recentResearch = getNewKnowledge(path.resolve(ROOT, 'brain', 'research'), 72);
        const recentAnalysis = getNewKnowledge(path.resolve(ROOT, 'brain', 'analysis'), 72);
        const allKnowledge = [...recentResearch, ...recentAnalysis];

        // Extract keywords from user message for relevance matching
        const msgLower = message.toLowerCase();
        const msgKeywords = message.replace(/[?？。、！!,.]/g, ' ').split(/\s+/).filter(w => w.length >= 2);

        // Score each knowledge entry by relevance to the question
        const scored = allKnowledge.map(k => {
          const topic = (k.topic || '').toLowerCase();
          const summaryText = (k.summary || '').toLowerCase();
          const insightsText = Array.isArray(k.insights)
            ? k.insights.map(i => typeof i === 'string' ? i : JSON.stringify(i)).join(' ').toLowerCase()
            : '';
          const fullText = topic + ' ' + summaryText + ' ' + insightsText;

          let score = 0;
          for (const kw of msgKeywords) {
            const kwLower = kw.toLowerCase();
            if (topic.includes(kwLower)) score += 3;
            if (summaryText.includes(kwLower)) score += 2;
            if (insightsText.includes(kwLower)) score += 1;
          }
          return { entry: k, score };
        });

        // Take relevant entries first, then recent ones as fallback
        scored.sort((a, b) => b.score - a.score);
        const relevant = scored.filter(s => s.score > 0).slice(0, 8).map(s => s.entry);
        const recent = scored.filter(s => s.score === 0).slice(-4).map(s => s.entry);
        const selectedKnowledge = [...relevant, ...recent];

        // Format knowledge entries in readable text (not raw JSON)
        const formatEntry = (k) => {
          const parts = [`### ${k.topic || 'unknown'}`];
          if (k.summary) parts.push(k.summary.slice(0, 500));
          if (Array.isArray(k.insights) && k.insights.length > 0) {
            const insightTexts = k.insights.map(i => typeof i === 'string' ? i : (i.insight || i.finding || JSON.stringify(i)));
            parts.push(insightTexts.slice(0, 5).join('\n'));
          }
          if (Array.isArray(k.sources) && k.sources.length > 0) {
            parts.push('出典: ' + k.sources.slice(0, 3).join(', '));
          }
          return parts.join('\n');
        };
        let knowledgeSummary = selectedKnowledge.map(formatEntry).join('\n\n');

        // Also search knowledge graph for related context
        if (msgKeywords.length > 0) {
          const graphNodes = searchGraphNodes(msgKeywords);
          if (graphNodes.length > 0) {
            const graphContext = graphNodes.map(n => {
              let line = `- ${n.label}`;
              if (n.description) line += `: ${n.description.slice(0, 100)}`;
              if (n.neighbors.length > 0) line += ` (関連: ${n.neighbors.slice(0, 5).join(', ')})`;
              return line;
            }).join('\n');
            knowledgeSummary += '\n\n## ナレッジグラフの関連キーワード:\n' + graphContext;
          }
        }

        // Immediate response from existing knowledge (research-focused only)
        log('info', `User chat: ${message.slice(0, 80)}`);
        saveChatMessage('user', message);
        try {
          // Load recent chat history (excluding the message just saved) for context
          const recentHistory = loadChatHistory().slice(-11, -1); // last 10 messages (5 turns)
          let reply = await chat(ollamaClient, message, {
            knowledge: knowledgeSummary,
            history: recentHistory
          });
          // Strip any file name/path references
          reply = reply.replace(/[A-Za-z0-9_\-]+\.(txt|json|jsonl|csv|md|js|py|yaml|yml|xml|bak|log|tmp)\b/gi, '').replace(/\s{2,}/g, ' ').trim();

          saveChatMessage('assistant', reply);

          // Detect if user message is a research directive and update searchPrompt
          detectAndStoreCuriosity(ollamaClient, message, recentHistory);

          res.end(JSON.stringify({
            reply,
            searchPrompt: config.searchPrompt || ''
          }));

          // Background: if the reply suggests insufficient knowledge, search and follow up
          supplementChatWithSearch(ollamaClient, message, reply, knowledgeSummary);
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }

      } else if (method === 'GET' && url.pathname === '/knowledge') {
        const count = parseInt(url.searchParams.get('count') || '50', 10);
        const category = url.searchParams.get('category') || null;
        const source = url.searchParams.get('source') || null; // 'research' or 'analysis'

        const entries = [];
        const kbDirs = [];
        if (!source || source === 'research') kbDirs.push({ dir: path.resolve(ROOT, 'brain', 'research'), src: 'research' });
        if (!source || source === 'analysis') kbDirs.push({ dir: path.resolve(ROOT, 'brain', 'analysis'), src: 'analysis' });

        for (const { dir, src } of kbDirs) {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
          for (const file of files) {
            if (category && file !== `${category}.jsonl`) continue;
            const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                entry._category = file.replace('.jsonl', '');
                entry._source = src;
                entries.push(entry);
              } catch {}
            }
          }
        }

        // Sort by timestamp descending, return latest N
        entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        res.end(JSON.stringify(entries.slice(0, count)));

      } else if (method === 'GET' && url.pathname === '/knowledge-graph') {
        res.end(JSON.stringify(getGraphData()));

      } else if (method === 'POST' && url.pathname === '/knowledge-graph/reorganize') {
        // Prevent duplicate reorganization
        const isReorgRunning = taskManager.currentTask?.name === 'manual:graph-reorg' ||
          taskManager.queue.some(t => t.name === 'manual:graph-reorg');
        if (isReorgRunning) {
          res.end(JSON.stringify({ started: false, reason: 'already running' }));
          return;
        }
        res.end(JSON.stringify({ started: true }));
        taskManager.prioritize(createTask('manual:graph-reorg', async () => {
          try {
            setPhase('organizing', 'Pruning knowledge graph');
            log('info', 'Graph reorganization started');
            await pruneGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
            setPhase('organizing', 'Reviewing knowledge graph');
            await reviewGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
            // Only auto-connect if graph is small — large graphs are already well-connected
const _acStats = getGraphStats();
if (_acStats.nodeCount <= 500) autoConnect(log);
else log('info', `Auto-connect skipped: graph has ${_acStats.nodeCount} nodes (threshold: 500)`);
            log('info', 'Graph reorganization completed');
          } catch (e) {
            log('error', `Graph reorganization failed: ${e.message}`);
          } finally {
            setPhase('idle');
          }
        }));

      } else if (method === 'POST' && url.pathname === '/knowledge-graph/delete') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { key } = JSON.parse(body || '{}');
        if (!key) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'key is required' }));
          return;
        }
        const ok = deleteNode(key);
        log('info', `Graph node delete: ${key} → ${ok ? 'deleted' : 'not found'}`);
        res.end(JSON.stringify({ deleted: ok, key }));

      } else if (method === 'GET' && url.pathname === '/goals') {
        const summary = getGoalSummary();
        const { subtask, progress } = getNextSubtask();
        res.end(JSON.stringify({
          summary,
          nextSubtask: subtask,
          progress
        }));

      } else if (method === 'GET' && url.pathname === '/feedback') {
        const { getStats } = require('./core/feedback-tracker');
        res.end(JSON.stringify(getStats()));

      } else if (method === 'GET' && url.pathname === '/curiosities') {
        res.end(JSON.stringify(loadCuriosities()));

      } else if (method === 'GET' && url.pathname === '/settings') {
        // Return current settings (safe subset)
        const settingsPath = path.join(ROOT, 'config', 'settings.json');
        const settings = loadJsonFile(settingsPath, {});
        res.end(JSON.stringify(settings));

      } else if (method === 'POST' && url.pathname === '/settings') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const updates = JSON.parse(body);
        const settingsPath = path.join(ROOT, 'config', 'settings.json');
        try {
          const current = loadJsonFile(settingsPath, {});
          // Apply allowed updates
          if (updates.ollama) {
            if (!current.ollama) current.ollama = {};
            if (updates.ollama.url !== undefined) current.ollama.url = updates.ollama.url;
            if (updates.ollama.model !== undefined) current.ollama.model = updates.ollama.model;
            if (updates.ollama.dreamModel !== undefined) current.ollama.dreamModel = updates.ollama.dreamModel;
          }
          if (updates.searchPrompt !== undefined) current.searchPrompt = updates.searchPrompt;
          // finalGoal is protected — only changeable via setup (npm run setup)
          if (updates.taskInterval !== undefined) current.taskInterval = parseInt(updates.taskInterval, 10) || 60000;
          if (updates.dreamHour !== undefined) current.dreamHour = parseInt(updates.dreamHour, 10) || 5;
          if (updates.server && updates.server.port !== undefined) {
            if (!current.server) current.server = {};
            current.server.port = parseInt(updates.server.port, 10) || 2500;
          }
          if (updates.voice) {
            current.voice = Object.assign(current.voice || {}, updates.voice);
          }
          saveJsonFile(settingsPath, current);
          // Reload config in memory
          config = Object.assign(config, current);
          if (ollamaClient && current.ollama) {
            ollamaClient = new OllamaClient(current.ollama);
          }
          log('info', 'Settings updated via UI');
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }

      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      log('error', `API error: ${req.method} ${req.url} — ${err.message}`);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('warn', `Port ${port} is already in use. API server not started.`);
    } else {
      log('error', `API server error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    log('info', `API server listening on port ${port}`);
  });

  return server;
};

// --- Shutdown & Restart ---
const shutdown = () => {
  return new Promise((resolve) => {
    restarting = true;
    flushChatReport(); // flush any buffered reports before shutdown
    taskManager.stop();

    if (analyzeLoop) { analyzeLoop.stop(); analyzeLoop = null; }
    if (dreamTimer) { clearTimeout(dreamTimer); dreamTimer = null; }

    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        restarting = false;
        resolve();
      });
      // Force close after 3 seconds
      setTimeout(() => {
        if (httpServer) { httpServer = null; }
        restarting = false;
        resolve();
      }, 3000);
    } else {
      restarting = false;
      resolve();
    }
  });
};

const restart = async () => {
  log('info', 'Restarting...');
  await shutdown();

  // Clear module cache for hot reload
  const cacheKeys = Object.keys(require.cache);
  for (const key of cacheKeys) {
    if (key.startsWith(ROOT) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }

  // Reload config
  try {
    config = loadConfig(CONFIG_PATH);
  } catch (err) {
    log('error', `Config reload failed: ${err.message}`);
    return;
  }

  start();
  log('info', 'Restart complete');
}

// --- Bootstrap ---
const start = () => {
  log('info', 'Think Tank Core starting');

  // Create Ollama client with multi-URL failover support
  ollamaClient = new OllamaClient(config.ollama);
  ollamaClient.setThinkingCallback((active, context) => {
    if (active) {
      log('info', `Thinking... ${context || ''}`);
    }
  });
  log('info', `Ollama endpoints: ${ollamaClient.urls.join(', ')} (model: ${ollamaClient.model})`);

  // Ensure brain directories exist
  const modulesDir = path.resolve(ROOT, 'brain', 'modules');
  const researchDir = path.resolve(ROOT, 'brain', 'research');
  const analysisDir = path.resolve(ROOT, 'brain', 'analysis');
  const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
  const scriptsDir = path.resolve(ROOT, 'brain', 'scripts');
  const outputDir = path.resolve(ROOT, 'brain', 'output');
  for (const dir of [modulesDir, researchDir, analysisDir, workLogDir, scriptsDir, outputDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Start task manager
  taskManager.queue = [];
  taskManager.currentTask = null;
  taskManager.start();

  // Schedule dream phase
  scheduleDream();

  // Index unprocessed knowledge entries into graph on startup
  taskManager.enqueue(createTask('startup:graph-index', async () => {
    const count = await processUnindexedEntries(ollamaClient, [researchDir, analysisDir], log);
    if (count > 0) {
      log('info', 'Startup graph prune & review...');
      await pruneGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
      await reviewGraph(ollamaClient, log, { goalPrompt: config.finalGoal || config.searchPrompt });
      // Only auto-connect if graph is small — large graphs are already well-connected
const _acStats = getGraphStats();
if (_acStats.nodeCount <= 500) autoConnect(log);
else log('info', `Auto-connect skipped: graph has ${_acStats.nodeCount} nodes (threshold: 500)`);
    }
  }));

  // Seed initial tasks
  scheduleAutonomousTasks();

  // Start API server
  const port = config.server?.port || 3000;
  httpServer = startServer(port);

  // Start JavaScript Analyzer loop
  analyzeLoop = new AnalyzeLoop({
    client: ollamaClient,
    rootDir: ROOT,
    log,
    autoFormat: config.analyzer?.autoFormat !== false
  });
  analyzeLoop.on('analyzed', ({ file }) => {
    log('info', `[Analyzer] Analyzed: ${path.relative(ROOT, file)}`);
  });
  analyzeLoop.on('error', ({ file, error }) => {
    log('warn', `[Analyzer] Error: ${path.relative(ROOT, file)} — ${error}`);
  });
  analyzeLoop.start().catch(err => {
    log('warn', `[Analyzer] Failed to start: ${err.message}`);
  });

  log('info', 'Think Tank Core fully operational');
};

// --- CLI Entrypoint ---
const main = async () => {
  const args = process.argv.slice(2);

  // --setup: force interactive setup
  if (args.includes('--setup')) {
    config = await runSetup(CONFIG_PATH);
    console.log('Setup complete. Starting server...\n');
    start();
    return;
  }

  // --analyze: one-shot folder analysis (delegates to scripts/analyze.js)
  if (args.includes('--analyze')) {
    const idx = args.indexOf('--analyze');
    const folders = args.slice(idx + 1);
    const scriptPath = path.join(ROOT, 'scripts', 'analyze.js');
    const scriptArgs = folders.length > 0 ? folders : [];
    const { execFileSync } = require('child_process');
    try {
      execFileSync('node', [scriptPath, ...scriptArgs], { stdio: 'inherit', cwd: ROOT });
    } catch (err) {
      process.exit(err.status || 1);
    }
    process.exit(0);
    return;
  }

  // Normal startup — run setup if no config exists
  const needsSetup = !fs.existsSync(CONFIG_PATH);
  if (needsSetup) {
    console.log('No config found. Starting initial setup...');
    config = await runSetup(CONFIG_PATH);
    console.log('Setup complete. Starting server...\n');
  } else {
    try { config = loadConfig(CONFIG_PATH); } catch (err) {
      console.error('Failed to load config:', err.message);
      process.exit(1);
    }
  }

  // Prevent unhandled promise rejections from crashing the process
  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${reason?.message || reason}`);
  });

  process.on('uncaughtException', (err) => {
    log('error', `Uncaught exception: ${err.message}`);
    // Don't exit — try to keep running
    // Check if task manager is stuck and restart the loop
    setTimeout(() => {
      if (!restarting && taskManager.running && !taskManager.currentTask && taskManager.queue.length === 0) {
        log('info', 'Recovery: restarting autonomous loop after uncaught exception');
        try { scheduleAutonomousTasks(); } catch {}
      }
    }, 5000);
  });

  start();

  // File watcher for hot reload
  const watcher = startWatcher(ROOT, { ignore: ['node_modules', '.git', 'brain', 'ui'] });
  watcher.on('change', (info) => {
    log('info', `File changed: ${info.file} — restarting...`);
    restart();
  });

  // Interactive CLI (only in TTY mode)
  if (process.stdin.isTTY) {
    startCLI({
      taskManager,
      getConfig: () => config,
      getClient: () => ollamaClient,
      log,
      restart,
      root: ROOT,
      rawLog: log,
      overrideLog: (fn) => { logWriter = fn; },
      getLogs: (count) => logs.slice(-count),
      createTaskFn: createTask,
      doubleCheckFn: doubleCheck,
      saveKnowledgeFn: saveKnowledge,
      analyzeFolderWithLLMFn: analyzeFolderWithLLM,
      scanDirectoryFn: scanDirectory,
      getAnalyzeLoop: () => analyzeLoop
    });
  }
};

main();

module.exports = { taskManager, log };
