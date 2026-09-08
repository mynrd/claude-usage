const path = require('path');
const fs = require('fs');
const os = require('os');
const { calcCost, calcCostBreakdown } = require('./pricing');
const { count, tally } = require('./perf');
const { getClaudeProjectsDir } = require('./paths');
const scan = require('./scan-index');

// Bucket by the user's local calendar day — toISOString() is UTC and would
// shift early-morning usage onto the previous day.
function localDay(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function modelFamily(m) {
  const match = (m || '').match(/fable|mythos|opus|sonnet|haiku/);
  return match ? match[0] : 'other';
}

// Claude Code writes the JSONL during streaming, so one API response
// (message.id + requestId) appears as several lines, each carrying a copy of
// the usage object — raw sums overcount 2-20x (PLANNING.md F1/F2). Per key,
// each usage category counts once at the highest value observed: identical
// duplicate rows contribute 0; placeholder→final rows converge to the final
// value. Returns the per-category delta to add, plus `first` (first sighting
// of the key — used for turn counts). Rows without an id count as-is.
// Takes a compact usage row: { key | id+requestId, input, output, cacheCreate,
// cacheCreate1h, cacheRead, thinking }.
// `key` is the pre-joined `id:requestId` cached rows carry (one string instead
// of two shrinks the on-disk parse cache noticeably).
function createUsageDeduper() {
  const seen = new Map();
  return (row) => {
    const cur = {
      input: row.input || 0,
      output: row.output || 0,
      cacheCreate: row.cacheCreate || 0,
      cacheCreate1h: row.cacheCreate1h || 0,
      cacheRead: row.cacheRead || 0,
      thinking: row.thinking || 0,
    };
    const key = row.key !== undefined ? row.key : (row.id ? row.id + ':' + (row.requestId || '') : null);
    if (!key) return { ...cur, first: true };
    const prev = seen.get(key);
    if (!prev) { seen.set(key, cur); return { ...cur, first: true }; }
    const delta = { first: false };
    for (const c of ['input', 'output', 'cacheCreate', 'cacheCreate1h', 'cacheRead', 'thinking']) {
      delta[c] = cur[c] > prev[c] ? cur[c] - prev[c] : 0;
      if (cur[c] > prev[c]) prev[c] = cur[c];
    }
    return delta;
  };
}

// ── Per-file parse cache ──────────────────────────────────────────────────────
// Parsing the JSONL is the expensive part (MBs of text per file, re-read on
// every refresh). Cache each file's extracted usage rows keyed by size+mtime.
// Dedup is folder-scoped (resumed sessions copy history across files), so rows
// are cached PRE-dedupe and the deduper is replayed per query — cheap, since
// it iterates small in-memory arrays instead of re-parsing megabytes.
// entry: { sig, size, head, parsedBytes, title, agentSpawnIds, records }
//   head       — base64 of the first HEAD_BYTES, to prove the file wasn't rewritten
//   parsedBytes— offset of the byte after the last complete line consumed
const _fileCache = new Map();
const HEAD_BYTES = 256;

function readRange(absPath, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return read === len ? buf : buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Usage shapes that would silently undercount if Claude Code starts emitting
// them. Both are zero in every transcript seen so far; count them per file so
// the modal can say so instead of quietly reporting a low number.
//   multiIter  — `usage.iterations` with more than one element: only the
//                outer counters are summed here, so extra iterations are lost.
//   webSearch/webFetch — server tool calls that bill per request, not per
//                token, so no amount of token math prices them.
//   fastMode   — `usage.speed: "fast"`: the same model billed at roughly twice
//                the standard rate, which the rate cards here do not carry.
function newFlags() { return { multiIter: 0, webSearch: 0, webFetch: 0, fastMode: 0 }; }

function tallyFlags(flags, u) {
  if (u.iterations && u.iterations.length > 1) flags.multiIter++;
  if (u.speed === 'fast') flags.fastMode++;
  const stu = u.server_tool_use;
  if (stu) {
    flags.webSearch += stu.web_search_requests || 0;
    flags.webFetch  += stu.web_fetch_requests  || 0;
  }
}

function anyFlags(f) {
  return !!f && (f.multiIter > 0 || f.webSearch > 0 || f.webFetch > 0 || f.fastMode > 0);
}

// A message the user personally typed. `user` records also carry tool results,
// slash-command markup, IDE context, task notifications, compact summaries and
// meta records - none of those count. Rules verified against every transcript
// on this machine.
const NOT_PROMPT_PREFIXES = ['<command-name', '<command-message', '<local-command-stdout', '<local-command-caveat', '<task-notification', '<bash-input', '[Request interrupted'];
function isHumanPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isCompactSummary) return false;
  if (rec.origin && rec.origin.kind !== 'human') return false;
  const ct = rec.message?.content;
  let text, hasImage = false;
  if (typeof ct === 'string') {
    text = ct;
  } else if (Array.isArray(ct)) {
    hasImage = ct.some(b => b.type === 'image');
    if (!hasImage && !ct.some(b => b.type === 'text')) return false;
    // The CLI prepends <ide_opened_file> / <ide_selection> blocks to what the user typed.
    text = ct.filter(b => b.type === 'text' && !(b.text || '').trim().startsWith('<ide_')).map(b => b.text || '').join('\n');
  } else {
    return false;
  }
  text = text.trim();
  if (!text && !hasImage) return false;
  return !NOT_PROMPT_PREFIXES.some(p => text.startsWith(p));
}

// Feed complete lines into an entry. Returns the number of bytes consumed —
// a trailing partial line (Claude is mid-write) is left for the next pass.
function parseInto(entry, buf) {
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return 0;
  const flags = entry.flags || (entry.flags = newFlags());
  const prompts = entry.prompts || (entry.prompts = []);
  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'ai-title' && rec.aiTitle) entry.title = rec.aiTitle;
      if (isHumanPrompt(rec)) prompts.push({ uuid: rec.uuid || null, ts: rec.timestamp ? Date.parse(rec.timestamp) : null, model: null });
      if (rec.type !== 'assistant') continue;
      // Attribute the latest unanswered prompt to the model that replied. Works
      // across tail parses; a prompt the next prompt overtakes stays null.
      const model = rec.message?.model;
      if (model && model !== '<synthetic>' && prompts.length) {
        const last = prompts[prompts.length - 1];
        if (last.model === null) last.model = model;
      }
      if (Array.isArray(rec.message?.content)) {
        for (const b of rec.message.content) {
          if (b.type === 'tool_use' && b.name === 'Agent') entry.agentSpawnIds.push(b.id || null);
        }
      }
      if (rec.message?.usage) {
        const u = rec.message.usage;
        const id = rec.message.id || null;
        tallyFlags(flags, u);
        entry.records.push({
          key: id ? id + ':' + (rec.requestId || '') : null,
          ts: rec.timestamp ? Date.parse(rec.timestamp) : null,
          model: rec.message.model || null,
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          // Subset of output_tokens, not additional — display only, never priced.
          thinking: u.output_tokens_details?.thinking_tokens || 0,
        });
      }
    } catch {}
  }
  return lastNl + 1;
}

