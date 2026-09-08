import { formatNum, escapeHtml } from './utils.js';
import { formatCost } from './pricing.js';
import { getIncludeSubagents, setIncludeSubagents } from './settings.js';

let chartDailyTokens  = null;
let chartDailyCost    = null;
let chartBreakdown    = null;
let chartTopProjects  = null;
let chartMessages     = null;
let lastDailyTotals   = [];
let lastProjectTotals = [];
let messagesPeriod    = 'day';   // 'day' | 'week' - the Day/Week toggle on the messages card

function getDateRange() {
  return {
    from: document.getElementById('analytics-date-from').value || null,
    to:   document.getElementById('analytics-date-to').value   || null,
  };
}

// ── Main load ─────────────────────────────────────────────────────────────────

export async function loadAnalytics() {
  // Placeholder tiles while the parser aggregates — an empty panel reads as a
  // hang on the first (uncached) scan.
  const summaryEl = document.getElementById('analytics-summary');
  if (summaryEl && !summaryEl.children.length) {
    summaryEl.innerHTML = Array.from({ length: 4 }, () =>
      '<div class="summary-stat"><span class="skel"></span><span class="skel skel-label"></span></div>').join('');
  }

  const { from, to } = getDateRange();
  const data = await window.api.getAnalyticsData(from, to, getIncludeSubagents());
  lastDailyTotals   = data.dailyTotals;
  lastProjectTotals = data.projectTotals;

  renderSummary(data);
  renderDailyTokensChart(data.dailyTotals);
  renderDailyCostChart(data.dailyTotals);
  renderBreakdownChart(data.dailyTotals);
  renderTopProjectsChart(data.projectTotals);
  renderMessagesChart(data.dailyTotals);
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function renderSummary(data) {
  const totals = data.dailyTotals.reduce(
    (acc, d) => {
      acc.input       += d.input;
      acc.output      += d.output;
      acc.cacheCreate += d.cacheCreate;
      acc.cacheRead   += d.cacheRead;
      acc.cost        += d.cost;
      acc.savings     += d.savings || 0;
      acc.messages    += d.messages || 0;
      return acc;
    },
    { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0, messages: 0 }
  );
  const totalTokens = totals.input + totals.output + totals.cacheCreate + totals.cacheRead;
  const days = data.dailyTotals.length;
  const avgPerDay = days > 0 ? Math.round(totalTokens / days) : 0;

  document.getElementById('analytics-summary').innerHTML = `
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totalTokens)}</div>
      <div class="stat-label">Total Tokens</div>
      <div class="stat-cost">${formatCost(totals.cost)}</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totals.input)}</div>
      <div class="stat-label">Input Tokens</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totals.output)}</div>
      <div class="stat-label">Output Tokens</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totals.cacheCreate + totals.cacheRead)}</div>
      <div class="stat-label">Cache Tokens</div>
    </div>
    <div class="summary-stat" title="What the cache-read tokens would have cost extra at the full input rate">
      <div class="stat-value stat-savings">${formatCost(totals.savings)}</div>
      <div class="stat-label">Cache Saved</div>
    </div>
    <div class="summary-stat" title="Prompts you typed">
      <div class="stat-value">${formatNum(totals.messages)}</div>
      <div class="stat-label">Messages</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${days}</div>
      <div class="stat-label">Active Days</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(avgPerDay)}</div>
      <div class="stat-label">Avg / Day</div>
    </div>
  `;
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

function chartDefaults() {
  const style = getComputedStyle(document.documentElement);
  return {
    textColor:   style.getPropertyValue('--text').trim()   || '#1A1A1A',
    subtext:     style.getPropertyValue('--subtext').trim() || '#8A8A8A',
    gridColor:   style.getPropertyValue('--card-bd').trim() || '#E8E8E6',
    blue:        style.getPropertyValue('--blue').trim()    || '#4A90D9',
    accent:      style.getPropertyValue('--accent').trim()  || '#CC785C',
    green:       style.getPropertyValue('--green').trim()   || '#22C55E',
    orange:      style.getPropertyValue('--orange').trim()  || '#F5A623',
  };
}

function destroyAll() {
  [chartDailyTokens, chartDailyCost, chartBreakdown, chartTopProjects, chartMessages].forEach(c => c && c.destroy());
  chartDailyTokens = chartDailyCost = chartBreakdown = chartTopProjects = chartMessages = null;
}

// ── Chart 1: Daily Token Usage (stacked bar) ──────────────────────────────────

function renderDailyTokensChart(dailyTotals) {
  const ctx = document.getElementById('chart-daily-tokens');
  if (!ctx) return;
  if (chartDailyTokens) { chartDailyTokens.destroy(); chartDailyTokens = null; }

  const c = chartDefaults();
  const labels = dailyTotals.map(d => d.date);
  const noData = dailyTotals.length === 0;

  chartDailyTokens = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: noData ? ['No data'] : labels,
      datasets: noData ? [] : [
        { label: 'Input',        data: dailyTotals.map(d => d.input),                    backgroundColor: c.blue,   stack: 'tokens' },
        { label: 'Output',       data: dailyTotals.map(d => d.output),                   backgroundColor: c.accent, stack: 'tokens' },
        { label: 'Cache Create', data: dailyTotals.map(d => d.cacheCreate),              backgroundColor: '#9CA3AF', stack: 'tokens' },
        { label: 'Cache Read',   data: dailyTotals.map(d => d.cacheRead),                backgroundColor: '#D1D5DB', stack: 'tokens' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: c.textColor } },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, color: c.subtext, maxRotation: 45 }, grid: { color: c.gridColor } },
        y: { stacked: true, ticks: { callback: v => formatNum(v), font: { size: 10 }, color: c.subtext }, grid: { color: c.gridColor } },
      },
    },
  });
}

