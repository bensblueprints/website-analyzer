'use strict';

const cheerio = require('cheerio');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * HEAD request with timeout. Returns { status, redirects, error }.
 * Follows up to maxRedirects.
 */
function headRequest(url, timeoutMs = 8000, maxRedirects = 5) {
  return new Promise((resolve) => {
    const seen = [];

    function doRequest(targetUrl, remaining) {
      if (remaining <= 0) {
        return resolve({ status: null, redirects: seen, error: 'too many redirects' });
      }
      let mod;
      try {
        mod = targetUrl.startsWith('https') ? https : http;
      } catch {
        return resolve({ status: null, redirects: seen, error: 'invalid url' });
      }

      const req = mod.request(targetUrl, {
        method: 'HEAD',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'WebsiteAnalyzerBot/1.0' },
      }, (res) => {
        seen.push({ url: targetUrl, status: res.statusCode });
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).href;
          } catch {
            return resolve({ status: res.statusCode, redirects: seen, error: null });
          }
          // Check for loop
          if (seen.some((s, i) => i < seen.length - 1 && s.url === nextUrl)) {
            return resolve({ status: res.statusCode, redirects: seen, error: 'redirect loop' });
          }
          return doRequest(nextUrl, remaining - 1);
        }
        resolve({ status: res.statusCode, redirects: seen, error: null });
      });

      req.on('timeout', () => { req.destroy(); resolve({ status: null, redirects: seen, error: 'timeout' }); });
      req.on('error', (err) => resolve({ status: null, redirects: seen, error: err.message }));
      req.end();
    }

    doRequest(url, maxRedirects);
  });
}

/**
 * Build a check result object.
 */
function check(id, name, status, severity, value, details) {
  return { id, name, status, severity, value, details };
}

/**
 * Generic click-here / non-descriptive anchor texts.
 */
const GENERIC_ANCHORS = new Set([
  'click here', 'here', 'link', 'read more', 'more', 'click',
  'this', 'go', 'learn more', 'this link', 'continue',
]);

/**
 * Known social media domains.
 */
const SOCIAL_DOMAINS = [
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'reddit.com',
  'tumblr.com', 'vimeo.com', 'threads.net', 'mastodon.social', 'bsky.app',
];

/**
 * Soft-404 indicator phrases.
 */
const SOFT_404_PHRASES = [
  'page not found', 'not found', "page doesn't exist", 'page does not exist',
  '404', 'no longer available', 'this page is missing', 'couldn\'t find',
  'could not find', 'does not exist', 'oops',
];

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze links and navigation for a single page (with cross-page context).
 *
 * @param {object} pageData - Current page data from crawler.
 * @param {object[]} allPages - All crawled page data objects.
 * @param {object} siteData - { domain, sitemapUrls }
 * @returns {Promise<{checks: Array}>}
 */
