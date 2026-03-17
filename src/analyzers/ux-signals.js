'use strict';

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a simplified tag skeleton from a root element.
 * Returns a string like "header>div>nav>ul>li*5>a" for structural comparison.
 */
function getSimplifiedStructure($, selector) {
  const el = $(selector).first();
  if (!el.length) return '';

  function walk(node, depth) {
    if (depth > 6) return '';
    const parts = [];
    $(node).children().each((_, child) => {
      const tag = child.tagName;
      if (!tag) return;
      const cls = ($(child).attr('class') || '').split(/\s+/).sort().join('.');
      const id = cls ? `${tag}.${cls}` : tag;
      const childStr = walk(child, depth + 1);
      parts.push(childStr ? `${id}>${childStr}` : id);
    });
    return parts.join('|');
  }

  return walk(el, 0);
}

/**
 * Extract all hex and rgb colors from a string of CSS/inline styles.
 */
function extractColors(text) {
  const colors = new Set();
  // hex
  const hexRe = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
  let m;
  while ((m = hexRe.exec(text)) !== null) colors.add(m[0].toLowerCase());
  // rgb/rgba
  const rgbRe = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/gi;
  while ((m = rgbRe.exec(text)) !== null) colors.add(m[0].toLowerCase().replace(/\s/g, ''));
  return [...colors];
}

/**
 * Extract all font-family declarations from CSS/inline styles.
 */
