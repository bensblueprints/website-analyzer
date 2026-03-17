const cheerio = require('cheerio');
const tls = require('tls');
const https = require('https');
const dns = require('dns').promises;
const { URL } = require('url');

/**
 * Security Analyzer - 50 checks covering HTTPS, headers, cookies,
 * content security, information leakage, and DNS configuration.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Connect via TLS and return socket metadata + certificate info.
 * Cached per domain so checks 2-4 share one connection.
 */
const _tlsCache = new Map();

function getTlsInfo(domain) {
  if (_tlsCache.has(domain)) return _tlsCache.get(domain);

  const promise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { socket.destroy(); } catch (_) { /* noop */ }
      resolve(null);
    }, 8000);

    let socket;
    try {
      socket = tls.connect(443, domain, { servername: domain, rejectUnauthorized: false }, () => {
        clearTimeout(timeout);
        try {
          const cert = socket.getPeerCertificate();
          const protocol = socket.getProtocol();
          const authorized = socket.authorized;
          socket.end();
          resolve({ cert, protocol, authorized });
        } catch (_) {
          socket.end();
          resolve(null);
        }
      });
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    } catch (_) {
      clearTimeout(timeout);
      resolve(null);
    }
  });

  _tlsCache.set(domain, promise);
  return promise;
}

