const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { loadConfig, saveConfig } = require('./config');
const { listLocalProjects, getProjectDetail, getTodayLocalSummary, getSessionChat, getSessionSubagents, searchSessions, getAggregatedDailyTotals, getRateWindows, clearCostCaches } = require('./projects');
const { getLatestSnapshot, saveSnapshot } = require('./price-history');
const { fetchCliUsage } = require('./usage-cli');
const { getStatsCache } = require('./stats-cache');

function setupIpc(getMainWindow) {
  ipcMain.handle('get-config',  ()         => loadConfig());
  ipcMain.handle('save-config', (_, cfg)   => { saveConfig(cfg); return true; });

  ipcMain.handle('list-projects',          (_, opts) => listLocalProjects(opts?.startDate || null, opts?.endDate || null, !!opts?.includeSub));
  ipcMain.handle('get-project-detail',     (_, opts) => getProjectDetail(opts?.folder, opts?.startDate || null, opts?.endDate || null, !!opts?.includeSub));
  ipcMain.handle('search-sessions',        (_, opts) => searchSessions(opts?.folder, opts?.query));
  ipcMain.handle('get-session-chat',       (_, opts) => getSessionChat(opts?.folder, opts?.sessionId));
  ipcMain.handle('get-session-subagents',  (_, opts) => getSessionSubagents(opts?.folder, opts?.sessionId));
  ipcMain.handle('get-today-summary',      (_, opts) => getTodayLocalSummary(!!opts?.includeSub));
  ipcMain.handle('get-analytics-data',     (_, opts) => getAggregatedDailyTotals(opts?.startDate || null, opts?.endDate || null, !!opts?.includeSub));
  ipcMain.handle('get-rate-windows',       (_, opts) => getRateWindows(opts?.includeSub !== false));
  ipcMain.handle('get-cli-usage',          () => fetchCliUsage());
  ipcMain.handle('get-stats-cache',        () => getStatsCache());

  ipcMain.handle('get-price-snapshot', () => getLatestSnapshot());
  ipcMain.handle('save-price-snapshot', (_, { prices }) => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    saveSnapshot(prices, today);
    clearCostCaches(); // subagent aggregates bake in costs — recompute at new rates
    return today;
  });

  ipcMain.handle('export-file', async (_, { defaultName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(getMainWindow(), { defaultPath: defaultName });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  });

  ipcMain.handle('enter-widget-mode', () => {
    const win = getMainWindow();
    win.setMinimumSize(380, 300);
    win.setSize(380, 360);
    win.setResizable(false);
    win.setAlwaysOnTop(false);
    return true;
  });

  ipcMain.handle('exit-widget-mode', () => {
    const win = getMainWindow();
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    win.setMinimumSize(700, 500);
    win.setSize(1100, 900);
    win.center();
    return true;
  });

  ipcMain.handle('set-widget-pinned', (_, pinned) => {
    const win = getMainWindow();
    win.setAlwaysOnTop(!!pinned);
    return !!pinned;
  });
}

module.exports = { setupIpc };
