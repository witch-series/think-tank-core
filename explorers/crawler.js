'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 15000;

function fetch(urlString, options = {}) {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    let redirectCount = 0;

    function doRequest(currentUrl, currentOptions) {
      const url = new URL(currentUrl);
      const client = url.protocol === 'https:' ? https : http;

      const body = currentOptions.body
        ? (typeof currentOptions.body === 'string' ? currentOptions.body : JSON.stringify(currentOptions.body))
        : null;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: currentOptions.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ...currentOptions.headers
        },
        timeout
      };

      // Add Content-Length for POST bodies
      if (body && (currentOptions.method || '').toUpperCase() === 'POST') {
        reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = client.request(reqOptions, (res) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            resolve({ status: res.statusCode, headers: res.headers, body: '' });
            return;
          }
          // Consume the response body to free the socket
          res.resume();
          const redirectUrl = new URL(res.headers.location, currentUrl).href;
          // 303 always becomes GET; 301/302 become GET for non-GET/HEAD
          const method = (res.statusCode === 303 || ([301, 302].includes(res.statusCode) && currentOptions.method !== 'HEAD'))
            ? 'GET' : (currentOptions.method || 'GET');
          doRequest(redirectUrl, { ...currentOptions, method, body: method === 'GET' ? null : currentOptions.body });
          return;
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    }

    doRequest(urlString, options);
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(urlString, options = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(urlString, options);
    } catch (err) {
      const isRetryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(err.code);
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = attempt * 3000;
      if (options.onRetry) options.onRetry(attempt, maxRetries, err, delay);
      await wait(delay);
    }
  }
}

module.exports = { fetch, fetchWithRetry };
