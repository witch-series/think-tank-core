'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { TaskManager, createTask } = require('./core/task-manager');
const {
  dreamPhase, proposeRefactor, applyRefactor,
  generateNextQuestion, getLastCommit,
  saveKnowledge, autoCommit, sanitizeText,
  generateModule, chat, getNewKnowledge
} = require('./core/evolution');
const { doubleCheck } = require('./explorers/verifier');
const { extractInsights, setThinkingCallback } = require('./explorers/crawler');
const { analyzeFolder, analyzeFolderWithLLM, scanDirectory } = require('./lib/analyzer');
const { runAgentLoop } = require('./core/agent-loop');
const { loadConfig } = require('./lib/configurator');
const { runSetup } = require('./lib/setup');
const { startWatcher } = require('./lib/watcher');
const { startCLI } = require('./lib/cli');

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

// --- Config ---
let config;

// --- Server & Timer state (for restart) ---
let httpServer = null;
let idleTimer = null;
let dreamTimer = null;
let restarting = false;

// --- Task Manager ---
const taskManager = new TaskManager();

taskManager.on('task:start', (task) => log('debug', `Task started: ${task.name}`));
taskManager.on('task:complete', ({ task }) => log('debug', `Task completed: ${task.name}`));
taskManager.on('task:error', ({ task, error }) => log('error', `Task failed: ${task.name} — ${error.message}`));