function getFileUsage(absPath) {
  const st = scan.statFor(absPath);
  if (!st) return null;
  const sig = `${st.size}:${st.mtime}`;
  const hit = _fileCache.get(absPath);
  if (hit && hit.sig === sig) { count('sessionFilesCached'); return hit; }

  const t0 = performance.now();

  // Transcripts are append-only, so a file that only grew is parsed from where
  // the last pass stopped. Without this, an active session's multi-MB
  // transcript was re-read in full on every 2 s watcher tick.
  if (hit && st.size > hit.parsedBytes && hit.head) {
    const head = readRange(absPath, 0, Math.min(HEAD_BYTES, st.size)).toString('base64');
    if (head === hit.head) {
      const buf = readRange(absPath, hit.parsedBytes, st.size);
      hit.parsedBytes += parseInto(hit, buf);
      hit.sig = sig;
      hit.size = st.size;
      count('sessionFilesTailed');
      count('sessionTailMbRead', buf.length / 1048576);
      count('sessionParseMs', performance.now() - t0);
      return hit;
    }
  }

  count('sessionFilesParsed');
  count('sessionMbRead', st.size / 1048576);
  const entry = { sig, size: st.size, head: null, parsedBytes: 0, title: null, agentSpawnIds: [], records: [], flags: newFlags(), prompts: [] };
  let buf = Buffer.alloc(0);
  try { buf = fs.readFileSync(absPath); } catch {}
  entry.head = buf.subarray(0, HEAD_BYTES).toString('base64');
  entry.parsedBytes = parseInto(entry, buf);
  _fileCache.set(absPath, entry);
  count('sessionParseMs', performance.now() - t0);
  return entry;
}

// Folder scans share one deduper across session files (resumed/branched
// sessions copy history into new files in the same folder). Scan oldest-first
// so the original session keeps its tokens and a resumed copy dedups to only
// its new turns (PLANNING.md D3). Order comes from the shared scan index.
function listSessionFilesOldestFirst(dir) {
  const folder = scan.getIndex().folders.find(f => f.path === dir);
  return folder ? folder.sessions.map(s => s.name) : [];
}

// Walk a file's human prompts: skip resume-copied duplicates (seenPrompts is
// folder scoped; files arrive oldest-first so the original keeps the prompt)
// and apply the same date filter the usage rows use. onEach(prompt, dt).
function countPrompts(entry, seenPrompts, dtStart, dtEnd, onEach) {
  for (const p of (entry ? entry.prompts : [])) {
    if (p.uuid) {
      if (seenPrompts.has(p.uuid)) continue;
      seenPrompts.add(p.uuid);
    }
    const dt = p.ts != null ? new Date(p.ts) : null;
    if ((dtStart || dtEnd) && !dt) continue;
    if (dt && dtStart && dt < dtStart) continue;
    if (dt && dtEnd   && dt > dtEnd)   continue;
    onEach(p, dt);
  }
}

// Probing the filesystem to un-encode a folder name is stable for the life of
// the process — memoize it instead of redoing 31 existsSync sweeps per query.
const _nameCache = new Map();
function resolveProjectName(folder) {
  const hit = _nameCache.get(folder);
  if (hit) return hit;
  const res = tally('resolveProjectName', () => resolveProjectNameUncached(folder));
  _nameCache.set(folder, res);
  return res;
}

function resolveProjectNameUncached(folder) {
  const wtIdx = folder.indexOf('--claude-worktrees-');
  const encoded = wtIdx >= 0 ? folder.substring(0, wtIdx) : folder;

  const driveMatch = encoded.match(/^([A-Za-z])--(.*)$/);
  if (!driveMatch) return { displayName: encoded, fullPath: encoded };

  const drive = driveMatch[1] + ':\\';
  const segments = driveMatch[2].split('-').filter(Boolean);
  let currentPath = drive;
  let i = 0;

  while (i < segments.length) {
    let matched = false;
    for (let j = segments.length; j > i; j--) {
      const hyphenated = segments.slice(i, j).join('-');
      const spaced     = segments.slice(i, j).join(' ');
      for (const candidate of [hyphenated, spaced]) {
        try {
          if (fs.existsSync(path.join(currentPath, candidate))) {
            currentPath = path.join(currentPath, candidate);
            i = j;
            matched = true;
            break;
          }
        } catch {}
      }
      if (matched) break;
    }
    if (!matched) { currentPath = path.join(currentPath, segments[i]); i++; }
  }

  return { displayName: path.basename(currentPath), fullPath: currentPath.replace(/\\/g, '/') };
}

// onProgress({ done, total, project }) fires after each folder so the UI can
// fill the list as results land instead of waiting for the whole scan.
function listLocalProjects(startDate, endDate, includeSub = false, onProgress = null) {
  const index = scan.getIndex();

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const projects = [];
  const total = index.folders.length;
  let done = 0;
  for (const entry of index.folders) {
    const folder = entry.folder;
    const fullPath = entry.path;
    const jsonlFiles = entry.sessions.map(s => s.name);

    const { displayName, fullPath: projectPath } = resolveProjectName(folder);
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    const seenPrompts = new Set();
    let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;
    let totalCost = 0, totalSavings = 0, lastActive = null, sessionCount = 0, hasMatchingRecords = false;
    let messageCount = 0;

    let lastWriteMs = 0;
    for (const jf of jsonlFiles) {
      let sessionHasMatch = false;
      let sInput = 0, sOutput = 0, sCacheCreate = 0, sCacheRead = 0, sCost = 0, sSavings = 0;
      const w = sessionLastWriteMs(fullPath, jf);
      if (w > lastWriteMs) lastWriteMs = w;
      const entry = getFileUsage(path.join(fullPath, jf));
      let sMessages = 0;
      countPrompts(entry, seenPrompts, dtStart, dtEnd, () => { sMessages++; });
      if (sMessages) hasMatchingRecords = true;
      messageCount += sMessages;
      for (const row of (entry ? entry.records : [])) {
        const dt = row.ts != null ? new Date(row.ts) : null;
        if ((dtStart || dtEnd) && !dt) continue;
        if (dt && dtStart && dt < dtStart) continue;
        if (dt && dtEnd   && dt > dtEnd)   continue;
        const d = dedupe(row);
        sInput += d.input;
        sOutput += d.output;
        sCacheCreate += d.cacheCreate;
        sCacheRead += d.cacheRead;
        const day = dt ? localDay(dt) : null;
        const bd = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, row.model, day, d.cacheCreate1h);
        sCost += bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
        sSavings += bd.cacheReadSavings;
        sessionHasMatch = true;
        hasMatchingRecords = true;
        if (dt && (!lastActive || dt > lastActive)) lastActive = dt;
      }
      if (sessionHasMatch) {
        sessionCount++;
        totalInput += sInput;
        totalOutput += sOutput;
        totalCacheCreate += sCacheCreate;
        totalCacheRead += sCacheRead;
        totalCost += sCost;
        totalSavings += sSavings;
      }

      if (includeSub) {
        const sub = getSessionSubagents(folder, jf.replace('.jsonl', ''));
        if (sub.agentCount) {
          const s = sumSubagentRange(sub.daily, dtStart, dtEnd);
          if (s.input || s.output || s.cacheCreate || s.cacheRead) {
            totalInput += s.input; totalOutput += s.output;
            totalCacheCreate += s.cacheCreate; totalCacheRead += s.cacheRead;
            totalCost += s.cost;
            totalSavings += s.savings;
            hasMatchingRecords = true;
          }
        }
      }
    }

    let project = null;
    if ((!dtStart && !dtEnd) || hasMatchingRecords) {
      project = {
        folder, name: displayName, fullPath: projectPath,
        sessionCount, messageCount, totalInput, totalOutput, totalCacheCreate, totalCacheRead,
        totalTokens: totalInput + totalOutput + totalCacheCreate + totalCacheRead,
        totalCost, totalSavings, lastActive: lastActive ? lastActive.toISOString() : null,
        lastWriteMs,
      };
      projects.push(project);
    }
    done++;
    if (onProgress) onProgress({ done, total, project });
  }

  return projects.sort((a, b) => {
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return new Date(b.lastActive) - new Date(a.lastActive);
  });
}