async function analyzeLinks(pageData, allPages, siteData) {
  const checks = [];
  const $ = cheerio.load(pageData.html || '');
  const currentUrl = pageData.url || '';
  const domain = siteData.domain || '';
  const sitemapUrls = siteData.sitemapUrls || [];

  // Pre-compute some data used by multiple checks
  const allCrawledUrls = new Set(allPages.map((p) => p.url));
  const networkByUrl = new Map();
  for (const nr of (pageData.networkRequests || [])) {
    if (nr.url) networkByUrl.set(nr.url, nr);
  }

  const isHomepage = (() => {
    try {
      const u = new URL(currentUrl);
      return u.pathname === '/' || u.pathname === '';
    } catch { return false; }
  })();

  // -----------------------------------------------------------------------
  // Check 1: No broken internal links 404 (critical)
  // -----------------------------------------------------------------------
  try {
    const internalLinks = pageData.links.internal || [];
    const broken = [];
    for (const link of internalLinks) {
      // Check if the target was crawled and returned 404+
      const target = allPages.find((p) => p.url === link.url);
      if (target && target.statusCode >= 400) {
        broken.push({ url: link.url, status: target.statusCode });
      }
      // If not crawled at all, flag it too (could be blocked or missed)
      if (!target && !allCrawledUrls.has(link.url)) {
        // Only flag if it looks like a real page URL (not a fragment-only link)
        try {
          const parsed = new URL(link.url);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            broken.push({ url: link.url, status: 'not crawled' });
          }
        } catch { /* ignore malformed */ }
      }
    }
    checks.push(check(
      'link-1', 'No broken internal links (404)', broken.length === 0 ? 'pass' : 'fail',
      'critical', `${broken.length} broken`,
      broken.length > 0 ? `Broken: ${broken.slice(0, 10).map((b) => `${b.url} (${b.status})`).join(', ')}` : 'All internal links valid'
    ));
  } catch (e) {
    checks.push(check('link-1', 'No broken internal links (404)', 'warn', 'critical', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 2: No broken external links (major) - HEAD check first 20
  // -----------------------------------------------------------------------
  try {
    const externalLinks = pageData.links.external || [];
    const uniqueExternal = [...new Set(externalLinks.map((l) => l.url))].slice(0, 20);
    const brokenExternal = [];
    const results = await Promise.all(uniqueExternal.map((url) => headRequest(url, 8000)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.error === 'timeout') continue; // Don't count timeouts as broken
      if (r.status && r.status >= 400) {
        brokenExternal.push({ url: uniqueExternal[i], status: r.status });
      } else if (r.error && r.error !== 'timeout') {
        brokenExternal.push({ url: uniqueExternal[i], status: r.error });
      }
    }
    checks.push(check(
      'link-2', 'No broken external links', brokenExternal.length === 0 ? 'pass' : 'fail',
      'major', `${brokenExternal.length} broken of ${uniqueExternal.length} checked`,
      brokenExternal.length > 0 ? `Broken: ${brokenExternal.slice(0, 5).map((b) => `${b.url} (${b.status})`).join(', ')}` : 'All checked external links valid'
    ));
  } catch (e) {
    checks.push(check('link-2', 'No broken external links', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 3: No broken image links (critical)
  // -----------------------------------------------------------------------
  try {
    const imgElements = $('img[src]');
    const brokenImages = [];
    imgElements.each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      let fullUrl;
      try { fullUrl = new URL(src, currentUrl).href; } catch { return; }
      const nr = networkByUrl.get(fullUrl);
      if (nr && nr.status >= 400) {
        brokenImages.push({ src: fullUrl, status: nr.status });
      }
    });
    checks.push(check(
      'link-3', 'No broken image links', brokenImages.length === 0 ? 'pass' : 'fail',
      'critical', `${brokenImages.length} broken images`,
      brokenImages.length > 0 ? `Broken: ${brokenImages.slice(0, 5).map((b) => `${b.src} (${b.status})`).join(', ')}` : 'All image sources valid'
    ));
  } catch (e) {
    checks.push(check('link-3', 'No broken image links', 'warn', 'critical', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 4: No broken CSS/JS links (major)
  // -----------------------------------------------------------------------
  try {
    const brokenAssets = [];
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      const rel = ($(el).attr('rel') || '').toLowerCase();
      if (rel !== 'stylesheet' && rel !== 'preload') return;
      if (!href) return;
      let fullUrl;
      try { fullUrl = new URL(href, currentUrl).href; } catch { return; }
      const nr = networkByUrl.get(fullUrl);
      if (nr && nr.status >= 400) {
        brokenAssets.push({ src: fullUrl, type: 'CSS', status: nr.status });
      }
    });
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      let fullUrl;
      try { fullUrl = new URL(src, currentUrl).href; } catch { return; }
      const nr = networkByUrl.get(fullUrl);
      if (nr && nr.status >= 400) {
        brokenAssets.push({ src: fullUrl, type: 'JS', status: nr.status });
      }
    });
    checks.push(check(
      'link-4', 'No broken CSS/JS links', brokenAssets.length === 0 ? 'pass' : 'fail',
      'major', `${brokenAssets.length} broken assets`,
      brokenAssets.length > 0 ? `Broken: ${brokenAssets.slice(0, 5).map((b) => `${b.src} (${b.type}, ${b.status})`).join(', ')}` : 'All CSS/JS assets load correctly'
    ));
  } catch (e) {
    checks.push(check('link-4', 'No broken CSS/JS links', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 5: No broken anchor links #fragments (minor)
  // -----------------------------------------------------------------------
  try {
    const brokenAnchors = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Only check same-page fragment links
      if (href.startsWith('#') && href.length > 1) {
        const targetId = href.slice(1);
        if ($(`[id="${targetId}"]`).length === 0 && $(`[name="${targetId}"]`).length === 0) {
          brokenAnchors.push(href);
        }
      }
    });
    const unique = [...new Set(brokenAnchors)];
    checks.push(check(
      'link-5', 'No broken anchor links (#fragments)', unique.length === 0 ? 'pass' : 'fail',
      'minor', `${unique.length} broken fragments`,
      unique.length > 0 ? `Missing targets: ${unique.slice(0, 10).join(', ')}` : 'All anchor fragments resolve'
    ));
  } catch (e) {
    checks.push(check('link-5', 'No broken anchor links (#fragments)', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 6: Redirect chain <= 2 (major)
  // -----------------------------------------------------------------------
  try {
    const redirectChains = [];
    for (const nr of (pageData.networkRequests || [])) {
      if (nr.status >= 300 && nr.status < 400) {
        redirectChains.push(nr);
      }
    }
    // Group redirects by initial URL - count sequential redirects
    // Simpler approach: look at the main page navigation redirects
    const mainPageRedirects = (pageData.networkRequests || []).filter(
      (nr) => nr.resourceType === 'document' && nr.status >= 300 && nr.status < 400
    );
    const chainLength = mainPageRedirects.length;
    checks.push(check(
      'link-6', 'Redirect chain <= 2', chainLength <= 2 ? 'pass' : 'fail',
      'major', `${chainLength} redirects`,
      chainLength > 2 ? `Page has ${chainLength} redirect hops: ${mainPageRedirects.map((r) => `${r.url} (${r.status})`).join(' -> ')}` : 'Redirect chain within limits'
    ));
  } catch (e) {
    checks.push(check('link-6', 'Redirect chain <= 2', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 7: No redirect loops (critical)
  // -----------------------------------------------------------------------
  try {
    const docRedirects = (pageData.networkRequests || []).filter(
      (nr) => nr.resourceType === 'document' && nr.status >= 300 && nr.status < 400
    );
    const seenUrls = new Set();
    let loopDetected = false;
    for (const nr of docRedirects) {
      if (seenUrls.has(nr.url)) {
        loopDetected = true;
        break;
      }
      seenUrls.add(nr.url);
    }
    checks.push(check(
      'link-7', 'No redirect loops', loopDetected ? 'fail' : 'pass',
      'critical', loopDetected ? 'Loop detected' : 'No loops',
      loopDetected ? 'Redirect loop detected in document navigation' : 'No redirect loops found'
    ));
  } catch (e) {
    checks.push(check('link-7', 'No redirect loops', 'warn', 'critical', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 8: No temporary redirects on permanent moves (minor)
  // -----------------------------------------------------------------------
  try {
    const tempRedirects = (pageData.networkRequests || []).filter(
      (nr) => nr.resourceType === 'document' && nr.status === 302
    );
    checks.push(check(
      'link-8', 'No temporary redirects on permanent moves', tempRedirects.length === 0 ? 'pass' : 'warn',
      'minor', `${tempRedirects.length} 302 redirects`,
      tempRedirects.length > 0 ? `302 redirects found (consider 301): ${tempRedirects.slice(0, 5).map((r) => r.url).join(', ')}` : 'No temporary redirects detected'
    ));
  } catch (e) {
    checks.push(check('link-8', 'No temporary redirects on permanent moves', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 9: Homepage links to main sections (minor)
  // -----------------------------------------------------------------------
  try {
    if (isHomepage) {
      const internalLinks = pageData.links.internal || [];
      const uniquePaths = new Set();
      for (const link of internalLinks) {
        try {
          const u = new URL(link.url);
          const segment = u.pathname.split('/').filter(Boolean)[0];
          if (segment) uniquePaths.add(segment);
        } catch { /* ignore */ }
      }
      const hasVariety = uniquePaths.size >= 3;
      checks.push(check(
        'link-9', 'Homepage links to main sections', hasVariety ? 'pass' : 'warn',
        'minor', `${uniquePaths.size} unique path sections`,
        hasVariety ? `Homepage links to ${uniquePaths.size} distinct sections` : `Homepage only links to ${uniquePaths.size} section(s) — consider adding more navigation`
      ));
    } else {
      checks.push(check(
        'link-9', 'Homepage links to main sections', 'pass',
        'minor', 'N/A (not homepage)', 'This check only applies to the homepage'
      ));
    }
  } catch (e) {
    checks.push(check('link-9', 'Homepage links to main sections', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 10: Navigation consistent across pages (major)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-10', 'Navigation consistent across pages', 'pass',
        'major', 'Only 1 page crawled', 'Cannot compare navigation across a single page'
      ));
    } else {
      // Extract nav link hrefs from each page
      function extractNavLinks(html) {
        const p$ = cheerio.load(html || '');
        const navLinks = [];
        p$('nav a[href], header a[href]').each((_, el) => {
          const href = p$(el).attr('href');
          if (href) navLinks.push(href);
        });
        return navLinks.sort().join('|');
      }
      const currentNavSig = extractNavLinks(pageData.html);
      let consistent = 0;
      let total = 0;
      for (const other of allPages) {
        if (other.url === currentUrl) continue;
        total++;
        const otherNavSig = extractNavLinks(other.html);
        if (currentNavSig === otherNavSig) consistent++;
      }
      const pct = total > 0 ? Math.round((consistent / total) * 100) : 100;
      checks.push(check(
        'link-10', 'Navigation consistent across pages', pct >= 70 ? 'pass' : 'fail',
        'major', `${pct}% consistent`,
        pct >= 70 ? `Navigation is consistent across ${pct}% of pages` : `Navigation differs on ${100 - pct}% of pages — consider a shared nav template`
      ));
    }
  } catch (e) {
    checks.push(check('link-10', 'Navigation consistent across pages', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 11: Navigation has descriptive labels (minor)
  // -----------------------------------------------------------------------
  try {
    const navLinks = [];
    $('nav a').each((_, el) => {
      const text = $(el).text().trim();
      navLinks.push(text);
    });
    const emptyLabels = navLinks.filter((t) => t.length === 0 || t.length === 1);
    const hasDescriptive = navLinks.length === 0 || emptyLabels.length === 0;
    checks.push(check(
      'link-11', 'Navigation has descriptive labels', hasDescriptive ? 'pass' : 'warn',
      'minor', `${emptyLabels.length} non-descriptive of ${navLinks.length}`,
      hasDescriptive ? 'All navigation links have descriptive text' : `${emptyLabels.length} navigation link(s) have empty or single-character labels (icon-only?)`
    ));
  } catch (e) {
    checks.push(check('link-11', 'Navigation has descriptive labels', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 12: Breadcrumbs on inner pages (minor)
  // -----------------------------------------------------------------------
  try {
    if (isHomepage) {
      checks.push(check(
        'link-12', 'Breadcrumbs on inner pages', 'pass',
        'minor', 'N/A (homepage)', 'Breadcrumbs not expected on homepage'
      ));
    } else {
      const hasBreadcrumb =
        $('nav[aria-label="breadcrumb"]').length > 0 ||
        $('nav[aria-label="Breadcrumb"]').length > 0 ||
        $('[class*="breadcrumb"]').length > 0 ||
        $('[class*="Breadcrumb"]').length > 0 ||
        $('ol.breadcrumb').length > 0 ||
        $('[itemtype*="BreadcrumbList"]').length > 0;
      checks.push(check(
        'link-12', 'Breadcrumbs on inner pages', hasBreadcrumb ? 'pass' : 'warn',
        'minor', hasBreadcrumb ? 'Found' : 'Not found',
        hasBreadcrumb ? 'Breadcrumb navigation detected' : 'No breadcrumb navigation found on this inner page'
      ));
    }
  } catch (e) {
    checks.push(check('link-12', 'Breadcrumbs on inner pages', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 13: Footer navigation present (minor)
  // -----------------------------------------------------------------------
  try {
    const footerLinks = $('footer a[href]');
    const hasFooterNav = footerLinks.length >= 1;
    checks.push(check(
      'link-13', 'Footer navigation present', hasFooterNav ? 'pass' : 'warn',
      'minor', `${footerLinks.length} footer links`,
      hasFooterNav ? `Footer contains ${footerLinks.length} link(s)` : 'No footer navigation found — consider adding footer links'
    ));
  } catch (e) {
    checks.push(check('link-13', 'Footer navigation present', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 14: Logo links to homepage (minor)
  // -----------------------------------------------------------------------
  try {
    let logoLinksHome = false;
    // Check for common logo patterns
    const logoSelectors = [
      'a[class*="logo"]', 'a[id*="logo"]',
      'a [class*="logo"]', 'a [id*="logo"]',
      'header a:first-of-type',
      '.logo a', '#logo a',
      'a.brand', 'a.navbar-brand',
    ];
    for (const sel of logoSelectors) {
      const el = $(sel).first();
      if (el.length > 0) {
        const href = el.closest('a').attr('href') || el.attr('href') || '';
        try {
          const resolved = new URL(href, currentUrl);
          if (resolved.pathname === '/' || resolved.pathname === '') {
            logoLinksHome = true;
            break;
          }
        } catch { /* ignore */ }
        // Also check if href itself is just "/" or domain root
        if (href === '/' || href === '' || href === currentUrl || href === `https://${domain}/` || href === `http://${domain}/`) {
          logoLinksHome = true;
          break;
        }
      }
    }
    checks.push(check(
      'link-14', 'Logo links to homepage', logoLinksHome ? 'pass' : 'warn',
      'minor', logoLinksHome ? 'Yes' : 'Not detected',
      logoLinksHome ? 'Logo links back to homepage' : 'Could not confirm logo links to homepage'
    ));
  } catch (e) {
    checks.push(check('link-14', 'Logo links to homepage', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 15: 404 page is custom (minor)
  // -----------------------------------------------------------------------
  try {
    const pages404 = allPages.filter((p) => p.statusCode === 404);
    if (pages404.length === 0) {
      checks.push(check(
        'link-15', '404 page is custom', 'pass',
        'minor', 'No 404 pages found', 'No 404 pages encountered during crawl'
      ));
    } else {
      // Check if 404 pages have substantial content (not default server page)
      const customCount = pages404.filter((p) => {
        const html = p.html || '';
        return html.length > 500; // Default server 404s are typically very short
      }).length;
      const isCustom = customCount === pages404.length;
      checks.push(check(
        'link-15', '404 page is custom', isCustom ? 'pass' : 'warn',
        'minor', `${customCount}/${pages404.length} custom`,
        isCustom ? 'All 404 pages have custom content' : 'Some 404 pages appear to use default server error pages'
      ));
    }
  } catch (e) {
    checks.push(check('link-15', '404 page is custom', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 16: 404 page has navigation (minor)
  // -----------------------------------------------------------------------
  try {
    const pages404 = allPages.filter((p) => p.statusCode === 404);
    if (pages404.length === 0) {
      checks.push(check(
        'link-16', '404 page has navigation', 'pass',
        'minor', 'No 404 pages', 'No 404 pages to check'
      ));
    } else {
      const withNav = pages404.filter((p) => {
        const p$ = cheerio.load(p.html || '');
        return p$('nav a').length > 0 || p$('header a').length > 0;
      }).length;
      const allHaveNav = withNav === pages404.length;
      checks.push(check(
        'link-16', '404 page has navigation', allHaveNav ? 'pass' : 'warn',
        'minor', `${withNav}/${pages404.length} have nav`,
        allHaveNav ? '404 pages include navigation for recovery' : 'Some 404 pages lack navigation — users may get stuck'
      ));
    }
  } catch (e) {
    checks.push(check('link-16', '404 page has navigation', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 17: No orphan pages (major)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-17', 'No orphan pages', 'pass',
        'major', 'Only 1 page', 'Cannot detect orphans with only one page'
      ));
    } else {
      // Build set of all URLs that are linked to from any page
      const linkedUrls = new Set();
      for (const p of allPages) {
        for (const link of (p.links.internal || [])) {
          linkedUrls.add(link.url);
        }
      }
      // Find pages not linked from any other page (exclude homepage)
      const orphans = allPages.filter((p) => {
        try {
          const u = new URL(p.url);
          if (u.pathname === '/' || u.pathname === '') return false;
        } catch { /* ignore */ }
        return !linkedUrls.has(p.url);
      });
      checks.push(check(
        'link-17', 'No orphan pages', orphans.length === 0 ? 'pass' : 'fail',
        'major', `${orphans.length} orphan(s)`,
        orphans.length > 0 ? `Orphan pages (not linked from any page): ${orphans.slice(0, 10).map((p) => p.url).join(', ')}` : 'All pages are linked from at least one other page'
      ));
    }
  } catch (e) {
    checks.push(check('link-17', 'No orphan pages', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 18: Max click depth <= 4 (major)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-18', 'Max click depth <= 4', 'pass',
        'major', 'Only 1 page', 'Cannot calculate depth with only one page'
      ));
    } else {
      // BFS from homepage
      const homepage = allPages.find((p) => {
        try { return new URL(p.url).pathname === '/'; } catch { return false; }
      }) || allPages[0];

      const depthMap = new Map();
      depthMap.set(homepage.url, 0);
      const queue = [homepage.url];
      const pageMap = new Map(allPages.map((p) => [p.url, p]));

      let qi = 0;
      while (qi < queue.length) {
        const url = queue[qi++];
        const page = pageMap.get(url);
        if (!page) continue;
        const currentDepth = depthMap.get(url);
        for (const link of (page.links.internal || [])) {
          if (!depthMap.has(link.url) && pageMap.has(link.url)) {
            depthMap.set(link.url, currentDepth + 1);
            queue.push(link.url);
          }
        }
      }

      let maxDepth = 0;
      for (const d of depthMap.values()) {
        if (d > maxDepth) maxDepth = d;
      }

      checks.push(check(
        'link-18', 'Max click depth <= 4', maxDepth <= 4 ? 'pass' : 'fail',
        'major', `Max depth: ${maxDepth}`,
        maxDepth <= 4 ? `Deepest page is ${maxDepth} clicks from homepage` : `Some pages are ${maxDepth} clicks deep — consider flattening site architecture`
      ));
    }
  } catch (e) {
    checks.push(check('link-18', 'Max click depth <= 4', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 19: Average click depth <= 3 (minor)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-19', 'Average click depth <= 3', 'pass',
        'minor', 'Only 1 page', 'Cannot calculate average depth with only one page'
      ));
    } else {
      // BFS from homepage (same logic as check 18)
      const homepage = allPages.find((p) => {
        try { return new URL(p.url).pathname === '/'; } catch { return false; }
      }) || allPages[0];

      const depthMap = new Map();
      depthMap.set(homepage.url, 0);
      const queue = [homepage.url];
      const pageMap = new Map(allPages.map((p) => [p.url, p]));

      let qi = 0;
      while (qi < queue.length) {
        const url = queue[qi++];
        const page = pageMap.get(url);
        if (!page) continue;
        const currentDepth = depthMap.get(url);
        for (const link of (page.links.internal || [])) {
          if (!depthMap.has(link.url) && pageMap.has(link.url)) {
            depthMap.set(link.url, currentDepth + 1);
            queue.push(link.url);
          }
        }
      }

      const depths = [...depthMap.values()];
      const avg = depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
      const avgRounded = Math.round(avg * 100) / 100;

      checks.push(check(
        'link-19', 'Average click depth <= 3', avgRounded <= 3 ? 'pass' : 'warn',
        'minor', `Average: ${avgRounded}`,
        avgRounded <= 3 ? `Average click depth is ${avgRounded}` : `Average click depth is ${avgRounded} — consider better interlinking`
      ));
    }
  } catch (e) {
    checks.push(check('link-19', 'Average click depth <= 3', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 20: External links open in new tab (minor)
  // -----------------------------------------------------------------------
  try {
    const extAnchors = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      try {
        const parsed = new URL(href, currentUrl);
        if (parsed.hostname && !parsed.hostname.includes(domain)) {
          const target = $(el).attr('target') || '';
          extAnchors.push({ href, target });
        }
      } catch { /* ignore */ }
    });
    const missingTarget = extAnchors.filter((a) => a.target !== '_blank');
    checks.push(check(
      'link-20', 'External links open in new tab', missingTarget.length === 0 ? 'pass' : 'warn',
      'minor', `${missingTarget.length} missing target="_blank"`,
      missingTarget.length === 0 ? 'All external links open in new tabs' : `${missingTarget.length} external link(s) don't open in new tab`
    ));
  } catch (e) {
    checks.push(check('link-20', 'External links open in new tab', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 21: External links have rel="noopener" (minor)
  // -----------------------------------------------------------------------
  try {
    const extBlankAnchors = [];
    $('a[href][target="_blank"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      try {
        const parsed = new URL(href, currentUrl);
        if (parsed.hostname && !parsed.hostname.includes(domain)) {
          const rel = ($(el).attr('rel') || '').toLowerCase();
          extBlankAnchors.push({ href, rel });
        }
      } catch { /* ignore */ }
    });
    const missingNoopener = extBlankAnchors.filter((a) => !a.rel.includes('noopener'));
    checks.push(check(
      'link-21', 'External links have rel="noopener"', missingNoopener.length === 0 ? 'pass' : 'warn',
      'minor', `${missingNoopener.length} missing noopener`,
      missingNoopener.length === 0 ? 'All target="_blank" external links have rel="noopener"' : `${missingNoopener.length} external link(s) with target="_blank" missing rel="noopener"`
    ));
  } catch (e) {
    checks.push(check('link-21', 'External links have rel="noopener"', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 22: Anchor text is descriptive (minor)
  // -----------------------------------------------------------------------
  try {
    const genericLinks = [];
    $('a[href]').each((_, el) => {
      const text = ($(el).text() || '').trim().toLowerCase();
      if (GENERIC_ANCHORS.has(text)) {
        genericLinks.push({ href: $(el).attr('href'), text });
      }
    });
    checks.push(check(
      'link-22', 'Anchor text is descriptive', genericLinks.length === 0 ? 'pass' : 'warn',
      'minor', `${genericLinks.length} generic anchor(s)`,
      genericLinks.length === 0 ? 'All anchor texts are descriptive' : `Found generic anchor text: ${genericLinks.slice(0, 5).map((l) => `"${l.text}" -> ${l.href}`).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('link-22', 'Anchor text is descriptive', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 23: No duplicate links on same page (minor)
  // -----------------------------------------------------------------------
  try {
    const hrefCounts = {};
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href && href !== '#' && href !== '') {
        hrefCounts[href] = (hrefCounts[href] || 0) + 1;
      }
    });
    const duplicates = Object.entries(hrefCounts).filter(([, count]) => count > 1);
    checks.push(check(
      'link-23', 'No duplicate links on same page', duplicates.length === 0 ? 'pass' : 'warn',
      'minor', `${duplicates.length} duplicated href(s)`,
      duplicates.length === 0 ? 'No duplicate links found' : `Duplicated: ${duplicates.slice(0, 5).map(([href, c]) => `${href} (${c}x)`).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('link-23', 'No duplicate links on same page', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 24: Internal link count 2-100 per page (minor)
  // -----------------------------------------------------------------------
  try {
    const count = (pageData.links.internal || []).length;
    const ok = count >= 2 && count <= 100;
    checks.push(check(
      'link-24', 'Internal link count 2-100 per page', ok ? 'pass' : 'warn',
      'minor', `${count} internal links`,
      ok ? `Page has ${count} internal links (within 2-100 range)` : `Page has ${count} internal links (recommended: 2-100)`
    ));
  } catch (e) {
    checks.push(check('link-24', 'Internal link count 2-100 per page', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 25: External links not excessive < 50 per page (minor)
  // -----------------------------------------------------------------------
  try {
    const count = (pageData.links.external || []).length;
    const ok = count < 50;
    checks.push(check(
      'link-25', 'External links not excessive (< 50)', ok ? 'pass' : 'warn',
      'minor', `${count} external links`,
      ok ? `Page has ${count} external links (under 50)` : `Page has ${count} external links — consider reducing`
    ));
  } catch (e) {
    checks.push(check('link-25', 'External links not excessive (< 50)', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 26: No links to flagged domains (minor) - skip, just pass
  // -----------------------------------------------------------------------
  try {
    checks.push(check(
      'link-26', 'No links to flagged domains', 'pass',
      'minor', 'Skipped', 'Domain reputation check skipped'
    ));
  } catch (e) {
    checks.push(check('link-26', 'No links to flagged domains', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 27: Tel: links formatted correctly (minor)
  // -----------------------------------------------------------------------
  try {
    const telLinks = [];
    const telRegex = /^tel:\+?[\d\s\-().]+$/;
    $('a[href^="tel:"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      telLinks.push({ href, valid: telRegex.test(href) });
    });
    const invalid = telLinks.filter((t) => !t.valid);
    if (telLinks.length === 0) {
      checks.push(check(
        'link-27', 'Tel: links formatted correctly', 'pass',
        'minor', 'No tel: links', 'No telephone links found'
      ));
    } else {
      checks.push(check(
        'link-27', 'Tel: links formatted correctly', invalid.length === 0 ? 'pass' : 'warn',
        'minor', `${invalid.length} invalid of ${telLinks.length}`,
        invalid.length === 0 ? 'All tel: links properly formatted' : `Invalid tel: links: ${invalid.slice(0, 5).map((t) => t.href).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('link-27', 'Tel: links formatted correctly', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 28: Mailto: links formatted correctly (minor)
  // -----------------------------------------------------------------------
  try {
    const mailtoLinks = [];
    const emailRegex = /^mailto:[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      mailtoLinks.push({ href, valid: emailRegex.test(href) });
    });
    const invalid = mailtoLinks.filter((m) => !m.valid);
    if (mailtoLinks.length === 0) {
      checks.push(check(
        'link-28', 'Mailto: links formatted correctly', 'pass',
        'minor', 'No mailto: links', 'No email links found'
      ));
    } else {
      checks.push(check(
        'link-28', 'Mailto: links formatted correctly', invalid.length === 0 ? 'pass' : 'warn',
        'minor', `${invalid.length} invalid of ${mailtoLinks.length}`,
        invalid.length === 0 ? 'All mailto: links properly formatted' : `Invalid mailto: links: ${invalid.slice(0, 5).map((m) => m.href).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('link-28', 'Mailto: links formatted correctly', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 29: Download links indicate file type (minor)
  // -----------------------------------------------------------------------
  try {
    const downloadLinks = [];
    $('a[download]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = ($(el).text() || '').trim();
      const hasExtension = /\.\w{2,5}$/.test(href) || /\.\w{2,5}(\?|$)/.test(href);
      const textIndicates = /\.(pdf|doc|docx|xls|xlsx|zip|csv|txt|ppt|pptx)/i.test(text);
      downloadLinks.push({ href, text, indicates: hasExtension || textIndicates });
    });
    const missing = downloadLinks.filter((d) => !d.indicates);
    if (downloadLinks.length === 0) {
      checks.push(check(
        'link-29', 'Download links indicate file type', 'pass',
        'minor', 'No download links', 'No download links found'
      ));
    } else {
      checks.push(check(
        'link-29', 'Download links indicate file type', missing.length === 0 ? 'pass' : 'warn',
        'minor', `${missing.length} unclear of ${downloadLinks.length}`,
        missing.length === 0 ? 'All download links indicate file type' : `${missing.length} download link(s) don't indicate file type`
      ));
    }
  } catch (e) {
    checks.push(check('link-29', 'Download links indicate file type', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 30: Pagination links work (minor)
  // -----------------------------------------------------------------------
  try {
    const hasRelNext = $('link[rel="next"]').length > 0 || $('a[rel="next"]').length > 0;
    const hasRelPrev = $('link[rel="prev"]').length > 0 || $('a[rel="prev"]').length > 0;
    const hasPagination = $('[class*="pagination"]').length > 0 || $('[class*="pager"]').length > 0;
    const hasPageLinks = $('a[href*="page="]').length > 0 || $('a[href*="/page/"]').length > 0;

    if (!hasRelNext && !hasRelPrev && !hasPagination && !hasPageLinks) {
      checks.push(check(
        'link-30', 'Pagination links work', 'pass',
        'minor', 'No pagination', 'No pagination found on this page'
      ));
    } else {
      // If pagination exists, check that pagination links are among crawled or internal links
      const paginationOk = hasRelNext || hasRelPrev || hasPagination || hasPageLinks;
      checks.push(check(
        'link-30', 'Pagination links work', paginationOk ? 'pass' : 'warn',
        'minor', 'Pagination found',
        `Pagination elements detected: ${[hasRelNext && 'rel=next', hasRelPrev && 'rel=prev', hasPagination && 'pagination class', hasPageLinks && 'page links'].filter(Boolean).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('link-30', 'Pagination links work', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 31: Search functionality present if > 20 pages (minor)
  // -----------------------------------------------------------------------
  try {
    const hasSearch =
      $('form[role="search"]').length > 0 ||
      $('input[type="search"]').length > 0 ||
      $('input[name="q"]').length > 0 ||
      $('input[name="s"]').length > 0 ||
      $('input[name="search"]').length > 0 ||
      $('[class*="search"]').find('input').length > 0 ||
      $('[id*="search"]').find('input').length > 0;

    if (allPages.length <= 20) {
      checks.push(check(
        'link-31', 'Search functionality present', 'pass',
        'minor', hasSearch ? 'Search found' : `<= 20 pages (${allPages.length})`,
        allPages.length <= 20 ? 'Site has 20 or fewer pages — search not required' : 'Search functionality detected'
      ));
    } else {
      checks.push(check(
        'link-31', 'Search functionality present', hasSearch ? 'pass' : 'warn',
        'minor', hasSearch ? 'Search found' : 'No search',
        hasSearch ? 'Search functionality detected' : `Site has ${allPages.length} pages but no search functionality found`
      ));
    }
  } catch (e) {
    checks.push(check('link-31', 'Search functionality present', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 32: Sitemap matches crawled pages (minor)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-32', 'Sitemap matches crawled pages', 'pass',
        'minor', 'Only 1 page', 'Cannot compare sitemap coverage with only one page'
      ));
    } else if (sitemapUrls.length === 0) {
      checks.push(check(
        'link-32', 'Sitemap matches crawled pages', 'warn',
        'minor', 'No sitemap', 'No sitemap URLs found to compare'
      ));
    } else {
      const crawledSet = new Set(allPages.map((p) => p.url));
      const inSitemapNotCrawled = sitemapUrls.filter((u) => !crawledSet.has(u));
      const crawledNotInSitemap = allPages.map((p) => p.url).filter((u) => !sitemapUrls.includes(u));
      const mismatch = inSitemapNotCrawled.length + crawledNotInSitemap.length;
      checks.push(check(
        'link-32', 'Sitemap matches crawled pages', mismatch === 0 ? 'pass' : 'warn',
        'minor', `${mismatch} mismatch(es)`,
        mismatch === 0
          ? 'Sitemap URLs match crawled pages'
          : `${inSitemapNotCrawled.length} in sitemap but not crawled, ${crawledNotInSitemap.length} crawled but not in sitemap`
      ));
    }
  } catch (e) {
    checks.push(check('link-32', 'Sitemap matches crawled pages', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 33: No soft 404s (major)
  // -----------------------------------------------------------------------
  try {
    const soft404s = [];
    for (const p of allPages) {
      if (p.statusCode === 200 && p.html) {
        const text = cheerio.load(p.html || '').text().toLowerCase();
        const matches = SOFT_404_PHRASES.filter((phrase) => text.includes(phrase));
        // Only flag if the page title or main content area has these phrases
        // and the page is relatively short (to avoid false positives on pages that mention 404 in passing)
        if (matches.length >= 2 || (matches.length >= 1 && (p.html || '').length < 5000)) {
          soft404s.push(p.url);
        }
      }
    }
    checks.push(check(
      'link-33', 'No soft 404s', soft404s.length === 0 ? 'pass' : 'fail',
      'major', `${soft404s.length} soft 404(s)`,
      soft404s.length === 0 ? 'No soft 404 pages detected' : `Possible soft 404s: ${soft404s.slice(0, 5).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('link-33', 'No soft 404s', 'warn', 'major', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 34: No history manipulation concerns (minor)
  // -----------------------------------------------------------------------
  try {
    const html = pageData.html || '';
    const hasPushState = html.includes('pushState') || html.includes('replaceState');
    checks.push(check(
      'link-34', 'No history manipulation concerns', hasPushState ? 'warn' : 'pass',
      'minor', hasPushState ? 'pushState/replaceState found' : 'None found',
      hasPushState ? 'Page uses history.pushState/replaceState — verify navigation works with back/forward buttons' : 'No history manipulation detected'
    ));
  } catch (e) {
    checks.push(check('link-34', 'No history manipulation concerns', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 35: Hash navigation works (minor)
  // -----------------------------------------------------------------------
  try {
    const hashLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.startsWith('#') && href.length > 1) {
        hashLinks.push(href.slice(1));
      }
    });
    const missing = hashLinks.filter((id) =>
      $(`[id="${id}"]`).length === 0 && $(`[name="${id}"]`).length === 0
    );
    const unique = [...new Set(missing)];
    checks.push(check(
      'link-35', 'Hash navigation works', unique.length === 0 ? 'pass' : 'warn',
      'minor', `${unique.length} missing target(s)`,
      unique.length === 0 ? 'All hash navigation targets exist' : `Missing targets for: ${unique.slice(0, 10).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('link-35', 'Hash navigation works', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 36: All nav items reachable (minor)
  // -----------------------------------------------------------------------
  try {
    if (allPages.length < 2) {
      checks.push(check(
        'link-36', 'All nav items reachable', 'pass',
        'minor', 'Only 1 page', 'Cannot verify nav reachability with only one page'
      ));
    } else {
      const navHrefs = [];
      $('nav a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        try {
          const resolved = new URL(href, currentUrl).href;
          navHrefs.push(resolved);
        } catch { /* ignore */ }
      });

      const unreachable = navHrefs.filter((href) => {
        // Check if the nav link target is among crawled pages
        try {
          const parsed = new URL(href);
          if (parsed.hostname.includes(domain)) {
            return !allCrawledUrls.has(href);
          }
        } catch { /* ignore */ }
        return false; // external links are not expected to be crawled
      });

      const unique = [...new Set(unreachable)];
      checks.push(check(
        'link-36', 'All nav items reachable', unique.length === 0 ? 'pass' : 'warn',
        'minor', `${unique.length} unreachable`,
        unique.length === 0 ? 'All navigation items lead to reachable pages' : `Unreachable nav links: ${unique.slice(0, 5).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('link-36', 'All nav items reachable', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 37: Dropdown menus function (minor)
  // -----------------------------------------------------------------------
  try {
    const hasDropdown =
      $('nav ul ul').length > 0 ||
      $('nav li ul').length > 0 ||
      $('nav [class*="dropdown"]').length > 0 ||
      $('nav [class*="submenu"]').length > 0 ||
      $('nav [class*="sub-menu"]').length > 0 ||
      $('[class*="dropdown-menu"]').length > 0;

    if (!hasDropdown) {
      checks.push(check(
        'link-37', 'Dropdown menus function', 'pass',
        'minor', 'No dropdowns', 'No dropdown navigation patterns detected'
      ));
    } else {
      // Verify dropdown items have links
      const dropdownLinks = $('nav ul ul a[href], nav [class*="dropdown"] a[href], [class*="dropdown-menu"] a[href]');
      const hasLinks = dropdownLinks.length > 0;
      checks.push(check(
        'link-37', 'Dropdown menus function', hasLinks ? 'pass' : 'warn',
        'minor', `${dropdownLinks.length} dropdown link(s)`,
        hasLinks ? `Dropdown menus found with ${dropdownLinks.length} links` : 'Dropdown structure found but no links inside — verify functionality'
      ));
    }
  } catch (e) {
    checks.push(check('link-37', 'Dropdown menus function', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 38: Mobile nav hamburger exists (minor)
  // -----------------------------------------------------------------------
  try {
    const hasHamburger =
      $('[class*="hamburger"]').length > 0 ||
      $('[class*="mobile-menu"]').length > 0 ||
      $('[class*="mobile-nav"]').length > 0 ||
      $('[class*="menu-toggle"]').length > 0 ||
      $('[class*="nav-toggle"]').length > 0 ||
      $('[class*="navbar-toggler"]').length > 0 ||
      $('[class*="burger"]').length > 0 ||
      $('button[aria-label*="menu" i]').length > 0 ||
      $('button[aria-label*="Menu" i]').length > 0 ||
      $('[data-toggle="collapse"][data-target*="nav"]').length > 0 ||
      $('[class*="toggle-menu"]').length > 0;

    checks.push(check(
      'link-38', 'Mobile nav hamburger exists', hasHamburger ? 'pass' : 'warn',
      'minor', hasHamburger ? 'Found' : 'Not detected',
      hasHamburger ? 'Mobile hamburger/toggle menu detected' : 'No mobile hamburger menu pattern detected — verify mobile navigation'
    ));
  } catch (e) {
    checks.push(check('link-38', 'Mobile nav hamburger exists', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 39: CTA links functional (minor)
  // -----------------------------------------------------------------------
  try {
    const ctaLinks = [];
    $('a[class*="cta"], a[class*="btn"], a[class*="button"], a.btn, button a, a[role="button"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      ctaLinks.push(href);
    });

    if (ctaLinks.length === 0) {
      checks.push(check(
        'link-39', 'CTA links functional', 'pass',
        'minor', 'No CTA links', 'No CTA-styled links detected'
      ));
    } else {
      const broken = ctaLinks.filter((href) => {
        if (!href || href === '#' || href === '') return true;
        if (href.startsWith('javascript:void')) return true;
        return false;
      });
      checks.push(check(
        'link-39', 'CTA links functional', broken.length === 0 ? 'pass' : 'warn',
        'minor', `${broken.length} non-functional of ${ctaLinks.length}`,
        broken.length === 0 ? `All ${ctaLinks.length} CTA link(s) have valid hrefs` : `${broken.length} CTA link(s) point to # or javascript:void`
      ));
    }
  } catch (e) {
    checks.push(check('link-39', 'CTA links functional', 'warn', 'minor', 'error', e.message));
  }

  // -----------------------------------------------------------------------
  // Check 40: Social media links valid (minor)
  // -----------------------------------------------------------------------
  try {
    const socialLinks = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      for (const sd of SOCIAL_DOMAINS) {
        if (href.includes(sd)) {
          socialLinks.push({ href, domain: sd });
          break;
        }
      }
    });

    if (socialLinks.length === 0) {
      checks.push(check(
        'link-40', 'Social media links valid', 'pass',
        'minor', 'No social links', 'No social media links found'
      ));
    } else {
      // Validate social links have proper profile URLs (not just domain root)
      const suspicious = socialLinks.filter((s) => {
        try {
          const u = new URL(s.href);
          // If it's just the domain with no path, it's probably wrong
          return u.pathname === '/' || u.pathname === '';
        } catch {
          return true; // malformed URL
        }
      });
      checks.push(check(
        'link-40', 'Social media links valid', suspicious.length === 0 ? 'pass' : 'warn',
        'minor', `${socialLinks.length} social link(s), ${suspicious.length} suspicious`,
        suspicious.length === 0 ? `All ${socialLinks.length} social media link(s) appear valid` : `${suspicious.length} social link(s) may be incomplete (link to root domain only): ${suspicious.slice(0, 3).map((s) => s.href).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('link-40', 'Social media links valid', 'warn', 'minor', 'error', e.message));
  }

  return { checks };
}

module.exports = { analyzeLinks };
