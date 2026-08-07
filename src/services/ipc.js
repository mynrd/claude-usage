const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const perf = require('./perf');
const { loadConfig, saveConfig } = require('./config');
const { getLatestSnapshot, saveSnapshot } = require('./price-history');
const { fetchCliUsage } = require('./usage-cli');
const worker = require('./worker-client');

function setupIpc(getMainWindow) {
  // Every handler is timed. Transcript work is delegated to the parser worker,
  // so these durations are message round-trips, not main-thread stalls.
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (evt, arg) => perf.timeAsync(`ipc ${channel}`, () => fn(evt, arg)));
  };

  // Renderer-side marks land in the same log/timeline as the main process.
  ipcMain.on('perf-mark', (_, { label, ms, info }) => {
    perf.mark(`renderer ${label}`, ms != null ? { atMs: Math.round(ms), ...(info || {}) } : info);
  });

  handle('get-config',  ()         => loadConfig());
  handle('save-config', (_, cfg)   => { saveConfig(cfg); return true; });

  // Folder results stream back as they finish so the project list fills in
  // during a cold scan instead of appearing all at once at the end.
  handle('list-projects', (_, opts) => worker.call('listProjects', {
    startDate: opts?.startDate || null,
    endDate: opts?.endDate || null,
    includeSub: !!opts?.includeSub,
  }, (payload) => {
    const win = getMainWindow();
    // seq lets the renderer drop progress belonging to a superseded scan.
    if (win && !win.isDestroyed()) win.webContents.send('usage-progress', { ...payload, seq: opts?.seq });
  }));

  handle('get-project-detail',     (_, opts) => worker.call('projectDetail', { folder: opts?.folder, startDate: opts?.startDate || null, endDate: opts?.endDate || null, includeSub: !!opts?.includeSub }));
  handle('search-sessions',        (_, opts) => worker.call('searchSessions', { folder: opts?.folder, query: opts?.query }));
  handle('get-session-chat',       (_, opts) => worker.call('sessionChat', { folder: opts?.folder, sessionId: opts?.sessionId }));
  handle('get-session-subagents',  (_, opts) => worker.call('sessionSubagents', { folder: opts?.folder, sessionId: opts?.sessionId }));
  handle('get-today-summary',      (_, opts) => worker.call('todaySummary', { includeSub: !!opts?.includeSub }));
  handle('get-analytics-data',     (_, opts) => worker.call('analytics', { startDate: opts?.startDate || null, endDate: opts?.endDate || null, includeSub: !!opts?.includeSub }));
  handle('get-rate-windows',       (_, opts) => worker.call('rateWindows', { includeSub: opts?.includeSub !== false }));
  handle('get-cli-usage',          () => fetchCliUsage());
  handle('get-stats-cache',        () => worker.call('statsCache', {}));

  handle('get-price-snapshot', () => getLatestSnapshot());
  handle('save-price-snapshot', async (_, { prices }) => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    saveSnapshot(prices, today);
    await worker.call('clearCostCaches', {}); // aggregates bake in costs — recompute at new rates
    return today;
  });

  handle('export-file', async (_, { defaultName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), { defaultPath: defaultName });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  });

  handle('enter-widget-mode', () => {
    const win = getMainWindow();
    win.setMinimumSize(380, 300);
    win.setSize(380, 360);
    win.setResizable(false);
    win.setAlwaysOnTop(false);
    return true;
  });

  handle('exit-widget-mode', () => {
    const win = getMainWindow();
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    win.setMinimumSize(700, 500);
    win.setSize(1100, 900);
    win.center();
    return true;
  });

  handle('set-widget-pinned', (_, pinned) => {
    const win = getMainWindow();
    win.setAlwaysOnTop(!!pinned);
    return !!pinned;
  });
}

module.exports = { setupIpc };