// Most recent write across a session's main transcript and its subagent tree.
// Drives the "Claude is working" indicator: file mtime captures every write
// (tool results, progress, streaming) — usage-record timestamps don't, they
// go stale mid-turn during long tool runs.
function sessionLastWriteMs(dir, jf) {
  const s = scan.statFor(path.join(dir, jf));
  return s && s.lastWriteMs !== undefined ? s.lastWriteMs : (s ? s.mtime : 0);
}

function getProjectDetail(folder, startDate, endDate, includeSub = false) {
  const dir = path.join(getClaudeProjectsDir(), folder);
  if (!fs.existsSync(dir)) return { sessions: [], dailyTotals: [] };

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const sessions = [];
  const dailyMap = {};
  const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
  const seenAgentSpawns = new Set();   // streamed lines repeat tool_use blocks (D4)
  const seenPrompts = new Set();
  const newModelUsage = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, cost: 0, savings: 0, thinking: 0, messages: 0 });
  const newDay = (day) => ({ date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, messages: 0 });

  for (const jf of listSessionFilesOldestFirst(dir)) {
    const sessionId = jf.replace('.jsonl', '');
    let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;
    let firstTs = null, lastTs = null;
    let subagentCount = 0;
    let messages = 0;
    const models = new Set();
    const modelUsage = {};

    const entry = getFileUsage(path.join(dir, jf));
    const title = entry ? entry.title : null;
    for (const aid of (entry ? entry.agentSpawnIds : [])) {
      if (!aid || !seenAgentSpawns.has(aid)) {
        if (aid) seenAgentSpawns.add(aid);
        subagentCount++;
      }
    }
    // Unreplied prompts (model null) count for the session but for no model row.
    countPrompts(entry, seenPrompts, dtStart, dtEnd, (p, dt) => {
      messages++;
      if (p.model) {
        if (!modelUsage[p.model]) modelUsage[p.model] = newModelUsage();
        modelUsage[p.model].messages++;
      }
      if (dt) {
        const day = localDay(dt);
        if (!dailyMap[day]) dailyMap[day] = newDay(day);
        dailyMap[day].messages++;
      }
    });
    for (const row of (entry ? entry.records : [])) {
      const dt = row.ts != null ? new Date(row.ts) : null;
      if ((dtStart || dtEnd) && !dt) continue;
      if (dt && dtStart && dt < dtStart) continue;
      if (dt && dtEnd   && dt > dtEnd)   continue;
      const recModel = row.model;
      const d = dedupe(row);
      input       += d.input;
      output      += d.output;
      cacheCreate += d.cacheCreate;
      cacheRead   += d.cacheRead;
      const day = dt ? localDay(dt) : null;
      const bd  = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, recModel, day, d.cacheCreate1h);
      const recCost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
      cost += recCost;
      if (recModel && recModel !== '<synthetic>') {
        models.add(recModel);
        if (!modelUsage[recModel]) modelUsage[recModel] = newModelUsage();
        const mu = modelUsage[recModel];
        mu.savings         += bd.cacheReadSavings;
        mu.thinking        += d.thinking;
        mu.input           += d.input;
        mu.output          += d.output;
        mu.cacheCreate     += d.cacheCreate;
        mu.cacheRead       += d.cacheRead;
        mu.inputCost       += bd.input;
        mu.outputCost      += bd.output;
        mu.cacheCreateCost += bd.cacheCreate;
        mu.cacheReadCost   += bd.cacheRead;
        mu.cost            += recCost;
      }
      if (dt) {
        if (!firstTs || dt < firstTs) firstTs = dt;
        if (!lastTs  || dt > lastTs)  lastTs  = dt;
        if (!dailyMap[day]) dailyMap[day] = newDay(day);
        dailyMap[day].input       += d.input;
        dailyMap[day].output      += d.output;
        dailyMap[day].cacheCreate += d.cacheCreate;
        dailyMap[day].cacheRead   += d.cacheRead;
        dailyMap[day].cost        += recCost;
      }
    }

    if (includeSub) {
      const sub = getSessionSubagents(folder, sessionId);
      if (sub.agentCount) {
        const s = sumSubagentRange(sub.daily, dtStart, dtEnd);
        input += s.input; output += s.output;
        cacheCreate += s.cacheCreate; cacheRead += s.cacheRead;
        cost += s.cost;
        // Roll subagent spend into the per-day totals for this project's chart.
        for (const [day, v] of Object.entries(sub.daily)) {
          if (dtStart || dtEnd) {
            const d = new Date(day + 'T12:00:00');
            if (dtStart && d < dtStart) continue;
            if (dtEnd && d > dtEnd) continue;
          }
          if (!dailyMap[day]) dailyMap[day] = newDay(day);
          dailyMap[day].input += v.input; dailyMap[day].output += v.output;
          dailyMap[day].cacheCreate += v.cacheCreate; dailyMap[day].cacheRead += v.cacheRead;
          dailyMap[day].cost += v.cost;
        }
      }
    }

    const total = input + output + cacheCreate + cacheRead;
    if (total > 0 || messages > 0) {
      sessions.push({
        sessionId, title, subagentCount, models: [...models], messages,
        input, output, cacheCreate, cacheRead, total, cost,
        ...(anyFlags(entry && entry.flags) ? { flags: entry.flags } : {}),
        modelUsage: Object.entries(modelUsage).map(([model, u]) => ({ model, ...u })),
        startedAt: firstTs ? firstTs.toISOString() : null,
        lastAt:    lastTs  ? lastTs.toISOString()  : null,
        lastWriteMs: sessionLastWriteMs(dir, jf),
      });
    }
  }

  sessions.sort((a, b) => {
    if (!a.lastAt) return 1;
    if (!b.lastAt) return -1;
    return new Date(b.lastAt) - new Date(a.lastAt);
  });

  return { sessions, dailyTotals: Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date)) };
}

