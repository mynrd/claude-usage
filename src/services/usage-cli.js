// Runs Claude Code's own `/usage` slash command non-interactively and parses
// the plain-text output. This is the *official* subscription usage (real
// percentages + reset times), as opposed to the local-transcript estimate in
// getRateWindows(). Output shape (Pro/Max, lines vary by plan):
//
//   You are currently using your subscription to power your Claude Code usage
//
//   Current session: 4% used · resets Jul 23, 1:39pm (Asia/Manila)
//   Current week (all models): 10% used · resets Jul 29, 6:59am (Asia/Manila)
//   Current week (Opus): 2% used · resets Jul 29, 6:59am (Asia/Manila)
//
// We parse every "<label>: N% used · resets <when>" line generically so new
// limit rows (e.g. per-model) surface automatically, and keep the raw text.

const { spawn } = require('child_process');

// `<label>: N% used · resets <when>`  (· is U+00B7; keep raw if reset absent)
const LIMIT_RE = /^(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+))?$/i;

function parseUsage(text) {
  const limits = [];
  let plan = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(LIMIT_RE);
    if (m) {
      limits.push({ label: m[1].trim(), pct: Number(m[2]), resets: (m[3] || '').trim() });
    } else if (!plan && /subscription|api|credit/i.test(line)) {
      plan = line;
    }
  }
  return { plan, limits };
}

// Resolves to { ok, raw, plan, limits, fetchedAt, error }. Never rejects — a
// failure (claude not on PATH, not logged in, timeout) comes back as ok:false
// with the captured message so the UI can show it instead of throwing.
function fetchCliUsage({ timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // Single command string + shell:true so Windows resolves claude.cmd;
      // stdin 'ignore' gives an immediate EOF (no interactive stdin wait).
      child = spawn('claude -p /usage', { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    } catch (e) {
      resolve({ ok: false, error: e.message, fetchedAt: Date.now() });
      return;
    }

    let out = '', err = '', done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, error: `timed out after ${timeoutMs / 1000}s`, fetchedAt: Date.now() });
    }, timeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ ok: false, error: e.message, fetchedAt: Date.now() }));
    child.on('close', (code) => {
      const raw = out.trim();
      if (code !== 0 && !raw) {
        finish({ ok: false, error: (err.trim() || `claude exited with code ${code}`), fetchedAt: Date.now() });
        return;
      }
      const { plan, limits } = parseUsage(raw);
      finish({ ok: true, raw, plan, limits, fetchedAt: Date.now() });
    });
  });
}

module.exports = { fetchCliUsage, parseUsage };
