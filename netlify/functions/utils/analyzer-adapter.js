'use strict';

/**
 * Analyzer Adapter for Netlify Functions / AWS Lambda
 *
 * Bridges the existing src/ analyzer modules to a serverless environment by
 * using @sparticuz/chromium + puppeteer-core instead of full puppeteer, and
 * re-implementing the crawl logic to accept an externally managed browser
 * instance (Lambda cannot afford to spin up a second browser).
 *
 * CommonJS -- require / module.exports
 */

const { URL } = require('url');
const https = require('https');
const http = require('http');

// ---------------------------------------------------------------------------
// URL helpers (mirrored from src/crawler.js so we stay self-contained)
// ---------------------------------------------------------------------------

function normalizeUrl(raw, baseUrl) {
  try {
    const parsed = new URL(raw, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    const params = Array.from(parsed.searchParams.entries()).sort(
      (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
    );
    parsed.search = '';
    for (const [k, v] of params) parsed.searchParams.append(k, v);
    let href = parsed.href;
    if (href.endsWith('/') && parsed.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return null;
  }
}

function isSameDomain(url, domain) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lightweight HTTP fetcher (no browser required)
// ---------------------------------------------------------------------------

function fetchText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { timeout: timeoutMs, headers: { 'User-Agent': 'WebsiteAnalyzerBot/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchText(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Robots.txt
// ---------------------------------------------------------------------------

async function fetchRobotsTxt(baseUrl) {
  const robotsUrl = new URL('/robots.txt', baseUrl).href;
  const result = { exists: false, content: null, blocked: [], sitemaps: [] };
  try {
    const { status, body } = await fetchText(robotsUrl);
    if (status === 200 && body && body.length > 0) {
      result.exists = true;
      result.content = body;
      const sitemapRegex = /^Sitemap:\s*(.+)$/gim;
      let m;
      while ((m = sitemapRegex.exec(body)) !== null) {
        result.sitemaps.push(m[1].trim());
      }
    }
  } catch {
    // robots.txt not reachable
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sitemap parsing
// ---------------------------------------------------------------------------

async function fetchSitemapUrls(sitemapUrl, domain, depth = 0) {
  if (depth > 3) return [];
  const urls = [];
  try {
    const { status, body } = await fetchText(sitemapUrl, 15000);
    if (status !== 200 || !body) return urls;
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
        if (normalized && isSameDomain(normalized, domain)) urls.push(normalized);
      }
    }
  } catch {
    // sitemap not reachable
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Launch a Lambda-compatible browser
// ---------------------------------------------------------------------------

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');

  let executablePath;
  let args;
  let headless;

  try {
    const chromium = require('@sparticuz/chromium');
    chromium.setHeadlessMode = true;
    chromium.setGraphicsMode = false;
    executablePath = await chromium.executablePath();
    args = chromium.args;
    headless = chromium.headless;
  } catch (chromErr) {
    // Fallback: try common paths
    const fs = require('fs');
    const possiblePaths = [
      '/tmp/chromium',
      '/opt/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) { executablePath = p; break; }
    }
    if (!executablePath) {
      throw new Error(`Failed to launch browser: ${chromErr.message}`);
    }
    args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ];
    headless = true;
  }

  const browser = await puppeteer.launch({
    args: args || [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
    defaultViewport: { width: 1440, height: 900 },
    executablePath,
    headless: headless ?? true,
  });
  return browser;
}

// ---------------------------------------------------------------------------
// Crawl a site using an existing browser instance (BFS, max N pages)
// ---------------------------------------------------------------------------

async function crawlSite(browser, startUrl, options = {}) {
  const {
    maxPages = 5,
    delay = 200,
    timeout = 15000,
  } = options;

  const crawlStart = Date.now();

  const parsedStart = new URL(startUrl);
  const domain = parsedStart.hostname.toLowerCase();
  const origin = parsedStart.origin;
  const normalizedStart = normalizeUrl(startUrl);

  if (!normalizedStart) {
    throw new Error('Invalid start URL: ' + startUrl);
  }

  // ----- robots.txt & sitemap (plain HTTP, no browser) -----
  let robotsInfo;
  try {
    robotsInfo = await fetchRobotsTxt(origin);
  } catch {
    robotsInfo = { exists: false, content: null, blocked: [], sitemaps: [] };
  }

  let sitemapUrls = [];
  try {
    const sitemapSources = robotsInfo.sitemaps.length > 0
      ? robotsInfo.sitemaps
      : [new URL('/sitemap.xml', origin).href];
    for (const smUrl of sitemapSources) {
      const found = await fetchSitemapUrls(smUrl, domain);
      sitemapUrls.push(...found);
    }
    sitemapUrls = [...new Set(sitemapUrls)];
  } catch {
    sitemapUrls = [];
  }

  // ----- BFS queue -----
  const visited = new Set();
  const queue = [];
  const blockedUrls = [];

  function enqueue(url) {
    const n = normalizeUrl(url, origin);
    if (!n) return;
    if (!isSameDomain(n, domain)) return;
    if (visited.has(n)) return;
    visited.add(n);
    queue.push(n);
  }

  enqueue(normalizedStart);
  for (const su of sitemapUrls) enqueue(su);

  // ----- Page-by-page crawl -----
  const pages = [];
  let queueIndex = 0;
  let page;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebsiteAnalyzerBot/1.0'
    );
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);

    while (queueIndex < queue.length && pages.length < maxPages) {
      const currentUrl = queue[queueIndex++];

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

      // ------- Network tracking -------
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
        try {
          interceptedRequest.continue();
        } catch {
          // request may already have been handled
        }
      };

      const onResponse = async (response) => {
        try {
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

          try {
            const securityDetails = response.securityDetails();
            if (securityDetails) networkEntry.protocol = securityDetails.protocol();
          } catch { /* ignore */ }

          if (!networkEntry.protocol && headers['alt-svc']) {
            if (headers['alt-svc'].includes('h3')) networkEntry.protocol = 'h3';
            else if (headers['alt-svc'].includes('h2')) networkEntry.protocol = 'h2';
          }

          const cl = headers['content-length'];
          if (cl) {
            networkEntry.size = parseInt(cl, 10);
          } else {
            try {
              const buf = await response.buffer();
              networkEntry.size = buf.length;
            } catch {
              // body unavailable
            }
          }

          pageData.networkRequests.push(networkEntry);
        } catch {
          // swallow response-tracking errors
        }
      };

      const onConsole = (msg) => {
        try {
          const type = msg.type();
          if (type === 'error' || type === 'warning') {
            pageData.consoleMessages.push({
              type,
              text: msg.text(),
              location: msg.location(),
            });
          }
        } catch { /* ignore */ }
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

        pageData.html = await page.content();

        // Extract links
        let extractedLinks = [];
        try {
          extractedLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]')).map((a) => ({
              href: a.href,
              text: (a.textContent || '').trim().slice(0, 200),
              rel: a.getAttribute('rel') || '',
            }));
          });
        } catch {
          // page context may have been destroyed
        }

        for (const link of extractedLinks) {
          const normalized = normalizeUrl(link.href, currentUrl);
          if (!normalized) continue;
          if (isSameDomain(normalized, domain)) {
            pageData.links.internal.push({ url: normalized, text: link.text, rel: link.rel });
            enqueue(normalized);
          } else {
            pageData.links.external.push({ url: normalized, text: link.text, rel: link.rel });
          }
        }
      } catch (err) {
        pageData.statusCode = pageData.statusCode || 0;
        pageData.consoleMessages.push({
          type: 'error',
          text: 'Navigation error: ' + (err.message || String(err)),
          location: null,
        });
      } finally {
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        requestMap.clear();
      }

      pages.push(pageData);

      // Rate-limit between pages
      if (delay > 0 && queueIndex < queue.length && pages.length < maxPages) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } catch (err) {
    // If the crawl loop itself throws, still return whatever we collected
    console.error('Crawl loop error:', err.message || err);
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

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

// ---------------------------------------------------------------------------
// Run axe-core accessibility audit
// ---------------------------------------------------------------------------

async function runAxeCore(browser, url) {
  const { AxePuppeteer } = require('@axe-core/puppeteer');
  let page;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const results = await new AxePuppeteer(page).analyze();
    return results;
  } catch (err) {
    console.error('axe-core error:', err.message || err);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Run all 10 analyzers on the crawled data
// ---------------------------------------------------------------------------

async function runAllAnalyzers(crawlData, lighthouseResults, axeResults) {
  const { analyzePerformance } = require('../../../src/analyzers/performance');
  const { analyzeSEO } = require('../../../src/analyzers/seo');
  const { analyzeAccessibility } = require('../../../src/analyzers/accessibility');
  const { analyzeSecurity } = require('../../../src/analyzers/security');
  const { analyzeLinks } = require('../../../src/analyzers/links');
  const { analyzeContent } = require('../../../src/analyzers/content');
  const { analyzeMobile } = require('../../../src/analyzers/mobile');
  const { analyzeTechnical } = require('../../../src/analyzers/technical');
  const { analyzeUXSignals } = require('../../../src/analyzers/ux-signals');
  const { analyzeInfrastructure } = require('../../../src/analyzers/infrastructure');

  const homepage = crawlData.pages[0];
  if (!homepage) {
    throw new Error('No pages were crawled -- cannot run analyzers');
  }

  const siteData = {
    domain: crawlData.domain,
    sitemapUrls: crawlData.sitemapUrls,
    robotsTxt: crawlData.robotsTxt,
  };

  const results = {};

  // Run each analyzer in a try/catch so one failure doesn't kill everything
  try {
    results.performance = await analyzePerformance(homepage, lighthouseResults);
  } catch (err) {
    console.error('Analyzer error [performance]:', err.message);
    results.performance = { checks: [] };
  }

  try {
    results.seo = await analyzeSEO(homepage, crawlData.pages, siteData);
  } catch (err) {
    console.error('Analyzer error [seo]:', err.message);
    results.seo = { checks: [] };
  }

  try {
    results.accessibility = await analyzeAccessibility(homepage, axeResults);
  } catch (err) {
    console.error('Analyzer error [accessibility]:', err.message);
    results.accessibility = { checks: [] };
  }

  try {
    results.security = await analyzeSecurity(homepage, siteData);
  } catch (err) {
    console.error('Analyzer error [security]:', err.message);
    results.security = { checks: [] };
  }

  try {
    results.links = await analyzeLinks(homepage, crawlData.pages, siteData);
  } catch (err) {
    console.error('Analyzer error [links]:', err.message);
    results.links = { checks: [] };
  }

  try {
    results.content = await analyzeContent(homepage, crawlData.pages);
  } catch (err) {
    console.error('Analyzer error [content]:', err.message);
    results.content = { checks: [] };
  }

  try {
    results.mobile = await analyzeMobile(homepage, lighthouseResults);
  } catch (err) {
    console.error('Analyzer error [mobile]:', err.message);
    results.mobile = { checks: [] };
  }

  try {
    results.technical = await analyzeTechnical(homepage);
  } catch (err) {
    console.error('Analyzer error [technical]:', err.message);
    results.technical = { checks: [] };
  }

  try {
    results['ux-signals'] = await analyzeUXSignals(homepage, crawlData.pages, lighthouseResults);
  } catch (err) {
    console.error('Analyzer error [ux-signals]:', err.message);
    results['ux-signals'] = { checks: [] };
  }

  try {
    results.infrastructure = await analyzeInfrastructure(homepage, crawlData.pages, siteData);
  } catch (err) {
    console.error('Analyzer error [infrastructure]:', err.message);
    results.infrastructure = { checks: [] };
  }

  return results;
}

// ---------------------------------------------------------------------------
// Generate a PDF buffer using the already-open browser
// ---------------------------------------------------------------------------

async function generatePDFBuffer(browser, htmlContent) {
  const pdfCSS = `
    <style>
      /* ---- PDF-specific overrides ---- */
      @page {
        size: A4;
        margin: 16mm 14mm 20mm 14mm;
      }

      body {
        background: #ffffff !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      /* Force all collapsible sections open */
      details { display: block !important; }
      details > .collapse-body { display: block !important; }
      details > summary::before { display: none !important; }
      details > summary { pointer-events: none; }
      button { display: none !important; }

      /* Header stays vibrant */
      .report-header {
        background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%) !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        padding: 36px 24px 44px !important;
        page-break-after: avoid;
      }
      .report-header::before { display: none !important; }

      /* Score circle in PDF */
      .score-circle svg { width: 160px !important; height: 160px !important; }
      .score-circle { width: 160px !important; height: 160px !important; }

      /* Ensure colored elements render */
      .grade-badge, .sev-badge, .page-status, .rec-num, .cat-bar,
      .cat-d-grade, .icon-pass, .icon-fail, .icon-warn {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      /* Card styling for print */
      .card {
        box-shadow: none !important;
        border: 1px solid #e2e8f0;
        page-break-inside: avoid;
      }

      /* Category bars render properly */
      .cat-bar-wrap {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      /* Section breaks */
      .section {
        page-break-inside: avoid;
        margin: 28px 0;
      }
      .section-title {
        page-break-after: avoid;
      }

      /* Issues table */
      .issues-table thead { display: table-header-group; }
      .issues-table { page-break-inside: auto; }
      .issues-table tr { page-break-inside: avoid; }

      /* Collapse sections for PDF */
      .collapse-section {
        page-break-inside: avoid;
        border: 1px solid #e2e8f0;
      }

      /* Check list items */
      .check-item { page-break-inside: avoid; }
      .rec-item { page-break-inside: avoid; }

      /* Footer */
      .report-footer {
        page-break-before: avoid;
        margin-top: 24px !important;
      }

      /* Make container wider for A4 */
      .container { max-width: 100%; }
    </style>
  `;

  const pdfHtml = htmlContent.replace('</head>', pdfCSS + '\n</head>');

  let page;
  try {
    page = await browser.newPage();
    await page.setContent(pdfHtml, { waitUntil: 'networkidle0', timeout: 30000 });

    // Force all <details> open
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''));
    });

    // Let CSS transitions settle
    await new Promise((r) => setTimeout(r, 500));

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: '16mm',
        right: '14mm',
        bottom: '20mm',
        left: '14mm',
      },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: [
        '<div style="width:100%;font-size:9px;color:#94a3b8;text-align:center;',
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:0 14mm;\">",
        '<span>Website Analysis Report</span>',
        '<span style="margin:0 12px">&bull;</span>',
        '<span>Advanced Marketing</span>',
        '<span style="margin:0 12px">&bull;</span>',
        '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>',
        '</div>',
      ].join(''),
    });

    return pdf; // Buffer
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Full analysis orchestrator
// ---------------------------------------------------------------------------

