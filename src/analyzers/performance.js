'use strict';

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getResourcesByType(networkRequests, type) {
  if (!Array.isArray(networkRequests)) return [];
  return networkRequests.filter(r => {
    if (r.resourceType && r.resourceType.toLowerCase() === type.toLowerCase()) return true;
    const ct = (r.contentType || '').toLowerCase();
    switch (type.toLowerCase()) {
      case 'css': return ct.includes('text/css');
      case 'js':
      case 'javascript': return ct.includes('javascript');
      case 'image': return ct.includes('image/');
      case 'font': return ct.includes('font') || ct.includes('woff') || ct.includes('ttf') || ct.includes('otf');
      case 'html': return ct.includes('text/html');
      default: return false;
    }
  });
}

function totalSize(resources) {
  return resources.reduce((sum, r) => sum + (r.size || 0), 0);
}

function bytesToKB(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function bytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return bytesToKB(bytes);
  return bytesToMB(bytes);
}

function getLighthouseAudit(lighthouseResults, auditId) {
  if (!lighthouseResults) return null;
  const audits = lighthouseResults.audits || (lighthouseResults.lhr && lighthouseResults.lhr.audits);
  if (!audits) return null;
  return audits[auditId] || null;
}

function getLighthouseNumericValue(lighthouseResults, auditId) {
  const audit = getLighthouseAudit(lighthouseResults, auditId);
  if (!audit) return null;
  if (typeof audit.numericValue === 'number') return audit.numericValue;
  if (typeof audit.rawValue === 'number') return audit.rawValue;
  return null;
}

function getLighthouseScore(lighthouseResults, auditId) {
  const audit = getLighthouseAudit(lighthouseResults, auditId);
  if (!audit) return null;
  return audit.score;
}

function safeCheck(id, name, severity, fn) {
  try {
    return fn();
  } catch (err) {
    return { id, name, status: 'warn', severity, value: null, details: `Error running check: ${err.message}` };
  }
}