function getTodayLocalSummary(includeSub = false) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return { input: 0, output: 0, total: 0, cost: 0, messages: 0 };

  const today = localDay(new Date());
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0, messages = 0;

  for (const fEntry of scan.getIndex().folders) {
    const folder = fEntry.folder;
    const fullPath = fEntry.path;
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    const seenPrompts = new Set();
    for (const jf of fEntry.sessions.map(s => s.name)) {
      const entry = getFileUsage(path.join(fullPath, jf));
      const rows = entry ? entry.records : [];
      const sessionModel = (rows.find(r => r.model) || {}).model || null;
      countPrompts(entry, seenPrompts, null, null, (p, dt) => { if (dt && localDay(dt) === today) messages++; });
      for (const row of rows) {
        if (row.ts == null) continue;
        if (localDay(new Date(row.ts)) !== today) continue;
        const d = dedupe(row);
        input += d.input; output += d.output; cacheCreate += d.cacheCreate; cacheRead += d.cacheRead;
        cost += calcCost(d.input, d.output, d.cacheCreate, d.cacheRead, row.model || sessionModel, today, d.cacheCreate1h);
      }

      if (includeSub) {
        const sub = getSessionSubagents(folder, jf.replace('.jsonl', ''));
        const d = sub.daily && sub.daily[today];
        if (d) {
          input += d.input; output += d.output; cacheCreate += d.cacheCreate; cacheRead += d.cacheRead;
          cost += d.cost;
        }
      }
    }
  }
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead, cost, messages };
}

const _agentModelCache = {};
// Resolve a subagent's default model from its definition file's frontmatter.
// Looks in the project-local .claude/agents first, then the global ~/.claude/agents.
// Returns null when no definition is found (caller treats that as "inherits parent").
function resolveAgentDefaultModel(projectPath, agentType) {
  if (!agentType) return null;
  const key = (projectPath || '') + '|' + agentType;
  if (key in _agentModelCache) return _agentModelCache[key];

  const candidates = [];
  if (projectPath) candidates.push(path.join(projectPath, '.claude', 'agents', agentType + '.md'));
  candidates.push(path.join(os.homedir(), '.claude', 'agents', agentType + '.md'));

  let model = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      const m = fm[1].match(/^model:\s*(.+?)\s*$/m);
      if (m) { model = m[1].trim(); break; }
    } catch {}
  }
  _agentModelCache[key] = model;
  return model;
}

// F7 (PLANNING.md): top-level record types beyond user/assistant/attachment
// carry session events — hook runs, API errors/retries, mode flips, queue
// operations, file snapshots, … New types appear as Claude Code evolves.
// Known shapes map to a compact `event` row; anything unrecognized surfaces
// raw (kind 'unknown') so it is visible in the UI, never silently dropped.
// Same contract as the attachment branch — see CLAUDE.md.
function contextEventPart(rec) {
  const ev = (label, text, raw) => ({ type: 'attachment', kind: 'event', label, text: text || '', raw: raw || null });
  const rawPart = (label) => ({ type: 'attachment', kind: 'unknown', attachType: label, isRecord: true, raw: rec });
  switch (rec.type) {
    case 'system': {
      const st = rec.subtype;
      if (st === 'compact_boundary') {
        const m = rec.compactMetadata;
        const detail = m ? ` (${m.trigger}, ${(m.preTokens || 0).toLocaleString()} → ${(m.postTokens || 0).toLocaleString()} tokens)` : '';
        return ev('Compacted', (rec.content || 'Conversation compacted') + detail);
      }
      if (st === 'api_error') {
        const e = rec.error || {};
        const retry = rec.retryAttempt ? ` — retry ${rec.retryAttempt}/${rec.maxRetries}` : '';
        return ev('API error', (e.formatted || e.message || '') + retry, rec);
      }
      if (st === 'stop_hook_summary') {
        const n = rec.hookCount || (rec.hookInfos || []).length;
        const ms = (rec.hookInfos || []).reduce((a, h) => a + (h.durationMs || 0), 0);
        const errs = (rec.hookErrors || []).length;
        return ev('Stop hook', `${n} hook${n === 1 ? '' : 's'}, ${ms} ms${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}`, rec);
      }
      if (st === 'turn_duration') return ev('Turn', `${((rec.durationMs || 0) / 1000).toFixed(1)}s · ${rec.messageCount || 0} messages`);
      if (st === 'away_summary') return ev('Recap', rec.content || '');
      if (st === 'informational') return ev('Info', rec.content || '');
      if (st === 'scheduled_task_fire') return ev('Scheduled', rec.content || '');
      // local_command content is the same <command-name>… markup user messages
      // carry — reuse the Command chip renderer via a text part.
      if (st === 'local_command' && rec.content) return { type: 'text', text: rec.content };
      return rawPart('system: ' + (st || 'unknown'));
    }
    case 'progress': {
      const d = rec.data || {};
      if (d.type === 'hook_progress') return ev('Hook', d.hookName || d.hookEvent || '', rec);
      if (d.type === 'agent_progress') return ev('Agent progress', '', rec);
      return rawPart('progress: ' + (d.type || 'unknown'));
    }
    case 'queue-operation': {
      if (rec.operation === 'enqueue') return ev('Queued', rec.content || '');
      if (rec.operation === 'dequeue') return ev('Dequeued', rec.content || '');
      if (rec.operation === 'remove')  return ev('Unqueued', rec.content || '');
      return rawPart('queue-operation: ' + (rec.operation || 'unknown'));
    }
    case 'last-prompt': return ev('Last prompt', rec.lastPrompt || '');
    case 'file-history-snapshot': {
      const n = Object.keys(rec.snapshot?.trackedFileBackups || {}).length;
      return ev('File snapshot', n ? `${n} file${n === 1 ? '' : 's'} tracked` : 'no tracked files');
    }
    case 'mode': return ev('Mode', rec.mode || '');
    case 'permission-mode': return ev('Permissions', rec.permissionMode || '');
    case 'teleported-from': return ev('Teleported', `from remote session${rec.messageCount ? ` (${rec.messageCount} messages)` : ''}`);
    case 'ai-title': return ev('Title', rec.aiTitle || '');
    default: return rawPart(rec.type || 'unknown');
  }
}

