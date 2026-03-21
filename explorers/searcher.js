'use strict';

const { fetch, fetchWithRetry } = require('./crawler');
const { URL } = require('url');

/**
 * Wait for specified milliseconds
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decode HTML entities in text
 */
function decodeEntities(text) {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

/**
 * Search DuckDuckGo HTML and extract results.
 * Uses POST method for reliability. Retries on 202 (rate limit).
 */
async function searchWeb(query, maxResults = 5) {
  const searchUrl = 'https://html.duckduckgo.com/html/';
  const formBody = 'q=' + encodeURIComponent(query);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'text/html',
    'Referer': 'https://duckduckgo.com/'
  };

  let html = '';

  // Try up to 3 times with increasing delays (DDG returns 202 when rate limited)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(searchUrl, { method: 'POST', headers, body: formBody });

      if (res.status === 200 && res.body.includes('result__a')) {
        html = res.body;
        break;
      }

      // 202 = rate limited, wait and retry
      if (res.status === 202 || !res.body.includes('result__a')) {
        if (attempt < 3) {
          await wait(attempt * 2000);
          continue;
        }
      }
    } catch {
      if (attempt < 3) await wait(attempt * 2000);
    }
  }

  if (!html) return [];

  const results = [];

  // Extract result links and titles
  const resultBlockRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetBlockRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
    let href = match[1].replace(/&amp;/g, '&');

    // Skip ads (contain ad_domain or ad_provider in URL)
    if (href.includes('ad_domain') || href.includes('ad_provider')) continue;

    // DuckDuckGo wraps URLs in redirect links — extract the real URL
    try {
      const parsed = new URL(href, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {}

    // Skip if still a duckduckgo internal URL
    if (href.includes('duckduckgo.com/y.js') || href.includes('duckduckgo.com/?q')) continue;

    const title = decodeEntities(match[2].replace(/<[^>]+>/g, '')).trim();
    if (href && title && href.startsWith('http')) {
      results.push({ url: href, title, snippet: '' });
    }
  }

  // Extract snippets
  let i = 0;
  while ((match = snippetBlockRegex.exec(html)) !== null && i < results.length) {
    results[i].snippet = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
    i++;
  }

  return results;
}

/**
 * Fetch a web page and extract readable text content
 */
async function fetchPage(pageUrl, maxLength = 6000) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,text/plain,application/json',
        'Accept-Language': 'ja,en;q=0.9'
      }
    });

    if (res.status !== 200) return { url: pageUrl, error: `HTTP ${res.status}` };

    let text = res.body;

    // Remove non-content elements
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
    // Remove all tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode entities
    text = decodeEntities(text);
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
