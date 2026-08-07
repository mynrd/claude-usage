// Startup/query timing. Every boot phase, IPC handler and hot internal reports
// how long it took and how much filesystem work it did, to `perf.log` next to
// package.json (gitignored via *.log) and to stdout.
//
// Two pieces:
//   time()/timeAsync()/mark() — wall-clock spans, stamped with ms since boot.
//   count()                   — counters (files parsed, bytes read, ms inside a
//                               hot helper) accumulated globally; each timed
//                               span prints the delta accrued while it ran, so
//                               "list-projects took 4200ms {filesParsed: 312,
//                               mbRead: 812}" attributes the cost.

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'perf.log');
const T0 = performance.now();

// Main and the parser worker both append here — tag lines so they're separable.
let TAG = 'main';
function setTag(tag) { TAG = tag; }

let fd;
function out(line) {
  console.log(line);
  try {
    if (fd === undefined) fd = fs.openSync(LOG_FILE, 'a');
    fs.writeSync(fd, line + '\n');
  } catch { fd = null; }
}

const counters = Object.create(null);
function count(name, n = 1) { counters[name] = (counters[name] || 0) + n; }

function snapshot() { return { ...counters }; }
function delta(snap) {
  const d = {};
  for (const k of Object.keys(counters)) {
    const v = counters[k] - (snap[k] || 0);
    if (v) d[k] = Math.round(v * 10) / 10;
  }
  return d;
}

const stamp = () => `+${String(Math.round(performance.now() - T0)).padStart(6)}ms [${TAG}]`;
const extras = (o) => (o && Object.keys(o).length ? ' ' + JSON.stringify(o) : '');

function mark(label, info) {
  out(`${stamp()} [perf] ${label}${extras(info)}`);
}

function time(label, fn) {
  const t = performance.now();
  const snap = snapshot();
  try {
    return fn();
  } finally {
    out(`${stamp()} [perf] ${label} took ${(performance.now() - t).toFixed(1)}ms${extras(delta(snap))}`);
  }
}

async function timeAsync(label, fn) {
  const t = performance.now();
  const snap = snapshot();
  try {
    return await fn();
  } finally {
    out(`${stamp()} [perf] ${label} took ${(performance.now() - t).toFixed(1)}ms${extras(delta(snap))}`);
  }
}

// Time a hot helper into a counter instead of its own log line (called
// thousands of times per query — one line each would drown the log).
function tally(prefix, fn) {
  const t = performance.now();
  try {
    return fn();
  } finally {
    count(prefix + 'Ms', performance.now() - t);
    count(prefix + 'Calls');
  }
}

// Called once by the main process at startup. Keeps one previous log around so
// a long-running session (a refresh every ~2 s) can't grow the file forever.
const MAX_LOG_BYTES = 2 * 1024 * 1024;
function banner(tag) {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch { /* no log yet */ }
  out('');
  out(`=== ${tag} ${new Date().toISOString()} ===`);
}

module.exports = { mark, time, timeAsync, tally, count, banner, setTag, LOG_FILE };
