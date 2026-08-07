// Main-process side of the parser worker: request/response over utilityProcess.
//
// call() resolves when the worker replies. Calls made before the worker is up
// are queued, so IPC handlers registered at startup work without ordering rules.
// If the worker dies, pending calls reject and the next call respawns it —
// a crash in the parser degrades to one failed refresh, not a dead app.

const path = require('path');
const { utilityProcess, app } = require('electron');
const perf = require('./perf');

let child = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject, onProgress }

function spawn() {
  child = utilityProcess.fork(path.join(__dirname, 'usage-worker.js'), [], {
    serviceName: 'claude-usage-parser',
    stdio: 'inherit',
  });

  readyPromise = new Promise((resolve) => {
    child.once('spawn', () => {
      perf.mark('parser worker spawned');
      send({ id: nextId++, op: 'init', args: { userDataDir: app.getPath('userData') } });
      resolve();
    });
  });

  child.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'progress') {
      const p = pending.get(msg.id);
      if (p && p.onProgress) p.onProgress(msg.payload);
      return;
    }
    if (msg.type !== 'reply') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'worker error'));
  });

  child.on('exit', (code) => {
    perf.mark('parser worker exited', { code });
    for (const [, p] of pending) p.reject(new Error('parser worker exited'));
    pending.clear();
    child = null;
    readyPromise = null;
  });
}

function send(msg) { child.postMessage(msg); }

async function ensure() {
  if (!child) spawn();
  await readyPromise;
}

async function call(op, args, onProgress) {
  await ensure();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    send({ id, op, args });
  });
}

// Fire-and-forget: used on quit, where waiting for a reply would hold up exit.
function notify(op, args) {
  if (child) send({ id: nextId++, op, args });
}

function start() { return ensure(); }

function stop() {
  if (!child) return;
  try { child.kill(); } catch {}
  child = null;
}

module.exports = { start, call, notify, stop };
