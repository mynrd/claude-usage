const { ipcMain } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const { listLocalProjects, getProjectDetail, getTodayLocalSummary, getSessionChat, searchSessions, getAggregatedDailyTotals } = require('./projects');

function setupIpc(getMainWindow) {
  ipcMain.handle('get-config',  ()         => loadConfig());
  ipcMain.handle('save-config', (_, cfg)   => { saveConfig(cfg); return true; });

  ipcMain.handle('list-projects',          (_, opts) => listLocalProjects(opts?.startDate || null, opts?.endDate || null));
  ipcMain.handle('get-project-detail',     (_, opts) => getProjectDetail(opts?.folder, opts?.startDate || null, opts?.endDate || null));
  ipcMain.handle('search-sessions',        (_, opts) => searchSessions(opts?.folder, opts?.query));
  ipcMain.handle('get-session-chat',       (_, opts) => getSessionChat(opts?.folder, opts?.sessionId));
  ipcMain.handle('get-today-summary',      ()        => getTodayLocalSummary());
  ipcMain.handle('get-analytics-data',     (_, opts) => getAggregatedDailyTotals(opts?.startDate || null, opts?.endDate || null));

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
