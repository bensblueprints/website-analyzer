'use strict';

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Mapping of axe-core violation IDs (or prefixes) to our 30 grouped categories.
 * Each category maps to { id, name, severity }.
 */
const AXE_CATEGORY_MAP = {
  1:  { prefix: ['aria-'], name: 'ARIA attributes valid', severity: 'critical' },
  2:  { prefix: ['color-contrast'], name: 'Color contrast sufficient', severity: 'critical' },
  3:  { prefix: ['image-alt'], name: 'Images have alt text', severity: 'critical' },
  4:  { prefix: ['label'], name: 'Form inputs have labels', severity: 'critical' },
  5:  { prefix: ['link-name'], name: 'Links have accessible names', severity: 'critical' },
  6:  { prefix: ['button-name'], name: 'Buttons have accessible names', severity: 'major' },
  7:  { prefix: ['document-title'], name: 'Document has title', severity: 'major' },
  8:  { prefix: ['html-has-lang'], name: 'HTML has lang attribute', severity: 'major' },
  9:  { prefix: ['html-lang-valid'], name: 'HTML lang is valid', severity: 'major' },
  10: { prefix: ['input-image-alt'], name: 'Input images have alt text', severity: 'major' },
  11: { prefix: ['meta-viewport'], name: 'Meta viewport allows zoom', severity: 'major' },
  12: { prefix: ['bypass'], name: 'Skip navigation link present', severity: 'major' },
  13: { prefix: ['heading-order'], name: 'Heading order sequential', severity: 'major' },
  14: { prefix: ['landmark-'], name: 'ARIA landmarks used correctly', severity: 'major' },
  15: { prefix: ['list'], name: 'Lists structured correctly', severity: 'minor' },
  16: { prefix: ['listitem'], name: 'List items within lists', severity: 'minor' },
  17: { prefix: ['definition-list'], name: 'Definition lists valid', severity: 'minor' },
  18: { prefix: ['dlitem'], name: 'Definition list items valid', severity: 'minor' },
  19: { prefix: ['table-'], name: 'Tables structured correctly', severity: 'minor' },
  20: { prefix: ['td-headers-attr'], name: 'TD headers attribute valid', severity: 'minor' },
  21: { prefix: ['th-has-data-cells'], name: 'TH has associated data cells', severity: 'minor' },
  22: { prefix: ['valid-lang'], name: 'Valid lang attributes', severity: 'minor' },
  23: { prefix: ['video-caption'], name: 'Videos have captions', severity: 'major' },
  24: { prefix: ['audio-caption'], name: 'Audio has captions', severity: 'major' },
  25: { prefix: ['blink', 'marquee'], name: 'No blink or marquee elements', severity: 'critical' },
  26: { prefix: ['frame-title'], name: 'Frames have titles', severity: 'minor' },
  27: { prefix: ['server-side-image-map'], name: 'No server-side image maps', severity: 'minor' },
  28: { prefix: ['tabindex'], name: 'Tabindex used correctly', severity: 'minor' },
  29: { prefix: ['scope-attr-valid'], name: 'Scope attribute valid', severity: 'minor' },
  30: { prefix: ['role-'], name: 'ARIA roles valid', severity: 'major' },
};

/**
 * Valid ARIA roles per WAI-ARIA 1.2 specification.
 */
const VALID_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'command', 'comment', 'complementary', 'composite', 'contentinfo', 'definition',
  'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
  'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'input',
  'insertion', 'landmark', 'link', 'list', 'listbox', 'listitem', 'log', 'main',
  'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'range', 'region',
  'roletype', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'section', 'sectionhead', 'select', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'structure', 'subscript', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time',
  'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem', 'widget',
  'window',
]);

/**
 * Valid BCP 47 language tag pattern (simplified but covers most real-world tags).
 */
const BCP47_REGEX = /^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-[a-zA-Z]{2}|-\d{3})?(-([a-zA-Z\d]{5,8}|\d[a-zA-Z\d]{3}))*(-[a-wyzA-WYZ\d](-[a-zA-Z\d]{2,8})+)*(-x(-[a-zA-Z\d]{1,8})+)?$/;

/**
 * Non-descriptive link text patterns.
 */
