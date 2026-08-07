// Stats tab — mirrors `claude /usage` → Stats (Overview + Models). Reads Claude
// Code's own stats cache (~/.claude/stats-cache.json) via getStatsCache(), so the
// numbers are identical to Claude's: cross-session, back to the first session
// ever. Token figures are input+output (cache excluded) — verified: the all-time
// sum of dailyModelTokens equals Σ(inputTokens+outputTokens) = Claude's "Total
// tokens". We add real cost (Claude leaves costUSD at 0) for the all-time view.
//
// Cache shape supports range filtering only for what it stores per-day
// (dailyActivity, dailyModelTokens). Per-model In/Out split + cost exist only as
// an all-time aggregate, so those extra figures show on the "All time" range.

import { formatNum, escapeHtml } from './utils.js';
import { formatCost } from './pricing.js';

let statsData = null;      // result of getStatsCache()
let statsRange = 'all';    // 'all' | '30' | '7'
let statsDate = null;      // 'YYYY-MM-DD' single-day override, or null
let statsView = 'overview';
let modelChart = null;

// ── helpers ─────────────────────────────────────────────────────────────────

function shortModel(m) {
  const match = m.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i);
  if (!match) return m;
  const name = match[1][0].toUpperCase() + match[1].slice(1);
  const minor = match[3] ? `.${match[3]}` : '';
  return `${name} ${match[2]}${minor}`;
}

function familyOf(m) {
  const match = (m || '').match(/fable|mythos|opus|sonnet|haiku/i);
  return match ? match[0].toLowerCase() : 'other';
}

const FAMILY_COLOR = {
  opus: '#7B61FF', sonnet: '#CC7820', haiku: '#4A90D9',
  fable: '#E0115F', mythos: '#14B8A6', other: '#B0B0AC',
};
const colorFor = (m) => FAMILY_COLOR[familyOf(m)] || FAMILY_COLOR.other;

function localDayStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// null for 'all', else 'YYYY-MM-DD' lower bound (inclusive).
function cutoffStr() {
  if (statsRange === 'all') return null;
  const n = statsRange === '7' ? 7 : 30;
  const c = new Date(); c.setHours(0, 0, 0, 0);
  c.setDate(c.getDate() - (n - 1));
  return localDayStr(c);
}

// True if a 'YYYY-MM-DD' falls in the active selection (single-day date pick
// takes precedence over the range toggle).
function dateInRange(dateStr) {
  if (statsDate) return dateStr === statsDate;
  const cut = cutoffStr();
  return !cut || dateStr >= cut;
}

function activityInRange() {
  return (statsData?.dailyActivity || []).filter(a => dateInRange(a.date));
}

function modelDaysInRange() {
  return (statsData?.dailyModelTokens || []).filter(d => dateInRange(d.date));
}

// [{ model, io, pct }] over the active range, from per-day token counts.
function perModelInRange() {
  const totals = {};
  for (const row of modelDaysInRange()) {
    for (const [m, t] of Object.entries(row.tokensByModel || {})) {
      totals[m] = (totals[m] || 0) + t;
    }
  }
  const list = Object.entries(totals).map(([model, io]) => ({ model, io }));
  const sum = list.reduce((s, m) => s + m.io, 0) || 1;
  list.forEach(m => { m.pct = (m.io / sum) * 100; });
  list.sort((a, b) => b.io - a.io);
  return list;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// longest / current run of consecutive calendar days among active days (lifetime).
function computeStreaks(activeDates) {
  if (!activeDates.length) return { longest: 0, current: 0 };
  const set = new Set(activeDates);
  const day = 86400000;
  const shift = (ds, n) => localDayStr(new Date(new Date(ds + 'T12:00:00').getTime() + n * day));
  let longest = 0;
  for (const ds of activeDates) {
    if (set.has(shift(ds, -1))) continue; // not a run start
    let len = 1, cur = ds;
    while (set.has(shift(cur, 1))) { len++; cur = shift(cur, 1); }
    if (len > longest) longest = len;
  }
  const today = localDayStr(new Date());
  let cur = set.has(today) ? today : (set.has(shift(today, -1)) ? shift(today, -1) : null);
  let current = 0;
  while (cur && set.has(cur)) { current++; cur = shift(cur, -1); }
  return { longest, current };
}

// ── Overview ────────────────────────────────────────────────────────────────

function renderHeatmap() {
  // Trailing 53 weeks (GitHub-style), fixed regardless of the range toggle.
  const byDate = {};
  let max = 0;
  for (const a of (statsData?.dailyActivity || [])) {
    byDate[a.date] = a.messageCount || 0;
    if (a.messageCount > max) max = a.messageCount;
  }

  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 52 * 7 - end.getDay());

  const level = (v) => {
    if (!v) return 0;
    const r = v / (max || 1);
    if (r > 0.5) return 4;
    if (r > 0.25) return 3;
    if (r > 0.08) return 2;
    return 1;
  };

  const weeks = [], monthLabels = [];
  const cursor = new Date(start);
  let lastMonth = '';
  while (cursor <= end) {
    const cells = [];
    let weekMonth = null;
    for (let dow = 0; dow < 7; dow++) {
      const ds = localDayStr(cursor);
      const v = byDate[ds] || 0;
      cells.push(cursor > end
        ? `<div class="hm-cell hm-empty"></div>`
        : `<div class="hm-cell hm-l${level(v)}" title="${ds}: ${v.toLocaleString()} messages"></div>`);
      // The 1st-7th of a month is the week that "owns" that month's label.
      if (cursor.getDate() <= 7 && weekMonth === null) weekMonth = cursor.toLocaleDateString(undefined, { month: 'short' });
      cursor.setDate(cursor.getDate() + 1);
    }
    // Emit each month once — the 1st-7th can straddle two week columns, which
    // previously labeled both ("MayMay").
    const label = (weekMonth && weekMonth !== lastMonth) ? weekMonth : '';
    if (label) lastMonth = label;
    monthLabels.push(`<div class="hm-mlabel">${label}</div>`);
    weeks.push(`<div class="hm-week">${cells.join('')}</div>`);
  }

  return `
    <div class="heatmap">
      <div class="hm-months">${monthLabels.join('')}</div>
      <div class="hm-body">
        <div class="hm-dowlabels"><span>Mon</span><span>Wed</span><span>Fri</span></div>
        <div class="hm-grid">${weeks.join('')}</div>
      </div>
      <div class="hm-legend">Less
        <span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span>
        <span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span>
        <span class="hm-cell hm-l4"></span> More
      </div>
    </div>`;
}

