const { BrowserWindow, app } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#F7F7F5',
    title: 'Claude Usage',
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') mainWindow.webContents.toggleDevTools();
    if (input.key === 'F11' && input.type === 'keyDown') mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function getMainWindow() { return mainWindow; }

module.exports = { createWindow, getMainWindow };
