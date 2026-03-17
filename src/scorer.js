/**
 * Weighted Scoring Algorithm
 * Calculates a 1-100 score from all analyzer results
 */

const path = require('path');
const weights = require(path.join(__dirname, '..', 'data', 'scoring-weights.json'));

function getGrade(score) {
  const rounded = Math.round(score);
  for (const [grade, info] of Object.entries(weights.grades)) {
    if (rounded >= info.min && rounded <= info.max) {
      return { grade, label: info.label, color: info.color };
    }
  }
  return { grade: 'F-', label: 'Critical Issues', color: '#ef4444' };
}

function calculateCategoryScore(checks) {
  if (!checks || checks.length === 0) return { score: 0, passed: 0, failed: 0, warned: 0, total: 0 };

  let totalWeighted = 0;
  let passedWeighted = 0;
  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const check of checks) {
    const sevWeight = weights.severityWeights[check.severity] || 1;
    totalWeighted += sevWeight;

    if (check.status === 'pass') {
      passedWeighted += sevWeight;
      passed++;
    } else if (check.status === 'warn') {
      passedWeighted += sevWeight * 0.5; // warnings count as half
      warned++;
    } else {
      failed++;
    }
  }

  const score = totalWeighted > 0 ? (passedWeighted / totalWeighted) * 100 : 0;

  return {
    score: Math.round(score * 10) / 10,
    passed,
    failed,
    warned,
    total: checks.length
  };
}

function calculateOverallScore(categoryResults) {
  let weightedSum = 0;
  let totalWeight = 0;
  const breakdown = {};

  for (const [category, result] of Object.entries(categoryResults)) {
    const catWeight = weights.categoryWeights[category] || 0;
    const catScore = calculateCategoryScore(result.checks);
    const gradeInfo = getGrade(catScore.score);

    breakdown[category] = {
      ...catScore,
      weight: catWeight,
      weightedScore: catScore.score * catWeight,
      grade: gradeInfo.grade,
      gradeLabel: gradeInfo.label,
      gradeColor: gradeInfo.color,
      label: weights.categoryLabels[category] || category,
      checks: result.checks
    };

    weightedSum += catScore.score * catWeight;
    totalWeight += catWeight;
  }

  // Normalize in case weights don't sum to exactly 1
  const finalScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  const gradeInfo = getGrade(finalScore);

  // Collect top issues (failed checks sorted by severity)
  const allChecks = [];
  for (const [category, result] of Object.entries(categoryResults)) {
    for (const check of (result.checks || [])) {
      allChecks.push({ ...check, category });
    }
  }

  const sevOrder = { critical: 0, major: 1, minor: 2 };
  const topIssues = allChecks
    .filter(c => c.status === 'fail')
    .sort((a, b) => (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2));

  const warnings = allChecks.filter(c => c.status === 'warn');

  // Summary stats
  const totalChecks = allChecks.length;
  const totalPassed = allChecks.filter(c => c.status === 'pass').length;
  const totalFailed = allChecks.filter(c => c.status === 'fail').length;
  const totalWarned = allChecks.filter(c => c.status === 'warn').length;

  return {
    score: finalScore,
    grade: gradeInfo.grade,
    gradeLabel: gradeInfo.label,
    gradeColor: gradeInfo.color,
    breakdown,
    topIssues,
    warnings,
    stats: {
      totalChecks,
      totalPassed,
      totalFailed,
      totalWarned,
      passRate: totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0
    }
  };
}

function generateExecutiveSummary(scoreResult, domain, pageCount) {
  const { score, grade, gradeLabel, breakdown, stats, topIssues } = scoreResult;

  // Find best and worst categories
  const categories = Object.entries(breakdown).sort((a, b) => b[1].score - a[1].score);
  const best = categories[0];
  const worst = categories[categories.length - 1];

  // Count critical issues
  const criticalIssues = topIssues.filter(i => i.severity === 'critical');

  let para1 = `${domain} scored ${score}/100 (${grade} - ${gradeLabel}) based on analysis of ${pageCount} page${pageCount !== 1 ? 's' : ''} across ${stats.totalChecks} data points. `;
  para1 += `Of all checks performed, ${stats.totalPassed} passed (${stats.passRate}%), ${stats.totalFailed} failed, and ${stats.totalWarned} had warnings.`;

  let para2 = `The strongest area is ${best[1].label} with a score of ${best[1].score}/100, `;
  para2 += `while ${worst[1].label} needs the most attention at ${worst[1].score}/100. `;
  if (criticalIssues.length > 0) {
    para2 += `There are ${criticalIssues.length} critical issue${criticalIssues.length !== 1 ? 's' : ''} that should be addressed immediately, `;
    para2 += `including: ${criticalIssues.slice(0, 3).map(i => i.name).join(', ')}.`;
  } else {
    para2 += `No critical issues were found, which is excellent.`;
  }

  let para3 = 'Key recommendations: ';
  const recs = [];
  if (breakdown.performance && breakdown.performance.score < 70) recs.push('optimize page load speed and reduce resource sizes');
  if (breakdown.seo && breakdown.seo.score < 70) recs.push('improve SEO fundamentals (meta tags, headings, structured data)');
  if (breakdown.accessibility && breakdown.accessibility.score < 70) recs.push('fix accessibility violations for WCAG compliance');
  if (breakdown.security && breakdown.security.score < 70) recs.push('strengthen security headers and HTTPS configuration');
  if (breakdown.mobile && breakdown.mobile.score < 70) recs.push('enhance mobile responsiveness and touch usability');
  if (recs.length === 0) recs.push('continue maintaining the high quality across all categories');
  para3 += recs.join('; ') + '.';

  return { para1, para2, para3 };
}

module.exports = { calculateOverallScore, calculateCategoryScore, getGrade, generateExecutiveSummary };
