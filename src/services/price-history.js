const path = require('path');
const fs   = require('fs');
const { getDataDir } = require('./config');

const SEED_PATH = path.join(__dirname, '..', '..', 'price-history.json');

function getHistoryFile() {
  return path.join(getDataDir(), 'price-history.json');
}

function loadHistory() {
  const file = getHistoryFile();
  if (!fs.existsSync(file) && fs.existsSync(SEED_PATH)) {
    fs.copyFileSync(SEED_PATH, file);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

// Returns the price entry { input, cacheWrite5m, cacheWrite1h, cacheRead, output }
// for a modelKey (e.g. 'opus-4.6') effective on the given date (YYYY-MM-DD).
// Pass null/undefined for date to use the latest snapshot.
function getPricingForDate(modelKey, date) {
  if (!modelKey) return null;
  const history = loadHistory();
  if (!history.length) return null;

  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  let snapshot;
  if (!date) {
    snapshot = sorted[sorted.length - 1];
  } else {
    const applicable = sorted.filter(h => h.date <= date);
    snapshot = applicable.length ? applicable[applicable.length - 1] : sorted[0];
  }

  return snapshot.prices.find(p => p.model === modelKey) || null;
}

module.exports = { loadHistory, getPricingForDate };
