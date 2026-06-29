const { execFile } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');

const DISCONNECT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'disconnect-target.ps1');
let activeDisconnect = null;

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...args,
    ];
    execFile('powershell.exe', params, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err && !activeDisconnect) {
        reject(new Error(`PowerShell error: ${err.message}`));
        return;
      }
      try {
        if (stdout && stdout.trim()) {
          const result = JSON.parse(stdout.trim());
          resolve(result);
          return;
        }
      } catch {}
      reject(new Error(stderr || 'Unknown error'));
    });
  });
}

function parseArpTable(output) {
  const lines = output.split('\n');
  const entries = [];
  for (const line of lines) {
    const clean = line.replace(/\s+/g, ' ').trim();
    const parts = clean.split(' ');
    if (parts.length >= 3 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) {
      entries.push({
        ip: parts[0],
        mac: parts[1].toUpperCase(),
        type: parts[2].toLowerCase(),
      });
    }
  }
  return entries;
}

const arpSpoofer = {
  async poisonTarget(targetIp, targetMac, durationSeconds = 30) {
    if (activeDisconnect) {
      return { isSuccess: false, value: null, error: 'Already poisoning a target. Stop first.', statusCode: 409 };
    }

    logger.info(`Starting ARP poison on ${targetIp} for ${durationSeconds}s`);

    activeDisconnect = { targetIp, targetMac, startTime: new Date().toISOString() };

    try {
      const result = await runPowerShell(DISCONNECT_SCRIPT, [
        '-TargetIp', targetIp,
        '-TargetMac', targetMac,
        '-DurationSeconds', durationSeconds.toString(),
      ]);

      activeDisconnect = null;

      if (result.success) {
        logger.info(`ARP poison completed: ${targetIp}`);
        return {
          isSuccess: true,
          value: { targetIp, targetMac, durationSeconds, methods: result.methods, gatewayIp: result.gatewayIp },
          error: null,
          statusCode: 200,
        };
      }
      return { isSuccess: false, value: null, error: result.error || 'ARP poison failed', statusCode: 500 };
    } catch (err) {
      activeDisconnect = null;
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async poisonAndWait(targetIp, targetMac, timeoutMs = 15000) {
    const result = await this.poisonTarget(targetIp, targetMac, Math.ceil(timeoutMs / 1000));
    return result;
  },

  stopPoison() {
    activeDisconnect = null;
    logger.info('ARP poison stopped');
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },

  async clearArpCache() {
    try {
      await new Promise((resolve, reject) => {
        execFile('netsh', ['interface', 'ip', 'delete', 'arpcache'], { timeout: 10000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info('ARP cache cleared');
      return { isSuccess: true, value: null, error: null, statusCode: 200 };
    } catch (err) {
      logger.warn('Failed to clear ARP cache', err.message);
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async getArpTable() {
    return new Promise((resolve) => {
      execFile('arp', ['-a'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ isSuccess: false, value: null, error: err.message, statusCode: 500 });
          return;
        }
        const entries = parseArpTable(stdout);
        resolve({ isSuccess: true, value: entries, error: null, statusCode: 200 });
      });
    });
  },

  async addStaticEntry(ip, mac) {
    try {
      const macDashed = mac.replace(/:/g, '-');
      await new Promise((resolve, reject) => {
        execFile('arp', ['-s', ip, macDashed], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return { isSuccess: true, value: { ip, mac }, error: null, statusCode: 200 };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async deleteEntry(ip) {
    try {
      await new Promise((resolve, reject) => {
        execFile('arp', ['-d', ip], { timeout: 5000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return { isSuccess: true, value: null, error: null, statusCode: 200 };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  isActive() {
    return activeDisconnect !== null;
  },

  getStatus() {
    if (activeDisconnect) {
      return { active: true, ...activeDisconnect };
    }
    return { active: false };
  },
};

module.exports = arpSpoofer;
