'use strict';

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(id, name, status, severity, value, details) {
  return {
    id: `mobile-${id}`,
    name,
    status,   // 'pass' | 'fail' | 'warning' | 'info'
    severity, // 'critical' | 'major' | 'minor'
    value,
    details,
  };
}

/**
 * Extract all CSS text from <style> tags and inline style attributes.
 */
function collectCSS($) {
  const blocks = [];
  $('style').each((_, el) => {
    blocks.push($(el).text());
  });
  return blocks.join('\n');
}

/**
 * Collect all inline style attribute values.
 */
function collectInlineStyles($) {
  const styles = [];
  $('[style]').each((_, el) => {
    styles.push($(el).attr('style') || '');
  });
  return styles;
}

/**
 * Parse the viewport meta content string into key-value pairs.
 */
function parseViewportContent(content) {
  if (!content) return {};
  const pairs = {};
  content.split(/[,;]\s*/).forEach((part) => {
    const [key, ...rest] = part.split('=');
    if (key) pairs[key.trim().toLowerCase()] = (rest.join('=') || '').trim().toLowerCase();
  });
  return pairs;
}

/**
 * Find numeric fixed-width values in CSS/inline styles (in px).
 */
function findFixedWidths(cssText) {
  const widths = [];
  const re = /width\s*:\s*(\d+(?:\.\d+)?)\s*px/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    widths.push(parseFloat(m[1]));
  }
  return widths;
}

/**
 * Extract font-size values in px from CSS text.
 */
function findFontSizes(cssText) {
  const sizes = [];
  const re = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    sizes.push(parseFloat(m[1]));
  }
  return sizes;
}

/**
 * Extract line-height values from CSS text.
 */
function findLineHeights(cssText) {
  const heights = [];
  // unitless line-height
  const re1 = /line-height\s*:\s*(\d+(?:\.\d+)?)\s*(?:;|\s|$)/gi;
  let m;
  while ((m = re1.exec(cssText)) !== null) {
    heights.push(parseFloat(m[1]));
  }
  return heights;
}

/**
 * Check if CSS text contains @media queries.
 */
function findMediaQueries(cssText) {
  const queries = [];
  const re = /@media\s*\([^)]*\)/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    queries.push(m[0]);
  }
  return queries;
}

/**
 * Extract breakpoint pixel values from media queries.
 */
function extractBreakpoints(mediaQueries) {
  const bps = new Set();
  for (const q of mediaQueries) {
    const re = /(\d+)\s*px/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      bps.add(parseInt(m[1], 10));
    }
  }
  return Array.from(bps).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

