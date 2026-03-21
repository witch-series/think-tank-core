'use strict';

const { fetch } = require('../explorers/crawler');

/**
 * Ollama client with multi-URL failover support.
 *
 * Config: ollama.url can be a single URL or space-separated list:
 *   "http://host1:11434 http://host2:11434 http://host3:11434"
 *
 * The client cycles through URLs in order. If an endpoint fails 3 times
 * consecutively, it moves to the next URL. Once all URLs are exhausted,
 * it wraps around and retries from the beginning.
 */
class OllamaClient {
  /**
   * @param {object} ollamaConfig - { url: string, model: string, dreamModel?: string }
   */
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

    // Thinking indicator
    this._thinkingCallback = null;
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

  /**
   * Switch to the next available URL.
   * Returns true if switched, false if no more URLs to try.
   */
  _switchUrl() {
    const startIndex = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;

    if (this.currentIndex === startIndex) return false; // only one URL
    return true;
  }

  /**
   * Record a failure on the current URL.
   * If the failure count exceeds the threshold, switch to the next URL.
   * @returns {boolean} true if switched to a different URL
   */
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

  /**
   * Record a success — reset the current URL's failure counter.
   */
  _recordSuccess() {
    this.failCounts[this.currentIndex] = 0;
  }

  /**
   * Query the Ollama API. Handles failover across configured URLs.
   * @param {string} prompt - The user prompt
   * @param {string} [system] - System prompt
   * @param {object} [options] - { model: override model }
   * @returns {Promise<{response: string}>}
   */
  async query(prompt, system, options = {}) {
    const model = options.model || this.model;
    const payload = {
      model,
      prompt,
      system: system || 'You are a research assistant. Extract structured information.',
      stream: false
    };

    // Try each URL up to maxFailsBeforeSwitch times before moving to the next.
    // Total attempts = urls * maxFailsBeforeSwitch.
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
          timeout: 120000  // LLM generation can take a while
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

        // Record the failure and let _recordFailure decide when to switch.
        // Do NOT force-switch here — that bypasses the 3-failure threshold.
        this._recordFailure();
        continue;
      }
    }

    throw lastError || new Error('All Ollama endpoints failed');
  }

  /**
   * Get a status summary of the client for monitoring.
   */
  getStatus() {
    return {
      currentUrl: this.url,
      urls: this.urls,
      currentIndex: this.currentIndex,
      failCounts: this.failCounts,
      model: this.model
    };
  }
}

module.exports = { OllamaClient };
