const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  listProjects: (startDate, endDate, includeSub) => ipcRenderer.invoke('list-projects', { startDate, endDate, includeSub }),
  getProjectDetail: (folder, startDate, endDate, includeSub) => ipcRenderer.invoke('get-project-detail', { folder, startDate, endDate, includeSub }),
  searchSessions: (folder, query) => ipcRenderer.invoke('search-sessions', { folder, query }),
  getSessionChat: (folder, sessionId) => ipcRenderer.invoke('get-session-chat', { folder, sessionId }),
  getSessionSubagents: (folder, sessionId) => ipcRenderer.invoke('get-session-subagents', { folder, sessionId }),
  getTodaySummary: (includeSub) => ipcRenderer.invoke('get-today-summary', { includeSub }),
  getAnalyticsData: (startDate, endDate, includeSub) => ipcRenderer.invoke('get-analytics-data', { startDate, endDate, includeSub }),
  onOpenWidget: (cb) => ipcRenderer.on('open-widget', cb),
  enterWidgetMode: () => ipcRenderer.invoke('enter-widget-mode'),
  exitWidgetMode: () => ipcRenderer.invoke('exit-widget-mode'),
  setWidgetPinned: (pinned) => ipcRenderer.invoke('set-widget-pinned', pinned),
});
