/**
 * Summary Builder Module
 * 
 * This module provides functions for summarizing information based on a provided data structure.
 * It's designed to be a lightweight and reusable solution for quickly extracting key insights.
 */

'use strict';

/**
 * Summarizes research information into a concise overview.
 *
 * @param {object} researchData - The research data object containing the insights and summary.
 * @returns {string} - A concise summary of the research data.
 * @throws {Error} - If researchData is not an object.
 */
function buildSummary(researchData) {
  // Input validation
  if (typeof researchData !== 'object' || researchData === null) {
    throw new Error('researchData must be a non-null object.');
  }

  // Extract relevant information
  const insights = researchData.insights || [];
  const summary = researchData.summary || '';
  const timestamp = researchData.timestamp || '';

  // Construct the summary
  let summaryString = `AI technology advancements and risks are widely reported.`;
  if (insights.length > 0) {
    summaryString += '\n';
    insights.forEach(insight => {
      summaryString += ` - ${insight}`;
    });
  }
  if (summary) {
      summaryString += '\n' + summary;
  }
  if (timestamp) {
      summaryString += '\nTimestamp: ' + timestamp;
  }

  return summaryString;
}


// Export the function
module.exports = {
  buildSummary
};
