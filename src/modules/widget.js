import { estimateCost, formatCost } from './pricing.js';
import { formatNum, barColor } from './utils.js';
import { getIncludeSubagents, getWindowCeiling } from './settings.js';

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export async function refreshWidget() {
  const localEl = document.getElementById('widget-local');
  try {
    const today = await window.api.getTodaySummary(getIncludeSubagents());
    const todayCost = today.cost != null
      ? today.cost
      : estimateCost(today.input, today.output, today.cacheCreate || 0, today.cacheRead || 0, null);
    localEl.innerHTML = `
      <div class="widget-local-stat">
        Input: <strong>${formatNum(today.input)}</strong> &middot;
        Output: <strong>${formatNum(today.output)}</strong> &middot;
        Cache: <strong>${formatNum((today.cacheCreate || 0) + (today.cacheRead || 0))}</strong><br>
        Total today: <strong>${formatNum(today.total)}</strong> tokens &middot; <span class="cost-total">${formatCost(todayCost)}</span>${
          typeof today.messages === 'number' ? ` &middot; Messages: <strong>${formatNum(today.messages)}</strong>` : ''}
      </div>
    `;
  } catch {
    localEl.innerHTML = '<div style="color:#8A8A8A;font-size:12px">Unable to load local data</div>';
  }

  const winEl = document.getElementById('widget-window');
  try {
    const { current, now } = await window.api.getRateWindows(getIncludeSubagents());
    if (!current) {
      winEl.innerHTML = '<div class="widget-local-stat">No active window</div>';
    } else {
      const elapsedMs = Math.max(now - current.start, 5 * 60 * 1000);
      const perHour = current.total / (elapsedMs / 3600000);
      const ceiling = getWindowCeiling();
      let gauge = '';
      if (ceiling > 0) {
        const pct = Math.min(100, (current.total / ceiling) * 100);
        gauge = `<div class="rw-track"><div class="rw-fill" style="width:${pct.toFixed(1)}%;background:${barColor(pct)}"></div></div>`;
      }
      winEl.innerHTML = `
        <div class="widget-local-stat">
          ${fmtTime(current.start)} – ${fmtTime(current.end)} &middot;
          <strong>${formatNum(current.total)}</strong> tokens &middot; <span class="cost-total">${formatCost(current.cost)}</span><br>
          ${formatNum(Math.round(perHour))}/hr
        </div>
        ${gauge}`;
    }
  } catch {
    winEl.innerHTML = '';
  }
}

async function enterWidget() {
  await refreshWidget();
  document.body.classList.add('widget-mode');
  await window.api.enterWidgetMode();
}

async function exitWidget() {
  document.body.classList.remove('widget-mode');
  setPinUI(false);
  await window.api.exitWidgetMode();
}

let pinned = false;

function setPinUI(isPinned) {
  pinned = isPinned;
  const btn = document.getElementById('btn-pin-widget');
  btn.classList.toggle('is-pinned', pinned);
  btn.textContent = pinned ? 'Unpin' : 'Pin';
  btn.title = pinned ? 'Click to let other windows cover this' : 'Keep window above others';
}

async function togglePin() {
  await window.api.setWidgetPinned(!pinned);
  setPinUI(!pinned);
}

export function initWidget() {
  document.getElementById('btn-widget-mode').addEventListener('click', enterWidget);
  document.getElementById('btn-exit-widget').addEventListener('click', exitWidget);
  document.getElementById('btn-pin-widget').addEventListener('click', togglePin);
  setPinUI(false);
}
