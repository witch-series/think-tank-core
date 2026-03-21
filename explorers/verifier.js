'use strict';

const { fillPrompt, loadPrompt } = require('../lib/prompt-loader');

/**
 * @param {import('../lib/ollama-client').OllamaClient} client
 */
async function verify(client, originalInsights, sourceText) {
  const prompt = fillPrompt('verify.user', {
    sourceText,
    insights: JSON.stringify(originalInsights, null, 2)
  });

  const response = await client.query(prompt, loadPrompt('verify.system'));

  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {}

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
async function extractInsights(client, sourceText, systemPrompt) {
  const prompt = fillPrompt('extract-insights.user', { sourceText });

  const response = await client.query(prompt, systemPrompt);

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

/**
 * @param {import('../lib/ollama-client').OllamaClient} client
 */
async function doubleCheck(client, sourceText) {
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
