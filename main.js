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
const { getModelConfig } = require('./lib/model-config');
const { runSetup } = require('./lib/setup');
const { startWatcher } = require('./lib/watcher');
const { startCLI } = require('./lib/cli');
const { updateGraph, reviewGraph, pruneGraph, processUnindexedEntries, getUnderExplored, getGraphStats, getGraphData, deleteNode } = require('./core/knowledge-graph');
const { decomposeGoal, getNextSubtask, updateSubtask, evaluateProgress, getGoalSummary } = require('./core/goal-manager');
const { recordOutcome, getFeedbackSummary, isActionUnreliable } = require('./core/feedback-tracker');
const { execSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config', 'settings.json');

// --- State ---
const logs = [];
const maxLogs = 500;
let logWriter = null; // overridable by CLI

function log(level, message, data) {
  const entry = { timestamp: new Date().toISOString(), level, message, data };
  logs.push(entry);
  if (logs.length > maxLogs) logs.shift();
  if (logWriter) {
    logWriter(level, message, data);
  } else if (level !== 'debug') {
    console.log(`[${entry.timestamp}] [${level}] ${message}`);
  }
}

// --- System Documentation for Chat ---
const DOCS_DIR = path.join(ROOT, 'docs');

function loadSystemDocs() {
  const docFiles = ['architecture.md', 'technical-specs.md', 'directory-structure.md'];
  const docs = [];
  for (const file of docFiles) {
    const filePath = path.join(DOCS_DIR, file);
    try {
      if (fs.existsSync(filePath)) {
        docs.push(`### ${file}\n${fs.readFileSync(filePath, 'utf-8')}`);
      }
    } catch {}
  }
  // Also include README
  const readmePath = path.join(ROOT, 'README.md');
  try {
    if (fs.existsSync(readmePath)) {
      docs.push(`### README.md\n${fs.readFileSync(readmePath, 'utf-8')}`);
    }
  } catch {}
  return docs.join('\n\n---\n\n');
}

function isSystemQuestion(message) {
  const patterns = [
    /このシステム/, /think.?tank/, /仕組み/, /アーキテクチャ/,
    /どう(やって|動い|なって)/, /機能/, /セキュリティ/,
    /ゴール分解/, /フィードバック/, /ナレッジグラフ/,
    /エージェント/, /サンドボックス/, /検閲/,
    /dream\s*phase/i, /設定/, /API/, /使い方/,
    /コマンド/, /モード/, /ツール/, /プロンプト/,
    /自律/, /開発モード/, /リサーチモード/,
    /how does/i, /what is/i, /explain/i, /architecture/i,
    /security/i, /how.*work/i, /設計/, /構造/,
  ];
  return patterns.some(p => p.test(message));
}

// --- Chat History ---
const CHAT_HISTORY_PATH = path.join(ROOT, 'brain', 'chat-history.json');
const MAX_CHAT_HISTORY = 200;

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_HISTORY_PATH)) return JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf-8'));
  } catch {}
  return [];
}

function saveChatMessage(role, text) {
  const history = loadChatHistory();
  history.push({ role, text, timestamp: new Date().toISOString() });
  while (history.length > MAX_CHAT_HISTORY) history.shift();
  const dir = path.dirname(CHAT_HISTORY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHAT_HISTORY_PATH, JSON.stringify(history), 'utf-8');
}

// --- Config ---
let config;
let ollamaClient = null;

// --- Server & Timer state (for restart) ---
let httpServer = null;
let idleTimer = null;
let dreamTimer = null;
let restarting = false;

// --- Task Manager ---
const taskManager = new TaskManager();

taskManager.on('task:start', (task) => log('debug', `Task started: ${task?.name}`));
taskManager.on('task:complete', ({ task }) => log('debug', `Task completed: ${task?.name}`));
taskManager.on('task:error', ({ task, error }) => log('error', `Task failed: ${task?.name || 'unknown'} — ${error?.message}`));

