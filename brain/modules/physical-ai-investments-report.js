"use strict";

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

/**
 * Fetches the content of a URL using http or https.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<string>} - A promise that resolves with the page content as a string.
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    const httpModule = parsedUrl.protocol === 'https:' ? https : http;
    const request = httpModule.get(parsedUrl, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Request Failed. Status Code: ${res.statusCode}`));
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => resolve(rawData));
    });
    request.on('error', (e) => reject(e));
  });
}

/**
 * Fetches JSON data from a URL.
 * @param {string} url - The URL to fetch JSON from.
 * @returns {Promise<Object>} - A promise that resolves with the parsed JSON object.
 */
function fetchJSON(url) {
  return fetchPage(url)
    .then((data) => JSON.parse(data))
    .catch((err) => {
      throw new Error(`Failed to fetch or parse JSON from ${url}: ${err.message}`);
    });
}

/**
 * Generates a Markdown report from an object containing research data.
 * Expected structure:
 * {
 *   topic: string,
 *   query: string,
 *   insights: string[],
 *   summary: string,
 *   steps: number,
 *   actions: string[],
 *   timestamp: string
 * }
 * @param {Object} data - The data object.
 * @returns {string} - The formatted Markdown report.
 */
function generateReport(data) {
  const { topic, query, insights, summary, steps, actions, timestamp } = data;

  let report = `# ${topic}\n\n`;
  report += `**Query:** ${query}\n\n`;
  report += `**Summary:** ${summary}\n\n`;
  report += `**Steps:** ${steps}\n\n`;
  report += `**Actions:**\n\n`;
  if (Array.isArray(actions)) {
    actions.forEach((act, idx) => {
      report += `  ${idx + 1}. ${act}\n`;
    });
  }
  report += `\n**Insights:**\n\n`;
  if (Array.isArray(insights)) {
    insights.forEach((insight, idx) => {
      report += `  ${idx + 1}. ${insight}\n`;
    });
  }
  report += `\n*Generated at ${timestamp}*\n`;
  return report;
}

/**
 * Writes a string to a file, ensuring the directory exists.
 * @param {string} content - The content to write.
 * @param {string} filePath - The file path where content will be saved.
 * @returns {Promise<void>} - A promise that resolves when the file is written.
 */
function writeReportToFile(content, filePath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filePath);
    fs.mkdir(dir, { recursive: true }, (dirErr) => {
      if (dirErr) return reject(dirErr);
      fs.writeFile(filePath, content, 'utf8', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

module.exports = {
  fetchPage,
  fetchJSON,
  generateReport,
  writeReportToFile
};
