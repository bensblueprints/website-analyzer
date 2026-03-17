#!/usr/bin/env node

/**
 * Website Analyzer — Full Algorithmic Scoring (No AI)
 * Crawls any website, checks 500+ deterministic data points, outputs a score 1-100.
 *
 * Usage:
 *   node analyze.js https://example.com
 *   node analyze.js https://example.com --max-pages 50
 *   node analyze.js https://example.com --output ./reports/example.html
 *   node analyze.js https://example.com --categories performance,seo,security
 *   node analyze.js https://example.com --verbose
 */

const { program } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs');

const { crawlSite } = require('./src/crawler');
const { calculateOverallScore, generateExecutiveSummary } = require('./src/scorer');
const { generateReport, generatePDF } = require('./src/reporter');

// Analyzer imports
const { analyzePerformance } = require('./src/analyzers/performance');
const { analyzeSEO } = require('./src/analyzers/seo');
const { analyzeAccessibility } = require('./src/analyzers/accessibility');
const { analyzeSecurity } = require('./src/analyzers/security');
const { analyzeLinks } = require('./src/analyzers/links');
const { analyzeContent } = require('./src/analyzers/content');
const { analyzeMobile } = require('./src/analyzers/mobile');
const { analyzeTechnical } = require('./src/analyzers/technical');
const { analyzeUXSignals } = require('./src/analyzers/ux-signals');
const { analyzeInfrastructure } = require('./src/analyzers/infrastructure');

const ALL_CATEGORIES = [
  'performance', 'seo', 'accessibility', 'security', 'links',
  'content', 'mobile', 'technical', 'ux-signals', 'infrastructure'
];

program
  .name('website-analyzer')
  .description('Analyze any website across 500+ data points and get a score from 1-100')
  .version('1.0.0')
  .argument('<url>', 'Website URL to analyze')
  .option('-m, --max-pages <number>', 'Maximum pages to crawl', (v) => Number(v), 200)
  .option('-o, --output <path>', 'Output path for HTML report')
  .option('-c, --categories <list>', 'Comma-separated categories to analyze')
  .option('-d, --delay <ms>', 'Delay between page requests in ms', (v) => Number(v), 500)
  .option('-t, --timeout <ms>', 'Timeout per page in ms', (v) => Number(v), 30000)
  .option('-v, --verbose', 'Verbose output', false)
  .option('--no-lighthouse', 'Skip Lighthouse analysis (faster but fewer data points)')
  .option('--no-axe', 'Skip axe-core accessibility analysis')
  .option('--no-pdf', 'Skip PDF report generation')
  .action(runAnalysis);

program.parse();

