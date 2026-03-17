const { getBlobStore } = require('./utils/blobs');

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const jobId = event.queryStringParameters?.jobId;
  const format = event.queryStringParameters?.format || 'html';

  if (!jobId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing jobId parameter' })
    };
  }

  try {
    // Check job exists and is completed
    const jobsStore = getBlobStore('jobs');
    const jobRaw = await jobsStore.get(jobId);

    if (!jobRaw) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Report not found' })
      };
    }

    const job = JSON.parse(jobRaw);
    if (job.status !== 'completed') {
      return {
        statusCode: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Report is still being generated', status: job.status })
      };
    }

    if (format === 'pdf') {
      // Serve PDF
      const pdfStore = getBlobStore('reports-pdf');
      const pdfData = await pdfStore.get(jobId, { type: 'arrayBuffer' });

      if (!pdfData) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'PDF report not found' })
        };
      }

      const domain = job.url ? new URL(job.url).hostname : 'website';
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="website-audit-${domain}.pdf"`,
          'Cache-Control': 'public, max-age=86400',
        },
        body: Buffer.from(pdfData).toString('base64'),
        isBase64Encoded: true,
      };
    }

    // Serve HTML report
    const reportsStore = getBlobStore('reports');
    const htmlReport = await reportsStore.get(jobId);

    if (!htmlReport) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'HTML report not found' })
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
      body: htmlReport,
    };

  } catch (err) {
    console.error('Report serve error:', err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to retrieve report' })
    };
  }
};