// ── Chart 2: Daily Cost (stacked bar by model family) ─────────────────────────

const FAMILY_COLORS = {
  opus: '#CC785C', sonnet: '#4A90D9', haiku: '#22C55E',
  fable: '#9B59B6', mythos: '#D946EF', other: '#9CA3AF',
};

function renderDailyCostChart(dailyTotals) {
  const ctx = document.getElementById('chart-daily-cost');
  if (!ctx) return;
  if (chartDailyCost) { chartDailyCost.destroy(); chartDailyCost = null; }

  const c = chartDefaults();
  const labels = dailyTotals.map(d => d.date);
  const noData = dailyTotals.length === 0;

  // Only the families that actually appear, ordered by total spend.
  const famTotals = {};
  for (const d of dailyTotals) {
    for (const [fam, cost] of Object.entries(d.costByModel || {})) {
      famTotals[fam] = (famTotals[fam] || 0) + cost;
    }
  }
  const families = Object.keys(famTotals).sort((a, b) => famTotals[b] - famTotals[a]);

  chartDailyCost = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: noData ? ['No data'] : labels,
      datasets: noData ? [] : families.map(fam => ({
        label: fam,
        data: dailyTotals.map(d => +((d.costByModel || {})[fam] || 0).toFixed(4)),
        backgroundColor: FAMILY_COLORS[fam] || FAMILY_COLORS.other,
        stack: 'cost',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: c.textColor } },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatCost(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, color: c.subtext, maxRotation: 45 }, grid: { color: c.gridColor } },
        y: { stacked: true, ticks: { callback: v => formatCost(v), font: { size: 10 }, color: c.subtext }, grid: { color: c.gridColor } },
      },
    },
  });
}

// ── Chart 3: Token Type Breakdown (doughnut) ──────────────────────────────────

