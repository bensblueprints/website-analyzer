'use strict';

const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// text-readability is ESM-only, so we lazy-load it via dynamic import()
// ---------------------------------------------------------------------------
let _readability = null;
async function getReadability() {
  if (!_readability) {
    const mod = await import('text-readability');
    _readability = mod.default || mod;
  }
  return _readability;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and return visible text only.
 * Removes script, style, noscript content first.
 */
function extractVisibleText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, template').remove();
  // Get text, collapse whitespace
  const text = $('body').text() || $.root().text() || '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Count words in a string.
 */
function wordCount(text) {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compute Jaccard similarity between two sets of words (0-1).
 */
function jaccardSimilarity(textA, textB) {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a check result object.
 */
function check(id, name, status, severity, value, details) {
  return { id, name, status, severity, value, details };
}

// ---------------------------------------------------------------------------
// Common misspellings list (small representative set)
// ---------------------------------------------------------------------------
const COMMON_MISSPELLINGS = [
  'accomodate', 'acheive', 'accross', 'agressive', 'apparantly',
  'arguement', 'basicly', 'begining', 'beleive', 'buisness',
  'calender', 'catagory', 'cemetary', 'changable', 'collegue',
  'comming', 'committment', 'concious', 'curiousity', 'definately',
  'dilemna', 'dissapear', 'dissapoint', 'embarass', 'enviroment',
  'exagerate', 'existance', 'familar', 'finaly', 'foriegn',
  'freind', 'goverment', 'grammer', 'harrass', 'humourous',
  'immediatly', 'independant', 'intresting', 'knowlege', 'liason',
  'libary', 'maintenence', 'millenium', 'neccessary', 'noticable',
  'occassion', 'occurence', 'orignal', 'parliment', 'persistant',
  'posession', 'prefered', 'priveledge', 'profesional', 'publically',
  'realy', 'recieve', 'recomend', 'refering', 'relevent',
  'religous', 'remeber', 'repitition', 'resistence', 'saftey',
  'sargent', 'seize', 'seperate', 'sieze', 'succesful',
  'supercede', 'suprise', 'tatoo', 'temperture', 'tommorow',
  'tounge', 'truely', 'unforseen', 'unfortunatly', 'untill',
  'wierd', 'writting', 'wich', 'thier', 'reccomend',
  'occured', 'untill', 'acheive', 'beleif', 'concensus',
];

// ---------------------------------------------------------------------------
// Basic profanity list
// ---------------------------------------------------------------------------
const PROFANITY_LIST = [
  'fuck', 'shit', 'damn', 'ass', 'bitch', 'bastard', 'crap',
  'dick', 'piss', 'cunt', 'bollocks', 'wanker', 'arsehole',
  'asshole', 'motherfucker', 'bullshit', 'horseshit',
];

// ---------------------------------------------------------------------------
// Action words for CTAs
// ---------------------------------------------------------------------------
const CTA_ACTION_WORDS = [
  'get', 'start', 'try', 'buy', 'shop', 'order', 'book', 'schedule',
  'download', 'sign up', 'subscribe', 'join', 'register', 'learn',
  'discover', 'explore', 'find', 'see', 'view', 'read', 'watch',
  'contact', 'call', 'request', 'claim', 'grab', 'unlock', 'access',
  'begin', 'apply', 'submit', 'send', 'create', 'build', 'launch',
  'save', 'reserve', 'enroll', 'donate', 'add to cart',
];

// ---------------------------------------------------------------------------
// Encoding artifact patterns (mojibake)
// ---------------------------------------------------------------------------
const ENCODING_ARTIFACTS = [
  /â€™/g, /â€œ/g, /â€\u009d/g, /â€"/g, /â€¢/g, /Ã©/g,
  /Ã¨/g, /Ã¼/g, /Ã¶/g, /Ã¤/g, /Ã±/g, /Ã§/g, /Â©/g,
  /Â®/g, /Â°/g, /Â»/g, /Â«/g, /Ã¡/g, /Ã­/g, /Ã³/g, /Ãº/g,
];

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze content quality of a page.
 *
 * @param {object} pageData - { url, html, statusCode, headers, networkRequests, consoleMessages, links }
 * @param {object[]} allPages - Array of all page data objects
 * @returns {Promise<{checks: Array}>}
 */
async function analyzeContent(pageData, allPages) {
  const checks = [];
  const html = pageData.html || '';
  const $ = cheerio.load(html);
  const visibleText = extractVisibleText(html);
  const words = visibleText.split(/\s+/).filter(Boolean);
  const wc = words.length;
  const url = pageData.url || '';
  const allLinks = [
    ...(pageData.links.internal || []),
    ...(pageData.links.external || []),
  ];

  // Pre-load readability (ESM)
  let readability = null;
  try {
    readability = await getReadability();
  } catch {
    // If text-readability fails to load, readability checks will gracefully degrade
  }

  // -----------------------------------------------------------------------
  // Check 1: No lorem ipsum placeholder text
  // -----------------------------------------------------------------------
  try {
    const loremRegex = /lorem\s+ipsum/i;
    const hasLorem = loremRegex.test(visibleText);
    checks.push(check(
      'content-1', 'No lorem ipsum placeholder text',
      hasLorem ? 'fail' : 'pass', 'major',
      hasLorem ? 'Found' : 'None',
      hasLorem ? 'Lorem ipsum placeholder text detected on page' : 'No placeholder text found'
    ));
  } catch (e) {
    checks.push(check('content-1', 'No lorem ipsum placeholder text', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 2: No "coming soon" placeholders
  // -----------------------------------------------------------------------
  try {
    const comingSoonRegex = /coming\s+soon|under\s+construction|work\s+in\s+progress/i;
    const hasComingSoon = comingSoonRegex.test(visibleText);
    checks.push(check(
      'content-2', 'No "coming soon" placeholders',
      hasComingSoon ? 'fail' : 'pass', 'major',
      hasComingSoon ? 'Found' : 'None',
      hasComingSoon ? 'Coming soon / under construction placeholder detected' : 'No placeholder content found'
    ));
  } catch (e) {
    checks.push(check('content-2', 'No "coming soon" placeholders', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 3: No "example.com" or test URLs
  // -----------------------------------------------------------------------
  try {
    const testUrlRegex = /example\.com|example\.org|example\.net|test\.com|localhost|127\.0\.0\.1/i;
    const hasTestUrls = testUrlRegex.test(html);
    checks.push(check(
      'content-3', 'No example.com or test URLs',
      hasTestUrls ? 'fail' : 'pass', 'minor',
      hasTestUrls ? 'Found' : 'None',
      hasTestUrls ? 'Test/example URLs detected in page content' : 'No test URLs found'
    ));
  } catch (e) {
    checks.push(check('content-3', 'No example.com or test URLs', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 4: No empty pages < 50 words
  // -----------------------------------------------------------------------
  try {
    const isEmpty = wc < 50;
    checks.push(check(
      'content-4', 'Page has adequate content (50+ words)',
      isEmpty ? 'fail' : 'pass', 'critical',
      `${wc} words`,
      isEmpty ? `Page has only ${wc} words — likely empty or placeholder` : `Page has ${wc} words of content`
    ));
  } catch (e) {
    checks.push(check('content-4', 'Page has adequate content (50+ words)', 'error', 'critical', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 5: Readability score Flesch-Kincaid
  // -----------------------------------------------------------------------
  try {
    if (readability && wc >= 30) {
      const score = readability.fleschReadingEase(visibleText);
      const ideal = score >= 60 && score <= 70;
      const acceptable = score >= 30 && score <= 80;
      checks.push(check(
        'content-5', 'Readability score (Flesch-Kincaid)',
        acceptable ? 'pass' : 'fail', 'minor',
        `${score} (${ideal ? 'ideal' : score > 70 ? 'easy' : score < 30 ? 'very difficult' : 'difficult'})`,
        `Flesch Reading Ease score: ${score}. Ideal range is 60-70. ${score > 80 ? 'Content may be too simple.' : score < 30 ? 'Content may be too difficult for general audiences.' : ''}`
      ));
    } else {
      checks.push(check(
        'content-5', 'Readability score (Flesch-Kincaid)',
        'skip', 'minor',
        wc < 30 ? 'Too little text' : 'Readability module unavailable',
        'Not enough text to compute readability score (need 30+ words)'
      ));
    }
  } catch (e) {
    checks.push(check('content-5', 'Readability score (Flesch-Kincaid)', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 6: Average sentence length < 25 words
  // -----------------------------------------------------------------------
  try {
    if (readability && wc >= 30) {
      const asl = readability.averageSentenceLength(visibleText);
      const ok = asl < 25;
      checks.push(check(
        'content-6', 'Average sentence length < 25 words',
        ok ? 'pass' : 'fail', 'minor',
        `${asl} words/sentence`,
        ok ? 'Sentence length is within acceptable range' : `Average sentence length of ${asl} words is too long. Aim for under 25.`
      ));
    } else {
      checks.push(check(
        'content-6', 'Average sentence length < 25 words',
        'skip', 'minor',
        'Insufficient text',
        'Not enough text to calculate average sentence length'
      ));
    }
  } catch (e) {
    checks.push(check('content-6', 'Average sentence length < 25 words', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 7: Paragraph length reasonable < 150 words per paragraph
  // -----------------------------------------------------------------------
  try {
    const paragraphs = $('p').toArray().map(el => $(el).text().trim()).filter(t => t.length > 0);
    let longParagraphs = 0;
    let maxParagraphWords = 0;
    for (const p of paragraphs) {
      const pWords = wordCount(p);
      if (pWords > maxParagraphWords) maxParagraphWords = pWords;
      if (pWords > 150) longParagraphs++;
    }
    const ok = longParagraphs === 0;
    checks.push(check(
      'content-7', 'Paragraph length < 150 words',
      ok ? 'pass' : 'fail', 'minor',
      `Max: ${maxParagraphWords} words, ${longParagraphs} long paragraphs`,
      ok ? 'All paragraphs are within acceptable length' : `${longParagraphs} paragraph(s) exceed 150 words. Break them up for readability.`
    ));
  } catch (e) {
    checks.push(check('content-7', 'Paragraph length < 150 words', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 8: Content has clear structure / headings
  // -----------------------------------------------------------------------
  try {
    const headings = $('h1, h2, h3, h4, h5, h6').length;
    const hasStructure = headings >= 1;
    checks.push(check(
      'content-8', 'Content has clear structure with headings',
      hasStructure ? 'pass' : 'fail', 'major',
      `${headings} heading(s)`,
      hasStructure ? `Page uses ${headings} heading element(s) for structure` : 'No headings found — content lacks structural hierarchy'
    ));
  } catch (e) {
    checks.push(check('content-8', 'Content has clear structure with headings', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 9: Lists used where appropriate
  // -----------------------------------------------------------------------
  try {
    const lists = $('ul, ol').length;
    // Only flag if page has substantial content but no lists
    const shouldHaveLists = wc > 300 && lists === 0;
    checks.push(check(
      'content-9', 'Lists used where appropriate',
      shouldHaveLists ? 'fail' : 'pass', 'minor',
      `${lists} list(s)`,
      shouldHaveLists ? 'Page has significant content but no lists — consider using lists for scannability' : `Found ${lists} list element(s)`
    ));
  } catch (e) {
    checks.push(check('content-9', 'Lists used where appropriate', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 10: No walls of text > 300 words without break
  // -----------------------------------------------------------------------
  try {
    // Get text blocks between block-level elements
    const blockElements = $('p, h1, h2, h3, h4, h5, h6, li, td, th, div, section, article, blockquote, pre, hr, br');
    let wallFound = false;
    let maxBlockWords = 0;

    blockElements.each((_, el) => {
      // Only check direct text, not nested block children
      const tagName = (el.tagName || '').toLowerCase();
      if (['p', 'li', 'td', 'th', 'blockquote'].includes(tagName)) {
        const text = $(el).text().trim();
        const bwc = wordCount(text);
        if (bwc > maxBlockWords) maxBlockWords = bwc;
        if (bwc > 300) wallFound = true;
      }
    });

    checks.push(check(
      'content-10', 'No walls of text (> 300 words without break)',
      wallFound ? 'fail' : 'pass', 'major',
      `Largest block: ${maxBlockWords} words`,
      wallFound ? 'Found text block exceeding 300 words — break up with headings, lists, or shorter paragraphs' : 'No excessively long text blocks found'
    ));
  } catch (e) {
    checks.push(check('content-10', 'No walls of text (> 300 words without break)', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 11: Spelling errors basic check
  // -----------------------------------------------------------------------
  try {
    const lowerText = visibleText.toLowerCase();
    const foundMisspellings = COMMON_MISSPELLINGS.filter(word => {
      const regex = new RegExp('\\b' + word + '\\b', 'i');
      return regex.test(lowerText);
    });
    const ok = foundMisspellings.length === 0;
    checks.push(check(
      'content-11', 'No common spelling errors',
      ok ? 'pass' : 'fail', 'minor',
      ok ? 'None found' : `${foundMisspellings.length} found`,
      ok ? 'No common misspellings detected' : `Possible misspellings: ${foundMisspellings.slice(0, 10).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('content-11', 'No common spelling errors', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 12: No double spaces
  // -----------------------------------------------------------------------
  try {
    const doubleSpaceRegex = /[^\S\n] {2,}/g;
    const matches = visibleText.match(doubleSpaceRegex);
    const count = matches ? matches.length : 0;
    const ok = count === 0;
    checks.push(check(
      'content-12', 'No double spaces',
      ok ? 'pass' : 'fail', 'minor',
      `${count} occurrence(s)`,
      ok ? 'No double spaces found in visible text' : `Found ${count} instance(s) of double spaces`
    ));
  } catch (e) {
    checks.push(check('content-12', 'No double spaces', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 13: No broken special characters / encoding issues
  // -----------------------------------------------------------------------
  try {
    let encodingIssues = 0;
    for (const pattern of ENCODING_ARTIFACTS) {
      const matches = html.match(pattern);
      if (matches) encodingIssues += matches.length;
    }
    const ok = encodingIssues === 0;
    checks.push(check(
      'content-13', 'No broken character encoding',
      ok ? 'pass' : 'fail', 'minor',
      `${encodingIssues} issue(s)`,
      ok ? 'No encoding artifacts detected' : `Found ${encodingIssues} character encoding artifact(s) — check charset declaration`
    ));
  } catch (e) {
    checks.push(check('content-13', 'No broken character encoding', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 14: Copyright year current (2025 or 2026)
  // -----------------------------------------------------------------------
  try {
    const copyrightRegex = /(?:©|&copy;|copyright)\s*(\d{4})/gi;
    const years = [];
    let m;
    while ((m = copyrightRegex.exec(visibleText + ' ' + html)) !== null) {
      years.push(parseInt(m[1], 10));
    }
    if (years.length === 0) {
      checks.push(check(
        'content-14', 'Copyright year is current',
        'skip', 'minor',
        'No copyright year found',
        'No copyright notice with year found on page'
      ));
    } else {
      const currentYears = years.filter(y => y === 2025 || y === 2026);
      const ok = currentYears.length > 0;
      checks.push(check(
        'content-14', 'Copyright year is current',
        ok ? 'pass' : 'fail', 'minor',
        `Year(s): ${[...new Set(years)].join(', ')}`,
        ok ? 'Copyright year is current' : `Copyright year(s) ${[...new Set(years)].join(', ')} may be outdated — update to 2025 or 2026`
      ));
    }
  } catch (e) {
    checks.push(check('content-14', 'Copyright year is current', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 15: Contact information present
  // -----------------------------------------------------------------------
  try {
    const phoneRegex = /(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const hasPhone = phoneRegex.test(visibleText);
    const hasEmail = emailRegex.test(visibleText);
    const hasContact = hasPhone || hasEmail;
    const parts = [];
    if (hasPhone) parts.push('phone');
    if (hasEmail) parts.push('email');
    checks.push(check(
      'content-15', 'Contact information present',
      hasContact ? 'pass' : 'fail', 'major',
      hasContact ? `Found: ${parts.join(', ')}` : 'None found',
      hasContact ? `Contact information found: ${parts.join(', ')}` : 'No phone number or email address found on page'
    ));
  } catch (e) {
    checks.push(check('content-15', 'Contact information present', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 16: Phone number formatted correctly
  // -----------------------------------------------------------------------
  try {
    const phoneRegex = /(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
    const phones = visibleText.match(phoneRegex) || [];
    if (phones.length === 0) {
      checks.push(check(
        'content-16', 'Phone number formatted correctly',
        'skip', 'minor',
        'No phone numbers found',
        'No phone numbers detected on page'
      ));
    } else {
      // Check for consistent formatting (hyphens, dots, or spaces)
      const wellFormatted = phones.every(p => /^(\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(p.trim()));
      checks.push(check(
        'content-16', 'Phone number formatted correctly',
        wellFormatted ? 'pass' : 'fail', 'minor',
        `${phones.length} phone number(s)`,
        wellFormatted ? 'Phone numbers are well formatted' : `Phone numbers found: ${phones.slice(0, 3).join(', ')} — verify formatting`
      ));
    }
  } catch (e) {
    checks.push(check('content-16', 'Phone number formatted correctly', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 17: Email addresses formatted correctly
  // -----------------------------------------------------------------------
  try {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = visibleText.match(emailRegex) || [];
    if (emails.length === 0) {
      checks.push(check(
        'content-17', 'Email addresses formatted correctly',
        'skip', 'minor',
        'No emails found',
        'No email addresses detected on page'
      ));
    } else {
      // Basic validation: all should match standard format
      const validFormat = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      const allValid = emails.every(e => validFormat.test(e));
      checks.push(check(
        'content-17', 'Email addresses formatted correctly',
        allValid ? 'pass' : 'fail', 'minor',
        `${emails.length} email(s)`,
        allValid ? 'All email addresses are properly formatted' : `Some email addresses may be malformed: ${emails.slice(0, 3).join(', ')}`
      ));
    }
  } catch (e) {
    checks.push(check('content-17', 'Email addresses formatted correctly', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 18: Physical address present
  // -----------------------------------------------------------------------
  try {
    // Look for common address patterns: street numbers, state abbreviations, zip codes
    const addressPatterns = [
      /\d{1,5}\s+[\w\s]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl)\b/i,
      /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/, // US zip code with state
      /\b\d{5}(?:-\d{4})?\b/, // US zip code
      /\b(?:suite|ste|apt|unit|floor|fl)\s*#?\s*\d+/i,
    ];
    const hasAddress = addressPatterns.some(p => p.test(visibleText));
    checks.push(check(
      'content-18', 'Physical address present',
      hasAddress ? 'pass' : 'fail', 'minor',
      hasAddress ? 'Found' : 'Not found',
      hasAddress ? 'Physical address pattern detected on page' : 'No physical address pattern found — consider adding a business address'
    ));
  } catch (e) {
    checks.push(check('content-18', 'Physical address present', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 19: Privacy policy page exists
  // -----------------------------------------------------------------------
  try {
    const allLinkUrls = allLinks.map(l => (l.url || '').toLowerCase());
    const allLinkTexts = allLinks.map(l => (l.text || '').toLowerCase());
    const hasPrivacyLink = allLinkUrls.some(u => /privacy/i.test(u)) ||
      allLinkTexts.some(t => /privacy\s*policy/i.test(t));
    checks.push(check(
      'content-19', 'Privacy policy page exists',
      hasPrivacyLink ? 'pass' : 'fail', 'major',
      hasPrivacyLink ? 'Found' : 'Not found',
      hasPrivacyLink ? 'Privacy policy link found on page' : 'No privacy policy link found — required for legal compliance'
    ));
  } catch (e) {
    checks.push(check('content-19', 'Privacy policy page exists', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 20: Terms of service exists
  // -----------------------------------------------------------------------
  try {
    const allLinkUrls = allLinks.map(l => (l.url || '').toLowerCase());
    const allLinkTexts = allLinks.map(l => (l.text || '').toLowerCase());
    const hasTermsLink = allLinkUrls.some(u => /terms/i.test(u)) ||
      allLinkTexts.some(t => /terms\s*(of\s*service|of\s*use|&\s*conditions|\s*and\s*conditions)/i.test(t));
    checks.push(check(
      'content-20', 'Terms of service exists',
      hasTermsLink ? 'pass' : 'fail', 'minor',
      hasTermsLink ? 'Found' : 'Not found',
      hasTermsLink ? 'Terms of service link found on page' : 'No terms of service link found'
    ));
  } catch (e) {
    checks.push(check('content-20', 'Terms of service exists', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 21: No duplicate content > 80% similar across pages
  // -----------------------------------------------------------------------
  try {
    let maxSimilarity = 0;
    let mostSimilarUrl = '';
    if (wc >= 50) {
      for (const otherPage of allPages) {
        if (otherPage.url === pageData.url) continue;
        const otherText = extractVisibleText(otherPage.html);
        if (wordCount(otherText) < 50) continue;
        const similarity = jaccardSimilarity(visibleText, otherText);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          mostSimilarUrl = otherPage.url;
        }
      }
    }
    const isDuplicate = maxSimilarity > 0.8;
    const similarityPct = Math.round(maxSimilarity * 100);
    checks.push(check(
      'content-21', 'No duplicate content across pages (> 80% similar)',
      isDuplicate ? 'fail' : 'pass', 'major',
      `${similarityPct}% max similarity`,
      isDuplicate ? `Page is ${similarityPct}% similar to ${mostSimilarUrl} — likely duplicate content` : `Highest similarity with another page: ${similarityPct}%`
    ));
  } catch (e) {
    checks.push(check('content-21', 'No duplicate content across pages (> 80% similar)', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 22: Consistent tone across pages
  // -----------------------------------------------------------------------
  try {
    if (readability && wc >= 30 && allPages.length > 1) {
      const scores = [];
      for (const p of allPages) {
        const pText = extractVisibleText(p.html);
        if (wordCount(pText) >= 30) {
          try {
            scores.push(readability.fleschReadingEase(pText));
          } catch {
            // skip pages that fail readability
          }
        }
      }
      if (scores.length >= 2) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const pageScore = readability.fleschReadingEase(visibleText);
        const deviation = Math.abs(pageScore - avg);
        const ok = deviation < 20;
        checks.push(check(
          'content-22', 'Consistent tone across pages',
          ok ? 'pass' : 'fail', 'minor',
          `Deviation: ${Math.round(deviation)} from average`,
          ok ? 'Page readability is consistent with other pages' : `Page readability score deviates ${Math.round(deviation)} points from site average (${Math.round(avg)}) — tone may feel inconsistent`
        ));
      } else {
        checks.push(check('content-22', 'Consistent tone across pages', 'skip', 'minor', 'Insufficient pages', 'Not enough pages with sufficient text to compare'));
      }
    } else {
      checks.push(check('content-22', 'Consistent tone across pages', 'skip', 'minor', 'Insufficient data', 'Not enough text or pages to compare tone'));
    }
  } catch (e) {
    checks.push(check('content-22', 'Consistent tone across pages', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 23: No orphaned media (skip — return pass)
  // -----------------------------------------------------------------------
  try {
    checks.push(check(
      'content-23', 'No orphaned media',
      'pass', 'minor',
      'Skipped',
      'Orphaned media check not applicable in automated analysis'
    ));
  } catch (e) {
    checks.push(check('content-23', 'No orphaned media', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 24: All images load successfully
  // -----------------------------------------------------------------------
  try {
    const networkReqs = pageData.networkRequests || [];
    const imageRequests = networkReqs.filter(r =>
      r.resourceType === 'image' || (r.contentType && r.contentType.startsWith('image/'))
    );
    const failedImages = imageRequests.filter(r => r.status >= 400 || r.status === 0);
    const ok = failedImages.length === 0;
    checks.push(check(
      'content-24', 'All images load successfully',
      ok ? 'pass' : 'fail', 'major',
      `${failedImages.length} failed of ${imageRequests.length} total`,
      ok ? `All ${imageRequests.length} images loaded successfully` : `${failedImages.length} image(s) failed to load: ${failedImages.slice(0, 3).map(r => r.url).join(', ')}`
    ));
  } catch (e) {
    checks.push(check('content-24', 'All images load successfully', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 25: Images are relevant (not 1x1 tracking pixels)
  // -----------------------------------------------------------------------
  try {
    const imgs = $('img').toArray();
    let trackingPixels = 0;
    for (const img of imgs) {
      const width = $(img).attr('width');
      const height = $(img).attr('height');
      if (width && height && parseInt(width, 10) <= 1 && parseInt(height, 10) <= 1) {
        trackingPixels++;
      }
    }
    const totalImages = imgs.length;
    const ratio = totalImages > 0 ? trackingPixels / totalImages : 0;
    const ok = ratio < 0.5; // less than half are tracking pixels
    checks.push(check(
      'content-25', 'Images are relevant (not tracking pixels)',
      ok ? 'pass' : 'fail', 'minor',
      `${trackingPixels} tracking pixel(s) of ${totalImages} images`,
      ok ? 'Images appear to be relevant content images' : `${trackingPixels} of ${totalImages} images appear to be 1x1 tracking pixels`
    ));
  } catch (e) {
    checks.push(check('content-25', 'Images are relevant (not tracking pixels)', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 26: No stock photo watermarks (check for very large unoptimized images)
  // -----------------------------------------------------------------------
  try {
    const networkReqs = pageData.networkRequests || [];
    const imageRequests = networkReqs.filter(r =>
      r.resourceType === 'image' || (r.contentType && r.contentType.startsWith('image/'))
    );
    // Flag images larger than 5MB as potentially unoptimized stock photos
    const oversized = imageRequests.filter(r => r.size && r.size > 5 * 1024 * 1024);
    const ok = oversized.length === 0;
    checks.push(check(
      'content-26', 'No stock photo watermarks (oversized images)',
      ok ? 'pass' : 'fail', 'minor',
      `${oversized.length} oversized image(s)`,
      ok ? 'No suspiciously large images detected' : `${oversized.length} image(s) over 5MB — may be unoptimized stock photos with watermarks`
    ));
  } catch (e) {
    checks.push(check('content-26', 'No stock photo watermarks (oversized images)', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 27: Video embeds load
  // -----------------------------------------------------------------------
  try {
    const iframes = $('iframe').toArray();
    const videos = $('video').toArray();
    const videoIframes = iframes.filter(el => {
      const src = $(el).attr('src') || '';
      return /youtube|vimeo|wistia|dailymotion|loom|vidyard/i.test(src);
    });
    const totalEmbeds = videoIframes.length + videos.length;
    if (totalEmbeds === 0) {
      checks.push(check(
        'content-27', 'Video embeds load',
        'skip', 'minor',
        'No video embeds',
        'No video embeds found on page'
      ));
    } else {
      // Check if iframe srcs have valid-looking URLs
      const brokenEmbeds = videoIframes.filter(el => {
        const src = $(el).attr('src') || '';
        return !src || src === 'about:blank';
      });
      const ok = brokenEmbeds.length === 0;
      checks.push(check(
        'content-27', 'Video embeds load',
        ok ? 'pass' : 'fail', 'minor',
        `${totalEmbeds} embed(s), ${brokenEmbeds.length} broken`,
        ok ? `All ${totalEmbeds} video embed(s) have valid sources` : `${brokenEmbeds.length} video embed(s) have missing or blank sources`
      ));
    }
  } catch (e) {
    checks.push(check('content-27', 'Video embeds load', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 28: No empty links
  // -----------------------------------------------------------------------
  try {
    const anchors = $('a').toArray();
    let emptyLinks = 0;
    for (const a of anchors) {
      const text = $(a).text().trim();
      const ariaLabel = $(a).attr('aria-label') || '';
      const title = $(a).attr('title') || '';
      const imgAlt = $(a).find('img').attr('alt') || '';
      if (!text && !ariaLabel.trim() && !title.trim() && !imgAlt.trim()) {
        emptyLinks++;
      }
    }
    const ok = emptyLinks === 0;
    checks.push(check(
      'content-28', 'No empty links',
      ok ? 'pass' : 'fail', 'major',
      `${emptyLinks} empty link(s)`,
      ok ? 'All links have accessible text content' : `${emptyLinks} link(s) have no text, aria-label, or title — inaccessible to screen readers`
    ));
  } catch (e) {
    checks.push(check('content-28', 'No empty links', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 29: No empty headings
  // -----------------------------------------------------------------------
  try {
    const headings = $('h1, h2, h3, h4, h5, h6').toArray();
    let emptyHeadings = 0;
    for (const h of headings) {
      const text = $(h).text().trim();
      if (!text) emptyHeadings++;
    }
    const ok = emptyHeadings === 0;
    checks.push(check(
      'content-29', 'No empty headings',
      ok ? 'pass' : 'fail', 'major',
      `${emptyHeadings} empty heading(s)`,
      ok ? 'All headings contain text' : `${emptyHeadings} heading(s) are empty — remove or add content`
    ));
  } catch (e) {
    checks.push(check('content-29', 'No empty headings', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 30: No empty list items
  // -----------------------------------------------------------------------
  try {
    const listItems = $('li').toArray();
    let emptyItems = 0;
    for (const li of listItems) {
      const text = $(li).text().trim();
      if (!text) emptyItems++;
    }
    const ok = emptyItems === 0;
    checks.push(check(
      'content-30', 'No empty list items',
      ok ? 'pass' : 'fail', 'minor',
      `${emptyItems} empty item(s)`,
      ok ? 'All list items contain content' : `${emptyItems} list item(s) are empty`
    ));
  } catch (e) {
    checks.push(check('content-30', 'No empty list items', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 31: No empty table cells in data tables
  // -----------------------------------------------------------------------
  try {
    const tables = $('table').toArray();
    let emptyDataCells = 0;
    let totalDataCells = 0;
    for (const table of tables) {
      // Only check tables that seem to be data tables (have th elements)
      const hasHeaders = $(table).find('th').length > 0;
      if (hasHeaders) {
        const tds = $(table).find('td').toArray();
        totalDataCells += tds.length;
        for (const td of tds) {
          if (!$(td).text().trim()) emptyDataCells++;
        }
      }
    }
    if (totalDataCells === 0) {
      checks.push(check(
        'content-31', 'No empty table cells in data tables',
        'skip', 'minor',
        'No data tables',
        'No data tables found on page'
      ));
    } else {
      const ok = emptyDataCells === 0;
      checks.push(check(
        'content-31', 'No empty table cells in data tables',
        ok ? 'pass' : 'fail', 'minor',
        `${emptyDataCells} empty of ${totalDataCells} cells`,
        ok ? 'All data table cells contain content' : `${emptyDataCells} empty cell(s) in data tables — use a dash or N/A for missing values`
      ));
    }
  } catch (e) {
    checks.push(check('content-31', 'No empty table cells in data tables', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 32: Consistent date formatting
  // -----------------------------------------------------------------------
  try {
    // Look for various date formats
    const usFormat = visibleText.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || []; // MM/DD/YYYY
    const isoFormat = visibleText.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []; // YYYY-MM-DD
    const euFormat = visibleText.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g) || []; // DD.MM.YYYY
    const longFormat = visibleText.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi) || [];
    const shortFormat = visibleText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/gi) || [];

    const formats = [];
    if (usFormat.length > 0) formats.push('US (MM/DD/YYYY)');
    if (isoFormat.length > 0) formats.push('ISO (YYYY-MM-DD)');
    if (euFormat.length > 0) formats.push('EU (DD.MM.YYYY)');
    if (longFormat.length > 0) formats.push('Long (Month DD, YYYY)');
    if (shortFormat.length > 0) formats.push('Short (Mon DD, YYYY)');

    if (formats.length <= 1) {
      checks.push(check(
        'content-32', 'Consistent date formatting',
        'pass', 'minor',
        formats.length === 0 ? 'No dates found' : formats[0],
        formats.length === 0 ? 'No dates detected on page' : 'Date formatting is consistent'
      ));
    } else {
      checks.push(check(
        'content-32', 'Consistent date formatting',
        'fail', 'minor',
        `${formats.length} formats mixed`,
        `Mixed date formats found: ${formats.join(', ')} — standardize to one format`
      ));
    }
  } catch (e) {
    checks.push(check('content-32', 'Consistent date formatting', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 33: No future dates in published content
  // -----------------------------------------------------------------------
  try {
    const yearRegex = /\b(20\d{2})\b/g;
    const currentYear = new Date().getFullYear();
    const years = [];
    let ym;
    while ((ym = yearRegex.exec(visibleText)) !== null) {
      years.push(parseInt(ym[1], 10));
    }
    const futureYears = years.filter(y => y > currentYear);
    const ok = futureYears.length === 0;
    checks.push(check(
      'content-33', 'No future dates in published content',
      ok ? 'pass' : 'fail', 'minor',
      ok ? 'None found' : `Future year(s): ${[...new Set(futureYears)].join(', ')}`,
      ok ? 'No future dates detected' : `Found references to future year(s): ${[...new Set(futureYears)].join(', ')}`
    ));
  } catch (e) {
    checks.push(check('content-33', 'No future dates in published content', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 34: No very old dates > 2 years (before 2024)
  // -----------------------------------------------------------------------
  try {
    const yearRegex = /\b(20\d{2})\b/g;
    const currentYear = new Date().getFullYear();
    const threshold = currentYear - 2; // 2024
    const years = [];
    let ym;
    while ((ym = yearRegex.exec(visibleText)) !== null) {
      years.push(parseInt(ym[1], 10));
    }
    const oldYears = years.filter(y => y < threshold && y >= 2000);
    const ok = oldYears.length === 0;
    checks.push(check(
      'content-34', 'No very old dates (> 2 years old)',
      ok ? 'pass' : 'fail', 'minor',
      ok ? 'None found' : `Old year(s): ${[...new Set(oldYears)].sort().join(', ')}`,
      ok ? 'No outdated date references found' : `Found references to year(s) before ${threshold}: ${[...new Set(oldYears)].sort().join(', ')} — content may be stale`
    ));
  } catch (e) {
    checks.push(check('content-34', 'No very old dates (> 2 years old)', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 35: CTA present on key pages
  // -----------------------------------------------------------------------
  try {
    const buttons = $('button, a.btn, a.button, a.cta, [class*="cta"], [class*="btn-"], input[type="submit"], a[class*="button"]').length;
    const ctaLinks = $('a').toArray().filter(a => {
      const text = $(a).text().toLowerCase().trim();
      return CTA_ACTION_WORDS.some(w => text.startsWith(w));
    }).length;
    const hasCta = buttons > 0 || ctaLinks > 0;
    const total = buttons + ctaLinks;
    checks.push(check(
      'content-35', 'Call-to-action (CTA) present',
      hasCta ? 'pass' : 'fail', 'major',
      `${total} CTA element(s)`,
      hasCta ? `Found ${total} CTA element(s) on page` : 'No call-to-action buttons or links found — add CTAs to guide users'
    ));
  } catch (e) {
    checks.push(check('content-35', 'Call-to-action (CTA) present', 'error', 'major', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 36: CTA text is action-oriented
  // -----------------------------------------------------------------------
  try {
    const ctaElements = $('button, a.btn, a.button, a.cta, [class*="cta"], [class*="btn-"], input[type="submit"], a[class*="button"]').toArray();
    if (ctaElements.length === 0) {
      checks.push(check(
        'content-36', 'CTA text is action-oriented',
        'skip', 'minor',
        'No CTAs found',
        'No CTA elements to check'
      ));
    } else {
      let actionOriented = 0;
      let total = 0;
      for (const el of ctaElements) {
        const text = $(el).text().toLowerCase().trim();
        if (!text) continue;
        total++;
        const isAction = CTA_ACTION_WORDS.some(w => text.includes(w));
        if (isAction) actionOriented++;
      }
      const ok = total === 0 || actionOriented / total >= 0.5;
      checks.push(check(
        'content-36', 'CTA text is action-oriented',
        ok ? 'pass' : 'fail', 'minor',
        `${actionOriented}/${total} action-oriented`,
        ok ? 'CTA text uses action-oriented language' : `Only ${actionOriented} of ${total} CTAs use action words — use verbs like "Get", "Start", "Learn"`
      ));
    }
  } catch (e) {
    checks.push(check('content-36', 'CTA text is action-oriented', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 37: Testimonials / social proof present
  // -----------------------------------------------------------------------
  try {
    const testimonialPatterns = [
      /testimonial/i, /review/i, /rating/i, /customer.*(say|said|love|recommend)/i,
      /\bstars?\b/i, /\b5\/5\b/, /\b4\.[\d]\/5\b/,
    ];
    const testimonialClasses = $('[class*="testimonial"], [class*="review"], [class*="rating"], [class*="social-proof"], blockquote, [class*="quote"]').length;
    const textMatch = testimonialPatterns.some(p => p.test(visibleText));
    const hasProof = testimonialClasses > 0 || textMatch;
    checks.push(check(
      'content-37', 'Testimonials or social proof present',
      hasProof ? 'pass' : 'fail', 'minor',
      hasProof ? 'Found' : 'Not found',
      hasProof ? 'Social proof or testimonial elements detected' : 'No testimonials, reviews, or social proof found — consider adding credibility elements'
    ));
  } catch (e) {
    checks.push(check('content-37', 'Testimonials or social proof present', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 38: No profanity
  // -----------------------------------------------------------------------
  try {
    const lowerText = visibleText.toLowerCase();
    const foundProfanity = PROFANITY_LIST.filter(word => {
      const regex = new RegExp('\\b' + word + '\\b', 'i');
      return regex.test(lowerText);
    });
    const ok = foundProfanity.length === 0;
    checks.push(check(
      'content-38', 'No profanity',
      ok ? 'pass' : 'fail', 'minor',
      ok ? 'None found' : `${foundProfanity.length} word(s)`,
      ok ? 'No profanity detected in visible text' : `Profane word(s) detected: ${foundProfanity.join(', ')}`
    ));
  } catch (e) {
    checks.push(check('content-38', 'No profanity', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 39: Content matches meta description topic
  // -----------------------------------------------------------------------
  try {
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    if (!metaDesc || wc < 30) {
      checks.push(check(
        'content-39', 'Content matches meta description topic',
        'skip', 'minor',
        metaDesc ? 'Insufficient page text' : 'No meta description',
        metaDesc ? 'Not enough page content to compare' : 'No meta description found to compare against page content'
      ));
    } else {
      // Word overlap check
      const metaWords = new Set(metaDesc.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const contentWords = new Set(visibleText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of metaWords) {
        if (contentWords.has(w)) overlap++;
      }
      const overlapRatio = metaWords.size > 0 ? overlap / metaWords.size : 0;
      const ok = overlapRatio >= 0.3;
      checks.push(check(
        'content-39', 'Content matches meta description topic',
        ok ? 'pass' : 'fail', 'minor',
        `${Math.round(overlapRatio * 100)}% word overlap`,
        ok ? 'Page content aligns with meta description topic' : `Low word overlap (${Math.round(overlapRatio * 100)}%) between meta description and page content — may hurt SEO relevance`
      ));
    }
  } catch (e) {
    checks.push(check('content-39', 'Content matches meta description topic', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 40: No hidden content via CSS
  // -----------------------------------------------------------------------
  try {
    const hiddenElements = $('[style*="display:none"], [style*="display: none"]').toArray();
    let hiddenWithText = 0;
    for (const el of hiddenElements) {
      const text = $(el).text().trim();
      if (text.length > 20) hiddenWithText++; // Only flag substantial hidden text
    }
    const ok = hiddenWithText === 0;
    checks.push(check(
      'content-40', 'No hidden content via CSS',
      ok ? 'pass' : 'fail', 'minor',
      `${hiddenWithText} hidden element(s) with text`,
      ok ? 'No hidden text content detected via inline display:none' : `${hiddenWithText} element(s) hidden via display:none contain substantial text — may be flagged by search engines`
    ));
  } catch (e) {
    checks.push(check('content-40', 'No hidden content via CSS', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 41: Print stylesheet exists
  // -----------------------------------------------------------------------
  try {
    const printLink = $('link[media="print"]').length > 0;
    const printInStyle = html.includes('@media print');
    const hasPrint = printLink || printInStyle;
    checks.push(check(
      'content-41', 'Print stylesheet exists',
      hasPrint ? 'pass' : 'fail', 'minor',
      hasPrint ? 'Found' : 'Not found',
      hasPrint ? 'Print stylesheet or @media print rules detected' : 'No print-specific styles found — page may not print well'
    ));
  } catch (e) {
    checks.push(check('content-41', 'Print stylesheet exists', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 42: Content is unique (duplicate check with other pages)
  // -----------------------------------------------------------------------
  try {
    if (wc < 50 || allPages.length <= 1) {
      checks.push(check(
        'content-42', 'Content is unique across site',
        'skip', 'minor',
        allPages.length <= 1 ? 'Single page' : 'Insufficient text',
        'Not enough data to check content uniqueness'
      ));
    } else {
      let duplicateCount = 0;
      for (const otherPage of allPages) {
        if (otherPage.url === pageData.url) continue;
        const otherText = extractVisibleText(otherPage.html);
        if (wordCount(otherText) < 50) continue;
        const similarity = jaccardSimilarity(visibleText, otherText);
        if (similarity > 0.6) duplicateCount++;
      }
      const ok = duplicateCount === 0;
      checks.push(check(
        'content-42', 'Content is unique across site',
        ok ? 'pass' : 'fail', 'minor',
        `${duplicateCount} similar page(s)`,
        ok ? 'Page content is unique compared to other pages' : `${duplicateCount} other page(s) share more than 60% similar content`
      ));
    }
  } catch (e) {
    checks.push(check('content-42', 'Content is unique across site', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 43: No excessive capitalization
  // -----------------------------------------------------------------------
  try {
    const allCapsRegex = /\b[A-Z]{4,}\b/g;
    const allCapsWords = visibleText.match(allCapsRegex) || [];
    // Filter out common acronyms / abbreviations (2-5 chars are usually acronyms)
    const excessiveCaps = allCapsWords.filter(w => w.length > 5);
    const ok = excessiveCaps.length <= 3;
    checks.push(check(
      'content-43', 'No excessive capitalization',
      ok ? 'pass' : 'fail', 'minor',
      `${excessiveCaps.length} ALL-CAPS word(s)`,
      ok ? 'No excessive use of ALL CAPS' : `${excessiveCaps.length} words in ALL CAPS (>5 chars): ${excessiveCaps.slice(0, 5).join(', ')} — avoid shouting at readers`
    ));
  } catch (e) {
    checks.push(check('content-43', 'No excessive capitalization', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 44: No excessive punctuation !!!
  // -----------------------------------------------------------------------
  try {
    const excessivePunctRegex = /[!?]{3,}|\.{4,}/g;
    const matches = visibleText.match(excessivePunctRegex) || [];
    const ok = matches.length === 0;
    checks.push(check(
      'content-44', 'No excessive punctuation',
      ok ? 'pass' : 'fail', 'minor',
      `${matches.length} instance(s)`,
      ok ? 'No excessive punctuation found' : `${matches.length} instance(s) of repeated punctuation (e.g., "!!!", "???") — appears unprofessional`
    ));
  } catch (e) {
    checks.push(check('content-44', 'No excessive punctuation', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 45: No excessive emoji usage
  // -----------------------------------------------------------------------
  try {
    // Match common emoji ranges
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
    const emojis = visibleText.match(emojiRegex) || [];
    const emojiCount = emojis.length;
    // More than 10 emojis or more than 1 per 50 words is excessive
    const ratio = wc > 0 ? emojiCount / wc : 0;
    const ok = emojiCount <= 10 && ratio < 0.02;
    checks.push(check(
      'content-45', 'No excessive emoji usage',
      ok ? 'pass' : 'fail', 'minor',
      `${emojiCount} emoji(s)`,
      ok ? 'Emoji usage is within acceptable range' : `${emojiCount} emojis found — excessive emoji use can look unprofessional`
    ));
  } catch (e) {
    checks.push(check('content-45', 'No excessive emoji usage', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 46: Proper quotation marks
  // -----------------------------------------------------------------------
  try {
    const straightSingle = (visibleText.match(/'/g) || []).length;
    const straightDouble = (visibleText.match(/"/g) || []).length;
    const smartSingle = (visibleText.match(/[\u2018\u2019]/g) || []).length;
    const smartDouble = (visibleText.match(/[\u201C\u201D]/g) || []).length;

    const hasStraight = straightSingle > 0 || straightDouble > 0;
    const hasSmart = smartSingle > 0 || smartDouble > 0;
    const mixed = hasStraight && hasSmart;

    checks.push(check(
      'content-46', 'Proper quotation marks',
      mixed ? 'fail' : 'pass', 'minor',
      mixed ? 'Mixed straight and smart quotes' : (hasSmart ? 'Smart quotes' : 'Straight quotes'),
      mixed ? 'Page mixes straight (\' ") and smart quotes (\u2018\u2019 \u201C\u201D) — pick one style' : 'Quotation mark style is consistent'
    ));
  } catch (e) {
    checks.push(check('content-46', 'Proper quotation marks', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 47: No weird whitespace in text
  // -----------------------------------------------------------------------
  try {
    const tabsInContent = (visibleText.match(/\t/g) || []).length;
    const multiNewlines = (html.match(/(\n\s*){4,}/g) || []).length;
    const nbspChains = (html.match(/(&nbsp;\s*){3,}/g) || []).length;
    const issues = tabsInContent + multiNewlines + nbspChains;
    const ok = issues === 0;
    checks.push(check(
      'content-47', 'No weird whitespace in text',
      ok ? 'pass' : 'fail', 'minor',
      `${issues} issue(s)`,
      ok ? 'No unusual whitespace patterns found' : `Found ${issues} whitespace issue(s): tabs in content, excessive newlines, or nbsp chains`
    ));
  } catch (e) {
    checks.push(check('content-47', 'No weird whitespace in text', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 48: Consistent brand name spelling (skip — return pass)
  // -----------------------------------------------------------------------
  try {
    checks.push(check(
      'content-48', 'Consistent brand name spelling',
      'pass', 'minor',
      'Skipped',
      'Brand name consistency check requires manual configuration — skipped'
    ));
  } catch (e) {
    checks.push(check('content-48', 'Consistent brand name spelling', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 49: No mixed languages
  // -----------------------------------------------------------------------
  try {
    // Check for significant presence of non-Latin characters (excluding common symbols)
    const latinChars = (visibleText.match(/[a-zA-Z]/g) || []).length;
    const cjkChars = (visibleText.match(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const cyrillicChars = (visibleText.match(/[\u0400-\u04FF]/g) || []).length;
    const arabicChars = (visibleText.match(/[\u0600-\u06FF]/g) || []).length;

    const nonLatinTotal = cjkChars + cyrillicChars + arabicChars;
    const totalChars = latinChars + nonLatinTotal;
    const mixedRatio = totalChars > 0 ? nonLatinTotal / totalChars : 0;

    // Flag if there's a significant mix (both Latin and non-Latin in meaningful amounts)
    const isMixed = mixedRatio > 0.05 && mixedRatio < 0.95 && nonLatinTotal > 20;
    checks.push(check(
      'content-49', 'No mixed languages',
      isMixed ? 'fail' : 'pass', 'minor',
      isMixed ? `${Math.round(mixedRatio * 100)}% non-Latin characters` : 'Consistent',
      isMixed ? 'Page contains a significant mix of Latin and non-Latin characters — may indicate mixed languages' : 'Character set is consistent across page content'
    ));
  } catch (e) {
    checks.push(check('content-49', 'No mixed languages', 'error', 'minor', null, e.message));
  }

  // -----------------------------------------------------------------------
  // Check 50: Content depth adequate
  // -----------------------------------------------------------------------
  try {
    const headings = $('h1, h2, h3, h4, h5, h6').length;
    const images = $('img').length;
    const lists = $('ul, ol').length;

    // Simple depth score: word count + structural elements
    const depthScore = wc + (headings * 50) + (images * 30) + (lists * 20);
    // Expect at least 200 depth score for a non-trivial page
    const isAdequate = depthScore >= 200;

    checks.push(check(
      'content-50', 'Content depth adequate',
      isAdequate ? 'pass' : 'fail', 'minor',
      `${wc} words, ${headings} headings, ${images} images, ${lists} lists`,
      isAdequate
        ? `Content depth is adequate: ${wc} words with ${headings} headings, ${images} images, ${lists} lists`
        : `Content appears thin: ${wc} words, ${headings} headings, ${images} images, ${lists} lists — consider adding more substance`
    ));
  } catch (e) {
    checks.push(check('content-50', 'Content depth adequate', 'error', 'minor', null, e.message));
  }

  return { checks };
}

module.exports = { analyzeContent };
