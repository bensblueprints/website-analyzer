'use strict';

const { getStore } = require('@netlify/blobs');

const SITE_ID = process.env.SITE_ID || 'fb0ffdfa-37d4-442b-8826-c4027fdc1bda';
const TOKEN = process.env.NETLIFY_API_TOKEN;

function getBlobStore(name) {
  if (TOKEN) {
    return getStore({ name, siteID: SITE_ID, token: TOKEN });
  }
  // Fall back to auto-detection (works during Netlify builds)
  return getStore(name);
}

module.exports = { getBlobStore };