function renderBreakdownChart(dailyTotals) {
  const ctx = document.getElementById('chart-token-breakdown');
  if (!ctx) return;
  if (chartBreakdown) { chartBreakdown.destroy(); chartBreakdown = null; }

  const c = chartDefaults();
  const totals = dailyTotals.reduce(
    (acc, d) => { acc.input += d.input; acc.output += d.output; acc.cache += d.cacheCreate + d.cacheRead; return acc; },
    { input: 0, output: 0, cache: 0 }
  );
  const hasData = (totals.input + totals.output + totals.cache) > 0;

  chartBreakdown = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Input', 'Output', 'Cache'],
      datasets: [{
        data: hasData ? [totals.input, totals.output, totals.cache] : [1, 0, 0],
        backgroundColor: [c.blue, c.accent, '#9CA3AF'],
        borderWidth: 2,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#fff',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, color: c.textColor } },
        tooltip: {
          callbacks: {
            label: ctx => hasData
              ? ` ${ctx.label}: ${formatNum(ctx.parsed)} (${((ctx.parsed / (totals.input + totals.output + totals.cache)) * 100).toFixed(1)}%)`
              : ' No data',
          },
        },
      },
    },
  });
}

// ── Chart 4: Top Projects (horizontal bar) ────────────────────────────────────

function renderTopProjectsChart(projectTotals) {
  const ctx = document.getElementById('chart-top-projects');
  if (!ctx) return;
  if (chartTopProjects) { chartTopProjects.destroy(); chartTopProjects = null; }

  const c = chartDefaults();
  const top = projectTotals.slice(0, 10);
  const noData = top.length === 0;

  chartTopProjects = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: noData ? ['No data'] : top.map(p => p.name.length > 20 ? p.name.slice(0, 18) + '…' : p.name),
      datasets: noData ? [] : [{
        label: 'Total Tokens',
        data: top.map(p => p.total),
        backgroundColor: top.map((_, i) => i === 0 ? c.accent : c.blue + 'BB'),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatNum(ctx.parsed.x)} tokens  ·  ${formatCost(top[ctx.dataIndex].cost)}`,
          },
        },
      },
      scales: {
        x: { ticks: { callback: v => formatNum(v), font: { size: 10 }, color: c.subtext }, grid: { color: c.gridColor } },
        y: { ticks: { font: { size: 10 }, color: c.textColor }, grid: { display: false } },
      },
    },
  });
}

// ── Chart 5: Messages per Day / Week (stacked bar by model) ──────────────────
// "Messages" = prompts the user typed. `messagesByModel` is keyed by full model
// id plus 'no-reply' for prompts that never got an assistant reply.

function shortModel(m) {
  if (m === 'no-reply') return 'No reply';
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

// Monday-start week containing `date` (YYYY-MM-DD), as a local Date at noon
// so DST shifts cannot move it across midnight.
function weekStart(date) {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Groups dailyTotals into periods. Returns ordered buckets (oldest first) and
// the model keys seen across the range, ordered by total desc.
function messageBuckets(dailyTotals, period) {
  const byKey = new Map();
  const modelTotals = {};
  for (const d of dailyTotals) {
    let key = d.date, label = d.date;
    if (period === 'week') {
      const ws = weekStart(d.date);
      key = ws.toLocaleDateString('en-CA');
      label = `Wk of ${ws.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    let b = byKey.get(key);
    if (!b) { b = { key, label, total: 0, byModel: {} }; byKey.set(key, b); }
    b.total += d.messages || 0;
    for (const [m, n] of Object.entries(d.messagesByModel || {})) {
      b.byModel[m] = (b.byModel[m] || 0) + n;
      modelTotals[m] = (modelTotals[m] || 0) + n;
    }
  }
  const buckets = [...byKey.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const models = Object.keys(modelTotals).sort((a, b) => modelTotals[b] - modelTotals[a]);
  return { buckets, models };
}

function renderMessagesChart(dailyTotals) {
  const ctx = document.getElementById('chart-messages');
  if (!ctx) return;
  if (chartMessages) { chartMessages.destroy(); chartMessages = null; }

  const c = chartDefaults();
  const { buckets, models } = messageBuckets(dailyTotals, messagesPeriod);
  const noData = buckets.length === 0;

  chartMessages = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: noData ? ['No data'] : buckets.map(b => b.label),
      datasets: noData ? [] : models.map(m => ({
        label: shortModel(m),
        data: buckets.map(b => b.byModel[m] || 0),
        backgroundColor: FAMILY_COLORS[familyOf(m)] || FAMILY_COLORS.other,
        stack: 'messages',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 }, color: c.textColor } },
        tooltip: {
          callbacks: {
            label: item => ` ${item.dataset.label}: ${formatNum(item.parsed.y)}`,
            footer: items => items.length ? `Total: ${formatNum(buckets[items[0].dataIndex].total)}` : '',
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, color: c.subtext, maxRotation: 45 }, grid: { color: c.gridColor } },
        y: { stacked: true, ticks: { callback: v => formatNum(v), font: { size: 10 }, color: c.subtext, precision: 0 }, grid: { color: c.gridColor } },
      },
    },
  });

  renderMessagesTable(buckets, models);
}

