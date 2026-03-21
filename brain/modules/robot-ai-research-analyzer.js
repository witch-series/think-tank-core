/**
 * Robot AI Research Analyzer Module
 *
 * This module provides functionality to analyze research data
 * related to the utilization of AI in robotics.
 * It's currently designed to parse and summarize a single research
 * dataset based on the provided research findings.
 */

'use strict';

/**
 * Analyzes a research data object and extracts key insights.
 *
 * @param {object} researchData - The research data object.
 * @returns {string} - A summary of the research data.
 */
function analyzeResearchData(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    throw new Error('Invalid research data provided.');
  }

  let summary = '';

  if (researchData.topic) {
    summary += `Topic: ${researchData.topic}\n`;
  }

  if (researchData.insights && Array.isArray(researchData.insights)) {
    summary += 'Insights:\n';
    researchData.insights.forEach(insight => {
      summary += `- ${insight}\n`;
    });
  }

  if (researchData.summary) {
    summary += `Summary: ${researchData.summary}\n`;
  }

  if (researchData.timestamp) {
    summary += `Timestamp: ${researchData.timestamp}\n`;
  }

  if (researchData._category) {
    summary += `Category: ${researchData._category}\n`;
  }

  return summary;
}


/**
 * @typedef {object} ResearchData
 * @property {string} [topic] - The topic of the research.
 * @property {string[]} [insights] - An array of insights from the research.
 * @property {string} [summary] - A summary of the research.
 * @property {string} [timestamp] - The timestamp of the research.
 * @property {string} [_category] - The category of the research.
 */

module.exports = { analyzeResearchData };
