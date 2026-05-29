import { estimateCost, formatCost } from './pricing.js';
import { formatNum } from './utils.js';
import { openSessionChat } from './chat-viewer.js';

let currentProjects = [];
let activeProjectFolder = null;
let detailChart = null;
let sessionMap = {};

function getDateRange() {
  return {
    from: document.getElementById('local-date-from').value || null,
    to:   document.getElementById('local-date-to').value   || null,
  };
}

// ── Project List ──────────────────────────────────────────────────────────────

export async function loadLocalUsage() {
  const { from, to } = getDateRange();
  const projects = await window.api.listProjects(from, to);
  currentProjects = projects;

  const totalInput       = projects.reduce((s, p) => s + p.totalInput,        0);
  const totalOutput      = projects.reduce((s, p) => s + p.totalOutput,       0);
  const totalCacheCreate = projects.reduce((s, p) => s + p.totalCacheCreate,   0);
  const totalCacheRead   = projects.reduce((s, p) => s + p.totalCacheRead,     0);
  const totalTokens      = totalInput + totalOutput + totalCacheCreate + totalCacheRead;

  document.getElementById('local-summary').innerHTML = `
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totalInput)}</div>
      <div class="stat-label">Input</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totalOutput)}</div>
      <div class="stat-label">Output</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totalCacheCreate)}</div>
      <div class="stat-label">Cache Write</div>
    </div>
    <div class="summary-stat">
      <div class="stat-value">${formatNum(totalCacheRead)}</div>
      <div class="stat-label">Cache Read</div>
    </div>
    <div class="summary-stat summary-stat-full">
      <div class="stat-value">${formatNum(totalTokens)}</div>
      <div class="stat-label">Total Tokens</div>
    </div>
  `;

  const listEl = document.getElementById('project-list');
  listEl.innerHTML = '';
  for (const p of projects) {
    const div = document.createElement('div');
    div.className = 'project-item';
    div.dataset.folder = p.folder;
    if (p.folder === activeProjectFolder) div.classList.add('active');

    const lastActiveStr = p.lastActive
      ? new Date(p.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : 'N/A';

    div.innerHTML = `
      <div class="proj-name" title="${p.fullPath || p.name}">${p.name}</div>
      <div class="proj-meta">${formatNum(p.totalTokens)} tokens &middot; <span class="cost-badge">${formatCost(p.totalCost || 0)}</span> &middot; ${p.sessionCount} sessions &middot; ${lastActiveStr}</div>
    `;
    div.addEventListener('click', () => {
      document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active'));
      div.classList.add('active');
      activeProjectFolder = p.folder;
      loadProjectDetail(p.folder, p.name, p.fullPath);
    });
    listEl.appendChild(div);
  }

  if (activeProjectFolder) {
    const active = projects.find(p => p.folder === activeProjectFolder);
    if (active) loadProjectDetail(active.folder, active.name, active.fullPath);
  }
}

// ── Project Detail ────────────────────────────────────────────────────────────

async function loadProjectDetail(folder, name, fullPath) {
  const { from, to } = getDateRange();
  const detail = await window.api.getProjectDetail(folder, from, to);
  const panel = document.getElementById('project-detail');

  panel.innerHTML = `
    <h3 style="font-size:14px;margin-bottom:4px;">${name}</h3>
    <div style="font-size:11px;color:#888;margin-bottom:12px;" title="${fullPath || name}">${fullPath || name}</div>
    <div class="detail-tabs">
      <button class="detail-tab active" data-dtab="sessions">Sessions</button>
      <button class="detail-tab" data-dtab="daily">Daily Totals</button>
      <button class="detail-tab" data-dtab="chart">Chart</button>
    </div>
    <div class="detail-content active" id="dtab-sessions"></div>
    <div class="detail-content" id="dtab-daily"></div>
    <div class="detail-content" id="dtab-chart"><div class="detail-chart-container"><canvas id="detail-canvas"></canvas></div></div>
  `;

  panel.querySelectorAll('.detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`dtab-${tab.dataset.dtab}`).classList.add('active');
      if (tab.dataset.dtab === 'chart') renderDetailChart(detail.dailyTotals);
    });
  });

  renderSessionsTab(detail, folder);
  renderDailyTab(detail);
}

