// Reads Claude Code's own stats cache (~/.claude/stats-cache.json) — the exact
// data source behind the interactive `/usage` → Stats screen. Using it directly
// gives figures identical to Claude's (cross-session, back to the first session
// ever, surviving transcript cleanup) instead of re-deriving weaker numbers from
// local transcripts. Claude leaves costUSD at 0 for subscription usage, so we
// enrich each model with a real cost from the app's own pricing.
//
// Shape (version 3): { dailyActivity[], dailyModelTokens[], modelUsage{},
// totalSessions, totalMessages, longestSession, firstSessionDate, hourCounts }.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { calcCost } = require('./pricing');

function getStatsCacheFile() {
  return path.join(os.homedir(), '.claude', 'stats-cache.json');
}

// Returns { ok, ... } — never throws. ok:false means the file is missing or
// unreadable (older CLI, or the user never opened /usage → Stats), so the UI
// can tell them how to generate it.
function getStatsCache() {
  const file = getStatsCacheFile();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, error: 'stats-cache.json not found', file }; }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return { ok: false, error: 'stats-cache.json is not valid JSON: ' + e.message, file }; }

  // Enrich modelUsage with cost + input/output totals for convenience.
  const models = {};
  for (const [model, u] of Object.entries(data.modelUsage || {})) {
    const input = u.inputTokens || 0;
    const output = u.outputTokens || 0;
    const cacheCreate = u.cacheCreationInputTokens || 0;
    const cacheRead = u.cacheReadInputTokens || 0;
    models[model] = {
      input, output, cacheCreate, cacheRead,
      io: input + output,
      total: input + output + cacheCreate + cacheRead,
      cost: calcCost(input, output, cacheCreate, cacheRead, model, null),
    };
  }

  return {
    ok: true,
    file,
    version: data.version ?? null,
    lastComputedDate: data.lastComputedDate ?? null,
    dailyActivity: data.dailyActivity || [],
    dailyModelTokens: data.dailyModelTokens || [],
    models,
    totalSessions: data.totalSessions ?? null,
    totalMessages: data.totalMessages ?? null,
    longestSession: data.longestSession ?? null,
    firstSessionDate: data.firstSessionDate ?? null,
    hourCounts: data.hourCounts || {},
  };
}

module.exports = { getStatsCache, getStatsCacheFile };
