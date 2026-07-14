const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'favorites.json');

let favorites = [];

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadStore() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      favorites = JSON.parse(raw);
      if (!Array.isArray(favorites)) favorites = [];
    }
  } catch (err) {
    logger.error('Failed to load favorites', err.message);
    favorites = [];
  }
}

function saveStore() {
  try {
    ensureDataDir();
    fs.writeFileSync(DATA_FILE, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save favorites', err.message);
  }
}

function normalizeMac(mac) {
  if (!mac) return '';
  return mac.toUpperCase().replace(/[-:]/g, ':').replace(/(^:|:$)/g, '');
}

loadStore();

function findIdx(mac) {
  const n = normalizeMac(mac);
  return n ? favorites.findIndex(f => normalizeMac(f.mac) === n) : -1;
}

const favoriteStore = {
  getAll() {
    return favorites;
  },

  getWithIp() {
    return favorites.filter(f => f.ip);
  },

  isFavorite(mac) {
    return findIdx(mac) >= 0;
  },

  findByIp(ip) {
    if (!ip) return null;
    return favorites.find(f => f.ip === ip) || null;
  },

  toggle(mac, label = '') {
    const n = normalizeMac(mac);
    if (!n) return { isSuccess: false, value: null, error: 'Invalid MAC', statusCode: 400 };
    const idx = findIdx(n);
    if (idx >= 0) {
      favorites.splice(idx, 1);
      saveStore();
      logger.info(`Favorite removed: ${mac}`);
      return { isSuccess: true, value: { mac, favorited: false }, error: null, statusCode: 200 };
    }
    favorites.push({ mac: n, label: label || n, addedAt: new Date().toISOString() });
    saveStore();
    logger.info(`Favorite added: ${n} (${label || 'no label'})`);
    return { isSuccess: true, value: { mac: n, favorited: true }, error: null, statusCode: 201 };
  },

  add(mac, label = '', ip = '') {
    const n = normalizeMac(mac);
    if (!n) return { isSuccess: false, value: null, error: 'Invalid MAC', statusCode: 400 };
    const idx = findIdx(n);
    if (idx >= 0) {
      if (ip && favorites[idx].ip !== ip) { favorites[idx].ip = ip; saveStore(); }
      return { isSuccess: true, value: { mac: n, favorited: true }, error: null, statusCode: 200 };
    }
    favorites.push({ mac: n, label: label || n, ip: ip || '', addedAt: new Date().toISOString() });
    saveStore();
    logger.info(`Favorite added: ${n} (${label || 'no label'})${ip ? ' @ ' + ip : ''}`);
    return { isSuccess: true, value: { mac: n, favorited: true, ip: ip || '' }, error: null, statusCode: 201 };
  },

  remove(mac) {
    const idx = findIdx(mac);
    if (idx < 0) return { isSuccess: false, value: null, error: 'Not found', statusCode: 404 };
    favorites.splice(idx, 1);
    saveStore();
    return { isSuccess: true, value: { mac: normalizeMac(mac), removed: true }, error: null, statusCode: 200 };
  },

  clear() {
    favorites = [];
    saveStore();
    return { isSuccess: true, value: null, error: null, statusCode: 200 };
  },
};

module.exports = favoriteStore;
