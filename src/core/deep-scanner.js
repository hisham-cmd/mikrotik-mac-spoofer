const { execFile } = require('child_process');
const net = require('net');
const path = require('path');
const logger = require('../utils/logger');
const MikrotikApi = require('./mikrotik-api');
const wifiManager = require('./wifi-manager');
const config = require('../../config/default.json');

const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-deep.ps1');
const FALLBACK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-fallback.ps1');
const POWER_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-power.ps1');

const mikrotikApi = new MikrotikApi(config.router || {});

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...args,
    ];
    execFile('powershell.exe', params, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) {
        const stderrMsg = stderr ? stderr.trim().slice(0, 500) : '';
        logger.error('PowerShell exec error', err.message + (stderrMsg ? ' | stderr: ' + stderrMsg : ''));
        reject(new Error(`PowerShell error: ${err.message}`));
        return;
      }
      try {
        const allOutput = stdout.trim();
        const jsonStart = allOutput.indexOf('{');
        const jsonEnd = allOutput.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          resolve(JSON.parse(allOutput.substring(jsonStart, jsonEnd + 1)));
        } else {
          reject(new Error(stderr || 'No JSON found in output'));
        }
      } catch (parseErr) {
        reject(new Error(`Parse error: ${parseErr.message}`));
      }
    });
  });
}

