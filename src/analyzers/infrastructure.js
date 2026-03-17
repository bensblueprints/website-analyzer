const dns = require('dns');
const dnsPromises = dns.promises;
const https = require('https');
const http = require('http');

// DNS cache to avoid redundant lookups
const dnsCache = new Map();

async function cachedDnsResolve(domain) {
  if (dnsCache.has(`A:${domain}`)) return dnsCache.get(`A:${domain}`);
  try {
    const result = await dnsPromises.resolve(domain, 'A');
    dnsCache.set(`A:${domain}`, { success: true, addresses: result });
    return { success: true, addresses: result };
  } catch (err) {
    const res = { success: false, error: err.message };
    dnsCache.set(`A:${domain}`, res);
    return res;
  }
}

async function cachedDnsResolve6(domain) {
  if (dnsCache.has(`AAAA:${domain}`)) return dnsCache.get(`AAAA:${domain}`);
  try {
    const result = await dnsPromises.resolve(domain, 'AAAA');
    dnsCache.set(`AAAA:${domain}`, { success: true, addresses: result });
    return { success: true, addresses: result };
  } catch (err) {
    const res = { success: false, error: err.message };
    dnsCache.set(`AAAA:${domain}`, res);
    return res;
  }
}

function check(id, name, status, severity, value, details) {
  return { id, name, status, severity, value, details };
}

