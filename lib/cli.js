'use strict';

const readline = require('readline');

function startCLI(context) {
  const { taskManager, getConfig, getClient, log, restart, createTaskFn, doubleCheckFn, saveKnowledgeFn, analyzeFolderWithLLMFn, scanDirectoryFn } = context;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'think-tank> '
  });

  // Prevent log output from corrupting the prompt line
  const originalLog = context.rawLog;
  context.overrideLog((level, message, data) => {
    if (level === 'debug') return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level}] ${message}`);
    rl.prompt(true);
  });

  console.log('\nInteractive mode. Type "help" for commands.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const [cmd, ...args] = input.split(/\s+/);
    const rest = args.join(' ');
    const config = getConfig();

    switch (cmd) {
      case 'help':
        console.log([
          'Commands:',
          '  status           — Show task manager status',
          '  queue            — Show queued tasks',
          '  pause            — Pause task execution',
          '  resume           — Resume task execution',
          '  inject <prompt>  — Prioritize a research task with the given prompt',
          '  analyze <folder> — Prioritize folder analysis',
          '  prompt <text>    — Update the search system prompt',
          '  prompt           — Show current search prompt',
          '  config           — Show current config',
          '  logs [n]         — Show last n log entries (default 20)',
          '  restart          — Reload code and config',
          '  exit             — Shut down',
        ].join('\n'));
        break;

      case 'status':
        console.log(JSON.stringify(taskManager.getStatus(), null, 2));
        break;

      case 'queue':
        const status = taskManager.getStatus();
        if (status.currentTask) console.log(`  Running: ${status.currentTask}`);
        if (status.queuedTasks.length === 0) {
          console.log('  Queue is empty');
        } else {
          status.queuedTasks.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
        }
        break;

      case 'pause':
        taskManager.pause();
        console.log('Task execution paused.');
        break;

      case 'resume':
        taskManager.resume();
        console.log('Task execution resumed.');
        break;

      case 'inject':
        if (!rest) { console.log('Usage: inject <research prompt>'); break; }
        taskManager.prioritize(createTaskFn(`cli:research`, async () => {
          log('info', `CLI research: ${rest}`);
          const result = await doubleCheckFn(getClient(), rest);
          const dbPath = require('path').resolve(context.root, config.knowledgeDb);
          if (result.accepted) {
            saveKnowledgeFn(dbPath, 'research', {
              topic: rest,
              query: rest,
              insights: result.insights,
              confidence: result.verification.confidence,
              source: 'cli'
            });
            log('info', `CLI knowledge saved (confidence: ${result.verification.confidence})`);
          } else {
            log('info', `CLI knowledge rejected (failed double-check)`);
          }
          return result;
        }));
        console.log(`Research task queued: "${rest}"`);
        break;

      case 'analyze':
        if (!rest) { console.log('Usage: analyze <folder>'); break; }
        const absPath = require('path').resolve(context.root, rest);
        taskManager.prioritize(createTaskFn(`cli:analyze:${rest}`, async () => {
          log('info', `CLI analyze: ${absPath}`);
          return analyzeFolderWithLLMFn(getClient(), absPath);
        }));
        console.log(`Analyze task queued: ${absPath}`);
        break;

      case 'prompt':
        if (!rest) {
          console.log(`Current search prompt:\n  ${config.searchPrompt || '(not set)'}`);
        } else {
          config.searchPrompt = rest;
          // Persist to settings.json
          const fs = require('fs');
          const configPath = require('path').join(context.root, 'config', 'settings.json');
          try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
            console.log('Search prompt updated and saved.');
          } catch (err) {
            console.log(`Search prompt updated in memory. Save failed: ${err.message}`);
          }
        }
        break;

      case 'config':
        console.log(JSON.stringify(config, null, 2));
        break;

      case 'logs': {
        const count = parseInt(args[0] || '20', 10);
        const entries = context.getLogs(count);
        for (const entry of entries) {
          console.log(`[${entry.timestamp}] [${entry.level}] ${entry.message}`);
        }
        break;
      }

      case 'restart':
        console.log('Restarting...');
        await restart();
        break;

      case 'exit':
        console.log('Shutting down...');
        process.exit(0);
        break;

      default:
        console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nCLI closed. Server continues running. Press Ctrl+C to stop.');
  });

  return rl;
}

module.exports = { startCLI };
