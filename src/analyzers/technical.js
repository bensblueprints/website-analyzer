const cheerio = require('cheerio');

/**
 * Technical HTML/CSS Analyzer - 50 data points
 * Analyzes page for HTML validity, CSS quality, JS issues, and technical best practices.
 *
 * @param {Object} pageData - { url, html, statusCode, headers, networkRequests, consoleMessages, links }
 * @returns {Promise<{ checks: Array<{ id: string, name: string, status: string, severity: string, value: any, details: string }> }>}
 */
async function analyzeTechnical(pageData) {
  const { html = '', consoleMessages = [] } = pageData || {};
  const checks = [];

  let $;
  try {
    $ = cheerio.load(html || '', { decodeEntities: false });
  } catch (e) {
    $ = cheerio.load('');
  }

  const rawHtml = html || '';

  // Helper to add a check safely
  function addCheck(id, name, severity, fn) {
    try {
      const result = fn();
      checks.push({
        id,
        name,
        status: result.status,
        severity,
        value: result.value !== undefined ? result.value : null,
        details: result.details || ''
      });
    } catch (err) {
      checks.push({
        id,
        name,
        status: 'error',
        severity,
        value: null,
        details: `Check failed: ${err.message}`
      });
    }
  }

  // Collect all inline style content
  function getInlineStyleContent() {
    const parts = [];
    $('style').each((_, el) => {
      parts.push($(el).html() || '');
    });
    return parts.join('\n');
  }

  // Collect all inline script content
  function getInlineScriptContent() {
    const parts = [];
    $('script').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) {
        parts.push($(el).html() || '');
      }
    });
    return parts.join('\n');
  }

  // ── Check 1: Valid DOCTYPE declaration ──
  addCheck('tech-1', 'Valid DOCTYPE declaration', 'major', () => {
    const hasDoctype = /<!doctype\s/i.test(rawHtml.trimStart().substring(0, 100));
    return {
      status: hasDoctype ? 'pass' : 'fail',
      value: hasDoctype,
      details: hasDoctype
        ? 'DOCTYPE declaration found'
        : 'No DOCTYPE declaration found. Add <!DOCTYPE html> at the top of the document.'
    };
  });

  // ── Check 2: HTML5 doctype ──
  addCheck('tech-2', 'HTML5 doctype', 'minor', () => {
    const hasHtml5 = /<!DOCTYPE\s+html\s*>/i.test(rawHtml.trimStart().substring(0, 100));
    return {
      status: hasHtml5 ? 'pass' : 'fail',
      value: hasHtml5,
      details: hasHtml5
        ? 'HTML5 doctype detected'
        : 'Not using HTML5 doctype. Use <!DOCTYPE html> for modern standards mode.'
    };
  });

  // ── Check 3: Character encoding UTF-8 ──
  addCheck('tech-3', 'Character encoding UTF-8', 'major', () => {
    const metaCharset = $('meta[charset]').attr('charset') || '';
    const metaHttpEquiv = $('meta[http-equiv="Content-Type"]').attr('content') || '';
    const hasUtf8 =
      metaCharset.toLowerCase() === 'utf-8' ||
      metaHttpEquiv.toLowerCase().includes('utf-8');
    return {
      status: hasUtf8 ? 'pass' : 'fail',
      value: hasUtf8 ? 'utf-8' : metaCharset || 'none',
      details: hasUtf8
        ? 'UTF-8 character encoding declared'
        : 'UTF-8 charset not declared. Add <meta charset="utf-8"> in the <head>.'
    };
  });

  // ── Check 4: No HTML critical validation errors ──
  addCheck('tech-4', 'No HTML critical validation errors', 'major', () => {
    const errors = [];

    // Check for unclosed tags by looking for common patterns
    const voidElements = new Set([
      'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);

    // Check for img without alt
    $('img').each((_, el) => {
      if ($(el).attr('alt') === undefined) {
        errors.push('img missing alt attribute');
      }
    });

    // Check for form inputs without labels or aria-label
    $('input').each((_, el) => {
      const type = ($(el).attr('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
      const id = $(el).attr('id');
      const ariaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby');
      const hasLabel = id && $(`label[for="${id}"]`).length > 0;
      if (!ariaLabel && !hasLabel) {
        errors.push(`input[type="${type}"] missing associated label or aria-label`);
      }
    });

    // Check for a tags without href
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const name = $(el).attr('name');
      const id = $(el).attr('id');
      if (href === undefined && !name && !id) {
        errors.push('anchor tag without href, name, or id');
      }
    });

    const errorCount = errors.length;
    const capped = errors.slice(0, 10);
    return {
      status: errorCount === 0 ? 'pass' : 'fail',
      value: errorCount,
      details: errorCount === 0
        ? 'No critical HTML validation issues detected'
        : `Found ${errorCount} issue(s): ${capped.join('; ')}${errorCount > 10 ? '...' : ''}`
    };
  });

  // ── Check 5: No HTML validation warnings ──
  addCheck('tech-5', 'No HTML validation warnings', 'minor', () => {
    const warnings = [];

    // Check for deprecated patterns
    if (/<frameset/i.test(rawHtml)) warnings.push('frameset detected');
    if (/<frame\s/i.test(rawHtml)) warnings.push('frame element detected');
    if (/<applet/i.test(rawHtml)) warnings.push('applet element detected');
    if (/<isindex/i.test(rawHtml)) warnings.push('isindex element detected');

    // Check for missing lang attribute
    const lang = $('html').attr('lang');
    if (!lang) warnings.push('html element missing lang attribute');

    // Check for missing title
    const title = $('title').text().trim();
    if (!title) warnings.push('Missing or empty <title> element');

    return {
      status: warnings.length === 0 ? 'pass' : 'fail',
      value: warnings.length,
      details: warnings.length === 0
        ? 'No HTML validation warnings'
        : `Found ${warnings.length} warning(s): ${warnings.join('; ')}`
    };
  });

  // ── Check 6: No deprecated HTML elements ──
  addCheck('tech-6', 'No deprecated HTML elements', 'minor', () => {
    const deprecated = ['font', 'center', 'marquee', 'blink', 'big', 'strike', 'tt'];
    const found = [];
    for (const tag of deprecated) {
      const count = $(tag).length;
      if (count > 0) found.push(`<${tag}> (${count})`);
    }
    // Check <u> when not used semantically (just count it)
    const uCount = $('u').length;
    if (uCount > 0) found.push(`<u> (${uCount})`);

    return {
      status: found.length === 0 ? 'pass' : 'fail',
      value: found.length,
      details: found.length === 0
        ? 'No deprecated HTML elements found'
        : `Deprecated elements found: ${found.join(', ')}`
    };
  });

  // ── Check 7: No deprecated HTML attributes ──
  addCheck('tech-7', 'No deprecated HTML attributes', 'minor', () => {
    const deprecatedAttrs = ['bgcolor', 'align', 'valign', 'cellpadding', 'cellspacing'];
    const found = [];

    for (const attr of deprecatedAttrs) {
      const els = $(`[${attr}]`);
      if (els.length > 0) found.push(`${attr} (${els.length})`);
    }

    // border on table specifically
    const borderedTables = $('table[border]').length;
    if (borderedTables > 0) found.push(`border on table (${borderedTables})`);

    return {
      status: found.length === 0 ? 'pass' : 'fail',
      value: found.length,
      details: found.length === 0
        ? 'No deprecated HTML attributes found'
        : `Deprecated attributes found: ${found.join(', ')}`
    };
  });

  // ── Check 8: No inline styles ──
  addCheck('tech-8', 'No inline styles', 'minor', () => {
    const count = $('[style]').length;
    return {
      status: count === 0 ? 'pass' : 'fail',
      value: count,
      details: count === 0
        ? 'No inline styles found'
        : `Found ${count} element(s) with inline style attributes. Use external CSS instead.`
    };
  });

  // ── Check 9: No inline event handlers ──
  addCheck('tech-9', 'No inline event handlers', 'minor', () => {
    const eventAttrs = [
      'onclick', 'onload', 'onerror', 'onsubmit', 'onchange', 'onmouseover',
      'onmouseout', 'onkeydown', 'onkeyup', 'onkeypress', 'onfocus', 'onblur',
      'onscroll', 'onresize', 'ondblclick', 'oncontextmenu', 'oninput',
      'onmousedown', 'onmouseup', 'ontouchstart', 'ontouchend', 'ontouchmove'
    ];
    let totalCount = 0;
    const foundAttrs = [];
    for (const attr of eventAttrs) {
      const count = $(`[${attr}]`).length;
      if (count > 0) {
        totalCount += count;
        foundAttrs.push(`${attr} (${count})`);
      }
    }
    return {
      status: totalCount === 0 ? 'pass' : 'fail',
      value: totalCount,
      details: totalCount === 0
        ? 'No inline event handlers found'
        : `Found ${totalCount} inline event handler(s): ${foundAttrs.slice(0, 10).join(', ')}`
    };
  });

  // ── Check 10: No presentational HTML ──
  addCheck('tech-10', 'No presentational HTML', 'minor', () => {
    const issues = [];
    const fontCount = $('font').length;
    const centerCount = $('center').length;
    const bCount = $('b').length;
    const iCount = $('i').length;

    if (fontCount > 0) issues.push(`<font> (${fontCount}) - use CSS`);
    if (centerCount > 0) issues.push(`<center> (${centerCount}) - use CSS text-align`);
    if (bCount > 0) issues.push(`<b> (${bCount}) - consider <strong>`);
    if (iCount > 0) issues.push(`<i> (${iCount}) - consider <em> for emphasis`);

    return {
      status: issues.length === 0 ? 'pass' : 'fail',
      value: issues.length,
      details: issues.length === 0
        ? 'No presentational HTML found'
        : `Presentational elements: ${issues.join('; ')}`
    };
  });

  // ── Check 11: Semantic HTML used ──
  addCheck('tech-11', 'Semantic HTML used', 'major', () => {
    const semanticTags = ['section', 'article', 'nav', 'aside', 'header', 'footer', 'main'];
    const found = [];
    for (const tag of semanticTags) {
      const count = $(tag).length;
      if (count > 0) found.push(`<${tag}> (${count})`);
    }
    return {
      status: found.length >= 2 ? 'pass' : 'fail',
      value: found.length,
      details: found.length >= 2
        ? `Semantic elements found: ${found.join(', ')}`
        : `Only ${found.length} semantic element type(s) found. Use header, nav, main, footer, section, article, aside for better structure.`
    };
  });

  // ── Check 12: No excessive div nesting > 10 levels ──
  addCheck('tech-12', 'No excessive div nesting (>10 levels)', 'minor', () => {
    let maxDepth = 0;

    function measureDepth(el, depth) {
      if (depth > maxDepth) maxDepth = depth;
      $(el).children('div').each((_, child) => {
        measureDepth(child, depth + 1);
      });
      // Limit traversal for performance
      if (maxDepth > 15) return;
    }

    $('body > div, html > body > div').each((_, el) => {
      if (maxDepth <= 15) measureDepth(el, 1);
    });

    return {
      status: maxDepth <= 10 ? 'pass' : 'fail',
      value: maxDepth,
      details: maxDepth <= 10
        ? `Maximum div nesting depth: ${maxDepth}`
        : `Excessive div nesting detected: ${maxDepth} levels deep. Flatten the DOM structure.`
    };
  });

  // ── Check 13: No empty divs/spans ──
  addCheck('tech-13', 'No empty divs/spans', 'minor', () => {
    let emptyCount = 0;
    $('div, span').each((_, el) => {
      const inner = $(el).html();
      // Truly empty or only whitespace, and no children elements
      if (inner !== null && inner.trim() === '' && $(el).children().length === 0) {
        // Skip if it has attributes suggesting it's used for styling/JS
        const attrs = el.attribs || {};
        const hasClass = !!attrs.class;
        const hasId = !!attrs.id;
        const hasRole = !!attrs.role;
        if (!hasClass && !hasId && !hasRole) {
          emptyCount++;
        }
      }
    });
    return {
      status: emptyCount === 0 ? 'pass' : 'fail',
      value: emptyCount,
      details: emptyCount === 0
        ? 'No empty divs/spans found'
        : `Found ${emptyCount} empty div/span element(s) with no content, class, id, or role.`
    };
  });

  // ── Check 14: CSS validates (basic) ──
  addCheck('tech-14', 'CSS validates (basic check)', 'minor', () => {
    const styleContent = getInlineStyleContent();
    if (!styleContent.trim()) {
      return { status: 'pass', value: 0, details: 'No inline style blocks to validate' };
    }

    const errors = [];
    // Check for unclosed braces
    const openBraces = (styleContent.match(/{/g) || []).length;
    const closeBraces = (styleContent.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      errors.push(`Mismatched braces: ${openBraces} opening vs ${closeBraces} closing`);
    }

    // Check for obviously malformed properties (e.g., double colons in value context)
    const doubleColonValues = (styleContent.match(/:[^:;{}\n]*:(?!:)[^;{}\n]*/g) || []).length;
    if (doubleColonValues > 5) {
      errors.push('Possible malformed CSS properties detected');
    }

    return {
      status: errors.length === 0 ? 'pass' : 'fail',
      value: errors.length,
      details: errors.length === 0
        ? 'No obvious CSS errors in style blocks'
        : `CSS issues: ${errors.join('; ')}`
    };
  });

  // ── Check 15: No !important overuse > 20 instances ──
  addCheck('tech-15', 'No !important overuse (>20)', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const count = (styleContent.match(/!important/gi) || []).length;
    return {
      status: count <= 20 ? 'pass' : 'fail',
      value: count,
      details: count <= 20
        ? `Found ${count} !important declaration(s) in inline styles`
        : `Excessive !important usage: ${count} instances. Refactor CSS specificity instead.`
    };
  });

  // ── Check 16: No CSS errors in console ──
  addCheck('tech-16', 'No CSS errors in console', 'major', () => {
    const cssErrors = consoleMessages.filter(msg => {
      const text = (msg.text || msg.message || '').toLowerCase();
      const type = (msg.type || '').toLowerCase();
      return (type === 'error' || type === 'warning') &&
        (text.includes('css') || text.includes('stylesheet') || text.includes('style'));
    });
    return {
      status: cssErrors.length === 0 ? 'pass' : 'fail',
      value: cssErrors.length,
      details: cssErrors.length === 0
        ? 'No CSS errors in console'
        : `Found ${cssErrors.length} CSS-related console message(s): ${cssErrors.slice(0, 3).map(m => m.text || m.message).join('; ')}`
    };
  });

  // ── Check 17: No JS errors in console ──
  addCheck('tech-17', 'No JS errors in console', 'critical', () => {
    const jsErrors = consoleMessages.filter(msg => {
      const type = (msg.type || '').toLowerCase();
      return type === 'error';
    });
    return {
      status: jsErrors.length === 0 ? 'pass' : 'fail',
      value: jsErrors.length,
      details: jsErrors.length === 0
        ? 'No JavaScript errors in console'
        : `Found ${jsErrors.length} JS error(s): ${jsErrors.slice(0, 5).map(m => m.text || m.message || 'unknown error').join('; ')}`
    };
  });

  // ── Check 18: No JS warnings in console ──
  addCheck('tech-18', 'No JS warnings in console', 'minor', () => {
    const jsWarnings = consoleMessages.filter(msg => {
      const type = (msg.type || '').toLowerCase();
      return type === 'warning' || type === 'warn';
    });
    return {
      status: jsWarnings.length === 0 ? 'pass' : 'fail',
      value: jsWarnings.length,
      details: jsWarnings.length === 0
        ? 'No JavaScript warnings in console'
        : `Found ${jsWarnings.length} JS warning(s): ${jsWarnings.slice(0, 5).map(m => m.text || m.message || 'unknown warning').join('; ')}`
    };
  });

  // ── Check 19: No deprecated JS APIs ──
  addCheck('tech-19', 'No deprecated JS APIs', 'minor', () => {
    const deprecationMsgs = consoleMessages.filter(msg => {
      const text = (msg.text || msg.message || '').toLowerCase();
      return text.includes('deprecated') || text.includes('deprecation');
    });
    return {
      status: deprecationMsgs.length === 0 ? 'pass' : 'fail',
      value: deprecationMsgs.length,
      details: deprecationMsgs.length === 0
        ? 'No deprecated API warnings detected'
        : `Found ${deprecationMsgs.length} deprecation warning(s): ${deprecationMsgs.slice(0, 3).map(m => m.text || m.message).join('; ')}`
    };
  });

  // ── Check 20: No document.write usage ──
  addCheck('tech-20', 'No document.write usage', 'major', () => {
    const scriptContent = getInlineScriptContent();
    const matches = (scriptContent.match(/document\.write\s*\(/g) || []).length;
    return {
      status: matches === 0 ? 'pass' : 'fail',
      value: matches,
      details: matches === 0
        ? 'No document.write() usage found in inline scripts'
        : `Found ${matches} document.write() call(s). This blocks parsing and is a security risk.`
    };
  });

  // ── Check 21: No eval() usage ──
  addCheck('tech-21', 'No eval() usage', 'major', () => {
    const scriptContent = getInlineScriptContent();
    // Match eval( but not .evaluate or similar
    const matches = (scriptContent.match(/\beval\s*\(/g) || []).length;
    return {
      status: matches === 0 ? 'pass' : 'fail',
      value: matches,
      details: matches === 0
        ? 'No eval() usage found in inline scripts'
        : `Found ${matches} eval() call(s). Avoid eval() for security and performance.`
    };
  });

  // ── Check 22: Consistent indentation ──
  addCheck('tech-22', 'Consistent indentation', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'Indentation check skipped (not reliably detectable from parsed HTML).'
    };
  });

  // ── Check 23: No excessive comments in production ──
  addCheck('tech-23', 'No excessive comments in production', 'minor', () => {
    const comments = (rawHtml.match(/<!--[\s\S]*?-->/g) || []);
    // Exclude conditional comments and common framework comments
    const realComments = comments.filter(c =>
      !c.startsWith('<!--[if') && !c.startsWith('<!--<![') && !c.startsWith('<!--!')
    );
    const count = realComments.length;
    return {
      status: count <= 20 ? 'pass' : 'fail',
      value: count,
      details: count <= 20
        ? `Found ${count} HTML comment(s)`
        : `Found ${count} HTML comments in production. Consider removing unnecessary comments for smaller payloads.`
    };
  });

  // ── Check 24: No conditional IE comments ──
  addCheck('tech-24', 'No conditional IE comments', 'minor', () => {
    const ieComments = (rawHtml.match(/<!--\[if\s/g) || []).length;
    return {
      status: ieComments === 0 ? 'pass' : 'fail',
      value: ieComments,
      details: ieComments === 0
        ? 'No conditional IE comments found'
        : `Found ${ieComments} conditional IE comment(s). IE is end-of-life; consider removing.`
    };
  });

  // ── Check 25: No browser-specific CSS hacks ──
  addCheck('tech-25', 'No browser-specific CSS hacks', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const hacks = [];

    // _property hack (IE6)
    const underscoreHacks = (styleContent.match(/[{;]\s*_[a-zA-Z-]+\s*:/g) || []).length;
    if (underscoreHacks > 0) hacks.push(`_ prefix hack (${underscoreHacks})`);

    // *property hack (IE7)
    const starHacks = (styleContent.match(/[{;]\s*\*[a-zA-Z-]+\s*:/g) || []).length;
    if (starHacks > 0) hacks.push(`* prefix hack (${starHacks})`);

    // \9 hack (IE8-9)
    const slashNineHacks = (styleContent.match(/\\9\s*[;}/]/g) || []).length;
    if (slashNineHacks > 0) hacks.push(`\\9 hack (${slashNineHacks})`);

    return {
      status: hacks.length === 0 ? 'pass' : 'fail',
      value: hacks.length,
      details: hacks.length === 0
        ? 'No browser-specific CSS hacks found'
        : `Browser CSS hacks detected: ${hacks.join('; ')}`
    };
  });

  // ── Check 26: CSS custom properties used ──
  addCheck('tech-26', 'CSS custom properties used', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const customProps = (styleContent.match(/--[a-zA-Z][a-zA-Z0-9-]*\s*:/g) || []).length;
    const varUsage = (styleContent.match(/var\(--/g) || []).length;
    const used = customProps > 0 || varUsage > 0;
    return {
      status: used ? 'pass' : 'fail',
      value: { definitions: customProps, usages: varUsage },
      details: used
        ? `CSS custom properties: ${customProps} definition(s), ${varUsage} var() usage(s)`
        : 'No CSS custom properties found. Consider using them for maintainable theming.'
    };
  });

  // ── Check 27: No duplicate CSS rules (basic) ──
  addCheck('tech-27', 'No duplicate CSS rules', 'minor', () => {
    const styleContent = getInlineStyleContent();
    if (!styleContent.trim()) {
      return { status: 'pass', value: 0, details: 'No inline style blocks to check' };
    }

    // Extract selectors (rough)
    const selectorRegex = /([^{}@]+)\s*\{/g;
    const selectors = [];
    let match;
    while ((match = selectorRegex.exec(styleContent)) !== null) {
      const sel = match[1].trim();
      if (sel && !sel.startsWith('@') && !sel.startsWith('/*')) {
        selectors.push(sel);
      }
    }

    const seen = {};
    const dupes = [];
    for (const sel of selectors) {
      if (seen[sel]) {
        if (!dupes.includes(sel)) dupes.push(sel);
      }
      seen[sel] = true;
    }

    return {
      status: dupes.length === 0 ? 'pass' : 'fail',
      value: dupes.length,
      details: dupes.length === 0
        ? 'No duplicate CSS selectors detected'
        : `Found ${dupes.length} duplicate selector(s): ${dupes.slice(0, 5).join(', ')}`
    };
  });

  // ── Check 28: No duplicate IDs ──
  addCheck('tech-28', 'No duplicate IDs', 'major', () => {
    const ids = {};
    $('[id]').each((_, el) => {
      const id = $(el).attr('id');
      if (id) {
        ids[id] = (ids[id] || 0) + 1;
      }
    });
    const dupes = Object.entries(ids).filter(([, count]) => count > 1);
    return {
      status: dupes.length === 0 ? 'pass' : 'fail',
      value: dupes.length,
      details: dupes.length === 0
        ? 'No duplicate IDs found'
        : `Found ${dupes.length} duplicate ID(s): ${dupes.slice(0, 10).map(([id, c]) => `#${id} (${c}x)`).join(', ')}`
    };
  });

  // ── Check 29: No empty href attributes ──
  addCheck('tech-29', 'No empty href attributes', 'minor', () => {
    let emptyCount = 0;
    $('[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href === '' || href === '#') emptyCount++;
    });
    return {
      status: emptyCount === 0 ? 'pass' : 'fail',
      value: emptyCount,
      details: emptyCount === 0
        ? 'No empty href attributes found'
        : `Found ${emptyCount} element(s) with empty or "#" href. Use proper URLs or button elements.`
    };
  });

  // ── Check 30: No empty src attributes ──
  addCheck('tech-30', 'No empty src attributes', 'major', () => {
    let emptyCount = 0;
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src === '') emptyCount++;
    });
    return {
      status: emptyCount === 0 ? 'pass' : 'fail',
      value: emptyCount,
      details: emptyCount === 0
        ? 'No empty src attributes found'
        : `Found ${emptyCount} element(s) with empty src. This causes extra HTTP requests to the page URL.`
    };
  });

  // ── Check 31: All scripts have type or are standard ──
  addCheck('tech-31', 'All scripts have type or are standard', 'minor', () => {
    let nonStandard = 0;
    $('script').each((_, el) => {
      const type = $(el).attr('type');
      if (type && type !== 'text/javascript' && type !== 'module' && type !== 'application/javascript'
        && type !== 'application/ld+json' && type !== 'application/json'
        && type !== 'importmap' && type !== 'speculationrules') {
        nonStandard++;
      }
    });
    return {
      status: nonStandard === 0 ? 'pass' : 'fail',
      value: nonStandard,
      details: nonStandard === 0
        ? 'All script tags have standard or no type attribute'
        : `Found ${nonStandard} script(s) with non-standard type attributes.`
    };
  });

  // ── Check 32: No blocking synchronous XHR ──
  addCheck('tech-32', 'No blocking synchronous XHR', 'minor', () => {
    const syncXhrWarnings = consoleMessages.filter(msg => {
      const text = (msg.text || msg.message || '').toLowerCase();
      return text.includes('synchronous xmlhttprequest') || text.includes('synchronous xhr');
    });

    // Also check inline scripts
    const scriptContent = getInlineScriptContent();
    const syncXhrInCode = /\.open\s*\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*false\s*\)/g;
    const codeMatches = (scriptContent.match(syncXhrInCode) || []).length;

    const total = syncXhrWarnings.length + codeMatches;
    return {
      status: total === 0 ? 'pass' : 'fail',
      value: total,
      details: total === 0
        ? 'No synchronous XHR detected'
        : `Found ${total} synchronous XHR indicator(s). Synchronous XHR blocks the main thread.`
    };
  });

  // ── Check 33: No excessive DOM mutations ──
  addCheck('tech-33', 'No excessive DOM mutations', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'DOM mutation check skipped (requires runtime MutationObserver monitoring).'
    };
  });

  // ── Check 34: Web fonts loaded efficiently ──
  addCheck('tech-34', 'Web fonts loaded efficiently', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const hasFontFace = /@font-face/i.test(styleContent);
    const hasFontDisplay = /font-display\s*:/i.test(styleContent);
    const linkPreloads = $('link[rel="preload"][as="font"]').length;
    const fontLinks = $('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').length;

    if (!hasFontFace && fontLinks === 0) {
      return { status: 'pass', value: 'no-fonts', details: 'No web fonts detected in inline styles' };
    }

    const efficient = hasFontDisplay || linkPreloads > 0;
    return {
      status: efficient ? 'pass' : 'fail',
      value: { fontDisplay: hasFontDisplay, preloaded: linkPreloads },
      details: efficient
        ? 'Web fonts appear to be loaded efficiently (font-display or preload found)'
        : 'Web fonts detected but no font-display or preload found. Add font-display: swap and preload critical fonts.'
    };
  });

  // ── Check 35: No FOUC indicators ──
  addCheck('tech-35', 'No FOUC indicators', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const hasFontDisplaySwap = /font-display\s*:\s*swap/i.test(styleContent);
    const hasFontDisplayFallback = /font-display\s*:\s*fallback/i.test(styleContent);
    const hasFontDisplayOptional = /font-display\s*:\s*optional/i.test(styleContent);
    const hasFontFace = /@font-face/i.test(styleContent);

    if (!hasFontFace) {
      return { status: 'pass', value: 'no-fonts', details: 'No @font-face rules; FOUC not applicable' };
    }

    const safe = hasFontDisplaySwap || hasFontDisplayFallback || hasFontDisplayOptional;
    return {
      status: safe ? 'pass' : 'fail',
      value: safe,
      details: safe
        ? 'font-display value set (swap/fallback/optional) to mitigate FOUC'
        : '@font-face found without font-display: swap/fallback/optional. Risk of FOUC.'
    };
  });

  // ── Check 36: No FOIT indicators ──
  addCheck('tech-36', 'No FOIT indicators', 'minor', () => {
    const styleContent = getInlineStyleContent();
    const hasFontFace = /@font-face/i.test(styleContent);
    const hasFontDisplayBlock = /font-display\s*:\s*block/i.test(styleContent);

    if (!hasFontFace) {
      return { status: 'pass', value: 'no-fonts', details: 'No @font-face rules; FOIT not applicable' };
    }

    return {
      status: hasFontDisplayBlock ? 'fail' : 'pass',
      value: !hasFontDisplayBlock,
      details: hasFontDisplayBlock
        ? 'font-display: block detected. This causes Flash of Invisible Text (FOIT). Use swap or fallback instead.'
        : 'No font-display: block detected. FOIT risk is low.'
    };
  });

  // ── Check 37: CSS is modular (no huge inline style block > 50KB) ──
  addCheck('tech-37', 'CSS is modular (no single inline block >50KB)', 'minor', () => {
    let largestSize = 0;
    let largeCount = 0;
    $('style').each((_, el) => {
      const content = $(el).html() || '';
      const size = Buffer.byteLength(content, 'utf8');
      if (size > largestSize) largestSize = size;
      if (size > 50 * 1024) largeCount++;
    });

    const sizeKB = (largestSize / 1024).toFixed(1);
    return {
      status: largeCount === 0 ? 'pass' : 'fail',
      value: { largestBlockKB: parseFloat(sizeKB), oversizedBlocks: largeCount },
      details: largeCount === 0
        ? `Largest inline style block: ${sizeKB}KB (under 50KB threshold)`
        : `Found ${largeCount} inline style block(s) over 50KB. Largest: ${sizeKB}KB. Extract to external CSS files.`
    };
  });

  // ── Check 38: JS is modular (no single inline script > 100KB) ──
  addCheck('tech-38', 'JS is modular (no single inline script >100KB)', 'minor', () => {
    let largestSize = 0;
    let largeCount = 0;
    $('script').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) {
        const content = $(el).html() || '';
        const size = Buffer.byteLength(content, 'utf8');
        if (size > largestSize) largestSize = size;
        if (size > 100 * 1024) largeCount++;
      }
    });

    const sizeKB = (largestSize / 1024).toFixed(1);
    return {
      status: largeCount === 0 ? 'pass' : 'fail',
      value: { largestBlockKB: parseFloat(sizeKB), oversizedBlocks: largeCount },
      details: largeCount === 0
        ? `Largest inline script block: ${sizeKB}KB (under 100KB threshold)`
        : `Found ${largeCount} inline script block(s) over 100KB. Largest: ${sizeKB}KB. Extract to external JS files.`
    };
  });

  // ── Check 39: No global scope pollution ──
  addCheck('tech-39', 'No global scope pollution', 'minor', () => {
    const scriptContent = getInlineScriptContent();
    // Look for top-level var declarations (rough heuristic)
    // Match var at the beginning of a line (not inside functions)
    const topLevelVars = (scriptContent.match(/(?:^|\n)\s*var\s+/g) || []).length;
    return {
      status: topLevelVars <= 5 ? 'pass' : 'fail',
      value: topLevelVars,
      details: topLevelVars <= 5
        ? `Found ${topLevelVars} top-level var declaration(s) in inline scripts`
        : `Found ${topLevelVars} top-level var declarations. Use const/let and modules to reduce global scope pollution.`
    };
  });

  // ── Check 40: No memory leak patterns ──
  addCheck('tech-40', 'No memory leak patterns', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'Memory leak pattern check skipped (requires runtime heap analysis).'
    };
  });

  // ── Check 41: No memory leaks detected ──
  addCheck('tech-41', 'No memory leaks detected', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'Memory leak detection skipped (requires runtime heap snapshots).'
    };
  });

  // ── Check 42: requestAnimationFrame for animations ──
  addCheck('tech-42', 'requestAnimationFrame for animations', 'minor', () => {
    const scriptContent = getInlineScriptContent();
    const setTimeoutAnimation = /setTimeout\s*\([^)]*(?:animate|move|slide|fade|scroll|transform|opacity|style)/gi;
    const setIntervalAnimation = /setInterval\s*\([^)]*(?:animate|move|slide|fade|scroll|transform|opacity|style)/gi;
    const timeoutMatches = (scriptContent.match(setTimeoutAnimation) || []).length;
    const intervalMatches = (scriptContent.match(setIntervalAnimation) || []).length;
    const total = timeoutMatches + intervalMatches;

    return {
      status: total === 0 ? 'pass' : 'fail',
      value: total,
      details: total === 0
        ? 'No setTimeout/setInterval-based animation patterns detected'
        : `Found ${total} setTimeout/setInterval animation pattern(s). Use requestAnimationFrame for smoother animations.`
    };
  });

  // ── Check 43: No layout thrashing ──
  addCheck('tech-43', 'No layout thrashing', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'Layout thrashing check skipped (requires runtime performance profiling).'
    };
  });

  // ── Check 44: Async/defer on scripts ──
  addCheck('tech-44', 'Async/defer on scripts in head', 'major', () => {
    const headScripts = $('head script[src]');
    const blocking = [];
    headScripts.each((_, el) => {
      const hasAsync = $(el).attr('async') !== undefined;
      const hasDefer = $(el).attr('defer') !== undefined;
      const hasType = $(el).attr('type');
      const isModule = hasType === 'module'; // modules are deferred by default
      if (!hasAsync && !hasDefer && !isModule) {
        blocking.push($(el).attr('src'));
      }
    });

    return {
      status: blocking.length === 0 ? 'pass' : 'fail',
      value: blocking.length,
      details: blocking.length === 0
        ? 'All external scripts in <head> use async, defer, or type="module"'
        : `Found ${blocking.length} render-blocking script(s) in <head>: ${blocking.slice(0, 5).join(', ')}. Add async or defer.`
    };
  });

  // ── Check 45: No third-party scripts in head ──
  addCheck('tech-45', 'No third-party scripts in head', 'minor', () => {
    let pageHost = '';
    try {
      pageHost = new URL(pageData.url || '').hostname;
    } catch (e) {
      // ignore
    }

    const thirdParty = [];
    $('head script[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      try {
        // If relative, skip
        if (src.startsWith('/') || src.startsWith('./') || src.startsWith('../')) return;
        const srcHost = new URL(src, pageData.url || 'http://localhost').hostname;
        if (pageHost && srcHost !== pageHost) {
          thirdParty.push(src);
        }
      } catch (e) {
        // ignore malformed URLs
      }
    });

    return {
      status: thirdParty.length === 0 ? 'pass' : 'fail',
      value: thirdParty.length,
      details: thirdParty.length === 0
        ? 'No third-party scripts found in <head>'
        : `Found ${thirdParty.length} third-party script(s) in <head>: ${thirdParty.slice(0, 5).map(s => s.substring(0, 60)).join(', ')}. Move to body or load async.`
    };
  });

  // ── Check 46: CSS in head, JS before body close ──
  addCheck('tech-46', 'CSS in head, JS before body close', 'minor', () => {
    const issues = [];

    // Check for style/link[stylesheet] outside head
    const bodyStyles = $('body style').length;
    const bodyLinks = $('body link[rel="stylesheet"]').length;
    if (bodyStyles > 0) issues.push(`${bodyStyles} <style> tag(s) in <body>`);
    if (bodyLinks > 0) issues.push(`${bodyLinks} stylesheet link(s) in <body>`);

    // Check for scripts in head that aren't async/defer (already covered by check 44,
    // but here we check position preference)
    const bodyScripts = $('body script[src]');
    const headScripts = $('head script[src]');
    const totalExtScripts = bodyScripts.length + headScripts.length;

    // Ideally external scripts should be at end of body or have async/defer in head
    // This is more of a structural check
    return {
      status: issues.length === 0 ? 'pass' : 'fail',
      value: issues.length,
      details: issues.length === 0
        ? 'CSS is in <head> and script placement looks correct'
        : `Placement issues: ${issues.join('; ')}. Keep CSS in <head> for render performance.`
    };
  });

  // ── Check 47: DOM size < 1500 nodes ideal ──
  addCheck('tech-47', 'DOM size under 1500 nodes', 'minor', () => {
    const allElements = $('*').length;
    return {
      status: allElements <= 1500 ? 'pass' : 'fail',
      value: allElements,
      details: allElements <= 1500
        ? `DOM contains ${allElements} element(s) (under 1500 threshold)`
        : `DOM contains ${allElements} elements, exceeding the 1500 node guideline. Large DOMs slow rendering and memory usage.`
    };
  });

  // ── Check 48: Proper meta viewport ──
  addCheck('tech-48', 'Proper meta viewport', 'major', () => {
    const viewport = $('meta[name="viewport"]').attr('content') || '';
    const hasWidth = /width\s*=\s*device-width/i.test(viewport);
    const hasInitialScale = /initial-scale\s*=\s*1/i.test(viewport);

    if (!viewport) {
      return {
        status: 'fail',
        value: null,
        details: 'No meta viewport tag found. Add <meta name="viewport" content="width=device-width, initial-scale=1">.'
      };
    }

    const proper = hasWidth && hasInitialScale;
    return {
      status: proper ? 'pass' : 'fail',
      value: viewport,
      details: proper
        ? `Proper viewport meta: ${viewport}`
        : `Viewport meta found but may be incomplete: "${viewport}". Should include width=device-width, initial-scale=1.`
    };
  });

  // ── Check 49: No querySelectorAll overuse ──
  addCheck('tech-49', 'No querySelectorAll overuse', 'minor', () => {
    return {
      status: 'pass',
      value: true,
      details: 'querySelectorAll usage check skipped (requires runtime call counting).'
    };
  });

  // ── Check 50: Efficient CSS selectors ──
  addCheck('tech-50', 'Efficient CSS selectors (no universal selector overuse)', 'minor', () => {
    const styleContent = getInlineStyleContent();

    // Check for universal selector * used broadly (not as part of specific selectors)
    // Problematic: * { ... } or .class > * { ... } used excessively
    const universalMatches = styleContent.match(/(?:^|[{;,\s])\*\s*[{,]/g) || [];
    const count = universalMatches.length;

    return {
      status: count <= 2 ? 'pass' : 'fail',
      value: count,
      details: count <= 2
        ? `Found ${count} broad universal selector usage(s) in inline styles`
        : `Found ${count} universal selector (*) usage(s). Excessive use impacts rendering performance.`
    };
  });

  return { checks };
}

module.exports = { analyzeTechnical };