function shortModel(m) {
  const match = m.match(/(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!match) return m;
  const minor = match[3] ? `.${match[3]}` : '';
  return `${match[1]}-${match[2]}${minor}`;
}

function renderSessionRows(sessions) {
  sessions.forEach(s => { sessionMap[s.sessionId] = s; });
  return sessions.map(s => {
    const started = s.startedAt
      ? new Date(s.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'N/A';
    const displayName = s.title || s.sessionId.substring(0, 8) + '...';
    // Auto-titles repeat across sessions, so always show a short id to disambiguate.
    const idSuffix = `<span class="session-id-suffix">#${s.sessionId.substring(0, 8)}</span>`;
    const subagentBadge = s.subagentCount > 0
      ? `<span class="subagent-badge" title="${s.subagentCount} subagent call${s.subagentCount === 1 ? '' : 's'}">&#10551; ${s.subagentCount}</span>`
      : '';
    const models = s.models || (s.model ? [s.model] : []);
    const total = s.total ?? (s.input + s.output + s.cacheCreate + s.cacheRead);
    const modelHtml = models.length === 0 ? 'N/A'
      : models.map(m => `<span class="model-badge model-${shortModel(m).split('-')[0]}">${shortModel(m)}</span>`).join(' ');
    return `<tr class="session-row" data-sid="${s.sessionId}">
      <td class="session-name" title="${s.title ? s.sessionId : ''}">${displayName} ${idSuffix} ${subagentBadge}</td>
      <td>${modelHtml}</td>
      <td>${started}</td>
      <td class="tok-input">${formatNum(s.input)}</td>
      <td class="tok-output">${formatNum(s.output)}</td>
      <td class="tok-cache">${formatNum(s.cacheCreate)}</td>
      <td class="tok-cache">${formatNum(s.cacheRead)}</td>
      <td class="tok-total">${formatNum(total)}</td>
      <td><button class="btn-detail" data-sid="${s.sessionId}">Detail</button></td>
    </tr>`;
  }).join('');
}

function bindSessionClicks(sessEl, folder) {
  sessEl.querySelectorAll('.session-row').forEach(row => {
    row.addEventListener('click', () => openSessionChat(folder, row.dataset.sid));
  });
  sessEl.querySelectorAll('.btn-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = sessionMap[btn.dataset.sid];
      if (s) showModelDetailModal(s);
    });
  });
}

function renderSessionsTab(detail, folder) {
  const sessEl = document.getElementById('dtab-sessions');

  if (detail.sessions.length === 0) {
    sessEl.innerHTML = '<div class="empty-state">No token data found</div>';
    return;
  }

  sessEl.innerHTML = `
    <div class="session-search-bar">
      <input type="text" id="session-search" class="search-input" placeholder="Search sessions (title &amp; content)..." />
    </div>
    <table class="session-table">
      <thead><tr>
        <th>Session</th><th>Model</th><th>Started</th>
        <th>Input</th><th>Output</th><th>C.Write</th><th>C.Read</th><th>Total Tokens</th><th></th>
      </tr></thead>
      <tbody id="session-tbody">${renderSessionRows(detail.sessions)}</tbody>
    </table>
  `;
  bindSessionClicks(sessEl, folder);

  let searchTimer = null;
  sessEl.querySelector('#session-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (!q) {
      document.getElementById('session-tbody').innerHTML = renderSessionRows(detail.sessions);
      bindSessionClicks(sessEl, folder);
      return;
    }
    searchTimer = setTimeout(async () => {
      const matchIds = await window.api.searchSessions(folder, q);
      const matchSet = new Set(matchIds);
      const filtered = detail.sessions.filter(s => matchSet.has(s.sessionId));
      document.getElementById('session-tbody').innerHTML = filtered.length
        ? renderSessionRows(filtered)
        : '<tr><td colspan="9" class="empty-state" style="padding:20px">No matches</td></tr>';
      bindSessionClicks(sessEl, folder);
    }, 400);
  });
}

function renderDailyTab(detail) {
  const dailyEl = document.getElementById('dtab-daily');

  if (detail.dailyTotals.length === 0) {
    dailyEl.innerHTML = '<div class="empty-state">No daily data</div>';
    return;
  }

  const dRows = [...detail.dailyTotals].reverse().map(d => {
    const cost = d.cost != null ? d.cost : estimateCost(d.input, d.output, d.cacheCreate, d.cacheRead, null);
    return `<tr>
      <td>${d.date}</td>
      <td class="tok-output">${formatNum(d.output)}</td>
      <td class="tok-cache">${formatNum(d.cacheCreate)}</td>
      <td class="tok-cache">${formatNum(d.cacheRead)}</td>
      <td class="cost-badge">${formatCost(cost)}</td>
    </tr>`;
  }).join('');

  dailyEl.innerHTML = `
    <table class="daily-table">
      <thead><tr><th>Date</th><th>Output</th><th>C.Write</th><th>C.Read</th><th>Est. Cost</th></tr></thead>
      <tbody>${dRows}</tbody>
    </table>
  `;
}

