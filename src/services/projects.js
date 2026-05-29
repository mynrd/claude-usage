const path = require('path');
const fs = require('fs');
const os = require('os');
const { calcCost, calcCostBreakdown } = require('./pricing');

function getClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
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

function listLocalProjects(startDate, endDate) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return [];

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const projects = [];
  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    const { displayName, fullPath: projectPath } = resolveProjectName(folder);
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
              const u = rec.message.usage;
              const model = rec.message.model || null;
              sInput += u.input_tokens || 0;
              sOutput += u.output_tokens || 0;
              sCacheCreate += u.cache_creation_input_tokens || 0;
              sCacheRead += u.cache_read_input_tokens || 0;
              if (model && model !== '<synthetic>') sModels.add(model);
              const day = dt ? dt.toISOString().split('T')[0] : null;
              sCost += calcCost(u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, model, day);
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

function getProjectDetail(folder, startDate, endDate) {
  const dir = path.join(getClaudeProjectsDir(), folder);
  if (!fs.existsSync(dir)) return { sessions: [], dailyTotals: [] };

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const sessions = [];
  const dailyMap = {};

  for (const jf of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const sessionId = jf.replace('.jsonl', '');
    let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;
    let firstTs = null, lastTs = null, title = null;
    const models = new Set();
    const modelUsage = {};

    try {
      for (const line of fs.readFileSync(path.join(dir, jf), 'utf8').trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
          if (rec.type === 'assistant' && rec.message?.usage) {
            const dt = rec.timestamp ? new Date(rec.timestamp) : null;
            if ((dtStart || dtEnd) && !dt) continue;
            if (dt && dtStart && dt < dtStart) continue;
            if (dt && dtEnd   && dt > dtEnd)   continue;
            const u = rec.message.usage;
            const recModel = rec.message.model || null;
            input       += u.input_tokens || 0;
            output      += u.output_tokens || 0;
            cacheCreate += u.cache_creation_input_tokens || 0;
            cacheRead   += u.cache_read_input_tokens || 0;
            const day = dt ? dt.toISOString().split('T')[0] : null;
            const bd  = calcCostBreakdown(u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, recModel, day);
            const recCost = bd.input + bd.output + bd.cacheCreate + bd.cacheRead;
            cost += recCost;
            if (recModel && recModel !== '<synthetic>') {
              models.add(recModel);
              if (!modelUsage[recModel]) modelUsage[recModel] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, inputCost: 0, outputCost: 0, cacheCreateCost: 0, cacheReadCost: 0, cost: 0 };
              const mu = modelUsage[recModel];
              mu.input           += u.input_tokens || 0;
              mu.output          += u.output_tokens || 0;
              mu.cacheCreate     += u.cache_creation_input_tokens || 0;
              mu.cacheRead       += u.cache_read_input_tokens || 0;
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
              dailyMap[day].input       += u.input_tokens || 0;
              dailyMap[day].output      += u.output_tokens || 0;
              dailyMap[day].cacheCreate += u.cache_creation_input_tokens || 0;
              dailyMap[day].cacheRead   += u.cache_read_input_tokens || 0;
              dailyMap[day].cost        += recCost;
            }
          }
        } catch {}
      }
    } catch {}

    const total = input + output + cacheCreate + cacheRead;
    if (total > 0) {
      sessions.push({
        sessionId, title, models: [...models],
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

function getTodayLocalSummary() {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return { input: 0, output: 0, total: 0, cost: 0 };

  const today = new Date().toISOString().split('T')[0];
  let input = 0, output = 0, cacheCreate = 0, cacheRead = 0, cost = 0;

  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;
    for (const jf of fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl'))) {
      let sessionModel = null;
      try {
        for (const line of fs.readFileSync(path.join(fullPath, jf), 'utf8').trim().split('\n')) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line);
            if (rec.type === 'assistant' && rec.message?.model && !sessionModel) sessionModel = rec.message.model;
            if (rec.type === 'assistant' && rec.message?.usage && rec.timestamp) {
              if (new Date(rec.timestamp).toISOString().split('T')[0] === today) {
                const u = rec.message.usage;
                const iT = u.input_tokens || 0, oT = u.output_tokens || 0;
                const ccT = u.cache_creation_input_tokens || 0, crT = u.cache_read_input_tokens || 0;
                input += iT; output += oT; cacheCreate += ccT; cacheRead += crT;
                cost += calcCost(iT, oT, ccT, crT, rec.message.model || sessionModel, today);
              }
            }
          } catch {}
        }
      } catch {}
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
  for (const line of fs.readFileSync(fpath, 'utf8').trim().split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
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
                const totalMatch = uText.match(/total_tokens:\s*(\d+)/);
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
  return reorderToolResults(messages);
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

function getAggregatedDailyTotals(startDate, endDate) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return { dailyTotals: [], projectTotals: [] };

  const dtStart = startDate ? new Date(startDate + 'T00:00:00') : null;
  const dtEnd   = endDate   ? new Date(endDate   + 'T23:59:59.999') : null;

  const dailyMap = {};
  const projectMap = {};

  for (const folder of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, folder);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) continue;

    const { displayName } = resolveProjectName(folder);
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
              const u = rec.message.usage;
              const model = rec.message.model || null;
              const iT = u.input_tokens || 0;
              const oT = u.output_tokens || 0;
              const ccT = u.cache_creation_input_tokens || 0;
              const crT = u.cache_read_input_tokens || 0;
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

module.exports = { listLocalProjects, getProjectDetail, getTodayLocalSummary, getSessionChat, searchSessions, getAggregatedDailyTotals };
