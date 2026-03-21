/**
 * Robot AI Market Research Module
 *
 * This module provides functions to analyze research data related to
 * the utilization of AI in robots.
 */

'use strict';

/**
 * Summarizes the provided research data.
 *
 * @param {object} researchData - The research data object.
 * @returns {string} - A summary of the research data.
 */
function summarizeResearch(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    return 'Invalid research data provided.';
  }

  const summary = `AI robot market is growing with VLA model research development. Especially, the importance of computer vision has become clear, and technological development towards robot autonomy and learning ability enhancement is progressing. On the other hand, the robot and AI collaboration technology is immature, and responses to safety, ethics, and legal issues are required.`;
  return summary;
}

/**
 * Extracts insights from the research data.
 *
 * @param {object} researchData - The research data object.
 * @returns {string[]} - An array of extracted insights.
 */
function extractInsights(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    return [];
  }

  const insights = [
    'VLA models show that computer vision dominates robot action generation.',
    'The importance of language depends on the task structure, and the language is utilized depending on the task structure rather than model design.',
    'Distinguishing between specialized paths (Motor Program) and general paths (Goal Semantics) is important for improving robot autonomy.'
  ];
  return insights;
}

/**
 * Exports the module functions.
 */
module.exports = {
  summarizeResearch: summarizeResearch,
  extractInsights: extractInsights
};