function countTagOccurrences(html, regex) {
  const matches = html.match(regex);
  return matches ? matches.length : 0;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function getWhitespaceRatio(content) {
  if (!content || content.length === 0) return 0;
  const whitespace = (content.match(/\s/g) || []).length;
  return whitespace / content.length;
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

async function analyzePerformance(pageData, lighthouseResults) {
  const checks = [];
  const { url = '', html = '', statusCode, headers = {}, responseTime, networkRequests = [], consoleMessages = [] } = pageData || {};

  let $;
  try {
    $ = cheerio.load(html || '');
  } catch {
    $ = cheerio.load('');
  }

  const allRequests = Array.isArray(networkRequests) ? networkRequests : [];
  const cssResources = getResourcesByType(allRequests, 'css');
  const jsResources = getResourcesByType(allRequests, 'javascript');
  const imageResources = getResourcesByType(allRequests, 'image');
  const fontResources = getResourcesByType(allRequests, 'font');
  const htmlResources = getResourcesByType(allRequests, 'html');

  const pageHostname = getHostname(url);

  // -------------------------------------------------------------------------
  // 1-6: Core Web Vitals from Lighthouse
  // -------------------------------------------------------------------------

  const coreVitals = [
    { id: 'perf-1', name: 'First Contentful Paint', audit: 'first-contentful-paint', thresholds: [1800, 3000], unit: 'ms' },
    { id: 'perf-2', name: 'Largest Contentful Paint', audit: 'largest-contentful-paint', thresholds: [2500, 4000], unit: 'ms' },
    { id: 'perf-3', name: 'Cumulative Layout Shift', audit: 'cumulative-layout-shift', thresholds: [0.1, 0.25], unit: '' },
    { id: 'perf-4', name: 'Total Blocking Time', audit: 'total-blocking-time', thresholds: [200, 600], unit: 'ms' },
    { id: 'perf-5', name: 'Speed Index', audit: 'speed-index', thresholds: [3400, 5800], unit: 'ms' },
    { id: 'perf-6', name: 'Time to Interactive', audit: 'interactive', thresholds: [3800, 7300], unit: 'ms' },
  ];

  for (const vital of coreVitals) {
    checks.push(safeCheck(vital.id, vital.name, 'critical', () => {
      const value = getLighthouseNumericValue(lighthouseResults, vital.audit);
      if (value === null) {
        return { id: vital.id, name: vital.name, status: 'warn', severity: 'critical', value: null, details: 'No Lighthouse data available' };
      }
      const displayValue = vital.unit === 'ms' ? `${Math.round(value)}ms` : value.toFixed(3);
      let status;
      if (value <= vital.thresholds[0]) status = 'pass';
      else if (value <= vital.thresholds[1]) status = 'warn';
      else status = 'fail';
      return { id: vital.id, name: vital.name, status, severity: 'critical', value, details: `${vital.name}: ${displayValue} (good: <${vital.thresholds[0]}${vital.unit}, poor: >${vital.thresholds[1]}${vital.unit})` };
    }));
  }

  // -------------------------------------------------------------------------
  // 7: TTFB
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-7', 'Time to First Byte', 'critical', () => {
    const ttfb = responseTime;
    if (ttfb == null) {
      return { id: 'perf-7', name: 'Time to First Byte', status: 'warn', severity: 'critical', value: null, details: 'No TTFB data available' };
    }
    let status;
    if (ttfb < 600) status = 'pass';
    else if (ttfb < 1800) status = 'warn';
    else status = 'fail';
    return { id: 'perf-7', name: 'Time to First Byte', status, severity: 'critical', value: ttfb, details: `TTFB: ${Math.round(ttfb)}ms (good: <600ms, poor: >1800ms)` };
  }));

  // -------------------------------------------------------------------------
  // 8: Total page weight
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-8', 'Total Page Weight', 'major', () => {
    const total = totalSize(allRequests);
    let status;
    if (total < 3 * 1024 * 1024) status = 'pass';
    else if (total < 5 * 1024 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-8', name: 'Total Page Weight', status, severity: 'major', value: total, details: `Total page weight: ${formatBytes(total)} (good: <3MB, poor: >5MB)` };
  }));

  // -------------------------------------------------------------------------
  // 9: HTML size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-9', 'HTML Document Size', 'minor', () => {
    const htmlSize = html ? Buffer.byteLength(html, 'utf8') : 0;
    let status;
    if (htmlSize < 100 * 1024) status = 'pass';
    else if (htmlSize < 300 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-9', name: 'HTML Document Size', status, severity: 'minor', value: htmlSize, details: `HTML size: ${formatBytes(htmlSize)} (good: <100KB, poor: >300KB)` };
  }));

  // -------------------------------------------------------------------------
  // 10: CSS total size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-10', 'CSS Total Size', 'major', () => {
    const size = totalSize(cssResources);
    let status;
    if (size < 200 * 1024) status = 'pass';
    else if (size < 500 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-10', name: 'CSS Total Size', status, severity: 'major', value: size, details: `CSS total: ${formatBytes(size)} across ${cssResources.length} files (good: <200KB, poor: >500KB)` };
  }));

  // -------------------------------------------------------------------------
  // 11: JS total size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-11', 'JavaScript Total Size', 'major', () => {
    const size = totalSize(jsResources);
    let status;
    if (size < 500 * 1024) status = 'pass';
    else if (size < 1024 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-11', name: 'JavaScript Total Size', status, severity: 'major', value: size, details: `JS total: ${formatBytes(size)} across ${jsResources.length} files (good: <500KB, poor: >1MB)` };
  }));

  // -------------------------------------------------------------------------
  // 12: Image total size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-12', 'Image Total Size', 'major', () => {
    const size = totalSize(imageResources);
    let status;
    if (size < 1024 * 1024) status = 'pass';
    else if (size < 3 * 1024 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-12', name: 'Image Total Size', status, severity: 'major', value: size, details: `Image total: ${formatBytes(size)} across ${imageResources.length} images (good: <1MB, poor: >3MB)` };
  }));

  // -------------------------------------------------------------------------
  // 13: Font total size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-13', 'Font Total Size', 'minor', () => {
    const size = totalSize(fontResources);
    let status;
    if (size < 300 * 1024) status = 'pass';
    else if (size < 500 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-13', name: 'Font Total Size', status, severity: 'minor', value: size, details: `Font total: ${formatBytes(size)} across ${fontResources.length} fonts (good: <300KB, poor: >500KB)` };
  }));

  // -------------------------------------------------------------------------
  // 14: HTTP request count
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-14', 'HTTP Request Count', 'major', () => {
    const count = allRequests.length;
    let status;
    if (count < 50) status = 'pass';
    else if (count < 100) status = 'warn';
    else status = 'fail';
    return { id: 'perf-14', name: 'HTTP Request Count', status, severity: 'major', value: count, details: `${count} HTTP requests (good: <50, poor: >100)` };
  }));

  // -------------------------------------------------------------------------
  // 15: Redirects
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-15', 'Redirect Count', 'minor', () => {
    const redirects = allRequests.filter(r => r.status >= 300 && r.status < 400).length;
    let status;
    if (redirects === 0) status = 'pass';
    else if (redirects <= 2) status = 'warn';
    else status = 'fail';
    return { id: 'perf-15', name: 'Redirect Count', status, severity: 'minor', value: redirects, details: `${redirects} redirect(s) detected (good: 0, poor: 3+)` };
  }));

  // -------------------------------------------------------------------------
  // 16: Gzip/Brotli on HTML
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-16', 'HTML Compression', 'major', () => {
    const encoding = (headers['content-encoding'] || headers['Content-Encoding'] || '').toLowerCase();
    const hasCompression = encoding.includes('gzip') || encoding.includes('br') || encoding.includes('deflate');
    // Also check HTML network requests
    const htmlReqs = htmlResources.filter(r => (r.contentEncoding || '').toLowerCase().match(/gzip|br|deflate/));
    const compressed = hasCompression || htmlReqs.length > 0;
    return {
      id: 'perf-16', name: 'HTML Compression', status: compressed ? 'pass' : 'fail', severity: 'major',
      value: encoding || 'none',
      details: compressed ? `HTML is compressed (${encoding || 'gzip/br'})` : 'HTML is not compressed - enable gzip or Brotli compression'
    };
  }));

  // -------------------------------------------------------------------------
  // 17: Gzip/Brotli on CSS/JS
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-17', 'CSS/JS Compression', 'major', () => {
    const textResources = [...cssResources, ...jsResources];
    if (textResources.length === 0) {
      return { id: 'perf-17', name: 'CSS/JS Compression', status: 'pass', severity: 'major', value: 'N/A', details: 'No external CSS/JS resources found' };
    }
    const uncompressed = textResources.filter(r => {
      const enc = (r.contentEncoding || '').toLowerCase();
      return !enc.includes('gzip') && !enc.includes('br') && !enc.includes('deflate');
    });
    const pct = ((textResources.length - uncompressed.length) / textResources.length * 100).toFixed(0);
    let status;
    if (uncompressed.length === 0) status = 'pass';
    else if (uncompressed.length <= 2) status = 'warn';
    else status = 'fail';
    return {
      id: 'perf-17', name: 'CSS/JS Compression', status, severity: 'major',
      value: `${pct}%`,
      details: `${textResources.length - uncompressed.length}/${textResources.length} CSS/JS resources are compressed (${pct}%)`
    };
  }));

  // -------------------------------------------------------------------------
  // 18: Render-blocking CSS
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-18', 'Render-blocking CSS', 'major', () => {
    // Try lighthouse first
    const audit = getLighthouseAudit(lighthouseResults, 'render-blocking-resources');
    if (audit && audit.details && Array.isArray(audit.details.items)) {
      const blockingCSS = audit.details.items.filter(i => (i.url || '').match(/\.css/i));
      const count = blockingCSS.length;
      let status;
      if (count === 0) status = 'pass';
      else if (count <= 2) status = 'warn';
      else status = 'fail';
      return { id: 'perf-18', name: 'Render-blocking CSS', status, severity: 'major', value: count, details: `${count} render-blocking CSS resource(s) found (Lighthouse)` };
    }
    // Fallback: count <link rel="stylesheet"> in head without media attribute (media="print" etc.) or disabled
    const headLinks = $('head link[rel="stylesheet"]');
    let blockingCount = 0;
    headLinks.each((_, el) => {
      const media = $(el).attr('media');
      const disabled = $(el).attr('disabled');
      if (!disabled && (!media || media === 'all' || media === '')) {
        blockingCount++;
      }
    });
    let status;
    if (blockingCount === 0) status = 'pass';
    else if (blockingCount <= 2) status = 'warn';
    else status = 'fail';
    return { id: 'perf-18', name: 'Render-blocking CSS', status, severity: 'major', value: blockingCount, details: `${blockingCount} potentially render-blocking CSS file(s) in <head>` };
  }));

  // -------------------------------------------------------------------------
  // 19: Render-blocking JS
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-19', 'Render-blocking JavaScript', 'major', () => {
    const headScripts = $('head script[src]');
    let blockingCount = 0;
    headScripts.each((_, el) => {
      const async = $(el).attr('async');
      const defer = $(el).attr('defer');
      const type = ($(el).attr('type') || '').toLowerCase();
      if (async == null && defer == null && type !== 'module') {
        blockingCount++;
      }
    });
    let status;
    if (blockingCount === 0) status = 'pass';
    else if (blockingCount <= 2) status = 'warn';
    else status = 'fail';
    return { id: 'perf-19', name: 'Render-blocking JavaScript', status, severity: 'major', value: blockingCount, details: `${blockingCount} render-blocking script(s) in <head> (missing async/defer)` };
  }));

  // -------------------------------------------------------------------------
  // 20: Unused CSS %
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-20', 'Unused CSS', 'minor', () => {
    const audit = getLighthouseAudit(lighthouseResults, 'unused-css-rules');
    if (!audit || !audit.details || !Array.isArray(audit.details.items)) {
      return { id: 'perf-20', name: 'Unused CSS', status: 'warn', severity: 'minor', value: null, details: 'No Lighthouse CSS coverage data available' };
    }
    const totalBytes = audit.details.items.reduce((sum, i) => sum + (i.totalBytes || 0), 0);
    const wastedBytes = audit.details.items.reduce((sum, i) => sum + (i.wastedBytes || 0), 0);
    const pct = totalBytes > 0 ? (wastedBytes / totalBytes * 100).toFixed(1) : 0;
    let status;
    if (pct < 20) status = 'pass';
    else if (pct < 50) status = 'warn';
    else status = 'fail';
    return { id: 'perf-20', name: 'Unused CSS', status, severity: 'minor', value: `${pct}%`, details: `${pct}% of CSS is unused (${formatBytes(wastedBytes)} wasted of ${formatBytes(totalBytes)})` };
  }));

  // -------------------------------------------------------------------------
  // 21: Unused JS %
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-21', 'Unused JavaScript', 'minor', () => {
    const audit = getLighthouseAudit(lighthouseResults, 'unused-javascript');
    if (!audit || !audit.details || !Array.isArray(audit.details.items)) {
      return { id: 'perf-21', name: 'Unused JavaScript', status: 'warn', severity: 'minor', value: null, details: 'No Lighthouse JS coverage data available' };
    }
    const totalBytes = audit.details.items.reduce((sum, i) => sum + (i.totalBytes || 0), 0);
    const wastedBytes = audit.details.items.reduce((sum, i) => sum + (i.wastedBytes || 0), 0);
    const pct = totalBytes > 0 ? (wastedBytes / totalBytes * 100).toFixed(1) : 0;
    let status;
    if (pct < 20) status = 'pass';
    else if (pct < 50) status = 'warn';
    else status = 'fail';
    return { id: 'perf-21', name: 'Unused JavaScript', status, severity: 'minor', value: `${pct}%`, details: `${pct}% of JavaScript is unused (${formatBytes(wastedBytes)} wasted of ${formatBytes(totalBytes)})` };
  }));

  // -------------------------------------------------------------------------
  // 22: CSS minified
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-22', 'CSS Minification', 'minor', () => {
    const audit = getLighthouseAudit(lighthouseResults, 'unminified-css');
    if (audit && audit.details && Array.isArray(audit.details.items)) {
      const unminified = audit.details.items.length;
      let status = unminified === 0 ? 'pass' : 'fail';
      return { id: 'perf-22', name: 'CSS Minification', status, severity: 'minor', value: unminified, details: `${unminified} unminified CSS file(s) found (Lighthouse)` };
    }
    // Fallback: check inline styles whitespace ratio
    const inlineCSS = [];
    $('style').each((_, el) => { inlineCSS.push($(el).html() || ''); });
    if (inlineCSS.length === 0 && cssResources.length === 0) {
      return { id: 'perf-22', name: 'CSS Minification', status: 'pass', severity: 'minor', value: 'N/A', details: 'No CSS resources to evaluate' };
    }
    if (inlineCSS.length > 0) {
      const combined = inlineCSS.join('');
      const ratio = getWhitespaceRatio(combined);
      const status = ratio < 0.1 ? 'pass' : 'warn';
      return { id: 'perf-22', name: 'CSS Minification', status, severity: 'minor', value: `${(ratio * 100).toFixed(1)}%`, details: `Inline CSS whitespace ratio: ${(ratio * 100).toFixed(1)}% (minified: <10%)` };
    }
    return { id: 'perf-22', name: 'CSS Minification', status: 'warn', severity: 'minor', value: null, details: 'Cannot determine CSS minification without content access' };
  }));

  // -------------------------------------------------------------------------
  // 23: JS minified
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-23', 'JavaScript Minification', 'minor', () => {
    const audit = getLighthouseAudit(lighthouseResults, 'unminified-javascript');
    if (audit && audit.details && Array.isArray(audit.details.items)) {
      const unminified = audit.details.items.length;
      let status = unminified === 0 ? 'pass' : 'fail';
      return { id: 'perf-23', name: 'JavaScript Minification', status, severity: 'minor', value: unminified, details: `${unminified} unminified JavaScript file(s) found (Lighthouse)` };
    }
    // Fallback: check inline scripts
    const inlineJS = [];
    $('script:not([src])').each((_, el) => {
      const content = $(el).html() || '';
      if (content.trim().length > 100) inlineJS.push(content);
    });
    if (inlineJS.length === 0 && jsResources.length === 0) {
      return { id: 'perf-23', name: 'JavaScript Minification', status: 'pass', severity: 'minor', value: 'N/A', details: 'No JavaScript resources to evaluate' };
    }
    if (inlineJS.length > 0) {
      const combined = inlineJS.join('');
      const ratio = getWhitespaceRatio(combined);
      const status = ratio < 0.1 ? 'pass' : 'warn';
      return { id: 'perf-23', name: 'JavaScript Minification', status, severity: 'minor', value: `${(ratio * 100).toFixed(1)}%`, details: `Inline JS whitespace ratio: ${(ratio * 100).toFixed(1)}% (minified: <10%)` };
    }
    return { id: 'perf-23', name: 'JavaScript Minification', status: 'warn', severity: 'minor', value: null, details: 'Cannot determine JS minification without content access' };
  }));

  // -------------------------------------------------------------------------
  // 24: HTML minified
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-24', 'HTML Minification', 'minor', () => {
    if (!html || html.length === 0) {
      return { id: 'perf-24', name: 'HTML Minification', status: 'warn', severity: 'minor', value: null, details: 'No HTML content to evaluate' };
    }
    const ratio = getWhitespaceRatio(html);
    let status;
    if (ratio < 0.1) status = 'pass';
    else if (ratio < 0.2) status = 'warn';
    else status = 'fail';
    return { id: 'perf-24', name: 'HTML Minification', status, severity: 'minor', value: `${(ratio * 100).toFixed(1)}%`, details: `HTML whitespace ratio: ${(ratio * 100).toFixed(1)}% (minified: <10%)` };
  }));

  // -------------------------------------------------------------------------
  // 25: Modern image formats (WebP/AVIF)
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-25', 'Modern Image Formats', 'major', () => {
    if (imageResources.length === 0) {
      return { id: 'perf-25', name: 'Modern Image Formats', status: 'pass', severity: 'major', value: 'N/A', details: 'No image resources found' };
    }
    const modernFormats = imageResources.filter(r => {
      const ct = (r.contentType || '').toLowerCase();
      const imgUrl = (r.url || '').toLowerCase();
      return ct.includes('webp') || ct.includes('avif') || imgUrl.includes('.webp') || imgUrl.includes('.avif');
    });
    const pct = (modernFormats.length / imageResources.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 40) status = 'warn';
    else status = 'fail';
    return { id: 'perf-25', name: 'Modern Image Formats', status, severity: 'major', value: `${pct}%`, details: `${modernFormats.length}/${imageResources.length} images use modern formats (WebP/AVIF) - ${pct}%` };
  }));

  // -------------------------------------------------------------------------
  // 26: Oversized images
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-26', 'Oversized Images', 'major', () => {
    const oversized = imageResources.filter(r => (r.size || 0) > 500 * 1024);
    let status;
    if (oversized.length === 0) status = 'pass';
    else if (oversized.length <= 2) status = 'warn';
    else status = 'fail';
    const details = oversized.length > 0
      ? `${oversized.length} image(s) over 500KB: ${oversized.slice(0, 3).map(r => `${getHostname(r.url) || 'unknown'}...${formatBytes(r.size)}`).join(', ')}${oversized.length > 3 ? '...' : ''}`
      : 'No images over 500KB';
    return { id: 'perf-26', name: 'Oversized Images', status, severity: 'major', value: oversized.length, details };
  }));

  // -------------------------------------------------------------------------
  // 27: Images missing width/height
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-27', 'Image Dimensions', 'minor', () => {
    const images = $('img');
    let missingCount = 0;
    let totalImages = 0;
    images.each((_, el) => {
      totalImages++;
      const width = $(el).attr('width');
      const height = $(el).attr('height');
      if (!width || !height) {
        missingCount++;
      }
    });
    if (totalImages === 0) {
      return { id: 'perf-27', name: 'Image Dimensions', status: 'pass', severity: 'minor', value: 'N/A', details: 'No <img> tags found' };
    }
    let status;
    if (missingCount === 0) status = 'pass';
    else if (missingCount <= 3) status = 'warn';
    else status = 'fail';
    return { id: 'perf-27', name: 'Image Dimensions', status, severity: 'minor', value: missingCount, details: `${missingCount}/${totalImages} images missing explicit width/height attributes (causes layout shift)` };
  }));

  // -------------------------------------------------------------------------
  // 28: Lazy loading on below-fold images
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-28', 'Image Lazy Loading', 'minor', () => {
    const images = $('img');
    const allImgs = [];
    images.each((i, el) => {
      allImgs.push({
        src: $(el).attr('src') || '',
        loading: $(el).attr('loading'),
        index: i
      });
    });
    if (allImgs.length <= 1) {
      return { id: 'perf-28', name: 'Image Lazy Loading', status: 'pass', severity: 'minor', value: 'N/A', details: `Only ${allImgs.length} image(s) found - lazy loading not critical` };
    }
    // Consider images after the first 2 as "below fold" heuristic
    const belowFold = allImgs.slice(2);
    const lazyCount = belowFold.filter(img => img.loading === 'lazy').length;
    if (belowFold.length === 0) {
      return { id: 'perf-28', name: 'Image Lazy Loading', status: 'pass', severity: 'minor', value: 'N/A', details: 'Few images - lazy loading not critical' };
    }
    const pct = (lazyCount / belowFold.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 40) status = 'warn';
    else status = 'fail';
    return { id: 'perf-28', name: 'Image Lazy Loading', status, severity: 'minor', value: `${pct}%`, details: `${lazyCount}/${belowFold.length} below-fold images have loading="lazy" (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 29: font-display: swap
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-29', 'Font Display Swap', 'minor', () => {
    const styles = [];
    $('style').each((_, el) => { styles.push($(el).html() || ''); });
    const allCSS = styles.join(' ');
    const fontFaceMatches = allCSS.match(/@font-face\s*\{[^}]*\}/gi) || [];
    if (fontFaceMatches.length === 0 && fontResources.length === 0) {
      return { id: 'perf-29', name: 'Font Display Swap', status: 'pass', severity: 'minor', value: 'N/A', details: 'No @font-face declarations or font resources found' };
    }
    if (fontFaceMatches.length === 0) {
      return { id: 'perf-29', name: 'Font Display Swap', status: 'warn', severity: 'minor', value: null, details: 'Fonts loaded but no inline @font-face declarations found to verify font-display property' };
    }
    const withSwap = fontFaceMatches.filter(ff => /font-display\s*:\s*(swap|optional)/i.test(ff)).length;
    const pct = (withSwap / fontFaceMatches.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 100) status = 'pass';
    else if (Number(pct) >= 50) status = 'warn';
    else status = 'fail';
    return { id: 'perf-29', name: 'Font Display Swap', status, severity: 'minor', value: `${pct}%`, details: `${withSwap}/${fontFaceMatches.length} @font-face rules use font-display: swap (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 30: Font preloading
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-30', 'Font Preloading', 'minor', () => {
    if (fontResources.length === 0) {
      return { id: 'perf-30', name: 'Font Preloading', status: 'pass', severity: 'minor', value: 'N/A', details: 'No font resources to preload' };
    }
    const preloads = $('link[rel="preload"][as="font"]');
    const count = preloads.length;
    let status;
    if (count > 0) status = 'pass';
    else status = 'warn';
    return { id: 'perf-30', name: 'Font Preloading', status, severity: 'minor', value: count, details: `${count} font preload hint(s) found for ${fontResources.length} font resource(s)` };
  }));

  // -------------------------------------------------------------------------
  // 31: Critical CSS inlined
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-31', 'Critical CSS Inlined', 'minor', () => {
    const headStyles = $('head style');
    const count = headStyles.length;
    let totalLength = 0;
    headStyles.each((_, el) => { totalLength += ($(el).html() || '').length; });
    let status;
    if (count > 0 && totalLength > 100) status = 'pass';
    else if (count > 0) status = 'warn';
    else status = 'fail';
    return { id: 'perf-31', name: 'Critical CSS Inlined', status, severity: 'minor', value: count, details: count > 0 ? `${count} inline <style> tag(s) in <head> (${formatBytes(totalLength)}) for critical CSS` : 'No inline critical CSS found in <head> - consider inlining above-the-fold styles' };
  }));

  // -------------------------------------------------------------------------
  // 32: Third-party script count
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-32', 'Third-party Script Count', 'major', () => {
    const thirdPartyScripts = jsResources.filter(r => {
      const host = getHostname(r.url);
      return host && host !== pageHostname;
    });
    const uniqueDomains = new Set(thirdPartyScripts.map(r => getHostname(r.url)));
    let status;
    if (uniqueDomains.size <= 3) status = 'pass';
    else if (uniqueDomains.size <= 7) status = 'warn';
    else status = 'fail';
    return { id: 'perf-32', name: 'Third-party Script Count', status, severity: 'major', value: thirdPartyScripts.length, details: `${thirdPartyScripts.length} third-party script(s) from ${uniqueDomains.size} domain(s)` };
  }));

  // -------------------------------------------------------------------------
  // 33: Third-party script size
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-33', 'Third-party Script Size', 'major', () => {
    const thirdPartyScripts = jsResources.filter(r => {
      const host = getHostname(r.url);
      return host && host !== pageHostname;
    });
    const size = totalSize(thirdPartyScripts);
    let status;
    if (size < 200 * 1024) status = 'pass';
    else if (size < 500 * 1024) status = 'warn';
    else status = 'fail';
    return { id: 'perf-33', name: 'Third-party Script Size', status, severity: 'major', value: size, details: `Third-party scripts total: ${formatBytes(size)} (good: <200KB, poor: >500KB)` };
  }));

  // -------------------------------------------------------------------------
  // 34: Cache-Control headers on static resources
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-34', 'Cache-Control Headers', 'major', () => {
    const staticResources = [...cssResources, ...jsResources, ...imageResources, ...fontResources];
    if (staticResources.length === 0) {
      return { id: 'perf-34', name: 'Cache-Control Headers', status: 'pass', severity: 'major', value: 'N/A', details: 'No static resources to evaluate' };
    }
    const withCache = staticResources.filter(r => {
      const h = r.headers || {};
      return h['cache-control'] || h['Cache-Control'];
    });
    // If we can't inspect individual resource headers, check if fromCache is set
    const cached = staticResources.filter(r => r.fromCache);
    const effective = Math.max(withCache.length, cached.length);
    const pct = (effective / staticResources.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 40) status = 'warn';
    else status = 'fail';
    return { id: 'perf-34', name: 'Cache-Control Headers', status, severity: 'major', value: `${pct}%`, details: `${effective}/${staticResources.length} static resources have Cache-Control headers (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 35: Cache TTL adequate
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-35', 'Cache TTL Adequate', 'minor', () => {
    const staticResources = [...cssResources, ...jsResources, ...imageResources, ...fontResources];
    if (staticResources.length === 0) {
      return { id: 'perf-35', name: 'Cache TTL Adequate', status: 'pass', severity: 'minor', value: 'N/A', details: 'No static resources to evaluate' };
    }
    let adequate = 0;
    let checked = 0;
    staticResources.forEach(r => {
      const h = r.headers || {};
      const cc = h['cache-control'] || h['Cache-Control'] || '';
      const maxAgeMatch = cc.match(/max-age=(\d+)/);
      if (maxAgeMatch) {
        checked++;
        if (Number(maxAgeMatch[1]) >= 604800) adequate++;
      }
    });
    if (checked === 0) {
      return { id: 'perf-35', name: 'Cache TTL Adequate', status: 'warn', severity: 'minor', value: null, details: 'No max-age directives found on static resources' };
    }
    const pct = (adequate / checked * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 40) status = 'warn';
    else status = 'fail';
    return { id: 'perf-35', name: 'Cache TTL Adequate', status, severity: 'minor', value: `${pct}%`, details: `${adequate}/${checked} resources have max-age >= 7 days (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 36: ETags present
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-36', 'ETag Headers', 'minor', () => {
    const staticResources = [...cssResources, ...jsResources, ...imageResources, ...fontResources];
    if (staticResources.length === 0) {
      return { id: 'perf-36', name: 'ETag Headers', status: 'pass', severity: 'minor', value: 'N/A', details: 'No static resources to evaluate' };
    }
    const withEtag = staticResources.filter(r => {
      const h = r.headers || {};
      return h['etag'] || h['ETag'];
    });
    const pct = (withEtag.length / staticResources.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 40) status = 'warn';
    else status = 'fail';
    return { id: 'perf-36', name: 'ETag Headers', status, severity: 'minor', value: `${pct}%`, details: `${withEtag.length}/${staticResources.length} resources have ETag headers (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 37: Service Worker
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-37', 'Service Worker', 'minor', () => {
    const audit = getLighthouseAudit(lighthouseResults, 'service-worker');
    if (audit) {
      const status = audit.score === 1 ? 'pass' : 'warn';
      return { id: 'perf-37', name: 'Service Worker', status, severity: 'minor', value: audit.score === 1, details: audit.score === 1 ? 'Service worker is registered' : 'No service worker registered - consider adding one for offline support' };
    }
    // Fallback: check HTML for navigator.serviceWorker
    const hasSW = html.includes('serviceWorker') || html.includes('service-worker') || html.includes('sw.js');
    return { id: 'perf-37', name: 'Service Worker', status: hasSW ? 'pass' : 'warn', severity: 'minor', value: hasSW, details: hasSW ? 'Service worker reference detected in HTML' : 'No service worker detected - consider adding one for offline/caching support' };
  }));

  // -------------------------------------------------------------------------
  // 38: Preconnect / DNS-prefetch hints
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-38', 'Resource Hints (Preconnect/DNS-Prefetch)', 'minor', () => {
    const preconnects = $('link[rel="preconnect"]').length;
    const dnsPrefetch = $('link[rel="dns-prefetch"]').length;
    const total = preconnects + dnsPrefetch;
    // Determine third-party domains
    const thirdPartyDomains = new Set();
    allRequests.forEach(r => {
      const host = getHostname(r.url);
      if (host && host !== pageHostname) thirdPartyDomains.add(host);
    });
    let status;
    if (thirdPartyDomains.size === 0 || total >= Math.min(thirdPartyDomains.size, 3)) status = 'pass';
    else if (total > 0) status = 'warn';
    else status = 'fail';
    return { id: 'perf-38', name: 'Resource Hints (Preconnect/DNS-Prefetch)', status, severity: 'minor', value: total, details: `${preconnects} preconnect and ${dnsPrefetch} dns-prefetch hint(s) for ${thirdPartyDomains.size} third-party domain(s)` };
  }));

  // -------------------------------------------------------------------------
  // 39: Priority hints (fetchpriority) on above-fold images
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-39', 'Priority Hints', 'minor', () => {
    const images = $('img');
    if (images.length === 0) {
      return { id: 'perf-39', name: 'Priority Hints', status: 'pass', severity: 'minor', value: 'N/A', details: 'No images found' };
    }
    // Check first 2 images as likely above-fold
    let priorityCount = 0;
    let aboveFoldCount = Math.min(2, images.length);
    images.each((i, el) => {
      if (i >= 2) return false;
      if ($(el).attr('fetchpriority') === 'high') priorityCount++;
    });
    let status;
    if (priorityCount > 0) status = 'pass';
    else status = 'warn';
    return { id: 'perf-39', name: 'Priority Hints', status, severity: 'minor', value: priorityCount, details: `${priorityCount}/${aboveFoldCount} above-fold image(s) have fetchpriority="high"` };
  }));

  // -------------------------------------------------------------------------
  // 40: DOM node count
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-40', 'DOM Node Count', 'major', () => {
    const allElements = $('*');
    const count = allElements.length;
    let status;
    if (count < 1500) status = 'pass';
    else if (count < 3000) status = 'warn';
    else status = 'fail';
    return { id: 'perf-40', name: 'DOM Node Count', status, severity: 'major', value: count, details: `${count} DOM nodes (good: <1500, poor: >3000)` };
  }));

  // -------------------------------------------------------------------------
  // 41: DOM depth
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-41', 'DOM Depth', 'minor', () => {
    let maxDepth = 0;
    function walkDepth(el, depth) {
      if (depth > maxDepth) maxDepth = depth;
      $(el).children().each((_, child) => {
        walkDepth(child, depth + 1);
      });
    }
    const body = $('body');
    if (body.length > 0) {
      walkDepth(body[0], 0);
    }
    let status;
    if (maxDepth < 15) status = 'pass';
    else if (maxDepth < 25) status = 'warn';
    else status = 'fail';
    return { id: 'perf-41', name: 'DOM Depth', status, severity: 'minor', value: maxDepth, details: `Maximum DOM nesting depth: ${maxDepth} levels (good: <15, poor: >25)` };
  }));

  // -------------------------------------------------------------------------
  // 42: Inline style tag count
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-42', 'Inline Style Tags', 'minor', () => {
    const count = $('style').length;
    let status;
    if (count < 3) status = 'pass';
    else if (count < 10) status = 'warn';
    else status = 'fail';
    return { id: 'perf-42', name: 'Inline Style Tags', status, severity: 'minor', value: count, details: `${count} inline <style> tag(s) (good: <3, poor: >10)` };
  }));

  // -------------------------------------------------------------------------
  // 43: Inline script tag count
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-43', 'Inline Script Tags', 'minor', () => {
    const count = $('script:not([src])').length;
    let status;
    if (count < 5) status = 'pass';
    else if (count < 15) status = 'warn';
    else status = 'fail';
    return { id: 'perf-43', name: 'Inline Script Tags', status, severity: 'minor', value: count, details: `${count} inline <script> tag(s) (good: <5, poor: >15)` };
  }));

  // -------------------------------------------------------------------------
  // 44: Number of CSS files
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-44', 'CSS File Count', 'minor', () => {
    const count = cssResources.length;
    let status;
    if (count < 5) status = 'pass';
    else if (count < 15) status = 'warn';
    else status = 'fail';
    return { id: 'perf-44', name: 'CSS File Count', status, severity: 'minor', value: count, details: `${count} external CSS file(s) (good: <5, poor: >15)` };
  }));

  // -------------------------------------------------------------------------
  // 45: Number of JS files
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-45', 'JavaScript File Count', 'minor', () => {
    const count = jsResources.length;
    let status;
    if (count < 10) status = 'pass';
    else if (count < 25) status = 'warn';
    else status = 'fail';
    return { id: 'perf-45', name: 'JavaScript File Count', status, severity: 'minor', value: count, details: `${count} external JS file(s) (good: <10, poor: >25)` };
  }));

  // -------------------------------------------------------------------------
  // 46: Number of font files
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-46', 'Font File Count', 'minor', () => {
    const count = fontResources.length;
    let status;
    if (count < 5) status = 'pass';
    else if (count < 10) status = 'warn';
    else status = 'fail';
    return { id: 'perf-46', name: 'Font File Count', status, severity: 'minor', value: count, details: `${count} font file(s) (good: <5, poor: >10)` };
  }));

  // -------------------------------------------------------------------------
  // 47: Largest single asset
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-47', 'Largest Single Asset', 'major', () => {
    if (allRequests.length === 0) {
      return { id: 'perf-47', name: 'Largest Single Asset', status: 'pass', severity: 'major', value: 0, details: 'No network requests to evaluate' };
    }
    let largest = { size: 0, url: '' };
    allRequests.forEach(r => {
      if ((r.size || 0) > largest.size) {
        largest = { size: r.size, url: r.url };
      }
    });
    let status;
    if (largest.size < 500 * 1024) status = 'pass';
    else if (largest.size < 1024 * 1024) status = 'warn';
    else status = 'fail';
    const assetName = largest.url ? (largest.url.split('/').pop() || '').split('?')[0].substring(0, 60) : 'unknown';
    return { id: 'perf-47', name: 'Largest Single Asset', status, severity: 'major', value: largest.size, details: `Largest asset: ${formatBytes(largest.size)} (${assetName}) (good: <500KB, poor: >1MB)` };
  }));

  // -------------------------------------------------------------------------
  // 48: Time to Interactive from Lighthouse
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-48', 'Time to Interactive (Lighthouse)', 'critical', () => {
    const value = getLighthouseNumericValue(lighthouseResults, 'interactive');
    if (value === null) {
      return { id: 'perf-48', name: 'Time to Interactive (Lighthouse)', status: 'warn', severity: 'critical', value: null, details: 'No Lighthouse data available' };
    }
    let status;
    if (value <= 3800) status = 'pass';
    else if (value <= 7300) status = 'warn';
    else status = 'fail';
    return { id: 'perf-48', name: 'Time to Interactive (Lighthouse)', status, severity: 'critical', value, details: `TTI: ${Math.round(value)}ms (good: <3800ms, poor: >7300ms)` };
  }));

  // -------------------------------------------------------------------------
  // 49: Speed Index from Lighthouse
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-49', 'Speed Index (Lighthouse)', 'critical', () => {
    const value = getLighthouseNumericValue(lighthouseResults, 'speed-index');
    if (value === null) {
      return { id: 'perf-49', name: 'Speed Index (Lighthouse)', status: 'warn', severity: 'critical', value: null, details: 'No Lighthouse data available' };
    }
    let status;
    if (value <= 3400) status = 'pass';
    else if (value <= 5800) status = 'warn';
    else status = 'fail';
    return { id: 'perf-49', name: 'Speed Index (Lighthouse)', status, severity: 'critical', value, details: `Speed Index: ${Math.round(value)}ms (good: <3400ms, poor: >5800ms)` };
  }));

  // -------------------------------------------------------------------------
  // 50: Cumulative resource load time
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-50', 'Cumulative Resource Load Time', 'major', () => {
    const totalDuration = allRequests.reduce((sum, r) => sum + (r.duration || 0), 0);
    const avgDuration = allRequests.length > 0 ? totalDuration / allRequests.length : 0;
    let status;
    if (avgDuration < 200) status = 'pass';
    else if (avgDuration < 500) status = 'warn';
    else status = 'fail';
    return { id: 'perf-50', name: 'Cumulative Resource Load Time', status, severity: 'major', value: totalDuration, details: `Cumulative load: ${Math.round(totalDuration)}ms across ${allRequests.length} requests (avg: ${Math.round(avgDuration)}ms/req)` };
  }));

  // -------------------------------------------------------------------------
  // 51: PNG images that could be WebP
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-51', 'PNG to WebP Opportunity', 'minor', () => {
    const pngImages = imageResources.filter(r => {
      const ct = (r.contentType || '').toLowerCase();
      const imgUrl = (r.url || '').toLowerCase();
      return ct.includes('image/png') || imgUrl.includes('.png');
    });
    const largePNGs = pngImages.filter(r => (r.size || 0) > 10 * 1024); // >10KB PNGs
    let status;
    if (largePNGs.length === 0) status = 'pass';
    else if (largePNGs.length <= 3) status = 'warn';
    else status = 'fail';
    return { id: 'perf-51', name: 'PNG to WebP Opportunity', status, severity: 'minor', value: largePNGs.length, details: `${largePNGs.length} PNG image(s) >10KB could be converted to WebP for ~25-35% savings` };
  }));

  // -------------------------------------------------------------------------
  // 52: JPEG images that could be WebP
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-52', 'JPEG to WebP Opportunity', 'minor', () => {
    const jpegImages = imageResources.filter(r => {
      const ct = (r.contentType || '').toLowerCase();
      const imgUrl = (r.url || '').toLowerCase();
      return ct.includes('image/jpeg') || ct.includes('image/jpg') || imgUrl.includes('.jpg') || imgUrl.includes('.jpeg');
    });
    const largeJPEGs = jpegImages.filter(r => (r.size || 0) > 50 * 1024); // >50KB JPEGs
    let status;
    if (largeJPEGs.length === 0) status = 'pass';
    else if (largeJPEGs.length <= 3) status = 'warn';
    else status = 'fail';
    return { id: 'perf-52', name: 'JPEG to WebP Opportunity', status, severity: 'minor', value: largeJPEGs.length, details: `${largeJPEGs.length} JPEG image(s) >50KB could be converted to WebP for ~25-35% savings` };
  }));

  // -------------------------------------------------------------------------
  // 53: BMP images detected
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-53', 'BMP Image Detection', 'major', () => {
    const bmpImages = imageResources.filter(r => {
      const ct = (r.contentType || '').toLowerCase();
      const imgUrl = (r.url || '').toLowerCase();
      return ct.includes('image/bmp') || ct.includes('image/x-bmp') || imgUrl.includes('.bmp');
    });
    const status = bmpImages.length === 0 ? 'pass' : 'fail';
    return { id: 'perf-53', name: 'BMP Image Detection', status, severity: 'major', value: bmpImages.length, details: bmpImages.length === 0 ? 'No BMP images detected' : `${bmpImages.length} BMP image(s) found - convert to WebP/PNG for massive size reduction` };
  }));

  // -------------------------------------------------------------------------
  // 54: TIFF images detected
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-54', 'TIFF Image Detection', 'major', () => {
    const tiffImages = imageResources.filter(r => {
      const ct = (r.contentType || '').toLowerCase();
      const imgUrl = (r.url || '').toLowerCase();
      return ct.includes('image/tiff') || imgUrl.includes('.tiff') || imgUrl.includes('.tif');
    });
    const status = tiffImages.length === 0 ? 'pass' : 'fail';
    return { id: 'perf-54', name: 'TIFF Image Detection', status, severity: 'major', value: tiffImages.length, details: tiffImages.length === 0 ? 'No TIFF images detected' : `${tiffImages.length} TIFF image(s) found - not supported by most browsers, convert to WebP/JPEG` };
  }));

  // -------------------------------------------------------------------------
  // 55: Async/defer on script tags
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-55', 'Script Async/Defer Usage', 'major', () => {
    const externalScripts = $('script[src]');
    if (externalScripts.length === 0) {
      return { id: 'perf-55', name: 'Script Async/Defer Usage', status: 'pass', severity: 'major', value: 'N/A', details: 'No external scripts found' };
    }
    let asyncDefer = 0;
    let total = 0;
    externalScripts.each((_, el) => {
      total++;
      if ($(el).attr('async') != null || $(el).attr('defer') != null || ($(el).attr('type') || '').toLowerCase() === 'module') {
        asyncDefer++;
      }
    });
    const pct = (asyncDefer / total * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 50) status = 'warn';
    else status = 'fail';
    return { id: 'perf-55', name: 'Script Async/Defer Usage', status, severity: 'major', value: `${pct}%`, details: `${asyncDefer}/${total} external scripts use async, defer, or type="module" (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 56: Module scripts
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-56', 'Module Scripts', 'minor', () => {
    const moduleScripts = $('script[type="module"]');
    const count = moduleScripts.length;
    const totalScripts = $('script[src]').length;
    return {
      id: 'perf-56', name: 'Module Scripts', status: count > 0 ? 'pass' : 'warn', severity: 'minor',
      value: count,
      details: count > 0 ? `${count} module script(s) found (modern JS modules with tree-shaking support)` : `No module scripts found - consider using type="module" for modern JS (${totalScripts} external scripts total)`
    };
  }));

  // -------------------------------------------------------------------------
  // 57: Source maps exposed
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-57', 'Source Maps Exposed', 'minor', () => {
    const sourceMaps = allRequests.filter(r => {
      const reqUrl = (r.url || '').toLowerCase();
      return reqUrl.endsWith('.map') || reqUrl.includes('.map?');
    });
    const status = sourceMaps.length === 0 ? 'pass' : 'warn';
    return { id: 'perf-57', name: 'Source Maps Exposed', status, severity: 'minor', value: sourceMaps.length, details: sourceMaps.length === 0 ? 'No source map files exposed in production' : `${sourceMaps.length} source map file(s) exposed - consider removing from production for security` };
  }));

  // -------------------------------------------------------------------------
  // 58: HTTP/2 or HTTP/3
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-58', 'HTTP/2 or HTTP/3 Protocol', 'major', () => {
    const withProtocol = allRequests.filter(r => r.protocol);
    if (withProtocol.length === 0) {
      return { id: 'perf-58', name: 'HTTP/2 or HTTP/3 Protocol', status: 'warn', severity: 'major', value: null, details: 'No protocol information available from network requests' };
    }
    const modernProtocol = withProtocol.filter(r => {
      const proto = (r.protocol || '').toLowerCase();
      return proto.includes('h2') || proto.includes('h3') || proto.includes('http/2') || proto.includes('http/3') || proto.includes('spdy');
    });
    const pct = (modernProtocol.length / withProtocol.length * 100).toFixed(0);
    let status;
    if (Number(pct) >= 80) status = 'pass';
    else if (Number(pct) >= 50) status = 'warn';
    else status = 'fail';
    return { id: 'perf-58', name: 'HTTP/2 or HTTP/3 Protocol', status, severity: 'major', value: `${pct}%`, details: `${modernProtocol.length}/${withProtocol.length} requests use HTTP/2 or HTTP/3 (${pct}%)` };
  }));

  // -------------------------------------------------------------------------
  // 59: Resource hints count (preload, prefetch, preconnect)
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-59', 'Resource Hints Count', 'minor', () => {
    const preload = $('link[rel="preload"]').length;
    const prefetch = $('link[rel="prefetch"]').length;
    const preconnect = $('link[rel="preconnect"]').length;
    const modulePreload = $('link[rel="modulepreload"]').length;
    const total = preload + prefetch + preconnect + modulePreload;
    let status;
    if (total >= 3) status = 'pass';
    else if (total >= 1) status = 'warn';
    else status = 'fail';
    return {
      id: 'perf-59', name: 'Resource Hints Count', status, severity: 'minor', value: total,
      details: `${total} resource hint(s): ${preload} preload, ${prefetch} prefetch, ${preconnect} preconnect, ${modulePreload} modulepreload`
    };
  }));

  // -------------------------------------------------------------------------
  // 60: Main thread blocking time (Lighthouse TBT)
  // -------------------------------------------------------------------------
  checks.push(safeCheck('perf-60', 'Main Thread Blocking Time', 'critical', () => {
    const value = getLighthouseNumericValue(lighthouseResults, 'total-blocking-time');
    if (value === null) {
      // Fallback: check for long tasks audit
      const longTasks = getLighthouseAudit(lighthouseResults, 'long-tasks');
      if (longTasks && longTasks.details && Array.isArray(longTasks.details.items)) {
        const totalBlocking = longTasks.details.items.reduce((sum, t) => sum + ((t.duration || 0) - 50), 0);
        let status;
        if (totalBlocking <= 200) status = 'pass';
        else if (totalBlocking <= 600) status = 'warn';
        else status = 'fail';
        return { id: 'perf-60', name: 'Main Thread Blocking Time', status, severity: 'critical', value: totalBlocking, details: `Main thread blocking time: ${Math.round(totalBlocking)}ms from ${longTasks.details.items.length} long task(s) (good: <200ms, poor: >600ms)` };
      }
      return { id: 'perf-60', name: 'Main Thread Blocking Time', status: 'warn', severity: 'critical', value: null, details: 'No Lighthouse data available for main thread blocking time' };
    }
    let status;
    if (value <= 200) status = 'pass';
    else if (value <= 600) status = 'warn';
    else status = 'fail';
    return { id: 'perf-60', name: 'Main Thread Blocking Time', status, severity: 'critical', value, details: `Total Blocking Time: ${Math.round(value)}ms (good: <200ms, poor: >600ms)` };
  }));

  return { checks };
}

module.exports = { analyzePerformance };
