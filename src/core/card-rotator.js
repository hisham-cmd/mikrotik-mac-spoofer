const logger = require('../utils/logger');
const wifiManager = require('./wifi-manager');
const hotspotAuth = require('./hotspot-auth');
const quotaMonitor = require('./quota-monitor');
const sessionStore = require('./session-store');
const proxyServer = require('./proxy-server');
const config = require('../../config/default.json');

const FAILURE_RETRY_COUNT = config.rotation.failureRetryCount || 2;
const FAILURE_RETRY_DELAY = config.rotation.failureRetryDelayMs || 30000;

let isRotating = false;
let rotationTimer = null;
let currentCard = null;
let originalMac = null;
let rotationState = 'idle';

const cardRotator = {
  async start() {
    if (isRotating) {
      return { isSuccess: true, value: { status: 'already_running' }, error: null, statusCode: 200 };
    }

    const cards = sessionStore.getCards();
    const readyCards = cards.filter(c => c.status === 'ready' || c.status === 'active');
    if (readyCards.length === 0) {
      return { isSuccess: false, value: null, error: 'No cards available for rotation', statusCode: 400 };
    }

    isRotating = true;
    rotationState = 'starting';
    logger.info(`Card rotation started with ${readyCards.length} cards`);

    sessionStore.updateSettings({ autoRotation: true });

    try {
      originalMac = await wifiManager.getCurrentMac();
      logger.info('Original MAC saved', originalMac);
    } catch (err) {
      logger.warn('Could not save original MAC', err.message);
    }

    quotaMonitor.onExhausted((event) => {
      logger.info(`Rotation triggered: ${event.reason}`);
      this.rotateToNextCard(event.reason);
    });

    const result = await this.useCurrentCard();
    if (!result.isSuccess) {
      const rotateResult = await this.rotateToNextCard('Initial login failed');
      if (!rotateResult) {
        isRotating = false;
        sessionStore.updateSettings({ autoRotation: false });
        return { isSuccess: false, value: null, error: 'No valid cards available', statusCode: 500 };
      }
    }

    return { isSuccess: true, value: { status: 'running', card: currentCard }, error: null, statusCode: 200 };
  },

  stop() {
    isRotating = false;
    rotationState = 'stopped';
    quotaMonitor.stop();
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    sessionStore.updateSettings({ autoRotation: false });
    logger.info('Card rotation stopped');
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },

  async useCurrentCard() {
    const card = sessionStore.getCurrentCard();
    if (!card) {
      return { isSuccess: false, value: null, error: 'No current card', statusCode: 404 };
    }

    currentCard = card;
    rotationState = 'logging_in';
    logger.info(`Using card ending with ${card.number.slice(-4)}`);

    const isLoggedIn = await hotspotAuth.checkStatus();
    if (isLoggedIn.isSuccess && isLoggedIn.value.isLoggedIn) {
      logger.info('Already logged in, checking session');
      await hotspotAuth.logout();
    }

    for (let attempt = 1; attempt <= FAILURE_RETRY_COUNT + 1; attempt++) {
      if (!isRotating) return { isSuccess: false, value: null, error: 'Rotation stopped', statusCode: 400 };

      const loginResult = await hotspotAuth.login(card.number, card.domain);
      if (loginResult.isSuccess) {
        sessionStore.markCardUsed(sessionStore.getSettings().currentCardIndex);
        rotationState = 'monitoring';
        currentCard.status = 'active';

        const limit = quotaMonitor.setCardLimit(card.profile);
        proxyServer.resetCounters();
        quotaMonitor.start(limit);

        sessionStore.addHistoryEntry({
          type: 'login',
          cardNumber: card.number.slice(-4),
          domain: card.domain,
          success: true,
        });

        logger.info(`Card ${card.number.slice(-4)} active`);
        return { isSuccess: true, value: { card, limit }, error: null, statusCode: 200 };
      }

      logger.warn(`Login attempt ${attempt} failed for card ${card.number.slice(-4)}`, loginResult.error);

      if (loginResult.statusCode === 403 && attempt < FAILURE_RETRY_COUNT + 1) {
        logger.info(`Blocked - waiting ${FAILURE_RETRY_DELAY / 1000}s before retry`);
        await new Promise(r => setTimeout(r, FAILURE_RETRY_DELAY));
        continue;
      }

      break;
    }

    sessionStore.markCardExhausted(sessionStore.getSettings().currentCardIndex);
    sessionStore.addHistoryEntry({
      type: 'login_failed',
      cardNumber: card.number.slice(-4),
      error: 'All login attempts failed',
    });

    return { isSuccess: false, value: null, error: `Card ${card.number.slice(-4)} login failed after ${FAILURE_RETRY_COUNT + 1} attempts`, statusCode: 401 };
  },

  async rotateToNextCard(reason) {
    if (!isRotating) return false;

    quotaMonitor.stop();
    rotationState = 'rotating';
    logger.info(`Rotating to next card (reason: ${reason})`);

    sessionStore.markCardExhausted(sessionStore.getSettings().currentCardIndex);

    sessionStore.addHistoryEntry({
      type: 'rotate',
      reason,
      cardNumber: currentCard ? currentCard.number.slice(-4) : 'unknown',
    });

    const newMac = wifiManager.generateRandomMac();

    try {
      await hotspotAuth.logout();
    } catch {
      logger.debug('Logout during rotation (non-critical)');
    }

    try {
      logger.info(`Spoofing MAC to ${newMac}`);
      await wifiManager.spoofMac(newMac);
    } catch (err) {
      logger.error('MAC spoofing failed during rotation', err.message);
    }

    const nextCard = sessionStore.advanceToNextCard();
    if (!nextCard) {
      logger.warn('No more cards available for rotation');
      isRotating = false;
      rotationState = 'no_cards';
      sessionStore.addHistoryEntry({ type: 'rotation_end', reason: 'No cards left' });
      return false;
    }

    const result = await this.useCurrentCard();
    if (!result.isSuccess) {
      return this.rotateToNextCard('Card login failed during rotation');
    }

    return true;
  },

  getState() {
    return {
      isRotating,
      rotationState,
      currentCard: currentCard ? {
        number: currentCard.number ? currentCard.number.slice(-4) : 'N/A',
        domain: currentCard.domain,
        profile: currentCard.profile,
        status: currentCard.status,
      } : null,
      stats: sessionStore.getStats(),
      quota: quotaMonitor.getState(),
      config: {
        retryCount: FAILURE_RETRY_COUNT,
        retryDelay: FAILURE_RETRY_DELAY,
        pollInterval: config.rotation.quotaPollIntervalMs,
        thresholdPercent: config.rotation.quotaThresholdPercent,
      },
    };
  },
};

module.exports = cardRotator;
