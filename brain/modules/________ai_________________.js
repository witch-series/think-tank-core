'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');

/**
 * Makes an HTTPS or HTTP GET request and resolves with the response body as a string.
 * @param {string} urlString - The URL to request.
 * @param {number} [timeout=10000] - Timeout in milliseconds.
 * @returns {Promise<string>} - Promise that resolves with the response body.
 */
function _get(urlString, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let lib;
    try {
      lib = urlString.startsWith('https') ? https : http;
    } catch (err) {
      return reject(err);
    }

    const req = lib.get(urlString, (res) => {
      const { statusCode } = res;
      const contentType = res.headers['content-type'] || '';
      const decoder = new StringDecoder('utf8');
      let rawData = '';

      if (statusCode !== 200) {
        // Consume response data to free up memory
        res.resume();
        return reject(new Error(`Request Failed.\nStatus Code: ${statusCode}`));
      }

      res.on('data', (chunk) => {
        rawData += decoder.write(chunk);
      });

      res.on('end', () => {
        rawData += decoder.end();
        if (/text\/html|application\/json/.test(contentType)) {
          resolve(rawData);
        } else {
          reject(new Error(`Unsupported content type: ${contentType}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(timeout, () => {
      req.abort();
      reject(new Error(`Request timeout after ${timeout} ms`));
    });
  });
}

/**
 * Searches DuckDuckGo for the given query and returns a list of search results.
 * @param {string} query - The search query.
 * @param {Object} [options] - Optional parameters.
 * @param {number} [options.limit=5] - Number of results to return.
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
async function searchWeb(query, options = {}) {
  const limit = typeof options.limit === 'number' ? options.limit : 5;
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html?q=${encoded}`;

  const html = await _get(searchUrl);
  const results = [];
  const regex = /<a rel="nofollow" class="result__a" href="(.*?)"[^>]*>(.*?)<\/a>[\s\S]*?<a rel="nofollow" class="result__snippet" href="[^"]*">([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && results.length < limit) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Fetches the content of a web page.
 * @param {string} url - The URL of the page to fetch.
 * @returns {Promise<string>} - Promise that resolves with the page HTML.
 */
async function fetchPage(url) {
  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    throw new Error(`Invalid URL: ${url}`);
  }
  return _get(parsedUrl.href);
}

/**
 * Runs a full investigation: searches the web, fetches each result page, and returns detailed data.
 * @param {string} query - The search query.
 * @param {Object} [options] - Optional parameters.
 * @param {number} [options.limit=5] - Number of search results to process.
 * @returns {Promise<Array<{ title: string, url: string, snippet: string, content: string }>>}
 */
async function runInvestigation(query, options = {}) {
  const results = await searchWeb(query, options);
  const detailedResults = await Promise.all(
    results.map(async (res) => {
      try {
        const content = await fetchPage(res.url);
        return { ...res, content };
      } catch (e) {
        return { ...res, content: null, error: e.message };
      }
    })
  );
  return detailedResults;
}

module.exports = {
  searchWeb,
  fetchPage,
  runInvestigation,
};
