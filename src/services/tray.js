const { Menu, Tray, nativeImage, app } = require('electron');
const path = require('path');
const { getTodayLocalSummary } = require('./projects');

let tray = null;

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function updateTrayTooltip() {
  if (!tray) return;
  try {
    const t = getTodayLocalSummary(false);
    tray.setToolTip(`Claude Usage — Today: ${fmtTokens(t.total)} tokens · $${t.cost.toFixed(2)}`);
  } catch {
    tray.setToolTip('Claude Usage');
  }
}

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

module.exports = { createTray, getTray, updateTrayTooltip };