function extractFontFamilies(text) {
  const families = new Set();
  const re = /font-family\s*:\s*([^;}"]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    // Split on commas and take the first (primary) family
    const parts = raw.split(',').map(f => f.trim().replace(/['"]/g, '').toLowerCase());
    for (const p of parts) {
      if (p && !['inherit', 'initial', 'unset', 'revert'].includes(p)) {
        families.add(p);
      }
    }
  }
  return [...families];
}

/**
 * Gather all inline styles and <style> content from HTML.
 */
function getAllStyles($) {
  const parts = [];
  $('style').each((_, el) => parts.push($(el).html() || ''));
  $('[style]').each((_, el) => parts.push($(el).attr('style') || ''));
  return parts.join('\n');
}

/**
 * Extract border-radius values from CSS text.
 */
function extractBorderRadii(text) {
  const vals = new Set();
  const re = /border-radius\s*:\s*([^;}"]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) vals.add(m[1].trim().toLowerCase());
  return [...vals];
}

/**
 * Extract margin and padding values from CSS text.
 */
function extractSpacingValues(text) {
  const vals = [];
  const re = /(?:margin|padding)(?:-(?:top|right|bottom|left))?\s*:\s*([^;}"]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) vals.push(m[1].trim().toLowerCase());
  return vals;
}

/**
 * Create a check result object.
 */
function check(id, name, status, severity, value, details) {
  return { id, name, status, severity, value, details };
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

async function analyzeUXSignals(pageData, allPages, lighthouseResults) {
  const checks = [];
  const $ = cheerio.load(pageData.html || '');
  const allStyles = getAllStyles($);

  // Pre-parse all other pages for cross-page checks
  const otherParsed = [];
  for (const p of allPages) {
    if (p.url === pageData.url) continue;
    try {
      otherParsed.push({ url: p.url, $: cheerio.load(p.html || '') });
    } catch { /* skip unparseable */ }
  }

  // ---- CHECK 1: Consistent header across pages (major) ----
  try {
    const myHeader = getSimplifiedStructure($, 'header') || getSimplifiedStructure($, 'nav');
    let consistent = true;
    let compared = 0;
    for (const op of otherParsed) {
      const theirHeader = getSimplifiedStructure(op.$, 'header') || getSimplifiedStructure(op.$, 'nav');
      if (myHeader && theirHeader) {
        compared++;
        if (myHeader !== theirHeader) { consistent = false; break; }
      }
    }
    if (allPages.length < 2) {
      checks.push(check('ux-1', 'Consistent header across pages', 'info', 'major', 'single page', 'Only one page available, cannot compare headers'));
    } else if (!myHeader) {
      checks.push(check('ux-1', 'Consistent header across pages', 'fail', 'major', 'no header found', 'No <header> or <nav> element detected'));
    } else {
      checks.push(check('ux-1', 'Consistent header across pages', consistent ? 'pass' : 'fail', 'major', consistent ? 'consistent' : 'inconsistent', `Compared header structure across ${compared + 1} pages`));
    }
  } catch (e) {
    checks.push(check('ux-1', 'Consistent header across pages', 'error', 'major', null, e.message));
  }

  // ---- CHECK 2: Consistent footer across pages (major) ----
  try {
    const myFooter = getSimplifiedStructure($, 'footer');
    let consistent = true;
    let compared = 0;
    for (const op of otherParsed) {
      const theirFooter = getSimplifiedStructure(op.$, 'footer');
      if (myFooter && theirFooter) {
        compared++;
        if (myFooter !== theirFooter) { consistent = false; break; }
      }
    }
    if (allPages.length < 2) {
      checks.push(check('ux-2', 'Consistent footer across pages', 'info', 'major', 'single page', 'Only one page available, cannot compare footers'));
    } else if (!myFooter) {
      checks.push(check('ux-2', 'Consistent footer across pages', 'fail', 'major', 'no footer found', 'No <footer> element detected'));
    } else {
      checks.push(check('ux-2', 'Consistent footer across pages', consistent ? 'pass' : 'fail', 'major', consistent ? 'consistent' : 'inconsistent', `Compared footer structure across ${compared + 1} pages`));
    }
  } catch (e) {
    checks.push(check('ux-2', 'Consistent footer across pages', 'error', 'major', null, e.message));
  }

  // ---- CHECK 3: Consistent color scheme (minor) ----
  try {
    const colors = extractColors(allStyles);
    // Normalize hex to 6-digit form for grouping
    const normalizedColors = colors.map(c => {
      if (c.startsWith('#') && (c.length === 4 || c.length === 5)) {
        // expand shorthand
        const hex = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
        return hex;
      }
      return c;
    });
    const unique = new Set(normalizedColors);
    const pass = unique.size <= 15;
    checks.push(check('ux-3', 'Consistent color scheme', pass ? 'pass' : 'fail', 'minor', `${unique.size} unique colors`, pass ? 'Color palette appears controlled' : 'Too many unique colors suggest inconsistent scheme'));
  } catch (e) {
    checks.push(check('ux-3', 'Consistent color scheme', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 4: Consistent typography <= 3 font families (minor) ----
  try {
    const families = extractFontFamilies(allStyles);
    const pass = families.length <= 3;
    checks.push(check('ux-4', 'Consistent typography <= 3 font families', pass ? 'pass' : 'fail', 'minor', `${families.length} families: ${families.slice(0, 5).join(', ')}`, pass ? 'Font family count is within best practices' : 'More than 3 font families detected in inline/embedded styles'));
  } catch (e) {
    checks.push(check('ux-4', 'Consistent typography <= 3 font families', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 5: Font count <= 3 families from network requests (minor) ----
  try {
    const fontRequests = (pageData.networkRequests || []).filter(r =>
      r.resourceType === 'font' ||
      /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.url) ||
      (r.contentType && /font/i.test(r.contentType))
    );
    // Group by font family (approximate by filename)
    const fontFiles = fontRequests.map(r => {
      const match = r.url.match(/\/([^/?]+)\.(woff2?|ttf|otf|eot)/i);
      return match ? match[1].replace(/[-_](regular|bold|italic|light|medium|semibold|thin|black|extra|heavy|\d{3})/gi, '').toLowerCase() : null;
    }).filter(Boolean);
    const uniqueFonts = new Set(fontFiles);
    const pass = uniqueFonts.size <= 3;
    checks.push(check('ux-5', 'Font file count <= 3 families', pass ? 'pass' : 'fail', 'minor', `${uniqueFonts.size} font families loaded (${fontRequests.length} files)`, pass ? 'Font file count is reasonable' : `Font families detected: ${[...uniqueFonts].join(', ')}`));
  } catch (e) {
    checks.push(check('ux-5', 'Font file count <= 3 families', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 6: Color count <= 10 core colors (minor) ----
  try {
    const allColorText = allStyles + '\n' + (pageData.html || '');
    const colors = extractColors(allColorText);
    // Collapse similar hex colors (first 4 chars) to approximate core palette
    const coreMap = new Map();
    for (const c of colors) {
      if (c.startsWith('#')) {
        const key = c.slice(0, 4);
        if (!coreMap.has(key)) coreMap.set(key, c);
      } else {
        coreMap.set(c, c);
      }
    }
    const coreCount = coreMap.size;
    const pass = coreCount <= 10;
    checks.push(check('ux-6', 'Color count <= 10 core colors', pass ? 'pass' : 'fail', 'minor', `${coreCount} approximate core colors (${colors.length} total)`, pass ? 'Color palette is focused' : 'Excessive unique colors may indicate an inconsistent design system'));
  } catch (e) {
    checks.push(check('ux-6', 'Color count <= 10 core colors', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 7: Consistent button styling (minor) ----
  try {
    const buttons = [];
    $('button, a.btn, a.button, [role="button"], input[type="submit"], input[type="button"], .btn, .button').each((_, el) => {
      const style = $(el).attr('style') || '';
      const cls = $(el).attr('class') || '';
      buttons.push({ tag: el.tagName, style, cls });
    });
    if (buttons.length === 0) {
      checks.push(check('ux-7', 'Consistent button styling', 'info', 'minor', 'no buttons found', 'No button elements detected'));
    } else {
      // Check if buttons share similar class patterns
      const classPatterns = buttons.map(b => b.cls.split(/\s+/).sort().join(' '));
      const uniquePatterns = new Set(classPatterns);
      const pass = uniquePatterns.size <= 3;
      checks.push(check('ux-7', 'Consistent button styling', pass ? 'pass' : 'fail', 'minor', `${uniquePatterns.size} button style patterns across ${buttons.length} buttons`, pass ? 'Button styling appears consistent' : 'Many different button style patterns detected'));
    }
  } catch (e) {
    checks.push(check('ux-7', 'Consistent button styling', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 8: CTA is visually prominent (minor) ----
  try {
    const ctaSelectors = 'a.btn, a.button, a.cta, button.cta, [class*="cta"], [class*="primary"], a.btn-primary, button.btn-primary, a.btn-lg, button.btn-lg, [class*="hero"] a, [class*="hero"] button';
    const ctas = $(ctaSelectors);
    const hasLargeButton = $('a.btn-lg, button.btn-lg, a.btn-xl, button.btn-xl, [class*="btn-large"], [class*="button-large"]').length > 0;
    const hasPrimary = $('[class*="primary"], [class*="cta"]').length > 0;
    const pass = ctas.length > 0 || hasLargeButton || hasPrimary;
    checks.push(check('ux-8', 'CTA is visually prominent', pass ? 'pass' : 'fail', 'minor', pass ? `${ctas.length} CTA elements found` : 'no prominent CTAs', pass ? 'Page has prominent call-to-action elements' : 'No clearly prominent CTA buttons detected'));
  } catch (e) {
    checks.push(check('ux-8', 'CTA is visually prominent', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 9: Above-fold content loads fast - FCP (major) ----
  try {
    if (lighthouseResults && lighthouseResults.audits && lighthouseResults.audits['first-contentful-paint']) {
      const fcp = lighthouseResults.audits['first-contentful-paint'];
      const val = fcp.numericValue || 0;
      const pass = val < 2500;
      checks.push(check('ux-9', 'Above-fold content loads fast (FCP)', pass ? 'pass' : 'fail', 'major', `${Math.round(val)}ms`, pass ? 'FCP is under 2.5s' : 'FCP exceeds 2.5s threshold'));
    } else {
      // Fallback: use response time as proxy
      const rt = pageData.responseTime || 0;
      const pass = rt < 3000;
      checks.push(check('ux-9', 'Above-fold content loads fast (FCP)', pass ? 'pass' : 'fail', 'major', `${rt}ms response time (no Lighthouse data)`, pass ? 'Page responded within 3s' : 'Page response was slow'));
    }
  } catch (e) {
    checks.push(check('ux-9', 'Above-fold content loads fast (FCP)', 'error', 'major', null, e.message));
  }

  // ---- CHECK 10: Above-fold has meaningful content (minor) ----
  try {
    const body = $('body');
    const bodyText = body.text().replace(/\s+/g, ' ').trim();
    const first500 = bodyText.slice(0, 500);
    // Meaningful = at least 50 non-whitespace chars in first 500
    const meaningful = first500.replace(/\s/g, '').length >= 50;
    checks.push(check('ux-10', 'Above-fold has meaningful content', meaningful ? 'pass' : 'fail', 'minor', `${first500.replace(/\s/g, '').length} chars in first 500 of body text`, meaningful ? 'Page has meaningful text content near the top' : 'Very little text content found in the initial body'));
  } catch (e) {
    checks.push(check('ux-10', 'Above-fold has meaningful content', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 11: No auto-playing audio/video (major) ----
  try {
    const autoplayMedia = [];
    $('video[autoplay], audio[autoplay]').each((_, el) => {
      const muted = $(el).attr('muted') !== undefined;
      if (!muted) {
        autoplayMedia.push(el.tagName);
      }
    });
    // Also check for autoplay in iframes (e.g. YouTube embeds with autoplay=1)
    $('iframe[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (/autoplay=1/i.test(src) && !/mute=1/i.test(src)) {
        autoplayMedia.push('iframe');
      }
    });
    const pass = autoplayMedia.length === 0;
    checks.push(check('ux-11', 'No auto-playing audio/video', pass ? 'pass' : 'fail', 'major', pass ? 'no unmuted autoplay' : `${autoplayMedia.length} unmuted autoplay elements`, pass ? 'No intrusive auto-playing media detected' : `Unmuted autoplay detected: ${autoplayMedia.join(', ')}`));
  } catch (e) {
    checks.push(check('ux-11', 'No auto-playing audio/video', 'error', 'major', null, e.message));
  }

  // ---- CHECK 12: No intrusive pop-ups on load (major) ----
  try {
    const html = pageData.html || '';
    const modalPatterns = [
      /class\s*=\s*["'][^"']*\bmodal\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\boverlay\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\bpopup\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\blightbox\b[^"']*["']/i,
      /class\s*=\s*["'][^"']*\binterstitial\b[^"']*["']/i,
    ];
    // Check if modals are displayed by default (visible on load)
    const visibleModals = [];
    $('[class*="modal"], [class*="popup"], [class*="overlay"], [class*="lightbox"], [class*="interstitial"]').each((_, el) => {
      const style = $(el).attr('style') || '';
      const cls = $(el).attr('class') || '';
      // If display:block or visibility:visible or no hide class, could be on-load popup
      if (/display\s*:\s*block/i.test(style) || /display\s*:\s*flex/i.test(style)) {
        visibleModals.push(cls.split(/\s+/)[0]);
      }
    });
    // Also check for on-load JS popup triggers
    const onLoadPopup = /\b(?:setTimeout|setInterval)\s*\(\s*(?:function|\(\))\s*(?:=>)?\s*\{[^}]*(?:modal|popup|overlay)/i.test(html);
    const fail = visibleModals.length > 0 || onLoadPopup;
    checks.push(check('ux-12', 'No intrusive pop-ups on load', fail ? 'fail' : 'pass', 'major', fail ? `${visibleModals.length} visible modals, on-load popup: ${onLoadPopup}` : 'none detected', fail ? 'Intrusive pop-up patterns detected in page source' : 'No intrusive on-load popups detected'));
  } catch (e) {
    checks.push(check('ux-12', 'No intrusive pop-ups on load', 'error', 'major', null, e.message));
  }

  // ---- CHECK 13: Cookie consent present if tracking detected (minor) ----
  try {
    const html = pageData.html || '';
    const hasTracking =
      /google-analytics\.com|googletagmanager\.com|gtag|ga\s*\(|fbq\s*\(|hotjar|segment\.com|mixpanel/i.test(html);
    const hasCookieBanner =
      /cookie[-_\s]?(?:consent|banner|notice|popup|bar|policy)/i.test(html) ||
      $('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], [class*="gdpr"], [id*="gdpr"]').length > 0;

    if (!hasTracking) {
      checks.push(check('ux-13', 'Cookie consent present if tracking detected', 'pass', 'minor', 'no tracking detected', 'No third-party tracking scripts found'));
    } else {
      checks.push(check('ux-13', 'Cookie consent present if tracking detected', hasCookieBanner ? 'pass' : 'fail', 'minor', `tracking: yes, cookie consent: ${hasCookieBanner ? 'yes' : 'no'}`, hasCookieBanner ? 'Tracking scripts found and cookie consent is present' : 'Tracking scripts found but no cookie consent mechanism detected'));
    }
  } catch (e) {
    checks.push(check('ux-13', 'Cookie consent present if tracking detected', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 14: Search is findable (minor) ----
  try {
    const searchInputs = $('input[type="search"], [role="search"], input[name="q"], input[name="query"], input[name="search"], input[name="s"], [class*="search"] input, [id*="search"] input');
    const searchLinks = $('a[href*="search"], a[aria-label*="search" i]');
    const searchIcon = $('[class*="search"] svg, [class*="search"] i, .fa-search, .fa-magnifying-glass, [class*="icon-search"]');
    const hasSearch = searchInputs.length > 0 || searchLinks.length > 0 || searchIcon.length > 0;

    // Only flag if site has enough content to warrant search
    const pageCount = allPages.length;
    if (pageCount < 5) {
      checks.push(check('ux-14', 'Search is findable', 'info', 'minor', hasSearch ? 'search present' : 'no search (small site)', 'Site has fewer than 5 pages; search may not be necessary'));
    } else {
      checks.push(check('ux-14', 'Search is findable', hasSearch ? 'pass' : 'fail', 'minor', hasSearch ? 'search found' : 'no search', hasSearch ? 'Search functionality detected in header/nav area' : 'No search input or link found on a site with 5+ pages'));
    }
  } catch (e) {
    checks.push(check('ux-14', 'Search is findable', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 15: Consistent page layout pattern (minor) ----
  try {
    const myBodyStructure = getSimplifiedStructure($, 'body');
    let consistent = true;
    let compared = 0;
    for (const op of otherParsed) {
      const theirBody = getSimplifiedStructure(op.$, 'body');
      if (myBodyStructure && theirBody) {
        compared++;
        // Compare top-level children only (first level tags)
        const myTopLevel = myBodyStructure.split('|').map(s => s.split('>')[0]).join('|');
        const theirTopLevel = theirBody.split('|').map(s => s.split('>')[0]).join('|');
        if (myTopLevel !== theirTopLevel) { consistent = false; break; }
      }
    }
    if (allPages.length < 2) {
      checks.push(check('ux-15', 'Consistent page layout pattern', 'info', 'minor', 'single page', 'Only one page available'));
    } else {
      checks.push(check('ux-15', 'Consistent page layout pattern', consistent ? 'pass' : 'fail', 'minor', consistent ? 'consistent' : 'inconsistent', `Compared top-level body structure across ${compared + 1} pages`));
    }
  } catch (e) {
    checks.push(check('ux-15', 'Consistent page layout pattern', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 16: Proper visual hierarchy (minor) ----
  try {
    const headings = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      headings.push(parseInt(el.tagName.replace(/h/i, ''), 10));
    });
    if (headings.length === 0) {
      checks.push(check('ux-16', 'Proper visual hierarchy', 'fail', 'minor', 'no headings', 'No heading elements found'));
    } else {
      // Check that heading levels don't skip (e.g. h1 -> h3 with no h2)
      let skipped = false;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i] > headings[i - 1] + 1) {
          skipped = true;
          break;
        }
      }
      const hasH1 = headings.includes(1);
      const pass = hasH1 && !skipped;
      checks.push(check('ux-16', 'Proper visual hierarchy', pass ? 'pass' : 'fail', 'minor', `${headings.length} headings, h1: ${hasH1 ? 'yes' : 'no'}, skipped levels: ${skipped ? 'yes' : 'no'}`, pass ? 'Heading hierarchy is proper' : `Issues: ${!hasH1 ? 'missing h1' : ''}${skipped ? ' heading levels skipped' : ''}`));
    }
  } catch (e) {
    checks.push(check('ux-16', 'Proper visual hierarchy', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 17: Adequate white space (minor) ----
  try {
    const spacingVals = extractSpacingValues(allStyles);
    if (spacingVals.length === 0) {
      // No inline/embedded spacing means likely relies on external CSS (fine) or has none
      checks.push(check('ux-17', 'Adequate white space', 'info', 'minor', 'no inline spacing detected', 'Spacing may be defined in external stylesheets'));
    } else {
      // Check if there are meaningful non-zero spacing values
      const nonZero = spacingVals.filter(v => !/^0(px|em|rem|%)?$/.test(v));
      const pass = nonZero.length >= spacingVals.length * 0.3;
      checks.push(check('ux-17', 'Adequate white space', pass ? 'pass' : 'fail', 'minor', `${nonZero.length}/${spacingVals.length} non-zero spacing values`, pass ? 'Spacing values indicate adequate white space' : 'Many zero-margin/padding values suggest cramped layout'));
    }
  } catch (e) {
    checks.push(check('ux-17', 'Adequate white space', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 18: Content is scannable (minor) ----
  try {
    const paragraphs = [];
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 0) paragraphs.push(text);
    });
    const lists = $('ul, ol').length;
    const headingCount = $('h1, h2, h3, h4, h5, h6').length;

    if (paragraphs.length === 0) {
      checks.push(check('ux-18', 'Content is scannable', 'info', 'minor', 'no paragraphs', 'No paragraph content found'));
    } else {
      // Short paragraphs = avg under 150 words
      const avgWords = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).length, 0) / paragraphs.length;
      const hasStructure = lists > 0 || headingCount >= 2;
      const shortParas = avgWords <= 150;
      const pass = shortParas && hasStructure;
      checks.push(check('ux-18', 'Content is scannable', pass ? 'pass' : 'fail', 'minor', `avg ${Math.round(avgWords)} words/paragraph, ${lists} lists, ${headingCount} headings`, pass ? 'Content uses short paragraphs and structural elements' : `${!shortParas ? 'Paragraphs are too long. ' : ''}${!hasStructure ? 'Lacks lists or multiple headings for scannability.' : ''}`));
    }
  } catch (e) {
    checks.push(check('ux-18', 'Content is scannable', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 19: Important info above fold (minor) ----
  try {
    const bodyHtml = $('body').html() || '';
    // Check if h1 appears in the first 2000 chars of body HTML
    const firstChunk = bodyHtml.slice(0, 2000);
    const hasH1AboveFold = /<h1[\s>]/i.test(firstChunk);
    checks.push(check('ux-19', 'Important info above fold', hasH1AboveFold ? 'pass' : 'fail', 'minor', hasH1AboveFold ? 'h1 in first 2000 chars of body' : 'h1 not in first 2000 chars', hasH1AboveFold ? 'Primary heading appears near the top of the page' : 'H1 tag is missing or positioned far down the page'));
  } catch (e) {
    checks.push(check('ux-19', 'Important info above fold', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 20: No dead-end pages (minor) ----
  try {
    const internalLinks = (pageData.links && pageData.links.internal) || [];
    const ctaElements = $('a.btn, a.button, a.cta, button, [role="button"]').length;
    const totalNavigation = internalLinks.length + ctaElements;
    const pass = totalNavigation > 0;
    checks.push(check('ux-20', 'No dead-end pages', pass ? 'pass' : 'fail', 'minor', `${internalLinks.length} internal links, ${ctaElements} CTA elements`, pass ? 'Page has navigation and/or CTAs' : 'Page appears to be a dead end with no links or CTAs'));
  } catch (e) {
    checks.push(check('ux-20', 'No dead-end pages', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 21: Loading indicator for slow actions (minor) ----
  try {
    const html = pageData.html || '';
    const hasSpinner = /class\s*=\s*["'][^"']*\b(?:spinner|loading|loader|skeleton|shimmer|pulse)\b/i.test(html) ||
      $('[class*="spinner"], [class*="loading"], [class*="loader"], [class*="skeleton"], [class*="shimmer"]').length > 0 ||
      /\.spinner|\.loading|\.loader|@keyframes\s+(?:spin|pulse|bounce|loading)/i.test(allStyles);
    checks.push(check('ux-21', 'Loading indicator for slow actions', hasSpinner ? 'pass' : 'info', 'minor', hasSpinner ? 'loading patterns found' : 'no loading patterns', hasSpinner ? 'Loading/spinner patterns detected in page' : 'No explicit loading indicator patterns found (may use external JS framework)'));
  } catch (e) {
    checks.push(check('ux-21', 'Loading indicator for slow actions', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 22: Smooth scrolling (minor) ----
  try {
    const hasSmooth = /scroll-behavior\s*:\s*smooth/i.test(allStyles) ||
      /scroll-behavior\s*:\s*smooth/i.test(pageData.html || '') ||
      /scrollBehavior\s*[=:]\s*['"]smooth['"]/i.test(pageData.html || '') ||
      /smoothscroll|smooth-scroll/i.test(pageData.html || '');
    checks.push(check('ux-22', 'Smooth scrolling', hasSmooth ? 'pass' : 'info', 'minor', hasSmooth ? 'smooth scrolling enabled' : 'no smooth scrolling detected', hasSmooth ? 'CSS scroll-behavior: smooth or equivalent found' : 'No smooth scrolling CSS or library detected'));
  } catch (e) {
    checks.push(check('ux-22', 'Smooth scrolling', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 23: No layout shift during interaction - CLS (minor) ----
  try {
    if (lighthouseResults && lighthouseResults.audits && lighthouseResults.audits['cumulative-layout-shift']) {
      const cls = lighthouseResults.audits['cumulative-layout-shift'];
      const val = cls.numericValue || 0;
      const pass = val < 0.1;
      checks.push(check('ux-23', 'No layout shift (CLS)', pass ? 'pass' : 'fail', 'minor', `CLS: ${val.toFixed(3)}`, pass ? 'CLS is under 0.1 (good)' : 'CLS exceeds 0.1 threshold'));
    } else {
      // Heuristic: check for dimension-less images or iframes (common CLS causes)
      const imgNoSize = $('img:not([width]):not([height])').length;
      const pass = imgNoSize <= 2;
      checks.push(check('ux-23', 'No layout shift (CLS)', pass ? 'pass' : 'fail', 'minor', `${imgNoSize} images without dimensions (no Lighthouse data)`, pass ? 'Few images missing explicit dimensions' : 'Multiple images without width/height may cause layout shifts'));
    }
  } catch (e) {
    checks.push(check('ux-23', 'No layout shift (CLS)', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 24: Consistent iconography (minor) ----
  try {
    const html = pageData.html || '';
    const iconLibraries = [];
    if (/font-?awesome|fa-[\w-]+/i.test(html)) iconLibraries.push('Font Awesome');
    if (/material-?icons|mat-icon/i.test(html)) iconLibraries.push('Material Icons');
    if (/feather-?icon|data-feather/i.test(html)) iconLibraries.push('Feather Icons');
    if (/bootstrap-?icons|bi-[\w-]+/i.test(html)) iconLibraries.push('Bootstrap Icons');
    if (/ionicons|ion-icon/i.test(html)) iconLibraries.push('Ionicons');
    if (/heroicons/i.test(html)) iconLibraries.push('Heroicons');
    if (/lucide/i.test(html)) iconLibraries.push('Lucide');
    if (/phosphor/i.test(html)) iconLibraries.push('Phosphor');

    const svgIcons = $('svg').length;
    const imgIcons = $('img[src*="icon"], img[class*="icon"]').length;

    if (iconLibraries.length === 0 && svgIcons === 0 && imgIcons === 0) {
      checks.push(check('ux-24', 'Consistent iconography', 'info', 'minor', 'no icons detected', 'No icon library or icon elements found'));
    } else {
      const pass = iconLibraries.length <= 1;
      checks.push(check('ux-24', 'Consistent iconography', pass ? 'pass' : 'fail', 'minor', `libraries: ${iconLibraries.length > 0 ? iconLibraries.join(', ') : 'none'}, ${svgIcons} SVGs, ${imgIcons} icon images`, pass ? 'Consistent icon approach' : 'Multiple icon libraries may create visual inconsistency'));
    }
  } catch (e) {
    checks.push(check('ux-24', 'Consistent iconography', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 25: Professional appearance (minor) ----
  try {
    const networkRequests = pageData.networkRequests || [];
    // Check for broken images (images that returned 4xx/5xx)
    const brokenImages = networkRequests.filter(r =>
      (r.resourceType === 'image' || /\.(png|jpg|jpeg|gif|svg|webp|ico)/i.test(r.url)) &&
      r.status >= 400
    );
    // Check for failed CSS loads
    const brokenCSS = networkRequests.filter(r =>
      (r.resourceType === 'stylesheet' || /\.css(\?|$)/i.test(r.url)) &&
      r.status >= 400
    );
    const issues = [];
    if (brokenImages.length > 0) issues.push(`${brokenImages.length} broken images`);
    if (brokenCSS.length > 0) issues.push(`${brokenCSS.length} failed CSS loads`);

    const pass = issues.length === 0;
    checks.push(check('ux-25', 'Professional appearance', pass ? 'pass' : 'fail', 'minor', pass ? 'all assets load' : issues.join(', '), pass ? 'All images and CSS files loaded successfully' : `Asset loading issues: ${issues.join(', ')}`));
  } catch (e) {
    checks.push(check('ux-25', 'Professional appearance', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 26: Consistent spacing scale (minor) ----
  try {
    const spacingVals = extractSpacingValues(allStyles);
    if (spacingVals.length < 3) {
      checks.push(check('ux-26', 'Consistent spacing scale', 'info', 'minor', `${spacingVals.length} spacing values`, 'Not enough inline spacing data to evaluate scale'));
    } else {
      // Extract numeric pixel values
      const pxVals = [];
      for (const v of spacingVals) {
        const match = v.match(/^(\d+(?:\.\d+)?)px$/);
        if (match) pxVals.push(parseFloat(match[1]));
      }
      if (pxVals.length < 3) {
        checks.push(check('ux-26', 'Consistent spacing scale', 'info', 'minor', 'mostly non-px values', 'Spacing uses relative units or external styles'));
      } else {
        // Check if values follow a consistent scale (multiples of a base)
        const sorted = [...new Set(pxVals)].sort((a, b) => a - b).filter(v => v > 0);
        const base = sorted[0] || 4;
        const onScale = sorted.filter(v => v % base === 0 || v % 4 === 0 || v % 8 === 0);
        const ratio = onScale.length / sorted.length;
        const pass = ratio >= 0.6;
        checks.push(check('ux-26', 'Consistent spacing scale', pass ? 'pass' : 'fail', 'minor', `${Math.round(ratio * 100)}% of ${sorted.length} unique values align to a 4/8px grid`, pass ? 'Spacing follows a consistent scale' : 'Spacing values appear inconsistent'));
      }
    }
  } catch (e) {
    checks.push(check('ux-26', 'Consistent spacing scale', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 27: Dark mode support (minor) ----
  try {
    const hasDarkMode =
      /prefers-color-scheme\s*:\s*dark/i.test(allStyles) ||
      /prefers-color-scheme\s*:\s*dark/i.test(pageData.html || '') ||
      $('[data-theme="dark"], [data-mode="dark"], .dark-mode, .dark-theme').length > 0 ||
      /dark-?mode|dark-?theme|theme-?toggle/i.test(pageData.html || '');
    checks.push(check('ux-27', 'Dark mode support', hasDarkMode ? 'pass' : 'info', 'minor', hasDarkMode ? 'dark mode support detected' : 'no dark mode', hasDarkMode ? 'prefers-color-scheme: dark or dark mode toggle found' : 'No dark mode support detected'));
  } catch (e) {
    checks.push(check('ux-27', 'Dark mode support', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 28: Reduced motion support (minor) ----
  try {
    const hasReducedMotion =
      /prefers-reduced-motion/i.test(allStyles) ||
      /prefers-reduced-motion/i.test(pageData.html || '');
    checks.push(check('ux-28', 'Reduced motion support', hasReducedMotion ? 'pass' : 'info', 'minor', hasReducedMotion ? 'prefers-reduced-motion detected' : 'no reduced motion support', hasReducedMotion ? 'prefers-reduced-motion media query found' : 'No prefers-reduced-motion support detected'));
  } catch (e) {
    checks.push(check('ux-28', 'Reduced motion support', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 29: High-DPI/Retina support (minor) ----
  try {
    const hasSrcset = $('img[srcset]').length;
    const hasPicture = $('picture').length;
    const has2x = $('img[srcset*="2x"], source[srcset*="2x"]').length;
    const hasMediaDpr = /min-resolution\s*:\s*2dppx|min-device-pixel-ratio\s*:\s*2|-webkit-min-device-pixel-ratio\s*:\s*2/i.test(allStyles + (pageData.html || ''));
    const totalImages = $('img').length;

    if (totalImages === 0) {
      checks.push(check('ux-29', 'High-DPI/Retina support', 'info', 'minor', 'no images', 'No images found on page'));
    } else {
      const retinaSources = hasSrcset + hasPicture + has2x;
      const pass = retinaSources > 0 || hasMediaDpr;
      checks.push(check('ux-29', 'High-DPI/Retina support', pass ? 'pass' : 'fail', 'minor', `${hasSrcset} srcset, ${hasPicture} picture, ${has2x} 2x refs out of ${totalImages} images`, pass ? 'Retina/high-DPI image support detected' : 'No srcset, picture elements, or 2x images found'));
    }
  } catch (e) {
    checks.push(check('ux-29', 'High-DPI/Retina support', 'error', 'minor', null, e.message));
  }

  // ---- CHECK 30: Consistent border/radius styling (minor) ----
  try {
    const radii = extractBorderRadii(allStyles);
    if (radii.length === 0) {
      checks.push(check('ux-30', 'Consistent border-radius styling', 'info', 'minor', 'no border-radius found', 'No border-radius values in inline/embedded styles'));
    } else {
      const unique = new Set(radii);
      const pass = unique.size <= 4;
      checks.push(check('ux-30', 'Consistent border-radius styling', pass ? 'pass' : 'fail', 'minor', `${unique.size} unique border-radius values: ${[...unique].slice(0, 5).join(', ')}`, pass ? 'Border-radius values are consistent' : 'Too many different border-radius values suggest inconsistent design'));
    }
  } catch (e) {
    checks.push(check('ux-30', 'Consistent border-radius styling', 'error', 'minor', null, e.message));
  }

  return { checks };
}

module.exports = { analyzeUXSignals };
