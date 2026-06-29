const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'cards.json');
const HISTORY_FILE = path.join(__dirname, '..', '..', 'data', 'history.json');

let store = null;
let history = [];

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadStore() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      store = JSON.parse(raw);
    } else {
      store = { cards: [], settings: { currentCardIndex: 0, autoRotation: false, activeProfile: 'متوسطة' } };
      saveStore();
    }
  } catch (err) {
    logger.error('Failed to load card store', err.message);
    store = { cards: [], settings: { currentCardIndex: 0, autoRotation: false, activeProfile: 'متوسطة' } };
  }
}

function saveStore() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save card store', err.message);
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      history = JSON.parse(raw);
      if (!Array.isArray(history)) history = [];
    }
  } catch (err) {
    logger.error('Failed to load history', err.message);
    history = [];
  }
}

function saveHistory() {
  try {
    ensureDataDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save history', err.message);
  }
}

loadStore();
loadHistory();

const sessionStore = {
  getCards() {
    return [...(store.cards || [])];
  },

  getCard(index) {
    return (store.cards || [])[index] || null;
  },

  addCard(card) {
    if (!card || !card.number) {
      return { isSuccess: false, value: null, error: 'Card number is required', statusCode: 400 };
    }
    const exists = (store.cards || []).find(c => c.number === card.number);
    if (exists) {
      return { isSuccess: false, value: null, error: 'Card already exists', statusCode: 409 };
    }
    store.cards.push({
      number: card.number.toString().trim(),
      password: card.password || '',
      domain: card.domain || '1024K/2048K',
      profile: card.profile || 'متوسطة',
      status: 'ready',
      lastUsed: null,
      usageCount: 0,
      addedAt: new Date().toISOString(),
    });
    saveStore();
    return { isSuccess: true, value: store.cards[store.cards.length - 1], error: null, statusCode: 201 };
  },

  updateCard(index, updates) {
    if (!store.cards[index]) {
      return { isSuccess: false, value: null, error: 'Card not found', statusCode: 404 };
    }
    Object.assign(store.cards[index], updates);
    saveStore();
    return { isSuccess: true, value: store.cards[index], error: null, statusCode: 200 };
  },

  removeCard(index) {
    if (!store.cards[index]) {
      return { isSuccess: false, value: null, error: 'Card not found', statusCode: 404 };
    }
    const removed = store.cards.splice(index, 1)[0];
    if (store.settings.currentCardIndex >= store.cards.length) {
      store.settings.currentCardIndex = Math.max(0, store.cards.length - 1);
    }
    saveStore();
    return { isSuccess: true, value: removed, error: null, statusCode: 200 };
  },

  getSettings() {
    return { ...store.settings };
  },

  updateSettings(updates) {
    Object.assign(store.settings, updates);
    saveStore();
    return { isSuccess: true, value: store.settings, error: null, statusCode: 200 };
  },

  getCurrentCard() {
    const idx = store.settings.currentCardIndex;
    return (store.cards || [])[idx] || null;
  },

  markCardUsed(index) {
    if (!store.cards[index]) return;
    store.cards[index].lastUsed = new Date().toISOString();
    store.cards[index].usageCount = (store.cards[index].usageCount || 0) + 1;
    store.cards[index].status = 'active';
    saveStore();
  },

  markCardExhausted(index) {
    if (!store.cards[index]) return;
    store.cards[index].status = 'exhausted';
    store.cards[index].exhaustedAt = new Date().toISOString();
    saveStore();
  },

  getNextCardIndex() {
    const cards = store.cards || [];
    if (cards.length === 0) return -1;

    const startIdx = store.settings.currentCardIndex;
    for (let i = 1; i <= cards.length; i++) {
      const idx = (startIdx + i) % cards.length;
      if (cards[idx].status === 'ready' || cards[idx].status === 'active') {
        return idx;
      }
    }
    return -1;
  },

  advanceToNextCard() {
    const nextIdx = this.getNextCardIndex();
    if (nextIdx === -1) return null;
    store.settings.currentCardIndex = nextIdx;
    saveStore();
    return store.cards[nextIdx];
  },

  addHistoryEntry(entry) {
    history.unshift({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    if (history.length > 1000) {
      history = history.slice(0, 1000);
    }
    saveHistory();
  },

  getHistory(limit = 50) {
    return history.slice(0, limit);
  },

  getStats() {
    const cards = store.cards || [];
    return {
      total: cards.length,
      ready: cards.filter(c => c.status === 'ready').length,
      active: cards.filter(c => c.status === 'active').length,
      exhausted: cards.filter(c => c.status === 'exhausted').length,
      failed: cards.filter(c => c.status === 'failed').length,
      currentIndex: store.settings.currentCardIndex,
      autoRotation: store.settings.autoRotation,
    };
  },

  reload() {
    loadStore();
    loadHistory();
  },
};

module.exports = sessionStore;
