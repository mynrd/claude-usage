import { initLocalTab, loadLocalUsage }    from './modules/local-tab.js';
import { initAnalyticsTab, loadAnalytics } from './modules/analytics-tab.js';
import { initStatsTab, loadStats }         from './modules/stats-tab.js';
import { initChatViewer }                  from './modules/chat-viewer.js';
import { initWidget, refreshWidget }       from './modules/widget.js';
import { initTheme }                       from './modules/theme.js';
import { initPricingSettings }             from './modules/pricing-settings.js';
import { mark, timeAsync }                 from './modules/perf.js';

mark('renderer.js evaluated');

function refreshActiveView() {
  if (document.body.classList.contains('widget-mode')) { refreshWidget(); return; }
  const active = document.querySelector('.tab.active')?.dataset.tab;
  if (active === 'local' || active === 'projects') loadLocalUsage();
  if (active === 'analytics') loadAnalytics();
  if (active === 'stats') loadStats();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
// Local Usage and Projects share one date range, so the filter bar rides above
// the panes and is hidden for the tabs that carry their own filter.
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${name}`).classList.add('active');
    document.getElementById('shared-filter').hidden = name !== 'local' && name !== 'projects';
    if (name === 'local' || name === 'projects') loadLocalUsage();
    if (name === 'analytics') loadAnalytics();
    if (name === 'stats') loadStats();
  });
});

// ── Tray events ───────────────────────────────────────────────────────────────
window.api.onOpenWidget(() => document.getElementById('btn-widget-mode').click());

// ── Live refresh ──────────────────────────────────────────────────────────────
// The main process watches ~/.claude/projects and pings when transcripts
// change. Skip while the user is typing in a field (search, date, limit) so a
// re-render doesn't wipe their input; skip while the chat viewer is open —
// it's a static snapshot anyway.
window.api.onUsageChanged(() => {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  if (!document.getElementById('chat-overlay').classList.contains('hidden')) return;
  refreshActiveView();
});

// ── Init ──────────────────────────────────────────────────────────────────────
const initStart = performance.now();
for (const [name, fn] of [
  ['initLocalTab', initLocalTab],
  ['initAnalyticsTab', initAnalyticsTab],
  ['initStatsTab', initStatsTab],
  ['initChatViewer', initChatViewer],
  ['initWidget', initWidget],
  ['initTheme', initTheme],
  ['initPricingSettings', () => initPricingSettings(refreshActiveView)],
]) {
  const t = performance.now();
  fn();
  mark(`${name} took ${(performance.now() - t).toFixed(0)}ms`);
}
mark(`all init took ${(performance.now() - initStart).toFixed(0)}ms`);

timeAsync('first loadLocalUsage', loadLocalUsage);
