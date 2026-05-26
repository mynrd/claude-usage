import { initLocalTab, loadLocalUsage }    from './modules/local-tab.js';
import { initAnalyticsTab, loadAnalytics } from './modules/analytics-tab.js';
import { initChatViewer }                  from './modules/chat-viewer.js';
import { initWidget }                      from './modules/widget.js';
import { initTheme }                       from './modules/theme.js';

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'local') loadLocalUsage();
    if (tab.dataset.tab === 'analytics') loadAnalytics();
  });
});

// ── Tray events ───────────────────────────────────────────────────────────────
window.api.onOpenWidget(() => document.getElementById('btn-widget-mode').click());

// ── Init ──────────────────────────────────────────────────────────────────────
initLocalTab();
initAnalyticsTab();
initChatViewer();
initWidget();
initTheme();

loadLocalUsage();