taskManager.on('idle', () => {
  if (idleTimer || restarting) return;
  const interval = config.taskInterval || 60000;
  log('debug', `Queue idle — next autonomous cycle in ${Math.round(interval / 1000)}s`);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!restarting) {
      try {
        scheduleAutonomousTasks();
      } catch (e) {
        log('error', `Failed to schedule autonomous cycle: ${e.message}`);
        // Ensure the loop continues even if scheduling itself fails
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (!restarting) scheduleAutonomousTasks();
        }, interval);
      }
    }
  }, interval);
});

taskManager.on('task:error', ({ task, error }) => {
  // Ensure cycle continues after task failure by scheduling next cycle if queue is empty
  if (taskManager.queue.length === 0 && !idleTimer && !restarting) {
    const interval = config.taskInterval || 60000;
    log('debug', `Recovering from task error — next cycle in ${Math.round(interval / 1000)}s`);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!restarting) scheduleAutonomousTasks();
    }, interval);
  }
});

// --- Helper: visited URL tracking ---
const VISITED_URLS_PATH = path.join(ROOT, 'brain', 'visited-urls.json');

function loadVisitedUrls() {
  try {
    if (fs.existsSync(VISITED_URLS_PATH)) {
      return JSON.parse(fs.readFileSync(VISITED_URLS_PATH, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveVisitedUrls(urls) {
  const dir = path.dirname(VISITED_URLS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VISITED_URLS_PATH, JSON.stringify(urls, null, 2), 'utf-8');
}

function addVisitedUrls(newUrls) {
  const existing = loadVisitedUrls();
  const set = new Set(existing);
  for (const url of newUrls) {
    if (url && typeof url === 'string') set.add(url);
  }
  saveVisitedUrls([...set]);
}

// --- Helper: detect research intent from user chat and update searchPrompt ---

function detectAndUpdateSearchPrompt(client, userMessage) {
  // Fire-and-forget — don't block the chat response
  (async () => {
    try {
      const systemPrompt = loadPrompt('detect-research-intent.system');
      const response = await client.query(userMessage, systemPrompt);
      const text = (response.response || '').trim();
      const parsed = parseJsonSafe(text);
      if (!parsed) return;
      if (parsed.isResearch && parsed.searchPrompt && parsed.searchPrompt !== 'null') {
        // User's chat contains a research directive → update the user-facing searchPrompt
        config.searchPrompt = parsed.searchPrompt;
        log('info', `searchPrompt updated by user: "${parsed.searchPrompt.slice(0, 80)}"`);

        // Persist to settings.json
        try {
          const settingsPath = path.join(ROOT, 'config', 'settings.json');
          if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            settings.searchPrompt = parsed.searchPrompt;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
          }
        } catch (e) {
          log('warn', `Failed to persist searchPrompt: ${e.message}`);
        }
      }
    } catch (e) {
      log('debug', `Research intent detection failed: ${e.message}`);
    }
  })();
}

// --- Helper: supplement chat with background search ---
function supplementChatWithSearch(client, userMessage, initialReply, existingKnowledge) {
  // Fire-and-forget: check if reply indicates insufficient knowledge, then search
  (async () => {
    try {
      const checkPrompt = `以下の質問と回答を分析してください。回答に十分な情報が含まれていない、または「わかりません」「情報がありません」等の不確かな回答の場合はtrueを返してください。

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
        addVisitedUrls(result.visitedUrls);
      }

      if (result.empty) return;

      // Save the supplementary research
      const hasData = (result.insights && result.insights.length > 0) ||
                      (result.summary && result.summary.length > 10);
      if (hasData) {
        saveKnowledge(path.resolve(ROOT, 'brain', 'research'), 'research', {
          topic: parsed.searchQuery.slice(0, 50),
          insights: result.insights || [],
          summary: result.summary || '',
          sources: result.sources || []
        });
        log('info', `Supplementary research saved: ${(result.insights || []).length} insights for user query`);
      }
    } catch (e) {
      log('debug', `Supplement search failed: ${e.message}`);
    }
  })();
}

// --- Helper: collect codebase context ---
function collectContext() {
  const folders = config.targetFolders || [];
  let fileCount = 0;
  const functionNames = [];

  for (const folder of folders) {
    const absPath = path.resolve(ROOT, folder);
    const files = scanDirectory(absPath);
    fileCount += files.length;

    for (const file of files) {
      const summaryPath = file.replace(/\.js$/, '.summary.json');
      if (fs.existsSync(summaryPath)) {
        try {
          const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
          for (const fn of summary.functions || []) {
            functionNames.push(`${path.basename(file)}:${fn.name}`);
          }
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
    functionList: functionNames.slice(0, 50).join(', ') || 'なし'
  };
}

// --- Activity Phase Tracking ---
let activityPhase = { phase: 'idle', detail: '', startedAt: null };

function setPhase(phase, detail = '') {
  activityPhase = { phase, detail, startedAt: new Date().toISOString() };
  log('debug', `Phase: ${phase}${detail ? ' — ' + detail : ''}`);
}

// --- LLM-Driven Autonomous Cycle ---
let cycleCount = 0;
let lastAnalysisCycle = 0;

function getResearchDbPath() { return path.resolve(ROOT, 'brain', 'research'); }
function getAnalysisDbPath() { return path.resolve(ROOT, 'brain', 'analysis'); }

function gitPull() {
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

function scheduleAutonomousTasks() {
  cycleCount++;

  // Pull latest code before each cycle
  gitPull();

  // Single task: LLM decides what to do next
  taskManager.enqueue(createTask('autonomous:plan', async () => {
    const researchDbPath = getResearchDbPath();
    const analysisDbPath = getAnalysisDbPath();
    const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
    const folders = config.targetFolders || [];

    // Gather current state for LLM
    const recentResearch = getNewKnowledge(researchDbPath, 48);
    const recentTopics = recentResearch.map(e => e.topic).filter(Boolean);
    const recentInsights = recentResearch.slice(-3).map(e =>
      `[${e.topic || '?'}] ${(e.insights || []).slice(0, 2).join('; ').slice(0, 150)}`
    ).join('\n') || 'なし';

    const modulesDir = path.resolve(ROOT, 'brain', 'modules');
    let moduleCount = 0;
    try { moduleCount = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js')).length; } catch {}

    const visitedUrls = loadVisitedUrls();
    const context = collectContext();
    const graphStats = getGraphStats(recentTopics);

    // Goal decomposition: break goal into subtasks if needed
    const goalText = config.searchPrompt || '';
    let goalSummary = null;
    let nextSubtaskInfo = 'なし';
    let currentSubtask = null;

    if (goalText && goalText !== 'なし') {
      try {
        await decomposeGoal(ollamaClient, goalText, {
          knowledgeCount: context.knowledgeCount,
          moduleCount,
          graphNodeCount: graphStats.nodeCount,
          existingFiles: context.functionList
        }, { model: ollamaClient.dreamModel });

        // Periodically re-evaluate goal progress
        if (cycleCount % 5 === 0) {
          await evaluateProgress(ollamaClient, { model: ollamaClient.dreamModel });
        }

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
      overResearched: graphStats.overResearched || 'なし'
    });

    let action = 'research'; // fallback
    let topic = '';
    let reason = '';

    setPhase('planning', 'Deciding next action');
    try {
      const modelConfig = getModelConfig(config.ollama || {});
      const { parsed } = await ollamaClient.queryForJson(
        prompt, loadPrompt('plan-next-action.system'),
        { jsonRetries: modelConfig.jsonRetries }
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
    // If the LLM chose research and the topic overlaps with recent topics, force a different one
    if ((action === 'research' || action === 'deep_research') && topic) {
      const topicLower = topic.toLowerCase();
      const recent10 = recentTopics.slice(-10).map(t => t.toLowerCase());
      const isDuplicate = recent10.some(rt =>
        rt.includes(topicLower.slice(0, 15)) || topicLower.includes(rt.slice(0, 15))
      );
      if (isDuplicate) {
        const alternatives = getUnderExplored(10, recentTopics);
        // Pick a random alternative to avoid always choosing the top-scored one
        const filtered = alternatives.filter(a => {
          const aLower = a.label.toLowerCase();
          return !recent10.some(rt => rt.includes(aLower) || aLower.includes(rt.slice(0, 15)));
        });
        if (filtered.length > 0) {
          const pick = filtered[Math.floor(Math.random() * Math.min(filtered.length, 5))];
          const goalSuffix = config.searchPrompt && config.searchPrompt !== 'なし'
            ? ` と ${config.searchPrompt.slice(0, 30)} の関連性`
            : ' の最新動向';
          log('info', `Topic diversity: "${topic}" is repetitive, switching to "${pick.label}"`);
          topic = pick.label + goalSuffix;
          reason = `多様性確保: ${pick.label}（調査${pick.count}回/接続${pick.connections}）を優先`;
        }
      }
    }

    // If LLM chose an action type that has been unreliable, fall back
    if (isActionUnreliable(action) && action !== 'research' && action !== 'idle') {
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
          const searchPrompt = topic || config.searchPrompt || '最新の技術トレンドを調査してください';

          setPhase('searching', searchPrompt.slice(0, 60));
          const result = await runAgentLoop(ollamaClient, searchPrompt, ROOT, {
            workLogDir, onLog: log, mode: 'research',
            visitedUrls, recentTopics,
            goalPrompt: config.searchPrompt || ''
          });

          if (result.visitedUrls && result.visitedUrls.length > 0) {
            addVisitedUrls(result.visitedUrls);
          }

          if (result.empty) {
            log('debug', 'Research cycle produced no data (possibly interrupted)');
            setPhase('idle');
            actionReason = 'no data';
            actionResult = result;
            break;
          }

          const hasData = (result.insights && result.insights.length > 0) ||
                          (result.summary && result.summary.length > 10);
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

            updateGraph(ollamaClient, entry).catch(e =>
              log('debug', `Graph update failed: ${e.message}`)
            );
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
            model: ollamaClient.dreamModel
          });

          const devHasData = (result.insights && result.insights.length > 0) ||
                             (result.summary && result.summary.length > 10);
          if (devHasData) {
            saveKnowledge(analysisDbPath, 'development', {
              topic: devTask.slice(0, 50),
              insights: result.insights || [],
              summary: result.summary || '',
              sources: result.sources || []
            });
            actionSuccess = true;
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
            model: ollamaClient.dreamModel
          });

          actionSuccess = !result.empty;
          actionReason = result.summary ? result.summary.slice(0, 100) : '';
          actionResult = result;
          break;
        }

        case 'organize': {
          setPhase('organizing', 'Compressing knowledge');
          log('info', 'Organizing knowledge...');
          const r1 = await compressKnowledge(ollamaClient, researchDbPath);
          const r2 = await compressKnowledge(ollamaClient, analysisDbPath);
          const total = [...(r1.compressed || []), ...(r2.compressed || [])];
          if (total.length > 0) {
            log('info', `Compressed: ${total.map(c => `${c.file} ${c.before}→${c.after}`).join(', ')}`);
          } else {
            log('info', 'No compression needed');
          }

          setPhase('organizing', 'Pruning knowledge graph');
          await pruneGraph(ollamaClient, log, { model: ollamaClient.dreamModel });
          setPhase('organizing', 'Reviewing knowledge graph');
          await reviewGraph(ollamaClient, log, { model: ollamaClient.dreamModel });

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
          const result = await runAgentLoop(ollamaClient,
            'プロジェクトのコードベースを解析し、品質・構造・改善点を分析してください。', ROOT, {
            workLogDir, onLog: log, mode: 'analyze', targetFolders: folders
          });

          const hasData = (result.insights && result.insights.length > 0) ||
                          (result.summary && result.summary.length > 10);
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
          }
          actionResult = result;
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
  }));
}

// --- Dream Phase Scheduler ---
function scheduleDream() {
  const now = new Date();
  const dreamHour = config.dreamHour || 5;
  const next = new Date(now);
  next.setHours(dreamHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delay = next.getTime() - now.getTime();
  log('info', `Dream phase scheduled at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)`);

  dreamTimer = setTimeout(async () => {
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
                insights: res.insights
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
}

// --- API Server ---
function startServer(port) {
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
        taskManager.prioritize(createTask(`manual:analyze:${folder}`, async () => {
          return analyzeFolderWithLLM(ollamaClient, absPath);
        }));

        res.end(JSON.stringify({ queued: true, folder: absPath }));

      } else if (method === 'POST' && url.pathname === '/chat') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { message } = JSON.parse(body);

        if (!message) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'message is required' }));
          return;
        }

        // Gather all available knowledge for context
        const recentResearch = getNewKnowledge(path.resolve(ROOT, 'brain', 'research'), 72);
        const recentAnalysis = getNewKnowledge(path.resolve(ROOT, 'brain', 'analysis'), 72);
        const recentKnowledge = [...recentResearch, ...recentAnalysis];
        const knowledgeSummary = recentKnowledge.slice(-10).map(k =>
          `[${k.topic || 'unknown'}] ${JSON.stringify(k.insights || k).slice(0, 300)}`
        ).join('\n');

        // If user is asking about the system itself, include documentation
        let systemDocsContext = '';
        if (isSystemQuestion(message)) {
          systemDocsContext = loadSystemDocs();
          log('debug', 'Including system documentation in chat context');
        }

        // Immediate response from existing knowledge
        log('info', `User chat: ${message.slice(0, 80)}`);
        saveChatMessage('user', message);
        try {
          const reply = await chat(ollamaClient, message, {
            knowledge: knowledgeSummary,
            systemDocs: systemDocsContext
          });

          saveChatMessage('assistant', reply);

          // Detect if user message is a research directive and update searchPrompt
          detectAndUpdateSearchPrompt(ollamaClient, message);

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
        // Run reorganization directly (not queued) so we can return the result
        res.end(JSON.stringify({ started: true }));
        // Execute as a prioritized task
        taskManager.prioritize(createTask('manual:graph-reorg', async () => {
          try {
            setPhase('organizing', 'Pruning knowledge graph');
            log('info', 'Graph reorganization started');
            await pruneGraph(ollamaClient, log, { model: ollamaClient.dreamModel });
            setPhase('organizing', 'Reviewing knowledge graph');
            await reviewGraph(ollamaClient, log, { model: ollamaClient.dreamModel });
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

      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
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
}

// --- Shutdown & Restart ---
function shutdown() {
  return new Promise((resolve) => {
    restarting = true;
    taskManager.stop();

    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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
}

async function restart() {
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
function start() {
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
      await pruneGraph(ollamaClient, log, { model: ollamaClient.dreamModel });
      await reviewGraph(ollamaClient, log, { model: ollamaClient.dreamModel });
    }
  }));

  // Seed initial tasks
  scheduleAutonomousTasks();

  // Start API server
  const port = config.server?.port || 3000;
  httpServer = startServer(port);

  log('info', 'Think Tank Core fully operational');
}

// --- CLI Entrypoint ---
async function main() {
  const args = process.argv.slice(2);

  // --setup: force interactive setup
  if (args.includes('--setup')) {
    config = await runSetup(CONFIG_PATH);
    console.log('Setup complete. Starting server...\n');
    start();
    return;
  }

  // --analyze: one-shot folder analysis
  if (args.includes('--analyze')) {
    try { config = loadConfig(CONFIG_PATH); } catch (err) {
      console.error('Failed to load config:', err.message);
      console.error('Run "node main.js --setup" first.');
      process.exit(1);
    }
    const idx = args.indexOf('--analyze');
    const folder = args[idx + 1];
    if (folder) {
      const absPath = path.resolve(ROOT, folder);
      console.log('Analyzing:', absPath);
      const results = analyzeFolder(absPath);
      console.log(JSON.stringify(results, null, 2));
      process.exit(0);
    } else {
      console.error('Usage: node main.js --analyze <folder>');
      process.exit(1);
    }
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
      scanDirectoryFn: scanDirectory
    });
  }
}

main();

module.exports = { taskManager, log };
