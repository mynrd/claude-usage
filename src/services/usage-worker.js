// Transcript parser, running in an Electron utilityProcess.
//
// Everything that reads ~/.claude/projects lives here. The main process only
// routes IPC, so a 1.3 s cold scan no longer freezes the window: handlers in
// the main process now await a message instead of running the scan inline.
//
// Protocol (structured clone, both directions):
//   in   { id, op, args }
//   out  { type: 'reply',    id, ok, result | error }
//        { type: 'progress', id, payload }
//        { type: 'ready' }

const perf = require('./perf');
perf.setTag('worker');

const { setUserDataDir } = require('./config');
const parseCache = require('./parse-cache');
const scan = require('./scan-index');
const projects = require('./projects');
const { getStatsCache } = require('./stats-cache');

let caches = null;

function post(msg) { process.parentPort.postMessage(msg); }

// Any op that can grow the caches schedules a debounced write-back.
function touched() {
  if (caches) parseCache.scheduleSave(caches.fileCache, caches.subagentCache);
}

const ops = {
  init({ userDataDir }) {
    setUserDataDir(userDataDir);
    caches = projects.getCaches();
    perf.time('parse-cache load', () => parseCache.load(caches.fileCache, caches.subagentCache));
    return { ok: true };
  },

  // Fresh directory sweep on the next query — called when the watcher fires.
  invalidateScan() { scan.invalidate(); return true; },

  listProjects({ startDate, endDate, includeSub }, onProgress) {
    const r = projects.listLocalProjects(startDate, endDate, includeSub, onProgress);
    touched();
    return r;
  },

  projectDetail({ folder, startDate, endDate, includeSub }) {
    const r = projects.getProjectDetail(folder, startDate, endDate, includeSub);
    touched();
    return r;
  },

  todaySummary({ includeSub }) { const r = projects.getTodayLocalSummary(includeSub); touched(); return r; },
  analytics({ startDate, endDate, includeSub }) { const r = projects.getAggregatedDailyTotals(startDate, endDate, includeSub); touched(); return r; },
  rateWindows({ includeSub }) { const r = projects.getRateWindows(includeSub); touched(); return r; },
  sessionChat({ folder, sessionId }) { return projects.getSessionChat(folder, sessionId); },
  sessionSubagents({ folder, sessionId }) { const r = projects.getSessionSubagents(folder, sessionId); touched(); return r; },
  searchSessions({ folder, query }) { return projects.searchSessions(folder, query); },
  statsCache() { return getStatsCache(); },

  clearCostCaches() {
    require('./price-history').resetHistory();  // main wrote new rates
    projects.clearCostCaches();
    parseCache.drop();                 // stale costs on disk too
    if (caches) parseCache.saveNow(caches.fileCache, caches.subagentCache);
    return true;
  },

  flushCache() {
    if (caches) parseCache.flush(caches.fileCache, caches.subagentCache);
    return true;
  },
};

process.parentPort.on('message', (e) => {
  const { id, op, args } = e.data || {};
  const fn = ops[op];
  if (!fn) { post({ type: 'reply', id, ok: false, error: `unknown op: ${op}` }); return; }

  const onProgress = (payload) => post({ type: 'progress', id, payload });
  try {
    const result = perf.time(`worker ${op}`, () => fn(args || {}, onProgress));
    post({ type: 'reply', id, ok: true, result });
  } catch (err) {
    perf.mark(`worker ${op} failed`, { error: err.message });
    post({ type: 'reply', id, ok: false, error: err.message });
  }
});

post({ type: 'ready' });
