'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');

function ask(rl, question, defaultValue) {
  const suffix = defaultValue != null ? ` (${defaultValue})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || (defaultValue != null ? String(defaultValue) : ''));
    });
  });
}

async function runSetup(configPath) {
  const defaultPath = configPath.replace(/settings\.json$/, 'settings.default.json');
  let defaults = {};
  if (fs.existsSync(configPath)) {
    defaults = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else if (fs.existsSync(defaultPath)) {
    defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Think Tank Core Setup ===\n');

  // Ollama
  console.log('-- Ollama --');
  const ollamaUrl = await ask(rl, 'Ollama URL', defaults.ollama?.url || 'http://localhost:11434');
  const model = await ask(rl, 'Model name', defaults.ollama?.model || 'llama3');
  const dreamModel = await ask(rl, 'Dream Phase model (blank = same as above)', defaults.ollama?.dreamModel || '');

  // Server
  console.log('\n-- Server --');
  const port = await ask(rl, 'API server port', defaults.server?.port || 3000);

  // Search / Exploration
  console.log('\n-- Exploration --');
  const searchPrompt = await ask(rl,
    'Search system prompt\n  (LLM が外部知見を探索する際の指示)',
    defaults.searchPrompt || 'あなたはリサーチアシスタントです。与えられたトピックについて調査し、「課題」「行動」「残課題」「可能性」を抽出してください。');

  // Target folders
  console.log('\n-- Analysis --');
  const foldersRaw = await ask(rl, 'Target folders (comma separated)', (defaults.targetFolders || ['./brain/modules']).join(', '));
  const targetFolders = foldersRaw.split(',').map(s => s.trim()).filter(Boolean);

  // Schedule
  console.log('\n-- Schedule --');
  const dreamHour = await ask(rl, 'Dream Phase hour (0-23)', defaults.dreamHour != null ? defaults.dreamHour : 5);
  const taskInterval = await ask(rl, 'Autonomous cycle interval (seconds)', Math.round((defaults.taskInterval || 60000) / 1000));

  rl.close();

  const config = {
    ollama: {
      url: ollamaUrl,
      model,
      dreamModel: dreamModel || model
    },
    server: { port: parseInt(port, 10) },
    searchPrompt,
    targetFolders,
    dreamHour: parseInt(dreamHour, 10),
    taskInterval: parseInt(taskInterval, 10) * 1000,
    maxConcurrentTasks: defaults.maxConcurrentTasks || 1,
    knowledgeDb: defaults.knowledgeDb || './brain/knowledge-db',
    summaryExtension: defaults.summaryExtension || '.summary.json'
  };

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\nConfig saved to ${configPath}\n`);
  return config;
}

module.exports = { runSetup };
