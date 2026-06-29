const { execFile } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const MikrotikApi = require('./mikrotik-api');
const config = require('../../config/default.json');

const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-network.ps1');
const FALLBACK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-fallback.ps1');

const VENDOR_DB = {
  '00:1A:2B': 'MikroTik',
  '00:0C:42': 'MikroTik',
  '4C:5E:0C': 'MikroTik',
  '64:D1:54': 'MikroTik',
  'E4:5D:51': 'MikroTik',
  '74:4D:28': 'MikroTik',
  'DC:2C:6E': 'MikroTik',
  '00:50:8D': 'TP-Link',
  '14:CF:35': 'TP-Link',
  '98:DA:C4': 'TP-Link',
  '50:C7:BF': 'TP-Link',
  'EC:17:2F': 'TP-Link',
  '1C:3B:F3': 'TP-Link',
  'F4:EC:38': 'TP-Link',
  '00:1D:7E': 'Cisco',
  '00:1A:A1': 'Cisco',
  '00:14:5C': 'Cisco',
  '8C:85:90': 'Intel',
  '00:1B:21': 'Intel',
  '3C:97:0E': 'Intel',
  'F0:7B:CB': 'Samsung',
  '00:23:D4': 'Samsung',
  '58:CB:52': 'Huawei',
  '9C:28:BF': 'Huawei',
  '48:7A:DA': 'Huawei',
  'AC:1F:6B': 'Xiaomi',
  '98:48:27': 'Xiaomi',
  '24:46:C8': 'Xiaomi',
  'B0:75:D5': 'OnePlus',
  '04:4B:ED': 'Oppo',
  'A0:CE:C8': 'Nokia',
  '30:07:4D': 'LG',
  '64:BC:0C': 'HMD/Nokia',
  '18:AF:8F': 'Sony',
  '30:52:CB': 'Honor',
  '9C:FC:E8': 'Apple',
  'B8:E8:56': 'Apple',
  'A4:D1:D2': 'Apple',
  '00:0A:27': 'Apple',
  '00:1B:63': 'Apple',
  '00:1E:C2': 'Apple',
  '00:1F:5B': 'Apple',
  '00:21:E9': 'Apple',
  '00:22:41': 'Apple',
  '00:23:32': 'Apple',
  '00:23:DF': 'Apple',
  '00:24:36': 'Apple',
  '00:25:00': 'Apple',
  '00:25:4B': 'Apple',
  '00:25:BC': 'Apple',
  '00:26:08': 'Apple',
  '00:26:4A': 'Apple',
  '00:26:B0': 'Apple',
  '00:27:0E': 'Apple',
  '00:27:F0': 'Apple',
  '00:28:F8': 'Apple',
  '40:6C:8F': 'Apple',
  '44:D8:84': 'Apple',
  '48:43:7C': 'Apple',
  '54:9B:12': 'Apple',
  '60:30:D4': 'Apple',
  '60:F2:62': 'Apple',
  '64:76:BA': 'Apple',
  '68:5B:35': 'Apple',
  '68:A0:3E': 'Apple',
  '6C:72:E7': 'Apple',
  '70:14:A6': 'Apple',
  '78:31:C1': 'Apple',
  '80:BE:05': 'Apple',
  '84:38:35': 'Apple',
  '8C:7B:9D': 'Apple',
  '90:84:0D': 'Apple',
  '98:01:A7': 'Apple',
  '98:FE:94': 'Apple',
  'A4:5E:60': 'Apple',
  'A8:4E:3F': 'Apple',
  'AC:29:3A': 'Apple',
  'B0:65:BD': 'Apple',
  'B4:F3:22': 'Apple',
  'BC:4C:C4': 'Apple',
  'C4:2D:E5': 'Apple',
  'C8:1E:E7': 'Apple',
  'CC:44:63': 'Apple',
  'D0:03:4B': 'Apple',
  'D4:61:DA': 'Apple',
  'D8:BB:2C': 'Apple',
  'DC:A4:CA': 'Apple',
  'E0:F5:C6': 'Apple',
  'E4:E0:A6': 'Apple',
  'F0:18:98': 'Apple',
  'F4:0F:1B': 'Apple',
  'F4:5C:89': 'Apple',
  'F8:1E:DF': 'Apple',
  'FC:E9:98': 'Apple',
  'F0:2F:74': 'Apple',
  '90:72:40': 'Apple',
  '1C:1B:0D': 'Dell',
  'B8:AC:6F': 'Dell',
  'F0:1F:AF': 'Dell',
  '34:29:8F': 'HP',
  'AC:BC:32': 'HP',
  '3C:D0:F8': 'HP',
};

