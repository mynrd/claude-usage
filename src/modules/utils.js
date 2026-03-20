export function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function barColor(pct) {
  if (pct < 50) return '#4A90D9';
  if (pct < 75) return '#F5A623';
  return '#E74C3C';
}

export function formatResetTime(iso) {
  if (!iso) return '\u2014';
  try {
    const dt = new Date(iso.replace('Z', '+00:00'));
    const now = new Date();
    const secs = Math.floor((dt - now) / 1000);
    if (secs > 0 && secs < 86400) {
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      return h ? `in ${h}h ${m}m` : `in ${m}m`;
    }
    return dt.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

export function deltaText(d) {
  if (d > 0) return `+${d.toFixed(0)}%`;
  if (d < 0) return `${d.toFixed(0)}%`;
  return '\u2014';
}

export function deltaClass(d) {
  if (d >= 5)  return 'delta-up';
  if (d <= -5) return 'delta-down';
  return 'delta-flat';
}

export function filterHistory(records, mode) {
  if (mode === 'all') return records;
  const now = new Date();
  let cutoff;
  if (mode === 'today') {
    cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (mode === '7d') {
    cutoff = new Date(now - 7 * 86400000);
  } else {
    cutoff = new Date(now - 30 * 86400000);
  }
  return records.filter(r => new Date(r.ts) >= cutoff);
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function highlightText(html, highlight) {
  if (!highlight) return html;
  const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="chat-highlight">$1</mark>');
}
