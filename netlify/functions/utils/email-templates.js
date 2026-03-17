'use strict';

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getScoreColor(score) {
  if (score >= 90) return '#22c55e';
  if (score >= 80) return '#4ade80';
  if (score >= 70) return '#a3e635';
  if (score >= 60) return '#facc15';
  if (score >= 50) return '#fb923c';
  return '#ef4444';
}

function buildReportEmail({ domain, score, grade, gradeLabel, topIssues, reportUrl, breakdown }) {
  const scoreColor = getScoreColor(score);

  // Top 5 issues as HTML rows
  let issueRows = '';
  const issues = (topIssues || []).slice(0, 5);
  for (const issue of issues) {
    const sevColor = issue.severity === 'critical' ? '#ef4444' : issue.severity === 'major' ? '#f97316' : '#eab308';
    issueRows += `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;text-transform:uppercase;color:${sevColor};background-color:${sevColor}15;">${escapeHtml(issue.severity)}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;">${escapeHtml(issue.name)}</td>
      </tr>`;
  }

  // Category scores
  let categoryRows = '';
  if (breakdown) {
    for (const [key, cat] of Object.entries(breakdown)) {
      const barWidth = Math.max(2, Math.min(100, Math.round(cat.score)));
      categoryRows += `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#475569;width:160px;">${escapeHtml(cat.label || key)}</td>
          <td style="padding:6px 0;">
            <div style="background:#f1f5f9;border-radius:4px;height:18px;width:100%;">
              <div style="background:${escapeHtml(cat.gradeColor)};border-radius:4px;height:18px;width:${barWidth}%;"></div>
            </div>
          </td>
          <td style="padding:6px 8px;font-size:14px;font-weight:700;color:${escapeHtml(cat.gradeColor)};text-align:right;width:50px;">${Math.round(cat.score)}</td>
        </tr>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1e293b,#0f172a);border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:14px;color:#94a3b8;letter-spacing:0.05em;text-transform:uppercase;">Website Auditor</p>
          <h1 style="margin:0 0 8px;font-size:24px;color:#f8fafc;font-weight:700;">Your Website Report is Ready</h1>
          <p style="margin:0;font-size:15px;color:#94a3b8;">${escapeHtml(domain)}</p>
        </td></tr>

        <!-- Score -->
        <tr><td style="background:#ffffff;padding:32px 40px;text-align:center;border-bottom:1px solid #f1f5f9;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td style="text-align:center;">
                <div style="display:inline-block;width:120px;height:120px;border-radius:50%;border:8px solid ${scoreColor};text-align:center;line-height:104px;">
                  <span style="font-size:44px;font-weight:800;color:${scoreColor};letter-spacing:-2px;">${score}</span>
                </div>
                <p style="margin:12px 0 0;font-size:13px;color:#64748b;">out of 100</p>
                <p style="margin:8px 0 0;">
                  <span style="display:inline-block;padding:4px 16px;border-radius:16px;background:${scoreColor};color:#ffffff;font-size:14px;font-weight:700;">${escapeHtml(grade)} &mdash; ${escapeHtml(gradeLabel)}</span>
                </p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Category Breakdown -->
        ${categoryRows ? `
        <tr><td style="background:#ffffff;padding:24px 40px;border-bottom:1px solid #f1f5f9;">
          <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b;">Category Scores</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${categoryRows}
          </table>
        </td></tr>` : ''}

        <!-- Top Issues -->
        ${issueRows ? `
        <tr><td style="background:#ffffff;padding:24px 40px;border-bottom:1px solid #f1f5f9;">
          <h2 style="margin:0 0 16px;font-size:16px;color:#1e293b;">Top Issues to Fix</h2>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${issueRows}
          </table>
          ${issues.length < (topIssues || []).length ? `<p style="font-size:13px;color:#94a3b8;margin:12px 0 0;font-style:italic;">...and ${(topIssues || []).length - issues.length} more issues in your full report</p>` : ''}
        </td></tr>` : ''}

        <!-- CTA -->
        <tr><td style="background:#ffffff;padding:32px 40px;text-align:center;">
          <a href="${escapeHtml(reportUrl)}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#ffffff;text-decoration:none;border-radius:8px;font-size:16px;font-weight:700;letter-spacing:0.02em;">View Full Report</a>
          <p style="margin:16px 0 0;font-size:13px;color:#94a3b8;">Your detailed PDF report is also attached to this email.</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 4px;font-size:13px;color:#94a3b8;">Powered by <strong style="color:#64748b;">Website Auditor</strong> by <strong style="color:#64748b;">Advanced Marketing</strong></p>
          <p style="margin:0;font-size:12px;color:#cbd5e1;">
            <a href="https://advancedmarketing.co" style="color:#3b82f6;text-decoration:none;">advancedmarketing.co</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { buildReportEmail };