async function runFullAnalysis(url) {
  let browser;

  try {
    browser = await launchBrowser();
  } catch (err) {
    throw new Error('Failed to launch browser: ' + (err.message || err));
  }

  try {
    // 1. Crawl
    const crawlData = await crawlSite(browser, url, {
      maxPages: 5,
      delay: 200,
      timeout: 15000,
    });

    if (!crawlData.pages || crawlData.pages.length === 0) {
      throw new Error('Crawl returned zero pages for ' + url);
    }

    // 2. axe-core accessibility audit
    let axeResults = null;
    try {
      axeResults = await runAxeCore(browser, url);
    } catch (err) {
      console.error('axe-core skipped:', err.message || err);
    }

    // 3. Lighthouse is too heavy for Lambda -- pass null (analyzers handle it gracefully)
    const lighthouseResults = null;

    // 4. Run all 10 analyzers
    const categoryResults = await runAllAnalyzers(crawlData, lighthouseResults, axeResults);

    // 5. Score
    const { calculateOverallScore, generateExecutiveSummary } = require('../../../src/scorer');
    const scoreResult = calculateOverallScore(categoryResults);
    scoreResult.executiveSummary = generateExecutiveSummary(
      scoreResult,
      crawlData.domain,
      crawlData.pages.length
    );

    // 6. HTML Report
    const { generateReport } = require('../../../src/reporter');
    const reportHtml = generateReport(scoreResult, crawlData, {
      url,
      maxPages: 5,
      analyzedAt: new Date().toISOString(),
    });

    // 7. PDF Report (best-effort)
    let pdfBuffer = null;
    try {
      pdfBuffer = await generatePDFBuffer(browser, reportHtml);
    } catch (err) {
      console.error('PDF generation failed:', err.message || err);
    }

    return {
      scoreResult,
      crawlData,
      reportHtml,
      pdfBuffer,
      score: scoreResult.score,
      grade: scoreResult.grade,
      gradeLabel: scoreResult.gradeLabel,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runFullAnalysis, launchBrowser };
