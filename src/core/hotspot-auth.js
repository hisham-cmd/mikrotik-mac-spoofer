const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config/default.json');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'data', 'hotspot-config.json');

function ensureDataDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSavedConfig() {
  try {
    ensureDataDir();
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.error('Failed to load saved hotspot config', err.message);
  }
  return null;
}

function saveConfigToDisk(cfg) {
  try {
    ensureDataDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    logger.info('Hotspot config saved to disk');
    return true;
  } catch (err) {
    logger.error('Failed to save hotspot config', err.message);
    return false;
  }
}

const saved = loadSavedConfig();
let currentConfig = saved || {
  url: config.hotspot.url,
  loginEndpoint: config.hotspot.loginEndpoint,
  logoutEndpoint: config.hotspot.logoutEndpoint,
  statusEndpoint: config.hotspot.statusEndpoint,
  usernameField: config.hotspot.usernameField,
  passwordField: config.hotspot.passwordField,
  speedField: config.hotspot.speedField,
  passwordValue: config.hotspot.passwordValue,
  cardAsPassword: config.hotspot.cardAsPassword === true,
  extraParams: config.hotspot.extraParams || {},
};

function reloadConfig() {
  delete require.cache[require.resolve('../../config/default.json')];
  const fresh = require('../../config/default.json');
  currentConfig = {
    url: fresh.hotspot.url,
    loginEndpoint: fresh.hotspot.loginEndpoint,
    logoutEndpoint: fresh.hotspot.logoutEndpoint,
    statusEndpoint: fresh.hotspot.statusEndpoint,
    usernameField: fresh.hotspot.usernameField,
    passwordField: fresh.hotspot.passwordField,
    speedField: fresh.hotspot.speedField,
    passwordValue: fresh.hotspot.passwordValue,
    cardAsPassword: fresh.hotspot.cardAsPassword === true,
    extraParams: fresh.hotspot.extraParams || {},
  };
}

function getConfig() {
  return { ...currentConfig };
}

function updateConfig(updates) {
  if (updates.url !== undefined) currentConfig.url = updates.url;
  if (updates.loginEndpoint !== undefined) currentConfig.loginEndpoint = updates.loginEndpoint;
  if (updates.logoutEndpoint !== undefined) currentConfig.logoutEndpoint = updates.logoutEndpoint;
  if (updates.statusEndpoint !== undefined) currentConfig.statusEndpoint = updates.statusEndpoint;
  if (updates.usernameField !== undefined) currentConfig.usernameField = updates.usernameField;
  if (updates.passwordField !== undefined) currentConfig.passwordField = updates.passwordField;
  if (updates.speedField !== undefined) currentConfig.speedField = updates.speedField;
  if (updates.passwordValue !== undefined) currentConfig.passwordValue = updates.passwordValue;
  if (updates.cardAsPassword !== undefined) currentConfig.cardAsPassword = updates.cardAsPassword === true;
  if (updates.extraParams !== undefined) currentConfig.extraParams = updates.extraParams;
  saveConfigToDisk(currentConfig);
  return true;
}

let activeSession = null;

function buildLoginUrl(username, domain) {
  const baseUrl = `${currentConfig.url.replace('/index.html', '')}${currentConfig.loginEndpoint}`;
  const params = new URLSearchParams();
  if (currentConfig.cardAsPassword) {
    if (currentConfig.passwordField) params.set(currentConfig.passwordField, username);
  } else {
    params.set(currentConfig.usernameField, username);
    params.set(currentConfig.passwordField, currentConfig.passwordValue);
  }
  if (domain !== undefined && domain !== null) {
    params.set(currentConfig.speedField, domain);
  }
  if (currentConfig.extraParams && typeof currentConfig.extraParams === 'object') {
    Object.entries(currentConfig.extraParams).forEach(([k, v]) => params.set(k, v));
  }
  return `${baseUrl}?${params.toString()}`;
}