function header(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function check(id, name, severity, status, value, details) {
  return { id, name, status, severity, value, details };
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

async function analyzeSecurity(pageData, siteData) {
  const { url, html, statusCode, headers, networkRequests, consoleMessages, links } = pageData;
  const { domain } = siteData;

  const $ = html ? cheerio.load(html) : null;
  const hdrs = headers || {};
  const nets = networkRequests || [];
  const allLinks = links || [];
  const isHttps = url && url.startsWith('https://');

  const checks = [];

  // --- 1: HTTPS enforced ---------------------------------------------------
  try {
    const pass = !!isHttps;
    checks.push(check('sec-1', 'HTTPS enforced', 'critical',
      pass ? 'pass' : 'fail',
      url,
      pass ? 'Site is served over HTTPS' : 'Site is not served over HTTPS'));
  } catch (e) {
    checks.push(check('sec-1', 'HTTPS enforced', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- TLS info (shared for checks 2-4) ------------------------------------
  let tlsInfo = null;
  try {
    tlsInfo = await getTlsInfo(domain);
  } catch (_) { /* handled per-check */ }

  // --- 2: SSL certificate valid ---------------------------------------------
  try {
    if (!tlsInfo) {
      checks.push(check('sec-2', 'SSL certificate valid', 'critical', 'warn', null, 'Could not establish TLS connection'));
    } else {
      const pass = !!tlsInfo.authorized;
      checks.push(check('sec-2', 'SSL certificate valid', 'critical',
        pass ? 'pass' : 'fail',
        pass ? 'Valid' : 'Invalid',
        pass ? 'SSL certificate is trusted' : 'SSL certificate is not trusted by default CAs'));
    }
  } catch (e) {
    checks.push(check('sec-2', 'SSL certificate valid', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 3: SSL cert not expiring within 30 days ------------------------------
  try {
    if (!tlsInfo || !tlsInfo.cert || !tlsInfo.cert.valid_to) {
      checks.push(check('sec-3', 'SSL cert not expiring soon', 'major', 'warn', null, 'Could not read certificate expiry'));
    } else {
      const expiry = new Date(tlsInfo.cert.valid_to);
      const now = new Date();
      const daysLeft = Math.floor((expiry - now) / 86400000);
      const pass = daysLeft > 30;
      checks.push(check('sec-3', 'SSL cert not expiring soon', 'major',
        pass ? 'pass' : 'warn',
        `${daysLeft} days remaining`,
        pass ? `Certificate expires on ${expiry.toISOString()}` : `Certificate expires in ${daysLeft} days on ${expiry.toISOString()}`));
    }
  } catch (e) {
    checks.push(check('sec-3', 'SSL cert not expiring soon', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 4: TLS 1.2+ required ------------------------------------------------
  try {
    if (!tlsInfo || !tlsInfo.protocol) {
      checks.push(check('sec-4', 'TLS 1.2+ required', 'major', 'warn', null, 'Could not determine TLS protocol'));
    } else {
      const proto = tlsInfo.protocol;
      const good = ['TLSv1.2', 'TLSv1.3'].includes(proto);
      checks.push(check('sec-4', 'TLS 1.2+ required', 'major',
        good ? 'pass' : 'fail',
        proto,
        good ? `Using ${proto}` : `Using outdated protocol ${proto}`));
    }
  } catch (e) {
    checks.push(check('sec-4', 'TLS 1.2+ required', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 5: HSTS header present -----------------------------------------------
  try {
    const hsts = header(hdrs, 'strict-transport-security');
    const pass = !!hsts;
    checks.push(check('sec-5', 'HSTS header present', 'critical',
      pass ? 'pass' : 'fail',
      hsts || 'Not set',
      pass ? 'Strict-Transport-Security header is set' : 'Missing Strict-Transport-Security header'));
  } catch (e) {
    checks.push(check('sec-5', 'HSTS header present', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 6: HSTS max-age >= 31536000 -----------------------------------------
  try {
    const hsts = header(hdrs, 'strict-transport-security') || '';
    const match = hsts.match(/max-age=(\d+)/i);
    if (!match) {
      checks.push(check('sec-6', 'HSTS max-age >= 1 year', 'major', 'fail', 'Not set', 'HSTS max-age directive not found'));
    } else {
      const maxAge = parseInt(match[1], 10);
      const pass = maxAge >= 31536000;
      checks.push(check('sec-6', 'HSTS max-age >= 1 year', 'major',
        pass ? 'pass' : 'warn',
        `${maxAge} seconds`,
        pass ? 'HSTS max-age is at least 1 year' : `HSTS max-age is ${maxAge}s, recommended >= 31536000s`));
    }
  } catch (e) {
    checks.push(check('sec-6', 'HSTS max-age >= 1 year', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 7: HSTS includeSubDomains -------------------------------------------
  try {
    const hsts = header(hdrs, 'strict-transport-security') || '';
    const pass = /includeSubDomains/i.test(hsts);
    checks.push(check('sec-7', 'HSTS includeSubDomains', 'minor',
      pass ? 'pass' : 'warn',
      pass ? 'Present' : 'Not set',
      pass ? 'HSTS includes subdomains' : 'HSTS does not include subdomains directive'));
  } catch (e) {
    checks.push(check('sec-7', 'HSTS includeSubDomains', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 8: Content-Security-Policy header present ----------------------------
  try {
    const csp = header(hdrs, 'content-security-policy');
    const pass = !!csp;
    checks.push(check('sec-8', 'Content-Security-Policy present', 'major',
      pass ? 'pass' : 'fail',
      pass ? 'Set' : 'Not set',
      pass ? 'CSP header is configured' : 'Missing Content-Security-Policy header'));
  } catch (e) {
    checks.push(check('sec-8', 'Content-Security-Policy present', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 9: CSP blocks unsafe-inline ------------------------------------------
  try {
    const csp = header(hdrs, 'content-security-policy') || '';
    if (!csp) {
      checks.push(check('sec-9', 'CSP blocks unsafe-inline', 'minor', 'fail', 'No CSP', 'Cannot check – CSP header missing'));
    } else {
      const hasUnsafe = csp.includes("'unsafe-inline'");
      checks.push(check('sec-9', 'CSP blocks unsafe-inline', 'minor',
        hasUnsafe ? 'fail' : 'pass',
        hasUnsafe ? 'unsafe-inline allowed' : 'Blocked',
        hasUnsafe ? "CSP allows 'unsafe-inline'" : "CSP does not allow 'unsafe-inline'"));
    }
  } catch (e) {
    checks.push(check('sec-9', 'CSP blocks unsafe-inline', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 10: CSP blocks unsafe-eval -------------------------------------------
  try {
    const csp = header(hdrs, 'content-security-policy') || '';
    if (!csp) {
      checks.push(check('sec-10', 'CSP blocks unsafe-eval', 'minor', 'fail', 'No CSP', 'Cannot check – CSP header missing'));
    } else {
      const hasUnsafe = csp.includes("'unsafe-eval'");
      checks.push(check('sec-10', 'CSP blocks unsafe-eval', 'minor',
        hasUnsafe ? 'fail' : 'pass',
        hasUnsafe ? 'unsafe-eval allowed' : 'Blocked',
        hasUnsafe ? "CSP allows 'unsafe-eval'" : "CSP does not allow 'unsafe-eval'"));
    }
  } catch (e) {
    checks.push(check('sec-10', 'CSP blocks unsafe-eval', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 11: X-Content-Type-Options: nosniff ----------------------------------
  try {
    const val = header(hdrs, 'x-content-type-options');
    const pass = val && val.toLowerCase().includes('nosniff');
    checks.push(check('sec-11', 'X-Content-Type-Options nosniff', 'major',
      pass ? 'pass' : 'fail',
      val || 'Not set',
      pass ? 'X-Content-Type-Options is nosniff' : 'Missing or incorrect X-Content-Type-Options'));
  } catch (e) {
    checks.push(check('sec-11', 'X-Content-Type-Options nosniff', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 12: X-Frame-Options set ----------------------------------------------
  try {
    const val = header(hdrs, 'x-frame-options');
    const pass = !!val;
    checks.push(check('sec-12', 'X-Frame-Options set', 'major',
      pass ? 'pass' : 'fail',
      val || 'Not set',
      pass ? `X-Frame-Options is ${val}` : 'Missing X-Frame-Options header'));
  } catch (e) {
    checks.push(check('sec-12', 'X-Frame-Options set', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 13: X-XSS-Protection set (deprecated) --------------------------------
  try {
    const val = header(hdrs, 'x-xss-protection');
    const pass = !!val;
    checks.push(check('sec-13', 'X-XSS-Protection set', 'minor',
      pass ? 'pass' : 'warn',
      val || 'Not set',
      pass ? `X-XSS-Protection is ${val} (note: deprecated in modern browsers)` : 'X-XSS-Protection not set (deprecated but still checked)'));
  } catch (e) {
    checks.push(check('sec-13', 'X-XSS-Protection set', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 14: Referrer-Policy set ----------------------------------------------
  try {
    const val = header(hdrs, 'referrer-policy');
    const pass = !!val;
    checks.push(check('sec-14', 'Referrer-Policy set', 'minor',
      pass ? 'pass' : 'warn',
      val || 'Not set',
      pass ? `Referrer-Policy is ${val}` : 'Missing Referrer-Policy header'));
  } catch (e) {
    checks.push(check('sec-14', 'Referrer-Policy set', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 15: Permissions-Policy set -------------------------------------------
  try {
    const val = header(hdrs, 'permissions-policy');
    const pass = !!val;
    checks.push(check('sec-15', 'Permissions-Policy set', 'minor',
      pass ? 'pass' : 'warn',
      val || 'Not set',
      pass ? 'Permissions-Policy header is configured' : 'Missing Permissions-Policy header'));
  } catch (e) {
    checks.push(check('sec-15', 'Permissions-Policy set', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 16: No server version in Server header --------------------------------
  try {
    const val = header(hdrs, 'server') || '';
    const hasVersion = /\d+\.\d+/.test(val);
    checks.push(check('sec-16', 'No server version disclosed', 'minor',
      hasVersion ? 'fail' : 'pass',
      val || 'Not set',
      hasVersion ? `Server header exposes version info: ${val}` : 'Server header does not expose version numbers'));
  } catch (e) {
    checks.push(check('sec-16', 'No server version disclosed', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 17: No X-Powered-By header -------------------------------------------
  try {
    const val = header(hdrs, 'x-powered-by');
    const pass = !val;
    checks.push(check('sec-17', 'No X-Powered-By header', 'minor',
      pass ? 'pass' : 'fail',
      val || 'Not present',
      pass ? 'X-Powered-By header is not exposed' : `X-Powered-By exposes: ${val}`));
  } catch (e) {
    checks.push(check('sec-17', 'No X-Powered-By header', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 18: No stack traces in error pages -----------------------------------
  try {
    const htmlStr = html || '';
    const stackPatterns = [
      /at\s+\S+\s+\([\w\/\\.:]+:\d+:\d+\)/,        // Node.js style
      /Traceback \(most recent call last\)/i,          // Python
      /Exception in thread/i,                          // Java
      /Fatal error:.*on line \d+/i,                    // PHP
      /Stack trace:/i,
      /\.java:\d+\)/,
      /\.py", line \d+/,
    ];
    const found = stackPatterns.some((p) => p.test(htmlStr));
    checks.push(check('sec-18', 'No stack traces in page', 'major',
      found ? 'fail' : 'pass',
      found ? 'Stack trace pattern detected' : 'None found',
      found ? 'Stack trace patterns found in page source' : 'No stack traces detected in page source'));
  } catch (e) {
    checks.push(check('sec-18', 'No stack traces in page', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- Cookie parsing helper ------------------------------------------------
  const setCookieHeaders = (() => {
    const raw = header(hdrs, 'set-cookie');
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  })();

  // --- 19: Cookies have Secure flag -----------------------------------------
  try {
    if (setCookieHeaders.length === 0) {
      checks.push(check('sec-19', 'Cookies have Secure flag', 'major', 'pass', 'No cookies', 'No Set-Cookie headers found'));
    } else {
      const insecure = setCookieHeaders.filter((c) => !/;\s*Secure/i.test(c));
      const pass = insecure.length === 0;
      checks.push(check('sec-19', 'Cookies have Secure flag', 'major',
        pass ? 'pass' : 'fail',
        `${setCookieHeaders.length - insecure.length}/${setCookieHeaders.length} secure`,
        pass ? 'All cookies have the Secure flag' : `${insecure.length} cookie(s) missing Secure flag`));
    }
  } catch (e) {
    checks.push(check('sec-19', 'Cookies have Secure flag', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 20: Cookies have HttpOnly flag ---------------------------------------
  try {
    if (setCookieHeaders.length === 0) {
      checks.push(check('sec-20', 'Cookies have HttpOnly flag', 'major', 'pass', 'No cookies', 'No Set-Cookie headers found'));
    } else {
      const missing = setCookieHeaders.filter((c) => !/;\s*HttpOnly/i.test(c));
      const pass = missing.length === 0;
      checks.push(check('sec-20', 'Cookies have HttpOnly flag', 'major',
        pass ? 'pass' : 'fail',
        `${setCookieHeaders.length - missing.length}/${setCookieHeaders.length} HttpOnly`,
        pass ? 'All cookies have the HttpOnly flag' : `${missing.length} cookie(s) missing HttpOnly flag`));
    }
  } catch (e) {
    checks.push(check('sec-20', 'Cookies have HttpOnly flag', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 21: Cookies have SameSite attribute ----------------------------------
  try {
    if (setCookieHeaders.length === 0) {
      checks.push(check('sec-21', 'Cookies have SameSite', 'minor', 'pass', 'No cookies', 'No Set-Cookie headers found'));
    } else {
      const missing = setCookieHeaders.filter((c) => !/;\s*SameSite/i.test(c));
      const pass = missing.length === 0;
      checks.push(check('sec-21', 'Cookies have SameSite', 'minor',
        pass ? 'pass' : 'warn',
        `${setCookieHeaders.length - missing.length}/${setCookieHeaders.length} SameSite`,
        pass ? 'All cookies have SameSite attribute' : `${missing.length} cookie(s) missing SameSite attribute`));
    }
  } catch (e) {
    checks.push(check('sec-21', 'Cookies have SameSite', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 22: No mixed content -------------------------------------------------
  try {
    if (!isHttps) {
      checks.push(check('sec-22', 'No mixed content', 'critical', 'warn', 'N/A', 'Site not on HTTPS – mixed content check not applicable'));
    } else {
      const mixedRequests = nets.filter((r) => {
        const reqUrl = (typeof r === 'string') ? r : (r.url || '');
        return reqUrl.startsWith('http://');
      });
      const pass = mixedRequests.length === 0;
      checks.push(check('sec-22', 'No mixed content', 'critical',
        pass ? 'pass' : 'fail',
        `${mixedRequests.length} mixed request(s)`,
        pass ? 'No HTTP resources loaded on HTTPS page' : `${mixedRequests.length} HTTP resource(s) loaded on HTTPS page`));
    }
  } catch (e) {
    checks.push(check('sec-22', 'No mixed content', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 23: SRI on CDN scripts -----------------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-23', 'SRI on CDN scripts', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const extScripts = [];
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.startsWith('http://') || src.startsWith('https://')) {
          try {
            const srcHost = new URL(src).hostname;
            if (srcHost !== domain) {
              extScripts.push({ src, hasIntegrity: !!$(el).attr('integrity') });
            }
          } catch (_) { /* malformed URL */ }
        }
      });
      if (extScripts.length === 0) {
        checks.push(check('sec-23', 'SRI on CDN scripts', 'minor', 'pass', 'No external scripts', 'No external CDN scripts found'));
      } else {
        const missing = extScripts.filter((s) => !s.hasIntegrity);
        const pass = missing.length === 0;
        checks.push(check('sec-23', 'SRI on CDN scripts', 'minor',
          pass ? 'pass' : 'warn',
          `${extScripts.length - missing.length}/${extScripts.length} with SRI`,
          pass ? 'All external scripts have integrity attributes' : `${missing.length} external script(s) missing integrity attribute`));
      }
    }
  } catch (e) {
    checks.push(check('sec-23', 'SRI on CDN scripts', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 24: SRI on CDN stylesheets -------------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-24', 'SRI on CDN stylesheets', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const extStyles = [];
      $('link[rel="stylesheet"][href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('http://') || href.startsWith('https://')) {
          try {
            const hrefHost = new URL(href).hostname;
            if (hrefHost !== domain) {
              extStyles.push({ href, hasIntegrity: !!$(el).attr('integrity') });
            }
          } catch (_) { /* malformed URL */ }
        }
      });
      if (extStyles.length === 0) {
        checks.push(check('sec-24', 'SRI on CDN stylesheets', 'minor', 'pass', 'No external stylesheets', 'No external CDN stylesheets found'));
      } else {
        const missing = extStyles.filter((s) => !s.hasIntegrity);
        const pass = missing.length === 0;
        checks.push(check('sec-24', 'SRI on CDN stylesheets', 'minor',
          pass ? 'pass' : 'warn',
          `${extStyles.length - missing.length}/${extStyles.length} with SRI`,
          pass ? 'All external stylesheets have integrity attributes' : `${missing.length} external stylesheet(s) missing integrity attribute`));
      }
    }
  } catch (e) {
    checks.push(check('sec-24', 'SRI on CDN stylesheets', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 25: No open redirect patterns in URLs --------------------------------
  try {
    const htmlStr = html || '';
    const redirectPatterns = [
      /[?&](redirect|next|url|return|returnTo|goto|continue|dest|destination|redir|redirect_uri|redirect_url)=http/gi,
    ];
    const found = redirectPatterns.some((p) => p.test(htmlStr));
    checks.push(check('sec-25', 'No open redirect patterns', 'minor',
      found ? 'warn' : 'pass',
      found ? 'Redirect parameter pattern detected' : 'None found',
      found ? 'Potential open redirect patterns found in page source' : 'No open redirect patterns detected'));
  } catch (e) {
    checks.push(check('sec-25', 'No open redirect patterns', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 26: No inline event handlers ----------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-26', 'No inline event handlers', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const inlineEvents = [];
      const eventAttrs = ['onclick', 'onload', 'onerror', 'onmouseover', 'onmouseout', 'onfocus',
        'onblur', 'onsubmit', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onkeypress',
        'ondblclick', 'oncontextmenu', 'onresize', 'onscroll', 'onmouseenter', 'onmouseleave'];
      $('*').each((_, el) => {
        const attribs = el.attribs || {};
        for (const attr of Object.keys(attribs)) {
          if (eventAttrs.includes(attr.toLowerCase())) {
            inlineEvents.push(attr);
            if (inlineEvents.length >= 50) return false; // limit scanning
          }
        }
      });
      const pass = inlineEvents.length === 0;
      checks.push(check('sec-26', 'No inline event handlers', 'minor',
        pass ? 'pass' : 'warn',
        `${inlineEvents.length} found`,
        pass ? 'No inline event handlers found' : `${inlineEvents.length} inline event handler(s) detected (e.g. ${inlineEvents.slice(0, 3).join(', ')})`));
    }
  } catch (e) {
    checks.push(check('sec-26', 'No inline event handlers', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 27: No javascript: URLs ----------------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-27', 'No javascript: URLs', 'major', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      let count = 0;
      $('[href]').each((_, el) => {
        const href = ($(el).attr('href') || '').trim();
        if (/^javascript:/i.test(href) && href.toLowerCase() !== 'javascript:void(0)' && href.toLowerCase() !== 'javascript:void(0);' && href.toLowerCase() !== 'javascript:;') {
          count++;
        }
      });
      const pass = count === 0;
      checks.push(check('sec-27', 'No javascript: URLs', 'major',
        pass ? 'pass' : 'fail',
        `${count} found`,
        pass ? 'No javascript: URLs found in href attributes' : `${count} javascript: URL(s) found in href attributes`));
    }
  } catch (e) {
    checks.push(check('sec-27', 'No javascript: URLs', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 28: External scripts from HTTPS --------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-28', 'External scripts from HTTPS', 'major', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const httpScripts = [];
      $('script[src]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.startsWith('http://')) {
          httpScripts.push(src);
        }
      });
      const pass = httpScripts.length === 0;
      checks.push(check('sec-28', 'External scripts from HTTPS', 'major',
        pass ? 'pass' : 'fail',
        `${httpScripts.length} HTTP script(s)`,
        pass ? 'All external scripts use HTTPS' : `${httpScripts.length} script(s) loaded over HTTP`));
    }
  } catch (e) {
    checks.push(check('sec-28', 'External scripts from HTTPS', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 29: No .env file accessible ------------------------------------------
  try {
    const envLinks = allLinks.filter((l) => {
      const linkStr = (typeof l === 'string') ? l : (l.href || l.url || '');
      return /\/\.env(\b|$)/i.test(linkStr);
    });
    const htmlStr = html || '';
    const envInSource = /["']([^"']*\/\.env)["']/i.test(htmlStr);
    const found = envLinks.length > 0 || envInSource;
    checks.push(check('sec-29', 'No .env file accessible', 'critical',
      found ? 'fail' : 'pass',
      found ? '.env reference found' : 'Not exposed',
      found ? 'Reference to .env file found in page or links' : 'No .env file references found'));
  } catch (e) {
    checks.push(check('sec-29', 'No .env file accessible', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 30: No .git accessible -----------------------------------------------
  try {
    const gitLinks = allLinks.filter((l) => {
      const linkStr = (typeof l === 'string') ? l : (l.href || l.url || '');
      return /\/\.git(\/|$)/i.test(linkStr);
    });
    const htmlStr = html || '';
    const gitInSource = /["']([^"']*\/\.git(\/|["']))/i.test(htmlStr);
    const found = gitLinks.length > 0 || gitInSource;
    checks.push(check('sec-30', 'No .git directory accessible', 'critical',
      found ? 'fail' : 'pass',
      found ? '.git reference found' : 'Not exposed',
      found ? 'Reference to .git directory found in page or links' : 'No .git directory references found'));
  } catch (e) {
    checks.push(check('sec-30', 'No .git directory accessible', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 31: No backup files .bak .old ----------------------------------------
  try {
    const htmlStr = html || '';
    const backupPattern = /["']([\w\/.-]+\.(bak|old|backup|orig|copy|save|swp|tmp|~))["']/gi;
    const matches = htmlStr.match(backupPattern) || [];
    const pass = matches.length === 0;
    checks.push(check('sec-31', 'No backup files referenced', 'minor',
      pass ? 'pass' : 'warn',
      `${matches.length} reference(s)`,
      pass ? 'No backup file references found in source' : `${matches.length} backup file reference(s) found in source`));
  } catch (e) {
    checks.push(check('sec-31', 'No backup files referenced', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 32: No directory listing ---------------------------------------------
  try {
    const htmlStr = html || '';
    const hasListing = /Index of\s+\//i.test(htmlStr) || /<title>\s*Directory listing/i.test(htmlStr);
    checks.push(check('sec-32', 'No directory listing', 'minor',
      hasListing ? 'fail' : 'pass',
      hasListing ? 'Directory listing detected' : 'Not detected',
      hasListing ? 'Page appears to be a directory listing' : 'No directory listing patterns detected'));
  } catch (e) {
    checks.push(check('sec-32', 'No directory listing', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 33: No exposed admin/login pages -------------------------------------
  try {
    const adminPatterns = /\/(admin|wp-admin|wp-login|login|administrator|dashboard|phpmyadmin|cpanel|webmail)/i;
    const exposedLinks = allLinks.filter((l) => {
      const linkStr = (typeof l === 'string') ? l : (l.href || l.url || '');
      return adminPatterns.test(linkStr);
    });
    const pass = exposedLinks.length === 0;
    checks.push(check('sec-33', 'No exposed admin/login pages', 'minor',
      pass ? 'pass' : 'warn',
      `${exposedLinks.length} found`,
      pass ? 'No admin or login page links found' : `${exposedLinks.length} admin/login link(s) found in page`));
  } catch (e) {
    checks.push(check('sec-33', 'No exposed admin/login pages', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 34: No API keys in source --------------------------------------------
  try {
    const htmlStr = html || '';
    const keyPatterns = [
      /sk_live_[a-zA-Z0-9]{20,}/,
      /sk_test_[a-zA-Z0-9]{20,}/,
      /pk_live_[a-zA-Z0-9]{20,}/,
      /pk_test_[a-zA-Z0-9]{20,}/,
      /api[_-]?key\s*[:=]\s*["'][a-zA-Z0-9]{16,}["']/i,
      /apiKey\s*[:=]\s*["'][a-zA-Z0-9]{16,}["']/i,
      /AKIA[A-Z0-9]{16}/,                                // AWS
      /AIza[a-zA-Z0-9_-]{35}/,                           // Google
      /ghp_[a-zA-Z0-9]{36}/,                             // GitHub PAT
      /sk-[a-zA-Z0-9]{32,}/,                             // OpenAI
    ];
    const found = keyPatterns.some((p) => p.test(htmlStr));
    checks.push(check('sec-34', 'No API keys in source', 'critical',
      found ? 'fail' : 'pass',
      found ? 'Potential API key found' : 'None found',
      found ? 'Potential API key pattern detected in page source' : 'No API key patterns detected in page source'));
  } catch (e) {
    checks.push(check('sec-34', 'No API keys in source', 'critical', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 35: No private IPs in source -----------------------------------------
  try {
    const htmlStr = html || '';
    const privateIpPattern = /(?:^|[^.\d])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?=[^.\d]|$)/g;
    const matches = htmlStr.match(privateIpPattern) || [];
    const unique = [...new Set(matches.map((m) => m.trim()))];
    const pass = unique.length === 0;
    checks.push(check('sec-35', 'No private IPs in source', 'minor',
      pass ? 'pass' : 'warn',
      `${unique.length} found`,
      pass ? 'No private IP addresses found in source' : `${unique.length} private IP(s) found: ${unique.slice(0, 3).join(', ')}`));
  } catch (e) {
    checks.push(check('sec-35', 'No private IPs in source', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 36: No email addresses exposed ---------------------------------------
  try {
    const htmlStr = html || '';
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = htmlStr.match(emailPattern) || [];
    const unique = [...new Set(matches)];
    // Filter out common false positives
    const filtered = unique.filter((e) => !/@example\./i.test(e) && !/@schema\./i.test(e) && !/@type/i.test(e));
    const pass = filtered.length === 0;
    checks.push(check('sec-36', 'No email addresses exposed', 'minor',
      pass ? 'pass' : 'warn',
      `${filtered.length} email(s)`,
      pass ? 'No email addresses found in source' : `${filtered.length} email address(es) found in source`));
  } catch (e) {
    checks.push(check('sec-36', 'No email addresses exposed', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 37: No SQL patterns in URLs ------------------------------------------
  try {
    const urlStr = url || '';
    const allUrlStrs = [urlStr, ...allLinks.map((l) => (typeof l === 'string') ? l : (l.href || l.url || ''))];
    const sqlPattern = /(\bSELECT\b|\bUNION\b|\bDROP\b|\bINSERT\b|\bDELETE\b|\bUPDATE\b|\b--|;--|\bOR\s+1\s*=\s*1)/i;
    const suspicious = allUrlStrs.filter((u) => {
      try {
        const parsed = new URL(u, url);
        return sqlPattern.test(parsed.search);
      } catch (_) {
        return false;
      }
    });
    const pass = suspicious.length === 0;
    checks.push(check('sec-37', 'No SQL patterns in URLs', 'major',
      pass ? 'pass' : 'fail',
      `${suspicious.length} suspicious URL(s)`,
      pass ? 'No SQL injection patterns found in URLs' : `${suspicious.length} URL(s) with potential SQL injection patterns`));
  } catch (e) {
    checks.push(check('sec-37', 'No SQL patterns in URLs', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 38: No debug mode indicators -----------------------------------------
  try {
    const htmlStr = html || '';
    const debugPatterns = [
      /debug\s*[:=]\s*true/i,
      /\bDEBUG\b\s*[:=]\s*["']?true/i,
      /debug_mode/i,
      /DJANGO_DEBUG/i,
      /APP_DEBUG\s*[:=]\s*true/i,
    ];
    const found = debugPatterns.some((p) => p.test(htmlStr));
    checks.push(check('sec-38', 'No debug mode indicators', 'minor',
      found ? 'fail' : 'pass',
      found ? 'Debug indicator found' : 'None found',
      found ? 'Debug mode indicators detected in page source' : 'No debug mode indicators found'));
  } catch (e) {
    checks.push(check('sec-38', 'No debug mode indicators', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 39: No source maps in production -------------------------------------
  try {
    const htmlStr = html || '';
    const hasSourceMap = /\/\/[#@]\s*sourceMappingURL\s*=\s*\S+\.map/i.test(htmlStr);
    const mapRequests = nets.filter((r) => {
      const reqUrl = (typeof r === 'string') ? r : (r.url || '');
      return /\.map(\?|$)/i.test(reqUrl);
    });
    const found = hasSourceMap || mapRequests.length > 0;
    checks.push(check('sec-39', 'No source maps in production', 'minor',
      found ? 'warn' : 'pass',
      found ? 'Source map references found' : 'None found',
      found ? 'Source map references detected – may expose original source code' : 'No source map references detected'));
  } catch (e) {
    checks.push(check('sec-39', 'No source maps in production', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 40: Content-Type correct per resource --------------------------------
  try {
    const ct = header(hdrs, 'content-type') || '';
    const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
    const pass = isHtml;
    checks.push(check('sec-40', 'Content-Type header correct', 'minor',
      pass ? 'pass' : 'warn',
      ct || 'Not set',
      pass ? 'Content-Type matches expected HTML content' : `Content-Type is "${ct}" – expected text/html for this page`));
  } catch (e) {
    checks.push(check('sec-40', 'Content-Type header correct', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 41: X-DNS-Prefetch-Control set ---------------------------------------
  try {
    const val = header(hdrs, 'x-dns-prefetch-control');
    const pass = !!val;
    checks.push(check('sec-41', 'X-DNS-Prefetch-Control set', 'minor',
      pass ? 'pass' : 'warn',
      val || 'Not set',
      pass ? `X-DNS-Prefetch-Control is ${val}` : 'Missing X-DNS-Prefetch-Control header'));
  } catch (e) {
    checks.push(check('sec-41', 'X-DNS-Prefetch-Control set', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 42: Cross-origin headers (CORP/COEP/COOP) ----------------------------
  try {
    const corp = header(hdrs, 'cross-origin-resource-policy');
    const coep = header(hdrs, 'cross-origin-embedder-policy');
    const coop = header(hdrs, 'cross-origin-opener-policy');
    const count = [corp, coep, coop].filter(Boolean).length;
    checks.push(check('sec-42', 'Cross-origin isolation headers', 'minor',
      count === 3 ? 'pass' : (count > 0 ? 'warn' : 'warn'),
      `${count}/3 set`,
      count === 3
        ? 'All cross-origin isolation headers set (CORP, COEP, COOP)'
        : `${count}/3 cross-origin headers set – missing: ${[!corp && 'CORP', !coep && 'COEP', !coop && 'COOP'].filter(Boolean).join(', ')}`));
  } catch (e) {
    checks.push(check('sec-42', 'Cross-origin isolation headers', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 43: No sensitive comments in HTML ------------------------------------
  try {
    const htmlStr = html || '';
    const commentPattern = /<!--([\s\S]*?)-->/g;
    let sensitiveComments = 0;
    const sensitiveKeywords = /\b(password|secret|token|api.?key|private|credential|TODO|FIXME|HACK|BUG|XXX)\b/i;
    let match;
    while ((match = commentPattern.exec(htmlStr)) !== null) {
      if (sensitiveKeywords.test(match[1])) {
        sensitiveComments++;
      }
    }
    const pass = sensitiveComments === 0;
    checks.push(check('sec-43', 'No sensitive comments in HTML', 'minor',
      pass ? 'pass' : 'warn',
      `${sensitiveComments} found`,
      pass ? 'No sensitive keywords found in HTML comments' : `${sensitiveComments} HTML comment(s) contain sensitive keywords`));
  } catch (e) {
    checks.push(check('sec-43', 'No sensitive comments in HTML', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 44: No TODO/FIXME in production source --------------------------------
  try {
    if (!$) {
      checks.push(check('sec-44', 'No TODO/FIXME in inline scripts', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      let count = 0;
      const todoPattern = /\b(TODO|FIXME|HACK|XXX|BUG)\b/;
      $('script:not([src])').each((_, el) => {
        const content = $(el).html() || '';
        if (todoPattern.test(content)) count++;
      });
      const pass = count === 0;
      checks.push(check('sec-44', 'No TODO/FIXME in inline scripts', 'minor',
        pass ? 'pass' : 'warn',
        `${count} script(s)`,
        pass ? 'No TODO/FIXME markers found in inline scripts' : `${count} inline script(s) contain TODO/FIXME markers`));
    }
  } catch (e) {
    checks.push(check('sec-44', 'No TODO/FIXME in inline scripts', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 45: CORS properly configured -----------------------------------------
  try {
    const cors = header(hdrs, 'access-control-allow-origin');
    if (!cors) {
      checks.push(check('sec-45', 'CORS properly configured', 'minor', 'pass', 'No CORS header', 'No Access-Control-Allow-Origin header (OK for same-origin pages)'));
    } else {
      checks.push(check('sec-45', 'CORS properly configured', 'minor', 'pass', cors, `Access-Control-Allow-Origin is set to: ${cors}`));
    }
  } catch (e) {
    checks.push(check('sec-45', 'CORS properly configured', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 46: No wildcard CORS * -----------------------------------------------
  try {
    const cors = header(hdrs, 'access-control-allow-origin');
    if (!cors) {
      checks.push(check('sec-46', 'No wildcard CORS', 'major', 'pass', 'No CORS header', 'No CORS header present'));
    } else {
      const isWildcard = cors.trim() === '*';
      checks.push(check('sec-46', 'No wildcard CORS', 'major',
        isWildcard ? 'fail' : 'pass',
        cors,
        isWildcard ? 'Access-Control-Allow-Origin is set to wildcard *' : `CORS origin is restricted to: ${cors}`));
    }
  } catch (e) {
    checks.push(check('sec-46', 'No wildcard CORS', 'major', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 47: Forms use CSRF protection ----------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-47', 'Forms have CSRF protection', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const forms = $('form');
      if (forms.length === 0) {
        checks.push(check('sec-47', 'Forms have CSRF protection', 'minor', 'pass', 'No forms', 'No forms found on page'));
      } else {
        let protected = 0;
        forms.each((_, form) => {
          const $form = $(form);
          const csrfField = $form.find('input[name*="csrf"], input[name*="token"], input[name*="_token"], input[name*="authenticity_token"], input[name*="__RequestVerificationToken"], input[name*="nonce"]');
          if (csrfField.length > 0) protected++;
        });
        const pass = protected === forms.length;
        checks.push(check('sec-47', 'Forms have CSRF protection', 'minor',
          pass ? 'pass' : 'warn',
          `${protected}/${forms.length} protected`,
          pass ? 'All forms have CSRF token fields' : `${forms.length - protected} form(s) may be missing CSRF protection`));
      }
    }
  } catch (e) {
    checks.push(check('sec-47', 'Forms have CSRF protection', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 48: Password fields autocomplete -------------------------------------
  try {
    if (!$) {
      checks.push(check('sec-48', 'Password autocomplete configured', 'minor', 'warn', 'No HTML', 'Could not parse HTML'));
    } else {
      const pwFields = $('input[type="password"]');
      if (pwFields.length === 0) {
        checks.push(check('sec-48', 'Password autocomplete configured', 'minor', 'pass', 'No password fields', 'No password fields on page'));
      } else {
        let configured = 0;
        pwFields.each((_, el) => {
          const ac = $(el).attr('autocomplete');
          if (ac) configured++;
        });
        const pass = configured === pwFields.length;
        checks.push(check('sec-48', 'Password autocomplete configured', 'minor',
          pass ? 'pass' : 'warn',
          `${configured}/${pwFields.length} configured`,
          pass ? 'All password fields have autocomplete attribute set' : `${pwFields.length - configured} password field(s) missing autocomplete attribute`));
      }
    }
  } catch (e) {
    checks.push(check('sec-48', 'Password autocomplete configured', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 49: No HTTP basic auth -----------------------------------------------
  try {
    const wwwAuth = header(hdrs, 'www-authenticate');
    const isBasic = wwwAuth && /basic/i.test(wwwAuth);
    checks.push(check('sec-49', 'No HTTP basic auth', 'minor',
      isBasic ? 'fail' : 'pass',
      wwwAuth || 'Not present',
      isBasic ? 'WWW-Authenticate header indicates HTTP Basic Auth in use' : 'No HTTP Basic Auth detected'));
  } catch (e) {
    checks.push(check('sec-49', 'No HTTP basic auth', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  // --- 50: CAA DNS record present -------------------------------------------
  try {
    let caaRecords = [];
    try {
      caaRecords = await dns.resolveCaa(domain);
    } catch (dnsErr) {
      // ENODATA / ENOTFOUND are expected when no CAA records
      if (dnsErr.code !== 'ENODATA' && dnsErr.code !== 'ENOTFOUND' && dnsErr.code !== 'ESERVFAIL') {
        throw dnsErr;
      }
    }
    const pass = caaRecords && caaRecords.length > 0;
    checks.push(check('sec-50', 'CAA DNS record present', 'minor',
      pass ? 'pass' : 'warn',
      pass ? `${caaRecords.length} record(s)` : 'Not set',
      pass
        ? `CAA record(s) found: ${caaRecords.map((r) => `${r.critical || 0} ${r.issue || r.iodef || ''}`).join('; ')}`
        : 'No CAA DNS records found – consider adding to restrict certificate issuance'));
  } catch (e) {
    checks.push(check('sec-50', 'CAA DNS record present', 'minor', 'warn', null, `Check error: ${e.message}`));
  }

  return { checks };
}

module.exports = { analyzeSecurity };