const VENDOR_DB = {
  'DC:2C:6E': 'MikroTik', '4C:5E:0C': 'MikroTik', '64:D1:54': 'MikroTik', '00:0C:42': 'MikroTik',
  '00:1A:8C': 'MikroTik', '6C:3B:6B': 'MikroTik', '04:18:D6': 'MikroTik', '74:4D:28': 'MikroTik',
  'E4:5D:52': 'MikroTik', '20:40:C0': 'MikroTik', 'C0:3C:04': 'MikroTik', '18:FD:74': 'MikroTik',
  '00:17:C5': 'Apple', '00:1E:C2': 'Apple', '00:1F:5B': 'Apple', '00:23:DF': 'Apple',
  '00:26:08': 'Apple', '00:26:4A': 'Apple', '00:50:E4': 'Apple', '04:0C:CE': 'Apple',
  '04:26:65': 'Apple', '04:7C:16': 'Apple', '08:66:98': 'Apple', '10:05:CA': 'Apple',
  '10:9A:DD': 'Apple', '14:7D:DA': 'Apple', '14:99:E2': 'Apple', '18:65:90': 'Apple',
  '1C:36:BB': 'Apple', '20:3C:AE': 'Apple', '24:1E:7B': 'Apple', '28:37:37': 'Apple',
  '28:53:2D': 'Apple', '2C:20:53': 'Apple', '30:10:B3': 'Apple', '34:81:C4': 'Apple',
  '3C:22:FB': 'Apple', '3C:D0:F8': 'Apple', '40:CB:C0': 'Apple', '44:00:10': 'Apple',
  '44:D8:84': 'Apple', '48:43:7C': 'Apple', '48:60:BC': 'Apple', '48:A4:72': 'Apple',
  '4C:32:75': 'Apple', '5C:96:9D': 'Apple', '60:03:08': 'Apple', '60:33:4B': 'Apple',
  '60:92:26': 'Apple', '64:76:BA': 'Apple', '68:5B:35': 'Apple', '68:AB:1E': 'Apple',
  '6C:72:20': 'Apple', '70:48:0F': 'Apple', '70:6E:AA': 'Apple', '74:21:6A': 'Apple',
  '78:48:59': 'Apple', '78:4F:43': 'Apple', '7C:11:BE': 'Apple', '80:BE:05': 'Apple',
  '84:38:38': 'Apple', '84:89:AD': 'Apple', '88:53:2E': 'Apple', '8C:85:80': 'Apple',
  '8C:8C:AA': 'Apple', '90:72:40': 'Apple', '90:84:0D': 'Apple', '94:BF:2D': 'Apple',
  '94:E9:79': 'Apple', '98:01:A7': 'Apple', '98:FE:94': 'Apple', '9C:20:7E': 'Apple',
  'A0:56:B2': 'Apple', 'A4:29:42': 'Apple', 'A4:D1:D2': 'Apple', 'AC:29:3A': 'Apple',
  'B0:34:95': 'Apple', 'B0:65:BD': 'Apple', 'B4:4B:D2': 'Apple', 'B4:8C:9D': 'Apple',
  'B8:87:1E': 'Apple', 'BC:52:B7': 'Apple', 'BC:92:6B': 'Apple', 'C0:48:E6': 'Apple',
  'C0:CB:38': 'Apple', 'C4:2E:FF': 'Apple', 'C8:34:8E': 'Apple', 'CC:78:5F': 'Apple',
  'D0:23:DB': 'Apple', 'D0:37:45': 'Apple', 'D0:9E:1F': 'Apple', 'D4:CA:6D': 'Apple',
  'D8:00:4D': 'Apple', 'D8:9A:34': 'Apple', 'DC:0C:5C': 'Apple', 'DC:A4:CA': 'Apple',
  'E0:52:1A': 'Apple', 'E0:7C:62': 'Apple', 'E0:F8:47': 'Apple', 'E4:1F:13': 'Apple',
  'E4:E4:AB': 'Apple', 'E8:64:01': 'Apple', 'EC:35:86': 'Apple', 'F0:18:98': 'Apple',
  'F0:99:B6': 'Apple', 'F4:0F:24': 'Apple', 'F4:15:63': 'Apple', 'F4:5C:89': 'Apple',
  'F4:96:34': 'Apple', 'F4:B8:5E': 'Apple', 'F8:1E:DF': 'Apple', 'FC:25:3F': 'Apple',
  'FC:E9:98': 'Apple', '44:2D:6B': 'Samsung', '48:D8:55': 'Samsung', '50:11:F8': 'Samsung',
  '58:A0:23': 'Samsung', '5C:49:79': 'Samsung', '64:3B:F0': 'Samsung', '64:6D:6C': 'Samsung',
  '70:91:8F': 'Samsung', '74:29:AF': 'Samsung', '78:2B:46': 'Samsung', '7C:2A:31': 'Samsung',
  '84:4B:F5': 'Samsung', '88:36:6C': 'Samsung', '8C:77:12': 'Samsung', '94:02:E5': 'Samsung',
  '9C:2A:70': 'Samsung', 'A0:08:A7': 'Samsung', 'A0:51:0B': 'Samsung', 'B0:75:D5': 'Samsung',
  'C8:61:95': 'Samsung', 'D0:94:66': 'Samsung', 'D4:D2:48': 'Samsung', 'DC:0C:59': 'Samsung',
  'E0:90:D8': 'Samsung', 'E0:F5:C6': 'Samsung', 'E4:8D:8C': 'Samsung', 'F0:1F:AF': 'Samsung',
  'F4:A5:09': 'Samsung', 'F8:A9:D0': 'Samsung', 'FC:03:9F': 'Samsung', '44:5A:B9': 'Huawei',
  '48:22:54': 'Huawei', '4C:74:BF': 'Huawei', '50:2B:73': 'Huawei', '54:2F:3C': 'Huawei',
  '58:17:0C': 'Huawei', '60:70:1C': 'Huawei', '64:16:7E': 'Huawei', '68:59:7A': 'Huawei',
  '70:4D:7B': 'Huawei', '74:9D:79': 'Huawei', '78:F2:9E': 'Huawei', '80:50:6D': 'Huawei',
  '84:A9:3E': 'Huawei', '8C:99:E6': 'Huawei', '8C:FD:DE': 'Huawei', '94:61:1B': 'Huawei',
  '9C:28:EF': 'Huawei', 'A0:99:9B': 'Huawei', 'A4:77:33': 'Huawei', 'B0:D2:27': 'Huawei',
  'C0:88:E3': 'Huawei', 'C4:96:88': 'Huawei', 'D8:0B:9A': 'Huawei', 'D8:15:0D': 'Huawei',
  'E0:5A:1F': 'Huawei', 'E4:81:84': 'Huawei', 'E8:6C:61': 'Huawei', '3C:8B:90': 'Xiaomi',
  '4C:FE:D0': 'Xiaomi', '50:F5:DA': 'Xiaomi', '54:8D:3A': 'Xiaomi', '64:32:A8': 'Xiaomi',
  '74:2F:68': 'Xiaomi', '78:04:73': 'Xiaomi', '7C:B5:66': 'Xiaomi', '80:AD:16': 'Xiaomi',
  '8C:68:46': 'Xiaomi', '90:3C:A4': 'Xiaomi', '94:65:2D': 'Xiaomi', '98:CF:43': 'Xiaomi',
  '9C:95:63': 'Xiaomi', 'A0:C9:A0': 'Xiaomi', 'A8:02:57': 'Xiaomi', 'B0:4E:26': 'Xiaomi',
  'B4:6C:DF': 'Xiaomi', 'C0:EE:FB': 'Xiaomi', 'C4:7D:4F': 'Xiaomi', 'D4:6A:91': 'Xiaomi',
  'E4:BE:ED': 'Xiaomi', 'E8:6C:33': 'Xiaomi', 'F0:A4:D2': 'Xiaomi', 'F4:B7:5A': 'Xiaomi',
  'F4:F9:9C': 'Xiaomi', '48:7D:2E': 'TP-Link', '50:C7:BF': 'TP-Link', '54:A6:78': 'TP-Link',
  '60:32:B1': 'TP-Link', '64:6D:B4': 'TP-Link', '6C:50:4D': 'TP-Link', '70:4F:57': 'TP-Link',
  '74:DA:38': 'TP-Link', '78:DA:BE': 'TP-Link', '84:16:F9': 'TP-Link', '8C:A6:DF': 'TP-Link',
  '90:F6:52': 'TP-Link', '94:D9:B3': 'TP-Link', 'A0:F3:C1': 'TP-Link', 'A4:2B:B0': 'TP-Link',
  'A8:5E:45': 'TP-Link', 'B0:BE:83': 'TP-Link', 'B4:A4:E3': 'TP-Link', 'B8:27:EB': 'TP-Link',
  'C0:4A:00': 'TP-Link', 'C8:3A:35': 'TP-Link', 'CC:32:E5': 'TP-Link', 'D0:37:42': 'TP-Link',
  'D4:6E:0E': 'TP-Link', 'D8:0D:17': 'TP-Link', 'D8:1C:79': 'TP-Link', 'E0:CC:F3': 'TP-Link',
  'E4:C3:2A': 'TP-Link', 'E8:48:B8': 'TP-Link', 'EC:08:6B': 'TP-Link', 'F4:3D:80': 'TP-Link',
  'F4:83:CD': 'TP-Link', 'FC:A8:4A': 'TP-Link', '00:17:9A': 'Cisco', '00:1A:6C': 'Cisco',
  '00:1E:4F': 'Cisco', '00:21:6B': 'Cisco', '00:24:50': 'Cisco', '00:26:0B': 'Cisco',
  '00:2B:8C': 'Cisco', '00:30:94': 'Cisco', '00:34:96': 'Cisco', '14:6A:A3': 'Cisco',
  '18:8B:45': 'Cisco', '1C:DE:A7': 'Cisco', '20:37:06': 'Cisco', '24:70:6E': 'Cisco',
  '2C:AB:25': 'Cisco', '30:F7:0D': 'Cisco', '34:A8:4E': 'Cisco', '3C:CE:73': 'Cisco',
  '40:3F:8B': 'Cisco', '44:D3:CA': 'Cisco', '64:16:F0': 'Cisco', '68:7A:B4': 'Cisco',
  '6C:41:6A': 'Cisco', '70:DB:98': 'Cisco', '74:A2:E6': 'Cisco', '8C:7B:9D': 'Cisco',
  '94:DE:80': 'Cisco', 'B0:4E:26': 'Cisco', 'B4:A9:FE': 'Cisco', 'BC:16:65': 'Cisco',
  'C0:56:27': 'Cisco', 'C8:E0:EB': 'Cisco', 'D4:6A:91': 'Cisco', 'DC:E8:4B': 'Cisco',
  'E0:2A:82': 'Cisco', 'E4:C7:22': 'Cisco', 'F0:4D:A2': 'Cisco', 'F8:1E:DF': 'Cisco',
  'FC:5B:26': 'Cisco', '68:72:51': 'Ubiquiti', '74:83:C2': 'Ubiquiti', '78:8A:20': 'Ubiquiti',
  '80:2A:A8': 'Ubiquiti', 'C4:6E:8E': 'Ubiquiti', 'D0:AE:EC': 'Ubiquiti', 'E0:63:DA': 'Ubiquiti',
  '00:0A:F5': 'D-Link', '00:13:46': 'D-Link', '00:15:E9': 'D-Link', '00:17:9A': 'D-Link',
  '00:1B:44': 'D-Link', '00:1C:F0': 'D-Link', '00:21:91': 'D-Link', '58:6D:8F': 'D-Link',
  '8C:09:F4': 'D-Link', 'B0:C5:54': 'D-Link', 'C0:3F:0E': 'D-Link', 'CC:B8:A8': 'D-Link',
  'E0:B9:4D': 'D-Link', '08:02:8E': 'Intel', '00:1B:21': 'Intel', '00:1E:64': 'Intel',
  '00:21:6A': 'Intel', '00:24:D6': 'Intel', '00:26:C6': 'Intel', '38:02:B8': 'Intel',
  '40:16:9F': 'Intel', '44:45:53': 'Intel', '48:45:20': 'Intel', '50:E5:49': 'Intel',
  '5C:F9:DD': 'Intel', '64:6E:69': 'Intel', '68:5D:43': 'Intel', '70:5A:0F': 'Intel',
  '74:85:2A': 'Intel', '78:24:AF': 'Intel', '80:86:F2': 'Intel', '84:7B:73': 'Intel',
  '8C:04:BA': 'Intel', '8C:70:5A': 'Intel', 'A0:36:9F': 'Intel', 'A0:88:B4': 'Intel',
  'A4:34:D9': 'Intel', 'A4:4C:11': 'Intel', 'B4:96:91': 'Intel', 'BC:77:37': 'Intel',
  'C0:CB:38': 'Intel', 'C4:85:08': 'Intel', 'C8:5B:76': 'Intel', 'D0:57:4C': 'Intel',
  'D4:6E:0E': 'Intel', 'D8:FC:38': 'Intel', 'E0:2E:2A': 'Intel', 'E4:54:E8': 'Intel',
  'E8:39:35': 'Intel', 'E8:6C:61': 'Intel', 'F0:1D:BC': 'Intel', 'F4:8E:92': 'Intel',
  'F8:BC:12': 'Intel', 'FC:F5:28': 'Intel', '00:00:5E': 'VMware', '00:0C:29': 'VMware',
  '00:50:56': 'VMware', '00:1C:42': 'Parallels', '00:15:5D': 'Hyper-V',
  '3C:D9:2B': 'HP', '3C:52:A1': 'HP', '48:0F:CF': 'HP', '64:00:6A': 'HP',
  '7C:46:85': 'HP', '00:25:90': 'HP', 'B8:31:B5': 'HP', '00:0E:C6': 'Dell',
  '00:12:3F': 'Dell', '00:14:22': 'Dell', '00:1E:C9': 'Dell', '00:21:9B': 'Dell',
  '14:18:77': 'Dell', '84:7B:73': 'Dell', 'F8:BC:12': 'Dell', 'B0:6C:BF': 'LG',
  '48:59:29': 'LG', '00:1B:BB': 'Sony', '00:22:57': 'Sony', '44:A8:42': 'Nokia',
  '10:68:8F': 'Nokia', 'A0:CE:C8': 'OnePlus', '4A:14:0A': 'OnePlus',
  'DE:AD:BE': 'Raspberry Pi', 'B8:27:EB': 'Raspberry Pi', 'DC:A6:32': 'Raspberry Pi',
  'E4:5F:01': 'Raspberry Pi', '4C:ED:DE': 'Motorola', '74:F0:7D': 'ZTE',
  '64:5A:04': 'ZTE', '84:DB:2F': 'Arris', '10:17:A8': 'Arris',
};

