const path = require('path');
const fs   = require('fs');
const { getDataDir } = require('./config');

const SEED_PATH = path.join(__dirname, '..', '..', 'price-history.json');

function getHistoryFile() {
  return path.join(getDataDir(), 'price-history.json');
}

// Parsed once and memoized — cost calc runs per record (hundreds of thousands
// of lookups per refresh). Edits to the live file require an app restart,
// which the README already documents.
let _history = null;

function loadHistory() {
  if (_history) return _history;
  const file = getHistoryFile();
  if (!fs.existsSync(file) && fs.existsSync(SEED_PATH)) {
    fs.copyFileSync(SEED_PATH, file);
  }
  let history;
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
  // Merge seed snapshots the live copy doesn't have yet (by date), so repo
  // pricing updates reach existing installs. Dates already in the live file
  // are left alone - snapshots saved via the in-app editor always win.
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    const have = new Set(history.map(h => h.date));
    const missing = seed.filter(s => s && s.date && !have.has(s.date));
    if (missing.length) {
      history.push(...missing);
      fs.writeFileSync(file, JSON.stringify(history, null, 2));
    }
  } catch { /* seed absent or unreadable - live copy stands alone */ }
  _history = history;
  return _history;
}

// Latest snapshot ({ date, prices }) or null — what the in-app pricing editor shows.
function getLatestSnapshot() {
  const history = loadHistory();
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  return sorted[sorted.length - 1];
}

// Append a snapshot effective `date` (YYYY-MM-DD) to the live file. History
// stays append-only across days — only a same-day snapshot is replaced, so
// corrections don't stack duplicates. Earlier usage keeps its historical rates.
function saveSnapshot(prices, date) {
  const file = getHistoryFile();
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const idx = history.findIndex(h => h.date === date);
  if (idx >= 0) history[idx] = { date, prices };
  else history.push({ date, prices });
  fs.writeFileSync(file, JSON.stringify(history, null, 2));
  _history = null; // drop the memo so new lookups see the new rates
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

module.exports = { loadHistory, getPricingForDate, getLatestSnapshot, saveSnapshot };
