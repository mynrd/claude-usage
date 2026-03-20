// Ensure we're running as Electron, not plain Node
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, Menu } = require('electron');
app.commandLine.appendSwitch('disable-gpu-cache');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

const { createWindow, getMainWindow } = require('./src/services/window');
const { createTray }                  = require('./src/services/tray');
const { setupIpc }                    = require('./src/services/ipc');

setupIpc(getMainWindow);

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  createTray(getMainWindow);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else getMainWindow().show();
});
