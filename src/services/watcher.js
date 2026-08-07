const fs = require('fs');
const { getClaudeProjectsDir } = require('./projects');

// Watch ~/.claude/projects for transcript writes so the UI refreshes itself
// while Claude Code is running. Events arrive in bursts during streaming —
// debounce so a busy session triggers at most one refresh per interval.
function startWatcher(onChange, debounceMs = 2000) {
  const dir = getClaudeProjectsDir();
  if (!fs.existsSync(dir)) return null;
  let timer = null;
  try {
    return fs.watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
  } catch {
    return null; // recursive watch unsupported — feature degrades to manual refresh
  }
}

module.exports = { startWatcher };
