const { Menu, Tray, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;

function createTray(getMainWindow) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Claude Usage');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show',        click: () => { getMainWindow().show(); getMainWindow().focus(); } },
    { label: 'Widget Mode', click: () => { getMainWindow().show(); getMainWindow().webContents.send('open-widget'); } },
    { type: 'separator' },
    { label: 'Quit',        click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { getMainWindow().show(); getMainWindow().focus(); });
}

function getTray() { return tray; }

module.exports = { createTray, getTray };
