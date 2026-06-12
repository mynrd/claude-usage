const path = require('path');
const fs = require('fs');
const os = require('os');
const { calcCost, calcCostBreakdown } = require('./pricing');

function getClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code writes the JSONL during streaming, so one API response
// (message.id + requestId) appears as several lines, each carrying a copy of
// the usage object — raw sums overcount 2-20x (PLANNING.md F1/F2). Per key,
// each usage category counts once at the highest value observed: identical
// duplicate rows contribute 0; placeholder→final rows converge to the final
// value. Returns the per-category delta to add, plus `first` (first sighting
// of the key — used for turn counts). Records without message.id count as-is.
function createUsageDeduper() {
  const seen = new Map();
  return (rec) => {
    const u = rec.message.usage;
    const cur = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
    };
    const id = rec.message.id;
    if (!id) return { ...cur, first: true };
    const key = id + ':' + (rec.requestId || '');
    const prev = seen.get(key);
    if (!prev) { seen.set(key, cur); return { ...cur, first: true }; }
    const delta = { first: false };
    for (const c of ['input', 'output', 'cacheCreate', 'cacheRead']) {
      delta[c] = cur[c] > prev[c] ? cur[c] - prev[c] : 0;
      if (cur[c] > prev[c]) prev[c] = cur[c];
    }
    return delta;
  };
}

