'use strict';

const { fetch } = require('../explorers/crawler');
const { parseJsonSafe } = require('./json-parser');

/**
 * Ollama client with multi-URL failover and priority queue.
 *
 * Config: ollama.url can be a single URL or space-separated list:
 *   "http://host1:11434 http://host2:11434 http://host3:11434"
 *
 * Priority system: calls with priority: true (e.g., user chat) run before
 * normal calls (e.g., autonomous research). This ensures user interactions
 * are responsive even when the system is busy researching.
 */
class OllamaClient {
  constructor(ollamaConfig) {
    this.urls = (ollamaConfig.url || 'http://localhost:11434')
      .split(/\s+/)
      .map(u => u.trim())
      .filter(Boolean);
    this.model = ollamaConfig.model || 'llama3';
    this.dreamModel = ollamaConfig.dreamModel || this.model;

    this.currentIndex = 0;
    this.failCounts = new Array(this.urls.length).fill(0);
    this.maxFailsBeforeSwitch = 3;

    this._thinkingCallback = null;

    // Priority queue: ensures user requests run before autonomous ones
    this._running = false;
    this._priorityQueue = []; // { priority, resolve, reject, args }
    this._normalQueue = [];
  }

  get url() {
    return this.urls[this.currentIndex];
  }

  setThinkingCallback(fn) {
    this._thinkingCallback = fn;
  }

  _notifyThinking(active, context) {
    if (this._thinkingCallback) this._thinkingCallback(active, context);
  }

  _switchUrl() {
    const startIndex = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    if (this.currentIndex === startIndex) return false;
    return true;
  }

  _recordFailure() {
    this.failCounts[this.currentIndex]++;
    if (this.failCounts[this.currentIndex] >= this.maxFailsBeforeSwitch) {
      const oldUrl = this.url;
      if (this._switchUrl()) {
        this._notifyThinking(true, `Switching from ${oldUrl} to ${this.url}`);
        return true;
      }
    }
    return false;
  }

  _recordSuccess() {
    this.failCounts[this.currentIndex] = 0;
  }

  /**
   * Internal: process the next queued request.
   * Priority queue is drained first, then normal queue.
   */
  _processNext() {
    if (this._running) return;

    let item;
    if (this._priorityQueue.length > 0) {
      item = this._priorityQueue.shift();
    } else if (this._normalQueue.length > 0) {
      item = this._normalQueue.shift();
    } else {
      return;
    }

    this._running = true;
    this._executeQuery(...item.args)
      .then(result => item.resolve(result))
      .catch(err => item.reject(err))
      .finally(() => {
        this._running = false;
        this._processNext();
      });
  }

  /**
   * Query the Ollama API. Handles failover across configured URLs.
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
      this._processNext();
    });
  }

  /**
   * Internal: actually execute the LLM query with failover.
   */
  async _executeQuery(prompt, system, options = {}) {
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

    const totalAttempts = this.urls.length * this.maxFailsBeforeSwitch;
    let lastError = null;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      const currentUrl = this.url;
      this._notifyThinking(true, `Querying ${model} at ${currentUrl}...`);

      try {
        const res = await fetch(`${currentUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          timeout: 120000
        });

        this._notifyThinking(false);

        if (res.status !== 200) {
          lastError = new Error(`Ollama returned status ${res.status}: ${res.body.slice(0, 200)}`);
          this._recordFailure();
          continue;
        }

        this._recordSuccess();
        return JSON.parse(res.body);
      } catch (err) {
        this._notifyThinking(false);
        lastError = err;
        this._recordFailure();
        continue;
      }
    }

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
   * Get status including queue depths.
   */
  getStatus() {
    return {
      currentUrl: this.url,
      urls: this.urls,
      currentIndex: this.currentIndex,
      failCounts: this.failCounts,
      model: this.model,
      priorityQueueLength: this._priorityQueue.length,
      normalQueueLength: this._normalQueue.length,
      busy: this._running
    };
  }
}

module.exports = { OllamaClient };
