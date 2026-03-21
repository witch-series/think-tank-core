'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * Mapping of file extensions to programming languages.
 * @type {Object<string, string>}
 */
const EXTENSION_MAP = {
  js: 'JavaScript',
  ts: 'TypeScript',
  py: 'Python',
  rb: 'Ruby',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
  cs: 'C#',
  go: 'Go',
  rs: 'Rust',
  swift: 'Swift',
  php: 'PHP',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  xml: 'XML',
  sh: 'Shell',
  bat: 'Batch',
  ps1: 'PowerShell',
  md: 'Markdown'
};

/**
 * Recursively walks through a directory and returns all file paths.
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Array of absolute file paths.
 */
function walkDirectory(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDirectory(filePath));
    } else if (stat && stat.isFile()) {
      results.push(filePath);
    }
  });
  return results;
}

/**
 * Reads a file and returns its size in bytes and number of lines.
 * @param {string} filePath - Path to the file.
 * @returns {{size: number, lines: number, language: string}}
 */
function getFileStats(filePath) {
  const stat = fs.statSync(filePath);
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').length;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const language = EXTENSION_MAP[ext] || 'Unknown';
  return {
    size: stat.size,
    lines,
    language
  };
}

/**
 * Analyzes a codebase directory and returns metadata about its files.
 * @param {string} dir - Root directory of the codebase.
 * @returns {Promise<{files: Array<{path: string, size: number, lines: number, language: string}>}>}
 */
async function analyzeCodebase(dir) {
  const absoluteDir = path.resolve(dir);
  const files = walkDirectory(absoluteDir).map((filePath) => {
    const stats = getFileStats(filePath);
    return {
      path: filePath,
      size: stats.size,
      lines: stats.lines,
      language: stats.language
    };
  });
  return { files };
}

/**
 * Summarizes the analysis of a codebase.
 * @param {{files: Array<{path: string, size: number, lines: number, language: string}>}} analysis
 * @returns {string} Summary string.
 */
function summarizeCodebaseAnalysis(analysis) {
  const totalFiles = analysis.files.length;
  const totalLines = analysis.files.reduce((sum, file) => sum + file.lines, 0);
  const totalSize = analysis.files.reduce((sum, file) => sum + file.size, 0);

  const languageCounts = analysis.files.reduce((acc, file) => {
    acc[file.language] = (acc[file.language] || 0) + 1;
    return acc;
  }, {});

  const mostCommonLanguage = Object.entries(languageCounts).reduce(
    (max, [lang, count]) => (count > max.count ? { lang, count } : max),
    { lang: 'N/A', count: 0 }
  ).lang;

  return [
    `Codebase Analysis Summary:`,
    `- Total files: ${totalFiles}`,
    `- Total lines: ${totalLines}`,
    `- Total size: ${totalSize} bytes`,
    `- Most common language: ${mostCommonLanguage}`
  ].join('\n');
}

/**
 * Performs an HTTPS GET request and returns parsed JSON.
 * @param {string} url - Request URL.
 * @returns {Promise<Object>} Parsed JSON response.
 */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Accept: 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

/**
 * Queries DuckDuckGo API for a web search.
 * @param {string} query - Search query.
 * @returns {Promise<Array<{title: string, url: string}>>} Search results.
 */
async function webSearch(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&pretty=1`;
  const json = await httpsGetJson(url);
  if (!json || !json.RelatedTopics) return [];
  return json.RelatedTopics.map((topic) => {
    if (topic.Text && topic.FirstURL) {
      return { title: topic.Text, url: topic.FirstURL };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Performs a simple filename search within the codebase files.
 * @param {Array<string>} filePaths - Array of file paths.
 * @param {string} query - Search query.
 * @returns {Array<{path: string}>} Matching files.
 */
function localSearch(filePaths, query) {
  const lower = query.toLowerCase();
  return filePaths
    .filter((filePath) => path.basename(filePath).toLowerCase().includes(lower))
    .map((filePath) => ({ path: filePath }));
}

/**
 * Searches for a query using web search with fallback to local search.
 * @param {string} query - Search query.
 * @param {Array<string>} localFiles - Array of local file paths for fallback.
 * @returns {Promise<Array<{title?: string, url?: string, path?: string}>>} Search results.
 */
async function search(query, localFiles) {
  try {
    const webResults = await webSearch(query);
    if (webResults && webResults.length > 0) {
      return webResults;
    }
  } catch (err) {
    // Web search failed; proceed to fallback
  }
  // Fallback to local file search
  return localSearch(localFiles, query);
}

/**
 * Runs an analysis agent that collects codebase data, summarizes it,
 * and performs a search query with fallback.
 * @param {string} dir - Codebase directory.
 * @param {string} query - Search query.
 * @returns {Promise<{analysis: Object, summary: string, searchResults: Array}>>}
 */
async function runAnalysisAgent(dir, query) {
  const analysis = await analyzeCodebase(dir);
  const summary = summarizeCodebaseAnalysis(analysis);
  const localFiles = analysis.files.map((f) => f.path);
  const searchResults = await search(query, localFiles);
  return { analysis, summary, searchResults };
}

module.exports = {
  analyzeCodebase,
  summarizeCodebaseAnalysis,
  search,
  runAnalysisAgent
};
