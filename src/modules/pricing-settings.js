import { escapeHtml } from './utils.js';

// In-app editor for model pricing. Shows the latest price-history snapshot;
// saving appends a snapshot dated today to the live price-history.json (a
// same-day save replaces today's snapshot). Historical usage keeps the rates
// that were in effect on its dates — see README "Updating Model Pricing".

const FIELDS = [
  { key: 'input',        label: 'Input' },
  { key: 'cacheWrite5m', label: 'Cache Write 5m' },
  { key: 'cacheWrite1h', label: 'Cache Write 1h' },
  { key: 'cacheRead',    label: 'Cache Read' },
  { key: 'output',       label: 'Output' },
];

let onSaved = null;

function rowHtml(p = {}) {
  const cells = FIELDS.map(f =>
    `<td><input type="number" min="0" step="0.01" data-field="${f.key}" value="${p[f.key] != null ? p[f.key] : ''}" /></td>`
  ).join('');
  return `<tr class="price-row">
    <td><input type="text" data-field="model" value="${escapeHtml(p.model || '')}" placeholder="e.g. opus-4.8" /></td>
    ${cells}
    <td><button class="btn-row-icon price-row-del" title="Remove model from the new snapshot">&times;</button></td>
  </tr>`;
}

function bindRowDeletes(tbody) {
  tbody.querySelectorAll('.price-row-del').forEach(btn => {
    btn.onclick = () => btn.closest('tr').remove();
  });
}

async function openPricingModal() {
  const overlay = document.getElementById('pricing-overlay');
  const body = document.getElementById('pricing-body');
  const snapshot = await window.api.getPriceSnapshot();
  const prices = snapshot?.prices || [];

  body.innerHTML = `
    <p class="pricing-note">
      Rates in <strong>$ / million tokens</strong>. Effective snapshot:
      <strong>${escapeHtml(snapshot?.date || 'none')}</strong>.
      Saving creates a new snapshot dated today — usage before today keeps its historical rates.
      Check <a href="https://www.anthropic.com/pricing" target="_blank">anthropic.com/pricing</a> for current list prices.
    </p>
    <table class="model-detail-table price-edit-table">
      <thead><tr>
        <th>Model key</th>${FIELDS.map(f => `<th>${f.label}</th>`).join('')}<th></th>
      </tr></thead>
      <tbody id="price-rows">${prices.map(rowHtml).join('')}</tbody>
    </table>
    <div class="pricing-actions">
      <button id="btn-price-add" class="btn btn-small">+ Add model</button>
      <span class="pricing-error" id="pricing-error"></span>
      <button id="btn-price-save" class="btn btn-accent">Save as today's snapshot</button>
    </div>`;

  const tbody = body.querySelector('#price-rows');
  bindRowDeletes(tbody);

  body.querySelector('#btn-price-add').addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', rowHtml());
    bindRowDeletes(tbody);
    tbody.lastElementChild.querySelector('input').focus();
  });

  body.querySelector('#btn-price-save').addEventListener('click', async () => {
    const errEl = body.querySelector('#pricing-error');
    const rows = [...tbody.querySelectorAll('.price-row')];
    const out = [];
    for (const tr of rows) {
      const p = {};
      for (const input of tr.querySelectorAll('input')) {
        const f = input.dataset.field;
        p[f] = f === 'model' ? input.value.trim() : parseFloat(input.value);
      }
      if (!p.model) { errEl.textContent = 'Every row needs a model key.'; return; }
      for (const f of FIELDS) {
        if (!Number.isFinite(p[f.key]) || p[f.key] < 0) {
          errEl.textContent = `${p.model}: "${f.label}" must be a number ≥ 0.`;
          return;
        }
      }
      out.push(p);
    }
    if (!out.length) { errEl.textContent = 'At least one model is required.'; return; }
    errEl.textContent = '';
    await window.api.savePriceSnapshot(out);
    overlay.classList.add('hidden');
    if (onSaved) onSaved();
  });

  overlay.classList.remove('hidden');
}

export function initPricingSettings(savedCallback) {
  onSaved = savedCallback;
  const overlay = document.createElement('div');
  overlay.id = 'pricing-overlay';
  overlay.className = 'model-detail-overlay hidden';
  overlay.innerHTML = `
    <div class="model-detail-card pricing-card">
      <div class="model-detail-header">
        <span class="model-detail-title">Model Pricing</span>
        <button id="pricing-close" class="modal-close-btn">×</button>
      </div>
      <div id="pricing-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#pricing-close').addEventListener('click', () => overlay.classList.add('hidden'));

  document.getElementById('btn-pricing').addEventListener('click', openPricingModal);
}
