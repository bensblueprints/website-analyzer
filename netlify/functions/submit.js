const { getBlobStore } = require('./utils/blobs');
const crypto = require('crypto');

function normalizeEmailKey(email) {
  return email.toLowerCase().trim().replace(/[^a-z0-9@._-]/g, '_');
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, url } = body;

  if (!email || !validateEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
  }

  if (!url || !validateUrl(url)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid website URL (include https://)' }) };
  }

  try {
    const leadsStore = getBlobStore('leads');
    const jobsStore = getBlobStore('jobs');
    const emailKey = normalizeEmailKey(email);

    // Check if this email already has a report
    let existingLead = null;
    try {
      const raw = await leadsStore.get(emailKey);
      if (raw) existingLead = JSON.parse(raw);
    } catch {}

    if (existingLead && existingLead.jobId) {
      // Check the job status
      let existingJob = null;
      try {
        const raw = await jobsStore.get(existingLead.jobId);
        if (raw) existingJob = JSON.parse(raw);
      } catch {}

      if (existingJob) {
        if (existingJob.status === 'completed') {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              status: 'already_exists',
              jobId: existingJob.jobId,
              score: existingJob.score,
              grade: existingJob.grade,
              message: 'You have already used your free audit. Here is your existing report.'
            })
          };
        }

        if (existingJob.status === 'processing' || existingJob.status === 'queued') {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              status: 'in_progress',
              jobId: existingJob.jobId,
              message: 'Your analysis is already in progress.'
            })
          };
        }

        // If failed, allow retry — fall through
      }
    }

    // Create new job
    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const jobData = {
      jobId,
      email: email.trim(),
      url: url.trim(),
      status: 'queued',
      score: null,
      grade: null,
      gradeLabel: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    const leadData = {
      email: email.trim(),
      url: url.trim(),
      jobId,
      createdAt: now,
    };

    // Store job and lead
    await jobsStore.set(jobId, JSON.stringify(jobData));
    await leadsStore.set(emailKey, JSON.stringify(leadData));

    // Trigger the background function
    const siteUrl = process.env.URL || process.env.SITE_URL || `https://${event.headers.host}`;
    const bgUrl = `${siteUrl}/.netlify/functions/analyze-background`;

    // Await the fetch — background functions return 202 immediately so this is fast
    try {
      const bgResponse = await fetch(bgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, email: email.trim(), url: url.trim() }),
      });
      console.log(`Background function triggered: ${bgResponse.status}`);
    } catch (err) {
      console.error('Failed to trigger background function:', err.message);
      // Still return success — job is queued, background may retry
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'queued',
        jobId,
        message: 'Analysis started! This usually takes 1-3 minutes.'
      })
    };

  } catch (err) {
    console.error('Submit error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' })
    };
  }
};