// Folder scans share one deduper across session files (resumed/branched
// sessions copy history into new files in the same folder). Scan oldest-first
// so the original session keeps its tokens and a resumed copy dedups to only
// its new turns (PLANNING.md D3).
function listSessionFilesOldestFirst(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      let mtime = 0;
      try { mtime = Math.round(fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
      return { f, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
    .map(x => x.f);
}

function resolveProjectName(folder) {
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

function listLocalProjects(startDate, endDate, includeSub = false) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return [];

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const projects = [];
  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const jsonlFiles = listSessionFilesOldestFirst(fullPath);
    if (jsonlFiles.length === 0) continue;

    const { displayName, fullPath: projectPath } = resolveProjectName(folder);
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0;
    let totalCost = 0, lastActive = null, sessionCount = 0, hasMatchingRecords = false;

    for (const jf of jsonlFiles) {
      let sessionHasMatch = false;
      let sInput = 0, sOutput = 0, sCacheCreate = 0, sCacheRead = 0, sCost = 0;
      const sModels = new Set();
      try {
        for (const line of fs.readFileSync(path.join(fullPath, jf), 'utf8').trim().split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'assistant' && rec.message?.usage) {
              const dt = rec.timestamp ? new Date(rec.timestamp) : null;
              if ((dtStart || dtEnd) && !dt) continue;
              if (dt && dtStart && dt < dtStart) continue;
              if (dt && dtEnd   && dt > dtEnd)   continue;
              const model = rec.message.model || null;
              const d = dedupe(rec);
              sInput += d.input;
              sOutput += d.output;
              sCacheCreate += d.cacheCreate;
              sCacheRead += d.cacheRead;
              if (model && model !== '<synthetic>') sModels.add(model);
              const day = dt ? dt.toISOString().split('T')[0] : null;
              sCost += calcCost(d.input, d.output, d.cacheCreate, d.cacheRead, model, day);
              sessionHasMatch = true;
              hasMatchingRecords = true;
              if (dt && (!lastActive || dt > lastActive)) lastActive = dt;
            }
          } catch {}
        }
      } catch {}
      if (sessionHasMatch) {
        sessionCount++;
        totalInput += sInput;
        totalOutput += sOutput;
        totalCacheCreate += sCacheCreate;
        totalCacheRead += sCacheRead;
        totalCost += sCost;
      }

      if (includeSub) {
        const sub = getSessionSubagents(folder, jf.replace('.jsonl', ''));
        if (sub.agentCount) {
          const s = sumSubagentRange(sub.daily, dtStart, dtEnd);
          if (s.input || s.output || s.cacheCreate || s.cacheRead) {
            totalInput += s.input; totalOutput += s.output;
            totalCacheCreate += s.cacheCreate; totalCacheRead += s.cacheRead;
            totalCost += s.cost;
            hasMatchingRecords = true;
          }
        }
      }
    }

    if ((!dtStart && !dtEnd) || hasMatchingRecords) {
      projects.push({
        folder, name: displayName, fullPath: projectPath,
        sessionCount, totalInput, totalOutput, totalCacheCreate, totalCacheRead,
        totalTokens: totalInput + totalOutput + totalCacheCreate + totalCacheRead,
        totalCost, lastActive: lastActive ? lastActive.toISOString() : null,
      });
    }
  }

  return projects.sort((a, b) => {
    if (!a.lastActive) return 1;
    if (!b.lastActive) return -1;
    return new Date(b.lastActive) - new Date(a.lastActive);
  });
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

  for (const jf of listSessionFilesOldestFirst(dir)) {
    const sessionId = jf.replace('.jsonl', '');
    let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;
    let firstTs = null, lastTs = null, title = null;
    let subagentCount = 0;
    const models = new Set();
    const modelUsage = {};

    try {
      for (const line of fs.readFileSync(path.join(dir, jf), 'utf8').trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
          if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
            for (const b of rec.message.content) {
              if (b.type === 'tool_use' && b.name === 'Agent' && (!b.id || !seenAgentSpawns.has(b.id))) {
                if (b.id) seenAgentSpawns.add(b.id);
                subagentCount++;
              }
            }
          }
          if (rec.type === 'assistant' && rec.message?.usage) {
            const dt = rec.timestamp ? new Date(rec.timestamp) : null;
            if ((dtStart || dtEnd) && !dt) continue;
            if (dt && dtStart && dt < dtStart) continue;
            if (dt && dtEnd   && dt > dtEnd)   continue;
            const recModel = rec.message.model || null;
            const d = dedupe(rec);
            input       += d.input;
            output      += d.output;
            cacheCreate += d.cacheCreate;
            cacheRead   += d.cacheRead;
            const day = dt ? dt.toISOString().split('T')[0] : null;
            const bd  = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, recModel, day);
            const recCost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
            cost += recCost;
            if (recModel && recModel !== '<synthetic>') {
              models.add(recModel);
              if (!modelUsage[recModel]) modelUsage[recModel] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, cost: 0 };
              const mu = modelUsage[recModel];
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
              if (!dailyMap[day]) dailyMap[day] = { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
              dailyMap[day].input       += d.input;
              dailyMap[day].output      += d.output;
              dailyMap[day].cacheCreate += d.cacheCreate;
              dailyMap[day].cacheRead   += d.cacheRead;
              dailyMap[day].cost        += recCost;
            }
          }
        } catch {}
      }
    } catch {}

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
          if (!dailyMap[day]) dailyMap[day] = { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
          dailyMap[day].input += v.input; dailyMap[day].output += v.output;
          dailyMap[day].cacheCreate += v.cacheCreate; dailyMap[day].cacheRead += v.cacheRead;
          dailyMap[day].cost += v.cost;
        }
      }
    }

    const total = input + output + cacheCreate + cacheRead;
    if (total > 0) {
      sessions.push({
        sessionId, title, subagentCount, models: [...models],
        input, output, cacheCreate, cacheRead, total, cost,
        modelUsage: Object.entries(modelUsage).map(([model, u]) => ({ model, ...u })),
        startedAt: firstTs ? firstTs.toISOString() : null,
        lastAt:    lastTs  ? lastTs.toISOString()  : null,
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
  if (!fs.existsSync(dir)) return { input: 0, output: 0, total: 0, cost: 0 };

  const today = new Date().toISOString().split('T')[0];
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;

  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    for (const jf of listSessionFilesOldestFirst(fullPath)) {
      let sessionModel = null;
      try {
        for (const line of fs.readFileSync(path.join(fullPath, jf), 'utf8').trim().split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'assistant' && rec.message?.model && !sessionModel) sessionModel = rec.message.model;
            if (rec.type === 'assistant' && rec.message?.usage && rec.timestamp) {
              if (new Date(rec.timestamp).toISOString().split('T')[0] === today) {
                const d = dedupe(rec);
                input += d.input; output += d.output; cacheCreate += d.cacheCreate; cacheRead += d.cacheRead;
                cost += calcCost(d.input, d.output, d.cacheCreate, d.cacheRead, rec.message.model || sessionModel, today);
              }
            }
          } catch {}
        }
      } catch {}

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
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead, cost };
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
  const subdir = path.join(getClaudeProjectsDir(), folder, sessionId, 'subagents');
  if (!fs.existsSync(subdir)) return { agentCount: 0, agents: [], totals: null, daily: {} };

  const cacheKey = folder + '/' + sessionId;
  const sig = subagentDirSignature(subdir);
  const cached = _subagentCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.result;

  const byName = {};
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0 };
  const daily = {}; // day -> { input, output, cacheCreate, cacheRead, cost }
  let agentCount = 0;

  const newAcc = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, toolUses: 0, turns: 0 });

  // Agent-team teammates each persist a copy of shared conversation turns, so
  // dedup must span ALL agent files of the session together (PLANNING.md F2/D2).
  // Tool calls in a shared turn would likewise count once per teammate file —
  // dedup them by tool_use block id across the session (D4).
  const dedupe = createUsageDeduper();
  const seenToolUseIds = new Set();

  for (const jfPath of listAgentTranscripts(subdir)) {
    let firstUser = null;
    // Accumulate per model within the transcript — a subagent can run on more than
    // one model (e.g. an opus thread that delegates a step to haiku), and those have
    // different rate cards, so they must never be summed into one row.
    const perModel = {};
    const ensure = (m) => perModel[m] || (perModel[m] = newAcc());

    try {
      for (const line of fs.readFileSync(jfPath, 'utf8').trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
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
            const day = rec.timestamp ? new Date(rec.timestamp).toISOString().split('T')[0] : null;
            const d = dedupe(rec);
            const bd = calcCostBreakdown(d.input, d.output, d.cacheCreate, d.cacheRead, model, day);
            const recCost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
            const e = ensure(mk);
            e.input += d.input; e.output += d.output; e.cacheCreate += d.cacheCreate; e.cacheRead += d.cacheRead;
            e.cost += recCost;
            e.inputCost += bd.input; e.outputCost += bd.output;
            e.cacheCreateCost += bd.cacheCreate; e.cacheReadCost += bd.cacheRead;
            if (d.first) e.turns++;
            if (day) {
              if (!daily[day]) daily[day] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
              daily[day].input += d.input; daily[day].output += d.output;
              daily[day].cacheCreate += d.cacheCreate; daily[day].cacheRead += d.cacheRead;
              daily[day].cost += recCost;
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
      const g = byName[key] || (byName[key] = { name, model: mk, spawns: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, toolUses: 0, turns: 0 });
      g.spawns++;
      g.input += e.input; g.output += e.output; g.cacheCreate += e.cacheCreate; g.cacheRead += e.cacheRead;
      g.total += total; g.cost += e.cost; g.toolUses += e.toolUses; g.turns += e.turns;
      g.inputCost += e.inputCost; g.outputCost += e.outputCost; g.cacheCreateCost += e.cacheCreateCost; g.cacheReadCost += e.cacheReadCost;

      totals.input += e.input; totals.output += e.output; totals.cacheCreate += e.cacheCreate;
      totals.cacheRead += e.cacheRead; totals.total += total; totals.cost += e.cost;
      totals.inputCost += e.inputCost; totals.outputCost += e.outputCost;
      totals.cacheCreateCost += e.cacheCreateCost; totals.cacheReadCost += e.cacheReadCost;
    }
    if (fileHadActivity) agentCount++;
  }

  const agents = Object.values(byName)
    .map(g => ({ ...g, models: [g.model] }))
    .sort((a, b) => b.cost - a.cost || b.total - a.total);

  const result = { agentCount, agents, totals: agentCount ? totals : null, daily };
  _subagentCache.set(cacheKey, { sig, result });
  return result;
}

// Sum a subagent daily-breakdown map over an optional [dtStart, dtEnd] window.
// Day-granular (subagent records are bucketed by calendar day); date filters are
// day-aligned so this matches the main-thread per-record filtering closely enough.
function sumSubagentRange(daily, dtStart, dtEnd) {
  const acc = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
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

  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const jsonlFiles = listSessionFilesOldestFirst(fullPath);
    if (jsonlFiles.length === 0) continue;

    const { displayName } = resolveProjectName(folder);
    const dedupe = createUsageDeduper(); // folder scope (PLANNING.md D2)
    let pInput = 0, pOutput = 0, pCacheCreate = 0, pCacheRead = 0, pCost = 0;

    for (const jf of jsonlFiles) {
      try {
        for (const line of fs.readFileSync(path.join(fullPath, jf), 'utf8').trim().split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'assistant' && rec.message?.usage) {
              const dt = rec.timestamp ? new Date(rec.timestamp) : null;
              if ((dtStart || dtEnd) && !dt) continue;
              if (dt && dtStart && dt < dtStart) continue;
              if (dt && dtEnd   && dt > dtEnd)   continue;
              const model = rec.message.model || null;
              const d = dedupe(rec);
              const iT = d.input;
              const oT = d.output;
              const ccT = d.cacheCreate;
              const crT = d.cacheRead;
              const day = dt ? dt.toISOString().split('T')[0] : null;
              const cost = calcCost(iT, oT, ccT, crT, model, day);

              pInput += iT; pOutput += oT; pCacheCreate += ccT; pCacheRead += crT; pCost += cost;

              if (dt) {
                if (!dailyMap[day]) dailyMap[day] = { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
                dailyMap[day].input       += iT;
                dailyMap[day].output      += oT;
                dailyMap[day].cacheCreate += ccT;
                dailyMap[day].cacheRead   += crT;
                dailyMap[day].cost        += cost;
              }
            }
          } catch {}
        }
      } catch {}

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
            if (!dailyMap[day]) dailyMap[day] = { date: day, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0 };
            dailyMap[day].input += v.input; dailyMap[day].output += v.output;
            dailyMap[day].cacheCreate += v.cacheCreate; dailyMap[day].cacheRead += v.cacheRead;
            dailyMap[day].cost += v.cost;
          }
        }
      }
    }

    const pTotal = pInput + pOutput + pCacheCreate + pCacheRead;
    if (pTotal > 0) {
      projectMap[folder] = { name: displayName, input: pInput, output: pOutput, cacheCreate: pCacheCreate, cacheRead: pCacheRead, total: pTotal, cost: pCost };
    }
  }

  const dailyTotals = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  const projectTotals = Object.values(projectMap).sort((a, b) => b.total - a.total);

  return { dailyTotals, projectTotals };
}

module.exports = { listLocalProjects, getProjectDetail, getTodayLocalSummary, getSessionChat, getSessionSubagents, searchSessions, getAggregatedDailyTotals };
