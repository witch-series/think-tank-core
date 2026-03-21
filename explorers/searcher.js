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

// --- Brave Search (primary) ---

/**
 * Search using Brave Search and extract results from HTML.
 */
async function searchBrave(query, maxResults = 5) {
  const q = encodeURIComponent(query);
  const searchUrl = `https://search.brave.com/search?q=${q}&source=web`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8'
      },
      timeout: 20000
    });

    if (res.status !== 200) return [];

    const html = res.body;
    const results = [];

    // Extract external URLs from Brave results
    // Brave embeds result URLs as plain href attributes
    const hrefRegex = /href="(https?:\/\/(?!search\.brave|brave\.com|cdn\.search\.brave|imgs\.search\.brave|tiles\.search\.brave)[^"]+)"/g;
    const seen = new Set();
    let match;

    while ((match = hrefRegex.exec(html)) !== null && results.length < maxResults) {
      const url = decodeEntities(match[1]);

      // Skip duplicates, images, tracking, and non-content URLs
      if (seen.has(url)) continue;
      if (/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff)(\?|$)/i.test(url)) continue;
      if (url.includes('favicon') || url.includes('/ads/') || url.includes('doubleclick')) continue;

      seen.add(url);

      // Try to extract title from surrounding context (look back for text)
      const urlPos = match.index;
      const surroundingHtml = html.slice(Math.max(0, urlPos - 200), Math.min(html.length, urlPos + 500));

      // Look for title-like text near the link
      let title = '';
      const titleMatch = surroundingHtml.match(/>([^<]{10,100})<\/a>/);
      if (titleMatch) {
        title = decodeEntities(titleMatch[1]).trim();
      }

      // Look for snippet/description near this result
      let snippet = '';
      const snippetMatch = surroundingHtml.match(/class="[^"]*snippet[^"]*"[^>]*>([\s\S]{10,300}?)<\//i);
      if (snippetMatch) {
        snippet = decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, '')).trim();
      }

      results.push({ url, title: title || url.split('/').slice(2, 4).join('/'), snippet });
    }

    return results;
  } catch {
    return [];
  }
}

// --- DuckDuckGo Search (fallback) ---

/**
 * Search DuckDuckGo HTML and extract results.
 * Uses POST method. Retries on 202 (rate limit).
 */
async function searchDDG(query, maxResults = 5) {
  const searchUrl = 'https://html.duckduckgo.com/html/';
  const formBody = 'q=' + encodeURIComponent(query);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'text/html',
    'Referer': 'https://duckduckgo.com/'
  };

  let html = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(searchUrl, { method: 'POST', headers, body: formBody, timeout: 15000 });

      if (res.status === 200 && res.body.includes('result__a')) {
        html = res.body;
        break;
      }

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

  const resultBlockRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetBlockRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
    let href = match[1].replace(/&amp;/g, '&');

    if (href.includes('ad_domain') || href.includes('ad_provider')) continue;

    try {
      const parsed = new URL(href, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) href = decodeURIComponent(uddg);
    } catch {}

    if (href.includes('duckduckgo.com/y.js') || href.includes('duckduckgo.com/?q')) continue;

    const title = decodeEntities(match[2].replace(/<[^>]+>/g, '')).trim();
    if (href && title && href.startsWith('http')) {
      results.push({ url: href, title, snippet: '' });
    }
  }

  let i = 0;
  while ((match = snippetBlockRegex.exec(html)) !== null && i < results.length) {
    results[i].snippet = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
    i++;
  }

  return results;
}

// --- Combined search with fallback ---

/**
 * Search the web using Brave Search (primary) with DuckDuckGo fallback.
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results
 * @returns {Promise<Array<{url: string, title: string, snippet: string}>>}
 */
async function searchWeb(query, maxResults = 5) {
  // Try Brave first
  let results = await searchBrave(query, maxResults);
  if (results.length > 0) return results;

  // Fallback to DuckDuckGo
  results = await searchDDG(query, maxResults);
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
      },
      timeout: 20000
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

/**
 * Search arxiv for academic papers using the Atom API.
 * @param {string} query - Search query (English recommended)
 * @param {number} maxResults - Maximum number of results
 * @returns {Promise<Array<{title: string, summary: string, url: string, authors: string[], published: string}>>}
 */
async function searchArxiv(query, maxResults = 5) {
  const searchUrl = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'think-tank-core/1.0 (research bot)',
        'Accept': 'application/atom+xml'
      },
      timeout: 15000
    });

    if (res.status !== 200) return [];

    const xml = res.body;
    const papers = [];

    // Parse Atom XML entries
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    let entryMatch;
    while ((entryMatch = entryRegex.exec(xml)) !== null && papers.length < maxResults) {
      const entry = entryMatch[1];

      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
      const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
      const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
      const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);

      // Extract authors
      const authors = [];
      const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/gi;
      let authorMatch;
      while ((authorMatch = authorRegex.exec(entry)) !== null) {
        authors.push(authorMatch[1].trim());
      }

      const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
      const summary = summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim() : '';
      const url = idMatch ? idMatch[1].trim() : '';

      if (title && url) {
        papers.push({
          title,
          summary,
          url,
          authors,
          published: publishedMatch ? publishedMatch[1].trim() : ''
        });
      }
    }

    return papers;
  } catch {
    return [];
  }
}

module.exports = { searchWeb, fetchPage, searchArxiv };
