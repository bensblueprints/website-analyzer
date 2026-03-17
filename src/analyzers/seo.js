const cheerio = require('cheerio');

/**
 * SEO Analyzer - 80 deterministic data points
 * Analyzes on-page SEO, technical SEO, structured data, and cross-page issues.
 *
 * @param {Object} pageData - { url, html, statusCode, headers, responseTime, networkRequests, consoleMessages, links }
 * @param {Array}  allPages  - Array of all pageData objects (for cross-page checks)
 * @param {Object} siteData  - { sitemapUrls, robotsTxt: { exists, content, blocked }, domain }
 * @returns {Promise<{ checks: Array<{ id, name, status, severity, value, details }> }>}
 */
async function analyzeSEO(pageData, allPages, siteData) {
  const checks = [];
  const $ = cheerio.load(pageData.html || '');
  const url = pageData.url || '';
  const pageIndex = allPages.indexOf(pageData);
  const isFirstPage = pageIndex === 0 || pageIndex === -1;

  // ─── Helpers ──────────────────────────────────────────────────────────

  function addCheck(id, name, status, severity, value, details) {
    checks.push({ id: `seo-${id}`, name, status, severity, value, details });
  }

  function safeCheck(id, name, severity, fn) {
    try {
      fn();
    } catch (err) {
      addCheck(id, name, 'warn', severity, null, `Check failed: ${err.message}`);
    }
  }

  function getMetaContent(name) {
    return (
      $(`meta[name="${name}"]`).attr('content') ||
      $(`meta[property="${name}"]`).attr('content') ||
      ''
    );
  }

  function getPageText() {
    const clone = $.root().clone();
    clone.find('script, style, noscript').remove();
    return clone.text().replace(/\s+/g, ' ').trim();
  }

  function getWords(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }

  /**
   * Build a simple adjacency representation from allPages links for depth calculation.
   */
  function buildLinkGraph() {
    const graph = {};
    for (const p of allPages) {
      const fromUrl = normalizeUrl(p.url);
      if (!graph[fromUrl]) graph[fromUrl] = [];
      if (p.links && Array.isArray(p.links)) {
        for (const link of p.links) {
          const href = normalizeUrl(typeof link === 'string' ? link : (link.href || ''));
          if (href && isInternal(href)) {
            graph[fromUrl].push(href);
          }
        }
      }
    }
    return graph;
  }

  function normalizeUrl(u) {
    try {
      const parsed = new URL(u);
      return (parsed.origin + parsed.pathname).replace(/\/+$/, '') || parsed.origin;
    } catch {
      return u;
    }
  }

  function isInternal(href) {
    try {
      const parsed = new URL(href);
      const domain = siteData && siteData.domain ? siteData.domain : new URL(url).hostname;
      return parsed.hostname === domain || parsed.hostname.endsWith('.' + domain);
    } catch {
      return href.startsWith('/');
    }
  }

  function getTextContent(el) {
    return $(el).text().trim();
  }

  // Extract page body text once
  const pageText = getPageText();
  const pageWords = getWords(pageText);

  // ─── CHECK 1: Title tag exists ────────────────────────────────────────
  safeCheck(1, 'Title tag exists', 'critical', () => {
    const title = $('title').text().trim();
    if (title) {
      addCheck(1, 'Title tag exists', 'pass', 'critical', title, `Title found: "${title}"`);
    } else {
      addCheck(1, 'Title tag exists', 'fail', 'critical', null, 'No <title> tag found on the page');
    }
  });

  // ─── CHECK 2: Title length ────────────────────────────────────────────
  safeCheck(2, 'Title length optimal', 'major', () => {
    const title = $('title').text().trim();
    const len = title.length;
    if (!title) {
      addCheck(2, 'Title length optimal', 'fail', 'major', 0, 'No title tag found');
    } else if (len >= 50 && len <= 60) {
      addCheck(2, 'Title length optimal', 'pass', 'major', len, `Title is ${len} chars (ideal 50-60)`);
    } else if (len >= 30 && len <= 70) {
      addCheck(2, 'Title length optimal', 'warn', 'major', len, `Title is ${len} chars (acceptable 30-70, ideal 50-60)`);
    } else {
      addCheck(2, 'Title length optimal', 'fail', 'major', len, `Title is ${len} chars (should be 30-70, ideal 50-60)`);
    }
  });

  // ─── CHECK 3: Title unique across pages ───────────────────────────────
  safeCheck(3, 'Title unique across pages', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(3, 'Title unique across pages', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const titles = allPages.map(p => {
      try { return cheerio.load(p.html || '')('title').text().trim(); } catch { return ''; }
    }).filter(Boolean);
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    if (dupes.length === 0) {
      addCheck(3, 'Title unique across pages', 'pass', 'major', true, 'All page titles are unique');
    } else {
      const unique = [...new Set(dupes)];
      addCheck(3, 'Title unique across pages', 'fail', 'major', unique, `Duplicate titles found: ${unique.map(t => `"${t}"`).join(', ')}`);
    }
  });

  // ─── CHECK 4: Meta description exists ─────────────────────────────────
  safeCheck(4, 'Meta description exists', 'critical', () => {
    const desc = getMetaContent('description');
    if (desc) {
      addCheck(4, 'Meta description exists', 'pass', 'critical', desc, `Meta description found (${desc.length} chars)`);
    } else {
      addCheck(4, 'Meta description exists', 'fail', 'critical', null, 'No meta description tag found');
    }
  });

  // ─── CHECK 5: Meta description length ─────────────────────────────────
  safeCheck(5, 'Meta description length optimal', 'major', () => {
    const desc = getMetaContent('description');
    const len = desc.length;
    if (!desc) {
      addCheck(5, 'Meta description length optimal', 'fail', 'major', 0, 'No meta description found');
    } else if (len >= 150 && len <= 160) {
      addCheck(5, 'Meta description length optimal', 'pass', 'major', len, `Meta description is ${len} chars (ideal 150-160)`);
    } else if (len >= 120 && len <= 170) {
      addCheck(5, 'Meta description length optimal', 'warn', 'major', len, `Meta description is ${len} chars (acceptable 120-170, ideal 150-160)`);
    } else {
      addCheck(5, 'Meta description length optimal', 'fail', 'major', len, `Meta description is ${len} chars (should be 120-170, ideal 150-160)`);
    }
  });

  // ─── CHECK 6: Meta description unique across pages ────────────────────
  safeCheck(6, 'Meta description unique across pages', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(6, 'Meta description unique across pages', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const descs = allPages.map(p => {
      try {
        const $p = cheerio.load(p.html || '');
        return $p('meta[name="description"]').attr('content') || $p('meta[property="description"]').attr('content') || '';
      } catch { return ''; }
    }).filter(Boolean);
    const dupes = descs.filter((d, i) => descs.indexOf(d) !== i);
    if (dupes.length === 0) {
      addCheck(6, 'Meta description unique across pages', 'pass', 'major', true, 'All meta descriptions are unique');
    } else {
      addCheck(6, 'Meta description unique across pages', 'fail', 'major', [...new Set(dupes)].length, `${[...new Set(dupes)].length} duplicate meta description(s) found`);
    }
  });

  // ─── CHECK 7: H1 exists ───────────────────────────────────────────────
  safeCheck(7, 'H1 tag exists', 'critical', () => {
    const h1s = $('h1');
    if (h1s.length > 0) {
      addCheck(7, 'H1 tag exists', 'pass', 'critical', h1s.length, `Found ${h1s.length} H1 tag(s)`);
    } else {
      addCheck(7, 'H1 tag exists', 'fail', 'critical', 0, 'No H1 tag found on the page');
    }
  });

  // ─── CHECK 8: Only one H1 per page ────────────────────────────────────
  safeCheck(8, 'Single H1 per page', 'major', () => {
    const h1Count = $('h1').length;
    if (h1Count === 1) {
      addCheck(8, 'Single H1 per page', 'pass', 'major', h1Count, 'Page has exactly one H1 tag');
    } else if (h1Count === 0) {
      addCheck(8, 'Single H1 per page', 'fail', 'major', 0, 'No H1 tag found');
    } else {
      addCheck(8, 'Single H1 per page', 'fail', 'major', h1Count, `Page has ${h1Count} H1 tags (should be exactly 1)`);
    }
  });

  // ─── CHECK 9: H1 not empty ────────────────────────────────────────────
  safeCheck(9, 'H1 not empty', 'major', () => {
    const h1 = $('h1').first();
    if (h1.length === 0) {
      addCheck(9, 'H1 not empty', 'fail', 'major', null, 'No H1 tag found');
    } else {
      const text = h1.text().trim();
      if (text.length > 0) {
        addCheck(9, 'H1 not empty', 'pass', 'major', text, `H1 content: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
      } else {
        addCheck(9, 'H1 not empty', 'fail', 'major', '', 'H1 tag is empty');
      }
    }
  });

  // ─── CHECK 10: Heading hierarchy valid ────────────────────────────────
  safeCheck(10, 'Heading hierarchy valid', 'major', () => {
    const headings = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      headings.push(parseInt(el.tagName.replace('h', ''), 10));
    });
    if (headings.length === 0) {
      addCheck(10, 'Heading hierarchy valid', 'warn', 'major', null, 'No headings found');
      return;
    }
    let valid = true;
    const skipped = [];
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        valid = false;
        skipped.push(`h${headings[i - 1]} -> h${headings[i]}`);
      }
    }
    if (valid) {
      addCheck(10, 'Heading hierarchy valid', 'pass', 'major', true, 'No skipped heading levels');
    } else {
      addCheck(10, 'Heading hierarchy valid', 'fail', 'major', skipped, `Skipped heading levels: ${skipped.join(', ')}`);
    }
  });

  // ─── CHECK 11: H2 tags present ────────────────────────────────────────
  safeCheck(11, 'H2 tags present', 'minor', () => {
    const h2Count = $('h2').length;
    if (h2Count > 0) {
      addCheck(11, 'H2 tags present', 'pass', 'minor', h2Count, `Found ${h2Count} H2 tag(s)`);
    } else {
      addCheck(11, 'H2 tags present', 'warn', 'minor', 0, 'No H2 tags found - consider adding subheadings');
    }
  });

  // ─── CHECK 12: Heading count reasonable ───────────────────────────────
  safeCheck(12, 'Heading count reasonable', 'minor', () => {
    const count = $('h1, h2, h3, h4, h5, h6').length;
    if (count >= 1 && count <= 30) {
      addCheck(12, 'Heading count reasonable', 'pass', 'minor', count, `${count} headings found (reasonable range 1-30)`);
    } else if (count === 0) {
      addCheck(12, 'Heading count reasonable', 'warn', 'minor', 0, 'No headings found on page');
    } else {
      addCheck(12, 'Heading count reasonable', 'warn', 'minor', count, `${count} headings found (may be excessive, recommended 1-30)`);
    }
  });

  // ─── CHECK 13: URL is readable ────────────────────────────────────────
  safeCheck(13, 'URL is readable', 'minor', () => {
    try {
      const parsed = new URL(url);
      const params = [...parsed.searchParams.keys()];
      if (params.length <= 2) {
        addCheck(13, 'URL is readable', 'pass', 'minor', params.length, `URL has ${params.length} query parameter(s)`);
      } else {
        addCheck(13, 'URL is readable', 'warn', 'minor', params.length, `URL has ${params.length} query parameters (excessive, consider cleaner URLs)`);
      }
    } catch {
      addCheck(13, 'URL is readable', 'warn', 'minor', null, 'Could not parse URL');
    }
  });

  // ─── CHECK 14: URL length < 100 chars ─────────────────────────────────
  safeCheck(14, 'URL length under 100 chars', 'minor', () => {
    const len = url.length;
    if (len < 100) {
      addCheck(14, 'URL length under 100 chars', 'pass', 'minor', len, `URL is ${len} characters`);
    } else {
      addCheck(14, 'URL length under 100 chars', 'warn', 'minor', len, `URL is ${len} characters (recommended under 100)`);
    }
  });

  // ─── CHECK 15: URL uses hyphens not underscores ───────────────────────
  safeCheck(15, 'URL uses hyphens not underscores', 'minor', () => {
    try {
      const path = new URL(url).pathname;
      if (path.includes('_')) {
        addCheck(15, 'URL uses hyphens not underscores', 'warn', 'minor', false, 'URL path contains underscores - prefer hyphens for SEO');
      } else {
        addCheck(15, 'URL uses hyphens not underscores', 'pass', 'minor', true, 'URL path uses hyphens correctly');
      }
    } catch {
      addCheck(15, 'URL uses hyphens not underscores', 'warn', 'minor', null, 'Could not parse URL');
    }
  });

  // ─── CHECK 16: URL lowercase ──────────────────────────────────────────
  safeCheck(16, 'URL is lowercase', 'minor', () => {
    try {
      const path = new URL(url).pathname;
      if (path === path.toLowerCase()) {
        addCheck(16, 'URL is lowercase', 'pass', 'minor', true, 'URL path is lowercase');
      } else {
        addCheck(16, 'URL is lowercase', 'warn', 'minor', false, 'URL path contains uppercase characters');
      }
    } catch {
      addCheck(16, 'URL is lowercase', 'warn', 'minor', null, 'Could not parse URL');
    }
  });

  // ─── CHECK 17: No double slashes in path ──────────────────────────────
  safeCheck(17, 'No double slashes in URL path', 'minor', () => {
    try {
      const path = new URL(url).pathname;
      if (path.includes('//')) {
        addCheck(17, 'No double slashes in URL path', 'warn', 'minor', false, 'URL path contains double slashes');
      } else {
        addCheck(17, 'No double slashes in URL path', 'pass', 'minor', true, 'URL path has no double slashes');
      }
    } catch {
      addCheck(17, 'No double slashes in URL path', 'warn', 'minor', null, 'Could not parse URL');
    }
  });

  // ─── CHECK 18: Canonical tag present ──────────────────────────────────
  safeCheck(18, 'Canonical tag present', 'major', () => {
    const canonical = $('link[rel="canonical"]').attr('href');
    if (canonical) {
      addCheck(18, 'Canonical tag present', 'pass', 'major', canonical, `Canonical URL: ${canonical}`);
    } else {
      addCheck(18, 'Canonical tag present', 'fail', 'major', null, 'No canonical tag found');
    }
  });

  // ─── CHECK 19: Canonical is self-referencing or valid ─────────────────
  safeCheck(19, 'Canonical URL is valid', 'major', () => {
    const canonical = $('link[rel="canonical"]').attr('href');
    if (!canonical) {
      addCheck(19, 'Canonical URL is valid', 'warn', 'major', null, 'No canonical tag to validate');
      return;
    }
    try {
      const canonicalUrl = new URL(canonical, url).href;
      const normalizedPage = normalizeUrl(url);
      const normalizedCanonical = normalizeUrl(canonicalUrl);
      if (normalizedCanonical === normalizedPage) {
        addCheck(19, 'Canonical URL is valid', 'pass', 'major', canonical, 'Canonical is self-referencing');
      } else {
        // Valid URL but pointing elsewhere
        new URL(canonicalUrl);
        addCheck(19, 'Canonical URL is valid', 'pass', 'major', canonical, `Canonical points to: ${canonicalUrl}`);
      }
    } catch {
      addCheck(19, 'Canonical URL is valid', 'fail', 'major', canonical, 'Canonical URL is not a valid URL');
    }
  });

  // ─── CHECK 20: robots.txt exists ──────────────────────────────────────
  safeCheck(20, 'robots.txt exists', 'major', () => {
    const exists = siteData && siteData.robotsTxt && siteData.robotsTxt.exists;
    if (exists) {
      addCheck(20, 'robots.txt exists', 'pass', 'major', true, 'robots.txt file found');
    } else {
      addCheck(20, 'robots.txt exists', 'fail', 'major', false, 'No robots.txt file found');
    }
  });

  // ─── CHECK 21: robots.txt is valid/parseable ──────────────────────────
  safeCheck(21, 'robots.txt is valid', 'minor', () => {
    if (!siteData || !siteData.robotsTxt || !siteData.robotsTxt.exists) {
      addCheck(21, 'robots.txt is valid', 'warn', 'minor', null, 'No robots.txt to validate');
      return;
    }
    const content = siteData.robotsTxt.content || '';
    const hasUserAgent = /user-agent:/i.test(content);
    const hasDirective = /(?:allow|disallow|sitemap|crawl-delay):/i.test(content);
    if (hasUserAgent && hasDirective) {
      addCheck(21, 'robots.txt is valid', 'pass', 'minor', true, 'robots.txt contains valid directives');
    } else {
      addCheck(21, 'robots.txt is valid', 'warn', 'minor', false, 'robots.txt may not be properly formatted');
    }
  });

  // ─── CHECK 22: robots.txt doesn't block important pages ──────────────
  safeCheck(22, 'robots.txt not blocking important pages', 'major', () => {
    if (!siteData || !siteData.robotsTxt || !siteData.robotsTxt.exists) {
      addCheck(22, 'robots.txt not blocking important pages', 'warn', 'major', null, 'No robots.txt to check');
      return;
    }
    const blocked = siteData.robotsTxt.blocked;
    if (Array.isArray(blocked) && blocked.length > 0) {
      // Check if any crawled pages are blocked
      const crawledUrls = allPages.map(p => p.url);
      const blockedCrawled = crawledUrls.filter(u => {
        try {
          const path = new URL(u).pathname;
          return blocked.some(b => path.startsWith(b) || path === b);
        } catch { return false; }
      });
      if (blockedCrawled.length > 0) {
        addCheck(22, 'robots.txt not blocking important pages', 'fail', 'major', blockedCrawled.length, `${blockedCrawled.length} crawled page(s) are blocked by robots.txt`);
      } else {
        addCheck(22, 'robots.txt not blocking important pages', 'pass', 'major', true, 'No crawled pages blocked by robots.txt');
      }
    } else {
      addCheck(22, 'robots.txt not blocking important pages', 'pass', 'major', true, 'No blocked paths detected in robots.txt');
    }
  });

  // ─── CHECK 23: sitemap.xml exists ─────────────────────────────────────
  safeCheck(23, 'sitemap.xml exists', 'major', () => {
    const hasSitemap = siteData && Array.isArray(siteData.sitemapUrls) && siteData.sitemapUrls.length > 0;
    if (hasSitemap) {
      addCheck(23, 'sitemap.xml exists', 'pass', 'major', siteData.sitemapUrls.length, `Sitemap found with ${siteData.sitemapUrls.length} URL(s)`);
    } else if (siteData && siteData.sitemapUrls !== undefined) {
      addCheck(23, 'sitemap.xml exists', 'fail', 'major', false, 'No sitemap.xml found or sitemap is empty');
    } else {
      addCheck(23, 'sitemap.xml exists', 'fail', 'major', false, 'sitemap.xml not detected');
    }
  });

  // ─── CHECK 24: sitemap.xml is valid ───────────────────────────────────
  safeCheck(24, 'sitemap.xml is valid', 'minor', () => {
    if (!siteData || !Array.isArray(siteData.sitemapUrls)) {
      addCheck(24, 'sitemap.xml is valid', 'warn', 'minor', null, 'No sitemap data to validate');
      return;
    }
    const validUrls = siteData.sitemapUrls.filter(u => {
      try { new URL(u); return true; } catch { return false; }
    });
    if (validUrls.length === siteData.sitemapUrls.length && validUrls.length > 0) {
      addCheck(24, 'sitemap.xml is valid', 'pass', 'minor', true, 'All sitemap URLs are valid');
    } else if (validUrls.length > 0) {
      addCheck(24, 'sitemap.xml is valid', 'warn', 'minor', false, `${siteData.sitemapUrls.length - validUrls.length} invalid URL(s) in sitemap`);
    } else {
      addCheck(24, 'sitemap.xml is valid', 'fail', 'minor', false, 'Sitemap contains no valid URLs');
    }
  });

  // ─── CHECK 25: Sitemap lists crawled pages ────────────────────────────
  safeCheck(25, 'Sitemap lists crawled pages', 'minor', () => {
    if (!siteData || !Array.isArray(siteData.sitemapUrls) || siteData.sitemapUrls.length === 0) {
      addCheck(25, 'Sitemap lists crawled pages', 'warn', 'minor', null, 'No sitemap to compare');
      return;
    }
    const normalizedSitemap = new Set(siteData.sitemapUrls.map(u => normalizeUrl(u)));
    const normalizedCrawled = allPages.map(p => normalizeUrl(p.url));
    const inSitemap = normalizedCrawled.filter(u => normalizedSitemap.has(u));
    if (inSitemap.length === normalizedCrawled.length) {
      addCheck(25, 'Sitemap lists crawled pages', 'pass', 'minor', true, 'All crawled pages are listed in the sitemap');
    } else {
      const missing = normalizedCrawled.length - inSitemap.length;
      addCheck(25, 'Sitemap lists crawled pages', 'warn', 'minor', missing, `${missing} crawled page(s) not found in sitemap`);
    }
  });

  // ─── CHECK 26: Sitemap referenced in robots.txt ──────────────────────
  safeCheck(26, 'Sitemap referenced in robots.txt', 'minor', () => {
    if (!siteData || !siteData.robotsTxt || !siteData.robotsTxt.exists) {
      addCheck(26, 'Sitemap referenced in robots.txt', 'warn', 'minor', null, 'No robots.txt to check');
      return;
    }
    const content = siteData.robotsTxt.content || '';
    if (/sitemap:/i.test(content)) {
      addCheck(26, 'Sitemap referenced in robots.txt', 'pass', 'minor', true, 'Sitemap directive found in robots.txt');
    } else {
      addCheck(26, 'Sitemap referenced in robots.txt', 'warn', 'minor', false, 'No Sitemap directive in robots.txt');
    }
  });

  // ─── CHECKS 27-31: Open Graph tags ────────────────────────────────────
  const ogTags = [
    { num: 27, prop: 'og:title', name: 'Open Graph title' },
    { num: 28, prop: 'og:description', name: 'Open Graph description' },
    { num: 29, prop: 'og:image', name: 'Open Graph image' },
    { num: 30, prop: 'og:url', name: 'Open Graph URL' },
    { num: 31, prop: 'og:type', name: 'Open Graph type' },
  ];
  for (const tag of ogTags) {
    safeCheck(tag.num, `${tag.name} present`, 'minor', () => {
      const val = $(`meta[property="${tag.prop}"]`).attr('content') || '';
      if (val) {
        addCheck(tag.num, `${tag.name} present`, 'pass', 'minor', val, `${tag.prop}: "${val.substring(0, 100)}"`);
      } else {
        addCheck(tag.num, `${tag.name} present`, 'warn', 'minor', null, `Missing ${tag.prop} meta tag`);
      }
    });
  }

  // ─── CHECKS 32-35: Twitter Card tags ──────────────────────────────────
  const twitterTags = [
    { num: 32, prop: 'twitter:card', name: 'Twitter Card type' },
    { num: 33, prop: 'twitter:title', name: 'Twitter Card title' },
    { num: 34, prop: 'twitter:description', name: 'Twitter Card description' },
    { num: 35, prop: 'twitter:image', name: 'Twitter Card image' },
  ];
  for (const tag of twitterTags) {
    safeCheck(tag.num, `${tag.name} present`, 'minor', () => {
      const val = $(`meta[name="${tag.prop}"]`).attr('content') || $(`meta[property="${tag.prop}"]`).attr('content') || '';
      if (val) {
        addCheck(tag.num, `${tag.name} present`, 'pass', 'minor', val, `${tag.prop}: "${val.substring(0, 100)}"`);
      } else {
        addCheck(tag.num, `${tag.name} present`, 'warn', 'minor', null, `Missing ${tag.prop} meta tag`);
      }
    });
  }

  // ─── CHECK 36: Schema.org structured data present ─────────────────────
  safeCheck(36, 'Schema.org structured data present', 'major', () => {
    const jsonLd = $('script[type="application/ld+json"]');
    const microdata = $('[itemscope]');
    const rdfa = $('[typeof]');
    const hasStructured = jsonLd.length > 0 || microdata.length > 0 || rdfa.length > 0;
    if (hasStructured) {
      const types = [];
      if (jsonLd.length > 0) types.push(`${jsonLd.length} JSON-LD block(s)`);
      if (microdata.length > 0) types.push(`${microdata.length} microdata element(s)`);
      if (rdfa.length > 0) types.push(`${rdfa.length} RDFa element(s)`);
      addCheck(36, 'Schema.org structured data present', 'pass', 'major', true, `Structured data found: ${types.join(', ')}`);
    } else {
      addCheck(36, 'Schema.org structured data present', 'fail', 'major', false, 'No structured data (JSON-LD, microdata, or RDFa) found');
    }
  });

  // ─── CHECK 37: Schema.org valid JSON ──────────────────────────────────
  safeCheck(37, 'Schema.org JSON-LD valid', 'minor', () => {
    const jsonLd = $('script[type="application/ld+json"]');
    if (jsonLd.length === 0) {
      addCheck(37, 'Schema.org JSON-LD valid', 'warn', 'minor', null, 'No JSON-LD blocks to validate');
      return;
    }
    let allValid = true;
    const errors = [];
    jsonLd.each((i, el) => {
      try {
        JSON.parse($(el).html());
      } catch (e) {
        allValid = false;
        errors.push(`Block ${i + 1}: ${e.message}`);
      }
    });
    if (allValid) {
      addCheck(37, 'Schema.org JSON-LD valid', 'pass', 'minor', true, `All ${jsonLd.length} JSON-LD block(s) are valid JSON`);
    } else {
      addCheck(37, 'Schema.org JSON-LD valid', 'fail', 'minor', errors, `Invalid JSON-LD: ${errors.join('; ')}`);
    }
  });

  // ─── CHECK 38: Schema.org uses recommended types ──────────────────────
  safeCheck(38, 'Schema.org uses recommended types', 'minor', () => {
    const jsonLd = $('script[type="application/ld+json"]');
    if (jsonLd.length === 0) {
      addCheck(38, 'Schema.org uses recommended types', 'warn', 'minor', null, 'No JSON-LD blocks to check');
      return;
    }
    const recommendedTypes = ['Organization', 'LocalBusiness', 'Person', 'WebSite', 'WebPage', 'Article', 'BlogPosting', 'Product', 'BreadcrumbList', 'FAQPage', 'HowTo', 'Event', 'Recipe', 'Review', 'VideoObject', 'Service'];
    const foundTypes = [];
    jsonLd.each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const extractTypes = (obj) => {
          if (!obj) return;
          if (obj['@type']) {
            const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
            foundTypes.push(...types);
          }
          if (obj['@graph'] && Array.isArray(obj['@graph'])) {
            obj['@graph'].forEach(extractTypes);
          }
        };
        extractTypes(data);
      } catch { /* ignore parse errors, handled in check 37 */ }
    });
    const recommended = foundTypes.filter(t => recommendedTypes.includes(t));
    if (recommended.length > 0) {
      addCheck(38, 'Schema.org uses recommended types', 'pass', 'minor', recommended, `Recommended types found: ${recommended.join(', ')}`);
    } else if (foundTypes.length > 0) {
      addCheck(38, 'Schema.org uses recommended types', 'warn', 'minor', foundTypes, `Types found (${foundTypes.join(', ')}) but none are commonly recommended`);
    } else {
      addCheck(38, 'Schema.org uses recommended types', 'warn', 'minor', null, 'Could not extract @type from structured data');
    }
  });

  // ─── CHECK 39: All images have alt attributes ─────────────────────────
  safeCheck(39, 'All images have alt attributes', 'critical', () => {
    const images = $('img');
    if (images.length === 0) {
      addCheck(39, 'All images have alt attributes', 'pass', 'critical', 0, 'No images found on page');
      return;
    }
    let missingAlt = 0;
    images.each((_, img) => {
      const alt = $(img).attr('alt');
      if (alt === undefined || alt === null) {
        missingAlt++;
      }
    });
    if (missingAlt === 0) {
      addCheck(39, 'All images have alt attributes', 'pass', 'critical', images.length, `All ${images.length} image(s) have alt attributes`);
    } else {
      addCheck(39, 'All images have alt attributes', 'fail', 'critical', missingAlt, `${missingAlt} of ${images.length} image(s) missing alt attribute`);
    }
  });

  // ─── CHECK 40: Alt text is descriptive ────────────────────────────────
  safeCheck(40, 'Alt text is descriptive', 'major', () => {
    const images = $('img');
    if (images.length === 0) {
      addCheck(40, 'Alt text is descriptive', 'pass', 'major', true, 'No images to check');
      return;
    }
    const fileNamePatterns = /^(img|image|photo|pic|picture|banner|hero|logo|icon)?[-_\s]?\d*\.(jpg|jpeg|png|gif|svg|webp|bmp|avif)$/i;
    const genericPatterns = /^(image|img|photo|picture|untitled|default|placeholder|no[- ]?image|blank)$/i;
    let badAlt = 0;
    images.each((_, img) => {
      const alt = ($(img).attr('alt') || '').trim();
      if (alt && (fileNamePatterns.test(alt) || genericPatterns.test(alt))) {
        badAlt++;
      }
    });
    if (badAlt === 0) {
      addCheck(40, 'Alt text is descriptive', 'pass', 'major', true, 'All alt texts appear descriptive');
    } else {
      addCheck(40, 'Alt text is descriptive', 'fail', 'major', badAlt, `${badAlt} image(s) have non-descriptive alt text (filename or generic)`);
    }
  });

  // ─── CHECK 41: Alt text not overly long ───────────────────────────────
  safeCheck(41, 'Alt text length under 125 chars', 'minor', () => {
    const images = $('img');
    if (images.length === 0) {
      addCheck(41, 'Alt text length under 125 chars', 'pass', 'minor', true, 'No images to check');
      return;
    }
    let longAlt = 0;
    images.each((_, img) => {
      const alt = ($(img).attr('alt') || '').trim();
      if (alt.length > 125) longAlt++;
    });
    if (longAlt === 0) {
      addCheck(41, 'Alt text length under 125 chars', 'pass', 'minor', true, 'All alt texts are within recommended length');
    } else {
      addCheck(41, 'Alt text length under 125 chars', 'warn', 'minor', longAlt, `${longAlt} image(s) have alt text exceeding 125 characters`);
    }
  });

  // ─── CHECK 42: Internal links count > 0 ───────────────────────────────
  safeCheck(42, 'Internal links present', 'major', () => {
    const links = pageData.links || [];
    const internalLinks = links.filter(link => {
      const href = typeof link === 'string' ? link : (link.href || '');
      return isInternal(href);
    });
    if (internalLinks.length > 0) {
      addCheck(42, 'Internal links present', 'pass', 'major', internalLinks.length, `Found ${internalLinks.length} internal link(s)`);
    } else {
      addCheck(42, 'Internal links present', 'fail', 'major', 0, 'No internal links found on this page');
    }
  });

  // ─── CHECK 43: Internal links use descriptive anchor text ─────────────
  safeCheck(43, 'Internal links have descriptive anchor text', 'minor', () => {
    const genericAnchors = /^(click here|here|read more|more|link|this|go|learn more|continue|page|website)$/i;
    const anchors = $('a');
    let genericCount = 0;
    let internalCount = 0;
    anchors.each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isInternal(href) || href.startsWith('/') || href.startsWith('#')) {
        internalCount++;
        const text = $(a).text().trim();
        if (text && genericAnchors.test(text)) {
          genericCount++;
        }
      }
    });
    if (internalCount === 0) {
      addCheck(43, 'Internal links have descriptive anchor text', 'warn', 'minor', null, 'No internal links to check');
    } else if (genericCount === 0) {
      addCheck(43, 'Internal links have descriptive anchor text', 'pass', 'minor', true, 'All internal link anchor texts are descriptive');
    } else {
      addCheck(43, 'Internal links have descriptive anchor text', 'warn', 'minor', genericCount, `${genericCount} internal link(s) use generic anchor text (e.g., "click here", "read more")`);
    }
  });

  // ─── CHECK 44: No orphan pages ────────────────────────────────────────
  safeCheck(44, 'No orphan pages', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(44, 'No orphan pages', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const linkedTo = new Set();
    for (const p of allPages) {
      const pLinks = p.links || [];
      for (const link of pLinks) {
        const href = typeof link === 'string' ? link : (link.href || '');
        try {
          const resolved = new URL(href, p.url).href;
          linkedTo.add(normalizeUrl(resolved));
        } catch { /* skip */ }
      }
    }
    const orphans = [];
    for (let i = 1; i < allPages.length; i++) {
      const normalized = normalizeUrl(allPages[i].url);
      if (!linkedTo.has(normalized)) {
        orphans.push(allPages[i].url);
      }
    }
    if (orphans.length === 0) {
      addCheck(44, 'No orphan pages', 'pass', 'major', true, 'All pages are linked from at least one other page');
    } else {
      addCheck(44, 'No orphan pages', 'fail', 'major', orphans.length, `${orphans.length} orphan page(s) found: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? '...' : ''}`);
    }
  });

  // ─── CHECK 45: Max click depth from homepage ≤ 3 ──────────────────────
  safeCheck(45, 'Click depth from homepage <= 3', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(45, 'Click depth from homepage <= 3', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const graph = buildLinkGraph();
    const homepage = normalizeUrl(allPages[0].url);
    const depths = {};
    depths[homepage] = 0;
    const queue = [homepage];
    while (queue.length > 0) {
      const current = queue.shift();
      const currentDepth = depths[current];
      const neighbors = graph[current] || [];
      for (const neighbor of neighbors) {
        const norm = normalizeUrl(neighbor);
        if (depths[norm] === undefined) {
          depths[norm] = currentDepth + 1;
          queue.push(norm);
        }
      }
    }
    const deepPages = [];
    for (const p of allPages) {
      const norm = normalizeUrl(p.url);
      const depth = depths[norm];
      if (depth !== undefined && depth > 3) {
        deepPages.push({ url: p.url, depth });
      }
    }
    const unreachable = allPages.filter(p => depths[normalizeUrl(p.url)] === undefined).length;
    if (deepPages.length === 0 && unreachable === 0) {
      addCheck(45, 'Click depth from homepage <= 3', 'pass', 'major', true, 'All pages are within 3 clicks of homepage');
    } else {
      const issues = [];
      if (deepPages.length > 0) issues.push(`${deepPages.length} page(s) are deeper than 3 clicks`);
      if (unreachable > 0) issues.push(`${unreachable} page(s) unreachable from homepage`);
      addCheck(45, 'Click depth from homepage <= 3', 'fail', 'major', { deepPages: deepPages.length, unreachable }, issues.join('; '));
    }
  });

  // ─── CHECK 46: Duplicate title tags across site ───────────────────────
  safeCheck(46, 'No duplicate title tags across site', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(46, 'No duplicate title tags across site', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const titleMap = {};
    for (const p of allPages) {
      try {
        const title = cheerio.load(p.html || '')('title').text().trim();
        if (title) {
          if (!titleMap[title]) titleMap[title] = [];
          titleMap[title].push(p.url);
        }
      } catch { /* skip */ }
    }
    const dupes = Object.entries(titleMap).filter(([, urls]) => urls.length > 1);
    if (dupes.length === 0) {
      addCheck(46, 'No duplicate title tags across site', 'pass', 'major', true, 'All title tags are unique');
    } else {
      const count = dupes.reduce((acc, [, urls]) => acc + urls.length, 0);
      addCheck(46, 'No duplicate title tags across site', 'fail', 'major', dupes.length, `${dupes.length} duplicated title(s) affecting ${count} pages`);
    }
  });

  // ─── CHECK 47: Duplicate meta descriptions ────────────────────────────
  safeCheck(47, 'No duplicate meta descriptions across site', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(47, 'No duplicate meta descriptions across site', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const descMap = {};
    for (const p of allPages) {
      try {
        const $p = cheerio.load(p.html || '');
        const desc = $p('meta[name="description"]').attr('content') || $p('meta[property="description"]').attr('content') || '';
        if (desc) {
          if (!descMap[desc]) descMap[desc] = [];
          descMap[desc].push(p.url);
        }
      } catch { /* skip */ }
    }
    const dupes = Object.entries(descMap).filter(([, urls]) => urls.length > 1);
    if (dupes.length === 0) {
      addCheck(47, 'No duplicate meta descriptions across site', 'pass', 'major', true, 'All meta descriptions are unique');
    } else {
      const count = dupes.reduce((acc, [, urls]) => acc + urls.length, 0);
      addCheck(47, 'No duplicate meta descriptions across site', 'fail', 'major', dupes.length, `${dupes.length} duplicated description(s) affecting ${count} pages`);
    }
  });

  // ─── CHECK 48: Duplicate H1 across site ───────────────────────────────
  safeCheck(48, 'No duplicate H1 tags across site', 'minor', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(48, 'No duplicate H1 tags across site', 'pass', 'minor', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const h1Map = {};
    for (const p of allPages) {
      try {
        const h1 = cheerio.load(p.html || '')('h1').first().text().trim();
        if (h1) {
          if (!h1Map[h1]) h1Map[h1] = [];
          h1Map[h1].push(p.url);
        }
      } catch { /* skip */ }
    }
    const dupes = Object.entries(h1Map).filter(([, urls]) => urls.length > 1);
    if (dupes.length === 0) {
      addCheck(48, 'No duplicate H1 tags across site', 'pass', 'minor', true, 'All H1 tags are unique across pages');
    } else {
      addCheck(48, 'No duplicate H1 tags across site', 'warn', 'minor', dupes.length, `${dupes.length} duplicated H1 text(s) found across pages`);
    }
  });

  // ─── CHECK 49: Duplicate content across pages ─────────────────────────
  safeCheck(49, 'No duplicate content across pages', 'major', () => {
    if (!isFirstPage || allPages.length < 2) {
      addCheck(49, 'No duplicate content across pages', 'pass', 'major', true, 'Cross-page check (single page or deferred)');
      return;
    }
    const pageTexts = allPages.map(p => {
      try {
        const $p = cheerio.load(p.html || '');
        $p('script, style, noscript, nav, header, footer').remove();
        return { url: p.url, words: new Set(getWords($p.text())) };
      } catch {
        return { url: p.url, words: new Set() };
      }
    }).filter(p => p.words.size > 20); // Only compare pages with meaningful content

    const duplicatePairs = [];
    for (let i = 0; i < pageTexts.length; i++) {
      for (let j = i + 1; j < pageTexts.length; j++) {
        const a = pageTexts[i].words;
        const b = pageTexts[j].words;
        let overlap = 0;
        for (const word of a) {
          if (b.has(word)) overlap++;
        }
        const smaller = Math.min(a.size, b.size);
        if (smaller > 0 && (overlap / smaller) > 0.8) {
          duplicatePairs.push([pageTexts[i].url, pageTexts[j].url]);
        }
      }
    }
    if (duplicatePairs.length === 0) {
      addCheck(49, 'No duplicate content across pages', 'pass', 'major', true, 'No highly similar pages detected');
    } else {
      addCheck(49, 'No duplicate content across pages', 'fail', 'major', duplicatePairs.length, `${duplicatePairs.length} pair(s) of pages with >80% content overlap`);
    }
  });

  // ─── CHECK 50: Content length > 300 words ─────────────────────────────
  safeCheck(50, 'Content length over 300 words', 'major', () => {
    const wordCount = pageWords.length;
    if (wordCount > 300) {
      addCheck(50, 'Content length over 300 words', 'pass', 'major', wordCount, `Page has ${wordCount} words`);
    } else {
      addCheck(50, 'Content length over 300 words', 'fail', 'major', wordCount, `Page has only ${wordCount} words (recommended: over 300)`);
    }
  });

  // ─── CHECK 51: Text-to-HTML ratio > 25% ───────────────────────────────
  safeCheck(51, 'Text-to-HTML ratio over 25%', 'minor', () => {
    const htmlLength = (pageData.html || '').length;
    const textLength = pageText.length;
    if (htmlLength === 0) {
      addCheck(51, 'Text-to-HTML ratio over 25%', 'warn', 'minor', 0, 'No HTML content to measure');
      return;
    }
    const ratio = Math.round((textLength / htmlLength) * 100);
    if (ratio >= 25) {
      addCheck(51, 'Text-to-HTML ratio over 25%', 'pass', 'minor', ratio, `Text-to-HTML ratio is ${ratio}%`);
    } else {
      addCheck(51, 'Text-to-HTML ratio over 25%', 'warn', 'minor', ratio, `Text-to-HTML ratio is ${ratio}% (recommended: over 25%)`);
    }
  });

  // ─── CHECKS 52-57: Keyword checks ────────────────────────────────────
  safeCheck(52, 'Primary keyword in title', 'minor', () => {
    // Extract top 2-3 word phrases as "keywords"
    const phrases = extractTopPhrases(pageWords, 2, 3);
    const title = $('title').text().trim().toLowerCase();
    if (phrases.length === 0) {
      addCheck(52, 'Primary keyword in title', 'warn', 'minor', null, 'Not enough content to extract keywords');
      return;
    }
    const topPhrase = phrases[0].phrase;
    if (title.includes(topPhrase)) {
      addCheck(52, 'Primary keyword in title', 'pass', 'minor', topPhrase, `Top phrase "${topPhrase}" found in title`);
    } else {
      addCheck(52, 'Primary keyword in title', 'warn', 'minor', topPhrase, `Top phrase "${topPhrase}" not found in title`);
    }
  });

  safeCheck(53, 'Primary keyword in H1', 'minor', () => {
    const phrases = extractTopPhrases(pageWords, 2, 3);
    const h1 = $('h1').first().text().trim().toLowerCase();
    if (phrases.length === 0 || !h1) {
      addCheck(53, 'Primary keyword in H1', 'warn', 'minor', null, 'Not enough content or no H1 to check');
      return;
    }
    const topPhrase = phrases[0].phrase;
    if (h1.includes(topPhrase)) {
      addCheck(53, 'Primary keyword in H1', 'pass', 'minor', topPhrase, `Top phrase "${topPhrase}" found in H1`);
    } else {
      addCheck(53, 'Primary keyword in H1', 'warn', 'minor', topPhrase, `Top phrase "${topPhrase}" not found in H1`);
    }
  });

  safeCheck(54, 'Primary keyword in first paragraph', 'minor', () => {
    const phrases = extractTopPhrases(pageWords, 2, 3);
    const firstP = $('p').first().text().trim().toLowerCase();
    if (phrases.length === 0 || !firstP) {
      addCheck(54, 'Primary keyword in first paragraph', 'warn', 'minor', null, 'Not enough content or no paragraph to check');
      return;
    }
    const topPhrase = phrases[0].phrase;
    if (firstP.includes(topPhrase)) {
      addCheck(54, 'Primary keyword in first paragraph', 'pass', 'minor', topPhrase, `Top phrase "${topPhrase}" found in first paragraph`);
    } else {
      addCheck(54, 'Primary keyword in first paragraph', 'warn', 'minor', topPhrase, `Top phrase "${topPhrase}" not found in first paragraph`);
    }
  });

  safeCheck(55, 'Primary keyword in URL', 'minor', () => {
    const phrases = extractTopPhrases(pageWords, 2, 3);
    if (phrases.length === 0) {
      addCheck(55, 'Primary keyword in URL', 'warn', 'minor', null, 'Not enough content to extract keywords');
      return;
    }
    const topPhrase = phrases[0].phrase;
    const urlLower = url.toLowerCase();
    // Check if words from the phrase appear in the URL (possibly hyphen-separated)
    const phraseWords = topPhrase.split(' ');
    const inUrl = phraseWords.every(w => urlLower.includes(w));
    if (inUrl) {
      addCheck(55, 'Primary keyword in URL', 'pass', 'minor', topPhrase, `Top phrase words "${topPhrase}" found in URL`);
    } else {
      addCheck(55, 'Primary keyword in URL', 'warn', 'minor', topPhrase, `Top phrase "${topPhrase}" not found in URL`);
    }
  });

  safeCheck(56, 'Keyword density under 3%', 'minor', () => {
    const phrases = extractTopPhrases(pageWords, 2, 3);
    if (phrases.length === 0 || pageWords.length === 0) {
      addCheck(56, 'Keyword density under 3%', 'warn', 'minor', null, 'Not enough content for density check');
      return;
    }
    const topPhrase = phrases[0];
    const density = ((topPhrase.count * topPhrase.phrase.split(' ').length) / pageWords.length * 100).toFixed(1);
    if (parseFloat(density) <= 3) {
      addCheck(56, 'Keyword density under 3%', 'pass', 'minor', parseFloat(density), `Top phrase "${topPhrase.phrase}" density is ${density}%`);
    } else {
      addCheck(56, 'Keyword density under 3%', 'warn', 'minor', parseFloat(density), `Top phrase "${topPhrase.phrase}" density is ${density}% (over 3%)`);
    }
  });

  safeCheck(57, 'No keyword stuffing', 'minor', () => {
    const phrases = extractTopPhrases(pageWords, 2, 3);
    if (phrases.length === 0 || pageWords.length === 0) {
      addCheck(57, 'No keyword stuffing', 'warn', 'minor', null, 'Not enough content to check');
      return;
    }
    // Check if any single word repeats at extremely high rate (>5%)
    const wordFreq = {};
    for (const w of pageWords) {
      if (w.length > 3) { // Skip short common words
        wordFreq[w] = (wordFreq[w] || 0) + 1;
      }
    }
    const totalWords = pageWords.length;
    const stuffed = Object.entries(wordFreq)
      .filter(([, count]) => (count / totalWords) > 0.05)
      .map(([word, count]) => ({ word, pct: ((count / totalWords) * 100).toFixed(1) }));
    // Also filter out common stopwords that naturally appear often
    const stopwords = new Set(['that', 'this', 'with', 'from', 'your', 'have', 'will', 'been', 'more', 'when', 'what', 'some', 'them', 'than', 'they', 'were', 'their', 'which', 'about', 'would', 'there', 'could', 'other', 'into', 'just', 'also', 'each', 'does', 'most', 'over']);
    const suspicious = stuffed.filter(s => !stopwords.has(s.word));
    if (suspicious.length === 0) {
      addCheck(57, 'No keyword stuffing', 'pass', 'minor', true, 'No keyword stuffing detected');
    } else {
      addCheck(57, 'No keyword stuffing', 'warn', 'minor', suspicious, `Possible keyword stuffing: ${suspicious.map(s => `"${s.word}" at ${s.pct}%`).join(', ')}`);
    }
  });

  // ─── CHECK 58: Meta robots not blocking indexing ──────────────────────
  safeCheck(58, 'Meta robots not blocking indexing', 'critical', () => {
    const robotsMeta = getMetaContent('robots');
    const googlebotMeta = getMetaContent('googlebot');
    const combined = (robotsMeta + ' ' + googlebotMeta).toLowerCase();
    if (combined.includes('noindex')) {
      addCheck(58, 'Meta robots not blocking indexing', 'fail', 'critical', combined.trim(), 'Page is set to noindex');
    } else {
      addCheck(58, 'Meta robots not blocking indexing', 'pass', 'critical', robotsMeta || 'not set', 'Page is not blocked from indexing via meta robots');
    }
  });

  // ─── CHECK 59: X-Robots-Tag header check ──────────────────────────────
  safeCheck(59, 'X-Robots-Tag header not blocking', 'major', () => {
    const headers = pageData.headers || {};
    const xRobots = headers['x-robots-tag'] || '';
    if (xRobots && xRobots.toLowerCase().includes('noindex')) {
      addCheck(59, 'X-Robots-Tag header not blocking', 'fail', 'major', xRobots, `X-Robots-Tag header contains noindex: "${xRobots}"`);
    } else if (xRobots) {
      addCheck(59, 'X-Robots-Tag header not blocking', 'pass', 'major', xRobots, `X-Robots-Tag: "${xRobots}" (not blocking)`);
    } else {
      addCheck(59, 'X-Robots-Tag header not blocking', 'pass', 'major', null, 'No X-Robots-Tag header present');
    }
  });

  // ─── CHECK 60: Pagination rel=next/prev ───────────────────────────────
  safeCheck(60, 'Pagination rel=next/prev', 'minor', () => {
    const relNext = $('link[rel="next"]').attr('href');
    const relPrev = $('link[rel="prev"]').attr('href');
    // Check if page appears to be paginated (has page numbers in URL or pagination nav)
    const hasPaginationNav = $('nav.pagination, .pagination, [aria-label="pagination"]').length > 0 ||
      $('a[href*="page="], a[href*="/page/"]').length > 0;
    if (relNext || relPrev) {
      addCheck(60, 'Pagination rel=next/prev', 'pass', 'minor', { next: relNext, prev: relPrev }, 'Pagination rel tags found');
    } else if (hasPaginationNav) {
      addCheck(60, 'Pagination rel=next/prev', 'warn', 'minor', false, 'Pagination detected but no rel=next/prev tags found');
    } else {
      addCheck(60, 'Pagination rel=next/prev', 'pass', 'minor', null, 'No pagination detected on this page');
    }
  });

  // ─── CHECK 61: Hreflang tags ──────────────────────────────────────────
  safeCheck(61, 'Hreflang tags for multilingual', 'minor', () => {
    const hreflangs = $('link[rel="alternate"][hreflang]');
    const htmlLang = $('html').attr('lang') || '';
    if (hreflangs.length > 0) {
      const langs = [];
      hreflangs.each((_, el) => langs.push($(el).attr('hreflang')));
      addCheck(61, 'Hreflang tags for multilingual', 'pass', 'minor', langs, `Hreflang tags found for: ${langs.join(', ')}`);
    } else if (htmlLang && htmlLang !== 'en') {
      addCheck(61, 'Hreflang tags for multilingual', 'warn', 'minor', null, `Non-English page (lang="${htmlLang}") but no hreflang tags`);
    } else {
      addCheck(61, 'Hreflang tags for multilingual', 'pass', 'minor', null, 'No hreflang needed (single language detected)');
    }
  });

  // ─── CHECK 62: Language attribute on HTML tag ─────────────────────────
  safeCheck(62, 'Language attribute on HTML tag', 'major', () => {
    const lang = $('html').attr('lang');
    if (lang) {
      addCheck(62, 'Language attribute on HTML tag', 'pass', 'major', lang, `HTML lang attribute: "${lang}"`);
    } else {
      addCheck(62, 'Language attribute on HTML tag', 'fail', 'major', null, 'Missing lang attribute on <html> tag');
    }
  });

  // ─── CHECK 63: Breadcrumb nav present ─────────────────────────────────
  safeCheck(63, 'Breadcrumb navigation present', 'minor', () => {
    const hasBreadcrumb = $('nav[aria-label*="breadcrumb" i], nav.breadcrumb, .breadcrumb, .breadcrumbs, [itemtype*="BreadcrumbList"], ol.breadcrumb').length > 0;
    // Also check JSON-LD for BreadcrumbList
    let hasJsonLdBreadcrumb = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'BreadcrumbList' || (data['@graph'] && data['@graph'].some(g => g['@type'] === 'BreadcrumbList'))) {
          hasJsonLdBreadcrumb = true;
        }
      } catch { /* ignore */ }
    });
    if (hasBreadcrumb || hasJsonLdBreadcrumb) {
      addCheck(63, 'Breadcrumb navigation present', 'pass', 'minor', true, 'Breadcrumb navigation detected');
    } else {
      addCheck(63, 'Breadcrumb navigation present', 'warn', 'minor', false, 'No breadcrumb navigation found');
    }
  });

  // ─── CHECK 64: Redirect chains ≤ 2 hops ──────────────────────────────
  safeCheck(64, 'Redirect chains <= 2 hops', 'major', () => {
    const requests = pageData.networkRequests || [];
    // Look for redirect chains in network requests
    const redirects = requests.filter(r => {
      const status = r.status || r.statusCode || 0;
      return status >= 300 && status < 400;
    });
    if (redirects.length <= 2) {
      addCheck(64, 'Redirect chains <= 2 hops', 'pass', 'major', redirects.length, `${redirects.length} redirect(s) detected (within limit)`);
    } else {
      addCheck(64, 'Redirect chains <= 2 hops', 'fail', 'major', redirects.length, `${redirects.length} redirects detected (exceeds 2-hop limit)`);
    }
  });

  // ─── CHECK 65: No redirect loops ──────────────────────────────────────
  safeCheck(65, 'No redirect loops', 'critical', () => {
    const requests = pageData.networkRequests || [];
    const redirectUrls = [];
    for (const r of requests) {
      const status = r.status || r.statusCode || 0;
      if (status >= 300 && status < 400) {
        const from = r.url || '';
        const to = r.redirectUrl || r.location || r.headers && r.headers.location || '';
        redirectUrls.push({ from, to });
      }
    }
    // Check for loops: if any URL appears more than once as "from"
    const fromUrls = redirectUrls.map(r => r.from);
    const hasDuplicates = fromUrls.some((u, i) => u && fromUrls.indexOf(u) !== i);
    // Also check if final URL redirects back to any earlier URL
    const seen = new Set();
    let hasLoop = false;
    for (const r of redirectUrls) {
      if (seen.has(r.from)) { hasLoop = true; break; }
      seen.add(r.from);
      if (seen.has(r.to)) { hasLoop = true; break; }
    }
    if (hasDuplicates || hasLoop) {
      addCheck(65, 'No redirect loops', 'fail', 'critical', true, 'Redirect loop detected');
    } else {
      addCheck(65, 'No redirect loops', 'pass', 'critical', false, 'No redirect loops detected');
    }
  });

  // ─── CHECK 66: No 302 where 301 intended ─────────────────────────────
  safeCheck(66, 'No 302 redirects where 301 intended', 'minor', () => {
    const requests = pageData.networkRequests || [];
    const temp302s = requests.filter(r => {
      const status = r.status || r.statusCode || 0;
      return status === 302;
    });
    if (temp302s.length === 0) {
      addCheck(66, 'No 302 redirects where 301 intended', 'pass', 'minor', 0, 'No 302 temporary redirects found');
    } else {
      addCheck(66, 'No 302 redirects where 301 intended', 'warn', 'minor', temp302s.length, `${temp302s.length} 302 redirect(s) found - consider using 301 for permanent redirects`);
    }
  });

  // ─── CHECK 67: Clean URL ──────────────────────────────────────────────
  safeCheck(67, 'Clean URL - no tracking params', 'minor', () => {
    try {
      const parsed = new URL(url);
      const params = [...parsed.searchParams.keys()];
      const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'sessionid', 'session_id', 'sid', 'PHPSESSID', 'jsessionid'];
      const found = params.filter(p => trackingParams.includes(p.toLowerCase()));
      if (found.length === 0) {
        addCheck(67, 'Clean URL - no tracking params', 'pass', 'minor', true, 'URL does not contain session IDs or tracking parameters');
      } else {
        addCheck(67, 'Clean URL - no tracking params', 'warn', 'minor', found, `URL contains tracking/session parameters: ${found.join(', ')}`);
      }
    } catch {
      addCheck(67, 'Clean URL - no tracking params', 'warn', 'minor', null, 'Could not parse URL');
    }
  });

  // ─── CHECK 68: No frames/iframes hiding content ──────────────────────
  safeCheck(68, 'No frames/iframes hiding content', 'minor', () => {
    const frames = $('frame');
    const iframes = $('iframe');
    // Filter out known legitimate iframes (videos, maps, widgets)
    const suspiciousIframes = [];
    iframes.each((_, el) => {
      const src = $(el).attr('src') || '';
      const width = parseInt($(el).attr('width') || '0', 10);
      const height = parseInt($(el).attr('height') || '0', 10);
      const style = $(el).attr('style') || '';
      // Hidden iframes or zero-size are suspicious
      if ((width === 0 && height === 0) || style.includes('display:none') || style.includes('display: none') || style.includes('visibility:hidden') || style.includes('visibility: hidden')) {
        suspiciousIframes.push(src || 'unknown source');
      }
    });
    if (frames.length > 0) {
      addCheck(68, 'No frames/iframes hiding content', 'warn', 'minor', frames.length, `${frames.length} <frame> element(s) found - frames are outdated`);
    } else if (suspiciousIframes.length > 0) {
      addCheck(68, 'No frames/iframes hiding content', 'warn', 'minor', suspiciousIframes.length, `${suspiciousIframes.length} hidden/zero-size iframe(s) detected`);
    } else {
      addCheck(68, 'No frames/iframes hiding content', 'pass', 'minor', true, 'No suspicious frames or hidden iframes detected');
    }
  });

  // ─── CHECK 69: No hidden text ─────────────────────────────────────────
  safeCheck(69, 'No hidden text with substantial content', 'minor', () => {
    let hiddenTextCount = 0;
    $('[style]').each((_, el) => {
      const style = ($(el).attr('style') || '').toLowerCase();
      if (style.includes('display:none') || style.includes('display: none') ||
          style.includes('visibility:hidden') || style.includes('visibility: hidden') ||
          style.includes('text-indent:-9999') || style.includes('text-indent: -9999') ||
          style.includes('font-size:0') || style.includes('font-size: 0')) {
        const text = $(el).text().trim();
        if (text.length > 50) { // Only flag if substantial content
          hiddenTextCount++;
        }
      }
    });
    if (hiddenTextCount === 0) {
      addCheck(69, 'No hidden text with substantial content', 'pass', 'minor', true, 'No substantial hidden text detected');
    } else {
      addCheck(69, 'No hidden text with substantial content', 'warn', 'minor', hiddenTextCount, `${hiddenTextCount} element(s) with hidden substantial text detected`);
    }
  });

  // ─── CHECK 70: No cloaking indicators ─────────────────────────────────
  safeCheck(70, 'No cloaking indicators', 'minor', () => {
    // Cloaking detection heuristics: user-agent sniffing in inline scripts, noscript with different content
    const inlineScripts = [];
    $('script:not([src])').each((_, el) => {
      inlineScripts.push($(el).html() || '');
    });
    const scriptContent = inlineScripts.join('\n').toLowerCase();
    const uaSniffing = scriptContent.includes('navigator.useragent') ||
      scriptContent.includes('navigator.appname') ||
      scriptContent.includes('googlebot') ||
      scriptContent.includes('bingbot');
    const noscriptContent = $('noscript').text().trim();
    const bodyTextLen = pageText.length;
    // If noscript has significantly more content than the page, could be cloaking
    const suspiciousNoscript = noscriptContent.length > bodyTextLen * 0.5 && noscriptContent.length > 500;
    if (uaSniffing || suspiciousNoscript) {
      const reasons = [];
      if (uaSniffing) reasons.push('user-agent detection in scripts');
      if (suspiciousNoscript) reasons.push('substantial noscript content');
      addCheck(70, 'No cloaking indicators', 'warn', 'minor', reasons, `Possible cloaking: ${reasons.join(', ')}`);
    } else {
      addCheck(70, 'No cloaking indicators', 'pass', 'minor', true, 'No cloaking indicators detected');
    }
  });

  // ─── CHECK 71: Favicon present ────────────────────────────────────────
  safeCheck(71, 'Favicon present', 'minor', () => {
    const favicon = $('link[rel="icon"], link[rel="shortcut icon"], link[rel="shortcut"]');
    if (favicon.length > 0) {
      addCheck(71, 'Favicon present', 'pass', 'minor', favicon.first().attr('href'), 'Favicon link tag found');
    } else {
      addCheck(71, 'Favicon present', 'warn', 'minor', null, 'No favicon link tag found (may still have /favicon.ico)');
    }
  });

  // ─── CHECK 72: Apple touch icon ───────────────────────────────────────
  safeCheck(72, 'Apple touch icon present', 'minor', () => {
    const touchIcon = $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]');
    if (touchIcon.length > 0) {
      addCheck(72, 'Apple touch icon present', 'pass', 'minor', touchIcon.first().attr('href'), 'Apple touch icon found');
    } else {
      addCheck(72, 'Apple touch icon present', 'warn', 'minor', null, 'No Apple touch icon found');
    }
  });

  // ─── CHECK 73: RSS/Atom feed ──────────────────────────────────────────
  safeCheck(73, 'RSS/Atom feed available', 'minor', () => {
    const rss = $('link[type="application/rss+xml"], link[type="application/atom+xml"]');
    if (rss.length > 0) {
      const feeds = [];
      rss.each((_, el) => feeds.push($(el).attr('href')));
      addCheck(73, 'RSS/Atom feed available', 'pass', 'minor', feeds, `Feed(s) found: ${feeds.join(', ')}`);
    } else {
      addCheck(73, 'RSS/Atom feed available', 'warn', 'minor', null, 'No RSS/Atom feed link found');
    }
  });

  // ─── CHECK 74: AMP version available ──────────────────────────────────
  safeCheck(74, 'AMP version available', 'minor', () => {
    const ampLink = $('link[rel="amphtml"]');
    const isAmp = $('html[amp], html[⚡]').length > 0;
    if (ampLink.length > 0) {
      addCheck(74, 'AMP version available', 'pass', 'minor', ampLink.attr('href'), `AMP version linked: ${ampLink.attr('href')}`);
    } else if (isAmp) {
      addCheck(74, 'AMP version available', 'pass', 'minor', true, 'This page is an AMP page');
    } else {
      addCheck(74, 'AMP version available', 'warn', 'minor', null, 'No AMP version detected (optional, not required)');
    }
  });

  // ─── CHECK 75: Social sharing links ───────────────────────────────────
  safeCheck(75, 'Social sharing links present', 'minor', () => {
    const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'threads.net'];
    const socialLinks = [];
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').toLowerCase();
      for (const domain of socialDomains) {
        if (href.includes(domain)) {
          socialLinks.push(domain);
          break;
        }
      }
    });
    // Also check for share buttons/widgets
    const shareWidgets = $('[class*="share"], [class*="social"], [id*="share"], [id*="social"], .addthis, .sharethis').length;
    const unique = [...new Set(socialLinks)];
    if (unique.length > 0 || shareWidgets > 0) {
      addCheck(75, 'Social sharing links present', 'pass', 'minor', unique.length || shareWidgets, `Social presence detected: ${unique.length > 0 ? unique.join(', ') : `${shareWidgets} share widget(s)`}`);
    } else {
      addCheck(75, 'Social sharing links present', 'warn', 'minor', null, 'No social sharing links or widgets detected');
    }
  });

  // ─── CHECK 76: Author meta tag or structured data ─────────────────────
  safeCheck(76, 'Author information present', 'minor', () => {
    const authorMeta = getMetaContent('author');
    let authorInSchema = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const check = (obj) => {
          if (!obj) return;
          if (obj.author) { authorInSchema = true; return; }
          if (obj['@graph'] && Array.isArray(obj['@graph'])) obj['@graph'].forEach(check);
        };
        check(data);
      } catch { /* ignore */ }
    });
    const authorByline = $('[class*="author"], [rel="author"], .byline, [itemprop="author"]').length > 0;
    if (authorMeta) {
      addCheck(76, 'Author information present', 'pass', 'minor', authorMeta, `Author meta tag: "${authorMeta}"`);
    } else if (authorInSchema) {
      addCheck(76, 'Author information present', 'pass', 'minor', true, 'Author found in structured data');
    } else if (authorByline) {
      addCheck(76, 'Author information present', 'pass', 'minor', true, 'Author byline detected in HTML');
    } else {
      addCheck(76, 'Author information present', 'warn', 'minor', null, 'No author information found');
    }
  });

  // ─── CHECK 77: Date published in structured data ──────────────────────
  safeCheck(77, 'Date published in structured data', 'minor', () => {
    let hasDatePublished = false;
    let dateValue = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const check = (obj) => {
          if (!obj) return;
          if (obj.datePublished) { hasDatePublished = true; dateValue = obj.datePublished; return; }
          if (obj.dateCreated) { hasDatePublished = true; dateValue = obj.dateCreated; return; }
          if (obj['@graph'] && Array.isArray(obj['@graph'])) obj['@graph'].forEach(check);
        };
        check(data);
      } catch { /* ignore */ }
    });
    const timePub = $('time[datetime], [itemprop="datePublished"]');
    if (hasDatePublished) {
      addCheck(77, 'Date published in structured data', 'pass', 'minor', dateValue, `Date published found: ${dateValue}`);
    } else if (timePub.length > 0) {
      addCheck(77, 'Date published in structured data', 'pass', 'minor', timePub.first().attr('datetime'), 'Date published found in HTML time element');
    } else {
      addCheck(77, 'Date published in structured data', 'warn', 'minor', null, 'No date published information found');
    }
  });

  // ─── CHECK 78: Nofollow on external links ─────────────────────────────
  safeCheck(78, 'External links use nofollow appropriately', 'minor', () => {
    let externalCount = 0;
    let nofollowCount = 0;
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.startsWith('http') && !isInternal(href)) {
        externalCount++;
        const rel = ($(el).attr('rel') || '').toLowerCase();
        if (rel.includes('nofollow') || rel.includes('ugc') || rel.includes('sponsored')) {
          nofollowCount++;
        }
      }
    });
    if (externalCount === 0) {
      addCheck(78, 'External links use nofollow appropriately', 'pass', 'minor', null, 'No external links found');
    } else if (nofollowCount > 0) {
      addCheck(78, 'External links use nofollow appropriately', 'pass', 'minor', { external: externalCount, nofollow: nofollowCount }, `${nofollowCount} of ${externalCount} external link(s) have nofollow/ugc/sponsored`);
    } else {
      addCheck(78, 'External links use nofollow appropriately', 'warn', 'minor', externalCount, `${externalCount} external link(s) without nofollow - consider adding rel="nofollow" to untrusted links`);
    }
  });

  // ─── CHECK 79: Image sitemap or images in sitemap ─────────────────────
  safeCheck(79, 'Image sitemap or images in sitemap', 'minor', () => {
    if (!siteData || !siteData.robotsTxt) {
      addCheck(79, 'Image sitemap or images in sitemap', 'warn', 'minor', null, 'No sitemap data available');
      return;
    }
    const content = (siteData.robotsTxt.content || '').toLowerCase();
    const hasImageSitemap = content.includes('image-sitemap') || content.includes('sitemap-image');
    // Check if sitemapUrls contain image-related entries
    const sitemapUrls = siteData.sitemapUrls || [];
    const imageInSitemap = sitemapUrls.some(u => /image/i.test(u));
    if (hasImageSitemap || imageInSitemap) {
      addCheck(79, 'Image sitemap or images in sitemap', 'pass', 'minor', true, 'Image sitemap or images in sitemap detected');
    } else {
      const imageCount = $('img').length;
      if (imageCount > 5) {
        addCheck(79, 'Image sitemap or images in sitemap', 'warn', 'minor', false, `Page has ${imageCount} images but no image sitemap detected`);
      } else {
        addCheck(79, 'Image sitemap or images in sitemap', 'pass', 'minor', null, 'Few images on page, image sitemap not critical');
      }
    }
  });

  // ─── CHECK 80: Video sitemap if videos present ────────────────────────
  safeCheck(80, 'Video sitemap if videos present', 'minor', () => {
    const videos = $('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="dailymotion"], iframe[src*="wistia"], embed[src*="video"]');
    if (videos.length === 0) {
      addCheck(80, 'Video sitemap if videos present', 'pass', 'minor', null, 'No videos detected on page');
      return;
    }
    // Check if there's a video sitemap reference
    const content = (siteData && siteData.robotsTxt && siteData.robotsTxt.content || '').toLowerCase();
    const hasVideoSitemap = content.includes('video-sitemap') || content.includes('sitemap-video');
    const sitemapUrls = (siteData && siteData.sitemapUrls) || [];
    const videoInSitemap = sitemapUrls.some(u => /video/i.test(u));
    // Check for VideoObject in structured data
    let hasVideoSchema = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const check = (obj) => {
          if (!obj) return;
          if (obj['@type'] === 'VideoObject') { hasVideoSchema = true; return; }
          if (obj['@graph'] && Array.isArray(obj['@graph'])) obj['@graph'].forEach(check);
        };
        check(data);
      } catch { /* ignore */ }
    });
    if (hasVideoSitemap || videoInSitemap || hasVideoSchema) {
      addCheck(80, 'Video sitemap if videos present', 'pass', 'minor', true, `${videos.length} video(s) found with video sitemap/schema`);
    } else {
      addCheck(80, 'Video sitemap if videos present', 'warn', 'minor', videos.length, `${videos.length} video(s) found but no video sitemap or VideoObject schema detected`);
    }
  });

  return { checks };
}

// ─── Helper: Extract top N-gram phrases ───────────────────────────────────

/**
 * Extract the most frequent 2-3 word phrases from a list of words.
 * Filters out stopword-only phrases and returns top results.
 */
function extractTopPhrases(words, minN, maxN) {
  const stopwords = new Set([
    'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
    'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
    'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
    'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their',
    'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go',
    'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him',
    'know', 'take', 'people', 'into', 'year', 'your', 'some', 'could',
    'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come',
    'its', 'over', 'also', 'our', 'are', 'is', 'was', 'has', 'been', 'more',
    'how', 'had', 'each', 'does', 'most', 'may', 'these', 'very', 'any',
  ]);

  const phraseCounts = {};
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      const slice = words.slice(i, i + n);
      // Skip if all words are stopwords
      if (slice.every(w => stopwords.has(w))) continue;
      // Skip if any word is very short (1 char)
      if (slice.some(w => w.length < 2)) continue;
      const phrase = slice.join(' ');
      phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
    }
  }

  return Object.entries(phraseCounts)
    .filter(([, count]) => count >= 2) // Must appear at least twice
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase, count]) => ({ phrase, count }));
}

module.exports = { analyzeSEO };
