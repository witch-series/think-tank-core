'use strict';

const { fetch, fetchWithRetry } = require('./crawler');
const { URL } = require('url');
const { wait } = require('../lib/utils');

/**
 * Decode HTML entities in text
 */
const decodeEntities = (text) => {
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
const searchBrave = async (query, maxResults = 5) => {
  const q = encodeURIComponent(query);
  const searchUrl = `https://search.brave.com/search?q=${q}&source=web`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8'
      },
      timeout: 10000
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

      // Skip site-root / homepage URLs — we want actual article pages, not landings
      try {
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 0) continue;
        // Skip shallow category/tag pages that rarely contain article body
        if (pathSegments.length === 1 && /^(tag|tags|category|categories|about|contact|privacy|terms|login|signup)$/i.test(pathSegments[0])) continue;
      } catch { continue; }

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
};

// --- DuckDuckGo Search (fallback) ---

/**
 * Search DuckDuckGo HTML and extract results.
 * Uses POST method. Retries on 202 (rate limit).
 */
const searchDDG = async (query, maxResults = 5) => {
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
      const res = await fetch(searchUrl, { method: 'POST', headers, body: formBody, timeout: 10000 });

      if (res.status === 200 && res.body.includes('result__a')) {
        html = res.body;
        break;
      }

      if (res.status === 202 || !res.body.includes('result__a')) {
        if (attempt < 3) {
          await wait(attempt * 1000);
          continue;
        }
      }
    } catch {
      if (attempt < 3) await wait(attempt * 1000);
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
};

// --- Source credibility scoring ---

/**
 * Classify a URL by source type and assign a credibility score.
 * Higher score = more credible/preferred source.
 * @param {string} url - The URL to classify
 * @returns {{type: string, credibility: number}}
 */
const classifySource = (url) => {
  const lower = url.toLowerCase();

  // Tier 1: Academic papers & preprints (credibility 1.0)
  if (/arxiv\.org|scholar\.google|semanticscholar\.org|ieee\.org|acm\.org|springer\.com|nature\.com|sciencedirect\.com|researchgate\.net|openreview\.net|aclweb\.org|nips\.cc|proceedings\.mlr\.press|dl\.acm\.org|pubmed\.ncbi|biorxiv\.org/.test(lower)) {
    return { type: 'academic', credibility: 1.0 };
  }

  // Tier 2: GitHub repos, issues, discussions (credibility 0.9)
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(lower)) {
    return { type: 'repository', credibility: 0.9 };
  }

  // Tier 3: Official documentation & technical references (credibility 0.85)
  if (/\.readthedocs\.io|docs\.|documentation\.|developer\.|devdocs\.io|spec\.|w3\.org|rfc-editor\.org|tc39\.es|pytorch\.org|tensorflow\.org|huggingface\.co/.test(lower)) {
    return { type: 'documentation', credibility: 0.85 };
  }

  // Tier 4: Technical blogs from known organizations (credibility 0.7)
  if (/openai\.com\/blog|deepmind\.com|ai\.googleblog|engineering\.|techblog\.|blog\.google|research\.facebook|aws\.amazon\.com\/blogs|cloud\.google\.com\/blog/.test(lower)) {
    return { type: 'tech_org_blog', credibility: 0.7 };
  }

  // Tier 5: Q&A and wikis (credibility 0.6)
  if (/stackoverflow\.com|stackexchange\.com|wikipedia\.org|wiki\./.test(lower)) {
    return { type: 'wiki_qa', credibility: 0.6 };
  }

  // Blocked: YouTube and video platforms (not useful as research sources)
  if (/youtube\.com|youtu\.be/.test(lower)) {
    return { type: 'blocked', credibility: 0 };
  }

  // Low tier: generic blogs, news aggregators (credibility 0.3)
  if (/medium\.com|dev\.to|qiita\.com|zenn\.dev|note\.com|hatena|ameblo|livedoor|fc2\.com|wordpress\.com|blogspot\.com|tumblr\.com/.test(lower)) {
    return { type: 'blog', credibility: 0.3 };
  }

  // Lowest tier: obvious non-technical (credibility 0.2)
  if (/twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|reddit\.com\/r\/(?!machinelearning|programming|compsci)/.test(lower)) {
    return { type: 'social_media', credibility: 0.2 };
  }

  // Default: unknown sources get moderate score
  return { type: 'other', credibility: 0.5 };
}

// --- GitHub Search ---