function parseStatusHtml(html) {
  const result = {
    bytesOut: null,
    bytesIn: null,
    remainBytes: null,
    uptime: null,
    sessionTimeLeft: null,
    isLoggedIn: false,
  };

  if (!html || html.length < 50) return result;

  const bytesOutMatch = html.match(/id="bytes_out"[^>]*>([^<]*)</);
  if (bytesOutMatch) result.bytesOut = bytesOutMatch[1].trim();

  const bytesInMatch = html.match(/id="bytes_in"[^>]*>([^<]*)</);
  if (bytesInMatch) result.bytesIn = bytesInMatch[1].trim();

  const remainMatch = html.match(/id="remain_bytes_total"[^>]*>([^<]*)</);
  if (remainMatch) result.remainBytes = remainMatch[1].trim();

  const uptimeMatch = html.match(/id="uptime"[^>]*>([^<]*)</);
  if (uptimeMatch) result.uptime = uptimeMatch[1].trim();

  const timeLeftMatch = html.match(/id="session_time_left"[^>]*>([^<]*)</);
  if (timeLeftMatch) result.sessionTimeLeft = timeLeftMatch[1].trim();

  const titleMatch = html.match(/id="status-title"[^>]*>([^<]*)</);
  if (titleMatch) {
    result.isLoggedIn = titleMatch[1].includes('تم تسجيل') || titleMatch[1].includes('success');
  }

  const sspeedMatch = html.match(/id="sspeed"[^>]*>([^<]*)</);
  if (sspeedMatch) result.speed = sspeedMatch[1].trim();

  return result;
}

function parseBytesString(str) {
  if (!str) return null;
  const cleaned = str.trim().toLowerCase();
  const match = cleaned.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2] || 'b';
  const multipliers = { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776 };
  return Math.round(value * (multipliers[unit] || 1));
}

const HOTSPOT_CANDIDATES = [
  { url: 'http://{gateway}/', type: 'gateway-root' },
  { url: 'http://{gateway}/index.html', type: 'gateway' },
  { url: 'http://{gateway}/login', type: 'gateway-login' },
  { url: 'http://{gateway}/status', type: 'gateway-status' },
  { url: 'http://{gateway}/hotspotlogin', type: 'gateway-hotspot' },
  { url: 'http://{gateway}/hotspotlogin', type: 'gateway-hotspot-alt' },
  { url: 'http://{gateway}/hslogin', type: 'gateway-hslogin' },
  { url: 'http://{gateway}/hotspot', type: 'gateway-hotspot-page' },
  { url: 'http://{gateway}/hs/', type: 'gateway-hs-dir' },
  { url: 'http://m.net/', type: 'm.net' },
  { url: 'http://m.net/index.html', type: 'm.net-index' },
  { url: 'http://m.net/login', type: 'm.net-login' },
  { url: 'http://www.h.net/', type: 'www.h.net' },
  { url: 'http://www.h.net/index.html', type: 'www.h.net-index' },
  { url: 'http://s.net/', type: 's.net' },
  { url: 'http://s.gov/', type: 's.gov' },
  { url: 'http://10.0.0.1/', type: 'common-gw1' },
  { url: 'http://192.168.1.1/', type: 'common-gw2' },
  { url: 'http://192.168.0.1/', type: 'common-gw3' },
  { url: 'http://172.16.0.1/', type: 'common-gw4' },
];