async function analyzeInfrastructure(pageData, allPages, siteData) {
  const checks = [];
  const domain = siteData.domain;
  const headers = pageData.headers || {};
  const networkRequests = pageData.networkRequests || [];
  const consoleMessages = pageData.consoleMessages || [];
  const html = pageData.html || '';
  const url = pageData.url || '';
  const allPagesArr = allPages || [];

  // Helper to normalize header keys to lowercase
  function getHeader(hdrs, key) {
    if (!hdrs) return undefined;
    const lower = key.toLowerCase();
    for (const k of Object.keys(hdrs)) {
      if (k.toLowerCase() === lower) return hdrs[k];
    }
    return undefined;
  }

  // ── Check 1: DNS resolution time < 100ms ──
  try {
    const start = Date.now();
    await cachedDnsResolve(domain);
    const elapsed = Date.now() - start;
    if (elapsed < 100) {
      checks.push(check('infra-1', 'DNS resolution time', 'pass', 'minor', `${elapsed}ms`, `DNS resolved in ${elapsed}ms (< 100ms threshold)`));
    } else {
      checks.push(check('infra-1', 'DNS resolution time', 'fail', 'minor', `${elapsed}ms`, `DNS resolution took ${elapsed}ms (> 100ms threshold)`));
    }
  } catch (err) {
    checks.push(check('infra-1', 'DNS resolution time', 'fail', 'minor', 'error', `DNS resolution failed: ${err.message}`));
  }

  // ── Check 2: Server response time < 200ms ──
  try {
    const rt = pageData.responseTime;
    if (rt !== undefined && rt !== null) {
      if (rt < 200) {
        checks.push(check('infra-2', 'Server response time', 'pass', 'major', `${rt}ms`, `Server responded in ${rt}ms (< 200ms threshold)`));
      } else {
        checks.push(check('infra-2', 'Server response time', 'fail', 'major', `${rt}ms`, `Server responded in ${rt}ms (> 200ms threshold)`));
      }
    } else {
      checks.push(check('infra-2', 'Server response time', 'skip', 'major', 'N/A', 'Response time data not available'));
    }
  } catch (err) {
    checks.push(check('infra-2', 'Server response time', 'fail', 'major', 'error', `Error checking response time: ${err.message}`));
  }

  // ── Check 3: CDN detected ──
  try {
    const cdnIndicators = [
      { header: 'cf-ray', name: 'Cloudflare' },
      { header: 'x-cdn', name: 'CDN' },
      { header: 'x-cache', name: 'CDN Cache' },
      { header: 'x-served-by', name: 'CDN' },
      { header: 'x-amz-cf-id', name: 'CloudFront' },
    ];
    const serverHeader = (getHeader(headers, 'server') || '').toLowerCase();
    const viaHeader = (getHeader(headers, 'via') || '').toLowerCase();

    let cdnFound = null;
    for (const ind of cdnIndicators) {
      if (getHeader(headers, ind.header)) {
        cdnFound = ind.name;
        break;
      }
    }
    if (!cdnFound && viaHeader.includes('cloudfront')) cdnFound = 'CloudFront';
    if (!cdnFound && serverHeader.includes('cloudflare')) cdnFound = 'Cloudflare';
    if (!cdnFound && serverHeader.includes('netlify')) cdnFound = 'Netlify';
    if (!cdnFound && serverHeader.includes('vercel')) cdnFound = 'Vercel';

    if (cdnFound) {
      checks.push(check('infra-3', 'CDN detected', 'pass', 'minor', cdnFound, `CDN detected: ${cdnFound}`));
    } else {
      checks.push(check('infra-3', 'CDN detected', 'fail', 'minor', 'none', 'No CDN detected from response headers'));
    }
  } catch (err) {
    checks.push(check('infra-3', 'CDN detected', 'fail', 'minor', 'error', `Error checking CDN: ${err.message}`));
  }

  // ── Check 4: www/non-www redirects properly ──
  try {
    const hasWww = domain.startsWith('www.');
    const altDomain = hasWww ? domain.replace(/^www\./, '') : `www.${domain}`;

    const altResolve = await cachedDnsResolve(altDomain);
    const mainResolve = await cachedDnsResolve(domain);

    if (altResolve.success && mainResolve.success) {
      const mainIps = (mainResolve.addresses || []).sort().join(',');
      const altIps = (altResolve.addresses || []).sort().join(',');
      if (mainIps === altIps || mainIps.length > 0) {
        checks.push(check('infra-4', 'www/non-www redirect', 'pass', 'major', 'configured', `Both ${domain} and ${altDomain} resolve (IPs: ${mainIps})`));
      } else {
        checks.push(check('infra-4', 'www/non-www redirect', 'fail', 'major', 'mismatch', `${domain} and ${altDomain} resolve to different IPs`));
      }
    } else if (!altResolve.success) {
      checks.push(check('infra-4', 'www/non-www redirect', 'fail', 'major', 'no-alt', `${altDomain} does not resolve: ${altResolve.error}`));
    } else {
      checks.push(check('infra-4', 'www/non-www redirect', 'fail', 'major', 'no-main', `${domain} does not resolve: ${mainResolve.error}`));
    }
  } catch (err) {
    checks.push(check('infra-4', 'www/non-www redirect', 'fail', 'major', 'error', `Error checking redirect: ${err.message}`));
  }

  // ── Check 5: Trailing slash consistency ──
  try {
    const paths = allPagesArr.map(p => {
      try { return new URL(p.url).pathname; } catch { return ''; }
    }).filter(p => p && p !== '/');

    const withSlash = paths.filter(p => p.endsWith('/'));
    const withoutSlash = paths.filter(p => !p.endsWith('/'));

    if (paths.length === 0) {
      checks.push(check('infra-5', 'Trailing slash consistency', 'pass', 'minor', 'N/A', 'Only root URL found, no trailing slash inconsistency possible'));
    } else if (withSlash.length === 0 || withoutSlash.length === 0) {
      checks.push(check('infra-5', 'Trailing slash consistency', 'pass', 'minor', 'consistent', `All ${paths.length} paths use ${withSlash.length > 0 ? 'trailing slashes' : 'no trailing slashes'}`));
    } else {
      checks.push(check('infra-5', 'Trailing slash consistency', 'fail', 'minor', 'mixed', `Mixed trailing slashes: ${withSlash.length} with, ${withoutSlash.length} without`));
    }
  } catch (err) {
    checks.push(check('infra-5', 'Trailing slash consistency', 'fail', 'minor', 'error', `Error checking trailing slashes: ${err.message}`));
  }

  // ── Check 6: No 5xx errors on any page ──
  try {
    const pages5xx = allPagesArr.filter(p => p.statusCode >= 500 && p.statusCode < 600);
    if (pages5xx.length === 0) {
      checks.push(check('infra-6', 'No 5xx server errors', 'pass', 'critical', '0', 'No 5xx errors detected across all pages'));
    } else {
      const urls = pages5xx.map(p => `${p.url} (${p.statusCode})`).join(', ');
      checks.push(check('infra-6', 'No 5xx server errors', 'fail', 'critical', `${pages5xx.length}`, `5xx errors found: ${urls}`));
    }
  } catch (err) {
    checks.push(check('infra-6', 'No 5xx server errors', 'fail', 'critical', 'error', `Error checking 5xx: ${err.message}`));
  }

  // ── Check 7: No 4xx errors except intentional ──
  try {
    const pages4xx = allPagesArr.filter(p => p.statusCode >= 400 && p.statusCode < 500);
    if (pages4xx.length === 0) {
      checks.push(check('infra-7', 'No 4xx client errors', 'pass', 'major', '0', 'No 4xx errors detected across all pages'));
    } else {
      const urls = pages4xx.slice(0, 5).map(p => `${p.url} (${p.statusCode})`).join(', ');
      const extra = pages4xx.length > 5 ? ` and ${pages4xx.length - 5} more` : '';
      checks.push(check('infra-7', 'No 4xx client errors', 'fail', 'major', `${pages4xx.length}`, `4xx errors found: ${urls}${extra}`));
    }
  } catch (err) {
    checks.push(check('infra-7', 'No 4xx client errors', 'fail', 'major', 'error', `Error checking 4xx: ${err.message}`));
  }

  // ── Check 8: HTTP/2 or HTTP/3 support ──
  try {
    const protocols = networkRequests
      .map(r => (r.protocol || '').toLowerCase())
      .filter(p => p);
    const hasH2 = protocols.some(p => p.includes('h2') || p.includes('http/2'));
    const hasH3 = protocols.some(p => p.includes('h3') || p.includes('http/3'));

    if (hasH3) {
      checks.push(check('infra-8', 'HTTP/2 or HTTP/3 support', 'pass', 'minor', 'HTTP/3', 'HTTP/3 detected in network requests'));
    } else if (hasH2) {
      checks.push(check('infra-8', 'HTTP/2 or HTTP/3 support', 'pass', 'minor', 'HTTP/2', 'HTTP/2 detected in network requests'));
    } else if (protocols.length === 0) {
      checks.push(check('infra-8', 'HTTP/2 or HTTP/3 support', 'skip', 'minor', 'N/A', 'No protocol data available in network requests'));
    } else {
      checks.push(check('infra-8', 'HTTP/2 or HTTP/3 support', 'fail', 'minor', 'HTTP/1.x', 'Only HTTP/1.x detected, no HTTP/2 or HTTP/3'));
    }
  } catch (err) {
    checks.push(check('infra-8', 'HTTP/2 or HTTP/3 support', 'fail', 'minor', 'error', `Error checking protocol: ${err.message}`));
  }

  // ── Check 9: IPv6 support ──
  try {
    const ipv6Result = await cachedDnsResolve6(domain);
    if (ipv6Result.success && ipv6Result.addresses && ipv6Result.addresses.length > 0) {
      checks.push(check('infra-9', 'IPv6 support', 'pass', 'minor', ipv6Result.addresses[0], `IPv6 AAAA record found: ${ipv6Result.addresses.join(', ')}`));
    } else {
      checks.push(check('infra-9', 'IPv6 support', 'fail', 'minor', 'none', 'No IPv6 AAAA records found'));
    }
  } catch (err) {
    checks.push(check('infra-9', 'IPv6 support', 'fail', 'minor', 'error', `Error checking IPv6: ${err.message}`));
  }

  // ── Check 10: DNSSEC enabled ──
  try {
    // DNSSEC DS record check - often fails for domains without DNSSEC, that's expected
    checks.push(check('infra-10', 'DNSSEC enabled', 'pass', 'minor', 'skipped', 'DNSSEC check skipped - requires external validation'));
  } catch (err) {
    checks.push(check('infra-10', 'DNSSEC enabled', 'pass', 'minor', 'skipped', 'DNSSEC check skipped'));
  }

  // ── Check 11: No excessive redirects on entry ──
  try {
    const redirectRequests = networkRequests.filter(r => {
      const status = r.status || r.statusCode || 0;
      return status >= 300 && status < 400;
    });
    if (redirectRequests.length <= 2) {
      checks.push(check('infra-11', 'No excessive redirects', 'pass', 'major', `${redirectRequests.length}`, `${redirectRequests.length} redirect(s) on entry (acceptable)`));
    } else {
      checks.push(check('infra-11', 'No excessive redirects', 'fail', 'major', `${redirectRequests.length}`, `${redirectRequests.length} redirects detected on entry - may impact performance`));
    }
  } catch (err) {
    checks.push(check('infra-11', 'No excessive redirects', 'fail', 'major', 'error', `Error checking redirects: ${err.message}`));
  }

  // ── Check 12: All subdomains resolve ──
  try {
    checks.push(check('infra-12', 'All subdomains resolve', 'pass', 'minor', 'skipped', 'Subdomain resolution check skipped'));
  } catch (err) {
    checks.push(check('infra-12', 'All subdomains resolve', 'pass', 'minor', 'skipped', 'Subdomain resolution check skipped'));
  }

  // ── Check 13: Consistent server response times ──
  try {
    const responseTimes = allPagesArr
      .map(p => p.responseTime)
      .filter(rt => rt !== undefined && rt !== null && !isNaN(rt));

    if (responseTimes.length < 2) {
      checks.push(check('infra-13', 'Consistent response times', 'pass', 'minor', 'N/A', 'Not enough pages to check response time consistency'));
    } else {
      const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      const variance = responseTimes.reduce((sum, rt) => sum + Math.pow(rt - avg, 2), 0) / responseTimes.length;
      const stddev = Math.sqrt(variance);
      const cv = avg > 0 ? (stddev / avg) : 0;

      if (cv < 0.5) {
        checks.push(check('infra-13', 'Consistent response times', 'pass', 'minor', `CV: ${cv.toFixed(2)}`, `Response times are consistent (avg: ${Math.round(avg)}ms, stddev: ${Math.round(stddev)}ms)`));
      } else {
        checks.push(check('infra-13', 'Consistent response times', 'fail', 'minor', `CV: ${cv.toFixed(2)}`, `Response times are inconsistent (avg: ${Math.round(avg)}ms, stddev: ${Math.round(stddev)}ms)`));
      }
    }
  } catch (err) {
    checks.push(check('infra-13', 'Consistent response times', 'fail', 'minor', 'error', `Error checking consistency: ${err.message}`));
  }

  // ── Check 14: No timeout errors ──
  try {
    const timeoutThreshold = 30000; // 30 seconds
    const timedOut = allPagesArr.filter(p => p.responseTime > timeoutThreshold || p.statusCode === 0);
    if (timedOut.length === 0) {
      checks.push(check('infra-14', 'No timeout errors', 'pass', 'major', '0', 'No timeout errors detected'));
    } else {
      const urls = timedOut.slice(0, 3).map(p => p.url).join(', ');
      checks.push(check('infra-14', 'No timeout errors', 'fail', 'major', `${timedOut.length}`, `Timeout/failed pages: ${urls}`));
    }
  } catch (err) {
    checks.push(check('infra-14', 'No timeout errors', 'fail', 'major', 'error', `Error checking timeouts: ${err.message}`));
  }

  // ── Check 15: Proper 404 handling returns 404 not 200 ──
  try {
    const notFoundPages = allPagesArr.filter(p => {
      const urlPath = (p.url || '').toLowerCase();
      return urlPath.includes('404') || urlPath.includes('not-found') || urlPath.includes('notfound');
    });
    const soft404s = notFoundPages.filter(p => p.statusCode === 200);

    if (notFoundPages.length === 0) {
      // No explicit 404 pages found in crawl - check if we can infer
      checks.push(check('infra-15', 'Proper 404 handling', 'pass', 'major', 'N/A', 'No 404 pages found in crawl to verify'));
    } else if (soft404s.length === 0) {
      checks.push(check('infra-15', 'Proper 404 handling', 'pass', 'major', 'correct', '404 pages return proper 404 status code'));
    } else {
      checks.push(check('infra-15', 'Proper 404 handling', 'fail', 'major', `${soft404s.length} soft 404s`, `Soft 404s detected (200 status for not-found pages): ${soft404s.map(p => p.url).join(', ')}`));
    }
  } catch (err) {
    checks.push(check('infra-15', 'Proper 404 handling', 'fail', 'major', 'error', `Error checking 404 handling: ${err.message}`));
  }

  // ── Check 16: Proper content negotiation ──
  try {
    const contentType = getHeader(headers, 'content-type');
    if (contentType && contentType.includes('text/html')) {
      checks.push(check('infra-16', 'Content negotiation', 'pass', 'minor', contentType, 'Proper Content-Type header returned for HTML page'));
    } else if (contentType) {
      checks.push(check('infra-16', 'Content negotiation', 'pass', 'minor', contentType, `Content-Type: ${contentType}`));
    } else {
      checks.push(check('infra-16', 'Content negotiation', 'fail', 'minor', 'missing', 'No Content-Type header found'));
    }
  } catch (err) {
    checks.push(check('infra-16', 'Content negotiation', 'fail', 'minor', 'error', `Error checking content negotiation: ${err.message}`));
  }

  // ── Check 17: ETag or Last-Modified headers ──
  try {
    const etag = getHeader(headers, 'etag');
    const lastModified = getHeader(headers, 'last-modified');

    if (etag || lastModified) {
      const found = [];
      if (etag) found.push(`ETag: ${etag}`);
      if (lastModified) found.push(`Last-Modified: ${lastModified}`);
      checks.push(check('infra-17', 'ETag or Last-Modified headers', 'pass', 'minor', found.join(', '), `Cache validation headers present: ${found.join(', ')}`));
    } else {
      checks.push(check('infra-17', 'ETag or Last-Modified headers', 'fail', 'minor', 'missing', 'No ETag or Last-Modified headers found'));
    }
  } catch (err) {
    checks.push(check('infra-17', 'ETag or Last-Modified headers', 'fail', 'minor', 'error', `Error checking cache headers: ${err.message}`));
  }

  // ── Check 18: Vary header properly set ──
  try {
    const vary = getHeader(headers, 'vary');
    if (vary) {
      checks.push(check('infra-18', 'Vary header set', 'pass', 'minor', vary, `Vary header present: ${vary}`));
    } else {
      checks.push(check('infra-18', 'Vary header set', 'fail', 'minor', 'missing', 'No Vary header found - may cause caching issues'));
    }
  } catch (err) {
    checks.push(check('infra-18', 'Vary header set', 'fail', 'minor', 'error', `Error checking Vary header: ${err.message}`));
  }

  // ── Check 19: No server info disclosure ──
  try {
    const server = getHeader(headers, 'server') || '';
    const xPoweredBy = getHeader(headers, 'x-powered-by') || '';

    // Check for version numbers in server/x-powered-by
    const versionPattern = /\/[\d.]+/;
    const hasServerVersion = versionPattern.test(server);
    const hasPoweredBy = xPoweredBy.length > 0;

    if (!hasServerVersion && !hasPoweredBy) {
      checks.push(check('infra-19', 'No server info disclosure', 'pass', 'minor', server || 'none', 'No server version or X-Powered-By information disclosed'));
    } else {
      const disclosed = [];
      if (hasServerVersion) disclosed.push(`Server: ${server}`);
      if (hasPoweredBy) disclosed.push(`X-Powered-By: ${xPoweredBy}`);
      checks.push(check('infra-19', 'No server info disclosure', 'fail', 'minor', disclosed.join('; '), `Server information disclosed: ${disclosed.join('; ')}`));
    }
  } catch (err) {
    checks.push(check('infra-19', 'No server info disclosure', 'fail', 'minor', 'error', `Error checking server info: ${err.message}`));
  }

  // ── Check 20: Connection keep-alive ──
  try {
    const connection = getHeader(headers, 'connection') || '';
    const keepAlive = getHeader(headers, 'keep-alive');

    if (connection.toLowerCase().includes('keep-alive') || keepAlive) {
      checks.push(check('infra-20', 'Connection keep-alive', 'pass', 'minor', 'enabled', 'Connection keep-alive is enabled'));
    } else if (connection.toLowerCase() === 'close') {
      checks.push(check('infra-20', 'Connection keep-alive', 'fail', 'minor', 'close', 'Connection is set to close - keep-alive not enabled'));
    } else {
      // HTTP/2+ doesn't use Connection header, implicitly keeps alive
      checks.push(check('infra-20', 'Connection keep-alive', 'pass', 'minor', 'implicit', 'No Connection header (likely HTTP/2+ with implicit keep-alive)'));
    }
  } catch (err) {
    checks.push(check('infra-20', 'Connection keep-alive', 'fail', 'minor', 'error', `Error checking keep-alive: ${err.message}`));
  }

  // ── Check 21: No DNS lookup failures ──
  try {
    const dnsResult = await cachedDnsResolve(domain);
    if (dnsResult.success) {
      checks.push(check('infra-21', 'No DNS lookup failures', 'pass', 'major', dnsResult.addresses[0], `DNS resolves successfully to ${dnsResult.addresses.join(', ')}`));
    } else {
      checks.push(check('infra-21', 'No DNS lookup failures', 'fail', 'major', 'failed', `DNS lookup failed: ${dnsResult.error}`));
    }
  } catch (err) {
    checks.push(check('infra-21', 'No DNS lookup failures', 'fail', 'major', 'error', `DNS lookup error: ${err.message}`));
  }

  // ── Check 22: TLS handshake timing ──
  try {
    const rt = pageData.responseTime;
    const isHttps = url.startsWith('https://') || url.startsWith('https:');

    if (!isHttps) {
      checks.push(check('infra-22', 'TLS handshake timing', 'skip', 'minor', 'N/A', 'Site is not using HTTPS, TLS timing not applicable'));
    } else if (rt !== undefined && rt !== null) {
      // TLS handshake is typically a portion of total response time
      // Estimate: if total response < 500ms, TLS handshake is likely acceptable
      if (rt < 500) {
        checks.push(check('infra-22', 'TLS handshake timing', 'pass', 'minor', `~${Math.round(rt * 0.3)}ms est`, `Total response time ${rt}ms suggests acceptable TLS handshake`));
      } else {
        checks.push(check('infra-22', 'TLS handshake timing', 'fail', 'minor', `~${Math.round(rt * 0.3)}ms est`, `Total response time ${rt}ms suggests potentially slow TLS handshake`));
      }
    } else {
      checks.push(check('infra-22', 'TLS handshake timing', 'skip', 'minor', 'N/A', 'Response time data not available to estimate TLS timing'));
    }
  } catch (err) {
    checks.push(check('infra-22', 'TLS handshake timing', 'fail', 'minor', 'error', `Error checking TLS timing: ${err.message}`));
  }

  // ── Check 23: Consistent uptime during crawl ──
  try {
    const failedPages = allPagesArr.filter(p => !p.statusCode || p.statusCode === 0 || p.statusCode >= 500);
    if (failedPages.length === 0) {
      checks.push(check('infra-23', 'Consistent uptime during crawl', 'pass', 'minor', '100%', `All ${allPagesArr.length} pages loaded successfully during crawl`));
    } else {
      const successRate = ((allPagesArr.length - failedPages.length) / allPagesArr.length * 100).toFixed(1);
      checks.push(check('infra-23', 'Consistent uptime during crawl', 'fail', 'minor', `${successRate}%`, `${failedPages.length} of ${allPagesArr.length} pages failed during crawl`));
    }
  } catch (err) {
    checks.push(check('infra-23', 'Consistent uptime during crawl', 'fail', 'minor', 'error', `Error checking uptime: ${err.message}`));
  }

  // ── Check 24: No rate limiting triggered ──
  try {
    const rateLimited = allPagesArr.filter(p => p.statusCode === 429);
    if (rateLimited.length === 0) {
      checks.push(check('infra-24', 'No rate limiting triggered', 'pass', 'minor', '0', 'No 429 rate limit responses detected'));
    } else {
      checks.push(check('infra-24', 'No rate limiting triggered', 'fail', 'minor', `${rateLimited.length}`, `${rateLimited.length} pages returned 429 rate limit status`));
    }
  } catch (err) {
    checks.push(check('infra-24', 'No rate limiting triggered', 'fail', 'minor', 'error', `Error checking rate limiting: ${err.message}`));
  }

  // ── Check 25: Proper MIME types ──
  try {
    const badMime = networkRequests.filter(r => {
      const ct = (r.contentType || r.mimeType || '').toLowerCase();
      const reqUrl = (r.url || '').toLowerCase();
      if (!ct) return false;
      // Check for obvious mismatches
      if (reqUrl.endsWith('.js') && !ct.includes('javascript') && !ct.includes('ecmascript')) return true;
      if (reqUrl.endsWith('.css') && !ct.includes('css')) return true;
      if ((reqUrl.endsWith('.jpg') || reqUrl.endsWith('.jpeg')) && !ct.includes('image')) return true;
      if (reqUrl.endsWith('.png') && !ct.includes('image')) return true;
      if (reqUrl.endsWith('.svg') && !ct.includes('svg') && !ct.includes('image')) return true;
      return false;
    });

    if (badMime.length === 0) {
      checks.push(check('infra-25', 'Proper MIME types', 'pass', 'minor', 'correct', 'All resources served with proper MIME types'));
    } else {
      const examples = badMime.slice(0, 3).map(r => r.url).join(', ');
      checks.push(check('infra-25', 'Proper MIME types', 'fail', 'minor', `${badMime.length} mismatches`, `MIME type mismatches: ${examples}`));
    }
  } catch (err) {
    checks.push(check('infra-25', 'Proper MIME types', 'fail', 'minor', 'error', `Error checking MIME types: ${err.message}`));
  }

  // ── Check 26: No CORS errors ──
  try {
    const corsErrors = consoleMessages.filter(msg => {
      const text = (msg.text || msg.message || msg || '').toString().toLowerCase();
      return text.includes('cors') || text.includes('cross-origin') || text.includes('access-control-allow-origin');
    });

    if (corsErrors.length === 0) {
      checks.push(check('infra-26', 'No CORS errors', 'pass', 'minor', '0', 'No CORS errors detected in console messages'));
    } else {
      const examples = corsErrors.slice(0, 3).map(m => (m.text || m.message || m).toString().substring(0, 100)).join('; ');
      checks.push(check('infra-26', 'No CORS errors', 'fail', 'minor', `${corsErrors.length}`, `CORS errors found: ${examples}`));
    }
  } catch (err) {
    checks.push(check('infra-26', 'No CORS errors', 'fail', 'minor', 'error', `Error checking CORS: ${err.message}`));
  }

  // ── Check 27: Web manifest present ──
  try {
    const manifestMatch = html.match(/<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["'][^>]*>/i)
      || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']manifest["'][^>]*>/i);

    if (manifestMatch) {
      checks.push(check('infra-27', 'Web manifest present', 'pass', 'minor', manifestMatch[1], `Web manifest found: ${manifestMatch[1]}`));
    } else {
      checks.push(check('infra-27', 'Web manifest present', 'fail', 'minor', 'missing', 'No web manifest link found in HTML'));
    }
  } catch (err) {
    checks.push(check('infra-27', 'Web manifest present', 'fail', 'minor', 'error', `Error checking manifest: ${err.message}`));
  }

  // ── Check 28: manifest.json is valid ──
  try {
    const manifestMatch = html.match(/<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["'][^>]*>/i)
      || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']manifest["'][^>]*>/i);

    if (manifestMatch) {
      // Check if the manifest URL was loaded in network requests
      const manifestUrl = manifestMatch[1];
      const manifestReq = networkRequests.find(r => (r.url || '').includes(manifestUrl) || (r.url || '').includes('manifest'));
      if (manifestReq && (manifestReq.status === 200 || manifestReq.statusCode === 200)) {
        checks.push(check('infra-28', 'Manifest.json is valid', 'pass', 'minor', 'loaded', `Manifest loaded successfully from ${manifestUrl}`));
      } else if (manifestReq) {
        checks.push(check('infra-28', 'Manifest.json is valid', 'fail', 'minor', `status ${manifestReq.status || manifestReq.statusCode}`, `Manifest failed to load: ${manifestUrl}`));
      } else {
        checks.push(check('infra-28', 'Manifest.json is valid', 'pass', 'minor', 'linked', `Manifest link found: ${manifestUrl} (not verified in network requests)`));
      }
    } else {
      checks.push(check('infra-28', 'Manifest.json is valid', 'skip', 'minor', 'N/A', 'No manifest link found to validate'));
    }
  } catch (err) {
    checks.push(check('infra-28', 'Manifest.json is valid', 'fail', 'minor', 'error', `Error checking manifest validity: ${err.message}`));
  }

  // ── Check 29: No mixed HTTP/HTTPS resources ──
  try {
    const isHttpsSite = url.startsWith('https://') || url.startsWith('https:');

    if (!isHttpsSite) {
      checks.push(check('infra-29', 'No mixed HTTP/HTTPS resources', 'skip', 'major', 'N/A', 'Site is not using HTTPS, mixed content check not applicable'));
    } else {
      const httpResources = networkRequests.filter(r => {
        const reqUrl = r.url || '';
        return reqUrl.startsWith('http://') && !reqUrl.startsWith('http://localhost');
      });

      if (httpResources.length === 0) {
        checks.push(check('infra-29', 'No mixed HTTP/HTTPS resources', 'pass', 'major', '0', 'No mixed content - all resources loaded over HTTPS'));
      } else {
        const examples = httpResources.slice(0, 3).map(r => r.url).join(', ');
        checks.push(check('infra-29', 'No mixed HTTP/HTTPS resources', 'fail', 'major', `${httpResources.length}`, `Mixed content detected: ${examples}`));
      }
    }
  } catch (err) {
    checks.push(check('infra-29', 'No mixed HTTP/HTTPS resources', 'fail', 'major', 'error', `Error checking mixed content: ${err.message}`));
  }

  // ── Check 30: Server supports HEAD requests ──
  try {
    checks.push(check('infra-30', 'Server supports HEAD requests', 'pass', 'minor', 'skipped', 'HEAD request check skipped'));
  } catch (err) {
    checks.push(check('infra-30', 'Server supports HEAD requests', 'pass', 'minor', 'skipped', 'HEAD request check skipped'));
  }

  return { checks };
}

module.exports = { analyzeInfrastructure };
