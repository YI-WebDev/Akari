import { generateTotp } from '../../lib/totp.js';
import { t } from '../../shared/i18n.js';
import { h } from './dom.js';
import { formatCode } from './format.js';
import { scramble, cancelScramble, DIGITS } from './fx.js';

const TICKS = 30;
const WARN_SECONDS = 5;
let seq = 0;

export function totpView(config) {
  const key = 'totp-' + ++seq;
  const period = Number(config?.period) || 30;
  const digits = Number(config?.digits) || 6;
  const code = h('span', { class: 'totp-code' }, formatCode('•'.repeat(digits)));
  const rem = h('span', { class: 'totp-rem', role: 'timer' });
  const ticks = h('div', { class: 'ticks', 'aria-hidden': 'true' });
  for (let i = 0; i < TICKS; i++) ticks.append(h('span'));
  const col = h('div', { class: 'totp-col' }, h('div', { class: 'totp-top' }, code, rem), ticks);

  let host = null;
  let timer = 0;
  let counter = null;
  let current = '';
  let alive = false;
  let lastOn = -1;

  async function refresh(now, animate) {
    try {
      const c = await generateTotp(config, now);
      if (!alive) return;
      current = c;
      if (animate) scramble(key, code, formatCode(c), 420, DIGITS);
      else code.textContent = formatCode(c);
    } catch {
      if (alive) code.textContent = '— — —';
    }
  }

  function tick() {
    const now = Date.now();
    const left = period - ((now / 1000) % period);
    const ri = Math.ceil(left);
    const ctr = Math.floor(now / 1000 / period);
    if (ctr !== counter) {
      const first = counter === null;
      counter = ctr;
      refresh(now, !first);
    }
    rem.textContent = `${ri}s`;
    rem.setAttribute('aria-label', t('残り {n} 秒', { n: ri }));
    const on = Math.ceil((left / period) * TICKS);
    if (on !== lastOn) {
      lastOn = on;
      for (let i = 0; i < TICKS; i++) ticks.children[i].classList.toggle('on', i < on);
    }
    host?.classList.toggle('warn', ri <= WARN_SECONDS);
  }

  return {
    col,
    code,
    start(hostEl) {
      host = hostEl;
      alive = true;
      tick();
      timer = setInterval(tick, 200);
    },
    stop() {
      alive = false;
      clearInterval(timer);
      cancelScramble(key);
    },
    current: () => current,
  };
}
