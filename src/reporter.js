'use strict';

/**
 * HTML Report Generator
 * Generates a self-contained, professional HTML report from analysis results.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return isoString || 'Unknown';
  }
}

function formatDuration(ms) {
  if (!ms) return 'N/A';
  if (ms < 1000) return `${ms}ms`;
  const secs = (ms / 1000).toFixed(1);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(ms / 60000);
  const remSecs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${remSecs}s`;
}

function severityOrder(sev) {
  return { critical: 0, major: 1, minor: 2 }[sev] || 3;
}

function severityColor(sev) {
  return { critical: '#ef4444', major: '#f97316', minor: '#eab308' }[sev] || '#94a3b8';
}

function severityBg(sev) {
  return { critical: '#fef2f2', major: '#fff7ed', minor: '#fefce8' }[sev] || '#f8fafc';
}

function statusIcon(status) {
  if (status === 'pass') return '<span class="icon-pass">&#x2713;</span>';
  if (status === 'fail') return '<span class="icon-fail">&#x2717;</span>';
  if (status === 'warn') return '<span class="icon-warn">&#x26A0;</span>';
  return '<span class="icon-info">&#x2139;</span>';
}

function truncateStr(str, max) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

// Recommendations map keyed by check id prefix or name patterns
function getRecommendation(check) {
  const id = (check.id || '').toLowerCase();
  const name = (check.name || '').toLowerCase();
  const details = (check.details || '').toLowerCase();

  // Performance
  if (id.includes('ttfb') || name.includes('time to first byte')) return 'Optimize server response time. Consider upgrading hosting, enabling server-side caching, or using a CDN.';
  if (id.includes('page-size') || name.includes('page size') || name.includes('page weight')) return 'Reduce total page size by compressing images, minifying CSS/JS, and removing unused code.';
  if (id.includes('image') && (name.includes('optim') || name.includes('compress'))) return 'Compress images using WebP/AVIF format and implement lazy loading for below-the-fold images.';
  if (id.includes('minif') || name.includes('minif')) return 'Minify CSS and JavaScript files to reduce transfer size. Use build tools like Terser or CSSNano.';
  if (id.includes('cache') || name.includes('cache')) return 'Implement proper cache headers (Cache-Control, ETag) for static assets with long expiry times.';
  if (id.includes('render-block') || name.includes('render-block')) return 'Defer non-critical CSS/JS and use async loading to prevent render-blocking resources.';
  if (id.includes('lazy') || name.includes('lazy')) return 'Implement lazy loading for images and iframes below the fold using loading="lazy" attribute.';
  if (id.includes('compress') || name.includes('gzip') || name.includes('compress')) return 'Enable GZIP or Brotli compression on the server for text-based resources.';

  // SEO
  if (id.includes('title') || name.includes('title tag')) return 'Add a unique, descriptive title tag (50-60 characters) that includes your primary keyword.';
  if (id.includes('meta-desc') || name.includes('meta description')) return 'Write a compelling meta description (150-160 characters) that accurately summarizes page content.';
  if (id.includes('h1') || name.includes('h1')) return 'Ensure each page has exactly one H1 tag that clearly describes the page topic.';
  if (id.includes('heading') || name.includes('heading')) return 'Use a proper heading hierarchy (H1 > H2 > H3) throughout the page for better structure.';
  if (id.includes('canonical') || name.includes('canonical')) return 'Add a canonical URL tag to prevent duplicate content issues.';
  if (id.includes('sitemap') || name.includes('sitemap')) return 'Create and submit an XML sitemap to help search engines discover and index all pages.';
  if (id.includes('robots') || name.includes('robots')) return 'Review your robots.txt file to ensure it is not blocking important pages from being crawled.';
  if (id.includes('alt') || name.includes('alt text') || name.includes('image alt')) return 'Add descriptive alt text to all images for SEO and accessibility benefits.';
  if (id.includes('structured') || name.includes('schema') || name.includes('structured data')) return 'Add structured data markup (JSON-LD) to help search engines understand your content.';
  if (id.includes('open-graph') || name.includes('og:') || name.includes('open graph')) return 'Add Open Graph meta tags for better social media sharing previews.';

  // Accessibility
  if (id.includes('contrast') || name.includes('contrast')) return 'Increase color contrast ratio to meet WCAG AA standards (minimum 4.5:1 for normal text).';
  if (id.includes('aria') || name.includes('aria')) return 'Add proper ARIA labels and roles to interactive elements for screen reader compatibility.';
  if (id.includes('focus') || name.includes('focus')) return 'Ensure all interactive elements have visible focus indicators for keyboard navigation.';
  if (id.includes('lang') || name.includes('language') || name.includes('lang attr')) return 'Add a lang attribute to the HTML element to declare the page language.';
  if (id.includes('label') || name.includes('form label') || name.includes('input label')) return 'Associate all form inputs with descriptive labels using the <label> element or aria-label.';
  if (id.includes('skip') || name.includes('skip link') || name.includes('skip nav')) return 'Add a "Skip to main content" link for keyboard users to bypass navigation.';

  // Security
  if (id.includes('https') || name.includes('https') || name.includes('ssl')) return 'Enable HTTPS across the entire site and redirect all HTTP requests to HTTPS.';
  if (id.includes('hsts') || name.includes('strict-transport')) return 'Add the Strict-Transport-Security header to enforce HTTPS connections.';
  if (id.includes('csp') || name.includes('content-security-policy') || name.includes('content security')) return 'Implement a Content Security Policy header to prevent XSS and data injection attacks.';
  if (id.includes('x-frame') || name.includes('x-frame') || name.includes('clickjack')) return 'Add the X-Frame-Options header (DENY or SAMEORIGIN) to prevent clickjacking.';
  if (id.includes('x-content-type') || name.includes('content-type-options') || name.includes('mime sniff')) return 'Add X-Content-Type-Options: nosniff header to prevent MIME type sniffing.';
  if (id.includes('mixed-content') || name.includes('mixed content')) return 'Fix mixed content issues by ensuring all resources are loaded over HTTPS.';

  // Mobile
  if (id.includes('viewport') || name.includes('viewport')) return 'Add a proper viewport meta tag: <meta name="viewport" content="width=device-width, initial-scale=1">.';
  if (id.includes('responsive') || name.includes('responsive')) return 'Use responsive design techniques (media queries, flexible grids) to ensure content adapts to all screen sizes.';
  if (id.includes('tap') || name.includes('touch') || name.includes('tap target')) return 'Increase touch target sizes to at least 48x48px with adequate spacing between interactive elements.';
  if (id.includes('font-size') || name.includes('font size') || name.includes('readable')) return 'Use a minimum font size of 16px for body text to ensure readability on mobile devices.';

  // Links
  if (id.includes('broken') || name.includes('broken')) return 'Fix or remove broken links that return 4xx/5xx status codes.';
  if (id.includes('redirect') || name.includes('redirect chain')) return 'Fix redirect chains by updating links to point directly to the final destination URL.';
  if (id.includes('orphan') || name.includes('orphan')) return 'Add internal links to orphan pages so they are discoverable by users and search engines.';
  if (id.includes('nofollow') || name.includes('nofollow')) return 'Review internal nofollow links; internal links should generally pass link equity.';

  // Content
  if (id.includes('thin') || name.includes('thin content') || name.includes('word count')) return 'Add more substantive content (aim for 300+ words per page) to provide value to visitors.';
  if (id.includes('duplicate') || name.includes('duplicate')) return 'Resolve duplicate content by using canonical tags, 301 redirects, or rewriting content.';
  if (id.includes('readab') || name.includes('readab')) return 'Improve readability by using shorter sentences, simpler words, and clear paragraph structure.';
  if (id.includes('spell') || name.includes('spell')) return 'Review and fix spelling errors to maintain professional credibility.';

  // Technical
  if (id.includes('html-valid') || name.includes('html valid')) return 'Fix HTML validation errors to ensure proper rendering across all browsers.';
  if (id.includes('doctype') || name.includes('doctype')) return 'Add a proper <!DOCTYPE html> declaration at the top of each page.';
  if (id.includes('charset') || name.includes('charset') || name.includes('encoding')) return 'Declare character encoding using <meta charset="UTF-8"> in the <head> section.';
  if (id.includes('favicon') || name.includes('favicon')) return 'Add a favicon to improve brand recognition in browser tabs and bookmarks.';
  if (id.includes('404') || name.includes('404') || name.includes('error page')) return 'Create a custom 404 error page that helps users navigate back to useful content.';
  if (id.includes('console-error') || name.includes('console error') || name.includes('javascript error')) return 'Fix JavaScript console errors that may affect functionality and user experience.';

  // Infrastructure
  if (id.includes('cdn') || name.includes('cdn')) return 'Use a Content Delivery Network (CDN) to serve assets from locations closer to your users.';
  if (id.includes('dns') || name.includes('dns')) return 'Optimize DNS resolution by reducing lookups and using DNS prefetch for third-party domains.';
  if (id.includes('http2') || name.includes('http/2') || name.includes('http2')) return 'Upgrade to HTTP/2 for improved performance with multiplexing and header compression.';
  if (id.includes('server') || name.includes('server')) return 'Review server configuration for optimal performance and security settings.';

  // UX
  if (id.includes('cls') || name.includes('layout shift') || name.includes('cumulative layout')) return 'Prevent layout shifts by setting explicit dimensions on images/ads and avoiding dynamic content injection.';
  if (id.includes('lcp') || name.includes('largest contentful')) return 'Optimize the largest contentful paint by preloading key resources and optimizing images.';
  if (id.includes('fid') || name.includes('first input') || name.includes('interaction')) return 'Reduce JavaScript execution time to improve input responsiveness.';

  // Generic fallback based on severity
  if (check.severity === 'critical') return 'This is a critical issue that should be prioritized for immediate resolution.';
  if (check.severity === 'major') return 'Address this issue in your next sprint to improve overall site quality.';
  return 'Consider fixing this issue to improve your overall website score.';
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function getCSS() {
  return `
    :root {
      --navy: #1e293b;
      --navy-light: #334155;
      --white: #ffffff;
      --gray-50: #f8fafc;
      --gray-100: #f1f5f9;
      --gray-200: #e2e8f0;
      --gray-300: #cbd5e1;
      --gray-400: #94a3b8;
      --gray-500: #64748b;
      --gray-600: #475569;
      --gray-700: #334155;
      --gray-800: #1e293b;
      --gray-900: #0f172a;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --orange: #f97316;
      --blue: #3b82f6;
      --font-stack: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
      --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);
      --radius: 8px;
    }

    *, *::before, *::after { box-sizing: border-box; }

    body {
      font-family: var(--font-stack);
      color: var(--gray-800);
      background: var(--gray-50);
      margin: 0;
      padding: 0;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* ---- Header ---- */
    .report-header {
      background: linear-gradient(135deg, var(--navy) 0%, #0f172a 100%);
      color: var(--white);
      padding: 48px 24px 56px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .report-header::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at 30% 50%, rgba(59,130,246,0.08) 0%, transparent 50%),
                  radial-gradient(circle at 70% 80%, rgba(139,92,246,0.06) 0%, transparent 50%);
      pointer-events: none;
    }
    .report-header .inner {
      position: relative;
      max-width: 900px;
      margin: 0 auto;
    }
    .report-header h1 {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 4px;
      letter-spacing: -0.02em;
    }
    .report-header .subtitle {
      font-size: 16px;
      color: var(--gray-400);
      margin: 0 0 36px;
    }
    .report-header .meta-row {
      display: flex;
      justify-content: center;
      gap: 32px;
      flex-wrap: wrap;
      margin-top: 28px;
      font-size: 14px;
      color: var(--gray-400);
    }
    .report-header .meta-row span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    /* ---- Score Circle ---- */
    .score-circle-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .score-circle {
      position: relative;
      width: 180px;
      height: 180px;
    }
    .score-circle svg {
      transform: rotate(-90deg);
      width: 180px;
      height: 180px;
    }
    .score-circle .bg {
      fill: none;
      stroke: rgba(255,255,255,0.1);
      stroke-width: 10;
    }
    .score-circle .progress {
      fill: none;
      stroke-width: 10;
      stroke-linecap: round;
      transition: stroke-dasharray 1s ease-out;
    }
    .score-circle .score-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }
    .score-circle .score-number {
      font-size: 52px;
      font-weight: 800;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .score-circle .score-max {
      font-size: 16px;
      color: var(--gray-400);
      font-weight: 400;
    }
    .grade-badge {
      display: inline-block;
      padding: 6px 20px;
      border-radius: 20px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    /* ---- Container ---- */
    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* ---- Sections ---- */
    .section {
      margin: 40px 0;
    }
    .section-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--gray-900);
      margin: 0 0 8px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--gray-200);
      letter-spacing: -0.01em;
    }

    /* ---- Card ---- */
    .card {
      background: var(--white);
      border-radius: var(--radius);
      box-shadow: var(--shadow-md);
      padding: 28px 32px;
      margin: 20px 0;
    }

    /* ---- Executive Summary ---- */
    .exec-summary p {
      font-size: 15px;
      line-height: 1.75;
      color: var(--gray-700);
      margin: 0 0 14px;
    }
    .exec-summary p:last-child { margin-bottom: 0; }

    /* ---- Category Breakdown ---- */
    .cat-grid {
      display: grid;
      gap: 16px;
    }
    .cat-row {
      display: grid;
      grid-template-columns: 180px 1fr 64px 140px;
      align-items: center;
      gap: 16px;
      padding: 14px 0;
      border-bottom: 1px solid var(--gray-100);
    }
    .cat-row:last-child { border-bottom: none; }
    .cat-label {
      font-weight: 600;
      font-size: 14px;
      color: var(--gray-800);
    }
    .cat-bar-wrap {
      background: var(--gray-100);
      border-radius: 6px;
      height: 28px;
      position: relative;
      overflow: hidden;
    }
    .cat-bar {
      height: 100%;
      border-radius: 6px;
      transition: width 0.6s ease-out;
      min-width: 2px;
    }
    .cat-score {
      font-size: 18px;
      font-weight: 700;
      text-align: right;
    }
    .cat-stats {
      display: flex;
      gap: 10px;
      font-size: 12px;
      color: var(--gray-500);
      justify-content: flex-end;
    }
    .cat-stats .stat-pass { color: var(--green); }
    .cat-stats .stat-fail { color: var(--red); }
    .cat-stats .stat-warn { color: var(--yellow); }
    .cat-weight {
      font-size: 11px;
      color: var(--gray-400);
      font-weight: 400;
    }

    /* ---- Issues Table ---- */
    .issues-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 14px;
    }
    .issues-table th {
      background: var(--gray-50);
      padding: 10px 14px;
      text-align: left;
      font-weight: 600;
      color: var(--gray-600);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 2px solid var(--gray-200);
    }
    .issues-table td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--gray-100);
      vertical-align: top;
    }
    .issues-table tr:last-child td { border-bottom: none; }
    .issues-table tr:hover td { background: var(--gray-50); }
    .sev-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .issues-more {
      text-align: center;
      padding: 14px;
      color: var(--gray-500);
      font-size: 14px;
      font-style: italic;
    }

    /* ---- Collapsible Details ---- */
    .collapse-section {
      border: 1px solid var(--gray-200);
      border-radius: var(--radius);
      margin: 12px 0;
      overflow: hidden;
    }
    .collapse-section summary {
      padding: 16px 20px;
      cursor: pointer;
      font-weight: 600;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--white);
      user-select: none;
      list-style: none;
      transition: background 0.15s;
    }
    .collapse-section summary::-webkit-details-marker { display: none; }
    .collapse-section summary::before {
      content: '\\25B6';
      font-size: 10px;
      transition: transform 0.2s;
      color: var(--gray-400);
      flex-shrink: 0;
    }
    .collapse-section[open] summary::before {
      transform: rotate(90deg);
    }
    .collapse-section summary:hover { background: var(--gray-50); }
    .collapse-section .collapse-body {
      padding: 0 20px 16px;
      background: var(--white);
    }

    /* Category detail header in summary */
    .cat-detail-header {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
    }
    .cat-detail-header .cat-d-name { flex: 1; }
    .cat-detail-header .cat-d-grade {
      font-size: 13px;
      padding: 2px 10px;
      border-radius: 12px;
      font-weight: 700;
    }
    .cat-detail-header .cat-d-score {
      font-size: 14px;
      font-weight: 700;
      color: var(--gray-600);
      min-width: 50px;
      text-align: right;
    }

    /* Check list inside category detail */
    .check-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .check-item {
      display: grid;
      grid-template-columns: 26px 1fr;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--gray-50);
      font-size: 14px;
      align-items: start;
    }
    .check-item:last-child { border-bottom: none; }
    .check-name { font-weight: 500; color: var(--gray-800); }
    .check-details {
      font-size: 13px;
      color: var(--gray-500);
      margin-top: 2px;
      word-break: break-word;
    }
    .check-sev-tag {
      display: inline-block;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
      text-transform: uppercase;
      margin-left: 6px;
      vertical-align: middle;
    }

    /* ---- Status Icons ---- */
    .icon-pass { color: var(--green); font-weight: 700; font-size: 15px; }
    .icon-fail { color: var(--red); font-weight: 700; font-size: 15px; }
    .icon-warn { color: var(--yellow); font-size: 14px; }
    .icon-info { color: var(--blue); font-size: 14px; }

    /* ---- Page Results ---- */
    .page-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .page-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--gray-50);
      font-size: 13px;
    }
    .page-item:last-child { border-bottom: none; }
    .page-status {
      display: inline-block;
      min-width: 42px;
      text-align: center;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
    }
    .page-url {
      color: var(--blue);
      text-decoration: none;
      word-break: break-all;
    }

    /* ---- Recommendations ---- */
    .rec-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .rec-item {
      padding: 14px 0;
      border-bottom: 1px solid var(--gray-100);
      display: grid;
      grid-template-columns: 26px 1fr;
      gap: 10px;
      align-items: start;
    }
    .rec-item:last-child { border-bottom: none; }
    .rec-num {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--white);
      flex-shrink: 0;
    }
    .rec-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--gray-800);
    }
    .rec-cat {
      font-size: 11px;
      color: var(--gray-400);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .rec-text {
      font-size: 14px;
      color: var(--gray-600);
      margin-top: 4px;
      line-height: 1.6;
    }

    /* ---- Footer ---- */
    .report-footer {
      text-align: center;
      padding: 36px 24px;
      color: var(--gray-400);
      font-size: 13px;
      border-top: 1px solid var(--gray-200);
      margin-top: 48px;
    }
    .report-footer strong { color: var(--gray-600); }

    /* ---- Responsive ---- */
    @media (max-width: 768px) {
      .report-header { padding: 32px 16px 40px; }
      .report-header h1 { font-size: 24px; }
      .report-header .meta-row { gap: 16px; font-size: 12px; }
      .container { padding: 0 16px; }
      .card { padding: 20px; }
      .cat-row {
        grid-template-columns: 1fr;
        gap: 6px;
        padding: 12px 0;
      }
      .cat-stats { justify-content: flex-start; }
      .cat-score { text-align: left; }
      .issues-table { font-size: 12px; }
      .issues-table td, .issues-table th { padding: 8px 10px; }
      .score-circle { width: 140px; height: 140px; }
      .score-circle svg { width: 140px; height: 140px; }
      .score-circle .score-number { font-size: 40px; }
      .cat-detail-header { flex-wrap: wrap; }
      .rec-item { grid-template-columns: 1fr; }
      .rec-num { margin-bottom: 4px; }
    }

    /* ---- Print ---- */
    @media print {
      body { background: white; }
      .report-header { background: var(--navy) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .collapse-section[open] summary::before,
      .collapse-section summary::before { display: none; }
      .collapse-section { border: 1px solid #ddd; }
      .collapse-section:not([open]) > .collapse-body { display: block !important; }
      details { open: true; }
      details > summary { pointer-events: none; }
      details > .collapse-body { display: block !important; }
      .card { box-shadow: none; border: 1px solid #ddd; }
      .cat-bar-wrap, .cat-bar { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .sev-badge, .grade-badge, .page-status, .rec-num { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;
}

// ---------------------------------------------------------------------------
// Inline JS (for collapsible expand/collapse all + print force-open)
// ---------------------------------------------------------------------------

function getJS() {
  return `
    // Force all details open when printing
    window.addEventListener('beforeprint', function() {
      document.querySelectorAll('details').forEach(function(d) { d.setAttribute('open', ''); });
    });

    // Expand/collapse all toggle
    function toggleAllDetails(btn) {
      var details = document.querySelectorAll('.collapse-section');
      var allOpen = true;
      details.forEach(function(d) { if (!d.open) allOpen = false; });
      details.forEach(function(d) { d.open = !allOpen; });
      btn.textContent = allOpen ? 'Expand All' : 'Collapse All';
    }
  `;
}

// ---------------------------------------------------------------------------
// HTML Section Builders
// ---------------------------------------------------------------------------

function buildHeader(scoreResult, crawlData, options) {
  const { score, grade, gradeLabel, gradeColor } = scoreResult;
  const domain = crawlData.domain || '';
  const analyzedAt = options.analyzedAt || new Date().toISOString();
  const pageCount = (crawlData.pages || []).length;
  const crawlTime = crawlData.crawlTime || 0;
  const circumference = 2 * Math.PI * 76; // radius 76
  const dasharray = (score / 100) * circumference;
  const gap = circumference - dasharray;

  return `
  <header class="report-header">
    <div class="inner">
      <h1>Website Analysis Report</h1>
      <p class="subtitle">${escapeHtml(domain)}</p>
      <div class="score-circle-wrap">
        <div class="score-circle">
          <svg viewBox="0 0 180 180">
            <circle class="bg" cx="90" cy="90" r="76" />
            <circle class="progress" cx="90" cy="90" r="76"
                    stroke="${escapeHtml(gradeColor)}"
                    stroke-dasharray="${dasharray.toFixed(2)} ${gap.toFixed(2)}" />
          </svg>
          <div class="score-text">
            <div class="score-number" style="color:${escapeHtml(gradeColor)}">${score}</div>
            <div class="score-max">/ 100</div>
          </div>
        </div>
        <span class="grade-badge" style="background:${escapeHtml(gradeColor)};color:#fff">${escapeHtml(grade)} &mdash; ${escapeHtml(gradeLabel)}</span>
      </div>
      <div class="meta-row">
        <span>${escapeHtml(formatDate(analyzedAt))}</span>
        <span>${pageCount} page${pageCount !== 1 ? 's' : ''} analyzed</span>
        <span>Crawl time: ${escapeHtml(formatDuration(crawlTime))}</span>
      </div>
    </div>
  </header>`;
}

function buildExecutiveSummary(executiveSummary) {
  if (!executiveSummary) return '';
  return `
  <div class="section">
    <h2 class="section-title">Executive Summary</h2>
    <div class="card exec-summary">
      <p>${escapeHtml(executiveSummary.para1)}</p>
      <p>${escapeHtml(executiveSummary.para2)}</p>
      <p>${escapeHtml(executiveSummary.para3)}</p>
    </div>
  </div>`;
}

function buildCategoryBreakdown(breakdown) {
  if (!breakdown) return '';

  // Sort by weight descending
  const categories = Object.entries(breakdown)
    .sort((a, b) => (b[1].weight || 0) - (a[1].weight || 0));

  let rows = '';
  for (const [key, cat] of categories) {
    const barWidth = Math.max(1, Math.min(100, Math.round(cat.score)));
    const weightPct = Math.round((cat.weight || 0) * 100);
    rows += `
      <div class="cat-row">
        <div>
          <div class="cat-label">${escapeHtml(cat.label || key)}</div>
          <div class="cat-weight">${weightPct}% weight</div>
        </div>
        <div class="cat-bar-wrap">
          <div class="cat-bar" style="width:${barWidth}%;background:${escapeHtml(cat.gradeColor)}"></div>
        </div>
        <div class="cat-score" style="color:${escapeHtml(cat.gradeColor)}">${cat.score}</div>
        <div class="cat-stats">
          <span class="stat-pass">&#x2713; ${cat.passed}</span>
          <span class="stat-fail">&#x2717; ${cat.failed}</span>
          <span class="stat-warn">&#x26A0; ${cat.warned}</span>
        </div>
      </div>`;
  }

  return `
  <div class="section">
    <h2 class="section-title">Category Breakdown</h2>
    <div class="card">
      <div class="cat-grid">
        ${rows}
      </div>
    </div>
  </div>`;
}

function buildTopIssues(topIssues) {
  if (!topIssues || topIssues.length === 0) {
    return `
    <div class="section">
      <h2 class="section-title">Top Issues</h2>
      <div class="card">
        <p style="color:var(--green);font-weight:600">No issues found &mdash; excellent work!</p>
      </div>
    </div>`;
  }

  const maxShown = 50;
  const shown = topIssues.slice(0, maxShown);
  const remaining = topIssues.length - maxShown;

  let tableRows = '';
  for (const issue of shown) {
    const sColor = severityColor(issue.severity);
    const sBg = severityBg(issue.severity);
    const catLabel = escapeHtml(issue.category || '');
    tableRows += `
      <tr>
        <td><span class="sev-badge" style="background:${sBg};color:${sColor}">${escapeHtml(issue.severity)}</span></td>
        <td class="check-name">${escapeHtml(issue.name)}</td>
        <td style="color:var(--gray-500);font-size:12px">${catLabel}</td>
        <td style="font-size:13px;color:var(--gray-600)">${escapeHtml(truncateStr(issue.details, 200))}</td>
      </tr>`;
  }

  let moreNote = '';
  if (remaining > 0) {
    moreNote = `<div class="issues-more">...and ${remaining} more issue${remaining !== 1 ? 's' : ''} not shown</div>`;
  }

  return `
  <div class="section">
    <h2 class="section-title">Top Issues</h2>
    <div class="card" style="padding:0;overflow:auto">
      <table class="issues-table">
        <thead>
          <tr>
            <th style="width:100px">Severity</th>
            <th>Check</th>
            <th style="width:130px">Category</th>
            <th style="width:280px">Details</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${moreNote}
    </div>
  </div>`;
}

function buildCategoryDetails(breakdown) {
  if (!breakdown) return '';

  const categories = Object.entries(breakdown)
    .sort((a, b) => (b[1].weight || 0) - (a[1].weight || 0));

  let sections = '';
  for (const [key, cat] of categories) {
    const checks = cat.checks || [];
    // Sort: fails first, then warns, then passes
    const sorted = [...checks].sort((a, b) => {
      const statusOrder = { fail: 0, warn: 1, pass: 2 };
      return (statusOrder[a.status] || 3) - (statusOrder[b.status] || 3);
    });

    let checkItems = '';
    for (const check of sorted) {
      const sevTag = check.status !== 'pass'
        ? `<span class="check-sev-tag" style="background:${severityBg(check.severity)};color:${severityColor(check.severity)}">${escapeHtml(check.severity)}</span>`
        : '';
      const detailLine = check.details
        ? `<div class="check-details">${escapeHtml(truncateStr(check.details, 300))}</div>`
        : '';
      checkItems += `
        <li class="check-item">
          <div>${statusIcon(check.status)}</div>
          <div>
            <span class="check-name">${escapeHtml(check.name)}</span>${sevTag}
            ${detailLine}
          </div>
        </li>`;
    }

    sections += `
      <details class="collapse-section">
        <summary>
          <div class="cat-detail-header">
            <span class="cat-d-name">${escapeHtml(cat.label || key)}</span>
            <span class="cat-d-grade" style="background:${escapeHtml(cat.gradeColor)};color:#fff">${escapeHtml(cat.grade)}</span>
            <span class="cat-d-score">${cat.score}/100</span>
          </div>
        </summary>
        <div class="collapse-body">
          <ul class="check-list">${checkItems}</ul>
        </div>
      </details>`;
  }

  return `
  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
      <h2 class="section-title" style="border:none;margin:0;padding:0">Category Details</h2>
      <button onclick="toggleAllDetails(this)" style="padding:6px 16px;border:1px solid var(--gray-300);border-radius:6px;background:var(--white);cursor:pointer;font-size:13px;font-family:inherit;color:var(--gray-600)">Expand All</button>
    </div>
    ${sections}
  </div>`;
}

function buildPageResults(pages) {
  if (!pages || pages.length === 0) return '';

  let items = '';
  for (const page of pages) {
    const code = page.statusCode || 0;
    let statusColor = 'var(--green)';
    let statusBg = '#f0fdf4';
    if (code >= 400 || code === 0) { statusColor = 'var(--red)'; statusBg = '#fef2f2'; }
    else if (code >= 300) { statusColor = 'var(--orange)'; statusBg = '#fff7ed'; }

    items += `
      <li class="page-item">
        <span class="page-status" style="background:${statusBg};color:${statusColor}">${code || 'ERR'}</span>
        <span class="page-url">${escapeHtml(truncateStr(page.url, 120))}</span>
      </li>`;
  }

  return `
  <div class="section">
    <details class="collapse-section">
      <summary>
        <div class="cat-detail-header">
          <span class="cat-d-name">Page Results</span>
          <span class="cat-d-score" style="font-weight:400;color:var(--gray-500)">${pages.length} page${pages.length !== 1 ? 's' : ''}</span>
        </div>
      </summary>
      <div class="collapse-body">
        <ul class="page-list">${items}</ul>
      </div>
    </details>
  </div>`;
}

function buildRecommendations(topIssues, breakdown) {
  if (!topIssues || topIssues.length === 0) {
    return `
    <div class="section">
      <h2 class="section-title">Recommendations</h2>
      <div class="card">
        <p style="color:var(--green);font-weight:600">All checks passed &mdash; keep up the great work!</p>
      </div>
    </div>`;
  }

  // De-duplicate recommendations: one per unique check name, max 25
  const seen = new Set();
  const recs = [];
  for (const issue of topIssues) {
    const key = issue.name || issue.id;
    if (seen.has(key)) continue;
    seen.add(key);
    recs.push(issue);
    if (recs.length >= 25) break;
  }

  // Lookup category labels
  const catLabelMap = {};
  if (breakdown) {
    for (const [key, cat] of Object.entries(breakdown)) {
      catLabelMap[key] = cat.label || key;
    }
  }

  let items = '';
  for (let i = 0; i < recs.length; i++) {
    const issue = recs[i];
    const rec = getRecommendation(issue);
    const sColor = severityColor(issue.severity);
    const catLabel = catLabelMap[issue.category] || issue.category || '';
    items += `
      <li class="rec-item">
        <span class="rec-num" style="background:${sColor}">${i + 1}</span>
        <div>
          <div class="rec-title">${escapeHtml(issue.name)}</div>
          <div class="rec-cat">${escapeHtml(catLabel)}</div>
          <div class="rec-text">${escapeHtml(rec)}</div>
        </div>
      </li>`;
  }

  return `
  <div class="section">
    <h2 class="section-title">Recommendations</h2>
    <div class="card">
      <ul class="rec-list">${items}</ul>
    </div>
  </div>`;
}

function buildFooter(options) {
  const date = options.analyzedAt ? formatDate(options.analyzedAt) : formatDate(new Date().toISOString());
  return `
  <footer class="report-footer">
    <p>Generated by <strong>Website Analyzer</strong> by <strong>Advanced Marketing</strong></p>
    <p>${escapeHtml(date)}</p>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML report.
 *
 * @param {object} scoreResult - Output from scorer.js
 * @param {object} crawlData   - { domain, pages, crawlTime, sitemapUrls }
 * @param {object} options      - { url, maxPages, analyzedAt }
 * @returns {string} Complete HTML document as a string
 */
function generateReport(scoreResult, crawlData, options) {
  scoreResult = scoreResult || {};
  crawlData = crawlData || {};
  options = options || {};

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Website Analysis Report &mdash; ${escapeHtml(crawlData.domain || options.url || 'Unknown')}</title>
  <style>${getCSS()}</style>
</head>
<body>
  ${buildHeader(scoreResult, crawlData, options)}

  <main class="container">
    ${buildExecutiveSummary(scoreResult.executiveSummary)}
    ${buildCategoryBreakdown(scoreResult.breakdown)}
    ${buildTopIssues(scoreResult.topIssues)}
    ${buildCategoryDetails(scoreResult.breakdown)}
    ${buildPageResults(crawlData.pages)}
    ${buildRecommendations(scoreResult.topIssues, scoreResult.breakdown)}
  </main>

  ${buildFooter(options)}

  <script>${getJS()}</script>
</body>
</html>`;

  return html;
}

// ---------------------------------------------------------------------------
// PDF Generation — renders the HTML report in Puppeteer and prints to PDF
// ---------------------------------------------------------------------------

/**
 * Generate a beautiful PDF report from the HTML report.
 *
 * @param {string} htmlContent - The complete HTML report string
 * @param {string} outputPath  - File path to save the PDF
 * @param {object} [pdfOptions] - Optional Puppeteer PDF options override
 * @returns {Promise<string>} The output path of the saved PDF
 */
async function generatePDF(htmlContent, outputPath, pdfOptions = {}) {
  const puppeteer = require('puppeteer');

  // Inject PDF-specific style overrides to make the report print-beautiful
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

      /* Issues table: allow page break inside but keep header */
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

  // Inject the PDF CSS right before </head>
  const pdfHtml = htmlContent.replace('</head>', pdfCSS + '\n</head>');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();

    // Load HTML content directly
    await page.setContent(pdfHtml, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Force all <details> elements open via JS (belt + suspenders with CSS above)
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
    });

    // Small delay to let any CSS transitions settle
    await new Promise(r => setTimeout(r, 500));

    // Generate PDF
    const defaultPdfOptions = {
      path: outputPath,
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
      footerTemplate: `
        <div style="width:100%;font-size:9px;color:#94a3b8;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:0 14mm;">
          <span>Website Analysis Report</span>
          <span style="margin:0 12px">&bull;</span>
          <span>Advanced Marketing</span>
          <span style="margin:0 12px">&bull;</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    };

    await page.pdf({ ...defaultPdfOptions, ...pdfOptions });

    return outputPath;
  } finally {
    await browser.close();
  }
}

module.exports = { generateReport, generatePDF };
