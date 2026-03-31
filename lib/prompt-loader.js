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
  if (cache.has(name)) return cache.get(name);
  const filePath = path.join(PROMPTS_DIR, `${name}.txt`);
  const text = fs.readFileSync(filePath, 'utf-8');
  cache.set(name, text);
  return text;
}

/**
 * Load a prompt template and fill in placeholders.
 * Placeholders use {{key}} syntax.
 * @param {string} name - Prompt file name without extension
 * @param {Record<string, string>} vars - Variables to substitute
 * @returns {string} The filled prompt
 */
const fillPrompt = (name, vars = {}) => {
  let text = loadPrompt(name);
  for (const [key, value] of Object.entries(vars)) {
    text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value ?? '');
  }
  return text;
}

/**
 * Clear the prompt cache (useful for hot reload).
 */
const clearPromptCache = () => {
  cache.clear();
}

module.exports = { loadPrompt, fillPrompt, clearPromptCache };