taskManager.on('idle', () => {
  if (idleTimer || restarting) return;
  const interval = config.taskInterval || 60000;
  log('debug', `Queue idle — next autonomous cycle in ${Math.round(interval / 1000)}s`);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!restarting) scheduleAutonomousTasks();
  }, interval);
});

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

  const dbPath = path.resolve(ROOT, config.knowledgeDb);
  let knowledgeCount = 0;
  if (fs.existsSync(dbPath)) {
    const dbFiles = fs.readdirSync(dbPath).filter(f => f.endsWith('.jsonl'));
    for (const file of dbFiles) {
      knowledgeCount += fs.readFileSync(path.join(dbPath, file), 'utf-8').split('\n').filter(Boolean).length;
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

// --- Autonomous Task Generation ---
function scheduleAutonomousTasks() {
  const { url, model } = config.ollama;
  const dbPath = path.resolve(ROOT, config.knowledgeDb);
  const folders = config.targetFolders || [];
  const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');

  // Phase 1: Agent-driven research — web search, page fetch, analysis
  taskManager.enqueue(createTask('agent:research', async () => {
    const context = collectContext();
    const searchPrompt = config.searchPrompt || '最新の技術トレンドを調査してください';

    // Build task description from search prompt + context
    const taskDesc = `## 調査指示\n${searchPrompt}\n\n` +
      `## 現在の知識状態\n- 蓄積知識数: ${context.knowledgeCount}\n- 解析済みファイル数: ${context.fileCount}\n- 直近の活動: ${context.recentActivity}\n\n` +
      `ウェブ検索（search_web）で最新の情報を収集し、関連ページ（fetch_page）の内容を確認して、` +
      `重要な発見をメモ（save_note）に残してください。最後にdoneで結果をまとめてください。`;

    log('info', `Agent research starting: ${searchPrompt.slice(0, 60)}`);

    const result = await runAgentLoop(url, model, taskDesc, ROOT, {
      workLogDir,
      onLog: log,
      systemContext: `検索プロンプト: ${searchPrompt}\n知識数: ${context.knowledgeCount}\nファイル数: ${context.fileCount}`
    });

    // Save successful research to knowledge DB
    if (result.insights && result.insights.length > 0) {
      saveKnowledge(dbPath, 'research', {
        topic: searchPrompt.slice(0, 50),
        query: searchPrompt,
        insights: result.insights,
        summary: result.summary,
        steps: result.steps
      });
      log('info', `Research complete: ${result.insights.length} insights saved (${result.steps} steps)`);
    } else {
      log('info', `Research complete: ${result.summary?.slice(0, 100) || 'no insights'}`);
    }

    return result;
  }));

  // Phase 2: Agent-driven code analysis — read actual files, analyze, summarize
  taskManager.enqueue(createTask('agent:analyze', async () => {
    const targetDesc = folders.length > 0
      ? `対象フォルダ: ${folders.join(', ')}`
      : 'プロジェクトのルートディレクトリ';

    const taskDesc = `## コードベース解析\n${targetDesc}\n\n` +
      `1. まず list_files でプロジェクト構造を確認してください\n` +
      `2. 重要なファイルを read_file または analyze_code で読んでください\n` +
      `3. git_log で最近の変更を確認してください\n` +
      `4. コードの品質、構造、改善点を分析してください\n` +
      `5. 発見をメモ（save_note）に残し、done で結果をまとめてください`;

    log('info', 'Agent code analysis starting');

    const result = await runAgentLoop(url, model, taskDesc, ROOT, {
      workLogDir,
      onLog: log
    });

    if (result.insights && result.insights.length > 0) {
      saveKnowledge(dbPath, 'analysis', {
        topic: 'コードベース解析',
        insights: result.insights,
        summary: result.summary,
        steps: result.steps
      });
      log('info', `Code analysis complete: ${result.insights.length} findings`);
    }

    return result;
  }));

  // Phase 3: Generate code module from accumulated knowledge
  taskManager.enqueue(createTask('generate:module', async () => {
    const knowledge = getNewKnowledge(dbPath, 48);
    if (knowledge.length === 0) {
      log('debug', 'No recent knowledge to generate modules from');
      return { skipped: true };
    }

    // Pick the most recent research entry with insights
    const researchEntries = knowledge.filter(k => k.insights || k.topic);
    if (researchEntries.length === 0) return { skipped: true };

    const entry = researchEntries[researchEntries.length - 1];
    const topic = entry.topic || 'utility';
    const modulesDir = path.resolve(ROOT, 'brain', 'modules');

    log('info', `Generating module from knowledge: ${topic}`);
    const result = await generateModule(url, model, topic, entry, modulesDir);

    if (result.success) {
      log('info', `Module generated: ${path.basename(result.file)} (committed: ${result.committed})`);
    } else if (result.skipped) {
      log('debug', `Module already exists for: ${topic}`);
    } else {
      log('info', `Module generation failed: ${result.reason}`);
    }
    return result;
  }));

  // Phase 4: Code improvement — pick a file, propose refactor, apply if safe
  taskManager.enqueue(createTask('self:improve', async () => {
    const allFiles = [];
    for (const folder of folders) {
      allFiles.push(...scanDirectory(path.resolve(ROOT, folder)));
    }
    if (allFiles.length === 0) {
      log('debug', 'No files to improve yet');
      return { skipped: true };
    }

    const targetFile = allFiles[Math.floor(Math.random() * allFiles.length)];
    log('info', `Proposing refactor: ${path.relative(ROOT, targetFile)}`);
    const proposal = await proposeRefactor(url, model, targetFile);

    if (proposal.refactoredCode) {
      log('info', `Applying refactor to ${path.basename(targetFile)}`);
      const result = await applyRefactor(ROOT, targetFile, proposal.refactoredCode);
      if (result.success) {
        log('info', `Refactor applied and committed: ${path.basename(targetFile)}`);
      } else {
        log('info', `Refactor not applied: ${result.reason}`);
      }
      return { file: targetFile, proposal: proposal.suggestions, applied: result.success };
    }

    log('debug', `No code changes for ${path.basename(targetFile)}: ${proposal.reason || 'no suggestions'}`);
    return { file: targetFile, suggestions: proposal.suggestions };
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
      const result = await dreamPhase(config, ROOT);
      log('info', 'Dream phase completed', result);

      const dbPath = path.resolve(ROOT, config.knowledgeDb);
      saveKnowledge(dbPath, 'dreams', result);

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
            const proposal = await proposeRefactor(config.ollama.url, config.ollama.model, targetFile);
            if (proposal.refactoredCode) {
              return await applyRefactor(ROOT, targetFile, proposal.refactoredCode);
            }
            return { suggestions: proposal.suggestions };
          }));
        } else if (task.query) {
          taskManager.enqueue(createTask(`dream:research:${task.topic}`, async () => {
            log('info', `Dream-driven research: ${task.topic}`);
            const res = await doubleCheck(config.ollama.url, config.ollama.model, task.query);
            if (res.accepted) {
              saveKnowledge(dbPath, 'research', {
                topic: task.topic, query: task.query,
                insights: res.insights, confidence: res.verification.confidence
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

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') { res.end(); return; }

    try {
      if (method === 'GET' && url.pathname === '/status') {
        const dbPath = path.resolve(ROOT, config.knowledgeDb);
        let knowledgeStats = { files: 0, entries: 0 };
        if (fs.existsSync(dbPath)) {
          const files = fs.readdirSync(dbPath).filter(f => f.endsWith('.jsonl'));
          let entries = 0;
          for (const file of files) {
            entries += fs.readFileSync(path.join(dbPath, file), 'utf-8').split('\n').filter(Boolean).length;
          }
          knowledgeStats = { files: files.length, entries };
        }

        const lastCommit = await getLastCommit(ROOT);

        res.end(JSON.stringify({
          taskManager: taskManager.getStatus(),
          knowledge: knowledgeStats,
          lastCommit,
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        }));

      } else if (method === 'GET' && url.pathname === '/logs') {
        const count = parseInt(url.searchParams.get('count') || '50', 10);
        res.end(JSON.stringify(logs.slice(-count)));

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
          return analyzeFolderWithLLM(config.ollama.url, config.ollama.model, absPath);
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

        // Gather recent knowledge for context
        const dbPath = path.resolve(ROOT, config.knowledgeDb);
        const recentKnowledge = getNewKnowledge(dbPath, 24);
        const knowledgeSummary = recentKnowledge.slice(-5).map(k =>
          `[${k.topic || 'unknown'}] ${JSON.stringify(k.insights || k).slice(0, 200)}`
        ).join('\n');

        // Run chat as a prioritized task (user input = highest priority)
        const taskPromise = new Promise((resolve, reject) => {
          taskManager.prioritize(createTask('user:chat', async () => {
            log('info', `User chat: ${message.slice(0, 80)}`);
            try {
              const reply = await chat(config.ollama.url, config.ollama.model, message, {
                systemPrompt: config.searchPrompt,
                knowledge: knowledgeSummary
              });
              resolve(reply);
              return { message, reply };
            } catch (err) {
              reject(err);
              throw err;
            }
          }));
        });

        try {
          const reply = await taskPromise;
          res.end(JSON.stringify({ reply }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }

      } else if (method === 'GET' && url.pathname === '/knowledge') {
        const dbPath = path.resolve(ROOT, config.knowledgeDb);
        const count = parseInt(url.searchParams.get('count') || '50', 10);
        const category = url.searchParams.get('category') || null;

        const entries = [];
        if (fs.existsSync(dbPath)) {
          const files = fs.readdirSync(dbPath).filter(f => f.endsWith('.jsonl'));
          for (const file of files) {
            if (category && file !== `${category}.jsonl`) continue;
            const lines = fs.readFileSync(path.join(dbPath, file), 'utf-8').split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                entry._category = file.replace('.jsonl', '');
                entries.push(entry);
              } catch {}
            }
          }
        }

        // Sort by timestamp descending, return latest N
        entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        res.end(JSON.stringify(entries.slice(0, count)));

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

  // Connect thinking indicator
  setThinkingCallback((active, context) => {
    if (active) {
      log('info', `Thinking... ${context || ''}`);
    }
  });

  // Ensure brain directories exist
  const modulesDir = path.resolve(ROOT, 'brain', 'modules');
  const knowledgeDir = path.resolve(ROOT, config.knowledgeDb);
  const workLogDir = path.resolve(ROOT, 'brain', 'work-logs');
  if (!fs.existsSync(modulesDir)) fs.mkdirSync(modulesDir, { recursive: true });
  if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
  if (!fs.existsSync(workLogDir)) fs.mkdirSync(workLogDir, { recursive: true });

  // Start task manager
  taskManager.queue = [];
  taskManager.currentTask = null;
  taskManager.start();

  // Schedule dream phase
  scheduleDream();

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
