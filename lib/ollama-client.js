'use strict';

const { fetch } = require('../explorers/crawler');
const { parseJsonSafe } = require('./json-parser');

/**
 * Ollama client with multi-URL parallel processing and priority queue.
 *
 * Config: ollama.url can be a single URL or space-separated list:
 *   "http://host1:11434 http://host2:11434 http://host3:11434"
 *
 * Each reachable URL gets its own worker that pulls from a shared queue.
 * Priority calls (e.g., user chat) run before normal calls (e.g., autonomous research).
 * Unreachable URLs are retried periodically.
 */
class OllamaClient {
  constructor(ollamaConfig) {
    this.urls = (ollamaConfig.url || 'http://localhost:11434')
      .split(/\s+/)
      .map(u => u.trim())
      .filter(Boolean);
    this.model = ollamaConfig.model || 'llama3';
    this.dreamModel = ollamaConfig.dreamModel || this.model;

    this._thinkingCallback = null;

    // Per-URL state
    this._urlState = this.urls.map(url => ({
      url,
      alive: true,     // assume alive until proven otherwise
      busy: false,
      failCount: 0
    }));

    // Shared queue (priority items first)
    this._priorityQueue = [];
    this._normalQueue = [];

    // Health check interval (re-check dead URLs every 60s)
    this._healthInterval = setInterval(() => this._recheckDeadUrls(), 60000);

    // Initial health check (non-blocking)
    this._initialHealthCheck();
  }

  get url() {
    // Return first alive URL for compatibility
    const alive = this._urlState.find(s => s.alive);
    return alive ? alive.url : this._urlState[0].url;
  }

  setThinkingCallback(fn) {
    this._thinkingCallback = fn;
  }

  _notifyThinking(active, context) {
    if (this._thinkingCallback) this._thinkingCallback(active, context);
  }

  /**
   * Quick connectivity check for a single URL.
   */
  async _checkUrl(urlState) {
    try {
      const res = await fetch(`${urlState.url}/api/tags`, { timeout: 5000 });
      urlState.alive = res.status === 200;
      if (urlState.alive) urlState.failCount = 0;
    } catch {
      urlState.alive = false;
    }
  }

  async _initialHealthCheck() {
    await Promise.all(this._urlState.map(s => this._checkUrl(s)));
    // If nothing is alive, mark all as alive to allow retry on actual queries
    if (!this._urlState.some(s => s.alive)) {
      this._urlState.forEach(s => { s.alive = true; });
    }
  }

  async _recheckDeadUrls() {
    const dead = this._urlState.filter(s => !s.alive);
    if (dead.length === 0) return;
    await Promise.all(dead.map(s => this._checkUrl(s)));
    // If a URL came back, kick off queue processing
    if (dead.some(s => s.alive)) this._processQueue();
  }

  /**
   * Query the Ollama API. Handles parallel execution across available URLs.
   * @param {string} prompt - The user prompt
   * @param {string} [system] - System prompt
   * @param {object} [options] - { model, json, priority }
   * @returns {Promise<{response: string}>}
   */
  query(prompt, system, options = {}) {
    const isPriority = options.priority || false;

    return new Promise((resolve, reject) => {
      const item = { resolve, reject, args: [prompt, system, options] };
      if (isPriority) {
        this._priorityQueue.push(item);
      } else {
        this._normalQueue.push(item);
      }
      this._processQueue();
    });
  }

  /**
   * Process queue: assign pending items to any idle+alive workers.
   */
  _processQueue() {
    const idleAlive = this._urlState.filter(s => s.alive && !s.busy);

    for (const worker of idleAlive) {
      let item;
      if (this._priorityQueue.length > 0) {
        item = this._priorityQueue.shift();
      } else if (this._normalQueue.length > 0) {
        item = this._normalQueue.shift();
      } else {
        break; // no more work
      }

      worker.busy = true;
      this._executeOnWorker(worker, item);
    }
  }

  /**
   * Execute a single query on a specific URL worker.
   */
  async _executeOnWorker(worker, item) {
    try {
      const result = await this._executeQuery(worker, ...item.args);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      worker.busy = false;
      this._processQueue();
    }
  }

  /**
   * Internal: actually execute the LLM query on a specific worker URL.
   * If the worker fails, try other alive URLs before giving up.
   */
  async _executeQuery(worker, prompt, system, options = {}) {
    const model = options.model || this.model;
    const payload = {
      model,
      prompt,
      system: system || 'You are a research assistant. Extract structured information.',
      stream: false
    };
    if (options.json) {
      payload.format = 'json';
    }

    // Try the assigned worker first, then fall back to others
    const urlOrder = [worker, ...this._urlState.filter(s => s !== worker && s.alive)];
    let lastError = null;

    for (const urlState of urlOrder) {
      this._notifyThinking(true, `Querying ${model} at ${urlState.url}...`);

      try {
        const res = await fetch(`${urlState.url}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          timeout: 600000
        });

        this._notifyThinking(false);

        if (res.status !== 200) {
          lastError = new Error(`LLM request failed (${model}): status ${res.status} from ${urlState.url}`);
          urlState.failCount++;
          if (urlState.failCount >= 3) urlState.alive = false;
          continue;
        }

        urlState.failCount = 0;
        urlState.alive = true;
        return JSON.parse(res.body);
      } catch (err) {
        this._notifyThinking(false);
        const isTimeout = err.message === 'Request timed out' || err.code === 'ETIMEDOUT';
        lastError = new Error(
          isTimeout
            ? `LLM timeout (${model} at ${urlState.url}) — model may need more time to respond`
            : `LLM request error (${model} at ${urlState.url}): ${err.message}`
        );
        urlState.failCount++;
        if (urlState.failCount >= 3) urlState.alive = false;
        continue;
      }
    }

    // All failed — mark nothing as alive and throw
    throw lastError || new Error('All Ollama endpoints failed');
  }

  /**
   * Query and parse JSON response.
   */
  async queryForJson(prompt, system, options = {}) {
    const response = await this.query(prompt, system, { ...options, json: true });
    const text = (response.response || '').trim();
    const parsed = parseJsonSafe(text);
    return { response: text, parsed };
  }

  /**
   * Get status including queue depths and per-URL state.
   */
  getStatus() {
    return {
      currentUrl: this.url,
      urls: this._urlState.map(s => ({
        url: s.url,
        alive: s.alive,
        busy: s.busy,
        failCount: s.failCount
      })),
      model: this.model,
      priorityQueueLength: this._priorityQueue.length,
      normalQueueLength: this._normalQueue.length,
      activeWorkers: this._urlState.filter(s => s.alive && s.busy).length,
      totalAlive: this._urlState.filter(s => s.alive).length
    };
  }

  /**
   * Cleanup interval on shutdown.
   */
  destroy() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }
}

module.exports = { OllamaClient };