function getSessionChat(folder, sessionId) {
  const fpath = path.join(getClaudeProjectsDir(), folder, sessionId + '.jsonl');
  if (!fs.existsSync(fpath)) return [];

  const { fullPath: projectPath } = resolveProjectName(folder);

  const messages = [];
  // Post-compact context (re-read files / referenced files) arrives as a run of
  // `attachment` records. Buffer consecutive ones into a single "Context" message
  // so they render as one card in sequence, like the CLI's post-compact summary.
  let pendingAttach = null;
  const flushAttach = () => {
    if (pendingAttach && pendingAttach.parts.length) messages.push(pendingAttach);
    pendingAttach = null;
  };
  for (const line of fs.readFileSync(fpath, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'attachment' && rec.attachment) {
        const a = rec.attachment;
        let part = null;
        if (a.type === 'file' && a.displayPath) {
          let numLines = null;
          try {
            const c = typeof a.content === 'string' ? JSON.parse(a.content) : a.content;
            numLines = c?.file?.numLines ?? null;
          } catch {}
          part = { type: 'attachment', kind: 'file', displayPath: a.displayPath, numLines };
        } else if (a.type === 'compact_file_reference' && a.displayPath) {
          part = { type: 'attachment', kind: 'reference', displayPath: a.displayPath };
        } else if (a.type === 'edited_text_file' && a.filename) {
          part = { type: 'attachment', kind: 'edited', displayPath: a.displayPath || a.filename };
        } else if (a.type === 'nested_memory' && a.displayPath) {
          part = { type: 'attachment', kind: 'memory', displayPath: a.displayPath };
        } else if (a.type === 'queued_command') {
          const txt = Array.isArray(a.prompt) ? a.prompt.map(b => b?.text || '').join(' ').trim() : '';
          if (txt) part = { type: 'attachment', kind: 'queued', text: txt };
        } else if (a.type === 'date_change' && a.newDate) {
          part = { type: 'attachment', kind: 'date', text: a.newDate };
        } else {
          // Never silently drop a context record. Anything we don't yet render
          // nicely is surfaced raw (collapsed JSON) so new/unknown shapes are
          // visible and can be reported, then designed properly. See CLAUDE.md.
          part = { type: 'attachment', kind: 'unknown', attachType: a.type || 'unknown', raw: a };
        }
        if (part) {
          if (!pendingAttach) pendingAttach = { role: 'attachment', parts: [], timestamp: rec.timestamp || null };
          pendingAttach.parts.push(part);
        }
        continue;
      }
      // F7: every other top-level record type renders as a context event row
      // (or raw when unrecognized) — never silently dropped.
      if (rec.type !== 'user' && rec.type !== 'assistant') {
        const part = contextEventPart(rec);
        if (!pendingAttach) pendingAttach = { role: 'attachment', parts: [], timestamp: rec.timestamp || null };
        pendingAttach.parts.push(part);
        continue;
      }
      flushAttach();
      if ((rec.type === 'user' || rec.type === 'assistant') && rec.message?.content) {
        const content = rec.message.content;
        const parts = [];

        if (typeof content === 'string') {
          parts.push({ type: 'text', text: content });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              let inputStr = '';
              if      (block.name === 'Bash')               inputStr = block.input?.command   || '';
              else if (block.name === 'Edit' || block.name === 'Write' || block.name === 'Read') inputStr = block.input?.file_path || '';
              else if (block.name === 'Glob' || block.name === 'Grep') inputStr = block.input?.pattern  || '';
              else    inputStr = JSON.stringify(block.input || {});
              const part = { type: 'tool_use', tool: block.name, input: inputStr, id: block.id };
              if (block.name === 'Agent') {
                part.agentType = block.input?.subagent_type || null;
                const override = block.input?.model || null;
                if (override) {
                  part.agentModel = override;
                  part.agentModelSource = 'override';
                } else {
                  const def = resolveAgentDefaultModel(projectPath, part.agentType);
                  part.agentModel = def;                       // null => inherits parent
                  part.agentModelSource = def ? 'default' : 'inherit';
                }
              }
              parts.push(part);
            } else if (block.type === 'tool_result') {
              const resultContent = typeof block.content === 'string' ? block.content
                : Array.isArray(block.content) ? block.content.map(b => {
                    if (typeof b === 'string') return b;
                    if (b.text) return b.text;
                    if (b.type === 'tool_reference') return b.tool_name || '';
                    return JSON.stringify(b);
                  }).join('\n') : '';
              const part = { type: 'tool_result', content: resultContent, isError: block.is_error || false, toolUseId: block.tool_use_id || null };
              const usageMatch = resultContent.match(/<usage>([\s\S]*?)<\/usage>/);
              if (usageMatch) {
                const uText = usageMatch[1];
                const totalMatch = uText.match(/(?:subagent_tokens|total_tokens):\s*(\d+)/);
                const toolMatch = uText.match(/tool_uses:\s*(\d+)/);
                const durMatch = uText.match(/duration_ms:\s*(\d+)/);
                part.agentUsage = {
                  totalTokens: totalMatch ? parseInt(totalMatch[1]) : 0,
                  toolUses: toolMatch ? parseInt(toolMatch[1]) : 0,
                  durationMs: durMatch ? parseInt(durMatch[1]) : 0,
                };
              }
              parts.push(part);
            } else if (block.type === 'image' && block.source) {
              parts.push({ type: 'image', mediaType: block.source.media_type || 'image/png', data: block.source.data || '' });
            }
          }
        }

        if (parts.length > 0) {
          let role = rec.type;
          if (rec.type === 'user' && !parts.some(p => p.type === 'text' || p.type === 'image')) role = 'tool';
          const msg = { role, parts, timestamp: rec.timestamp || null };
          if (rec.isCompactSummary) msg.isCompactSummary = true;
          if (rec.type === 'assistant') {
            const model = rec.message.model;
            if (model && model !== '<synthetic>') msg.model = model;
            const u = rec.message.usage;
            if (u) {
              msg.usage = {
                input: u.input_tokens || 0,
                output: u.output_tokens || 0,
                cacheCreate: u.cache_creation_input_tokens || 0,
                cacheRead: u.cache_read_input_tokens || 0,
              };
            }
          }
          messages.push(msg);
        }
      }
    } catch {}
  }
  flushAttach();
  return reorderToolResults(messages);
}

