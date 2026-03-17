'use strict';

const { getStore } = require('@netlify/blobs');
const { Resend } = require('resend');
const { buildReportEmail } = require('./utils/email-templates');

const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_TqppzRWt_LdZL9X1dzPPB4bpS4riMeNHV';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Website Auditor <noreply@advancedmarketing.co>';

async function updateJob(jobsStore, jobId, updates) {
  let job = {};
  try {
    const raw = await jobsStore.get(jobId);
    if (raw) job = JSON.parse(raw);
  } catch {}
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  await jobsStore.set(jobId, JSON.stringify(job));
  return job;
}

exports.handler = async (event) => {
  // Background functions receive the POST body and run asynchronously
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    console.error('Invalid body in background function');
    return { statusCode: 400 };
  }

  const { jobId, email, url } = body;
  if (!jobId || !email || !url) {
    console.error('Missing required fields:', { jobId, email, url });
    return { statusCode: 400 };
  }

  const jobsStore = getStore('jobs');
  const reportsStore = getStore('reports');
  const pdfStore = getStore('reports-pdf');

  try {
    // Mark as processing
    await updateJob(jobsStore, jobId, { status: 'processing' });
    console.log(`[${jobId}] Starting analysis for ${url}`);

    // Run the full analysis
    const { runFullAnalysis } = require('./utils/analyzer-adapter');
    const startTime = Date.now();
    const result = await runFullAnalysis(url);
    const duration = Date.now() - startTime;

    console.log(`[${jobId}] Analysis complete in ${(duration / 1000).toFixed(1)}s — Score: ${result.score}/100 (${result.grade})`);

    // Store HTML report
    await reportsStore.set(jobId, result.reportHtml);

    // Store PDF report
    if (result.pdfBuffer) {
      await pdfStore.set(jobId, result.pdfBuffer);
    }

    // Build report URL
    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://website-auditor-am.netlify.app';
    const reportUrl = `${siteUrl}/report.html?jobId=${jobId}&score=${result.score}&grade=${encodeURIComponent(result.grade)}`;

    // Update job as completed
    await updateJob(jobsStore, jobId, {
      status: 'completed',
      score: result.score,
      grade: result.grade,
      gradeLabel: result.gradeLabel,
      reportUrl,
    });

    // Send email with report
    try {
      const domain = new URL(url).hostname;
      const resend = new Resend(RESEND_API_KEY);

      const emailHtml = buildReportEmail({
        domain,
        score: result.score,
        grade: result.grade,
        gradeLabel: result.gradeLabel,
        topIssues: result.scoreResult.topIssues,
        reportUrl,
        breakdown: result.scoreResult.breakdown,
      });

      const emailPayload = {
        from: FROM_EMAIL,
        to: [email],
        subject: `Your Website Audit: ${domain} scored ${result.score}/100 (${result.grade})`,
        html: emailHtml,
      };

      // Attach PDF if available
      if (result.pdfBuffer) {
        emailPayload.attachments = [{
          filename: `website-audit-${domain}.pdf`,
          content: result.pdfBuffer.toString('base64'),
        }];
      }

      await resend.emails.send(emailPayload);
      console.log(`[${jobId}] Report email sent to ${email}`);
    } catch (emailErr) {
      console.error(`[${jobId}] Email send failed:`, emailErr.message);
      // Don't fail the job — report is still stored and viewable
    }

    return { statusCode: 200 };

  } catch (err) {
    console.error(`[${jobId}] Analysis failed:`, err);

    await updateJob(jobsStore, jobId, {
      status: 'failed',
      error: err.message || 'Analysis failed unexpectedly',
    });

    return { statusCode: 500 };
  }
};
