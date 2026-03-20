const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  listProjects: (startDate, endDate) => ipcRenderer.invoke('list-projects', { startDate, endDate }),
  getProjectDetail: (folder, startDate, endDate) => ipcRenderer.invoke('get-project-detail', { folder, startDate, endDate }),
  searchSessions: (folder, query) => ipcRenderer.invoke('search-sessions', { folder, query }),
  getSessionChat: (folder, sessionId) => ipcRenderer.invoke('get-session-chat', { folder, sessionId }),
  getTodaySummary: () => ipcRenderer.invoke('get-today-summary'),
  getAnalyticsData: (startDate, endDate) => ipcRenderer.invoke('get-analytics-data', { startDate, endDate }),
  onOpenWidget: (cb) => ipcRenderer.on('open-widget', cb),
  enterWidgetMode: () => ipcRenderer.invoke('enter-widget-mode'),
  exitWidgetMode: () => ipcRenderer.invoke('exit-widget-mode'),
  setWidgetPinned: (pinned) => ipcRenderer.invoke('set-widget-pinned', pinned),
});