// Subagent / agent-teams transcripts live in <folder>/<sessionId>/subagents/agent-*.jsonl
// and are NOT reflected in the session's headline totals (which cover only the main
// thread). Parse them and aggregate token spend per teammate, so the detail modal can
// surface the (often much larger) team cost.
//
// These transcripts are large (tens of MB for an active team), so results are cached
// keyed by a cheap signature (file count + sizes + mtimes); unchanged sessions are not
// re-parsed. The cache makes the "include subagents" fold-in across every project load
// affordable.
const _subagentCache = new Map();

// Plain Task/team subagents sit flat in <subagents>/agent-*.jsonl, but Workflow
// researchers nest one level deeper: <subagents>/workflows/<wf-id>/agent-*.jsonl.
// Walk the whole tree so a fan-out's transcripts are counted too — otherwise the
// detail modal shows only the main thread and silently drops the (often far larger)
// workflow cost.
function listAgentTranscripts(subdir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(subdir);
  // Deterministic scan order: a turn shared by several teammate files is
  // attributed to the first (sorted) file that contains it (PLANNING.md D3).
  return out.sort();
}

function subagentDirSignature(subdir) {
  try {
    const files = listAgentTranscripts(subdir).sort();
    return files.map(f => {
      const st = fs.statSync(f);
      return `${path.relative(subdir, f)}:${st.size}:${Math.round(st.mtimeMs)}`;
    }).join('|');
  } catch { return ''; }
}

function getSessionSubagents(folder, sessionId) {
  // File list and signature come from the shared scan index — this used to
  // walk the subagent tree twice per session on every query.
  const sess = scan.getSession(folder, sessionId);
  const subdir = path.join(getClaudeProjectsDir(), folder, sessionId, 'subagents');
  const agentFiles = sess ? sess.subFiles.map(f => f.file) : listAgentTranscripts(subdir);
  if (!agentFiles.length) return { agentCount: 0, agents: [], totals: null, daily: {}, records: [], flags: null };

  const cacheKey = folder + '/' + sessionId;
  const sig = sess ? sess.subSig : tally('subagentDirSig', () => subagentDirSignature(subdir));
  const cached = _subagentCache.get(cacheKey);
  if (cached && cached.sig === sig) { count('subagentSessionsCached'); return cached.result; }
  const _t0 = performance.now();
  count('subagentSessionsParsed');

  const byName = {};
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, savings: 0, thinking: 0 };
  const flags = newFlags();
  const daily = {}; // day -> { input, output, cacheCreate, cacheRead, cost, savings, costByModel }
  const records = []; // post-dedupe { ts, input, output, cacheCreate, cacheRead, cost } for rate windows
  let agentCount = 0;

  const newAcc = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, savings: 0, thinking: 0, toolUses: 0, turns: 0 });

  // Agent-team teammates each persist a copy of shared conversation turns, so
  // dedup must span ALL agent files of the session together (PLANNING.md F2/D2).
  // Tool calls in a shared turn would likewise count once per teammate file —
  // dedup them by tool_use block id across the session (D4).
  const dedupe = createUsageDeduper();
  const seenToolUseIds = new Set();

  for (const jfPath of agentFiles) {
    let firstUser = null;
    // Wall clock spans every record type, not just assistant ones, so time the
    // agent spent waiting on its own tool calls counts.
    let firstTs = null, lastTs = null;
    // Accumulate per model within the transcript — a subagent can run on more than
    // one model (e.g. an opus thread that delegates a step to haiku), and those have
    // different rate cards, so they must never be summed into one row.
    const perModel = {};
    const ensure = (m) => perModel[m] || (perModel[m] = newAcc());

    try {
      count('subagentFilesParsed');
      count('subagentMbRead', (scan.statFor(jfPath)?.size || 0) / 1048576);
      for (const line of fs.readFileSync(jfPath, 'utf8').trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.timestamp) {
            const t = Date.parse(rec.timestamp);
            if (!Number.isNaN(t)) {
              if (firstTs === null || t < firstTs) firstTs = t;
              if (lastTs === null || t > lastTs) lastTs = t;
            }
          }
          if (firstUser === null && rec.type === 'user' && typeof rec.message?.content === 'string') {
            firstUser = rec.message.content;
          }
          if (rec.type !== 'assistant') continue;
          const model = rec.message?.model || null;
          const mk = (model && model !== '<synthetic>') ? model : 'unknown';
          if (Array.isArray(rec.message?.content)) {
            for (const b of rec.message.content) {
              if (b.type !== 'tool_use') continue;
              if (b.id && seenToolUseIds.has(b.id)) { ensure(mk); continue; }
              if (b.id) seenToolUseIds.add(b.id);
              ensure(mk).toolUses++;
            }
          }
          if (rec.message?.usage) {
            const u = rec.message.usage;
            tallyFlags(flags, u);
            const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
            const day = ts != null ? localDay(new Date(ts)) : null;
            const d = dedupe({
              id: rec.message.id || null,
              requestId: rec.requestId || null,
              input: u.input_tokens || 0,
              output: u.output_tokens || 0,
              cacheCreate: u.cache_creation_input_tokens || 0,
              cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
              cacheRead: u.cache_read_input_tokens || 0,
              thinking: u.output_tokens_details?.thinking_tokens || 0,
            });
            const bd = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, model, day, d.cacheCreate1h);
            const recCost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
            const e = ensure(mk);
            e.input += d.input; e.output += d.output; e.cacheCreate += d.cacheCreate; e.cacheRead += d.cacheRead;
            e.cost += recCost;
            e.inputCost += bd.input; e.outputCost += bd.output;
            e.cacheCreateCost += bd.cacheCreate; e.cacheReadCost += bd.cacheRead;
            e.savings += bd.cacheReadSavings;
            e.thinking += d.thinking;
            if (d.first) e.turns++;
            if (ts != null) records.push({ ts, input: d.input, output: d.output, cacheCreate: d.cacheCreate, cacheRead: d.cacheRead, cost: recCost });
            if (day) {
              if (!daily[day]) daily[day] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0, costByModel: {} };
              daily[day].input += d.input; daily[day].output += d.output;
              daily[day].cacheCreate += d.cacheCreate; daily[day].cacheRead += d.cacheRead;
              daily[day].cost += recCost;
              daily[day].savings += bd.cacheReadSavings;
              const fam = modelFamily(model);
              daily[day].costByModel[fam] = (daily[day].costByModel[fam] || 0) + recCost;
            }
          }
        } catch {}
      }
    } catch { continue; }

    // Identity, most authoritative first:
    //  1. the agent-<id>.meta.json sidecar carries the spawning agentType
    //     (e.g. "designer", "Explore", "angular-expert") — present for both
    //     plain Task subagents and team members.
    //  2. agent-teams members also self-identify as: You are "name".
    //  3. otherwise a neutral fallback.
    let name = null;
    try {
      const meta = JSON.parse(fs.readFileSync(jfPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (meta && meta.agentType) name = meta.agentType;
    } catch { /* no sidecar */ }
    if (!name) {
      const idMatch = firstUser && firstUser.match(/You are ["“]([^"”]+)["”]/);
      name = (idMatch && idMatch[1]) || 'subagent';
    }

    let fileHadActivity = false;
    for (const [mk, e] of Object.entries(perModel)) {
      // A perModel entry only exists if the file had real assistant records for
      // that model. Keep the row even when dedup left it at zero tokens (a
      // teammate whose turns are all shared, attributed to an earlier file) —
      // dropping it would make the transcript silently missing.
      const total = e.input + e.output + e.cacheCreate + e.cacheRead;
      fileHadActivity = true;

      // One row per (teammate, model) so each row maps to a single rate card.
      const key = name + ' ' + mk;
      const g = byName[key] || (byName[key] = { name, model: mk, spawns: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, thinking: 0, toolUses: 0, turns: 0, durationMs: 0 });
      g.spawns++;
      g.input += e.input; g.output += e.output; g.cacheCreate += e.cacheCreate; g.cacheRead += e.cacheRead;
      g.total += total; g.cost += e.cost; g.toolUses += e.toolUses; g.turns += e.turns;
      g.inputCost += e.inputCost; g.outputCost += e.outputCost; g.cacheCreateCost += e.cacheCreateCost; g.cacheReadCost += e.cacheReadCost;
      g.thinking += e.thinking;
      // The span is per transcript, so a file that ran two models attributes its
      // whole span to both rows — wall time has no per-model split.
      if (firstTs !== null && lastTs > firstTs) g.durationMs += lastTs - firstTs;

      totals.input += e.input; totals.output += e.output; totals.cacheCreate += e.cacheCreate;
      totals.cacheRead += e.cacheRead; totals.total += total; totals.cost += e.cost;
      totals.inputCost += e.inputCost; totals.outputCost += e.outputCost;
      totals.cacheCreateCost += e.cacheCreateCost; totals.cacheReadCost += e.cacheReadCost;
      totals.savings += e.savings;
      totals.thinking += e.thinking;
    }
    if (fileHadActivity) agentCount++;
  }

  const agents = Object.values(byName)
    .map(g => ({ ...g, models: [g.model] }))
    .sort((a, b) => b.cost - a.cost || b.total - a.total);

  const result = { agentCount, agents, totals: agentCount ? totals : null, daily, records, flags: anyFlags(flags) ? flags : null };
  _subagentCache.set(cacheKey, { sig, result });
  count('subagentParseMs', performance.now() - _t0);
  return result;
}

// Drop caches that bake in computed costs (the file cache only holds raw token
// rows, so it survives a price change untouched).
function clearCostCaches() {
  _subagentCache.clear();
}

// Sum a subagent daily-breakdown map over an optional [dtStart, dtEnd] window.
// Day-granular (subagent records are bucketed by calendar day); date filters are
// day-aligned so this matches the main-thread per-record filtering closely enough.
function sumSubagentRange(daily, dtStart, dtEnd) {
  const acc = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0 };
  if (!daily) return acc;
  for (const [day, v] of Object.entries(daily)) {
    if (dtStart || dtEnd) {
      const d = new Date(day + 'T12:00:00');
      if (dtStart && d < dtStart) continue;
      if (dtEnd && d > dtEnd) continue;
    }
    acc.input += v.input; acc.output += v.output;
    acc.cacheCreate += v.cacheCreate; acc.cacheRead += v.cacheRead;
    acc.cost += v.cost;
    acc.savings += v.savings || 0;
  }
  return acc;
}