const mikrotikApi = new MikrotikApi(config.router || {});

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args,
    ];
    execFile('powershell.exe', params, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`PowerShell error: ${err.message}`));
        return;
      }
      if (stderr && stderr.trim()) {
        logger.warn('scan stderr', stderr.trim());
      }
      try {
        const clean = stdout.trim();
        const jsonStart = clean.indexOf('{');
        const jsonEnd = clean.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          resolve(JSON.parse(clean.substring(jsonStart, jsonEnd + 1)));
        } else {
          reject(new Error('No JSON in output'));
        }
      } catch (parseErr) {
        reject(new Error(`Parse error: ${parseErr.message}`));
      }
    });
  });
}

function lookupVendor(mac) {
  if (!mac) return 'Unknown';
  const oui = mac.toUpperCase().replace(/-/g, ':');
  const prefix = (oui.split(':').slice(0, 3).join(':'));
  return VENDOR_DB[prefix] || 'Unknown';
}

function isLocalMac(mac) {
  const secondChar = parseInt(mac.replace(/:/g, '').substring(1, 2), 16);
  return (secondChar & 0x02) !== 0;
}

function isMulticast(mac) {
  const firstByte = parseInt(mac.replace(/:/g, '').substring(0, 2), 16);
  return (firstByte & 0x01) !== 0;
}

