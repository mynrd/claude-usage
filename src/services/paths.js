const path = require('path');
const os = require('os');

// Split out of projects.js so the watcher (main process) and the parser
// (worker process) can both reach it without pulling in the parser.
function getClaudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

module.exports = { getClaudeProjectsDir };
