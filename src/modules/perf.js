// Renderer-side timing. Marks are stamped with ms since this module first
// evaluated (≈ first script byte executed) and shipped to the main process so
// the renderer and main timelines interleave in one perf.log.

const T0 = performance.now();

export function mark(label, info) {
  const ms = performance.now() - T0;
  console.log(`[perf] +${Math.round(ms)}ms ${label}`, info || '');
  try { window.api.perfMark(label, ms, info); } catch { /* preload not ready */ }
}

export async function timeAsync(label, fn) {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    mark(`${label} took ${(performance.now() - t).toFixed(0)}ms`);
  }
}
