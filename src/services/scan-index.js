// One directory sweep of ~/.claude/projects, shared by every query.
//
// Before this, a single refresh statted the same files three times over:
// listSessionFilesOldestFirst() statted every .jsonl to sort by mtime,
// sessionLastWriteMs() statted each one again plus walked its subagent tree,
// and subagentDirSignature() walked that tree a third time — then
// get-rate-windows ran right behind list-projects and repeated all of it.
// Measured at ~130 ms of pure syscalls per refresh on 1214 session files,
// every 2 s while Claude Code is writing.
//
// The index is built once and reused for a short window (queries in one
// refresh burst share it) and dropped whenever the file watcher fires.

const fs = require('fs');
const path = require('path');
const { getClaudeProjectsDir } = require('./paths');
const { count } = require('./perf');

let _index = null;
let _builtAt = 0;

// <folder>/<sessionId>/subagents/**.jsonl — plain subagents sit flat, workflow
// researchers nest one level deeper, so walk the whole tree.
function walkAgentFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkAgentFiles(full, out);
    else if (ent.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(full);
        out.push({ file: full, size: st.size, mtime: Math.round(st.mtimeMs) });
      } catch { /* vanished mid-scan */ }
    }
  }
}

function buildIndex() {
  const t0 = performance.now();
  const dir = getClaudeProjectsDir();
  const folders = [];
  const byPath = new Map();   // abs .jsonl path -> { size, mtime }

  let folderNames = [];
  try { folderNames = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}

  for (const folder of folderNames) {
    const folderPath = path.join(dir, folder);
    const sessions = [];

    let entries = [];
    try { entries = fs.readdirSync(folderPath, { withFileTypes: true }); } catch { continue; }

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(folderPath, ent.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const sessionId = ent.name.slice(0, -'.jsonl'.length);

      const subFiles = [];
      walkAgentFiles(path.join(folderPath, sessionId, 'subagents'), subFiles);
      subFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

      const mtime = Math.round(st.mtimeMs);
      let lastWriteMs = mtime;
      for (const sf of subFiles) if (sf.mtime > lastWriteMs) lastWriteMs = sf.mtime;

      const s = {
        sessionId, name: ent.name, file, size: st.size, mtime, subFiles, lastWriteMs,
        // Same signature getSessionSubagents used to recompute per query.
        subSig: subFiles.map(f => `${path.relative(folderPath, f.file)}:${f.size}:${f.mtime}`).join('|'),
      };
      sessions.push(s);
      byPath.set(file, s);
      for (const sf of subFiles) byPath.set(sf.file, sf);
    }

    if (!sessions.length) continue;
    // Oldest-first: a resumed session copies history into a new file, and
    // folder-scoped dedup must credit the original (PLANNING.md D3).
    sessions.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    folders.push({ folder, path: folderPath, sessions });
  }

  count('scanIndexMs', performance.now() - t0);
  count('scanIndexBuilds');
  return { dir, folders, byPath, builtAt: Date.now() };
}

// maxAgeMs 0 forces a rebuild. The default lets the queries fired by one
// refresh (list-projects, then get-rate-windows) share a single sweep.
function getIndex(maxAgeMs = 1500) {
  if (_index && performance.now() - _builtAt < maxAgeMs) {
    count('scanIndexReused');
    return _index;
  }
  _index = buildIndex();
  _builtAt = performance.now();
  return _index;
}

function invalidate() { _index = null; }

// The index entry for a path, without a fresh statSync — session entries also
// carry lastWriteMs and subSig. Falls back to a plain stat for paths outside
// the current index (chat viewer opening an arbitrary file, etc).
function statFor(absPath) {
  const idx = _index;
  const hit = idx && idx.byPath.get(absPath);
  if (hit) return hit;
  try {
    const st = fs.statSync(absPath);
    return { size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch { return null; }
}

function getFolder(folder) {
  return getIndex().folders.find(f => f.folder === folder) || null;
}

function getSession(folder, sessionId) {
  const f = getFolder(folder);
  return f ? f.sessions.find(s => s.sessionId === sessionId) || null : null;
}

module.exports = { getIndex, invalidate, statFor, getFolder, getSession };
