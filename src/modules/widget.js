import { estimateCost, formatCost } from './pricing.js';
import { formatNum } from './utils.js';

async function enterWidget() {
  const localEl = document.getElementById('widget-local');
  try {
    const today = await window.api.getTodaySummary();
    const todayCost = today.cost != null
      ? today.cost
      : estimateCost(today.input, today.output, today.cacheCreate || 0, today.cacheRead || 0, null);
    localEl.innerHTML = `
      <div class="widget-local-stat">
        Input: <strong>${formatNum(today.input)}</strong> &middot;
        Output: <strong>${formatNum(today.output)}</strong> &middot;
        Cache: <strong>${formatNum((today.cacheCreate || 0) + (today.cacheRead || 0))}</strong><br>
        Total today: <strong>${formatNum(today.total)}</strong> tokens &middot; <span class="cost-total">${formatCost(todayCost)}</span>
      </div>
    `;
  } catch {
    localEl.innerHTML = '<div style="color:#8A8A8A;font-size:12px">Unable to load local data</div>';
  }

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
