'use strict';

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');
const cache = new Map();

/**
 * Load a prompt template from the prompts/ directory.
 * @param {string} name - Prompt file name without extension (e.g. 'generate-module.user')
 * @returns {string} The prompt template text
 */
const loadPrompt = (name) => {
  const filePath = path.join(PROMPTS_DIR, `${name}.txt`);
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = cache.get(name);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  const text = fs.readFileSync(filePath, 'utf-8');
  cache.set(name, { text, mtimeMs });
  return text;
}

/**
 * Load a prompt template and fill in placeholders.
 * Placeholders use {{key}} syntax. A single regex pass replaces all known keys
 * in O(n) over the template, avoiding per-key RegExp construction.
 * @param {string} name - Prompt file name without extension
 * @param {Record<string, string>} vars - Variables to substitute
 * @returns {string} The filled prompt
 */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;
const fillPrompt = (name, vars = {}) => {
  const text = loadPrompt(name);
  return text.replace(PLACEHOLDER_RE, (match, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

/**
 * Clear the prompt cache (useful for hot reload).
 */
const clearPromptCache = () => {
  cache.clear();
}

module.exports = { loadPrompt, fillPrompt, clearPromptCache };
