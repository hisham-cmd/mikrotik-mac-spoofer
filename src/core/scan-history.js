const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../../config/default.json');

const SCAN_HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'scan-history.json');

let scanHistory = [];
let knownDevices = [];

function ensureDataDir() {
  const dir = path.dirname(SCAN_HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  try {
    ensureDataDir();
    if (fs.existsSync(SCAN_HISTORY_FILE)) {
      const raw = fs.readFileSync(SCAN_HISTORY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      scanHistory = Array.isArray(data.scans) ? data.scans : [];
      knownDevices = Array.isArray(data.devices) ? data.devices : [];
    }
  } catch (err) {
    logger.error('Failed to load scan history', err.message);
    scanHistory = [];
    knownDevices = [];
  }
}

function save() {
  try {
    ensureDataDir();
    fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify({ scans: scanHistory, devices: knownDevices }, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save scan history', err.message);
  }
}

load();

const scanHistoryStore = {
  recordScan(scanResult) {
    if (!scanResult || !scanResult.isSuccess || !scanResult.value) return null;

    const val = scanResult.value;
    const now = new Date().toISOString();
    const devices = (val.hosts || []).map(h => ({
      ip: h.ip,
      mac: h.mac || h.macAddress || '',
      hostname: h.hostname || '',
      vendor: h.vendor || 'Unknown',
      deviceType: h.deviceType || '',
      isGateway: !!h.isGateway,
      status: h.status || 'alive',
      source: h.source || val.source || 'unknown',
      firstSeen: now,
      lastSeen: now,
    }));

    const entry = {
      id: scanHistory.length + 1,
      timestamp: now,
      ssid: val.ssid || config.network.ssid || '',
      gateway: val.gateway || '',
      ourIp: val.ourIp || '',
      ourMac: val.ourMac || '',
      networkType: val.networkType || 'unknown',
      source: val.source || 'unknown',
      totalFound: val.totalFound || devices.length,
      apiAvailable: !!val.apiAvailable,
      apiError: val.apiError || null,
      hotspot: val.hotspot || null,
      devices,
    };

    scanHistory.unshift(entry);
    if (scanHistory.length > 500) scanHistory = scanHistory.slice(0, 500);

    const macMap = new Map();
    knownDevices.forEach(d => {
      const key = d.mac || d.ip;
      macMap.set(key, d);
    });
    devices.forEach(d => {
      const key = d.mac || d.ip;
      if (key) {
        const existing = macMap.get(key);
        if (existing) {
          existing.lastSeen = now;
          if (d.hostname && !existing.hostname) existing.hostname = d.hostname;
          if (d.vendor && existing.vendor === 'Unknown') existing.vendor = d.vendor;
        } else {
          macMap.set(key, { ...d, firstSeen: now, lastSeen: now, seenCount: 0 });
        }
      }
    });
    macMap.forEach(d => { d.seenCount = (d.seenCount || 0) + 1; });
    knownDevices = Array.from(macMap.values());
    if (knownDevices.length > 2000) knownDevices = knownDevices.slice(0, 2000);

    save();
    return entry;
  },

  getScans(limit = 20) {
    return scanHistory.slice(0, limit).map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      gateway: s.gateway,
      ourIp: s.ourIp,
      totalFound: s.totalFound,
      networkType: s.networkType,
      source: s.source,
      deviceCount: s.devices.length,
    }));
  },

  getScanDetail(id) {
    return scanHistory.find(s => s.id === id) || null;
  },

  getKnownDevices() {
    return knownDevices.map(d => ({
      mac: d.mac,
      ip: d.ip,
      hostname: d.hostname,
      vendor: d.vendor,
      deviceType: d.deviceType,
      isGateway: d.isGateway,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      lastHijack: d.lastHijack || null,
      favorite: d.favorite || false,
      seenCount: d.seenCount || 1,
      lastIp: d.ip,
    })).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  },

  getKnownDevicesCount() {
    return knownDevices.length;
  },

  recordHijackForMac(mac) {
    const now = new Date().toISOString();
    const dev = knownDevices.find(d => (d.mac || '').toUpperCase() === (mac || '').toUpperCase());
    if (dev) {
      dev.lastHijack = now;
      save();
      return true;
    }
    return false;
  },

  toggleFavorite(mac) {
    const now = new Date().toISOString();
    const dev = knownDevices.find(d => (d.mac || '').toUpperCase() === (mac || '').toUpperCase());
    if (dev) {
      dev.favorite = !dev.favorite;
      dev.favoriteToggled = now;
      save();
      return dev.favorite;
    }
    return false;
  },

  clear() {
    scanHistory = [];
    knownDevices = [];
    save();
  },

  getGroupedByNetwork(sortBy, sortDir) {
    const macCounts = new Map();
    const macLastIp = new Map();
    const macDetails = new Map();
    const networkGroups = new Map();

    sortBy = sortBy || 'seenCount';
    sortDir = sortDir || 'desc';
    const sortDirMul = sortDir === 'asc' ? 1 : -1;
    const knownMap = new Map();
    knownDevices.forEach(d => knownMap.set((d.mac || '').toUpperCase(), d));

    scanHistory.forEach(scan => {
      const networkName = scan.ssid || scan.gateway || 'unknown';
      if (!networkGroups.has(networkName)) {
        networkGroups.set(networkName, {
          ssid: scan.ssid || '',
          gateway: scan.gateway,
          ourIp: scan.ourIp,
          source: scan.source,
          timestamp: scan.timestamp,
          devices: new Map(),
        });
      }

      (scan.devices || []).forEach(d => {
        const mac = d.mac || d.ip || 'unknown';
        const key = mac;

        if (!macCounts.has(key)) macCounts.set(key, 0);
        macCounts.set(key, macCounts.get(key) + 1);
        macLastIp.set(key, d.ip);

        if (!macDetails.has(key)) {
          macDetails.set(key, {
            mac: d.mac, hostname: d.hostname || '', vendor: d.vendor || '',
            deviceType: d.deviceType || '', isGateway: !!d.isGateway,
          });
        } else if (d.hostname && !macDetails.get(key).hostname) {
          macDetails.get(key).hostname = d.hostname;
        }

        if (!networkGroups.get(networkName).devices.has(key)) {
          networkGroups.get(networkName).devices.set(key, {
            mac: d.mac, ip: d.ip, hostname: d.hostname || '',
            deviceType: d.deviceType || '', isGateway: !!d.isGateway,
          });
        }
      });
    });

    const sorters = {
      'seenCount': a => a.seenCount || 0,
      'firstSeen': a => a.firstSeen ? new Date(a.firstSeen).getTime() : 0,
      'lastSeen': a => a.lastSeen ? new Date(a.lastSeen).getTime() : 0,
      'lastHijack': a => a.lastHijack ? new Date(a.lastHijack).getTime() : 0,
      'favorite': a => a.favorite ? 1 : 0,
      'mac': a => a.mac || '',
      'ip': a => a.ip || '',
    };

    const networks = [];
    networkGroups.forEach((group) => {
      const deviceList = [];
      group.devices.forEach((d, key) => {
        const macKey = (d.mac || '').toUpperCase();
        const known = knownMap.get(macKey);
        deviceList.push({
          mac: d.mac, ip: macLastIp.get(key) || d.ip,
          hostname: d.hostname || macDetails.get(key)?.hostname || '',
          deviceType: d.deviceType || macDetails.get(key)?.deviceType || '',
          isGateway: d.isGateway, seenCount: macCounts.get(key) || 0,
          firstSeen: known ? known.firstSeen : null,
          lastSeen: known ? known.lastSeen : null,
          lastHijack: known ? known.lastHijack : null,
          favorite: known ? known.favorite : false,
        });
      });

      const getSortVal = sorters[sortBy] || sorters.seenCount;
      deviceList.sort((a, b) => {
        const va = getSortVal(a), vb = getSortVal(b);
        if (typeof va === 'string') return sortDirMul * va.localeCompare(vb);
        return sortDirMul * (va - vb);
      });

      networks.push({
        ssid: group.ssid || '', gateway: group.gateway,
        timestamp: group.timestamp, source: group.source,
        totalDevices: deviceList.length, devices: deviceList,
      });
    });

    networks.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return networks;
  },
};

module.exports = scanHistoryStore;
