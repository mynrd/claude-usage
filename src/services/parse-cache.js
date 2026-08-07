// Persists the transcript parse caches across restarts.
//
// Parsing is the whole cost of a refresh: a cold start read 352 MB of JSONL and
// blocked for 1.3 s, and the in-memory cache died with the process, so every
// launch paid it again. On disk, a launch instead stats the files (already done
// by the scan index) and re-parses only the ones whose size/mtime moved.
//
// Layout — models and record keys are the bulk of the bytes, so records are
// stored as tuples with the model interned into a table:
//   { version, priceSig, models: [...], files: { path: {s,z,h,p,t,a,r} }, subagents: {...} }
//   r tuple = [key, ts, modelIndex, input, output, cacheCreate, cacheRead]
//
// priceSig invalidates the subagent cache when rates change (those aggregates
// bake in computed costs; the file cache holds raw tokens and always survives).

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./config');
const { getLatestSnapshot } = require('./price-history');
const { mark, count } = require('./perf');

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 4000;

function cacheFile() { return path.join(getDataDir(), 'parse-cache.json'); }

function priceSig() {
  try {
    const snap = getLatestSnapshot();
    return snap ? `${snap.date}:${(snap.prices || []).length}` : 'none';
  } catch { return 'none'; }
}

function load(fileCache, subagentCache) {
  const file = cacheFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { mark('parse-cache: none on disk'); return false; }

  let data;
  try { data = JSON.parse(raw); } catch { mark('parse-cache: unreadable, ignoring'); return false; }
  if (!data || data.version !== VERSION) { mark('parse-cache: version mismatch, ignoring'); return false; }

  const models = data.models || [];
  let files = 0, records = 0;
  for (const [absPath, e] of Object.entries(data.files || {})) {
    fileCache.set(absPath, {
      sig: e.s,
      size: e.z,
      head: e.h,
      parsedBytes: e.p,
      title: e.t ?? null,
      agentSpawnIds: e.a || [],
      records: (e.r || []).map(([key, ts, mi, input, output, cacheCreate, cacheRead]) => ({
        key, ts, model: mi === -1 ? null : models[mi], input, output, cacheCreate, cacheRead,
      })),
    });
    files++;
    records += (e.r || []).length;
  }

  // Costs are baked into subagent aggregates — drop them if rates moved.
  let subs = 0;
  if (data.priceSig === priceSig()) {
    for (const [key, v] of Object.entries(data.subagents || {})) {
      subagentCache.set(key, v);
      subs++;
    }
  }

  mark('parse-cache loaded', { files, records, subagentSessions: subs, mb: Math.round(raw.length / 1048576 * 10) / 10 });
  return true;
}

function serialize(fileCache, subagentCache) {
  const modelIndex = new Map();
  const models = [];
  const mi = (m) => {
    if (m == null) return -1;
    let i = modelIndex.get(m);
    if (i === undefined) { i = models.push(m) - 1; modelIndex.set(m, i); }
    return i;
  };

  // Drop entries for transcripts that no longer exist, so the cache doesn't
  // accumulate deleted sessions forever. Paths in the current index are free
  // to check; anything else costs one stat.
  const scan = require('./scan-index');
  const files = {};
  for (const [absPath, e] of fileCache) {
    if (!scan.statFor(absPath)) continue;
    files[absPath] = {
      s: e.sig, z: e.size, h: e.head, p: e.parsedBytes, t: e.title, a: e.agentSpawnIds,
      r: e.records.map(r => [r.key, r.ts, mi(r.model), r.input, r.output, r.cacheCreate, r.cacheRead]),
    };
  }

  // Same pruning for subagent aggregates, keyed "<folder>/<sessionId>".
  const projectsDir = require('./paths').getClaudeProjectsDir();
  const subagents = {};
  for (const [key, v] of subagentCache) {
    const cut = key.lastIndexOf('/');
    if (cut > 0 && !scan.statFor(path.join(projectsDir, key.slice(0, cut), key.slice(cut + 1) + '.jsonl'))) continue;
    subagents[key] = v;
  }

  return JSON.stringify({ version: VERSION, priceSig: priceSig(), models, files, subagents });
}

function saveNow(fileCache, subagentCache) {
  const t0 = performance.now();
  const file = cacheFile();
  const tmp = file + '.tmp';
  try {
    const json = serialize(fileCache, subagentCache);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);   // atomic — a killed app never leaves a half file
    mark('parse-cache saved', { mb: Math.round(json.length / 1048576 * 10) / 10, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    mark('parse-cache save failed', { error: e.message });
    try { fs.unlinkSync(tmp); } catch {}
  }
}

let timer = null;
function scheduleSave(fileCache, subagentCache) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; saveNow(fileCache, subagentCache); }, SAVE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

function flush(fileCache, subagentCache) {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  saveNow(fileCache, subagentCache);
}

function drop() {
  try { fs.unlinkSync(cacheFile()); } catch {}
}

module.exports = { load, scheduleSave, saveNow, flush, drop, cacheFile };