function renderOverview() {
  const el = document.getElementById('stats-overview');
  if (!el) return;
  if (!renderGuard(el)) return;

  const activity = activityInRange();
  const models = perModelInRange();
  const totalIo = models.reduce((s, m) => s + m.io, 0);
  const activeDates = activity.map(a => a.date).sort();
  const { longest, current } = computeStreaks((statsData.dailyActivity || []).map(a => a.date));

  const sessions = (statsRange === 'all' && !statsDate)
    ? (statsData.totalSessions ?? activity.reduce((s, a) => s + (a.sessionCount || 0), 0))
    : activity.reduce((s, a) => s + (a.sessionCount || 0), 0);

  let spanDays;
  if (statsDate) spanDays = 1;
  else if (statsRange === '7') spanDays = 7;
  else if (statsRange === '30') spanDays = 30;
  else if (statsData.firstSessionDate) {
    spanDays = Math.round((Date.now() - Date.parse(statsData.firstSessionDate)) / 86400000) + 1;
  } else spanDays = activeDates.length;

  const mostActive = activity.reduce((mx, a) => (a.messageCount > (mx?.messageCount || 0) ? a : mx), null);
  const fav = models[0];
  const allTimeCost = (statsRange === 'all' && !statsDate)
    ? Object.values(statsData.models || {}).reduce((s, m) => s + (m.cost || 0), 0) : 0;

  const stat = (label, value, sub = '') =>
    `<div class="stat-cell"><div class="stat-cell-label">${label}</div><div class="stat-cell-value">${value}</div>${sub ? `<div class="stat-cell-sub">${sub}</div>` : ''}</div>`;

  const mostActiveStr = mostActive
    ? new Date(mostActive.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '—';

  el.innerHTML = `
    ${renderHeatmap()}
    <div class="stat-grid">
      ${stat('Favorite model', fav ? `<span class="model-badge model-${familyOf(fav.model)}">${escapeHtml(shortModel(fav.model))}</span>` : '—')}
      ${stat('Total tokens', formatNum(totalIo), `input + output${allTimeCost ? ` · ${formatCost(allTimeCost)}` : ''}`)}
      ${stat('Sessions', (sessions || 0).toLocaleString())}
      ${stat('Active days', `${activeDates.length}${spanDays ? ` / ${spanDays}` : ''}`)}
      ${stat('Most active day', mostActiveStr, mostActive ? `${(mostActive.messageCount || 0).toLocaleString()} messages` : '')}
      ${stat('Longest session', fmtDuration(statsData.longestSession?.duration), 'lifetime')}
      ${stat('Longest streak', `${longest} day${longest === 1 ? '' : 's'}`, 'lifetime')}
      ${stat('Current streak', `${current} day${current === 1 ? '' : 's'}`, 'lifetime')}
    </div>`;
}

// ── Models ──────────────────────────────────────────────────────────────────

function renderModels() {
  const el = document.getElementById('stats-models');
  if (!el) return;
  if (!renderGuard(el)) return;

  const models = perModelInRange();
  const allTime = statsRange === 'all' && !statsDate;

  const rows = models.map(m => {
    const agg = statsData.models?.[m.model];
    const extra = (allTime && agg)
      ? `<div class="model-stat-io">In: ${formatNum(agg.input)} · Out: ${formatNum(agg.output)} · ${formatCost(agg.cost)}</div>`
      : `<div class="model-stat-io">${formatNum(m.io)} tokens</div>`;
    return `
      <div class="model-stat-row">
        <div class="model-stat-head">
          <span class="model-dot" style="background:${colorFor(m.model)}"></span>
          <span class="model-stat-name">${escapeHtml(shortModel(m.model))}</span>
          <span class="model-stat-pct">${m.pct.toFixed(1)}%</span>
        </div>
        ${extra}
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="models-chart-card">
      <div class="analytics-chart-title">Tokens per Day (input + output)</div>
      <div class="analytics-chart-wrap"><canvas id="stats-model-canvas"></canvas></div>
    </div>
    <div class="model-stat-list">${rows || '<div class="empty-state">No models in range</div>'}</div>`;

  renderModelChart(models.map(m => m.model));
}

function renderModelChart(modelIds) {
  const ctx = document.getElementById('stats-model-canvas');
  if (!ctx) return;
  if (modelChart) { modelChart.destroy(); modelChart = null; }

  const days = modelDaysInRange();
  const labels = days.map(d => d.date);
  const datasets = modelIds.map(id => ({
    label: shortModel(id),
    data: days.map(d => d.tokensByModel?.[id] || 0),
    borderColor: colorFor(id),
    backgroundColor: colorFor(id),
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.25,
    fill: false,
  }));

  modelChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { font: { size: 10 }, maxTicksLimit: 12 } },
        y: { ticks: { callback: v => formatNum(v) } },
      },
    },
  });
}