function renderMessagesTable(buckets, models) {
  const wrap = document.getElementById('messages-table-wrap');
  if (!wrap) return;
  if (!buckets.length) { wrap.innerHTML = ''; return; }

  const head = models.map(m => `<th title="${escapeHtml(m)}">${escapeHtml(shortModel(m))}</th>`).join('');
  const rows = [...buckets].reverse().map(b => `<tr>
      <td>${escapeHtml(b.label)}</td>
      ${models.map(m => `<td>${formatNum(b.byModel[m] || 0)}</td>`).join('')}
      <td class="tok-total"><strong>${formatNum(b.total)}</strong></td>
    </tr>`).join('');

  wrap.innerHTML = `
    <table class="daily-table messages-table">
      <thead><tr><th>${messagesPeriod === 'week' ? 'Week' : 'Date'}</th>${head}<th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Text export ───────────────────────────────────────────────────────────────
// Everything the tab shows, as a plain-text report: summary strip, daily totals,
// daily cost by model family, token-type breakdown, projects, messages table.

const fullNum = n => Math.round(n).toLocaleString('en-US');
const usd     = n => '$' + (n || 0).toFixed(4);

// Fixed-width table. Numeric-looking cells are right-aligned.
function textTable(header, rows) {
  const all = [header, ...rows].map(r => r.map(v => v == null ? '' : String(v)));
  const widths = header.map((_, i) => Math.max(...all.map(r => r[i].length)));
  const isNum = s => /^[-$\d.,%]+$/.test(s);
  const line = r => r.map((cell, i) =>
    (isNum(cell) && cell !== '') ? cell.padStart(widths[i]) : cell.padEnd(widths[i])).join('  ').trimEnd();
  return [line(all[0]), widths.map(w => '-'.repeat(w)).join('  '), ...all.slice(1).map(line)].join('\n');
}

function buildAnalyticsText() {
  const daily = lastDailyTotals;
  const { from, to } = getDateRange();
  const out = [];
  const section = (title) => { out.push('', title, '='.repeat(title.length), ''); };

  out.push('Claude Usage - Analytics');
  out.push(`Generated: ${new Date().toLocaleString()}`);
  out.push(`Date range: ${from || 'all'} to ${to || 'all'}`);
  out.push(`Include subagents: ${getIncludeSubagents() ? 'yes' : 'no'}`);

  // Summary
  const t = daily.reduce((acc, d) => {
    acc.input += d.input; acc.output += d.output; acc.cacheCreate += d.cacheCreate; acc.cacheRead += d.cacheRead;
    acc.cost += d.cost; acc.savings += d.savings || 0; acc.messages += d.messages || 0; return acc;
  }, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0, messages: 0 });
  const totalTokens = t.input + t.output + t.cacheCreate + t.cacheRead;
  const days = daily.length;
  section('Summary');
  out.push(textTable(['Metric', 'Value'], [
    ['Total Tokens',  fullNum(totalTokens)],
    ['Total Cost',    usd(t.cost)],
    ['Input Tokens',  fullNum(t.input)],
    ['Output Tokens', fullNum(t.output)],
    ['Cache Tokens',  fullNum(t.cacheCreate + t.cacheRead)],
    ['Cache Saved',   usd(t.savings)],
    ['Messages',      fullNum(t.messages)],
    ['Active Days',   fullNum(days)],
    ['Avg / Day',     fullNum(days ? totalTokens / days : 0)],
  ]));

  // Daily totals
  section('Daily Token Usage');
  out.push(textTable(
    ['Date', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total', 'Cost (USD)', 'Cache Saved (USD)', 'Messages'],
    daily.map(d => [d.date, fullNum(d.input), fullNum(d.output), fullNum(d.cacheCreate), fullNum(d.cacheRead),
      fullNum(d.input + d.output + d.cacheCreate + d.cacheRead), usd(d.cost), usd(d.savings), fullNum(d.messages || 0)])));

  // Daily cost by model family
  const famTotals = {};
  for (const d of daily) for (const [fam, c] of Object.entries(d.costByModel || {})) famTotals[fam] = (famTotals[fam] || 0) + c;
  const families = Object.keys(famTotals).sort((a, b) => famTotals[b] - famTotals[a]);
  section('Daily Cost by Model (USD)');
  out.push(textTable(
    ['Date', ...families, 'Total'],
    daily.map(d => [d.date, ...families.map(f => usd((d.costByModel || {})[f])), usd(d.cost)])));

  // Token type breakdown
  const cache = t.cacheCreate + t.cacheRead;
  const pct = n => totalTokens ? (n / totalTokens * 100).toFixed(1) + '%' : '0.0%';
  section('Token Type Breakdown');
  out.push(textTable(['Type', 'Tokens', 'Share'], [
    ['Input',  fullNum(t.input),  pct(t.input)],
    ['Output', fullNum(t.output), pct(t.output)],
    ['Cache',  fullNum(cache),    pct(cache)],
  ]));

  // Projects (chart shows top 10; export lists all)
  section('Projects');
  out.push(textTable(
    ['#', 'Project', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Total', 'Cost (USD)', 'Messages'],
    lastProjectTotals.map((p, i) => [i + 1, p.name, fullNum(p.input), fullNum(p.output), fullNum(p.cacheCreate),
      fullNum(p.cacheRead), fullNum(p.total), usd(p.cost), fullNum(p.messages || 0)])));

  // Messages per day/week by model (current toggle)
  const { buckets, models } = messageBuckets(daily, messagesPeriod);
  section(`Messages per ${messagesPeriod === 'week' ? 'Week' : 'Day'} by Model`);
  out.push(textTable(
    [messagesPeriod === 'week' ? 'Week' : 'Date', ...models.map(shortModel), 'Total'],
    buckets.map(b => [b.label, ...models.map(m => fullNum(b.byModel[m] || 0)), fullNum(b.total)])));

  return out.join('\n') + '\n';
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAnalyticsTab() {
  document.querySelectorAll('#messages-range .stats-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      messagesPeriod = btn.dataset.period;
      document.querySelectorAll('#messages-range .stats-range-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderMessagesChart(lastDailyTotals);
    });
  });

  document.getElementById('analytics-date-from').addEventListener('change', loadAnalytics);
  document.getElementById('analytics-date-to').addEventListener('change', loadAnalytics);
  document.getElementById('btn-refresh-analytics').addEventListener('click', loadAnalytics);
  document.getElementById('btn-clear-analytics-dates').addEventListener('click', () => {
    document.getElementById('analytics-date-from').value = '';
    document.getElementById('analytics-date-to').value = '';
    loadAnalytics();
  });

  document.getElementById('btn-export-analytics').addEventListener('click', () => {
    window.api.exportFile('claude-usage.txt', buildAnalyticsText());
  });

  const toggle = document.getElementById('toggle-subagents-analytics');
  toggle.checked = getIncludeSubagents();
  toggle.addEventListener('change', (e) => {
    setIncludeSubagents(e.target.checked);
    const other = document.getElementById('toggle-subagents-local');
    if (other) other.checked = e.target.checked;
    loadAnalytics();
  });
}