// Tool calls fired in parallel get their results streamed back interleaved and
// out of order in the JSONL. Re-place each single tool_result message directly
// after the message containing its matching tool_use, so call -> result stays
// adjacent in the chat view. Orphan results (no tool_use_id) and batched
// multi-result messages keep their original position.
function reorderToolResults(messages) {
  const movable = new Map(); // tool_use_id -> result message
  for (const m of messages) {
    if (m.parts.length === 1 && m.parts[0].type === 'tool_result' && m.parts[0].toolUseId) {
      m.__key = m.parts[0].toolUseId;
      movable.set(m.__key, m);
    }
  }
  if (movable.size === 0) return messages;

  const out = [];
  const placed = new Set();
  for (const m of messages) {
    if (m.__key) continue; // a movable result — emitted via its call below
    out.push(m);
    for (const p of m.parts) {
      if (p.type === 'tool_use' && p.id && movable.has(p.id) && !placed.has(p.id)) {
        out.push(movable.get(p.id));
        placed.add(p.id);
      }
    }
  }
  // results whose call wasn't found — keep them rather than drop
  for (const m of messages) {
    if (m.__key && !placed.has(m.__key)) out.push(m);
  }
  for (const m of out) delete m.__key;
  return out;
}

// ── Rate-limit windows ────────────────────────────────────────────────────────
// Anthropic's subscription limits meter 5-hour session windows: a window opens
// with the first message and expires 5 hours later; the next message after
// expiry opens a new one. Reconstructed here from record timestamps across ALL
// projects (main threads + subagents, post-dedupe). Window starts are floored
// to the hour — community convention; exact anchoring is not officially
// documented. Token counts are exact; how Anthropic weighs them against the
// quota is not public, so no percentage is computed here.
function getRateWindows(includeSub = true) {
  const WIN_MS = 5 * 3600 * 1000;
  const dir = getClaudeProjectsDir();
  const empty = { current: null, week: { total: 0, cost: 0 }, avgWindowTotal: 0, windowCount: 0, now: Date.now() };
  if (!fs.existsSync(dir)) return empty;

  const events = []; // { ts, input, output, cacheCreate, cacheRead, cost }
  for (const fEntry of scan.getIndex().folders) {
    const folder = fEntry.folder;
    const fullPath = fEntry.path;
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    for (const jf of fEntry.sessions.map(s => s.name)) {
      const entry = getFileUsage(path.join(fullPath, jf));
      const rows = entry ? entry.records : [];
      const sessionModel = (rows.find(r => r.model) || {}).model || null;
      for (const row of rows) {
        const d = dedupe(row);
        if (row.ts == null) continue;
        const total = d.input + d.output + d.cacheCreate + d.cacheRead;
        if (!total) continue;
        const day = localDay(new Date(row.ts));
        events.push({
          ts: row.ts, input: d.input, output: d.output, cacheCreate: d.cacheCreate, cacheRead: d.cacheRead,
          cost: calcCost(d.input, d.output, d.cacheCreate, d.cacheRead, row.model || sessionModel, day, d.cacheCreate1h),
        });
      }
      if (includeSub) {
        const sub = getSessionSubagents(folder, jf.replace('.jsonl', ''));
        for (const r of (sub.records || [])) {
          if (r.input + r.output + r.cacheCreate + r.cacheRead) events.push(r);
        }
      }
    }
  }
  if (!events.length) return empty;
  events.sort((a, b) => a.ts - b.ts);

  const windows = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.ts >= cur.end) {
      const start = Math.floor(e.ts / 3600000) * 3600000;
      cur = { start, end: start + WIN_MS, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0 };
      windows.push(cur);
    }
    cur.input += e.input; cur.output += e.output;
    cur.cacheCreate += e.cacheCreate; cur.cacheRead += e.cacheRead;
    cur.total += e.input + e.output + e.cacheCreate + e.cacheRead;
    cur.cost += e.cost;
  }

  const now = Date.now();
  const last = windows[windows.length - 1];
  const current = now < last.end ? last : null;

  const weekStart = now - 7 * 86400000;
  const week = { total: 0, cost: 0 };
  for (const e of events) {
    if (e.ts >= weekStart) { week.total += e.input + e.output + e.cacheCreate + e.cacheRead; week.cost += e.cost; }
  }

  // Typical pace: average of the last 20 completed windows.
  const completed = windows.filter(w => w !== current).slice(-20);
  const avgWindowTotal = completed.length
    ? Math.round(completed.reduce((a, w) => a + w.total, 0) / completed.length)
    : 0;

  return { current, week, avgWindowTotal, windowCount: windows.length, now };
}

