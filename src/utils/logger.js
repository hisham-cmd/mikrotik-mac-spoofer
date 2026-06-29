const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024;

let currentLevel = 'info';

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size >= MAX_LOG_SIZE) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(LOG_FILE, LOG_FILE.replace('.log', `-${timestamp}.log`));
      }
    }
  } catch (err) {
    console.error(`Log rotation failed: ${err.message}`);
  }
}

function formatMessage(level, message, data) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (data !== undefined) {
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
      if (str.length > 2000) {
        line += ` ${str.substring(0, 2000)}...`;
      } else {
        line += ` ${str}`;
      }
    } catch {
      line += ' [circular]';
    }
  }
  return line;
}

function writeLog(level, message, data) {
  if (LOG_LEVELS[level] > LOG_LEVELS[currentLevel]) return;
  ensureLogDir();
  rotateLog();
  const line = formatMessage(level, message, data) + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    console.error(`Log write failed: ${err.message}`);
  }
  if (level === 'error') {
    console.error(line.trim());
  } else {
    console.log(line.trim());
  }
}

const logger = {
  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) currentLevel = level;
  },
  error(message, data) { writeLog('error', message, data); },
  warn(message, data) { writeLog('warn', message, data); },
  info(message, data) { writeLog('info', message, data); },
  debug(message, data) { writeLog('debug', message, data); },
};

module.exports = logger;
