import { formatNum, toCsv } from './utils.js';
import { formatCost } from './pricing.js';
import { getIncludeSubagents, setIncludeSubagents } from './settings.js';

let chartDailyTokens  = null;
let chartDailyCost    = null;
let chartBreakdown    = null;
let chartTopProjects  = null;
let lastDailyTotals   = [];

function getDateRange() {
  return {
    from: document.getElementById('analytics-date-from').value || null,
    to:   document.getElementById('analytics-date-to').value   || null,
  };
}

// ── Main load ─────────────────────────────────────────────────────────────────

export async function loadAnalytics() {
  const { from, to } = getDateRange();
  const data = await window.api.getAnalyticsData(from, to, getIncludeSubagents());
  lastDailyTotals = data.dailyTotals;

  renderSummary(data);
  renderDailyTokensChart(data.dailyTotals);
  renderDailyCostChart(data.dailyTotals);
  renderBreakdownChart(data.dailyTotals);
  renderTopProjectsChart(data.projectTotals);
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
      return acc;
    },
    { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, savings: 0 }
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
  [chartDailyTokens, chartDailyCost, chartBreakdown, chartTopProjects].forEach(c => c && c.destroy());
  chartDailyTokens = chartDailyCost = chartBreakdown = chartTopProjects = null;
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

// ── Init ──────────────────────────────────────────────────────────────────────

export function initAnalyticsTab() {
  document.getElementById('analytics-date-from').addEventListener('change', loadAnalytics);
  document.getElementById('analytics-date-to').addEventListener('change', loadAnalytics);
  document.getElementById('btn-refresh-analytics').addEventListener('click', loadAnalytics);
  document.getElementById('btn-clear-analytics-dates').addEventListener('click', () => {
    document.getElementById('analytics-date-from').value = '';
    document.getElementById('analytics-date-to').value = '';
    loadAnalytics();
  });

  document.getElementById('btn-export-analytics').addEventListener('click', () => {
    const rows = [['Date', 'Input', 'Output', 'Cache Write', 'Cache Read', 'Cost (USD)', 'Cache Saved (USD)']];
    for (const d of lastDailyTotals) {
      rows.push([d.date, d.input, d.output, d.cacheCreate, d.cacheRead, d.cost.toFixed(4), (d.savings || 0).toFixed(4)]);
    }
    window.api.exportFile('claude-usage-daily.csv', toCsv(rows));
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