/**
 * Search GitHub repositories using the search page.
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results
 * @returns {Promise<Array<{url: string, title: string, snippet: string, credibility: number}>>}
 */
const searchGitHub = async (query, maxResults = 5) => {
  const q = encodeURIComponent(query);
  const searchUrl = `https://github.com/search?q=${q}&type=repositories`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000
    });

    if (res.status !== 200) return [];

    const html = res.body;
    const results = [];

    // Extract repo links from GitHub search results
    const repoRegex = /href="(\/[^"]+\/[^"]+)" data-testid="results-list"/g;
    const seen = new Set();
    let match;

    while ((match = repoRegex.exec(html)) !== null && results.length < maxResults) {
      const repoPath = match[1];
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);

      const url = `https://github.com${repoPath}`;
      const title = repoPath.slice(1); // Remove leading /

      // Try to extract description near this link
      const pos = match.index;
      const nearby = html.slice(pos, Math.min(html.length, pos + 800));
      const descMatch = nearby.match(/class="[^"]*topic-tag[^"]*"[^>]*>([^<]+)/i) ||
                         nearby.match(/>([^<]{20,200})<\/p>/);
      const snippet = descMatch ? decodeEntities(descMatch[1]).trim() : '';

      results.push({ url, title, snippet, credibility: 0.9 });
    }

    // Fallback: try simpler pattern if data-testid not found
    if (results.length === 0) {
      const simpleRegex = /href="(\/[\w\-]+\/[\w\-]+)"[^>]*>\s*<span[^>]*>[\w\-]+\s*\/\s*<\/span>/g;
      while ((match = simpleRegex.exec(html)) !== null && results.length < maxResults) {
        const repoPath = match[1];
        if (seen.has(repoPath)) continue;
        if (repoPath.includes('/search') || repoPath.includes('/settings')) continue;
        seen.add(repoPath);
        const url = `https://github.com${repoPath}`;
        results.push({ url, title: repoPath.slice(1), snippet: '', credibility: 0.9 });
      }
    }

    return results;
  } catch {
    return [];
  }
};

// --- Combined search with fallback ---

/**
 * Search the web using Brave Search (primary) with DuckDuckGo fallback.
 * Results include credibility scores.
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results
 * @returns {Promise<Array<{url: string, title: string, snippet: string, credibility: number}>>}
 */
const searchWeb = async (query, maxResults = 5) => {
  // Start both, but resolve early if Brave succeeds (don't wait for DDG)
  const bravePromise = searchBrave(query, maxResults).catch(() => []);
  const ddgPromise = searchDDG(query, maxResults).catch(() => []);
  const braveResults = await bravePromise;
  const results = braveResults.length > 0 ? braveResults : await ddgPromise;

  // Attach credibility scores and filter out blocked sources
  return results.map(r => ({
    ...r,
    ...classifySource(r.url)
  })).filter(r => r.type !== 'blocked');
}

/**
 * Fetch a web page and extract readable text content
 */
const fetchPage = async (pageUrl, maxLength = 8000) => {
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

    let html = res.body;

    // Strip non-content elements first
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
    html = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    html = html.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    html = html.replace(/<header[\s\S]*?<\/header>/gi, '');
    html = html.replace(/<aside[\s\S]*?<\/aside>/gi, '');
    html = html.replace(/<form[\s\S]*?<\/form>/gi, '');

    // Prefer the main article container when present — avoids picking up sidebars,
    // related-articles lists, and site chrome so the LLM sees the actual body.
    const extractBlock = (regex) => {
      const m = html.match(regex);
      return m ? m[1] : '';
    };
    let core = extractBlock(/<article[^>]*>([\s\S]*?)<\/article>/i)
      || extractBlock(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || extractBlock(/<div[^>]+(?:id|class)="[^"]*(?:article|post|entry|content|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || html;

    // Strip remaining tags
    let text = core.replace(/<[^>]+>/g, ' ');
    text = decodeEntities(text);
    // Collapse whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n\s*\n/g, '\n');
    text = text.trim();

    // Fallback: if the structured extraction came back unusable, use a full-body strip.
    if (text.length < 200) {
      let full = html.replace(/<[^>]+>/g, ' ');
      full = decodeEntities(full).replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
      if (full.length > text.length) text = full;
    }

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
const searchArxiv = async (query, maxResults = 5) => {
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

module.exports = { searchWeb, fetchPage, searchArxiv, searchGitHub, classifySource };
