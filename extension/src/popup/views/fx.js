const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => mq.matches;

const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+=?';
export const DIGITS = '0123456789';
const running = new Map();

export function cancelScramble(key) {
  const id = running.get(key);
  if (id) clearInterval(id);
  running.delete(key);
}

export function scramble(key, el, target, ms = 520, glyphs = GLYPHS, onDone) {
  cancelScramble(key);
  if (!el) return;
  const chars = Array.from(target);
  if (reducedMotion() || !chars.length) {
    el.textContent = target;
    onDone?.();
    return;
  }
  const t0 = performance.now();
  const step = () => {
    if (!el.isConnected) { cancelScramble(key); return; }
    const t = (performance.now() - t0) / ms;
    if (t >= 1) {
      cancelScramble(key);
      el.textContent = target;
      onDone?.();
      return;
    }
    const done = Math.floor(t * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      out += i < done || c === ' ' || c === '\n' ? c : glyphs[(Math.random() * glyphs.length) | 0];
    }
    el.textContent = out;
  };
  running.set(key, setInterval(step, 34));
  step();
}

export function scrambleWith(key, target, ms, render, glyphs = GLYPHS, onDone) {
  cancelScramble(key);
  const chars = Array.from(target);
  if (reducedMotion() || !chars.length) { render(target); onDone?.(); return; }
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / ms;
    if (t >= 1) { cancelScramble(key); render(target); onDone?.(); return; }
    const done = Math.floor(t * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) out += i < done || chars[i] === ' ' || chars[i] === '\n' ? chars[i] : glyphs[(Math.random() * glyphs.length) | 0];
    render(out);
  };
  running.set(key, setInterval(step, 34));
  step();
}

export function rise(container, selector = '[data-f]') {
  if (!container || reducedMotion()) return;
  container.querySelectorAll(selector).forEach((el) => {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: EASE_OUT, fill: 'backwards' });
  });
}

export function shake(el) {
  if (!el) return;
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
      { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
    { duration: reducedMotion() ? 1 : 260, easing: 'ease-out' },
  );
}

export function spin(el, ms = 360) {
  if (!el || reducedMotion()) return;
  el.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: ms, easing: EASE_OUT });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 30) : ms));
