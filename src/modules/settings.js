// Shared UI settings persisted to localStorage. Currently just the
// "include subagents" toggle, which folds agent-team / subagent token spend
// into every headline total (cards, project list, sessions, analytics).
const KEY = 'includeSubagents';

export function getIncludeSubagents() {
  return localStorage.getItem(KEY) === '1';
}

export function setIncludeSubagents(on) {
  localStorage.setItem(KEY, on ? '1' : '0');
}
