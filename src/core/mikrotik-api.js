const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

class MikrotikApi {
  constructor(config) {
    this.host = config.host || '';
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.port = config.port || 443;
    this.useSsl = config.useSsl !== false;
    this.timeout = config.timeout || 5000;
    this._enabled = config.enabled !== false && !!this.host;
  }

  get enabled() {
    return this._enabled;
  }

  setEnabled(host, username, password) {
    this.host = host;
    this.username = username || 'admin';
    this.password = password || '';
    this._enabled = !!host;
  }

  _request(endpoint) {
    return new Promise((resolve, reject) => {
      if (!this._enabled || !this.host) {
        reject(new Error('MikroTik API not configured'));
        return;
      }
      const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const lib = this.useSsl ? https : http;
      const options = {
        hostname: this.host,
        port: this.port,
        path: `/rest/${endpoint}`,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
        rejectUnauthorized: false,
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : []);
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        });
      });
      req.on('error', (err) => {
        reject(new Error(`API error: ${err.message}`));
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('API timeout'));
      });
      req.end();
    });
  }

  async getDhcpLeases() {
    const data = await this._request('ip/dhcp-server/lease');
    return (data || []).map(entry => ({
      ip: entry.address || '',
      mac: (entry['mac-address'] || '').toUpperCase(),
      hostname: entry['host-name'] || '',
      status: entry.status || 'unknown',
      server: entry.server || '',
      expiresAfter: entry['expires-after'] || '',
      active: entry.status === 'bound',
      source: 'dhcp-lease',
    }));
  }

  async getArpTable() {
    const data = await this._request('ip/arp');
    return (data || []).map(entry => ({
      ip: entry.address || '',
      mac: (entry['mac-address'] || '').toUpperCase(),
      interface: entry.interface || '',
      status: entry['arp-status'] || entry.status || 'unknown',
      complete: entry.complete === 'true' || entry.complete === true,
      source: 'arp-table',
    }));
  }

  async getActiveHotspotSessions() {
    const data = await this._request('ip/hotspot/active');
    return (data || []).map(entry => ({
      ip: entry.address || '',
      mac: (entry['mac-address'] || '').toUpperCase(),
      user: entry.user || '',
      uptime: entry.uptime || '',
      idleTime: entry['idle-time'] || '',
      bytesIn: entry.bytes ? entry.bytes.split('/')[0] || '0' : '0',
      bytesOut: entry.bytes ? entry.bytes.split('/')[1] || '0' : '0',
      server: entry.server || '',
      source: 'hotspot-active',
    }));
  }

  async getHotspotUsers() {
    const data = await this._request('ip/hotspot/user');
    return (data || []).map(entry => ({
      name: entry.name || '',
      profile: entry.profile || '',
      mac: (entry['mac-address'] || '').toUpperCase(),
      limitUptime: entry['limit-uptime'] || '',
      limitBytesIn: entry['limit-bytes-in'] || '0',
      limitBytesOut: entry['limit-bytes-out'] || '0',
      status: entry.disabled === 'true' ? 'disabled' : 'enabled',
      source: 'hotspot-user',
    }));
  }

  async getAllDevices() {
    const results = {
      success: false,
      devices: [],
      gatewayMac: '',
      sources: [],
      errors: [],
    };

    const seen = new Map();

    function addDevice(dev) {
      if (!dev.ip && !dev.mac) return;
      const key = dev.mac || dev.ip;
      if (!seen.has(key)) {
        seen.set(key, dev);
      }
    }

    try {
      const leases = await this.getDhcpLeases();
      leases.forEach(addDevice);
      results.sources.push('dhcp-lease');
    } catch (err) {
      results.errors.push(`DHCP leases: ${err.message}`);
    }

    try {
      const arp = await this.getArpTable();
      arp.forEach(addDevice);
      results.sources.push('arp-table');
    } catch (err) {
      results.errors.push(`ARP table: ${err.message}`);
    }

    try {
      const hotspot = await this.getActiveHotspotSessions();
      hotspot.forEach(addDevice);
      results.sources.push('hotspot-active');
    } catch (err) {
      results.errors.push(`Hotspot active: ${err.message}`);
    }

    const devices = Array.from(seen.values());
    const gatewayMac = devices.find(d => {
      const octets = (d.ip || '').split('.');
      return octets.length === 4 && octets[3] === '1';
    });

    results.success = devices.length > 0;
    results.devices = devices;
    results.gatewayMac = gatewayMac ? gatewayMac.mac : '';
    results.totalFound = devices.length;

    return results;
  }
}

module.exports = MikrotikApi;
