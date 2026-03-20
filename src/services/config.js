const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigFile() {
  return path.join(getDataDir(), 'config.json');
}

function loadConfig() {
  const configFile = getConfigFile();
  // Migrate old config.json from project root if needed
  const oldConfig = path.join(__dirname, '..', '..', 'config.json');
  if (!fs.existsSync(configFile) && fs.existsSync(oldConfig)) {
    fs.copyFileSync(oldConfig, configFile);
  }
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(getConfigFile(), JSON.stringify(cfg, null, 2));
}

module.exports = { getDataDir, getConfigFile, loadConfig, saveConfig };