function searchSessions(folder, query) {
  const dir = path.join(getClaudeProjectsDir(), folder);
  if (!fs.existsSync(dir)) return [];

  const q = query.toLowerCase();
  const matching = new Set();

  for (const jf of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const sessionId = jf.replace('.jsonl', '');
    try {
      for (const line of fs.readFileSync(path.join(dir, jf), 'utf8').trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ai-title' && rec.aiTitle?.toLowerCase().includes(q)) { matching.add(sessionId); break; }
          if ((rec.type === 'user' || rec.type === 'assistant') && rec.message?.content) {
            const content = rec.message.content;
            const searchable = typeof content === 'string' ? content : Array.isArray(content)
              ? content.map(b => {
                  if (b.type === 'text')        return b.text || '';
                  if (b.type === 'tool_use')    return (b.name || '') + ' ' + (b.input?.command || b.input?.file_path || b.input?.pattern || '');
                  if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : '';
                  return '';
                }).join('\n')
              : '';
            if (searchable.toLowerCase().includes(q)) { matching.add(sessionId); break; }
          }
        } catch {}
      }
    } catch {}
  }
  return [...matching];
}

function getAggregatedDailyTotals(startDate, endDate, includeSub = false) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return { dailyTotals: [], projectTotals: [] };

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const dailyMap = {};
  const projectMap = {};

  for (const fEntry of scan.getIndex().folders) {
    const folder = fEntry.folder;
    const fullPath = fEntry.path;
    const jsonlFiles = fEntry.sessions.map(s => s.name);

    const { displayName } = resolveProjectName(folder);
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    const seenPrompts = new Set();
    let pInput = 0, pOutput = 0, pCacheCreate = 0, pCacheRead = 0, pCost = 0, pMessages = 0;

    const ensureDay = (day) => dailyMap[day] || (dailyMap[day] = { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0, costByModel: {}, messages: 0, messagesByModel: {} });

    for (const jf of jsonlFiles) {
      const entry = getFileUsage(path.join(fullPath, jf));
      // messagesByModel is keyed by full model id; 'no-reply' = no assistant reply followed.
      countPrompts(entry, seenPrompts, dtStart, dtEnd, (p, dt) => {
        pMessages++;
        if (!dt) return;
        const dm = ensureDay(localDay(dt));
        dm.messages++;
        const key = p.model || 'no-reply';
        dm.messagesByModel[key] = (dm.messagesByModel[key] || 0) + 1;
      });
      for (const row of (entry ? entry.records : [])) {
        const dt = row.ts != null ? new Date(row.ts) : null;
        if ((dtStart || dtEnd) && !dt) continue;
        if (dt && dtStart && dt < dtStart) continue;
        if (dt && dtEnd   && dt > dtEnd)   continue;
        const d = dedupe(row);
        const day = dt ? localDay(dt) : null;
        const bd = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, row.model, day, d.cacheCreate1h);
        const cost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;

        pInput += d.input; pOutput += d.output; pCacheCreate += d.cacheCreate; pCacheRead += d.cacheRead; pCost += cost;

        if (dt) {
          const dm = ensureDay(day);
          dm.input       += d.input;
          dm.output      += d.output;
          dm.cacheCreate += d.cacheCreate;
          dm.cacheRead   += d.cacheRead;
          dm.cost        += cost;
          dm.savings     += bd.cacheReadSavings;
          const fam = modelFamily(row.model);
          dm.costByModel[fam] = (dm.costByModel[fam] || 0) + cost;
        }
      }

      if (includeSub) {
        const sub = getSessionSubagents(folder, jf.replace('.jsonl', ''));
        if (sub.agentCount) {
          for (const [day, v] of Object.entries(sub.daily)) {
            if (dtStart || dtEnd) {
              const d = new Date(day + 'T12:00:00');
              if (dtStart && d < dtStart) continue;
              if (dtEnd && d > dtEnd) continue;
            }
            pInput += v.input; pOutput += v.output; pCacheCreate += v.cacheCreate; pCacheRead += v.cacheRead; pCost += v.cost;
            const dm = ensureDay(day);
            dm.input += v.input; dm.output += v.output;
            dm.cacheCreate += v.cacheCreate; dm.cacheRead += v.cacheRead;
            dm.cost += v.cost;
            dm.savings += v.savings || 0;
            for (const [fam, c] of Object.entries(v.costByModel || {})) {
              dm.costByModel[fam] = (dm.costByModel[fam] || 0) + c;
            }
          }
        }
      }
    }

    const pTotal = pInput + pOutput + pCacheCreate + pCacheRead;
    if (pTotal > 0) {
      projectMap[folder] = { name: displayName, input: pInput, output: pOutput, cacheCreate: pCacheCreate, cacheRead: pCacheRead, total: pTotal, cost: pCost, messages: pMessages };
    }
  }

  const dailyTotals = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const projectTotals = Object.values(projectMap).sort((a, b) => b.total - a.total);

  return { dailyTotals, projectTotals };
}

// The parse caches are handed to parse-cache.js so they can survive a restart —
// a cold start otherwise re-reads every transcript on disk (352 MB here).
function getCaches() { return { fileCache: _fileCache, subagentCache: _subagentCache }; }

module.exports = { getClaudeProjectsDir, listLocalProjects, getProjectDetail, getTodayLocalSummary, getSessionChat, getSessionSubagents, searchSessions, getAggregatedDailyTotals, getRateWindows, clearCostCaches, getCaches, isHumanPrompt };