async function runAnalysis(url, options) {
  const startTime = Date.now();

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      console.error(chalk.red('Error: URL must use http:// or https:// protocol'));
      process.exit(1);
    }
  } catch {
    console.error(chalk.red('Error: Invalid URL provided'));
    process.exit(1);
  }

  // Parse categories
  const categories = options.categories
    ? options.categories.split(',').map(c => c.trim().toLowerCase())
    : ALL_CATEGORIES;

  const invalidCats = categories.filter(c => !ALL_CATEGORIES.includes(c));
  if (invalidCats.length > 0) {
    console.error(chalk.red(`Error: Unknown categories: ${invalidCats.join(', ')}`));
    console.error(chalk.yellow(`Valid categories: ${ALL_CATEGORIES.join(', ')}`));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║') + chalk.bold.white('   Website Analyzer — Advanced Marketing          ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('║') + chalk.white('   500+ Data Points | Pure Algorithmic Scoring     ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.white('  Target: ') + chalk.bold(url));
  console.log(chalk.white('  Max Pages: ') + chalk.bold(options.maxPages));
  console.log(chalk.white('  Categories: ') + chalk.bold(categories.join(', ')));
  console.log('');

  // ───── Phase 1: Crawl ─────
  const crawlSpinner = ora({ text: 'Crawling website...', color: 'cyan' }).start();

  let crawlData;
  try {
    crawlData = await crawlSite(url, {
      maxPages: options.maxPages,
      delay: options.delay,
      timeout: options.timeout,
      verbose: options.verbose,
      onProgress: ({ current, total, url: pageUrl }) => {
        crawlSpinner.text = `Crawling page ${current}/${total}: ${pageUrl.substring(0, 60)}...`;
      }
    });
    crawlSpinner.succeed(`Crawled ${crawlData.pages.length} pages in ${(crawlData.crawlTime / 1000).toFixed(1)}s`);
  } catch (err) {
    crawlSpinner.fail(`Crawl failed: ${err.message}`);
    if (options.verbose) console.error(err);
    process.exit(1);
  }

  if (crawlData.pages.length === 0) {
    console.error(chalk.red('Error: No pages could be crawled from this URL'));
    process.exit(1);
  }

  // ───── Phase 2: Lighthouse (optional) ─────
  let lighthouseResults = null;
  if (options.lighthouse !== false && categories.some(c => ['performance', 'mobile', 'ux-signals'].includes(c))) {
    const lhSpinner = ora({ text: 'Running Lighthouse audit on homepage...', color: 'yellow' }).start();
    try {
      lighthouseResults = await runLighthouse(url);
      lhSpinner.succeed('Lighthouse audit complete');
    } catch (err) {
      lhSpinner.warn(`Lighthouse skipped: ${err.message}`);
    }
  }

  // ───── Phase 3: axe-core (optional) ─────
  let axeResults = null;
  if (options.axe !== false && categories.includes('accessibility')) {
    const axeSpinner = ora({ text: 'Running accessibility audit...', color: 'magenta' }).start();
    try {
      axeResults = await runAxeCore(url);
      axeSpinner.succeed('Accessibility audit complete');
    } catch (err) {
      axeSpinner.warn(`axe-core skipped: ${err.message}`);
    }
  }

  // ───── Phase 4: Run Analyzers ─────
  const analyzeSpinner = ora({ text: 'Analyzing data points...', color: 'green' }).start();

  const siteData = {
    domain: crawlData.domain,
    sitemapUrls: crawlData.sitemapUrls,
    robotsTxt: crawlData.robotsTxt
  };

  const categoryResults = {};
  const homepage = crawlData.pages[0];

  const analyzerMap = {
    'performance': async () => {
      analyzeSpinner.text = 'Analyzing performance (60 checks)...';
      return analyzePerformance(homepage, lighthouseResults);
    },
    'seo': async () => {
      analyzeSpinner.text = 'Analyzing SEO (80 checks)...';
      return analyzeSEO(homepage, crawlData.pages, siteData);
    },
    'accessibility': async () => {
      analyzeSpinner.text = 'Analyzing accessibility (70 checks)...';
      return analyzeAccessibility(homepage, axeResults);
    },
    'security': async () => {
      analyzeSpinner.text = 'Analyzing security (50 checks)...';
      return analyzeSecurity(homepage, siteData);
    },
    'links': async () => {
      analyzeSpinner.text = 'Analyzing links & navigation (40 checks)...';
      return analyzeLinks(homepage, crawlData.pages, siteData);
    },
    'content': async () => {
      analyzeSpinner.text = 'Analyzing content quality (50 checks)...';
      return analyzeContent(homepage, crawlData.pages);
    },
    'mobile': async () => {
      analyzeSpinner.text = 'Analyzing mobile responsiveness (40 checks)...';
      return analyzeMobile(homepage, lighthouseResults);
    },
    'technical': async () => {
      analyzeSpinner.text = 'Analyzing technical HTML/CSS (50 checks)...';
      return analyzeTechnical(homepage);
    },
    'ux-signals': async () => {
      analyzeSpinner.text = 'Analyzing UX signals (30 checks)...';
      return analyzeUXSignals(homepage, crawlData.pages, lighthouseResults);
    },
    'infrastructure': async () => {
      analyzeSpinner.text = 'Analyzing infrastructure (30 checks)...';
      return analyzeInfrastructure(homepage, crawlData.pages, siteData);
    }
  };

  for (const category of categories) {
    try {
      categoryResults[category] = await analyzerMap[category]();
    } catch (err) {
      if (options.verbose) console.error(`\n  ${chalk.red('Error in')} ${category}: ${err.message}`);
      categoryResults[category] = { checks: [] };
    }
  }

  analyzeSpinner.succeed('All analyzers complete');

  // ───── Phase 5: Calculate Scores ─────
  const scoreSpinner = ora({ text: 'Calculating scores...', color: 'blue' }).start();

  const scoreResult = calculateOverallScore(categoryResults);
  scoreResult.executiveSummary = generateExecutiveSummary(
    scoreResult,
    crawlData.domain,
    crawlData.pages.length
  );

  scoreSpinner.succeed('Scores calculated');

  // ───── Phase 6: Generate Report ─────
  const reportSpinner = ora({ text: 'Generating HTML report...', color: 'white' }).start();

  const reportHtml = generateReport(scoreResult, crawlData, {
    url,
    maxPages: options.maxPages,
    analyzedAt: new Date().toISOString()
  });

  // Determine output path
  const domain = crawlData.domain.replace(/[^a-zA-Z0-9.-]/g, '_');
  const timestamp = new Date().toISOString().split('T')[0];
  const defaultOutput = path.join(__dirname, 'reports', `${domain}_${timestamp}.html`);
  const outputPath = options.output || defaultOutput;

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, reportHtml);
  reportSpinner.succeed(`HTML report saved to ${outputPath}`);

  // ───── Phase 7: Generate PDF ─────
  let pdfPath = null;
  if (options.pdf !== false) {
    const pdfSpinner = ora({ text: 'Generating PDF report...', color: 'magenta' }).start();
    try {
      pdfPath = outputPath.replace(/\.html$/, '.pdf');
      await generatePDF(reportHtml, pdfPath);
      pdfSpinner.succeed(`PDF report saved to ${pdfPath}`);
    } catch (err) {
      pdfSpinner.warn(`PDF generation failed: ${err.message}`);
      pdfPath = null;
      if (options.verbose) console.error(err);
    }
  }

  // ───── Print Summary ─────
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log(chalk.bold('═══════════════════════════════════════════════════'));
  console.log('');

  // Score display
  const scoreColor = scoreResult.score >= 90 ? 'green' :
    scoreResult.score >= 70 ? 'yellow' :
    scoreResult.score >= 50 ? 'hex("#fb923c")' : 'red';

  console.log(chalk.bold(`  Overall Score: ${chalk[scoreResult.score >= 90 ? 'green' : scoreResult.score >= 70 ? 'yellow' : 'red'].bold(scoreResult.score + '/100')} (${scoreResult.grade} - ${scoreResult.gradeLabel})`));
  console.log('');

  // Category scores
  for (const [cat, data] of Object.entries(scoreResult.breakdown)) {
    const bar = createBar(data.score);
    const scoreStr = String(Math.round(data.score)).padStart(3);
    console.log(`  ${data.label.padEnd(22)} ${scoreStr}/100  ${bar}  ${data.grade}`);
  }

  console.log('');
  console.log(chalk.dim(`  ${scoreResult.stats.totalChecks} checks | ${scoreResult.stats.totalPassed} passed | ${scoreResult.stats.totalFailed} failed | ${scoreResult.stats.totalWarned} warnings`));
  console.log(chalk.dim(`  ${crawlData.pages.length} pages crawled in ${totalTime}s`));
  console.log('');

  // Top 5 issues
  if (scoreResult.topIssues.length > 0) {
    console.log(chalk.bold.red('  Top Issues:'));
    for (const issue of scoreResult.topIssues.slice(0, 5)) {
      const sevColor = issue.severity === 'critical' ? 'red' : issue.severity === 'major' ? 'yellow' : 'dim';
      console.log(`    ${chalk[sevColor](`[${issue.severity.toUpperCase()}]`)} ${issue.name} — ${issue.details || ''}`);
    }
    if (scoreResult.topIssues.length > 5) {
      console.log(chalk.dim(`    ... and ${scoreResult.topIssues.length - 5} more issues`));
    }
    console.log('');
  }

  console.log(chalk.dim(`  HTML report: ${outputPath}`));
  if (pdfPath) {
    console.log(chalk.dim(`  PDF report:  ${pdfPath}`));
  }
  console.log('');
}

function createBar(score, width = 20) {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const color = score >= 90 ? chalk.green : score >= 70 ? chalk.yellow : score >= 50 ? chalk.hex('#fb923c') : chalk.red;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

async function runLighthouse(url) {
  try {
    const lhModule = require('lighthouse');
    const lighthouse = lhModule.default || lhModule;
    const puppeteer = require('puppeteer');

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    const port = new URL(browser.wsEndpoint()).port;

    const result = await lighthouse(url, {
      port: Number(port),
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: 'desktop',
      screenEmulation: { disabled: true },
      throttling: {
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0
      }
    });

    await browser.close();

    if (result && result.lhr) {
      return result.lhr;
    }
    return null;
  } catch (err) {
    throw new Error(`Lighthouse failed: ${err.message}`);
  }
}

async function runAxeCore(url) {
  try {
    const puppeteer = require('puppeteer');
    const { AxePuppeteer } = require('@axe-core/puppeteer');

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const results = await new AxePuppeteer(page).analyze();

    await browser.close();
    return results;
  } catch (err) {
    throw new Error(`axe-core failed: ${err.message}`);
  }
}
