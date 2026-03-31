'use strict';

const { fillPrompt } = require('../lib/prompt-loader');
const { parseJsonSafe } = require('../lib/json-parser');

/**
 * @param {import('../lib/ollama-client').OllamaClient} client
 */
const verify = async (client, originalInsights, sourceText) => {
  const prompt = fillPrompt('verify.user', {
    sourceText,
    insights: JSON.stringify(originalInsights, null, 2)
  });

  const response = await client.query(prompt);

  const parsed = parseJsonSafe(response.response || '');
  if (parsed) return parsed;

  return {
    verified: false,
    confidence: 0,
    issues: ['Failed to parse verification response'],
    approved: null,
    rejected: ['Verification parse failure']
  };
}

/**
 * @param {import('../lib/ollama-client').OllamaClient} client
 */
const extractInsights = async (client, sourceText, systemPrompt) => {
  const prompt = fillPrompt('extract-insights.user', { sourceText });

  const response = await client.query(prompt, systemPrompt);

  const parsed = parseJsonSafe(response.response || '');
  if (parsed) return parsed;

  return {
    raw: response.response,
    issues: [],
    actions: [],
    remaining: [],
    possibilities: []
  };
}

/**
 * @param {import('../lib/ollama-client').OllamaClient} client
 */
const doubleCheck = async (client, sourceText) => {
  const insights = await extractInsights(client, sourceText);
  const verification = await verify(client, insights, sourceText);

  return {
    insights,
    verification,
    accepted: verification.verified && verification.confidence >= 0.7,
    timestamp: new Date().toISOString()
  };
}

module.exports = { verify, doubleCheck, extractInsights };
