function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('btn-theme');
  btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
  btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

export async function initTheme() {
  const cfg = await window.api.getConfig();
  applyTheme(cfg.theme || 'light');

  document.getElementById('btn-theme').addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    const c = await window.api.getConfig();
    c.theme = next;
    await window.api.saveConfig(c);
  });
}