// ── Detail Chart ──────────────────────────────────────────────────────────────

function renderDetailChart(dailyTotals) {
  const ctx = document.getElementById('detail-canvas');
  if (!ctx) return;
  if (detailChart) detailChart.destroy();

  detailChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: dailyTotals.map(d => d.date),
      datasets: [
        { label: 'Input',  data: dailyTotals.map(d => d.input),                    backgroundColor: '#4A90D9' },
        { label: 'Output', data: dailyTotals.map(d => d.output),                   backgroundColor: '#CC785C' },
        { label: 'Cache',  data: dailyTotals.map(d => d.cacheCreate + d.cacheRead), backgroundColor: '#D0D0CC' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, ticks: { callback: v => formatNum(v) } },
      },
    },
  });
}

// ── Model Detail Modal ────────────────────────────────────────────────────────

function initModelDetailModal() {
  const overlay = document.createElement('div');
  overlay.id = 'model-detail-overlay';
  overlay.className = 'model-detail-overlay hidden';
  overlay.innerHTML = `
    <div class="model-detail-card">
      <div class="model-detail-header">
        <span class="model-detail-title">Model Usage — <em id="modal-session-title"></em></span>
        <button id="modal-close" class="modal-close-btn">×</button>
      </div>
      <div id="modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('modal-close').addEventListener('click', () => overlay.classList.add('hidden'));
}

function showModelDetailModal(session) {
  const overlay = document.getElementById('model-detail-overlay');
  const body    = document.getElementById('modal-body');
  document.getElementById('modal-session-title').textContent =
    session.title || session.sessionId.substring(0, 12) + '…';

  const usage = session.modelUsage || [];
  if (!usage.length) {
    body.innerHTML = '<div class="empty-state">No model breakdown available</div>';
  } else {
    const tc = (n, c) => `${formatNum(n)} <span class="tok-cost">(${formatCost(c)})</span>`;
    const rows = usage.map(m => `
      <tr>
        <td><span class="model-badge model-${shortModel(m.model).split('-')[0]}">${shortModel(m.model)}</span></td>
        <td class="tok-input">${tc(m.input, m.inputCost || 0)}</td>
        <td class="tok-cache">${tc(m.cacheCreate, m.cacheCreateCost || 0)}</td>
        <td class="tok-cache">${tc(m.cacheRead, m.cacheReadCost || 0)}</td>
        <td class="tok-output">${tc(m.output, m.outputCost || 0)}</td>
        <td class="cost-badge">${formatCost(m.cost)}</td>
      </tr>`).join('');
    const tot = usage.reduce((a, m) => {
      a.output += m.output; a.outputCost += m.outputCost || 0;
      a.cacheCreate += m.cacheCreate; a.cacheCreateCost += m.cacheCreateCost || 0;
      a.cacheRead += m.cacheRead; a.cacheReadCost += m.cacheReadCost || 0;
      a.input += m.input; a.inputCost += m.inputCost || 0;
      a.cost += m.cost;
      return a;
    }, { output: 0, outputCost: 0, cacheCreate: 0, cacheCreateCost: 0, cacheRead: 0, cacheReadCost: 0, input: 0, inputCost: 0, cost: 0 });
    body.innerHTML = `
      <table class="model-detail-table">
        <thead><tr>
          <th>Model</th><th>Input</th><th>C.Write</th><th>C.Read</th><th>Output</th><th>Total</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td><strong>Total</strong></td>
          <td>${tc(tot.input, tot.inputCost)}</td>
          <td>${tc(tot.cacheCreate, tot.cacheCreateCost)}</td>
          <td>${tc(tot.cacheRead, tot.cacheReadCost)}</td>
          <td>${tc(tot.output, tot.outputCost)}</td>
          <td class="cost-badge"><strong>${formatCost(tot.cost)}</strong></td>
        </tr></tfoot>
      </table>`;
  }
  overlay.classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initLocalTab() {
  initModelDetailModal();
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('local-date-from').value = today;
  document.getElementById('local-date-to').value   = today;
  document.getElementById('local-date-from').addEventListener('change', loadLocalUsage);
  document.getElementById('local-date-to').addEventListener('change', loadLocalUsage);
  document.getElementById('btn-refresh-local').addEventListener('click', loadLocalUsage);
  document.getElementById('btn-clear-dates').addEventListener('click', () => {
    document.getElementById('local-date-from').value = '';
    document.getElementById('local-date-to').value = '';
    loadLocalUsage();
  });
}
