const { getBlobStore } = require('./utils/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobId parameter' }) };
  }

  try {
    const jobsStore = getBlobStore('jobs');
    const raw = await jobsStore.get(jobId);

    if (!raw) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    }

    const job = JSON.parse(raw);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        score: job.score,
        grade: job.grade,
        gradeLabel: job.gradeLabel,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })
    };
  } catch (err) {
    console.error('Status check error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to check status' })
    };
  }
};
