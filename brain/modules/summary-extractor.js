/**
 * Summary Extractor Module
 *
 * This module provides functions to extract key insights and summarize information
 * from a given research data structure.
 */

'use strict';

/**
 * Extracts key insights from a research data object.
 *
 * @param {object} researchData - The research data object.
 * @returns {string[]} An array of extracted insights.
 */
function extractInsights(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    return []; // Handle invalid input
  }

  const insights = researchData.insights || [];
  return insights;
}

/**
 * Extracts the summary string from the research data.
 *
 * @param {object} researchData - The research data object.
 * @returns {string} The summary string.
 */
function getSummary(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    return ''; // Handle invalid input
  }

  const summary = researchData.summary || '';
  return summary;
}

/**
 * Extracts the timestamp from the research data.
 *
 * @param {object} researchData - The research data object.
 * @returns {string} The timestamp string.
 */
function getTimestamp(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    return null; // Handle invalid input
  }

  const timestamp = researchData.timestamp || null;
  return timestamp;
}

/**
 * Extracts the category from the research data.
 *
 * @param {object} researchData - The research data object.
 * @returns {string} The category string.
 */
function getCategory(researchData) {
    if (!researchData || typeof researchData !== 'object') {
        return null; // Handle invalid input
    }

    const category = researchData._category || null;
    return category;
}

/**
 *  Exports the functions.
 * @private
 */
module.exports = {
  extractInsights: extractInsights,
  getSummary: getSummary,
  getTimestamp: getTimestamp,
  getCategory: getCategory
};