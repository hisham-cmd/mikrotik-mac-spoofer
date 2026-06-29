const logger = require('../utils/logger');
const hotspotAuth = require('./hotspot-auth');
const proxyServer = require('./proxy-server');
const config = require('../../config/default.json');

const POLL_INTERVAL = config.rotation.quotaPollIntervalMs || 15000;
const THRESHOLD_PERCENT = config.rotation.quotaThresholdPercent || 90;

let pollTimer = null;
let isMonitoring = false;
let quotaState = {
  cardLimitBytes: null,
  totalUsedBytes: 0,
  proxyBytes: { download: 0, upload: 0 },
  remainingBytes: null,
  quotaPercent: 0,
  isExhausted: false,
  lastCheck: null,
};

const profileLimits = {
  '100': { transferMB: 400 },
  '200': { transferMB: 800 },
  '250': { transferMB: 1024 },
  '500': { transferMB: 2048 },
  '1500': { transferMB: 6200 },
  '3000': { transferMB: 13312 },
};

let onExhaustedCallback = null;

function getProfileLimit(profileName) {
  const profiles = config.profiles || [];
  const profile = profiles.find(p => p.name === profileName);
  if (profile && profile.transferMB) {
    return profile.transferMB * 1048576;
  }
  return null;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'N/A';
  if (bytes === -1) return 'مفتوح';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, idx)).toFixed(1)} ${units[idx]}`;
}

function parseProfileQuota(username) {
  const num = parseInt(username, 10);
  if (isNaN(num)) return null;
  const configProfiles = config.profiles || [];
  if (configProfiles.length > 0 && configProfiles[1].transferMB) {
    return configProfiles[1].transferMB * 1048576;
  }
  return null;
}

async function checkQuota() {
  try {
    const quotaResult = await hotspotAuth.getRemainingQuota();
    if (!quotaResult.isSuccess) {
      logger.warn('Quota check failed', quotaResult.error);
      return;
    }

    const q = quotaResult.value;
    quotaState.lastCheck = new Date().toISOString();

    if (!q.isLoggedIn) {
      quotaState.isExhausted = true;
      logger.warn('Not logged in - treating as exhausted');
      triggerExhausted('Session ended');
      return;
    }

    if (q.remainBytes !== null) {
      const remainNum = typeof q.remainBytes === 'number' ? q.remainBytes : parseInt(q.remainBytes, 10);
      if (!isNaN(remainNum)) {
        quotaState.remainingBytes = remainNum;
        quotaState.totalUsedBytes = q.totalUsed || 0;

        if (quotaState.cardLimitBytes) {
          const used = Math.max(0, quotaState.cardLimitBytes - remainNum);
          quotaState.totalUsedBytes = used;
          quotaState.quotaPercent = (used / quotaState.cardLimitBytes) * 100;

          if (remainNum <= 0) {
            quotaState.isExhausted = true;
            logger.info(`Quota exhausted (remaining: ${formatBytes(remainNum)})`);
            triggerExhausted('Data quota depleted');
            return;
          }

          if (quotaState.quotaPercent >= THRESHOLD_PERCENT) {
            logger.warn(`Quota threshold reached: ${quotaState.quotaPercent.toFixed(1)}%`);
          }
        }
      }
    }

    const proxyBytes = proxyServer.getBytesTransferred();
    quotaState.proxyBytes.download = proxyBytes.download;
    quotaState.proxyBytes.upload = proxyBytes.upload;

    logger.debug(`Quota: ${formatBytes(quotaState.totalUsedBytes)} / ${formatBytes(quotaState.cardLimitBytes)} (${quotaState.quotaPercent.toFixed(1)}%)`);
  } catch (err) {
    logger.error('Quota check error', err.message);
  }
}

function triggerExhausted(reason) {
  if (onExhaustedCallback) {
    logger.info(`Quota exhausted: ${reason}`);
    onExhaustedCallback({ reason, quotaState: { ...quotaState } });
  }
}

const quotaMonitor = {
  start(cardLimitBytes) {
    if (isMonitoring) return;

    quotaState = {
      cardLimitBytes: cardLimitBytes || null,
      totalUsedBytes: 0,
      proxyBytes: { download: 0, upload: 0 },
      remainingBytes: null,
      quotaPercent: 0,
      isExhausted: false,
      lastCheck: null,
    };

    proxyServer.resetCounters();
    isMonitoring = true;

    pollTimer = setInterval(checkQuota, POLL_INTERVAL);
    checkQuota();
    logger.info(`Quota monitoring started (limit: ${formatBytes(cardLimitBytes)}, poll: ${POLL_INTERVAL}ms)`);
  },

  stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    isMonitoring = false;
    logger.info('Quota monitoring stopped');
  },

  setCardLimit(profileName) {
    const limit = getProfileLimit(profileName);
    if (limit) {
      quotaState.cardLimitBytes = limit;
      logger.info(`Card limit set: ${formatBytes(limit)} (${profileName})`);
    }
    return limit;
  },

  getState() {
    return { ...quotaState, isMonitoring };
  },

  forceCheck() {
    return checkQuota();
  },

  onExhausted(callback) {
    onExhaustedCallback = callback;
  },

  reset() {
    this.stop();
    quotaState = {
      cardLimitBytes: null,
      totalUsedBytes: 0,
      proxyBytes: { download: 0, upload: 0 },
      remainingBytes: null,
      quotaPercent: 0,
      isExhausted: false,
      lastCheck: null,
    };
    proxyServer.resetCounters();
  },

  isRunning() {
    return isMonitoring;
  },

  formatBytes,
};

module.exports = quotaMonitor;
