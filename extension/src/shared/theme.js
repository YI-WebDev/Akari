(() => {
  'use strict';

  const KEY = 'akari.theme';
  const CHOICES = ['dark', 'light', 'auto'];
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  let pref = 'dark';

  const resolve = (p) => (p === 'light' || (p === 'auto' && media?.matches) ? 'light' : 'dark');
  const paint = () => { document.documentElement.dataset.theme = resolve(pref); };

  function apply(next) {
    pref = CHOICES.includes(next) ? next : 'dark';
    paint();
    try { localStorage.setItem(KEY, pref); } catch { }
  }

  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) pref = saved;
  } catch { }
  paint();
  media?.addEventListener?.('change', () => { if (pref === 'auto') paint(); });

  globalThis.__akariTheme = Object.freeze({ apply, current: () => resolve(pref), pref: () => pref });
})();