const networkScanner = {
  async scan(subnet, timeoutMs = 100) {
    const args = [];
    if (subnet) args.push('-Subnet', subnet);
    args.push('-TimeoutMs', timeoutMs.toString());

    try {
      const raw = await runPowerShell(SCAN_SCRIPT, args);
      if (!raw.success) {
        return {
          isSuccess: false,
          value: null,
          error: raw.error || 'Scan failed',
          statusCode: 500,
          gateway: null,
          ourIp: null,
          ourMac: null,
        };
      }

      const hosts = (raw.hosts || [])
        .filter(h => h.mac && !isMulticast(h.mac) && !isLocalMac(h.mac))
        .map(h => ({
          ip: h.ip,
          mac: h.mac,
          ouiPrefix: h.oui_prefix,
          vendor: lookupVendor(h.mac),
          type: h.type || 'dynamic',
          isGateway: h.ip === raw.gateway,
          isOurs: h.ip === raw.ourIp,
        }))
        .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

      return {
        isSuccess: true,
        value: {
          hosts,
          gateway: raw.gateway,
          ourIp: raw.ourIp,
          ourMac: raw.ourMac,
          totalFound: hosts.length,
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      logger.error('Network scan failed', err.message);
      return {
        isSuccess: false,
        value: null,
        error: err.message,
        statusCode: 500,
        gateway: null,
        ourIp: null,
        ourMac: null,
      };
    }
  },

  async scanFallback(subnet, timeoutMs = 150) {
    const args = ['-TimeoutMs', timeoutMs.toString()];
    if (subnet) args.push('-Subnet', subnet);

    try {
      const raw = await runPowerShell(FALLBACK_SCRIPT, args);
      if (!raw.success) {
        return { isSuccess: false, value: null, error: raw.error || 'Fallback scan failed', statusCode: 500 };
      }

      const hosts = (raw.hosts || [])
        .filter(h => !h.isOurs)
        .map(h => ({
          ip: h.ip,
          mac: h.mac,
          hostname: h.hostname || '',
          hostnameSource: h.hostnameSource || '',
          vendor: h.mac && h.mac !== 'N/A' ? lookupVendor(h.mac) : 'Unknown',
          isGateway: h.isGateway,
        }))
        .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

      return {
        isSuccess: true,
        value: {
          hosts,
          gateway: raw.gateway,
          ourIp: raw.ourIp,
          ourMac: raw.ourMac,
          totalFound: hosts.length,
          methods: raw.methods || [],
          arpOnly: hosts.every(h => h.mac === 'N/A' || h.mac === raw.gateway),
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      logger.error('Fallback scan failed', err.message);
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async enhancedScan(subnet, timeoutMs = 150) {
    const result = {
      isSuccess: false,
      value: {
        hosts: [],
        gateway: null,
        ourIp: null,
        ourMac: null,
        totalFound: 0,
        source: 'none',
        routerDevices: [],
        apiAvailable: false,
        apiError: null,
        networkType: 'unknown',
      },
      error: null,
      statusCode: 500,
    };

    let gateway = null;
    let ourIp = null;
    let ourMac = null;

    let arpResult = null;
    try {
      arpResult = await this.scan(subnet, timeoutMs);
      if (arpResult.isSuccess) {
        gateway = arpResult.value.gateway;
        ourIp = arpResult.value.ourIp;
        ourMac = arpResult.value.ourMac;
      }
    } catch (err) {
      logger.warn('Initial ARP scan failed', err.message);
    }

    if (mikrotikApi.enabled && gateway) {
      mikrotikApi.setEnabled(gateway, config.router.username, config.router.password);
      try {
        const routerDevices = await mikrotikApi.getAllDevices();
        result.value.apiAvailable = true;
        result.value.routerDevices = routerDevices.devices;

        if (routerDevices.success) {
          const mapped = routerDevices.devices
            .filter(d => d.ip && d.ip !== ourIp)
            .map(d => ({
              ip: d.ip,
              mac: d.mac,
              hostname: d.hostname || d.user || '',
              vendor: lookupVendor(d.mac),
              isGateway: d.ip === gateway,
              source: d.source || 'router-api',
              status: d.status || d.active ? 'active' : 'inactive',
            }))
            .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

          result.value.hosts = mapped;
          result.value.totalFound = mapped.length;
          result.value.gateway = gateway;
          result.value.ourIp = ourIp;
          result.value.ourMac = ourMac;
          result.value.source = 'router-api';
          result.value.networkType = 'router-query';
          result.isSuccess = true;
          result.statusCode = 200;
          return result;
        }
      } catch (err) {
        result.value.apiError = err.message;
        logger.warn('MikroTik API failed, falling back', err.message);
      }
    }

    try {
      const fallback = await this.scanFallback(subnet, timeoutMs);
      if (fallback.isSuccess && fallback.value.hosts.length > 0) {
        const mapped = fallback.value.hosts.map(h => ({
          ip: h.ip,
          mac: h.mac !== 'N/A' ? h.mac : null,
          hostname: h.hostname || '',
          vendor: h.vendor || 'Unknown',
          isGateway: h.isGateway,
          source: h.hostnameSource || 'ping',
          status: 'alive',
        }));

        result.value.hosts = mapped;
        result.value.totalFound = mapped.length;
        result.value.gateway = gateway;
        result.value.ourIp = ourIp;
        result.value.ourMac = ourMac;
        result.value.source = 'fallback';
        result.value.networkType = fallback.value.arpOnly ? 'proxy-arp' : 'l2-bridged';
        result.isSuccess = true;
        result.statusCode = 200;
        return result;
      }
    } catch (err) {
      logger.warn('Fallback scan failed', err.message);
    }

    if (arpResult && arpResult.isSuccess) {
      arpResult.value.source = 'arp-only';
      arpResult.value.apiAvailable = false;
      return arpResult;
    }

    return result;
  },

  getMikrotikApi() {
    return mikrotikApi;
  },

  lookupVendor(mac) {
    return lookupVendor(mac);
  },

  async scanSingle(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return { isSuccess: false, value: null, error: 'Invalid IP', statusCode: 400 };
    }
    const subnet = parts.slice(0, 3).join('.');
    const result = await this.scan(subnet);
    if (!result.isSuccess) return result;

    const host = result.value.hosts.find(h => h.ip === ip);
    if (host) {
      return { isSuccess: true, value: host, error: null, statusCode: 200 };
    }
    return { isSuccess: false, value: null, error: `Host ${ip} not found`, statusCode: 404 };
  },

  async scanGateway() {
    const result = await this.scan();
    if (!result.isSuccess) return result;

    const gateway = result.value.hosts.find(h => h.isGateway);
    if (gateway) {
      return { isSuccess: true, value: gateway, error: null, statusCode: 200 };
    }
    return { isSuccess: true, value: { ip: result.value.gateway, vendor: lookupVendor(result.value.gateway) }, error: null, statusCode: 200 };
  },

  async configureRouterApi(host, username, password) {
    mikrotikApi.setEnabled(host, username, password);
    config.router = config.router || {};
    config.router.host = host;
    config.router.username = username || 'admin';
    config.router.password = password || '';
    return { isSuccess: true, value: { configured: true, host }, error: null, statusCode: 200 };
  },
};

module.exports = networkScanner;