async function analyzeMobile(pageData, lighthouseResults) {
  const checks = [];
  const html = (pageData && pageData.html) || '';
  const $ = cheerio.load(html);
  const cssText = collectCSS($);
  const inlineStyles = collectInlineStyles($);
  const allStyleText = cssText + '\n' + inlineStyles.join('\n');

  // Parse viewport meta
  const viewportMeta = $('meta[name="viewport"]');
  const viewportContent = viewportMeta.length > 0 ? (viewportMeta.attr('content') || '') : '';
  const vpParsed = parseViewportContent(viewportContent);

  // -----------------------------------------------------------------------
  // CHECK 1: Viewport meta tag present
  // -----------------------------------------------------------------------
  try {
    const present = viewportMeta.length > 0;
    checks.push(makeCheck(
      1,
      'Viewport meta tag present',
      present ? 'pass' : 'fail',
      'critical',
      present ? 'Present' : 'Missing',
      present
        ? 'The page has a viewport meta tag.'
        : 'No <meta name="viewport"> found. This is required for mobile rendering.',
    ));
  } catch (e) {
    checks.push(makeCheck(1, 'Viewport meta tag present', 'warning', 'critical', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 2: Viewport uses width=device-width
  // -----------------------------------------------------------------------
  try {
    const hasDeviceWidth = vpParsed['width'] === 'device-width';
    checks.push(makeCheck(
      2,
      'Viewport uses width=device-width',
      hasDeviceWidth ? 'pass' : 'fail',
      'critical',
      hasDeviceWidth ? 'width=device-width' : (vpParsed['width'] || 'Not set'),
      hasDeviceWidth
        ? 'Viewport correctly uses width=device-width.'
        : 'Viewport should set width=device-width for proper mobile scaling.',
    ));
  } catch (e) {
    checks.push(makeCheck(2, 'Viewport uses width=device-width', 'warning', 'critical', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 3: No user-scalable=no (allows pinch zoom)
  // -----------------------------------------------------------------------
  try {
    const userScalable = vpParsed['user-scalable'];
    const blocked = userScalable === 'no' || userScalable === '0';
    const maxScale = vpParsed['maximum-scale'];
    const maxScaleBlocked = maxScale && parseFloat(maxScale) < 2;
    const hasProblem = blocked || maxScaleBlocked;
    checks.push(makeCheck(
      3,
      'Allows pinch zoom (no user-scalable=no)',
      hasProblem ? 'fail' : 'pass',
      'major',
      hasProblem ? 'Zoom restricted' : 'Zoom allowed',
      hasProblem
        ? 'Pinch-to-zoom is disabled or restricted. user-scalable=no or maximum-scale < 2 found.'
        : 'Users can pinch-to-zoom freely.',
    ));
  } catch (e) {
    checks.push(makeCheck(3, 'Allows pinch zoom (no user-scalable=no)', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 4: Renders correctly at 375px (responsive indicators)
  // -----------------------------------------------------------------------
  try {
    const hasViewport = viewportMeta.length > 0 && vpParsed['width'] === 'device-width';
    const mediaQs = findMediaQueries(cssText);
    const hasMedia = mediaQs.length > 0;
    const ok = hasViewport || hasMedia;
    checks.push(makeCheck(
      4,
      'Responsive at 375px (mobile)',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'Responsive indicators found' : 'No responsive indicators',
      ok
        ? 'Page has viewport meta and/or media queries for mobile rendering.'
        : 'No viewport meta with device-width or media queries detected. Page may not render well at 375px.',
    ));
  } catch (e) {
    checks.push(makeCheck(4, 'Responsive at 375px (mobile)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 5: Renders correctly at 768px (tablet)
  // -----------------------------------------------------------------------
  try {
    const hasViewport = viewportMeta.length > 0 && vpParsed['width'] === 'device-width';
    const mediaQs = findMediaQueries(cssText);
    const bps = extractBreakpoints(mediaQs);
    const hasTabletBp = bps.some((bp) => bp >= 700 && bp <= 800);
    const ok = hasViewport || hasTabletBp;
    checks.push(makeCheck(
      5,
      'Responsive at 768px (tablet)',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'Responsive indicators found' : 'No tablet breakpoint detected',
      ok
        ? 'Page has viewport meta or a breakpoint near 768px.'
        : 'No responsive indicators for tablet width detected.',
    ));
  } catch (e) {
    checks.push(makeCheck(5, 'Responsive at 768px (tablet)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 6: Renders correctly at 1440px (desktop)
  // -----------------------------------------------------------------------
  try {
    const hasViewport = viewportMeta.length > 0;
    const mediaQs = findMediaQueries(cssText);
    const bps = extractBreakpoints(mediaQs);
    const hasDesktopBp = bps.some((bp) => bp >= 1200 && bp <= 1500);
    const ok = hasViewport || hasDesktopBp || mediaQs.length > 0;
    checks.push(makeCheck(
      6,
      'Responsive at 1440px (desktop)',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'Responsive indicators found' : 'No desktop breakpoint detected',
      ok
        ? 'Page has responsive features for desktop rendering.'
        : 'No responsive indicators for 1440px desktop width detected.',
    ));
  } catch (e) {
    checks.push(makeCheck(6, 'Responsive at 1440px (desktop)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 7: No horizontal scrollbar at mobile (375px)
  // -----------------------------------------------------------------------
  try {
    const fixedWidths = findFixedWidths(allStyleText);
    const overflowing = fixedWidths.filter((w) => w > 375);
    const ok = overflowing.length === 0;
    checks.push(makeCheck(
      7,
      'No horizontal scrollbar at mobile (375px)',
      ok ? 'pass' : 'fail',
      'major',
      ok ? 'No fixed widths > 375px' : `${overflowing.length} element(s) > 375px`,
      ok
        ? 'No fixed-width elements exceeding 375px found in styles.'
        : `Found ${overflowing.length} fixed-width value(s) exceeding 375px: ${overflowing.slice(0, 5).join(', ')}px. These may cause horizontal scrolling on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(7, 'No horizontal scrollbar at mobile (375px)', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 8: No horizontal scrollbar at tablet (768px)
  // -----------------------------------------------------------------------
  try {
    const fixedWidths = findFixedWidths(allStyleText);
    const overflowing = fixedWidths.filter((w) => w > 768);
    const ok = overflowing.length === 0;
    checks.push(makeCheck(
      8,
      'No horizontal scrollbar at tablet (768px)',
      ok ? 'pass' : 'fail',
      'minor',
      ok ? 'No fixed widths > 768px' : `${overflowing.length} element(s) > 768px`,
      ok
        ? 'No fixed-width elements exceeding 768px found in styles.'
        : `Found ${overflowing.length} fixed-width value(s) exceeding 768px: ${overflowing.slice(0, 5).join(', ')}px. These may cause horizontal scrolling on tablets.`,
    ));
  } catch (e) {
    checks.push(makeCheck(8, 'No horizontal scrollbar at tablet (768px)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 9: No content overflow at mobile
  // -----------------------------------------------------------------------
  try {
    const fixedWidths = findFixedWidths(allStyleText);
    const overflowing = fixedWidths.filter((w) => w > 375);
    // Also check for overflow-x: hidden which masks the problem
    const hasOverflowHidden = /overflow-x\s*:\s*hidden/i.test(allStyleText);
    const ok = overflowing.length === 0;
    checks.push(makeCheck(
      9,
      'No content overflow at mobile',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'No overflow detected' : `${overflowing.length} potential overflow(s)`,
      ok
        ? 'No fixed-width elements that could cause content overflow on mobile.'
        : `Found ${overflowing.length} element(s) with fixed widths > 375px.${hasOverflowHidden ? ' Note: overflow-x:hidden detected which may mask the problem.' : ''}`,
    ));
  } catch (e) {
    checks.push(makeCheck(9, 'No content overflow at mobile', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 10: Font size >= 16px base on mobile
  // -----------------------------------------------------------------------
  try {
    const fontSizes = findFontSizes(allStyleText);
    // Check body/html font-size specifically
    const bodyStyle = $('body').attr('style') || '';
    const htmlStyle = $('html').attr('style') || '';
    const baseSizes = findFontSizes(bodyStyle + ' ' + htmlStyle);
    // Check style tags for body/html rules
    const bodyRuleMatch = cssText.match(/(?:body|html)\s*\{[^}]*font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    if (bodyRuleMatch) baseSizes.push(parseFloat(bodyRuleMatch[1]));

    const smallBase = baseSizes.filter((s) => s < 16);
    const hasSmallFonts = smallBase.length > 0;
    // Also flag if there are many small font-sizes overall
    const smallAll = fontSizes.filter((s) => s < 12);

    checks.push(makeCheck(
      10,
      'Base font size >= 16px on mobile',
      hasSmallFonts ? 'fail' : (smallAll.length > 3 ? 'warning' : 'pass'),
      'major',
      hasSmallFonts ? `Base: ${smallBase[0]}px` : (baseSizes.length > 0 ? `Base: ${baseSizes[0]}px` : 'No explicit base size'),
      hasSmallFonts
        ? `Base font-size is ${smallBase[0]}px which is below the recommended 16px for mobile readability.`
        : smallAll.length > 3
          ? `Base font-size appears adequate, but ${smallAll.length} elements use font-size < 12px.`
          : 'Base font size is adequate for mobile readability.',
    ));
  } catch (e) {
    checks.push(makeCheck(10, 'Base font size >= 16px on mobile', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 11: Line height >= 1.4
  // -----------------------------------------------------------------------
  try {
    const lineHeights = findLineHeights(allStyleText);
    // Filter for unitless values that look like ratios (0.5 - 5)
    const ratios = lineHeights.filter((lh) => lh >= 0.5 && lh <= 5);
    const tooTight = ratios.filter((lh) => lh < 1.4);
    const ok = tooTight.length === 0;
    checks.push(makeCheck(
      11,
      'Line height >= 1.4',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? (ratios.length > 0 ? `Min: ${Math.min(...ratios)}` : 'No explicit line-height') : `${tooTight.length} tight line-height(s)`,
      ok
        ? 'Line heights are adequate for mobile readability.'
        : `Found ${tooTight.length} line-height value(s) below 1.4: ${tooTight.slice(0, 5).join(', ')}. Tight line heights reduce readability on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(11, 'Line height >= 1.4', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 12: Touch targets >= 44x44px
  // -----------------------------------------------------------------------
  try {
    const smallTargets = [];
    $('a, button, input[type="submit"], input[type="button"], [role="button"]').each((_, el) => {
      const style = $(el).attr('style') || '';
      // Check for explicit small height/width
      const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      const widthMatch = style.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      if (heightMatch && parseFloat(heightMatch[1]) < 44) {
        smallTargets.push({ tag: el.tagName, height: parseFloat(heightMatch[1]) });
      } else if (widthMatch && parseFloat(widthMatch[1]) < 44) {
        smallTargets.push({ tag: el.tagName, width: parseFloat(widthMatch[1]) });
      }
    });
    const ok = smallTargets.length === 0;
    checks.push(makeCheck(
      12,
      'Touch targets >= 44x44px',
      ok ? 'pass' : 'fail',
      'major',
      ok ? 'All targets adequate' : `${smallTargets.length} small target(s)`,
      ok
        ? 'No explicitly undersized touch targets found.'
        : `Found ${smallTargets.length} touch target(s) with explicit dimensions below 44px. Small targets are hard to tap on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(12, 'Touch targets >= 44x44px', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 13: Touch targets adequate spacing
  // -----------------------------------------------------------------------
  try {
    // Check for margin/padding on interactive elements
    let hasSpacing = true;
    const interactiveCount = $('a, button, input, select, textarea, [role="button"]').length;
    // Check for dense link groups (e.g. lists of links with no padding)
    const denseIndicators = $('a + a, button + button').length;
    const hasCrowding = denseIndicators > 5 && interactiveCount > 10;
    checks.push(makeCheck(
      13,
      'Touch target spacing adequate',
      hasCrowding ? 'warning' : 'pass',
      'minor',
      hasCrowding ? `${denseIndicators} adjacent targets` : 'Spacing appears adequate',
      hasCrowding
        ? `Found ${denseIndicators} adjacent interactive elements which may be too closely spaced on mobile.`
        : 'Interactive elements appear to have adequate spacing.',
    ));
  } catch (e) {
    checks.push(makeCheck(13, 'Touch target spacing adequate', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 14: No tiny clickable elements
  // -----------------------------------------------------------------------
  try {
    const tinyLinks = [];
    $('a, button, [role="button"]').each((_, el) => {
      const style = $(el).attr('style') || '';
      const fsMatch = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      if (fsMatch && parseFloat(fsMatch[1]) < 10) {
        tinyLinks.push({ tag: el.tagName, fontSize: parseFloat(fsMatch[1]) });
      }
    });
    const ok = tinyLinks.length === 0;
    checks.push(makeCheck(
      14,
      'No tiny clickable elements',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'No tiny clickables' : `${tinyLinks.length} tiny element(s)`,
      ok
        ? 'No clickable elements with very small font sizes found.'
        : `Found ${tinyLinks.length} clickable element(s) with font-size below 10px. These are difficult to read and tap on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(14, 'No tiny clickable elements', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 15: Images scale with viewport
  // -----------------------------------------------------------------------
  try {
    const totalImages = $('img').length;
    let responsiveCount = 0;
    $('img').each((_, el) => {
      const style = $(el).attr('style') || '';
      const cls = $(el).attr('class') || '';
      if (/max-width\s*:\s*100%/i.test(style) || /img-fluid|img-responsive|w-full|w-100/i.test(cls)) {
        responsiveCount++;
      }
    });
    // Also check global CSS for img { max-width: 100% }
    const globalImgResponsive = /img\s*\{[^}]*max-width\s*:\s*100%/i.test(cssText);
    const ok = totalImages === 0 || globalImgResponsive || responsiveCount === totalImages;
    checks.push(makeCheck(
      15,
      'Images scale with viewport',
      ok ? 'pass' : (responsiveCount > 0 || globalImgResponsive ? 'warning' : 'fail'),
      'minor',
      totalImages === 0 ? 'No images' : `${responsiveCount}/${totalImages} responsive`,
      ok
        ? globalImgResponsive ? 'Global img max-width:100% rule found.' : (totalImages === 0 ? 'No images on the page.' : 'All images have responsive styling.')
        : `${totalImages - responsiveCount} of ${totalImages} images may not scale with viewport. Consider adding max-width:100% or responsive classes.`,
    ));
  } catch (e) {
    checks.push(makeCheck(15, 'Images scale with viewport', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 16: srcset/sizes on images
  // -----------------------------------------------------------------------
  try {
    const totalImages = $('img').length;
    let srcsetCount = 0;
    $('img').each((_, el) => {
      if ($(el).attr('srcset')) srcsetCount++;
    });
    const ok = totalImages === 0 || srcsetCount > 0;
    checks.push(makeCheck(
      16,
      'Images use srcset/sizes',
      ok ? 'pass' : 'warning',
      'minor',
      totalImages === 0 ? 'No images' : `${srcsetCount}/${totalImages} with srcset`,
      ok
        ? totalImages === 0 ? 'No images on the page.' : `${srcsetCount} image(s) use srcset for responsive loading.`
        : 'No images use srcset attribute. Consider adding srcset/sizes for responsive image loading.',
    ));
  } catch (e) {
    checks.push(makeCheck(16, 'Images use srcset/sizes', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 17: picture element for art direction
  // -----------------------------------------------------------------------
  try {
    const pictureCount = $('picture').length;
    const totalImages = $('img').length;
    const ok = pictureCount > 0 || totalImages === 0;
    checks.push(makeCheck(
      17,
      'Picture element for art direction',
      ok ? 'pass' : 'info',
      'minor',
      pictureCount > 0 ? `${pictureCount} <picture> element(s)` : 'None found',
      ok
        ? `Found ${pictureCount} <picture> element(s) for responsive art direction.`
        : 'No <picture> elements found. Consider using <picture> for art direction across breakpoints.',
    ));
  } catch (e) {
    checks.push(makeCheck(17, 'Picture element for art direction', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 18: No fixed-width elements > viewport
  // -----------------------------------------------------------------------
  try {
    const fixedWidths = findFixedWidths(allStyleText);
    const tooWide = fixedWidths.filter((w) => w > 375);
    const ok = tooWide.length === 0;
    checks.push(makeCheck(
      18,
      'No fixed-width elements exceeding viewport',
      ok ? 'pass' : 'fail',
      'major',
      ok ? 'No oversized elements' : `${tooWide.length} element(s) > 375px`,
      ok
        ? 'No fixed-width elements wider than the mobile viewport found.'
        : `Found ${tooWide.length} element(s) with fixed widths > 375px: ${tooWide.slice(0, 5).map((w) => w + 'px').join(', ')}. These break mobile layouts.`,
    ));
  } catch (e) {
    checks.push(makeCheck(18, 'No fixed-width elements exceeding viewport', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 19: Tables are scrollable or responsive
  // -----------------------------------------------------------------------
  try {
    const tables = $('table');
    const tableCount = tables.length;
    let responsiveCount = 0;
    tables.each((_, el) => {
      const parent = $(el).parent();
      const parentClass = (parent.attr('class') || '').toLowerCase();
      const parentStyle = (parent.attr('style') || '').toLowerCase();
      const tableClass = ($(el).attr('class') || '').toLowerCase();
      const tableStyle = ($(el).attr('style') || '').toLowerCase();
      if (
        /table-responsive|overflow-x\s*:\s*(auto|scroll)|overflow\s*:\s*(auto|scroll)/i.test(parentClass + ' ' + parentStyle) ||
        /table-responsive/i.test(tableClass) ||
        /overflow/i.test(tableStyle) ||
        /display\s*:\s*block/i.test(tableStyle)
      ) {
        responsiveCount++;
      }
    });
    const ok = tableCount === 0 || responsiveCount === tableCount;
    checks.push(makeCheck(
      19,
      'Tables are scrollable or responsive',
      ok ? 'pass' : 'warning',
      'minor',
      tableCount === 0 ? 'No tables' : `${responsiveCount}/${tableCount} responsive`,
      ok
        ? tableCount === 0 ? 'No tables on the page.' : 'All tables have responsive or scrollable wrappers.'
        : `${tableCount - responsiveCount} of ${tableCount} table(s) lack responsive/scrollable wrappers. Tables may overflow on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(19, 'Tables are scrollable or responsive', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 20: Forms usable on mobile
  // -----------------------------------------------------------------------
  try {
    const inputs = $('input, select, textarea');
    const inputCount = inputs.length;
    let smallInputs = 0;
    inputs.each((_, el) => {
      const style = $(el).attr('style') || '';
      const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      const fsMatch = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      if ((heightMatch && parseFloat(heightMatch[1]) < 32) || (fsMatch && parseFloat(fsMatch[1]) < 14)) {
        smallInputs++;
      }
    });
    const ok = inputCount === 0 || smallInputs === 0;
    checks.push(makeCheck(
      20,
      'Forms usable on mobile',
      ok ? 'pass' : 'warning',
      'minor',
      inputCount === 0 ? 'No form fields' : (smallInputs > 0 ? `${smallInputs} small input(s)` : 'Inputs appear adequate'),
      ok
        ? inputCount === 0 ? 'No form fields on the page.' : 'Form inputs appear to be adequately sized for mobile.'
        : `${smallInputs} form input(s) may be too small for comfortable mobile use (height < 32px or font-size < 14px).`,
    ));
  } catch (e) {
    checks.push(makeCheck(20, 'Forms usable on mobile', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 21: Input types use correct mobile keyboard
  // -----------------------------------------------------------------------
  try {
    const issues = [];
    $('input').each((_, el) => {
      const type = ($(el).attr('type') || 'text').toLowerCase();
      const name = ($(el).attr('name') || '').toLowerCase();
      const id = ($(el).attr('id') || '').toLowerCase();
      const placeholder = ($(el).attr('placeholder') || '').toLowerCase();
      const combined = name + ' ' + id + ' ' + placeholder;

      if (type === 'text') {
        if (/email|e-mail/.test(combined)) {
          issues.push(`Input "${name || id || 'unnamed'}" looks like email but uses type="text"`);
        } else if (/phone|tel|mobile|cell/.test(combined)) {
          issues.push(`Input "${name || id || 'unnamed'}" looks like phone but uses type="text"`);
        } else if (/url|website|site/.test(combined)) {
          issues.push(`Input "${name || id || 'unnamed'}" looks like URL but uses type="text"`);
        } else if (/zip|postal/.test(combined)) {
          issues.push(`Input "${name || id || 'unnamed'}" looks like number but uses type="text"`);
        }
      }
    });
    const ok = issues.length === 0;
    checks.push(makeCheck(
      21,
      'Input types use correct mobile keyboard',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'Correct input types' : `${issues.length} issue(s)`,
      ok
        ? 'All inputs appear to use appropriate type attributes for mobile keyboards.'
        : `${issues.length} input(s) may use incorrect type for mobile keyboards: ${issues.slice(0, 3).join('; ')}.`,
    ));
  } catch (e) {
    checks.push(makeCheck(21, 'Input types use correct mobile keyboard', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 22: Autocomplete attributes on form fields
  // -----------------------------------------------------------------------
  try {
    const formInputs = $('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="password"], input[type="search"], input:not([type])');
    const total = formInputs.length;
    let withAutocomplete = 0;
    formInputs.each((_, el) => {
      if ($(el).attr('autocomplete')) withAutocomplete++;
    });
    const ok = total === 0 || withAutocomplete > 0;
    checks.push(makeCheck(
      22,
      'Autocomplete attributes on form fields',
      ok ? 'pass' : 'warning',
      'minor',
      total === 0 ? 'No text inputs' : `${withAutocomplete}/${total} with autocomplete`,
      ok
        ? total === 0 ? 'No text inputs found.' : `${withAutocomplete} of ${total} text input(s) have autocomplete attributes.`
        : 'No form fields have autocomplete attributes. Adding autocomplete helps mobile users fill forms faster.',
    ));
  } catch (e) {
    checks.push(makeCheck(22, 'Autocomplete attributes on form fields', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 23: No hover-only interactions
  // -----------------------------------------------------------------------
  try {
    const hoverRules = (cssText.match(/:hover/gi) || []).length;
    // Check for corresponding focus/active/touch handlers
    const focusRules = (cssText.match(/:focus/gi) || []).length;
    const activeRules = (cssText.match(/:active/gi) || []).length;
    const hasHoverOnly = hoverRules > 0 && focusRules === 0 && activeRules === 0;
    checks.push(makeCheck(
      23,
      'No hover-only interactions',
      hasHoverOnly ? 'warning' : 'pass',
      'minor',
      hoverRules === 0 ? 'No :hover rules' : `${hoverRules} :hover, ${focusRules} :focus, ${activeRules} :active`,
      hasHoverOnly
        ? `Found ${hoverRules} :hover rule(s) but no :focus or :active alternatives. Hover interactions are not available on touch devices.`
        : hoverRules === 0
          ? 'No :hover CSS rules found in inline styles.'
          : `Found ${hoverRules} :hover rule(s) with ${focusRules} :focus and ${activeRules} :active alternatives.`,
    ));
  } catch (e) {
    checks.push(makeCheck(23, 'No hover-only interactions', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 24: Mobile navigation present
  // -----------------------------------------------------------------------
  try {
    const hamburger = $(
      '.hamburger, .burger, .nav-toggle, .menu-toggle, .navbar-toggler, .mobile-menu, .mobile-nav, ' +
      '[class*="hamburger"], [class*="burger"], [class*="nav-toggle"], [class*="menu-toggle"], ' +
      '[aria-label*="menu" i], [aria-label*="navigation" i], ' +
      'button[data-toggle="collapse"], button[data-bs-toggle="collapse"]'
    ).length;
    const nav = $('nav, [role="navigation"]').length;
    const hasDrawer = $('[class*="drawer"], [class*="sidebar"], [class*="offcanvas"], [class*="slide-menu"]').length > 0;
    const hasMobileNav = hamburger > 0 || hasDrawer;
    const hasAnyNav = nav > 0;

    checks.push(makeCheck(
      24,
      'Mobile navigation present',
      hasMobileNav ? 'pass' : (hasAnyNav ? 'warning' : 'fail'),
      'major',
      hasMobileNav ? 'Mobile nav found' : (hasAnyNav ? 'Nav exists but no mobile toggle' : 'No navigation found'),
      hasMobileNav
        ? 'Mobile navigation pattern detected (hamburger menu, toggle, or drawer).'
        : hasAnyNav
          ? 'Navigation element found but no mobile toggle/hamburger pattern detected. Navigation may be difficult to use on mobile.'
          : 'No navigation element found on the page.',
    ));
  } catch (e) {
    checks.push(makeCheck(24, 'Mobile navigation present', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 25: Mobile nav is usable
  // -----------------------------------------------------------------------
  try {
    const toggleButtons = $(
      'button[aria-expanded], [role="button"][aria-expanded], ' +
      'button[data-toggle], button[data-bs-toggle], ' +
      '.navbar-toggler, .nav-toggle, .menu-toggle'
    );
    const hasAriaExpanded = $('[aria-expanded]').length > 0;
    const hasToggle = toggleButtons.length > 0;
    const ok = hasToggle || hasAriaExpanded;
    checks.push(makeCheck(
      25,
      'Mobile nav is usable',
      ok ? 'pass' : 'warning',
      'minor',
      ok ? 'Toggle pattern found' : 'No toggle pattern detected',
      ok
        ? 'Mobile navigation has toggle/aria-expanded patterns for usability.'
        : 'No aria-expanded or toggle button pattern found for mobile navigation. Screen reader and keyboard users may have difficulty.',
    ));
  } catch (e) {
    checks.push(makeCheck(25, 'Mobile nav is usable', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 26: Text readable without zooming
  // -----------------------------------------------------------------------
  try {
    // Check for base font size and body/html font-size
    const bodyRuleMatch = cssText.match(/(?:body|html)\s*\{[^}]*font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    const bodyStyle = $('body').attr('style') || '';
    const bodyFsMatch = bodyStyle.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    const baseFontSize = bodyRuleMatch ? parseFloat(bodyRuleMatch[1]) : (bodyFsMatch ? parseFloat(bodyFsMatch[1]) : null);

    const ok = baseFontSize === null || baseFontSize >= 14;
    checks.push(makeCheck(
      26,
      'Text readable without zooming',
      ok ? 'pass' : 'warning',
      'minor',
      baseFontSize !== null ? `Base: ${baseFontSize}px` : 'No explicit base size (browser default)',
      ok
        ? baseFontSize !== null
          ? `Base font size is ${baseFontSize}px which should be readable without zooming.`
          : 'No explicit base font size set. Browser default (usually 16px) should be readable.'
        : `Base font size is ${baseFontSize}px which may require zooming to read on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(26, 'Text readable without zooming', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 27: Buttons are tap-friendly
  // -----------------------------------------------------------------------
  try {
    const buttons = $('button, input[type="submit"], input[type="button"], .btn, [role="button"]');
    const buttonCount = buttons.length;
    let smallButtons = 0;
    buttons.each((_, el) => {
      const style = $(el).attr('style') || '';
      const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      const paddingMatch = style.match(/padding\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      if (heightMatch && parseFloat(heightMatch[1]) < 36) {
        smallButtons++;
      } else if (paddingMatch && parseFloat(paddingMatch[1]) < 8) {
        smallButtons++;
      }
    });
    const ok = buttonCount === 0 || smallButtons === 0;
    checks.push(makeCheck(
      27,
      'Buttons are tap-friendly',
      ok ? 'pass' : 'warning',
      'minor',
      buttonCount === 0 ? 'No buttons' : (smallButtons > 0 ? `${smallButtons} small button(s)` : 'Buttons appear adequate'),
      ok
        ? buttonCount === 0 ? 'No buttons found.' : 'All buttons appear to have adequate size for mobile tapping.'
        : `${smallButtons} button(s) may be too small for comfortable tapping (height < 36px or padding < 8px).`,
    ));
  } catch (e) {
    checks.push(makeCheck(27, 'Buttons are tap-friendly', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 28: No Flash content
  // -----------------------------------------------------------------------
  try {
    const flashElements = $(
      'object[type*="flash"], object[data*=".swf"], ' +
      'embed[type*="flash"], embed[src*=".swf"], ' +
      'object[classid*="ShockwaveFlash"], ' +
      '[type="application/x-shockwave-flash"]'
    );
    const ok = flashElements.length === 0;
    checks.push(makeCheck(
      28,
      'No Flash content',
      ok ? 'pass' : 'fail',
      'critical',
      ok ? 'No Flash' : `${flashElements.length} Flash element(s)`,
      ok
        ? 'No Flash content detected. Flash is not supported on mobile devices.'
        : `Found ${flashElements.length} Flash element(s). Flash is not supported on any modern browser or mobile device.`,
    ));
  } catch (e) {
    checks.push(makeCheck(28, 'No Flash content', 'warning', 'critical', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 29: No Java applets
  // -----------------------------------------------------------------------
  try {
    const applets = $('applet, object[type*="java"], embed[type*="java"]');
    const ok = applets.length === 0;
    checks.push(makeCheck(
      29,
      'No Java applets',
      ok ? 'pass' : 'fail',
      'critical',
      ok ? 'No Java applets' : `${applets.length} applet(s)`,
      ok
        ? 'No Java applets detected. Java applets are not supported on mobile.'
        : `Found ${applets.length} Java applet(s). Java applets are not supported on mobile or modern browsers.`,
    ));
  } catch (e) {
    checks.push(makeCheck(29, 'No Java applets', 'warning', 'critical', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 30: Media queries in CSS
  // -----------------------------------------------------------------------
  try {
    const mediaQs = findMediaQueries(cssText);
    // Also check linked stylesheets for media attribute
    const mediaLinks = $('link[rel="stylesheet"][media]').length;
    const totalMedia = mediaQs.length + mediaLinks;
    const ok = totalMedia > 0;
    checks.push(makeCheck(
      30,
      'Media queries in CSS',
      ok ? 'pass' : 'fail',
      'major',
      ok ? `${totalMedia} media query/queries found` : 'No media queries',
      ok
        ? `Found ${mediaQs.length} @media rule(s) in inline styles and ${mediaLinks} stylesheet(s) with media attributes.`
        : 'No CSS media queries found. Media queries are essential for responsive design.',
    ));
  } catch (e) {
    checks.push(makeCheck(30, 'Media queries in CSS', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 31: Responsive breakpoints cover common sizes
  // -----------------------------------------------------------------------
  try {
    const mediaQs = findMediaQueries(cssText);
    const bps = extractBreakpoints(mediaQs);
    const commonBreakpoints = [480, 768, 1024];
    const covered = commonBreakpoints.filter((target) =>
      bps.some((bp) => Math.abs(bp - target) <= 80)
    );
    const ok = covered.length >= 2;
    checks.push(makeCheck(
      31,
      'Responsive breakpoints cover common sizes',
      ok ? 'pass' : (bps.length > 0 ? 'warning' : 'info'),
      'minor',
      bps.length > 0 ? `Breakpoints: ${bps.join(', ')}px` : 'No breakpoints found',
      ok
        ? `Breakpoints cover ${covered.length}/3 common sizes (480, 768, 1024). Found: ${bps.join(', ')}px.`
        : bps.length > 0
          ? `Only ${covered.length}/3 common breakpoints (480, 768, 1024) are covered. Found: ${bps.join(', ')}px.`
          : 'No breakpoint values found in inline CSS. Breakpoints may be in external stylesheets.',
    ));
  } catch (e) {
    checks.push(makeCheck(31, 'Responsive breakpoints cover common sizes', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 32: Content priority on mobile (DOM order)
  // -----------------------------------------------------------------------
  try {
    const bodyChildren = $('body').children();
    const tagOrder = [];
    bodyChildren.each((_, el) => {
      const tag = (el.tagName || '').toLowerCase();
      if (['header', 'nav', 'main', 'article', 'section', 'footer'].includes(tag)) {
        tagOrder.push(tag);
      }
    });
    const hasHeader = tagOrder.includes('header');
    const hasMain = tagOrder.includes('main') || tagOrder.includes('article') || tagOrder.includes('section');
    const hasFooter = tagOrder.includes('footer');
    const headerBeforeMain = !hasHeader || !hasMain ||
      tagOrder.indexOf('header') < Math.min(
        tagOrder.indexOf('main') >= 0 ? tagOrder.indexOf('main') : Infinity,
        tagOrder.indexOf('article') >= 0 ? tagOrder.indexOf('article') : Infinity,
        tagOrder.indexOf('section') >= 0 ? tagOrder.indexOf('section') : Infinity,
      );
    const mainBeforeFooter = !hasMain || !hasFooter ||
      Math.min(
        tagOrder.indexOf('main') >= 0 ? tagOrder.indexOf('main') : Infinity,
        tagOrder.indexOf('article') >= 0 ? tagOrder.indexOf('article') : Infinity,
        tagOrder.indexOf('section') >= 0 ? tagOrder.indexOf('section') : Infinity,
      ) < tagOrder.indexOf('footer');

    const ok = headerBeforeMain && mainBeforeFooter;
    checks.push(makeCheck(
      32,
      'Content priority on mobile (DOM order)',
      ok ? 'pass' : 'warning',
      'minor',
      tagOrder.length > 0 ? `Order: ${tagOrder.join(' > ')}` : 'No semantic landmarks',
      ok
        ? tagOrder.length > 0
          ? `DOM order follows header > main > footer pattern: ${tagOrder.join(' > ')}.`
          : 'No semantic landmark elements (header, main, footer) found at top level.'
        : 'DOM order does not follow recommended header > main content > footer pattern for mobile content priority.',
    ));
  } catch (e) {
    checks.push(makeCheck(32, 'Content priority on mobile (DOM order)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 33: No layout shifts during load (CLS from Lighthouse)
  // -----------------------------------------------------------------------
  try {
    let cls = null;
    if (lighthouseResults) {
      // Try to extract CLS from Lighthouse
      const audits = lighthouseResults.audits || {};
      if (audits['cumulative-layout-shift']) {
        cls = audits['cumulative-layout-shift'].numericValue;
      }
      // Also try lhr format
      if (cls === null || cls === undefined) {
        const categories = lighthouseResults.categories || {};
        const perf = categories.performance || {};
        // Try from metrics
        if (lighthouseResults.lhr && lighthouseResults.lhr.audits && lighthouseResults.lhr.audits['cumulative-layout-shift']) {
          cls = lighthouseResults.lhr.audits['cumulative-layout-shift'].numericValue;
        }
      }
    }

    if (cls !== null && cls !== undefined) {
      const ok = cls <= 0.1;
      const warning = cls <= 0.25;
      checks.push(makeCheck(
        33,
        'No layout shifts during load (CLS)',
        ok ? 'pass' : (warning ? 'warning' : 'fail'),
        'minor',
        `CLS: ${cls.toFixed(3)}`,
        ok
          ? `Cumulative Layout Shift is ${cls.toFixed(3)} (good, <= 0.1).`
          : warning
            ? `Cumulative Layout Shift is ${cls.toFixed(3)} (needs improvement, > 0.1 but <= 0.25).`
            : `Cumulative Layout Shift is ${cls.toFixed(3)} (poor, > 0.25). Significant layout instability detected.`,
      ));
    } else {
      // Try heuristic: check for images without width/height
      const imgsWithoutDimensions = $('img:not([width]):not([height])').length;
      const totalImgs = $('img').length;
      checks.push(makeCheck(
        33,
        'No layout shifts during load (CLS)',
        imgsWithoutDimensions > 0 ? 'warning' : 'info',
        'minor',
        'CLS data unavailable',
        imgsWithoutDimensions > 0
          ? `Lighthouse CLS data unavailable. ${imgsWithoutDimensions}/${totalImgs} images lack width/height attributes, which can cause layout shifts.`
          : 'Lighthouse CLS data unavailable. Cannot determine layout shift score from HTML alone.',
      ));
    }
  } catch (e) {
    checks.push(makeCheck(33, 'No layout shifts during load (CLS)', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 34: Lazy loading for below-fold images
  // -----------------------------------------------------------------------
  try {
    const totalImages = $('img').length;
    let lazyCount = 0;
    $('img').each((_, el) => {
      const loading = ($(el).attr('loading') || '').toLowerCase();
      const cls = ($(el).attr('class') || '').toLowerCase();
      const dataSrc = $(el).attr('data-src') || $(el).attr('data-lazy') || '';
      if (loading === 'lazy' || /lazy/i.test(cls) || dataSrc) {
        lazyCount++;
      }
    });
    const ok = totalImages <= 3 || lazyCount > 0;
    checks.push(makeCheck(
      34,
      'Lazy loading for below-fold images',
      ok ? 'pass' : 'warning',
      'minor',
      totalImages === 0 ? 'No images' : `${lazyCount}/${totalImages} lazy-loaded`,
      ok
        ? totalImages === 0 ? 'No images on the page.'
          : totalImages <= 3 ? `Only ${totalImages} image(s) on page; lazy loading may not be needed.`
            : `${lazyCount} of ${totalImages} image(s) use lazy loading.`
        : `None of the ${totalImages} images use lazy loading (loading="lazy", data-src, etc.). Consider lazy loading below-fold images for faster mobile page loads.`,
    ));
  } catch (e) {
    checks.push(makeCheck(34, 'Lazy loading for below-fold images', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 35: Mobile page weight < 3MB
  // -----------------------------------------------------------------------
  try {
    const networkRequests = (pageData && pageData.networkRequests) || [];
    let totalBytes = 0;
    for (const req of networkRequests) {
      const size = req.responseSize || req.transferSize || req.size || req.contentLength || 0;
      totalBytes += size;
    }
    // If no network data, estimate from HTML size
    if (totalBytes === 0 && html) {
      totalBytes = Buffer.byteLength(html, 'utf8');
    }
    const totalMB = totalBytes / (1024 * 1024);
    const ok = totalMB < 3;
    checks.push(makeCheck(
      35,
      'Mobile page weight < 3MB',
      ok ? 'pass' : 'fail',
      'major',
      `${totalMB.toFixed(2)} MB`,
      ok
        ? `Total page weight is ${totalMB.toFixed(2)} MB (under 3MB limit for mobile).`
        : `Total page weight is ${totalMB.toFixed(2)} MB which exceeds the 3MB recommended limit for mobile. This impacts load times on cellular networks.`,
    ));
  } catch (e) {
    checks.push(makeCheck(35, 'Mobile page weight < 3MB', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 36: Mobile request count < 80
  // -----------------------------------------------------------------------
  try {
    const networkRequests = (pageData && pageData.networkRequests) || [];
    const count = networkRequests.length;
    const ok = count < 80;
    checks.push(makeCheck(
      36,
      'Mobile request count < 80',
      ok ? 'pass' : 'warning',
      'minor',
      `${count} requests`,
      ok
        ? `Page makes ${count} network request(s) (under 80 limit).`
        : `Page makes ${count} network requests which exceeds the 80 request recommended limit. Each request adds latency on mobile.`,
    ));
  } catch (e) {
    checks.push(makeCheck(36, 'Mobile request count < 80', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 37: No pop-ups/interstitials
  // -----------------------------------------------------------------------
  try {
    const popupSelectors = [
      '.modal', '.popup', '.overlay', '.interstitial', '.lightbox',
      '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
      '[class*="interstitial"]', '[class*="lightbox"]',
      '[role="dialog"]', '[role="alertdialog"]',
      '.cookie-banner', '.cookie-consent', '[class*="cookie"]',
      '[class*="gdpr"]', '[class*="consent"]',
    ];
    let popupCount = 0;
    for (const sel of popupSelectors) {
      try {
        popupCount += $(sel).length;
      } catch (_) {
        // Invalid selector, skip
      }
    }
    // Deduplicate by checking unique elements
    const popupElements = new Set();
    for (const sel of popupSelectors) {
      try {
        $(sel).each((_, el) => popupElements.add(el));
      } catch (_) {
        // skip
      }
    }
    const uniquePopups = popupElements.size;
    const ok = uniquePopups === 0;
    checks.push(makeCheck(
      37,
      'No pop-ups or interstitials',
      ok ? 'pass' : 'warning',
      'major',
      ok ? 'None detected' : `${uniquePopups} potential popup(s)`,
      ok
        ? 'No modal, popup, or interstitial patterns detected in the HTML.'
        : `Found ${uniquePopups} element(s) matching popup/modal/interstitial patterns. Intrusive pop-ups can block content on mobile and hurt SEO.`,
    ));
  } catch (e) {
    checks.push(makeCheck(37, 'No pop-ups or interstitials', 'warning', 'major', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 38: Sticky elements don't obscure content
  // -----------------------------------------------------------------------
  try {
    const stickyElements = [];
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      if (/position\s*:\s*(fixed|sticky)/i.test(style)) {
        const tag = (el.tagName || '').toLowerCase();
        const cls = ($(el).attr('class') || '').substring(0, 50);
        stickyElements.push(`${tag}${cls ? '.' + cls.split(/\s+/)[0] : ''}`);
      }
    });
    // Also check style tags for position: fixed/sticky
    const fixedInCSS = (cssText.match(/position\s*:\s*(fixed|sticky)/gi) || []).length;
    const totalSticky = stickyElements.length + fixedInCSS;
    const ok = totalSticky <= 2; // A header + maybe a CTA is fine
    checks.push(makeCheck(
      38,
      'Sticky elements don\'t obscure content',
      ok ? 'pass' : 'warning',
      'minor',
      totalSticky === 0 ? 'No sticky elements' : `${totalSticky} sticky/fixed element(s)`,
      ok
        ? totalSticky === 0
          ? 'No fixed or sticky positioned elements found.'
          : `Found ${totalSticky} fixed/sticky element(s). This is a reasonable amount.`
        : `Found ${totalSticky} fixed/sticky positioned element(s). Too many sticky elements can obscure content on small mobile screens.`,
    ));
  } catch (e) {
    checks.push(makeCheck(38, 'Sticky elements don\'t obscure content', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 39: Orientation change handled
  // -----------------------------------------------------------------------
  try {
    // Check viewport meta for orientation lock
    const hasOrientationLock = /orientation\s*=\s*portrait/i.test(viewportContent) ||
      /orientation\s*=\s*landscape/i.test(viewportContent);
    // Check CSS for orientation media queries
    const hasOrientationQuery = /orientation\s*:\s*(portrait|landscape)/i.test(cssText);
    // Device-width viewport handles orientation automatically
    const hasDeviceWidth = vpParsed['width'] === 'device-width';

    const ok = hasDeviceWidth && !hasOrientationLock;
    checks.push(makeCheck(
      39,
      'Orientation change handled',
      ok ? 'pass' : (hasOrientationLock ? 'fail' : 'warning'),
      'minor',
      ok ? 'Handled via viewport' : (hasOrientationLock ? 'Orientation locked' : 'May not handle orientation'),
      ok
        ? `Viewport uses width=device-width which adapts to orientation changes.${hasOrientationQuery ? ' CSS orientation media queries also found.' : ''}`
        : hasOrientationLock
          ? 'Viewport locks orientation. Users should be able to use both portrait and landscape.'
          : 'Viewport may not properly handle orientation changes. Use width=device-width for automatic adaptation.',
    ));
  } catch (e) {
    checks.push(makeCheck(39, 'Orientation change handled', 'warning', 'minor', 'Error', e.message));
  }

  // -----------------------------------------------------------------------
  // CHECK 40: PWA installable (manifest link)
  // -----------------------------------------------------------------------
  try {
    const manifestLink = $('link[rel="manifest"]');
    const hasManifest = manifestLink.length > 0;
    const manifestHref = hasManifest ? manifestLink.attr('href') : null;
    // Also check for other PWA indicators
    const hasServiceWorker = /serviceWorker|service-worker|sw\.js/i.test(html);
    const hasThemeColor = $('meta[name="theme-color"]').length > 0;
    const isPWA = hasManifest && (hasServiceWorker || hasThemeColor);

    checks.push(makeCheck(
      40,
      'PWA installable',
      isPWA ? 'pass' : (hasManifest ? 'warning' : 'info'),
      'minor',
      isPWA ? 'PWA ready' : (hasManifest ? 'Manifest found, partial PWA' : 'No manifest'),
      isPWA
        ? `Web app manifest found at "${manifestHref}". PWA indicators present (service worker/theme-color).`
        : hasManifest
          ? `Web app manifest found at "${manifestHref}" but additional PWA requirements may be missing (service worker, theme-color).`
          : 'No web app manifest (<link rel="manifest">) found. A manifest is required for PWA installability.',
    ));
  } catch (e) {
    checks.push(makeCheck(40, 'PWA installable', 'warning', 'minor', 'Error', e.message));
  }

  return { checks };
}

module.exports = { analyzeMobile };