async function tryUrl(url) {
  try {
    const resp = await axios.get(url, { timeout: 5000, maxRedirects: 3, validateStatus: () => true, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    return { url, status: resp.status, size: html.length, html, ok: html.length > 10 };
  } catch (err) {
    return { url, status: 0, size: 0, html: '', ok: false, error: err.message };
  }
}

async function tryDetectHotspot(gatewayIp) {
  const results = [];
  const candidates = HOTSPOT_CANDIDATES.map(c => ({ ...c, url: c.url.replace('{gateway}', gatewayIp || '') }));
  await Promise.allSettled(candidates.map(candidate =>
    axios.get(candidate.url, {
      timeout: 5000, maxRedirects: 3, validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }).then(resp => {
      let html = '';
      try { html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data); } catch { html = ''; }
      if (html && html.length > 60) {
        const hasLogin = html.includes('username') || html.includes('password') || html.includes('تسجيل') || html.includes('login');
        results.push({ url: candidate.url, status: resp.status, size: html.length, html, hasLogin });
      }
    }).catch(() => {})
  ));
  for (const r of results) {
    if (r.html.includes('remain_bytes_total') || r.html.includes('تم تسجيل') || r.html.includes('status.html')) {
      return { found: true, url: r.url, sessionActive: true };
    }
  }
  if (results.length > 0) {
    const best = results.sort((a, b) => b.size - a.size)[0];
    return { found: true, url: best.url, sessionActive: false };
  }
  return { found: false, url: null, results: results.length };
}

const hotspotAuth = {
  getConfig() {
    return getConfig();
  },

  updateConfig(updates) {
    return updateConfig(updates);
  },

  saveConfigToDisk() {
    return saveConfigToDisk(currentConfig);
  },

  async detectAndSetUrl(gatewayIp) {
    const cfgUrl = currentConfig.url;
    if (cfgUrl && cfgUrl !== 'http://' && cfgUrl !== 'https://') {
      logger.info(`Trying configured URL first: ${cfgUrl}`);
      const result = await tryUrl(cfgUrl);
      if (result.ok && result.html.length > 50) {
        const sessionActive = result.html.includes('remain_bytes_total') || result.html.includes('تم تسجيل') || result.html.includes('status.html');
        logger.info(`Configured URL works: ${cfgUrl} (${result.size}b, status ${result.status})`);
        return { found: true, url: cfgUrl, sessionActive };
      }
      logger.warn(`Configured URL failed: ${result.error || 'response too small (' + result.size + 'b)'}`);
    }

    const detected = await tryDetectHotspot(gatewayIp);
    if (detected.found) {
      const baseUrl = detected.url.replace('/index.html', '').replace('/hotspotlogin', '');
      currentConfig.url = detected.url;
      logger.info(`Hotspot URL auto-detected: ${detected.url}`);
      return detected;
    }
    logger.warn(`No hotspot URL detected (${gatewayIp ? 'gateway: ' + gatewayIp : 'no gateway'})`);
    return detected;
  },

  async login(username, domain) {
    if (!username || !username.toString().trim()) {
      return { isSuccess: false, value: null, error: 'Card number is required', statusCode: 400 };
    }

    const loginUrl = buildLoginUrl(username.toString().trim(), domain);
    logger.info(`Logging into hotspot: ${loginUrl.replace(username, '****')}`);

    try {
      const response = await axios.get(loginUrl, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: status => status < 500,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (response.status >= 400) {
        logger.warn(`Login HTTP ${response.status} for ${loginUrl.replace(username, '****')}`);
        return { isSuccess: false, value: null, error: `Server returned ${response.status}`, statusCode: response.status };
      }

      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const status = parseStatusHtml(html);
      const bodySnippet = html ? html.substring(0, 200).replace(/\n/g, ' ').trim() : '(فارغ)';

      logger.info(`Login response: HTTP ${response.status} (${html.length}b) snippet: ${bodySnippet}`);

      const sessionAlreadyActive = html.includes('remain_bytes_total') || html.includes('تم تسجيل') || html.includes('status.html');
      const isLoginPage = (html.includes('username') || html.includes('password') || html.includes('تسجيل الدخول') || html.includes('login')) && html.length < 5000;
      const isBlocked = html.includes('محظور') || html.includes('block') || html.includes('blocked');
      const isError = html.includes('خطأ') || html.includes('incorrect') || html.includes('wrong');

      if (sessionAlreadyActive) {
        activeSession = { username: username.toString().trim(), domain, loginTime: new Date().toISOString(), status };
        logger.info(`Login successful — جلسة موجودة مسبقاً للـ MAC`);
        return { isSuccess: true, value: { session: activeSession, status, note: 'session-already-active' }, error: null, statusCode: 200 };
      }

      if (isBlocked) {
        return { isSuccess: false, value: null, error: 'IP is blocked due to too many failed attempts', statusCode: 403 };
      }

      if (isError) {
        return { isSuccess: false, value: null, error: 'Invalid card number', statusCode: 401 };
      }

      if (isLoginPage) {
        logger.warn(`Login فشل — الهوتسبوت أعاد صفحة تسجيل الدخول (الكرت غير صالح)`);
        return { isSuccess: false, value: null, error: 'Login page returned — invalid credentials', statusCode: 401 };
      }

      logger.warn(`Login فشل — رد غير متوقع (${html.length}b)`, bodySnippet);
      return { isSuccess: false, value: null, error: `Unexpected response (${html.length}b)`, statusCode: 500 };
    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        return { isSuccess: false, value: null, error: 'Connection timeout - hotspot not reachable', statusCode: 504 };
      }
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        return { isSuccess: false, value: null, error: 'Hotspot not reachable - check WiFi connection', statusCode: 503 };
      }
      logger.error('Login request failed', err.message);
      return { isSuccess: false, value: null, error: `Login failed: ${err.message}`, statusCode: 500 };
    }
  },

  async logout() {
    const baseUrl = currentConfig.url.replace('/index.html', '');
    const logoutUrl = `${baseUrl}${currentConfig.logoutEndpoint}`;

    try {
      await axios.get(logoutUrl, { timeout: 10000, validateStatus: () => true });
      activeSession = null;
      logger.info('Logged out of hotspot');
      return { isSuccess: true, value: null, error: null, statusCode: 200 };
    } catch (err) {
      logger.error('Logout failed', err.message);
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async checkStatus() {
    const statusUrl = currentConfig.url.replace('/index.html', currentConfig.statusEndpoint || '/status');

    try {
      const response = await axios.get(statusUrl, {
        timeout: 10000,
        validateStatus: status => status < 500,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const status = parseStatusHtml(html);

      if (status.isLoggedIn) {
        return { isSuccess: true, value: { isLoggedIn: true, status }, error: null, statusCode: 200 };
      }

      if (html.includes('login') || html.includes('تسجيل')) {
        return { isSuccess: true, value: { isLoggedIn: false, status: null }, error: null, statusCode: 200 };
      }

      return { isSuccess: true, value: { isLoggedIn: status.isLoggedIn, status }, error: null, statusCode: 200 };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async getRemainingQuota() {
    const statusResult = await this.checkStatus();
    if (!statusResult.isSuccess) {
      return { isSuccess: false, value: null, error: statusResult.error, statusCode: statusResult.statusCode };
    }

    const status = statusResult.value.status;
    if (!status) {
      return { isSuccess: true, value: { isLoggedIn: false }, error: null, statusCode: 200 };
    }

    const remainBytes = parseBytesString(status.remainBytes);
    const bytesOut = parseBytesString(status.bytesOut);
    const bytesIn = parseBytesString(status.bytesIn);

    return {
      isSuccess: true,
      value: {
        isLoggedIn: status.isLoggedIn,
        remainBytes,
        bytesOut,
        bytesIn,
        totalUsed: bytesOut !== null && bytesIn !== null ? bytesOut + bytesIn : null,
        uptime: status.uptime,
        sessionTimeLeft: status.sessionTimeLeft,
        speed: status.speed,
      },
      error: null,
      statusCode: 200,
    };
  },

  getActiveSession() {
    return activeSession ? { ...activeSession } : null;
  },

  clearSession() {
    activeSession = null;
  },

  async testLogin(username, domain, testConfig) {
    if (!username || !username.toString().trim()) {
      return { isSuccess: false, value: null, error: 'Card number is required', statusCode: 400 };
    }

    const savedConfig = { ...currentConfig };
    if (testConfig) {
      if (testConfig.url !== undefined) currentConfig.url = testConfig.url;
      if (testConfig.loginEndpoint !== undefined) currentConfig.loginEndpoint = testConfig.loginEndpoint;
      if (testConfig.usernameField !== undefined) currentConfig.usernameField = testConfig.usernameField;
      if (testConfig.passwordField !== undefined) currentConfig.passwordField = testConfig.passwordField;
      if (testConfig.passwordValue !== undefined) currentConfig.passwordValue = testConfig.passwordValue;
      if (testConfig.cardAsPassword !== undefined) currentConfig.cardAsPassword = testConfig.cardAsPassword === true;
      if (testConfig.extraParams !== undefined) currentConfig.extraParams = testConfig.extraParams;
    }

    try {
      const loginUrl = buildLoginUrl(username.toString().trim(), domain);
      logger.info(`Test login: ${loginUrl.replace(username, '****')}`);

      const startTime = Date.now();
      const response = await axios.get(loginUrl, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const elapsed = Date.now() - startTime;

      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const responseInfo = {
        status: response.status,
        statusText: response.statusText,
        time: elapsed,
        size: html.length,
        contentType: response.headers['content-type'] || '',
        headers: response.headers || {},
        body: html.substring(0, 5000),
        bodyPreview: html.substring(0, 500),
        isLoggedIn: html.includes('تم تسجيل') || html.includes('status.html') || html.includes('remain_bytes_total'),
        isLoginPage: html.includes('username') || html.includes('password') || html.includes('تسجيل الدخول'),
        isBlocked: html.includes('محظور') || html.includes('blocked'),
        loginUrl: loginUrl.replace(username, '****'),
      };

      return {
        isSuccess: true,
        value: responseInfo,
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      return {
        isSuccess: true,
        value: {
          status: 0,
          statusText: 'ERROR',
          time: 0,
          size: 0,
          contentType: '',
          headers: {},
          body: '',
          bodyPreview: '',
          isLoggedIn: false,
          isLoginPage: false,
          isBlocked: false,
          error: err.message,
          loginUrl: buildLoginUrl(username.toString().trim(), domain).replace(username, '****'),
        },
        error: null,
        statusCode: 200,
      };
    } finally {
      if (testConfig) {
        Object.assign(currentConfig, savedConfig);
      }
    }
  },
};

module.exports = hotspotAuth;
