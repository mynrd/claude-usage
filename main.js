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

const perf = require('./src/services/perf');
perf.banner('app start');

const { createWindow, getMainWindow }   = perf.time('require window',  () => require('./src/services/window'));
const { createTray, updateTrayTooltip } = perf.time('require tray',    () => require('./src/services/tray'));
const { setupIpc }                      = perf.time('require ipc',     () => require('./src/services/ipc'));
const { startWatcher }                  = perf.time('require watcher', () => require('./src/services/watcher'));
const worker                            = require('./src/services/worker-client');

perf.time('setupIpc', () => setupIpc(getMainWindow));

app.whenReady().then(() => {
  perf.mark('app.whenReady');
  Menu.setApplicationMenu(null);
  // Spawn the parser first: it loads the on-disk parse cache while Chromium is
  // still bringing the window up, so the renderer's first query hits a warm one.
  perf.time('start parser worker', () => worker.start());
  perf.time('createWindow', () => createWindow());
  perf.time('createTray', () => createTray(getMainWindow));

  perf.time('startWatcher', () => startWatcher(() => {
    // Drop the cached directory sweep before anyone queries — ordered ahead of
    // the renderer's refresh because worker messages are processed in order.
    worker.notify('invalidateScan');
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('usage-changed');
    updateTrayTooltip();
  }));
  // Defer the first tooltip — the renderer's initial load warms the parse
  // cache, making this near-free instead of a second cold scan.
  setTimeout(() => perf.time('updateTrayTooltip (deferred)', updateTrayTooltip), 8000);
});

// Persist whatever the parser learned this run before the process goes away.
let flushing = false;
app.on('before-quit', (e) => {
  if (flushing) return;
  flushing = true;
  e.preventDefault();
  const finish = () => { worker.stop(); app.quit(); };
  Promise.race([
    worker.call('flushCache', {}),
    new Promise(resolve => setTimeout(resolve, 1500)),  // never hold up quit
  ]).then(finish, finish);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else getMainWindow().show();
});
