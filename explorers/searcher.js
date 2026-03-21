'use strict';

const { fetch } = require('./crawler');
const { URL } = require('url');

/**
 * Search DuckDuckGo HTML and extract results
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return
 * @returns {Promise<Array<{url: string, title: string, snippet: string}>>}
 */
async function searchWeb(query, maxResults = 5) {
  const encoded = encodeURIComponent(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9'
      }
    });

    if (res.status !== 200) return [];

    const html = res.body;
    const results = [];

    // Extract result links and titles
    const resultBlockRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetBlockRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
      let href = match[1];
      // DuckDuckGo wraps URLs in redirect links
      try {
        const parsed = new URL(href, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) href = decodeURIComponent(uddg);
      } catch {}

      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (href && title) {
        results.push({ url: href, title, snippet: '' });
      }
    }

    // Extract snippets
    let i = 0;
    while ((match = snippetBlockRegex.exec(html)) !== null && i < results.length) {
      results[i].snippet = match[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
      i++;
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Fetch a web page and extract readable text content
 * @param {string} pageUrl - URL to fetch
 * @param {number} maxLength - Maximum text length
 * @returns {Promise<{url: string, text?: string, error?: string}>}
 */
async function fetchPage(pageUrl, maxLength = 8000) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,text/plain,application/json',
        'Accept-Language': 'ja,en;q=0.9'
      }
    });

    if (res.status !== 200) return { url: pageUrl, error: `HTTP ${res.status}` };

    let text = res.body;

    // Remove scripts, styles, nav, footer
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
    // Remove all tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode common HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&[a-z]+;/gi, ' ');
    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n');
    text = text.trim();

    return { url: pageUrl, text: text.slice(0, maxLength) };
  } catch (err) {
    return { url: pageUrl, error: err.message };
  }
}

module.exports = { searchWeb, fetchPage };
