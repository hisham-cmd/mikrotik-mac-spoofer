const { execFile } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const MikrotikApi = require('./mikrotik-api');
const wifiManager = require('./wifi-manager');
const config = require('../../config/default.json');

const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-deep.ps1');
const FALLBACK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scan-fallback.ps1');

const mikrotikApi = new MikrotikApi(config.router || {});

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...args,
    ];
    execFile('powershell.exe', params, { timeout: 180000 }, (err, stdout, stderr) => {
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
  'DC:2C:6E': 'MikroTik',
  '4C:5E:0C': 'MikroTik',
  '64:D1:54': 'MikroTik',
  '00:0C:42': 'MikroTik',
};

function lookupVendor(mac) {
  if (!mac || mac === 'N/A') return 'Unknown';
  const prefix = mac.toUpperCase().split(':').slice(0, 3).join(':');
  return VENDOR_DB[prefix] || 'Unknown';
}

function classifyDevice(host) {
  if (host.source === 'arp-table') return 'جهاز من ARP (غير متصل حالياً)';
  if (host.isGateway || host.openPorts.includes('8291')) return 'MikroTik';

  const ports = (host.openPorts || '').split(',').filter(Boolean).map(Number);
  const ttl = parseInt(host.ttl, 10);

  if (ports.includes(22)) return 'SSH Server';
  if (ports.includes(80) && ports.includes(443)) return 'Web Server';
  if (ports.includes(8080)) return 'HTTP Proxy';
  if (ports.includes(53)) return 'DNS Server';
  if (ports.length === 0 && ttl === 128) return 'Windows Device';
  if (ports.length === 0 && ttl === 64) return 'Linux/Mac Device';

  if (host.macUnique) {
    const vendor = lookupVendor(host.mac);
    if (vendor !== 'Unknown') return vendor;
    return 'Client Device';
  }

  return 'Behind NAT (shared MAC)';
}

const deepScanner = {
  async scan(subnet, timeoutMs = 50, subnetStart = -1, subnetEnd = -1) {
    const args = [];
    if (subnet) args.push('-Subnet', subnet);
    args.push('-TimeoutMs', timeoutMs.toString());
    if (subnetStart >= 0) args.push('-SubnetStart', subnetStart.toString());
    if (subnetEnd >= 0) args.push('-SubnetEnd', subnetEnd.toString());

    try {
      const raw = await runPowerShell(SCAN_SCRIPT, args);
      if (!raw.success) {
        return { isSuccess: false, value: null, error: raw.error || 'Deep scan failed', statusCode: 500 };
      }

      const hosts = (raw.hosts || []).map(h => {
        const devType = h.source === 'gateway' ? 'MikroTik Router' : h.source === 'arp-client' ? classifyDevice(h) : h.deviceType || classifyDevice(h);
        return {
          ip: h.ip,
          mac: h.mac,
          ttl: h.ttl,
          deviceType: devType,
          vendor: h.isGateway ? 'MikroTik' : lookupVendor(h.mac),
          isGateway: h.isGateway || false,
          hasUniqueMac: h.macUnique || false,
          openPorts: h.openPorts || '',
          portCount: h.openPortCount || 0,
          source: h.source || 'arp-client',
          subnet: h.subnet || '',
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

    const result = {
      isSuccess: false,
      value: {
        hosts: [],
        gateway: null,
        ourIp: null,
        ourMac: null,
        ssid: currentSsid,
        totalFound: 0,
        uniqueMacHosts: 0,
        behindNATHosts: 0,
        networkType: 'unknown',
        source: 'none',
        routerDevices: [],
        apiAvailable: false,
        apiError: null,
        hotspot: { detected: false },
      },
      error: null,
      statusCode: 500,
    };

    let gateway = null;
    let ourIp = null;
    let ourMac = null;

    let arpResult = null;
    try {
      arpResult = await this.scan(subnet, timeoutMs, subnetStart, subnetEnd);
      if (arpResult.isSuccess) {
        gateway = arpResult.value.gateway;
        ourIp = arpResult.value.ourIp;
        ourMac = arpResult.value.ourMac;
        result.value.hotspot = arpResult.value.hotspot || { detected: false };
      }
    } catch (err) {
      logger.warn('Deep ARP scan failed', err.message);
    }

    if (arpResult && arpResult.isSuccess && arpResult.value.uniqueMacHosts > 0) {
      arpResult.value.source = 'deep-scan';
      arpResult.value.apiAvailable = false;
      return arpResult;
    }
    if (arpResult && arpResult.isSuccess) {
      arpResult.value.source = 'deep-scan';
      arpResult.value.apiAvailable = false;
    }

    const tryApi = mikrotikApi.enabled || (gateway && gateway !== 'N/A');
    if (tryApi && gateway) {
      try {
        mikrotikApi.setEnabled(gateway, config.router.username, config.router.password);
      } catch (e2) {}
      try {
        const routerDevices = await mikrotikApi.getAllDevices();
        result.value.apiAvailable = true;
        result.value.routerDevices = routerDevices.devices;

        if (routerDevices.success) {
          const mapped = routerDevices.devices
            .filter(d => d.ip && d.ip !== ourIp)
            .map(d => {
              const hasPorts = arpResult && arpResult.isSuccess
                ? arpResult.value.hosts.find(h => h.ip === d.ip)
                : null;
              return {
                ip: d.ip,
                mac: d.mac,
                hostname: d.hostname || d.user || '',
                vendor: lookupVendor(d.mac),
                isGateway: d.ip === gateway,
                deviceType: d.ip === gateway ? 'MikroTik' : 'Client Device',
                source: d.source || 'router-api',
                status: d.status || d.active ? 'active' : 'inactive',
                openPorts: hasPorts ? hasPorts.openPorts : '',
                portCount: hasPorts ? hasPorts.portCount : 0,
                hasUniqueMac: true,
              };
            })
            .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

          result.value.hosts = mapped;
          result.value.totalFound = mapped.length;
          result.value.uniqueMacHosts = mapped.length;
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
        logger.warn('Deep MikroTik API failed, falling back', err.message);
      }
    }

    try {
      const fallbackArgs = [];
      if (subnet) fallbackArgs.push('-Subnet', subnet);
      fallbackArgs.push('-TimeoutMs', timeoutMs.toString());

      const fallbackRaw = await runPowerShell(FALLBACK_SCRIPT, fallbackArgs);
      if (fallbackRaw.success && (fallbackRaw.hosts || []).length > 0) {
        const fallbackHosts = (fallbackRaw.hosts || [])
          .filter(h => !h.isOurs)
          .map(h => ({
            ip: h.ip,
            mac: h.mac !== 'N/A' ? h.mac : null,
            hostname: h.hostname || '',
            vendor: h.mac && h.mac !== 'N/A' ? lookupVendor(h.mac) : 'Unknown',
            isGateway: h.isGateway,
            deviceType: h.isGateway ? 'MikroTik' : (h.hostname ? 'Named Device' : 'Unknown'),
            source: h.hostnameSource || 'ping',
            status: 'alive',
            hasUniqueMac: h.mac && h.mac !== 'N/A',
          }))
          .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));

        const uniqueCount = fallbackHosts.filter(h => h.hasUniqueMac).length;
        const natCount = fallbackHosts.filter(h => !h.hasUniqueMac).length;
        const arpOnly = fallbackHosts.every(h => !h.mac || h.mac === fallbackRaw.gateway);

        result.value.hosts = fallbackHosts;
        result.value.totalFound = fallbackHosts.length;
        result.value.uniqueMacHosts = uniqueCount;
        result.value.behindNATHosts = natCount;
        result.value.gateway = gateway;
        result.value.ourIp = ourIp;
        result.value.ourMac = ourMac;
        result.value.source = 'fallback';
        result.value.networkType = arpOnly ? 'proxy-arp' : 'l2-bridged';
        result.isSuccess = true;
        result.statusCode = 200;
        return result;
      }
    } catch (err) {
      logger.warn('Deep fallback scan failed', err.message);
    }

    if (arpResult && arpResult.isSuccess) {
      arpResult.value.source = 'arp-only';
      arpResult.value.apiAvailable = false;
      return arpResult;
    }

    return result;
  },

  async scanWithPorts(subnet) {
    return this.scan(subnet, 50);
  },

  async arpOnly() {
    try {
      const hosts = [];
      const gatewayInfo = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', '$r=Get-NetRoute -DestinationPrefix "0.0.0.0/0"|Where-Object NextHop -ne "0.0.0.0"|Select-Object -First 1; if($r){$g=$r.NextHop;$i=Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4|Where-Object{$_.IPAddress -match "^\\d+\\.\\d+\\.\\d+\\.\\d+$"}|Select-Object -First 1; $a=Get-NetAdapter -InterfaceIndex $r.InterfaceIndex|Select-Object -First 1; Write-Output "{\"gateway\":\"$g\",\"ip\":\"$($i.IPAddress)\",\"mac\":\"$($a.MacAddress)\"}"}else{Write-Output "{}"}'], { timeout: 10000 }, (err, stdout) => {
          resolve(err ? {} : JSON.parse(stdout.trim() || '{}'));
        });
      });
      const gateway = gatewayInfo.gateway || null;
      const ourIp = gatewayInfo.ip || null;
      const ourMac = gatewayInfo.mac || null;

      let scanSsid = '';
      try {
        const quick = await wifiManager.quickCheck();
        if (quick && quick.ssid) scanSsid = quick.ssid;
      } catch {}

      const arpResult = await new Promise((resolve) => {
        execFile('arp', ['-a'], { timeout: 5000 }, (err, stdout) => {
          if (err) { resolve([]); return; }
          const seen = new Set();
          const macMap = new Map();
          const lines = stdout.split('\n');
          for (const line of lines) {
            const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2})/);
            if (m && !seen.has(m[1])) {
              seen.add(m[1]);
              macMap.set(m[1], m[2].toUpperCase().replace(/-/g, ':'));
            }
          }
          resolve(macMap);
        });
      });

      const gwMac = gateway ? arpResult.get(gateway) : null;
      for (const [ip, mac] of arpResult) {
        if (ip === gateway || ip === ourIp) continue;
        if (mac === '00:00:00:00:00:00') continue;
        if (mac.startsWith('01:00:5E') || mac === 'FF:FF:FF:FF:FF:FF') continue;
        const isProxy = gwMac && mac === gwMac && ip !== gateway;
        let deviceType = 'Client Device';
        if (isProxy) deviceType = 'Behind Proxy-ARP';
        else if (parseInt(mac.split(':')[0], 16) & 2) deviceType = 'Random MAC';
        hosts.push({
          ip, mac: isProxy ? 'N/A' : mac, ttl: '', deviceType,
          vendor: 'Unknown', isGateway: false, hasUniqueMac: !isProxy,
          openPorts: '', portCount: 0, source: 'arp-cache', subnet: ip.split('.').slice(0, 3).join('.'),
        });
      }

      if (gateway) {
        hosts.push({
          ip: gateway, mac: gwMac || 'N/A', ttl: '', deviceType: 'MikroTik Router',
          vendor: 'MikroTik', isGateway: true, hasUniqueMac: false,
          openPorts: '', portCount: 0, source: 'gateway', subnet: gateway.split('.').slice(0, 3).join('.'),
        });
      }

      const uniqueCount = hosts.filter(h => h.hasUniqueMac).length;
      return {
        isSuccess: true,
        value: {
          hosts, ssid: scanSsid, gateway, ourIp, ourMac,
          totalFound: hosts.length, uniqueMacHosts: uniqueCount,
          behindNATHosts: hosts.filter(h => !h.hasUniqueMac && !h.isGateway).length,
          source: 'arp-only', networkType: 'arp-cache',
        },
        error: null, statusCode: 200,
      };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
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