const CLIENT_VENDORS = new Set([
  'Apple', 'Samsung', 'Huawei', 'Xiaomi', 'OnePlus', 'LG', 'Sony', 'Nokia',
  'Motorola', 'ZTE', 'Raspberry Pi',
]);

const INFRA_VENDORS = new Set([
  'MikroTik', 'TP-Link', 'Cisco', 'D-Link', 'Ubiquiti', 'HP', 'Dell',
  'VMware', 'Parallels', 'Hyper-V', 'Arris',
]);

function lookupVendor(mac) {
  if (!mac || mac === 'N/A') return 'Unknown';
  const prefix = mac.toUpperCase().split(':').slice(0, 3).join(':');
  const exact = VENDOR_DB[prefix];
  if (exact) return exact;
  const oui2 = prefix.split(':').slice(0, 2).join(':');
  const mfr2 = VENDOR_DB[oui2];
  if (mfr2) return mfr2;
  return 'Unknown';
}

function classifyDevice(host, port53DevCount = 0) {
  if (host.source === 'arp-table') return 'جهاز من ARP (غير متصل حالياً)';
  if (host.isGateway || host.openPorts.includes('8291')) return 'MikroTik';

  const ports = (host.openPorts || '').split(',').filter(Boolean).map(Number);
  const ttl = parseInt(host.ttl, 10);
  const vendor = host.mac && host.mac !== 'N/A' ? lookupVendor(host.mac) : 'Unknown';
  const isClientVendor = CLIENT_VENDORS.has(vendor);
  const isInfraVendor = INFRA_VENDORS.has(vendor);

  if (ports.includes(22) && !isClientVendor) return 'SSH Server';
  if (ports.includes(80) && ports.includes(443)) return 'Web Server';
  if (ports.includes(8080)) return 'HTTP Proxy';

  const hasPort53 = ports.includes(53);
  const hasManyDns = port53DevCount > 2;

  if (hasPort53 && !hasManyDns && !isClientVendor) return 'DNS Server';
  if (hasPort53 && !hasManyDns && isClientVendor) return 'Client Device (with DNS)';

  if (isInfraVendor) return vendor;
  if (isClientVendor) return vendor;

  if (ports.length === 0 && ttl === 128) return 'Windows Device';
  if (ports.length === 0 && ttl === 64) return 'Linux/Mac Device';

  if (host.macUnique) {
    if (vendor !== 'Unknown') return vendor;
    return 'Client Device';
  }

  return 'Behind NAT (shared MAC)';
}