// ── render dispatch ─────────────────────────────────────────────────────────

// Shared guard: shows loading / error / empty and returns false if the caller
// should stop. Keeps the stats-cache-missing case honest (tell the user how to
// generate it) rather than a blank panel.
function renderGuard(el) {
  if (!statsData) { el.innerHTML = '<div class="empty-state">Loading…</div>'; return false; }
  if (!statsData.ok) {
    el.innerHTML = `<div class="empty-state">Stats cache not available.<br><span class="subtle">Open <code>/usage</code> → Stats in Claude Code once to generate <code>~/.claude/stats-cache.json</code>, then Refresh.</span></div>`;
    return false;
  }
  if (!statsData.dailyModelTokens?.length && !statsData.dailyActivity?.length) {
    el.innerHTML = '<div class="empty-state">No usage data in stats cache</div>';
    return false;
  }
  return true;
}

function renderStats() {
  if (statsView === 'overview') renderOverview();
  else renderModels();
}

export async function loadStats() {
  try { statsData = await window.api.getStatsCache(); }
  catch (e) { statsData = { ok: false, error: e.message }; }

  // Bound the date picker to the days the cache actually covers.
  const dateInput = document.getElementById('stats-date');
  if (dateInput) {
    const dates = (statsData?.dailyActivity || []).map(a => a.date).sort();
    if (dates.length) { dateInput.min = dates[0]; dateInput.max = dates[dates.length - 1]; }
  }

  renderStats();
}

export function initStatsTab() {
  document.querySelectorAll('.stats-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stats-subtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.stats-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      statsView = btn.dataset.stab;
      document.getElementById(`stats-${statsView}`).classList.add('active');
      renderStats();
    });
  });

  const dateInput = document.getElementById('stats-date');
  const dateBtn = document.getElementById('stats-date-btn');
  const dateLabel = document.getElementById('stats-date-label');
  const dateClear = document.getElementById('stats-date-clear');

  // Central place to reflect statsDate into the toolbar chrome.
  const applyDate = (val) => {
    statsDate = val || null;
    dateBtn.classList.toggle('active', !!statsDate);
    dateLabel.textContent = statsDate
      ? new Date(statsDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Pick a day';
    document.querySelectorAll('.stats-range-btn').forEach(b => b.classList.remove('active'));
    if (!statsDate) document.querySelector(`.stats-range-btn[data-range="${statsRange}"]`)?.classList.add('active');
    renderStats();
  };

  document.querySelectorAll('.stats-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      statsRange = btn.dataset.range;
      dateInput.value = '';
      applyDate(null); // clears the day + re-highlights this range button
    });
  });

  dateBtn.addEventListener('click', () => dateInput.showPicker?.());
  dateClear.addEventListener('click', (e) => {
    e.stopPropagation(); // don't reopen the picker
    dateInput.value = '';
    applyDate(null);
  });
  dateInput.addEventListener('change', () => applyDate(dateInput.value));

  document.getElementById('btn-refresh-stats').addEventListener('click', loadStats);
}
