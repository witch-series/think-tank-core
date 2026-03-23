'use strict';

/**
 * Model capability detection and configuration.
 * Adjusts batch sizes and retry counts based on model size.
 */

const PRESETS = {
  small: {
    pruneBatchSize: 10,
    pruneMaxRounds: 3,
    reviewBatchSize: 20,
    jsonRetries: 3
  },
  medium: {
    pruneBatchSize: 20,
    pruneMaxRounds: 4,
    reviewBatchSize: 40,
    jsonRetries: 2
  },
  large: {
    pruneBatchSize: 30,
    pruneMaxRounds: 5,
    reviewBatchSize: 80,
    jsonRetries: 1
  }
};

/**
 * Detect model capability from model name.
 * Looks for parameter-size patterns like ":4b", ":7b", ":20b".
 */
function detectCapability(modelName) {
  if (!modelName) return 'medium';
  const sizeMatch = modelName.match(/:(\d+\.?\d*)b/i);
  if (sizeMatch) {
    const billions = parseFloat(sizeMatch[1]);
    if (billions <= 8) return 'small';
    if (billions <= 20) return 'medium';
    return 'large';
  }
  // Known small models without size suffix
  const lowerName = modelName.toLowerCase();
  if (/phi|gemma.*2b|tinyllama|qwen.*0\.5b/.test(lowerName)) return 'small';
  return 'medium';
}

/**
 * Get model configuration based on settings.
 * @param {object} ollamaConfig - { model, dreamModel, modelCapability? }
 * @returns {object} Configuration preset
 */
function getModelConfig(ollamaConfig) {
  const capability = ollamaConfig.modelCapability || detectCapability(ollamaConfig.model);
  return PRESETS[capability] || PRESETS.medium;
}

module.exports = { detectCapability, getModelConfig };