const NONDESCRIPTIVE_LINK_TEXT = [
  /^click\s*here$/i,
  /^here$/i,
  /^read\s*more$/i,
  /^more$/i,
  /^learn\s*more$/i,
  /^link$/i,
  /^go$/i,
  /^download$/i,
  /^details$/i,
  /^info$/i,
  /^this$/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(id, name, status, severity, value, details) {
  return { id, name, status, severity, value, details };
}

/**
 * Determine which of our 30 axe categories a violation ID falls into.
 * Returns the category number (1-30) or null if it does not match.
 */
function matchAxeCategory(violationId) {
  for (const [catNum, cat] of Object.entries(AXE_CATEGORY_MAP)) {
    for (const prefix of cat.prefix) {
      // Exact match or prefix match (e.g. 'aria-' matches 'aria-hidden-focus')
      if (violationId === prefix || violationId.startsWith(prefix)) {
        return parseInt(catNum, 10);
      }
    }
  }
  return null;
}

/**
 * Extract inline style value for a given property from an element's style attribute.
 */
function getInlineStyle($el, prop) {
  const style = $el.attr('style') || '';
  const regex = new RegExp(prop + '\\s*:\\s*([^;]+)', 'i');
  const match = style.match(regex);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze accessibility of a page.
 *
 * @param {object} pageData - { url, html, statusCode, headers, networkRequests, consoleMessages, links }
 * @param {object|null} axeResults - Results from @axe-core/puppeteer, or null.
 * @returns {Promise<{checks: Array}>}
 */
async function analyzeAccessibility(pageData, axeResults) {
  const checks = [];
  const html = pageData.html || '';

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    $ = cheerio.load('');
  }

  // ------------------------------------------------------------------
  // Checks 1-30: Axe-core violation categories
  // ------------------------------------------------------------------
  const axeViolationsByCategory = {};
  if (axeResults && Array.isArray(axeResults.violations)) {
    for (const violation of axeResults.violations) {
      const catNum = matchAxeCategory(violation.id);
      if (catNum !== null) {
        if (!axeViolationsByCategory[catNum]) {
          axeViolationsByCategory[catNum] = [];
        }
        axeViolationsByCategory[catNum].push(violation);
      }
    }
  }

  for (let i = 1; i <= 30; i++) {
    const cat = AXE_CATEGORY_MAP[i];
    const checkId = `a11y-${i}`;

    try {
      if (!axeResults) {
        checks.push(makeCheck(checkId, cat.name, 'warn', cat.severity, null, 'axe-core data not available'));
      } else if (axeViolationsByCategory[i] && axeViolationsByCategory[i].length > 0) {
        const violations = axeViolationsByCategory[i];
        const totalNodes = violations.reduce((sum, v) => sum + (v.nodes ? v.nodes.length : 0), 0);
        const ids = violations.map(v => v.id).join(', ');
        const impact = violations.reduce((worst, v) => {
          const order = { critical: 4, serious: 3, moderate: 2, minor: 1 };
          return (order[v.impact] || 0) > (order[worst] || 0) ? v.impact : worst;
        }, 'minor');
        checks.push(makeCheck(
          checkId, cat.name, 'fail', cat.severity,
          `${totalNodes} violation(s)`,
          `Axe rules failed: ${ids} (${impact} impact, ${totalNodes} affected node(s))`
        ));
      } else {
        checks.push(makeCheck(checkId, cat.name, 'pass', cat.severity, 'No violations', 'All axe-core rules in this category passed'));
      }
    } catch (err) {
      checks.push(makeCheck(checkId, cat.name, 'warn', cat.severity, null, `Error checking: ${err.message}`));
    }
  }

  // ------------------------------------------------------------------
  // Check 31: Color contrast >= 4.5:1 for normal text (from axe)
  // ------------------------------------------------------------------
  try {
    if (!axeResults) {
      checks.push(makeCheck('a11y-31', 'Color contrast ratio >= 4.5:1 (normal text)', 'warn', 'critical', null, 'axe-core data not available'));
    } else {
      const contrastViolations = (axeResults.violations || []).filter(v => v.id === 'color-contrast');
      const normalTextViolations = [];
      for (const v of contrastViolations) {
        for (const node of (v.nodes || [])) {
          // axe-core reports font-size in the message; large text is >= 18pt or >= 14pt bold
          const msg = (node.message || node.failureSummary || '').toLowerCase();
          // If it does not mention "large text", it is normal text
          if (!msg.includes('large text')) {
            normalTextViolations.push(node);
          }
        }
      }
      if (normalTextViolations.length > 0) {
        checks.push(makeCheck('a11y-31', 'Color contrast ratio >= 4.5:1 (normal text)', 'fail', 'critical',
          `${normalTextViolations.length} element(s) fail`,
          `${normalTextViolations.length} normal-text element(s) have insufficient contrast`));
      } else {
        checks.push(makeCheck('a11y-31', 'Color contrast ratio >= 4.5:1 (normal text)', 'pass', 'critical',
          'All pass', 'Normal text meets 4.5:1 contrast ratio'));
      }
    }
  } catch (err) {
    checks.push(makeCheck('a11y-31', 'Color contrast ratio >= 4.5:1 (normal text)', 'warn', 'critical', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 32: Color contrast >= 3:1 for large text (from axe)
  // ------------------------------------------------------------------
  try {
    if (!axeResults) {
      checks.push(makeCheck('a11y-32', 'Color contrast ratio >= 3:1 (large text)', 'warn', 'major', null, 'axe-core data not available'));
    } else {
      const contrastViolations = (axeResults.violations || []).filter(v => v.id === 'color-contrast');
      const largeTextViolations = [];
      for (const v of contrastViolations) {
        for (const node of (v.nodes || [])) {
          const msg = (node.message || node.failureSummary || '').toLowerCase();
          if (msg.includes('large text')) {
            largeTextViolations.push(node);
          }
        }
      }
      if (largeTextViolations.length > 0) {
        checks.push(makeCheck('a11y-32', 'Color contrast ratio >= 3:1 (large text)', 'fail', 'major',
          `${largeTextViolations.length} element(s) fail`,
          `${largeTextViolations.length} large-text element(s) have insufficient contrast`));
      } else {
        checks.push(makeCheck('a11y-32', 'Color contrast ratio >= 3:1 (large text)', 'pass', 'major',
          'All pass', 'Large text meets 3:1 contrast ratio'));
      }
    }
  } catch (err) {
    checks.push(makeCheck('a11y-32', 'Color contrast ratio >= 3:1 (large text)', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 33: All form inputs have labels (cheerio)
  // ------------------------------------------------------------------
  try {
    const formInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea');
    let unlabeled = 0;
    formInputs.each(function () {
      const el = $(this);
      const id = el.attr('id');
      const ariaLabel = el.attr('aria-label');
      const ariaLabelledby = el.attr('aria-labelledby');
      const title = el.attr('title');
      const hasWrappingLabel = el.closest('label').length > 0;
      const hasForLabel = id ? $(`label[for="${id}"]`).length > 0 : false;

      if (!ariaLabel && !ariaLabelledby && !title && !hasWrappingLabel && !hasForLabel) {
        unlabeled++;
      }
    });
    const total = formInputs.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-33', 'All form inputs have labels', 'pass', 'major', 'No inputs found', 'No form inputs on page'));
    } else if (unlabeled === 0) {
      checks.push(makeCheck('a11y-33', 'All form inputs have labels', 'pass', 'major', `${total} input(s) all labeled`, 'All form inputs have associated labels'));
    } else {
      checks.push(makeCheck('a11y-33', 'All form inputs have labels', 'fail', 'major',
        `${unlabeled}/${total} missing labels`,
        `${unlabeled} of ${total} form input(s) lack an associated label (via for=, wrapping <label>, aria-label, aria-labelledby, or title)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-33', 'All form inputs have labels', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 34: Form labels associated with for= attribute
  // ------------------------------------------------------------------
  try {
    const labels = $('label');
    let missingFor = 0;
    let totalLabels = 0;
    labels.each(function () {
      totalLabels++;
      const el = $(this);
      const forAttr = el.attr('for');
      const hasWrappedInput = el.find('input, select, textarea').length > 0;
      if (!forAttr && !hasWrappedInput) {
        missingFor++;
      }
    });
    if (totalLabels === 0) {
      checks.push(makeCheck('a11y-34', 'Form labels properly associated', 'pass', 'major', 'No labels found', 'No label elements on page'));
    } else if (missingFor === 0) {
      checks.push(makeCheck('a11y-34', 'Form labels properly associated', 'pass', 'major', `${totalLabels} label(s) all associated`, 'All labels are properly associated via for= attribute or wrapping'));
    } else {
      checks.push(makeCheck('a11y-34', 'Form labels properly associated', 'fail', 'major',
        `${missingFor}/${totalLabels} not associated`,
        `${missingFor} label(s) lack a for= attribute and do not wrap an input`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-34', 'Form labels properly associated', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 35: Required fields indicated (aria-required or required)
  // ------------------------------------------------------------------
  try {
    const formInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
    const requiredInputs = formInputs.filter(function () {
      const el = $(this);
      return el.attr('required') !== undefined || el.attr('aria-required') === 'true';
    });
    const total = formInputs.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-35', 'Required fields indicated', 'pass', 'minor', 'No inputs found', 'No form inputs to check'));
    } else if (requiredInputs.length > 0) {
      checks.push(makeCheck('a11y-35', 'Required fields indicated', 'pass', 'minor',
        `${requiredInputs.length}/${total} marked required`,
        `${requiredInputs.length} input(s) use required or aria-required attributes`));
    } else {
      checks.push(makeCheck('a11y-35', 'Required fields indicated', 'warn', 'minor',
        'No required fields indicated',
        'No form inputs use required or aria-required attributes; verify if any fields should be marked required'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-35', 'Required fields indicated', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 36: Form error messages descriptive (aria-describedby)
  // ------------------------------------------------------------------
  try {
    const formInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
    let hasDescribedby = 0;
    formInputs.each(function () {
      if ($(this).attr('aria-describedby')) {
        hasDescribedby++;
      }
    });
    const total = formInputs.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-36', 'Form error messages descriptive', 'pass', 'minor', 'No inputs found', 'No form inputs on page'));
    } else if (hasDescribedby > 0) {
      checks.push(makeCheck('a11y-36', 'Form error messages descriptive', 'pass', 'minor',
        `${hasDescribedby}/${total} have aria-describedby`,
        `${hasDescribedby} input(s) use aria-describedby for descriptive messages`));
    } else {
      checks.push(makeCheck('a11y-36', 'Form error messages descriptive', 'warn', 'minor',
        'No aria-describedby found',
        'No form inputs use aria-describedby for error/help messages'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-36', 'Form error messages descriptive', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 37: Skip navigation link present
  // ------------------------------------------------------------------
  try {
    const allLinks = $('a');
    let hasSkipLink = false;
    const skipPattern = /skip\s*(to\s*)?(main|content|nav)/i;

    // Check first 5 links on the page
    const linksToCheck = Math.min(allLinks.length, 5);
    for (let i = 0; i < linksToCheck; i++) {
      const el = $(allLinks[i]);
      const text = (el.text() || '').trim();
      const href = el.attr('href') || '';
      if (skipPattern.test(text) || href === '#main' || href === '#main-content' || href === '#content' || href === '#maincontent') {
        hasSkipLink = true;
        break;
      }
    }

    // Also check for skip links with class patterns
    if (!hasSkipLink) {
      const skipByClass = $('a.skip-link, a.skip-nav, a.skip-to-content, a.skip-navigation, a[class*="skip"]');
      if (skipByClass.length > 0) {
        hasSkipLink = true;
      }
    }

    if (hasSkipLink) {
      checks.push(makeCheck('a11y-37', 'Skip navigation link present', 'pass', 'major', 'Found', 'Skip navigation link is present'));
    } else {
      checks.push(makeCheck('a11y-37', 'Skip navigation link present', 'fail', 'major', 'Not found', 'No skip navigation link found in the first few links on the page'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-37', 'Skip navigation link present', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 38: Keyboard focus visible (no outline:none/outline:0)
  // ------------------------------------------------------------------
  try {
    const styleBlocks = $('style');
    let outlineRemoved = false;
    let evidence = [];

    styleBlocks.each(function () {
      const css = $(this).html() || '';
      // Check for patterns that remove outline on focus
      if (/outline\s*:\s*(none|0)\b/i.test(css)) {
        outlineRemoved = true;
        // Try to find selector context
        const matches = css.match(/[^{}]+\{[^}]*outline\s*:\s*(none|0)[^}]*/gi);
        if (matches) {
          evidence.push(...matches.map(m => m.trim().substring(0, 80)));
        }
      }
    });

    // Also check inline styles
    $('[style*="outline"]').each(function () {
      const style = $(this).attr('style') || '';
      if (/outline\s*:\s*(none|0)\b/i.test(style)) {
        outlineRemoved = true;
        evidence.push(`Inline style: ${style.substring(0, 80)}`);
      }
    });

    if (outlineRemoved) {
      checks.push(makeCheck('a11y-38', 'Keyboard focus visible', 'fail', 'major',
        'outline:none detected',
        `Focus outlines removed in CSS: ${evidence.slice(0, 3).join('; ')}`));
    } else {
      checks.push(makeCheck('a11y-38', 'Keyboard focus visible', 'pass', 'major', 'No outline removal detected', 'No CSS rules removing focus outlines found'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-38', 'Keyboard focus visible', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 39: Tab order logical (no tabindex > 0)
  // ------------------------------------------------------------------
  try {
    const positiveTabindex = $('[tabindex]').filter(function () {
      const val = parseInt($(this).attr('tabindex'), 10);
      return !isNaN(val) && val > 0;
    });

    if (positiveTabindex.length === 0) {
      checks.push(makeCheck('a11y-39', 'Tab order logical', 'pass', 'major', 'No positive tabindex', 'No elements with tabindex > 0 found'));
    } else {
      checks.push(makeCheck('a11y-39', 'Tab order logical', 'fail', 'major',
        `${positiveTabindex.length} element(s) with positive tabindex`,
        `${positiveTabindex.length} element(s) use tabindex > 0, which disrupts natural tab order`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-39', 'Tab order logical', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 40: No positive tabindex values
  // ------------------------------------------------------------------
  try {
    const positiveTabindex = $('[tabindex]').filter(function () {
      const val = parseInt($(this).attr('tabindex'), 10);
      return !isNaN(val) && val > 0;
    });
    const values = [];
    positiveTabindex.each(function () {
      values.push($(this).attr('tabindex'));
    });

    if (positiveTabindex.length === 0) {
      checks.push(makeCheck('a11y-40', 'No positive tabindex values', 'pass', 'major', 'None found', 'No positive tabindex values on the page'));
    } else {
      const uniqueVals = [...new Set(values)].sort().join(', ');
      checks.push(makeCheck('a11y-40', 'No positive tabindex values', 'fail', 'major',
        `${positiveTabindex.length} element(s)`,
        `Found tabindex values: ${uniqueVals} on ${positiveTabindex.length} element(s)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-40', 'No positive tabindex values', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 41: ARIA landmarks used (main, nav, banner, etc.)
  // ------------------------------------------------------------------
  try {
    const landmarks = [];
    const mainEl = $('main, [role="main"]');
    const navEl = $('nav, [role="navigation"]');
    const bannerEl = $('header, [role="banner"]');
    const contentinfoEl = $('footer, [role="contentinfo"]');
    const searchEl = $('[role="search"]');
    const complementaryEl = $('aside, [role="complementary"]');

    if (mainEl.length > 0) landmarks.push('main');
    if (navEl.length > 0) landmarks.push('navigation');
    if (bannerEl.length > 0) landmarks.push('banner');
    if (contentinfoEl.length > 0) landmarks.push('contentinfo');
    if (searchEl.length > 0) landmarks.push('search');
    if (complementaryEl.length > 0) landmarks.push('complementary');

    if (landmarks.length >= 2) {
      checks.push(makeCheck('a11y-41', 'ARIA landmarks used', 'pass', 'major',
        `${landmarks.length} landmark(s)`,
        `Found landmarks: ${landmarks.join(', ')}`));
    } else if (landmarks.length === 1) {
      checks.push(makeCheck('a11y-41', 'ARIA landmarks used', 'warn', 'major',
        `1 landmark (${landmarks[0]})`,
        'Only one landmark found; consider adding more (main, nav, banner, contentinfo)'));
    } else {
      checks.push(makeCheck('a11y-41', 'ARIA landmarks used', 'fail', 'major',
        'No landmarks',
        'No ARIA landmarks found; use semantic elements or role attributes (main, nav, banner, contentinfo)'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-41', 'ARIA landmarks used', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 42: ARIA labels on interactive elements
  // ------------------------------------------------------------------
  try {
    const interactive = $('button, a, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="slider"], [role="switch"]');
    let missingAriaLabel = 0;
    interactive.each(function () {
      const el = $(this);
      const text = (el.text() || '').trim();
      const ariaLabel = el.attr('aria-label');
      const ariaLabelledby = el.attr('aria-labelledby');
      const title = el.attr('title');
      const alt = el.attr('alt');
      const placeholder = el.attr('placeholder');
      const value = el.attr('value');
      const id = el.attr('id');
      const hasForLabel = id ? $(`label[for="${id}"]`).length > 0 : false;

      if (!text && !ariaLabel && !ariaLabelledby && !title && !alt && !placeholder && !value && !hasForLabel) {
        missingAriaLabel++;
      }
    });

    const total = interactive.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-42', 'ARIA labels on interactive elements', 'pass', 'minor', 'No interactive elements', 'No interactive elements found'));
    } else if (missingAriaLabel === 0) {
      checks.push(makeCheck('a11y-42', 'ARIA labels on interactive elements', 'pass', 'minor',
        `${total} element(s) all labeled`, 'All interactive elements have accessible names'));
    } else {
      checks.push(makeCheck('a11y-42', 'ARIA labels on interactive elements', 'fail', 'minor',
        `${missingAriaLabel}/${total} missing names`,
        `${missingAriaLabel} interactive element(s) lack accessible names (text, aria-label, aria-labelledby, or title)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-42', 'ARIA labels on interactive elements', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 43: ARIA roles are valid
  // ------------------------------------------------------------------
  try {
    const elementsWithRole = $('[role]');
    let invalidRoles = [];
    elementsWithRole.each(function () {
      const roleAttr = ($(this).attr('role') || '').trim().toLowerCase();
      // role attribute can contain space-separated role tokens
      const roles = roleAttr.split(/\s+/).filter(Boolean);
      for (const r of roles) {
        if (!VALID_ARIA_ROLES.has(r)) {
          invalidRoles.push(r);
        }
      }
    });

    if (invalidRoles.length === 0) {
      checks.push(makeCheck('a11y-43', 'ARIA roles are valid', 'pass', 'minor',
        `${elementsWithRole.length} element(s) checked`, 'All ARIA roles are valid'));
    } else {
      const unique = [...new Set(invalidRoles)];
      checks.push(makeCheck('a11y-43', 'ARIA roles are valid', 'fail', 'minor',
        `${invalidRoles.length} invalid role(s)`,
        `Invalid ARIA roles found: ${unique.slice(0, 10).join(', ')}`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-43', 'ARIA roles are valid', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 44: No misused ARIA attributes (from axe)
  // ------------------------------------------------------------------
  try {
    if (!axeResults) {
      checks.push(makeCheck('a11y-44', 'No misused ARIA attributes', 'warn', 'minor', null, 'axe-core data not available'));
    } else {
      const ariaViolations = (axeResults.violations || []).filter(v =>
        v.id.startsWith('aria-') && !['aria-hidden-focus', 'aria-hidden-body'].includes(v.id)
      );
      const totalNodes = ariaViolations.reduce((sum, v) => sum + (v.nodes ? v.nodes.length : 0), 0);
      if (totalNodes === 0) {
        checks.push(makeCheck('a11y-44', 'No misused ARIA attributes', 'pass', 'minor', 'No misuse detected', 'No ARIA attribute misuse found by axe-core'));
      } else {
        const ids = ariaViolations.map(v => v.id).join(', ');
        checks.push(makeCheck('a11y-44', 'No misused ARIA attributes', 'fail', 'minor',
          `${totalNodes} issue(s)`,
          `ARIA attribute misuse detected: ${ids} (${totalNodes} affected node(s))`));
      }
    }
  } catch (err) {
    checks.push(makeCheck('a11y-44', 'No misused ARIA attributes', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 45: Language attribute on html tag
  // ------------------------------------------------------------------
  try {
    const lang = $('html').attr('lang');
    if (lang && lang.trim().length > 0) {
      checks.push(makeCheck('a11y-45', 'Language attribute on html tag', 'pass', 'major', lang.trim(), `html lang="${lang.trim()}"`));
    } else {
      checks.push(makeCheck('a11y-45', 'Language attribute on html tag', 'fail', 'major', 'Missing', 'No lang attribute found on <html> element'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-45', 'Language attribute on html tag', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 46: Language attribute is valid BCP 47
  // ------------------------------------------------------------------
  try {
    const lang = ($('html').attr('lang') || '').trim();
    if (!lang) {
      checks.push(makeCheck('a11y-46', 'Language attribute is valid BCP 47', 'fail', 'minor', 'No lang attribute', 'Cannot validate; no lang attribute on html'));
    } else if (BCP47_REGEX.test(lang)) {
      checks.push(makeCheck('a11y-46', 'Language attribute is valid BCP 47', 'pass', 'minor', lang, `"${lang}" is a valid BCP 47 language tag`));
    } else {
      checks.push(makeCheck('a11y-46', 'Language attribute is valid BCP 47', 'fail', 'minor', lang, `"${lang}" is not a valid BCP 47 language tag`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-46', 'Language attribute is valid BCP 47', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 47: Page has main landmark
  // ------------------------------------------------------------------
  try {
    const mainLandmark = $('main, [role="main"]');
    if (mainLandmark.length > 0) {
      checks.push(makeCheck('a11y-47', 'Page has main landmark', 'pass', 'major', `${mainLandmark.length} found`, 'Page has a main landmark (<main> or role="main")'));
    } else {
      checks.push(makeCheck('a11y-47', 'Page has main landmark', 'fail', 'major', 'Not found', 'No <main> element or role="main" found'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-47', 'Page has main landmark', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 48: Decorative images have alt=""
  // ------------------------------------------------------------------
  try {
    const images = $('img');
    let decorativeWithoutEmptyAlt = 0;
    let decorativeTotal = 0;

    images.each(function () {
      const el = $(this);
      const role = (el.attr('role') || '').toLowerCase();
      const ariaHidden = el.attr('aria-hidden');

      // Consider an image decorative if it has role="presentation", role="none", or aria-hidden="true"
      if (role === 'presentation' || role === 'none' || ariaHidden === 'true') {
        decorativeTotal++;
        const alt = el.attr('alt');
        if (alt !== '') {
          decorativeWithoutEmptyAlt++;
        }
      }
    });

    if (decorativeTotal === 0) {
      checks.push(makeCheck('a11y-48', 'Decorative images have empty alt', 'pass', 'minor', 'No decorative images', 'No images marked as decorative (role="presentation"/aria-hidden)'));
    } else if (decorativeWithoutEmptyAlt === 0) {
      checks.push(makeCheck('a11y-48', 'Decorative images have empty alt', 'pass', 'minor',
        `${decorativeTotal} decorative image(s) correct`,
        'All decorative images have alt=""'));
    } else {
      checks.push(makeCheck('a11y-48', 'Decorative images have empty alt', 'fail', 'minor',
        `${decorativeWithoutEmptyAlt}/${decorativeTotal} incorrect`,
        `${decorativeWithoutEmptyAlt} decorative image(s) should have alt="" (empty alt text)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-48', 'Decorative images have empty alt', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 49: No auto-playing media
  // ------------------------------------------------------------------
  try {
    const autoplayMedia = $('audio[autoplay], video[autoplay]');
    let problematic = 0;

    autoplayMedia.each(function () {
      const el = $(this);
      // Autoplay with muted is acceptable (e.g. background video)
      if (el.attr('muted') === undefined) {
        problematic++;
      }
    });

    if (problematic === 0) {
      checks.push(makeCheck('a11y-49', 'No auto-playing media', 'pass', 'major', 'None found', 'No unmuted auto-playing audio/video elements found'));
    } else {
      checks.push(makeCheck('a11y-49', 'No auto-playing media', 'fail', 'major',
        `${problematic} element(s)`,
        `${problematic} audio/video element(s) have autoplay without muted attribute`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-49', 'No auto-playing media', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 50: Media has controls
  // ------------------------------------------------------------------
  try {
    const mediaElements = $('audio, video');
    let missingControls = 0;

    mediaElements.each(function () {
      if ($(this).attr('controls') === undefined) {
        missingControls++;
      }
    });

    const total = mediaElements.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-50', 'Media has controls', 'pass', 'major', 'No media elements', 'No audio/video elements on page'));
    } else if (missingControls === 0) {
      checks.push(makeCheck('a11y-50', 'Media has controls', 'pass', 'major',
        `${total} element(s) have controls`, 'All audio/video elements have controls attribute'));
    } else {
      checks.push(makeCheck('a11y-50', 'Media has controls', 'fail', 'major',
        `${missingControls}/${total} missing controls`,
        `${missingControls} audio/video element(s) lack the controls attribute`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-50', 'Media has controls', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 51: Video has captions/subtitles track
  // ------------------------------------------------------------------
  try {
    const videos = $('video');
    let missingTrack = 0;

    videos.each(function () {
      const tracks = $(this).find('track[kind="captions"], track[kind="subtitles"]');
      if (tracks.length === 0) {
        missingTrack++;
      }
    });

    const total = videos.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-51', 'Video has captions/subtitles track', 'pass', 'major', 'No videos', 'No video elements on page'));
    } else if (missingTrack === 0) {
      checks.push(makeCheck('a11y-51', 'Video has captions/subtitles track', 'pass', 'major',
        `${total} video(s) have tracks`, 'All video elements have caption/subtitle tracks'));
    } else {
      checks.push(makeCheck('a11y-51', 'Video has captions/subtitles track', 'fail', 'major',
        `${missingTrack}/${total} missing tracks`,
        `${missingTrack} video element(s) lack <track kind="captions"> or <track kind="subtitles">`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-51', 'Video has captions/subtitles track', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 52: Tables have headers (th)
  // ------------------------------------------------------------------
  try {
    const tables = $('table').not('[role="presentation"]').not('[role="none"]');
    let missingHeaders = 0;

    tables.each(function () {
      const ths = $(this).find('th');
      if (ths.length === 0) {
        missingHeaders++;
      }
    });

    const total = tables.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-52', 'Tables have headers (th)', 'pass', 'minor', 'No data tables', 'No data tables on page'));
    } else if (missingHeaders === 0) {
      checks.push(makeCheck('a11y-52', 'Tables have headers (th)', 'pass', 'minor',
        `${total} table(s) have headers`, 'All data tables have th elements'));
    } else {
      checks.push(makeCheck('a11y-52', 'Tables have headers (th)', 'fail', 'minor',
        `${missingHeaders}/${total} missing headers`,
        `${missingHeaders} data table(s) lack th header elements`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-52', 'Tables have headers (th)', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 53: Tables have caption or aria-label
  // ------------------------------------------------------------------
  try {
    const tables = $('table').not('[role="presentation"]').not('[role="none"]');
    let missingCaption = 0;

    tables.each(function () {
      const el = $(this);
      const hasCaption = el.find('caption').length > 0;
      const hasAriaLabel = el.attr('aria-label') || el.attr('aria-labelledby');
      const hasSummary = el.attr('summary');
      if (!hasCaption && !hasAriaLabel && !hasSummary) {
        missingCaption++;
      }
    });

    const total = tables.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-53', 'Tables have caption or aria-label', 'pass', 'minor', 'No data tables', 'No data tables on page'));
    } else if (missingCaption === 0) {
      checks.push(makeCheck('a11y-53', 'Tables have caption or aria-label', 'pass', 'minor',
        `${total} table(s) labeled`, 'All data tables have captions or aria-labels'));
    } else {
      checks.push(makeCheck('a11y-53', 'Tables have caption or aria-label', 'fail', 'minor',
        `${missingCaption}/${total} unlabeled`,
        `${missingCaption} data table(s) lack a <caption>, aria-label, aria-labelledby, or summary attribute`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-53', 'Tables have caption or aria-label', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 54: Data tables use scope attribute
  // ------------------------------------------------------------------
  try {
    const tables = $('table').not('[role="presentation"]').not('[role="none"]');
    let tablesWithScope = 0;
    let tablesWithHeaders = 0;

    tables.each(function () {
      const ths = $(this).find('th');
      if (ths.length > 0) {
        tablesWithHeaders++;
        const hasScope = ths.filter(function () {
          return $(this).attr('scope') !== undefined;
        });
        if (hasScope.length > 0) {
          tablesWithScope++;
        }
      }
    });

    if (tablesWithHeaders === 0) {
      checks.push(makeCheck('a11y-54', 'Data tables use scope attribute', 'pass', 'minor', 'No tables with headers', 'No data tables with th elements to check'));
    } else if (tablesWithScope === tablesWithHeaders) {
      checks.push(makeCheck('a11y-54', 'Data tables use scope attribute', 'pass', 'minor',
        `${tablesWithScope}/${tablesWithHeaders} use scope`, 'All table headers use scope attributes'));
    } else {
      checks.push(makeCheck('a11y-54', 'Data tables use scope attribute', 'warn', 'minor',
        `${tablesWithScope}/${tablesWithHeaders} use scope`,
        `${tablesWithHeaders - tablesWithScope} table(s) with headers do not use scope attributes`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-54', 'Data tables use scope attribute', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 55: No layout tables
  // ------------------------------------------------------------------
  try {
    const allTables = $('table');
    let layoutTables = 0;
    let unmarkedLayoutTables = 0;

    allTables.each(function () {
      const el = $(this);
      const role = (el.attr('role') || '').toLowerCase();
      const hasTh = el.find('th').length > 0;
      const hasCaption = el.find('caption').length > 0;
      const rows = el.find('tr').length;
      const cells = el.find('td').length;

      // Properly marked layout tables
      if (role === 'presentation' || role === 'none') {
        layoutTables++;
        return;
      }

      // Simple structure (single row or single column, no headers) suggests layout table
      if (!hasTh && !hasCaption && ((rows <= 1) || (cells <= rows))) {
        unmarkedLayoutTables++;
      }
    });

    if (unmarkedLayoutTables === 0) {
      checks.push(makeCheck('a11y-55', 'No layout tables', 'pass', 'minor',
        layoutTables > 0 ? `${layoutTables} marked as presentation` : 'No layout tables detected',
        'Tables appear to be properly structured or marked as presentation'));
    } else {
      checks.push(makeCheck('a11y-55', 'No layout tables', 'warn', 'minor',
        `${unmarkedLayoutTables} possible layout table(s)`,
        `${unmarkedLayoutTables} table(s) appear to be used for layout without role="presentation"`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-55', 'No layout tables', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 56: Links are distinguishable (text-decoration)
  // ------------------------------------------------------------------
  try {
    const links = $('a');
    let linksWithNoDecoration = 0;

    links.each(function () {
      const style = $(this).attr('style') || '';
      if (/text-decoration\s*:\s*none/i.test(style)) {
        linksWithNoDecoration++;
      }
    });

    const total = links.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-56', 'Links are distinguishable', 'pass', 'minor', 'No links', 'No links on page'));
    } else if (linksWithNoDecoration === 0) {
      checks.push(makeCheck('a11y-56', 'Links are distinguishable', 'pass', 'minor',
        `${total} link(s) checked`, 'No inline text-decoration:none found on links'));
    } else {
      checks.push(makeCheck('a11y-56', 'Links are distinguishable', 'warn', 'minor',
        `${linksWithNoDecoration}/${total} have text-decoration:none`,
        `${linksWithNoDecoration} link(s) have inline text-decoration:none, which may make them indistinguishable from surrounding text`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-56', 'Links are distinguishable', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 57: Link text is descriptive
  // ------------------------------------------------------------------
  try {
    const links = $('a');
    let nonDescriptiveLinks = [];

    links.each(function () {
      const text = ($(this).text() || '').trim();
      if (text.length === 0) return; // skip empty links (handled elsewhere)

      for (const pattern of NONDESCRIPTIVE_LINK_TEXT) {
        if (pattern.test(text)) {
          nonDescriptiveLinks.push(text);
          break;
        }
      }
    });

    const total = links.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-57', 'Link text is descriptive', 'pass', 'major', 'No links', 'No links on page'));
    } else if (nonDescriptiveLinks.length === 0) {
      checks.push(makeCheck('a11y-57', 'Link text is descriptive', 'pass', 'major',
        `${total} link(s) checked`, 'No non-descriptive link text found'));
    } else {
      const examples = [...new Set(nonDescriptiveLinks)].slice(0, 5).map(t => `"${t}"`).join(', ');
      checks.push(makeCheck('a11y-57', 'Link text is descriptive', 'fail', 'major',
        `${nonDescriptiveLinks.length} non-descriptive link(s)`,
        `Found non-descriptive link text: ${examples}. Use descriptive text instead of generic phrases.`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-57', 'Link text is descriptive', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 58: Adjacent links separated
  // ------------------------------------------------------------------
  try {
    const body = $('body');
    const allElements = body.find('*');
    let adjacentLinkPairs = 0;

    // Look for consecutive <a> tags that are siblings with no text between them
    $('a + a').each(function () {
      const prev = $(this).prev('a');
      if (prev.length > 0) {
        // Check if there is meaningful separating content between them
        const prevEl = prev[0];
        let nextSibling = prevEl.nextSibling;
        let hasSeparator = false;

        while (nextSibling && nextSibling !== this) {
          if (nextSibling.type === 'text' && (nextSibling.data || '').trim().length > 0) {
            hasSeparator = true;
            break;
          }
          if (nextSibling.type === 'tag' && nextSibling.name !== 'a') {
            hasSeparator = true;
            break;
          }
          nextSibling = nextSibling.nextSibling;
        }

        if (!hasSeparator) {
          adjacentLinkPairs++;
        }
      }
    });

    if (adjacentLinkPairs === 0) {
      checks.push(makeCheck('a11y-58', 'Adjacent links separated', 'pass', 'minor', 'None found', 'No unseparated adjacent links detected'));
    } else {
      checks.push(makeCheck('a11y-58', 'Adjacent links separated', 'warn', 'minor',
        `${adjacentLinkPairs} pair(s)`,
        `${adjacentLinkPairs} pair(s) of adjacent links with no separating content found`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-58', 'Adjacent links separated', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 59: Error identification clear (aria-invalid)
  // ------------------------------------------------------------------
  try {
    const formInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
    const ariaInvalid = formInputs.filter(function () {
      return $(this).attr('aria-invalid') !== undefined;
    });

    const total = formInputs.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-59', 'Error identification clear', 'pass', 'minor', 'No inputs', 'No form inputs on page'));
    } else if (ariaInvalid.length > 0) {
      checks.push(makeCheck('a11y-59', 'Error identification clear', 'pass', 'minor',
        `${ariaInvalid.length} input(s) use aria-invalid`,
        'Form inputs use aria-invalid for clear error identification'));
    } else {
      checks.push(makeCheck('a11y-59', 'Error identification clear', 'warn', 'minor',
        'No aria-invalid usage',
        'No form inputs use aria-invalid; consider using it to programmatically indicate errors'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-59', 'Error identification clear', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 60: Page has title
  // ------------------------------------------------------------------
  try {
    const title = $('title').first().text().trim();
    if (title && title.length > 0) {
      checks.push(makeCheck('a11y-60', 'Page has title', 'pass', 'critical', title.substring(0, 100), `Page title: "${title.substring(0, 100)}"`));
    } else {
      checks.push(makeCheck('a11y-60', 'Page has title', 'fail', 'critical', 'Missing', 'Page has no <title> element or it is empty'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-60', 'Page has title', 'warn', 'critical', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 61: Headings structure content (at least h1 and h2)
  // ------------------------------------------------------------------
  try {
    const h1Count = $('h1').length;
    const h2Count = $('h2').length;
    const h3Count = $('h3').length;
    const totalHeadings = h1Count + h2Count + h3Count + $('h4').length + $('h5').length + $('h6').length;

    if (h1Count > 0 && h2Count > 0) {
      checks.push(makeCheck('a11y-61', 'Headings structure content', 'pass', 'major',
        `h1:${h1Count} h2:${h2Count} h3:${h3Count} (${totalHeadings} total)`,
        'Page has proper heading hierarchy with h1 and h2'));
    } else if (h1Count > 0) {
      checks.push(makeCheck('a11y-61', 'Headings structure content', 'warn', 'major',
        `h1:${h1Count} h2:${h2Count} (${totalHeadings} total)`,
        'Page has h1 but no h2; consider adding sub-headings to structure content'));
    } else {
      checks.push(makeCheck('a11y-61', 'Headings structure content', 'fail', 'major',
        `h1:${h1Count} h2:${h2Count} (${totalHeadings} total)`,
        'Page is missing h1 heading; every page should have at least one h1'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-61', 'Headings structure content', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 62: Lists use proper markup (ul/ol/dl)
  // ------------------------------------------------------------------
  try {
    const properLists = $('ul, ol, dl').length;

    // Look for fake lists: consecutive elements that look like list items but aren't in a list
    // Check for common patterns like "- item" or "* item" in sequential p or div elements
    let fakeLists = 0;
    $('p, div, span').each(function () {
      const text = ($(this).text() || '').trim();
      if (/^[\u2022\u2023\u25E6\u2043\u2219•\-\*]\s/.test(text)) {
        fakeLists++;
      }
    });

    if (fakeLists > 2) {
      checks.push(makeCheck('a11y-62', 'Lists use proper markup', 'warn', 'minor',
        `${properLists} proper list(s), ${fakeLists} potential fake list items`,
        `Found ${fakeLists} elements that look like list items but don't use ul/ol/dl markup`));
    } else if (properLists > 0) {
      checks.push(makeCheck('a11y-62', 'Lists use proper markup', 'pass', 'minor',
        `${properLists} proper list(s)`, 'Lists use proper HTML markup (ul, ol, dl)'));
    } else {
      checks.push(makeCheck('a11y-62', 'Lists use proper markup', 'pass', 'minor', 'No lists detected', 'No list content detected on page'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-62', 'Lists use proper markup', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 63: No flashing content (animation/blink/marquee)
  // ------------------------------------------------------------------
  try {
    const blinkElements = $('blink').length;
    const marqueeElements = $('marquee').length;
    let flashingCSS = false;

    $('style').each(function () {
      const css = $(this).html() || '';
      if (/animation[^}]*flash|@keyframes[^{]*flash/i.test(css)) {
        flashingCSS = true;
      }
    });

    $('[style*="animation"]').each(function () {
      const style = $(this).attr('style') || '';
      if (/flash|blink/i.test(style)) {
        flashingCSS = true;
      }
    });

    const issues = [];
    if (blinkElements > 0) issues.push(`${blinkElements} <blink> element(s)`);
    if (marqueeElements > 0) issues.push(`${marqueeElements} <marquee> element(s)`);
    if (flashingCSS) issues.push('flashing CSS animations detected');

    if (issues.length === 0) {
      checks.push(makeCheck('a11y-63', 'No flashing content', 'pass', 'minor', 'None found', 'No blink, marquee, or flashing animation content found'));
    } else {
      checks.push(makeCheck('a11y-63', 'No flashing content', 'fail', 'minor',
        issues.join(', '),
        `Flashing content detected: ${issues.join(', ')}. This can cause seizures.`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-63', 'No flashing content', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 64: Text resize check (no fixed font sizes without rem fallback)
  // ------------------------------------------------------------------
  try {
    let fixedFontSizes = 0;
    let totalFontDecls = 0;

    // Check inline styles for fixed px font-size
    $('[style]').each(function () {
      const style = $(this).attr('style') || '';
      const fontSizeMatch = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?px)/i);
      if (fontSizeMatch) {
        totalFontDecls++;
        fixedFontSizes++;
      }
      const remMatch = style.match(/font-size\s*:\s*\d+(?:\.\d+)?rem/i);
      if (remMatch) {
        totalFontDecls++;
      }
    });

    // Check style blocks
    $('style').each(function () {
      const css = $(this).html() || '';
      const pxMatches = css.match(/font-size\s*:\s*\d+(?:\.\d+)?px/gi);
      if (pxMatches) {
        fixedFontSizes += pxMatches.length;
        totalFontDecls += pxMatches.length;
      }
      const remMatches = css.match(/font-size\s*:\s*\d+(?:\.\d+)?(?:rem|em|%|vw)/gi);
      if (remMatches) {
        totalFontDecls += remMatches.length;
      }
    });

    if (fixedFontSizes === 0) {
      checks.push(makeCheck('a11y-64', 'Text resize support', 'pass', 'minor',
        'No fixed px font sizes', 'No fixed pixel font sizes found that would prevent text resizing'));
    } else if (fixedFontSizes <= 3) {
      checks.push(makeCheck('a11y-64', 'Text resize support', 'warn', 'minor',
        `${fixedFontSizes} fixed px font-size(s)`,
        `${fixedFontSizes} font-size declaration(s) use fixed px values; consider using rem or em for better resize support`));
    } else {
      checks.push(makeCheck('a11y-64', 'Text resize support', 'fail', 'minor',
        `${fixedFontSizes} fixed px font-size(s)`,
        `${fixedFontSizes} font-size declaration(s) use fixed px values, which may prevent text resizing`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-64', 'Text resize support', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 65: Focus trap in modals (dialog/modal patterns)
  // ------------------------------------------------------------------
  try {
    const dialogs = $('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    let hasFocusTrapHints = 0;

    dialogs.each(function () {
      const el = $(this);
      // A dialog element natively traps focus
      if (this.tagName === 'dialog' || this.name === 'dialog') {
        hasFocusTrapHints++;
        return;
      }
      // Check for aria-modal which indicates intent to trap focus
      if (el.attr('aria-modal') === 'true') {
        hasFocusTrapHints++;
        return;
      }
      // Check for tabindex on the dialog container (common focus management pattern)
      if (el.attr('tabindex') !== undefined) {
        hasFocusTrapHints++;
      }
    });

    if (dialogs.length === 0) {
      checks.push(makeCheck('a11y-65', 'Focus trap in modals', 'pass', 'minor', 'No modals', 'No modal dialogs detected on page'));
    } else if (hasFocusTrapHints === dialogs.length) {
      checks.push(makeCheck('a11y-65', 'Focus trap in modals', 'pass', 'minor',
        `${dialogs.length} modal(s) with focus management`,
        'All modal dialogs have focus management hints (dialog element, aria-modal, or tabindex)'));
    } else {
      checks.push(makeCheck('a11y-65', 'Focus trap in modals', 'warn', 'minor',
        `${hasFocusTrapHints}/${dialogs.length} with focus management`,
        `${dialogs.length - hasFocusTrapHints} modal dialog(s) may lack focus trapping; ensure keyboard focus stays within the modal`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-65', 'Focus trap in modals', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 66: Buttons have accessible names
  // ------------------------------------------------------------------
  try {
    const buttons = $('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]');
    let missingName = 0;

    buttons.each(function () {
      const el = $(this);
      const text = (el.text() || '').trim();
      const ariaLabel = el.attr('aria-label');
      const ariaLabelledby = el.attr('aria-labelledby');
      const title = el.attr('title');
      const value = el.attr('value');
      const alt = el.find('img').first().attr('alt');

      if (!text && !ariaLabel && !ariaLabelledby && !title && !value && !alt) {
        missingName++;
      }
    });

    const total = buttons.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-66', 'Buttons have accessible names', 'pass', 'major', 'No buttons', 'No button elements on page'));
    } else if (missingName === 0) {
      checks.push(makeCheck('a11y-66', 'Buttons have accessible names', 'pass', 'major',
        `${total} button(s) all named`, 'All buttons have accessible names'));
    } else {
      checks.push(makeCheck('a11y-66', 'Buttons have accessible names', 'fail', 'major',
        `${missingName}/${total} missing names`,
        `${missingName} button(s) lack accessible names (text content, aria-label, aria-labelledby, title, or value)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-66', 'Buttons have accessible names', 'warn', 'major', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 67: SVGs have title or aria-label
  // ------------------------------------------------------------------
  try {
    const svgs = $('svg');
    let missingLabel = 0;

    svgs.each(function () {
      const el = $(this);
      const ariaLabel = el.attr('aria-label');
      const ariaLabelledby = el.attr('aria-labelledby');
      const ariaHidden = el.attr('aria-hidden');
      const role = (el.attr('role') || '').toLowerCase();
      const hasTitle = el.find('title').length > 0;

      // Decorative SVGs (aria-hidden="true" or role="presentation"/"none") are fine without labels
      if (ariaHidden === 'true' || role === 'presentation' || role === 'none') {
        return;
      }

      if (!ariaLabel && !ariaLabelledby && !hasTitle) {
        missingLabel++;
      }
    });

    const total = svgs.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-67', 'SVGs have title or aria-label', 'pass', 'minor', 'No SVGs', 'No SVG elements on page'));
    } else if (missingLabel === 0) {
      checks.push(makeCheck('a11y-67', 'SVGs have title or aria-label', 'pass', 'minor',
        `${total} SVG(s) checked`, 'All non-decorative SVGs have accessible labels'));
    } else {
      checks.push(makeCheck('a11y-67', 'SVGs have title or aria-label', 'fail', 'minor',
        `${missingLabel}/${total} missing labels`,
        `${missingLabel} SVG(s) lack a <title>, aria-label, or aria-labelledby (and are not marked decorative)`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-67', 'SVGs have title or aria-label', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 68: Iframes have title attribute
  // ------------------------------------------------------------------
  try {
    const iframes = $('iframe');
    let missingTitle = 0;

    iframes.each(function () {
      const el = $(this);
      const title = (el.attr('title') || '').trim();
      const ariaLabel = el.attr('aria-label');
      const ariaHidden = el.attr('aria-hidden');

      // Hidden iframes don't need titles
      if (ariaHidden === 'true') return;

      if (!title && !ariaLabel) {
        missingTitle++;
      }
    });

    const total = iframes.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-68', 'Iframes have title attribute', 'pass', 'minor', 'No iframes', 'No iframe elements on page'));
    } else if (missingTitle === 0) {
      checks.push(makeCheck('a11y-68', 'Iframes have title attribute', 'pass', 'minor',
        `${total} iframe(s) all titled`, 'All visible iframes have title or aria-label attributes'));
    } else {
      checks.push(makeCheck('a11y-68', 'Iframes have title attribute', 'fail', 'minor',
        `${missingTitle}/${total} missing titles`,
        `${missingTitle} iframe(s) lack a title or aria-label attribute`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-68', 'Iframes have title attribute', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 69: Content readable without CSS (semantic HTML structure)
  // ------------------------------------------------------------------
  try {
    let semanticScore = 0;
    const maxScore = 7;

    // Check for key semantic elements
    if ($('header, [role="banner"]').length > 0) semanticScore++;
    if ($('nav, [role="navigation"]').length > 0) semanticScore++;
    if ($('main, [role="main"]').length > 0) semanticScore++;
    if ($('footer, [role="contentinfo"]').length > 0) semanticScore++;
    if ($('article, section').length > 0) semanticScore++;
    if ($('h1, h2, h3').length > 0) semanticScore++;
    if ($('p').length > 0) semanticScore++;

    if (semanticScore >= 5) {
      checks.push(makeCheck('a11y-69', 'Content readable without CSS', 'pass', 'minor',
        `${semanticScore}/${maxScore} semantic elements`,
        'Page uses good semantic HTML structure (header, nav, main, footer, headings, paragraphs)'));
    } else if (semanticScore >= 3) {
      checks.push(makeCheck('a11y-69', 'Content readable without CSS', 'warn', 'minor',
        `${semanticScore}/${maxScore} semantic elements`,
        'Page has some semantic structure but could be improved; use header, nav, main, footer, article, section'));
    } else {
      checks.push(makeCheck('a11y-69', 'Content readable without CSS', 'fail', 'minor',
        `${semanticScore}/${maxScore} semantic elements`,
        'Page lacks semantic HTML structure; content may not be understandable without CSS'));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-69', 'Content readable without CSS', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  // ------------------------------------------------------------------
  // Check 70: Touch target size >= 44x44px
  // ------------------------------------------------------------------
  try {
    const clickableSelectors = 'a, button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], select';
    const clickables = $(clickableSelectors);
    let smallTargets = 0;

    clickables.each(function () {
      const el = $(this);
      const style = el.attr('style') || '';

      // Parse inline width and height
      const widthMatch = style.match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/i);
      const heightMatch = style.match(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/i);
      const paddingMatch = style.match(/padding\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/i);

      // Check for explicit small sizes
      if (widthMatch && heightMatch) {
        let width = parseFloat(widthMatch[1]);
        let height = parseFloat(heightMatch[1]);

        // Convert rem to approximate px (assuming 16px base)
        if (widthMatch[2] === 'rem' || widthMatch[2] === 'em') width *= 16;
        if (heightMatch[2] === 'rem' || heightMatch[2] === 'em') height *= 16;

        if (width < 44 || height < 44) {
          smallTargets++;
          return;
        }
      }

      // Check for very small font-size with no padding (likely small target)
      const fontSizeMatch = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)(px)/i);
      if (fontSizeMatch && !paddingMatch) {
        const fontSize = parseFloat(fontSizeMatch[1]);
        if (fontSize < 10) {
          smallTargets++;
        }
      }
    });

    const total = clickables.length;
    if (total === 0) {
      checks.push(makeCheck('a11y-70', 'Touch target size >= 44x44px', 'pass', 'minor', 'No clickable elements', 'No clickable elements on page'));
    } else if (smallTargets === 0) {
      checks.push(makeCheck('a11y-70', 'Touch target size >= 44x44px', 'pass', 'minor',
        `${total} element(s) checked`, 'No obviously undersized touch targets detected in inline styles'));
    } else {
      checks.push(makeCheck('a11y-70', 'Touch target size >= 44x44px', 'warn', 'minor',
        `${smallTargets} potentially small target(s)`,
        `${smallTargets} clickable element(s) may have touch targets smaller than 44x44px based on inline styles`));
    }
  } catch (err) {
    checks.push(makeCheck('a11y-70', 'Touch target size >= 44x44px', 'warn', 'minor', null, `Error: ${err.message}`));
  }

  return { checks };
}

module.exports = { analyzeAccessibility };
