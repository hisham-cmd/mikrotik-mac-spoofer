const { execFile } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config/default.json');

const SPOOF_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'spoof-mac.ps1');
const RESET_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reset-mac.ps1');
const INFO_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'get-wifi-info.ps1');
const INFO_TIMEOUT = 30000;
const RETRY_COUNT = config.network.spoofRetryCount || 3;
const RECONNECT_DELAY = config.network.reconnectDelay || 3000;
const MAC_PREFIX = config.network.macPrefix || '00:1A:2B';

const SCRIPT_TIMEOUTS = {
  spoof: 120000,
  reset: 90000,
  info: 40000,
};

function getScriptType(args) {
  const first = (args && args[0]) || '';
  if (first === '-NewMac') return 'spoof';
  if (args && args.some(a => a === '-AdapterName')) return 'reset';
  return 'info';
}

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args,
    ];
    const scriptType = getScriptType(args);
    const timeout = SCRIPT_TIMEOUTS[scriptType] || 60000;
    execFile('powershell.exe', params, { timeout }, (err, stdout, stderr) => {
      if (err) {
        const stderrStr = (stderr || '').trim().slice(0, 500);
        const stdoutStr = (stdout || '').trim().slice(0, 200);
        reject(new Error(`PowerShell error: ${err.message} | stderr: ${stderrStr || '(empty)'} | stdout: ${stdoutStr || '(empty)'}`));
        return;
      }
      if (stderr && stderr.trim()) {
        logger.warn('PowerShell stderr', stderr.trim().slice(0, 500));
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (parseErr) {
        reject(new Error(`Failed to parse PowerShell output: ${parseErr.message} | raw: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

function generateMac() {
  const prefix = MAC_PREFIX.replace(/[-:]/g, '');
  const suffix = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  const full = (prefix + suffix).substring(0, 12);
  return (full.match(/.{2}/g) || []).join(':').toUpperCase();
}

function validateMac(mac) {
  return /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac);
}

const wifiManager = {
  async getAdapterInfo() {
    try {
      const result = await runPowerShell(INFO_SCRIPT, []);
      if (result.success && result.adapter) {
        return result.adapter;
      }
      throw new Error(result.error || 'Failed to get adapter info');
    } catch (err) {
      logger.warn('getAdapterInfo PS failed, trying netsh fallback', err.message);
      try {
        const quick = await this.quickCheck();
        if (quick) {
          return {
            name: 'Wi-Fi',
            macAddress: quick.macAddress,
            ssid: quick.ssid,
            status: quick.state,
            availableNetworks: [],
            linkSpeed: null,
          };
        }
      } catch {}
      throw err;
    }
  },

  async getCurrentMac() {
    try {
      const info = await this.getAdapterInfo();
      return info.macAddress || null;
    } catch {
      return null;
    }
  },

  async spoofMac(mac, options = {}) {
    const targetMac = mac || generateMac();
    if (!validateMac(targetMac)) {
      throw new Error(`Invalid MAC address: ${targetMac}`);
    }

    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
      try {
        logger.info(`Spoofing MAC (attempt ${attempt}/${RETRY_COUNT}): ${targetMac}`);
        const args = ['-NewMac', targetMac];
        if (options.noLaaFix) args.push('-NoLaaFix');
        const result = await runPowerShell(SPOOF_SCRIPT, args);
        if (result.success) {
          logger.info(`MAC spoofed: ${result.oldMac} -> ${result.newMac}`);
          await this._waitForConnection(RECONNECT_DELAY);
          const ret = { oldMac: result.oldMac, newMac: result.newMac };
          if (result.warning) {
            logger.warn('MAC spoof warning', result.warning);
            ret.warning = result.warning;
          }
          return ret;
        }
        throw new Error(result.error || 'Spoof failed');
      } catch (err) {
        logger.warn(`Spoof attempt ${attempt} failed`, err.message);
        if (attempt < RETRY_COUNT) {
          await new Promise(r => setTimeout(r, 5000));
        } else {
          throw new Error(`MAC spoofing failed after ${RETRY_COUNT} attempts: ${err.message}`);
        }
      }
    }
  },

  async restoreMac(mac) {
    if (!mac) return;
    try {
      await this.spoofMac(mac);
      logger.info('MAC restored', mac);
    } catch (err) {
      logger.error('Failed to restore MAC', err.message);
    }
  },

  async resetMac() {
    try {
      let adapterName = '';
      try {
        const info = await this.getAdapterInfo();
        adapterName = (info && info.name) || '';
      } catch (e) {
        logger.warn('Could not get adapter info for reset, proceeding without adapter name', e.message);
      }
      logger.info('Resetting MAC to original hardware address');
      const result = await runPowerShell(RESET_SCRIPT, [
        '-AdapterName', adapterName,
      ]);
      if (result.success) {
        logger.info(`MAC reset: ${result.oldMac} -> ${result.newMac}`);
        await this._waitForConnection(RECONNECT_DELAY);
        return { oldMac: result.oldMac, newMac: result.newMac };
      }
      throw new Error(result.error || 'Reset failed');
    } catch (err) {
      logger.error('MAC reset failed', err.message);
      throw new Error(`MAC reset failed: ${err.message}`);
    }
  },

  generateRandomMac() {
    return generateMac();
  },

  async quickCheck() {
    return new Promise((resolve, reject) => {
      execFile('netsh', ['wlan', 'show', 'interfaces'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ connected: false, error: err.message });
          return;
        }
        const ssidMatch = stdout.match(/^\s+SSID\s*:\s*(.+)$/m);
        const stateMatch = stdout.match(/^\s+State\s*:\s*(.+)$/m);
        const macMatch = stdout.match(/^\s+Physical address\(MAC\)\s*:\s*(.+)$/m);
        const connected = stateMatch && stateMatch[1].trim() === 'connected';
        resolve({
          connected,
          ssid: connected && ssidMatch ? ssidMatch[1].trim() : null,
          macAddress: macMatch ? macMatch[1].trim().replace(/-/g, ':') : null,
          state: stateMatch ? stateMatch[1].trim() : 'unknown',
        });
      });
    });
  },

  async getConnectedSsid() {
    try {
      const info = await this.getAdapterInfo();
      return info.ssid || null;
    } catch {
      return null;
    }
  },

  async _waitForConnection(delayMs) {
    await new Promise(r => setTimeout(r, delayMs));
    const maxRetries = 20;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const quick = await this.quickCheck();
        if (quick.connected && quick.ssid) {
          logger.info(`Connected to ${quick.ssid}`);
          return;
        }
      } catch {}
      if (i === 5 || i === 10) {
        try {
          const ps = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', '(Get-NetAdapter -Name \"Wi-Fi\").Status'], { timeout: 3000, encoding: 'utf-8', stdio: 'pipe' });
          if (ps.trim() === 'Up' || ps.trim() === 'Disconnected') {
            logger.info('WiFi adapter is active, proceeding');
            return;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    logger.warn('WiFi connection not confirmed after delay');
  },
};

module.exports = wifiManager;
