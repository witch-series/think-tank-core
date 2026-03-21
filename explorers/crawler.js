'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function fetch(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'ThinkTank/1.0',
        ...options.headers
      }
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }

    req.end();
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(urlString, options = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(urlString, options);
    } catch (err) {
      const isRetryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(err.code);
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = attempt * 3000;
      if (options.onRetry) options.onRetry(attempt, maxRetries, err, delay);
      await wait(delay);
    }
  }
}

// Thinking indicator callback — set by caller to display status
let thinkingCallback = null;

function setThinkingCallback(fn) {
  thinkingCallback = fn;
}

function notifyThinking(active, context) {
  if (thinkingCallback) thinkingCallback(active, context);
}

async function queryOllama(ollamaUrl, model, prompt, system) {
  const payload = {
    model,
    prompt,
    system: system || 'You are a research assistant. Extract structured information.',
    stream: false
  };

  notifyThinking(true, `Querying ${model}...`);

  try {
    const res = await fetchWithRetry(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      onRetry: (attempt, max, err, delay) => {
        notifyThinking(true, `Connection error (${err.code}), retry ${attempt}/${max} in ${delay / 1000}s...`);
      }
    });

    notifyThinking(false);

    if (res.status !== 200) {
      throw new Error(`Ollama returned status ${res.status}: ${res.body}`);
    }

    return JSON.parse(res.body);
  } catch (err) {
    notifyThinking(false);
    throw err;
  }
}

async function extractInsights(ollamaUrl, model, sourceText, systemPrompt) {
  const prompt = `以下のテキストから「課題」「行動」「残課題」「可能性」の4項目を抽出してJSON形式で返してください。

テキスト:
${sourceText}

以下のJSON形式で返答してください:
{
  "issues": ["課題1", "課題2"],
  "actions": ["行動1", "行動2"],
  "remaining": ["残課題1", "残課題2"],
  "possibilities": ["可能性1", "可能性2"]
}`;

  const response = await queryOllama(ollamaUrl, model, prompt, systemPrompt);

  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {}

  return {
    raw: response.response,
    issues: [],
    actions: [],
    remaining: [],
    possibilities: []
  };
}

module.exports = { fetch, fetchWithRetry, queryOllama, extractInsights, setThinkingCallback };