function isPotentialHotspotUser(host) {
  if (!host || host.isGateway) return false;
  const mac = host.mac || '';
  if (!mac || mac === 'N/A' || mac === '00:00:00:00:00:00') return false;
  if (!host.macUnique) return false;

  const ports = (host.openPorts || '').split(',').filter(Boolean).map(Number);
  const hasServerPorts = ports.some(p => [22, 443, 8080, 8291, 21, 23, 9090].includes(p));
  if (hasServerPorts) return false;

  const vendor = lookupVendor(mac);
  if (CLIENT_VENDORS.has(vendor)) return true;
  if (INFRA_VENDORS.has(vendor)) return false;
  if (vendor !== 'Unknown') return true;

  const ttl = parseInt(host.ttl, 10);
  if (ttl === 128 || ttl === 64) return true;

  return false;
}

const deepScanner = {
  async scan(subnet, timeoutMs = 50, subnetStart = -1, subnetEnd = -1, gateway = '', ourIp = '', ourMac = '') {
    const args = [];
    if (subnet) args.push('-Subnet', subnet);
    args.push('-TimeoutMs', timeoutMs.toString());
    if (subnetStart >= 0) args.push('-SubnetStart', subnetStart.toString());
    if (subnetEnd >= 0) args.push('-SubnetEnd', subnetEnd.toString());
    if (gateway) args.push('-Gateway', gateway);
    if (ourIp) args.push('-OurIp', ourIp);
    if (ourMac) args.push('-OurMac', ourMac);

    try {
      const raw = await Promise.race([
        runPowerShell(SCAN_SCRIPT, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Deep scan timed out')), 300000)),
      ]);
      if (!raw.success) {
        return { isSuccess: false, value: null, error: raw.error || 'Deep scan failed', statusCode: 500 };
      }

      const rawHosts = raw.hosts || [];
      const port53Count = rawHosts.filter(h => (h.openPorts || '').split(',').includes('53')).length;

      const hosts = rawHosts.map(h => {
        const isGateway = h.isGateway || false;
        const devType = h.source === 'gateway' ? 'MikroTik Router' : h.source === 'arp-client' ? classifyDevice(h, port53Count) : h.deviceType || classifyDevice(h, port53Count);
        return {
          ip: h.ip,
          mac: h.mac,
          ttl: h.ttl,
          deviceType: devType,
          vendor: isGateway ? 'MikroTik' : lookupVendor(h.mac),
          isGateway,
          hasUniqueMac: h.macUnique || false,
          openPorts: h.openPorts || '',
          portCount: h.openPortCount || 0,
          source: h.source || 'arp-client',
          subnet: h.subnet || '',
          isPotentialHotspotUser: isPotentialHotspotUser({ ...h, macUnique: h.macUnique || false, isGateway }),
        };
      });

      const liveUnique = hosts.filter(h => h.hasUniqueMac).length;
      const liveBehindNAT = hosts.filter(h => !h.hasUniqueMac && !h.isGateway).length;

      let scanSsid = config.network.ssid || '';
      try {
        const quick = await wifiManager.quickCheck();
        if (quick && quick.ssid) scanSsid = quick.ssid;
      } catch (e) {}
      if (!scanSsid || scanSsid === config.network.ssid) {
        try {
          const adapterInfo = await wifiManager.getAdapterInfo();
          if (adapterInfo && adapterInfo.ssid) scanSsid = adapterInfo.ssid;
        } catch (e) {}
      }

      return {
        isSuccess: true,
        value: {
          hosts,
          ssid: scanSsid,
          gateway: raw.gateway,
          ourIp: raw.ourIp,
          ourMac: raw.ourMac,
          totalFound: hosts.length,
          uniqueMacHosts: liveUnique,
          behindNATHosts: liveBehindNAT,
          potentialUserCount: hosts.filter(h => h.isPotentialHotspotUser).length,
          uniqueMacs: raw.subnetInfo ? raw.subnetInfo.uniqueMacClients || raw.subnetInfo.uniqueMacs || 0 : 0,
          totalProxyIps: raw.subnetInfo ? raw.subnetInfo.proxyArpIps || 0 : 0,
          totalArp: raw.subnetInfo ? raw.subnetInfo.totalArp || 0 : 0,
          networkType: 'proxy-arp',
          hotspot: raw.hotspot || { detected: false },
          note: raw.subnetInfo ? raw.subnetInfo.note : null,
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      logger.error('Deep scan failed', err.message);
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async enhancedScan(subnet, timeoutMs = 50, subnetStart = -1, subnetEnd = -1) {
    const scanStart = Date.now();
    logger.info(`[SCAN] بدء الفحص المحسن: mode=enhanced, network=${subnet || 'auto'}`);
    let gateway = null, ourIp = null, ourMac = null;
    let currentSsid = config.network.ssid || '';
    try {
      const quick = await wifiManager.quickCheck();
      if (quick && quick.ssid) currentSsid = quick.ssid;
    } catch (e) {}
    if (!currentSsid || currentSsid === config.network.ssid) {
      try {
        const adapterInfo = await wifiManager.getAdapterInfo();
        if (adapterInfo && adapterInfo.ssid) currentSsid = adapterInfo.ssid;
      } catch (e) {}
    }
    logger.info(`[SCAN] SSID الحالي: ${currentSsid}`);

    const arpFast = await this.arpOnly();
    const arpDuration = Date.now() - scanStart;
    logger.info(`[SCAN] ARP السريع: ${arpDuration}ms, hosts=${arpFast.isSuccess ? arpFast.value.totalFound : 0}`);
    if (arpFast.isSuccess) { gateway = arpFast.value.gateway; ourIp = arpFast.value.ourIp; ourMac = arpFast.value.ourMac; }

    let powerScanPromise = null;
    if (subnet) {
      const [subNetAddr] = subnet.split('/');
      const pfx = subNetAddr.split('.').slice(0, 3).join('.');
      if (pfx.split('.').length === 3) {
        powerScanPromise = this.runPowerfulScan(pfx, gateway, ourIp, ourMac);
      }
    } else if (gateway || ourIp) {
      const gwPrefix = gateway ? gateway.split('.').slice(0, 3).join('.') : null;
      const ourPrefix = ourIp ? ourIp.split('.').slice(0, 3).join('.') : null;
      const powerPrefix = (gwPrefix !== ourPrefix && gwPrefix) ? gwPrefix : (ourPrefix || gwPrefix);
      powerScanPromise = this.runPowerfulScan(powerPrefix, gateway, ourIp, ourMac);
    }

    const allHosts = arpFast.isSuccess && arpFast.value.hosts ? [...arpFast.value.hosts] : [];
    let apiAvailable = false, apiError = null, routerDevices = [];

    if (gateway && (mikrotikApi.enabled || config.router.host)) {
      try {
        mikrotikApi.setEnabled(gateway, config.router.username, config.router.password);
        const routerData = await mikrotikApi.getAllDevices();
        apiAvailable = true;
        routerDevices = routerData.devices;
        if (routerData.success && routerData.devices) {
          for (const d of routerData.devices) {
            if (!d.ip || d.ip === ourIp) continue;
            const mac = d.mac || '';
            const exists = allHosts.find(h => h.ip === d.ip);
            if (exists) {
              if (!exists.mac || exists.mac === 'N/A') exists.mac = mac;
              if (!exists.vendor || exists.vendor === 'Unknown') exists.vendor = lookupVendor(mac);
              if (d.ip === gateway) exists.isGateway = true;
              if (!exists.source || exists.source === 'arp-cache') exists.source = 'router-api';
            } else {
              allHosts.push({
                ip: d.ip, mac, ttl: '', deviceType: d.ip === gateway ? 'MikroTik' : 'Client Device',
                vendor: lookupVendor(mac), isGateway: d.ip === gateway, hasUniqueMac: true,
                openPorts: '', portCount: 0, source: 'router-api', subnet: d.ip.split('.').slice(0, 3).join('.'),
                isPotentialHotspotUser: false, hostname: d.hostname || d.user || '',
              });
            }
          }
          logger.info(`[SCAN] 📡 من API الراوتر: ${routerData.devices.length} جهاز في ${Date.now()-scanStart}ms`);
        } else {
          logger.info(`[SCAN] ⚠️ API الراوتر متصل لكن لا يوجد أجهزة`);
        }
      } catch (err) {
        apiError = err.message;
        logger.warn(`[SCAN] ⚠️ API الراوتر فشل: ${err.message}`);
      }
    } else {
      logger.info(`[SCAN] ⚠️ API الراوتر غير متاح (gateway=${gateway})`);
    }

    const subnetsToScan = new Set();
    if (ourIp) subnetsToScan.add(ourIp.split('.').slice(0, 3).join('.'));
    if (gateway) subnetsToScan.add(gateway.split('.').slice(0, 3).join('.'));
    if (subnet) {
      const [subNetAddr] = subnet.split('/');
      const pfx = subNetAddr.split('.').slice(0, 3).join('.');
      if (pfx.split('.').length === 3) subnetsToScan.add(pfx);
    }
    const prefixes = [...subnetsToScan];

    const pingSubnet = async (prefix) => {
      const ipList = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
      const found = [];
      for (let b = 0; b < ipList.length; b += 30) {
        const batch = ipList.slice(b, b + 30);
        const res = await Promise.all(batch.map(ip => new Promise(r => {
          execFile('ping', ['-n', '1', '-w', '300', ip], { timeout: 1000 }, e => r(!e));
        })));
        for (let j = 0; j < res.length; j++) { if (res[j]) found.push(batch[j]); }
      }
      return found;
    };

    if (prefixes.length > 0) {
      logger.info(`[SCAN] بدء ICMP Ping Sweep لـ ${prefixes.join(', ')}...`);
      const results = await Promise.all(prefixes.map(p => pingSubnet(p)));
      for (let pi = 0; pi < prefixes.length; pi++) {
        const prefix = prefixes[pi];
        for (const ip of results[pi]) {
          if (!allHosts.find(h => h.ip === ip)) {
            allHosts.push({ ip, mac: 'N/A', ttl: '', deviceType: 'Client Device',
              vendor: 'Unknown', isGateway: false, hasUniqueMac: false,
              openPorts: '', portCount: 0, source: 'icmp-sweep', subnet: prefix,
              isPotentialHotspotUser: true });
          }
        }
        logger.info(`[SCAN] ✅ ICMP Sweep ${prefix}.0/24: +${results[pi].length} جهاز`);
      }
    }

    const tcpSubnet = async (prefix) => {
      const ipList = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
      const found = [];
      for (let b = 0; b < ipList.length; b += 30) {
        const batch = ipList.slice(b, b + 30);
        const res = await Promise.all(batch.map(ip => new Promise(r => {
          const sock = new net.Socket();
          sock.setTimeout(400);
          sock.on('connect', () => { sock.destroy(); r(ip); });
          sock.on('error', () => { sock.destroy(); r(null); });
          sock.on('timeout', () => { sock.destroy(); r(null); });
          sock.connect(80, ip);
        })));
        for (const ip of res) { if (ip) found.push(ip); }
      }
      return found;
    };

    if (prefixes.length > 0) {
      logger.info(`[SCAN] بدء TCP Port Scan لـ ${prefixes.join(', ')}...`);
      const results = await Promise.all(prefixes.map(p => tcpSubnet(p)));
      for (let pi = 0; pi < prefixes.length; pi++) {
        const prefix = prefixes[pi];
        for (const ip of results[pi]) {
          if (!allHosts.find(h => h.ip === ip)) {
            allHosts.push({ ip, mac: 'N/A', ttl: '', deviceType: 'Client Device',
              vendor: 'Unknown', isGateway: false, hasUniqueMac: false,
              openPorts: '80', portCount: 1, source: 'tcp-scan', subnet: prefix,
              isPotentialHotspotUser: true });
          }
        }
        logger.info(`[SCAN] ✅ TCP Port Scan ${prefix}.0/24: +${results[pi].length} جهاز`);
      }
    }

    if (gateway) {
      const hotspotPaths = ['/status', '/hotspot/status', '/hotspotlog', '/log', '/hotspot/users'];
      let hotspotFound = false;
      const checkPath = async (spath) => {
        const statusUrl = `http://${gateway}${spath}`;
        try {
          const statusHtml = await new Promise(r => execFile('powershell.exe', ['-NoProfile', '-Command',
            `try{$c=New-Object System.Net.WebClient;$c.Timeout=2000;$t=$c.DownloadString('${statusUrl}');Write-Output $t}catch{}`
          ], { timeout: 3000 }, (e, o) => r(e ? '' : (o||''))));
          return { spath, statusHtml, statusUrl };
        } catch { return { spath, statusHtml: '', statusUrl }; }
      };
      logger.info(`[SCAN] فحص ${hotspotPaths.length} مسار hotspot بالتوازي...`);
      const results = await Promise.allSettled(hotspotPaths.map(checkPath));
      for (const { value } of results) {
        if (!value || !value.statusHtml || value.statusHtml.length <= 50) continue;
        const { statusHtml, statusUrl, spath } = value;
        hotspotFound = true;
            const ipMacPairs = [];
            const ipMacRegex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*[-:]\s*([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})/g;
            let m;
            while ((m = ipMacRegex.exec(statusHtml)) !== null) {
              ipMacPairs.push({ ip: m[1], mac: m[2].replace(/-/g, ':').toUpperCase() });
            }
            const tableRows = statusHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
            for (const row of tableRows) {
              const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
              const vals = cells.map(c => c.replace(/<\/?[^>]+>/g, '').trim()).filter(Boolean);
              if (vals.length >= 2) {
                const ipMatch = vals[0].match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
                const macMatch = vals[1].match(/([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})/);
                if (ipMatch && macMatch) {
                  ipMacPairs.push({ ip: ipMatch[1], mac: macMatch[1].replace(/-/g, ':').toUpperCase() });
                }
              }
            }
            const seen = new Set();
            for (const { ip, mac } of ipMacPairs) {
              if (seen.has(ip) || ip === gateway || ip === ourIp) continue;
              seen.add(ip);
              const exists = allHosts.find(h => h.ip === ip);
              if (exists) {
                if (!exists.mac || exists.mac === 'N/A') exists.mac = mac;
                if (!exists.source || exists.source === 'arp-cache') exists.source = 'hotspot-status';
                exists.hasUniqueMac = true;
              } else {
                allHosts.push({ ip, mac, ttl: '', deviceType: 'Client Device', vendor: lookupVendor(mac),
                  isGateway: false, hasUniqueMac: true, openPorts: '', portCount: 0,
                  source: 'hotspot-status', subnet: ip.split('.').slice(0, 3).join('.'),
                  isPotentialHotspotUser: true });
              }
            }
            if (seen.size > 0) logger.info(`[SCAN] ✅ من ${statusUrl}: +${seen.size} جهاز`);
          }
    }

    const dnsSubnet = async (prefix) => {
      const ipList = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
      const found = [];
      for (let b = 0; b < ipList.length; b += 20) {
        const batch = ipList.slice(b, b + 20);
        const res = await Promise.all(batch.map(ip => new Promise(r => {
          execFile('nslookup', [ip], { timeout: 1000 }, (e, o) => {
            if (!e && o && (o.includes('Name:') || o.includes('الاسم:'))) r(ip);
            else r(null);
          });
        })));
        for (const ip of res) { if (ip) found.push(ip); }
      }
      return found;
    };

    if (prefixes.length > 0) {
      try {
        logger.info(`[SCAN] بدء DNS Reverse Lookup لـ ${prefixes.join(', ')}...`);
        const results = await Promise.all(prefixes.map(p => dnsSubnet(p)));
        for (let pi = 0; pi < prefixes.length; pi++) {
          const prefix = prefixes[pi];
          for (const ip of results[pi]) {
            if (!allHosts.find(h => h.ip === ip)) {
              allHosts.push({ ip, mac: 'N/A', ttl: '', deviceType: 'Client Device',
                vendor: 'Unknown', isGateway: false, hasUniqueMac: false,
                openPorts: '', portCount: 0, source: 'dns-reverse', subnet: prefix,
                isPotentialHotspotUser: true });
            }
          }
          logger.info(`[SCAN] ✅ DNS Sweep ${prefix}.0/24: +${results[pi].length} اسم مضيف`);
        }
      } catch (e) { logger.warn(`[SCAN] ⚠️ DNS Reverse فشل: ${e.message}`); }
    }

    // ====== ARP MAC RESOLUTION: بعد TCP/ICMP الـ ARP cache فيه MACs ======
    if (allHosts.length > 0) {
      try {
        const arpOut = await new Promise(r => execFile('arp', ['-a'], { timeout: 5000 }, (e, o) => r(e ? '' : (o || ''))));
        let resolved = 0;
        for (const line of arpOut.split('\n')) {
          const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})/);
          if (!m) continue;
          const ip = m[1], mac = m[2].toUpperCase().replace(/-/g, ':');
          if (mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5E') || mac === 'FF:FF:FF:FF:FF:FF') continue;
          const host = allHosts.find(h => h.ip === ip);
          if (host && (!host.hasUniqueMac || host.mac === 'N/A')) {
            const isRouterMac = mac === ourMac || mac === 'D4:01:C3:87:AC:69';
            host.mac = mac; host.vendor = lookupVendor(mac); host.source = 'arp-resolve';
            if (!isRouterMac) { host.hasUniqueMac = true; resolved++; }
          }
        }
        logger.info(`[SCAN] ✅ ARP MAC Resolution: +${resolved} MAC (إجمالي ${allHosts.filter(h => h.hasUniqueMac).length})`);
      } catch (e) { logger.warn(`[SCAN] ⚠️ ARP MAC Resolution فشل: ${e.message}`); }
    }

    // ====== POWER SCAN (ننتظر النتيجة بمهلة 180s) ======
    if (powerScanPromise) {
      try {
        const powerResult = await Promise.race([
          powerScanPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Power scan طويل جداً')), 180000)),
        ]);
        if (powerResult && powerResult.hosts.length > 0) {
          let added = 0;
          for (const ph of powerResult.hosts) {
            const exists = allHosts.find(h => h.ip === ph.ip || (h.mac !== 'N/A' && ph.mac !== 'N/A' && h.mac === ph.mac));
            if (!exists && ph.ip) {
              allHosts.push(ph); added++;
            } else if (exists && ph.mac && ph.mac !== 'N/A' && (exists.mac === 'N/A' || exists.mac === '00:00:00:00:00:00')) {
              exists.mac = ph.mac; exists.vendor = lookupVendor(ph.mac); exists.hasUniqueMac = true; exists.hostname = ph.hostname || exists.hostname;
            }
          }
          logger.info(`[SCAN] ✅ الفحص الخارق: +${added} جهاز جديد (إجمالي ${allHosts.length}), ports=${(powerResult.gatewayPorts||[]).length}, SNMP=${powerResult.snmpCount}, REST=${powerResult.restCount}, Web=${powerResult.webCount}, mDNS=${powerResult.mdnsCount}, NetBIOS=${powerResult.netbiosCount}, DNS=${powerResult.dnsCount}`);
        } else {
          logger.info(`[SCAN] ℹ️ الفحص الخارق: ${powerResult ? 'لا أجهزة' : 'فشل'}`);
        }
      } catch (e) {
        logger.warn(`[SCAN] ⚠️ الفحص الخارق: ${e.message}`);
      }
    }

    if (gateway && !allHosts.find(h => h.ip === gateway)) {
      allHosts.unshift({ ip: gateway, mac: ourMac || 'N/A', ttl: '', deviceType: 'MikroTik Router',
        vendor: 'MikroTik', isGateway: true, hasUniqueMac: false, isPotentialHotspotUser: false,
        openPorts: '', portCount: 0, source: 'gateway', subnet: gateway.split('.').slice(0, 3).join('.') });
    }

    const beforeFilter = allHosts.length;
    const filteredHosts = allHosts.filter(h => h.isGateway || h.hasUniqueMac || h.portCount > 0);

    const filteredCount = beforeFilter - filteredHosts.length;
    if (filteredCount > 0) logger.info(`[SCAN] تم تصفية ${filteredCount} جهاز (بدون MAC ولا بورت)`, filteredCount);

    filteredHosts.sort((a, b) => {
      if (a.isGateway) return -1;
      if (b.isGateway) return 1;
      if (a.hasUniqueMac && !b.hasUniqueMac) return -1;
      if (!a.hasUniqueMac && b.hasUniqueMac) return 1;
      return 0;
    });

    const uniqueCount = filteredHosts.filter(h => h.hasUniqueMac).length;
    const behindNAT = filteredHosts.filter(h => !h.hasUniqueMac && !h.isGateway).length;
    const duration = Date.now() - scanStart;
    logger.info(`[SCAN] ✅ الفحص المحسن: ${filteredHosts.length} جهاز (${uniqueCount} unique) في ${duration}ms`);
    return {
      isSuccess: true,
      value: { hosts: filteredHosts, ssid: currentSsid, gateway, ourIp, ourMac,
        totalFound: filteredHosts.length, uniqueMacHosts: uniqueCount, behindNATHosts: behindNAT,
        networkType: filteredHosts.length > 1 ? 'discovered' : 'arp-cache', source: filteredHosts.length > 1 ? 'multi' : 'gateway',
        routerDevices, apiAvailable, apiError, hotspot: { detected: false },
        _scanDuration: duration, _scanStart: new Date(scanStart).toLocaleTimeString('ar-SA'), _scanEnd: new Date().toLocaleTimeString('ar-SA') },
      error: null, statusCode: 200,
    };
  },

  async scanWithPorts(subnet) {
    return this.scan(subnet, 50);
  },

  async arpOnly() {
    const start = Date.now();
    logger.info(`[SCAN] بدء ARP Only...`);
    try {
      const hosts = [];
      let gateway = null, ourIp = null, ourMac = null;

      const tryGateway = (timeout) => new Promise(r => execFile('powershell.exe', ['-NoProfile', '-Command',
        '$r=Get-NetRoute -DestinationPrefix "0.0.0.0/0"|Where-Object NextHop -ne "0.0.0.0"|Select-Object -First 1; if($r){$g=$r.NextHop;$i=Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4|Where-Object{$_.IPAddress -match "^\\d+\\.\\d+\\.\\d+\\.\\d+$"}|Select-Object -First 1; $a=Get-NetAdapter -InterfaceIndex $r.InterfaceIndex|Select-Object -First 1; $info=@{}; $info.gateway=$g; $info.ip=$($i.IPAddress); $info.mac=$($a.MacAddress); Write-Output ($info|ConvertTo-Json -Compress)}else{Write-Output "{}"}'
      ], { timeout }, (err, stdout) => {
        if (err) { r({}); return; }
        try { r(JSON.parse((stdout || '').trim() || '{}')); } catch (e) { r({}); }
      }));
      const gwInfo = await Promise.race([
        tryGateway(5000),
        new Promise(r => setTimeout(() => r({}), 5000)),
      ]);
      if (gwInfo.gateway) {
        gateway = gwInfo.gateway; ourIp = gwInfo.ip || null; ourMac = gwInfo.mac || null;
        logger.info(`[SCAN] Gateway: ${gateway}, IP: ${ourIp || '?'}, MAC: ${ourMac || '?'}`);
      } else {
        try {
          const ipc = await new Promise(r => execFile('ipconfig', [], { timeout: 5000 }, (e, o) => r(e ? '' : (o || ''))));
          const dm = ipc.match(/Default Gateway[.\s]*: ([^\r\n]+)/);
          const im = ipc.match(/IPv4 Address[.\s]*: ([^\r\n]+)/);
          if (dm && dm[1] && dm[1] !== '0.0.0.0') { gateway = dm[1].trim(); }
          if (im && im[1]) { ourIp = im[1].trim(); }
          if (gateway) logger.info(`[SCAN] Gateway (ipconfig): ${gateway}, IP: ${ourIp || '?'}`);
        } catch (e) {}
      }

      // TCP sweep skipped: causes hang on Proxy-ARP networks (router responds for all IPs).
      // ARP cache read below provides existing entries without active scanning.

      const arpMap = await new Promise(r => execFile('arp', ['-a'], { timeout: 5000 }, (err, out) => {
        if (err) { r(new Map()); return; }
        const seen = new Set(), map = new Map();
        for (const line of ((out || '').split('\n'))) {
          const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})/);
          if (m && !seen.has(m[1])) { seen.add(m[1]); map.set(m[1], m[2].toUpperCase().replace(/-/g, ':')); }
        } r(map);
      }));

      const gwMac = gateway ? arpMap.get(gateway) : null;
      for (const [ip, mac] of arpMap) {
        if (ip === gateway || ip === ourIp) continue;
        if (mac === '00:00:00:00:00:00' || mac.startsWith('01:00:5E') || mac === 'FF:FF:FF:FF:FF:FF') continue;
        const isProxy = gwMac && mac === gwMac && ip !== gateway;
        hosts.push({
          ip, mac: isProxy ? 'N/A' : mac, ttl: '',
          deviceType: isProxy ? 'Behind Proxy-ARP' : (parseInt(mac.split(':')[0], 16) & 2 ? 'Random MAC' : 'Client Device'),
          vendor: 'Unknown', isGateway: false, hasUniqueMac: !isProxy,
          openPorts: '', portCount: 0, source: 'arp-cache', subnet: ip.split('.').slice(0, 3).join('.'),
          isPotentialHotspotUser: false,
        });
      }
      if (gateway) {
        hosts.unshift({ ip: gateway, mac: gwMac || 'N/A', ttl: '', deviceType: 'MikroTik Router',
          vendor: 'MikroTik', isGateway: true, hasUniqueMac: false, isPotentialHotspotUser: false,
          openPorts: '', portCount: 0, source: 'gateway', subnet: gateway.split('.').slice(0, 3).join('.') });
      }

      let scanSsid = '';
      try { const q = await wifiManager.quickCheck(); if (q && q.ssid) scanSsid = q.ssid; } catch {}
      const uniqueCount = hosts.filter(h => h.hasUniqueMac).length;
      logger.info(`[SCAN] ✅ ARP Only: ${hosts.length} أجهزة في ${Date.now()-start}ms`);
      return {
        isSuccess: true,
        value: { hosts, ssid: scanSsid, gateway, ourIp, ourMac, totalFound: hosts.length,
          uniqueMacHosts: uniqueCount, behindNATHosts: hosts.filter(h => !h.hasUniqueMac && !h.isGateway).length,
          source: 'arp-only', networkType: 'arp-cache', hotspot: { detected: false }, apiAvailable: false,
          _scanDuration: Date.now()-start, _scanStart: new Date(start).toLocaleTimeString('ar-SA'), _scanEnd: new Date().toLocaleTimeString('ar-SA') },
        error: null, statusCode: 200,
      };
    } catch (err) {
      logger.error(`[SCAN] ❌ ARP Only فشل: ${err.message}`);
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async runPowerfulScan(subnet, gateway, ourIp, ourMac) {
    const start = Date.now();
    logger.info(`[POWERSCAN] بدء الفحص الخارق للشبكة ${subnet || gateway}...`);
    try {
      const powerArgs = ['-Gateway', gateway || '', '-Subnet', subnet || '', '-TimeoutMs', '500'];
      if (ourIp) { powerArgs.push('-OurIp', ourIp); }
      if (ourMac) { powerArgs.push('-OurMac', ourMac); }
      const raw = await Promise.race([
        runPowerShell(POWER_SCRIPT, powerArgs),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Power scan timed out')), 300000)),
      ]);
      if (!raw.success) {
        logger.warn(`[POWERSCAN] ❌ فشل: ${raw.error}`);
        return null;
      }
      const rawHosts = raw.hosts || [];
      const gwPorts = (raw.gatewayPorts || []).join(',');
      const banners = raw.banners || {};
      const duration = Date.now() - start;
      logger.info(`[POWERSCAN] ✅ ${rawHosts.length} جهاز, ${raw.gatewayPorts.length} منفذ بوابة, SNMP:${(raw.snmpDevices||[]).length}, REST:${(raw.restDevices||[]).length}, Web:${(raw.webDevices||[]).length}, mDNS:${Object.keys(raw.mdnsNames||{}).length}, NetBIOS:${Object.keys(raw.netbiosNames||{}).length}, DNS:${Object.keys(raw.dnsNames||{}).length}, Ping:${(raw.pingIps||[]).length} في ${duration}ms`);
      if (banners && Object.keys(banners).length > 0) {
        logger.info('[POWERSCAN] 🏷️  البانرات:', JSON.stringify(banners));
      }

      const prefix = (subnet || gateway || '').split('.').slice(0, 3).join('.');
      const hosts = rawHosts.map(h => {
        const mac = h.mac || 'N/A';
        const vendor = lookupVendor(mac);
        const isMikrotikMac = mac !== 'N/A' && vendor === 'MikroTik';
        const isGW = h.ip === gateway;
        return {
          ip: h.ip || '',
          mac,
          ttl: h.ttl || '',
          deviceType: h.hostname ? h.hostname : (isGW ? 'MikroTik Router' : (isMikrotikMac ? 'MikroTik Device' : classifyDevice({ ...h, mac, openPorts: gwPorts, macUnique: mac !== 'N/A' && mac !== '00:00:00:00:00:00' }, 0))),
          vendor,
          isGateway: isGW,
          hasUniqueMac: mac !== 'N/A' && mac !== '00:00:00:00:00:00',
          openPorts: isGW ? gwPorts : '',
          portCount: isGW ? (raw.gatewayPorts || []).length : 0,
          source: h.source || 'power-scan',
          subnet: h.ip ? h.ip.split('.').slice(0, 3).join('.') : prefix,
          isPotentialHotspotUser: !isGW && !isMikrotikMac && mac !== 'N/A' && mac !== '00:00:00:00:00:00',
          hostname: h.hostname || '',
        };
      });

      return {
        hosts,
        gatewayPorts: raw.gatewayPorts || [],
        banners,
        snmpCount: (raw.snmpDevices || []).length,
        restCount: (raw.restDevices || []).length,
        webCount: (raw.webDevices || []).length,
        mdnsCount: Object.keys(raw.mdnsNames || {}).length,
        netbiosCount: Object.keys(raw.netbiosNames || {}).length,
        dnsCount: Object.keys(raw.dnsNames || {}).length,
        pingCount: (raw.pingIps || []).length,
        hotspot: raw.hotspot || { detected: false },
        _scanDuration: duration,
      };
    } catch (err) {
      logger.warn(`[POWERSCAN] ❌ استثناء: ${err.message}`);
      return null;
    }
  },

  async checkHotspot() {
    try {
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-Command',
          'try { $c=New-Object System.Net.WebClient; $c.Timeout=5000; $h=$c.DownloadString(\"http://www.h.net/index.html\"); if($h -match \"remain_bytes_total|تم تسجيل|status\.html\"){Write-Output \"SESSION_ACTIVE\"} elseif($h -match \"username\"){Write-Output \"LOGIN_PAGE\"} else{Write-Output \"UNKNOWN\"} } catch{Write-Output \"UNREACHABLE\"}',
        ], { timeout: 10000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout ? stdout.trim() : 'UNKNOWN');
        });
      }).then(result => ({
        isSuccess: true,
        value: { status: result, isLoggedIn: result === 'SESSION_ACTIVE' },
        error: null,
        statusCode: 200,
      }));
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  getMikrotikApi() {
    return mikrotikApi;
  },
};

module.exports = deepScanner;
