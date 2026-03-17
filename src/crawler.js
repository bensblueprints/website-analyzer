'use strict';

const puppeteer = require('puppeteer');
const robotsParser = require('robots-parser');
const { URL } = require('url');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a URL: lowercase scheme + host, strip fragment, remove trailing
 * slash (except for root path), sort query params for dedup.
 */
function normalizeUrl(raw, baseUrl) {
  try {
    const parsed = new URL(raw, baseUrl);

    // Only keep http / https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    // Strip fragment
    parsed.hash = '';

    // Sort query params for consistent dedup
    const params = Array.from(parsed.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
    );
    parsed.search = '';
    for (const [k, v] of params) {
      parsed.searchParams.append(k, v);
    }

    let href = parsed.href;

    // Remove trailing slash unless it's the root path (e.g. https://example.com/)
    if (href.endsWith('/') && parsed.pathname !== '/') {
      href = href.slice(0, -1);
    }

    return href;
  } catch {
    return null;
  }
}

/**
 * Return true when `url` belongs to the same registrable domain as `domain`.
 * Compares hostnames directly (no public-suffix logic needed for a crawler).
 */
function isSameDomain(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lightweight HTTP fetcher (no Puppeteer overhead for text resources)
// ---------------------------------------------------------------------------

function fetchText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'WebsiteAnalyzerBot/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        return fetchText(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Robots.txt handling
// ---------------------------------------------------------------------------

async function fetchRobotsTxt(baseUrl) {
  const robotsUrl = new URL('/robots.txt', baseUrl).href;
  const result = { exists: false, content: null, blocked: [], sitemaps: [] };

  try {
    const { status, body } = await fetchText(robotsUrl);
    if (status === 200 && body && body.length > 0) {
      result.exists = true;
      result.content = body;

      // Extract sitemap URLs from robots.txt
      const sitemapRegex = /^Sitemap:\s*(.+)$/gim;
      let m;
      while ((m = sitemapRegex.exec(body)) !== null) {
        result.sitemaps.push(m[1].trim());
      }
    }
  } catch {
    // robots.txt not reachable – treat as nonexistent
  }

  return result;
}

function buildRobotsChecker(robotsContent, baseUrl) {
  if (!robotsContent) {
    // No robots.txt → everything allowed
    return { isAllowed: () => true };
  }
  const robotsUrl = new URL('/robots.txt', baseUrl).href;
  const parser = robotsParser(robotsUrl, robotsContent);
  return {
    isAllowed(url) {
      return parser.isAllowed(url, 'WebsiteAnalyzerBot') !== false;
    },
  };
}

// ---------------------------------------------------------------------------
// Sitemap parsing (supports sitemap index files + urlset)
// ---------------------------------------------------------------------------

async function fetchSitemapUrls(sitemapUrl, domain, depth = 0) {
  if (depth > 3) return []; // guard against deep nesting
  const urls = [];

  try {
    const { status, body } = await fetchText(sitemapUrl, 15000);
    if (status !== 200 || !body) return urls;

    // Sitemap index → recurse into child sitemaps
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    const isSitemapIndex = /<sitemapindex/i.test(body);

    let match;
    while ((match = locRegex.exec(body)) !== null) {
      const loc = match[1].trim();
      if (isSitemapIndex) {
        const children = await fetchSitemapUrls(loc, domain, depth + 1);
        urls.push(...children);
      } else {
        const normalized = normalizeUrl(loc);
        if (normalized && isSameDomain(normalized, domain)) {
          urls.push(normalized);
        }
      }
    }
  } catch {
    // Sitemap not reachable – ignore
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Main crawler
// ---------------------------------------------------------------------------

/**
 * Crawl a website starting from `startUrl`.
 *
 * @param {string} startUrl - The entry URL to start crawling from.
 * @param {object} [options]
 * @param {number} [options.maxPages=200]   - Maximum pages to crawl.
 * @param {number} [options.delay=500]      - Milliseconds between page loads.
 * @param {number} [options.timeout=30000]  - Per-page navigation timeout (ms).
 * @param {boolean} [options.verbose=false] - Log progress to stdout.
 * @param {function} [options.onProgress]   - Callback({ current, total, url }).
 * @returns {Promise<object>} Structured crawl results.
 */
async function crawlSite(startUrl, options = {}) {
  const {
    maxPages = 200,
    delay = 500,
    timeout = 30000,
    verbose = false,
    onProgress = null,
  } = options;

  const crawlStart = Date.now();

  // Normalise the start URL and extract domain
  const parsedStart = new URL(startUrl);
  const domain = parsedStart.hostname.toLowerCase();
  const origin = parsedStart.origin;
  const normalizedStart = normalizeUrl(startUrl);

  if (!normalizedStart) {
    throw new Error(`Invalid start URL: ${startUrl}`);
  }

  // ------------------------------------------------------------------
  // 1. Fetch robots.txt & sitemap URLs (before opening the browser)
  // ------------------------------------------------------------------
  const robotsInfo = await fetchRobotsTxt(origin);
  const robotsChecker = buildRobotsChecker(robotsInfo.content, origin);

  // Gather sitemap URLs
  let sitemapUrls = [];
  const sitemapSources = robotsInfo.sitemaps.length > 0
    ? robotsInfo.sitemaps
    : [new URL('/sitemap.xml', origin).href];

  for (const smUrl of sitemapSources) {
    const found = await fetchSitemapUrls(smUrl, domain);
    sitemapUrls.push(...found);
  }
  sitemapUrls = [...new Set(sitemapUrls)];

  // Track which URLs robots.txt blocks
  const blockedUrls = [];

  // ------------------------------------------------------------------
  // 2. Build BFS queue – seed with start URL + sitemap URLs
  // ------------------------------------------------------------------
  const visited = new Set();
  const queue = []; // array of normalised URL strings

  function enqueue(url) {
    const n = normalizeUrl(url, origin);
    if (!n) return;
    if (!isSameDomain(n, domain)) return;
    if (visited.has(n)) return;
    visited.add(n);

    if (!robotsChecker.isAllowed(n)) {
      blockedUrls.push(n);
      // Still mark visited so we don't re-check, but don't crawl
      return;
    }
    queue.push(n);
  }

  enqueue(normalizedStart);
  for (const su of sitemapUrls) {
    enqueue(su);
  }

  // ------------------------------------------------------------------
  // 3. Launch Puppeteer
  // ------------------------------------------------------------------
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });

  const pages = []; // collected page data
  let queueIndex = 0;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebsiteAnalyzerBot/1.0');
    await page.setViewport({ width: 1440, height: 900 });

    // Enable request interception for network tracking
    await page.setRequestInterception(true);

    while (queueIndex < queue.length && pages.length < maxPages) {
      const currentUrl = queue[queueIndex++];

      // Progress reporting
      const progress = {
        current: pages.length + 1,
        total: Math.min(queue.length, maxPages),
        url: currentUrl,
      };
      if (onProgress) onProgress(progress);
      if (verbose) {
        console.log(`[${progress.current}/${progress.total}] ${currentUrl}`);
      }

      // Collect data for this page
      const pageData = {
        url: currentUrl,
        html: null,
        statusCode: null,
        headers: {},
        responseTime: null,
        networkRequests: [],
        consoleMessages: [],
        links: { internal: [], external: [] },
      };

      // ------- Network request tracking -------
      let reqCounter = 0;
      const requestMap = new Map();

      const onRequest = (interceptedRequest) => {
        const id = ++reqCounter;
        interceptedRequest.__trackId = id;
        requestMap.set(id, {
          url: interceptedRequest.url(),
          method: interceptedRequest.method(),
          resourceType: interceptedRequest.resourceType(),
          startTime: Date.now(),
        });
        interceptedRequest.continue();
      };

      const onResponse = async (response) => {
        const reqUrl = response.url();
        const request = response.request();
        const id = request.__trackId;
        const entry = id ? requestMap.get(id) : null;

        const headers = response.headers();
        const networkEntry = {
          url: reqUrl,
          method: request.method(),
          resourceType: request.resourceType(),
          status: response.status(),
          contentType: headers['content-type'] || null,
          contentEncoding: headers['content-encoding'] || null,
          timing: entry ? Date.now() - entry.startTime : null,
          size: null,
          protocol: null,
          fromCache: response.fromCache(),
        };

        // Detect HTTP/2 from response
        try {
          const securityDetails = response.securityDetails();
          if (securityDetails) networkEntry.protocol = securityDetails.protocol();
        } catch {}
        // Fallback: check alt-svc or other headers for h2/h3
        if (!networkEntry.protocol && headers['alt-svc']) {
          if (headers['alt-svc'].includes('h3')) networkEntry.protocol = 'h3';
          else if (headers['alt-svc'].includes('h2')) networkEntry.protocol = 'h2';
        }

        // Try to get content length from headers
        const cl = response.headers()['content-length'];
        if (cl) {
          networkEntry.size = parseInt(cl, 10);
        } else {
          try {
            const buf = await response.buffer();
            networkEntry.size = buf.length;
          } catch {
            // body unavailable (e.g. redirected request)
          }
        }

        pageData.networkRequests.push(networkEntry);
      };

      const onConsole = (msg) => {
        const type = msg.type(); // 'error', 'warning', 'log', etc.
        if (type === 'error' || type === 'warning') {
          pageData.consoleMessages.push({
            type,
            text: msg.text(),
            location: msg.location(),
          });
        }
      };

      const onPageError = (err) => {
        pageData.consoleMessages.push({
          type: 'error',
          text: err.message || String(err),
          location: null,
        });
      };

      // Attach listeners
      page.on('request', onRequest);
      page.on('response', onResponse);
      page.on('console', onConsole);
      page.on('pageerror', onPageError);

      try {
        const navStart = Date.now();

        const response = await page.goto(currentUrl, {
          waitUntil: 'networkidle2',
          timeout,
        });

        pageData.responseTime = Date.now() - navStart;

        if (response) {
          pageData.statusCode = response.status();
          pageData.headers = response.headers();
        }

        // Get HTML
        pageData.html = await page.content();

        // ---- Extract links from the page ----
        const extractedLinks = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors.map((a) => ({
            href: a.href,
            text: (a.textContent || '').trim().slice(0, 200),
            rel: a.getAttribute('rel') || '',
          }));
        });

        for (const link of extractedLinks) {
          const normalized = normalizeUrl(link.href, currentUrl);
          if (!normalized) continue;

          if (isSameDomain(normalized, domain)) {
            pageData.links.internal.push({ url: normalized, text: link.text, rel: link.rel });
            // Enqueue for BFS crawl
            enqueue(normalized);
          } else {
            pageData.links.external.push({ url: normalized, text: link.text, rel: link.rel });
          }
        }
      } catch (err) {
        // Timeout or navigation error – still record the page attempt
        pageData.statusCode = pageData.statusCode || 0;
        pageData.consoleMessages.push({
          type: 'error',
          text: `Navigation error: ${err.message}`,
          location: null,
        });

        if (verbose) {
          console.warn(`  Error crawling ${currentUrl}: ${err.message}`);
        }
      } finally {
        // Remove listeners to avoid stacking across pages
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('console', onConsole);
        page.off('pageerror', onPageError);

        // Clear request map for next page
        requestMap.clear();
      }

      pages.push(pageData);

      // Update total estimate (queue may have grown)
      if (onProgress) {
        onProgress({
          current: pages.length,
          total: Math.min(queue.length, maxPages),
          url: currentUrl,
        });
      }

      // Rate-limit delay between pages
      if (delay > 0 && queueIndex < queue.length && pages.length < maxPages) {
        await sleep(delay);
      }
    }
  } finally {
    await browser.close();
  }

  // Add robots-blocked URLs to the result
  robotsInfo.blocked = blockedUrls;

  return {
    pages,
    sitemapUrls,
    robotsTxt: {
      exists: robotsInfo.exists,
      content: robotsInfo.content,
      blocked: robotsInfo.blocked,
    },
    domain,
    crawlTime: Date.now() - crawlStart,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { crawlSite };
