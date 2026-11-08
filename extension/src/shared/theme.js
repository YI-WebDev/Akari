// テーマ for extension pages (popup, passkey window). A classic script in <head>, so the page is
// drawn in the right theme from the first frame: it applies the theme this page last used
// (localStorage), and the page applies the stored setting again once it has read it.
// 'dark' is Akari's own look and the default; 'light' is the same lamp on warm paper; 'auto'
// follows the OS and changes with it. Sets <html data-theme="dark|light"> (shared/tokens.css).

(() => {
  'use strict';

  const KEY = 'akari.theme';
  const CHOICES = ['dark', 'light', 'auto'];
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  let pref = 'dark';

  const resolve = (p) => (p === 'light' || (p === 'auto' && media?.matches) ? 'light' : 'dark');
  const paint = () => { document.documentElement.dataset.theme = resolve(pref); };

  /** Use the テーマ setting ('dark' | 'light' | 'auto'); remembered for this page's next start. */
  function apply(next) {
    pref = CHOICES.includes(next) ? next : 'dark';
    paint();
    try { localStorage.setItem(KEY, pref); } catch { /* storage blocked: the setting still applies */ }
  }

  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) pref = saved;
  } catch { /* storage blocked: dark until the setting is read */ }
  paint();
  media?.addEventListener?.('change', () => { if (pref === 'auto') paint(); });

  globalThis.__akariTheme = Object.freeze({ apply, current: () => resolve(pref), pref: () => pref });
})();
