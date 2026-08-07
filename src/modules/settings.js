// Shared UI settings persisted to localStorage.
const KEY = 'includeSubagents';

export function getIncludeSubagents() {
  return localStorage.getItem(KEY) === '1';
}

export function setIncludeSubagents(on) {
  localStorage.setItem(KEY, on ? '1' : '0');
}

// User-entered 5h-window token ceiling (absolute tokens, 0 = unset). This is
// the user's own estimate — Anthropic does not publish plan quotas — so the
// UI labels anything derived from it as an estimate.
const CEILING_KEY = 'windowCeilingTokens';

export function getWindowCeiling() {
  const v = parseInt(localStorage.getItem(CEILING_KEY) || '0', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function setWindowCeiling(tokens) {
  localStorage.setItem(CEILING_KEY, String(Math.max(0, Math.round(tokens || 0))));
}

// Poll interval (minutes) for running `claude /usage`. 0 = manual only.
const USAGE_POLL_KEY = 'usagePollMinutes';
const DEFAULT_POLL_MIN = 5;

export function getUsagePollMinutes() {
  const raw = localStorage.getItem(USAGE_POLL_KEY);
  if (raw === null) return DEFAULT_POLL_MIN;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_POLL_MIN;
}

export function setUsagePollMinutes(min) {
  localStorage.setItem(USAGE_POLL_KEY, String(Math.max(0, Math.round(min || 0))));
}
