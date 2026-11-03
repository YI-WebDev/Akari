// Motion helpers from the design: scramble text, particle burst, list stagger,
// detail field rise, shake. All honour prefers-reduced-motion.

const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => mq.matches;

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+=?';
export const DIGITS = '0123456789';
const running = new Map();

export function cancelScramble(key) {
  const id = running.get(key);
  if (id) clearInterval(id);
  running.delete(key);
}

/** Reveal `target` into el.textContent left-to-right over `ms`, cycling random glyphs (cosmetic only). */
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

/** Same as scramble but renders into per-character spans via `render(text)`. */
export function scrambleWith(key, target, ms, render, glyphs = GLYPHS) {
  cancelScramble(key);
  const chars = Array.from(target);
  if (reducedMotion() || !chars.length) { render(target); return; }
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / ms;
    if (t >= 1) { cancelScramble(key); render(target); return; }
    const done = Math.floor(t * chars.length);
    let out = '';
    for (let i = 0; i < chars.length; i++) out += i < done || chars[i] === ' ' || chars[i] === '\n' ? chars[i] : glyphs[(Math.random() * glyphs.length) | 0];
    render(out);
  };
  running.set(key, setInterval(step, 34));
  step();
}

/** Confetti-like burst from the centre of `el`, drawn inside `root` (the 600×430 app). */
export function burst(root, el) {
  if (!root || !el || reducedMotion()) return;
  const r = el.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  const cols = [1, 2, 3, 4, 5].map((i) => cs.getPropertyValue('--burst-' + i).trim()).filter(Boolean);
  const radius = cs.getPropertyValue('--burst-r').trim() || '50%';
  const cx = r.left - rr.left + r.width / 2;
  const cy = r.top - rr.top + r.height / 2;
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('span');
    const s = 3 + Math.random() * 4;
    const a = (Math.PI * 2 * i) / 18 + Math.random() * 0.3;
    const d = 30 + Math.random() * 44;
    Object.assign(p.style, {
      position: 'absolute', left: cx + 'px', top: cy + 'px', width: s + 'px', height: s + 'px',
      marginLeft: -s / 2 + 'px', marginTop: -s / 2 + 'px', borderRadius: radius,
      background: cols[i % cols.length] || '#FF7A45', pointerEvents: 'none', zIndex: 60,
    });
    root.appendChild(p);
    p.animate(
      [{ transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d * 0.7}px) scale(.2)`, opacity: 0 }],
      { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.15,.8,.25,1)' },
    ).onfinish = () => p.remove();
  }
}

export function stagger(container, selector = '[data-row]', max = 15) {
  if (!container || reducedMotion()) return;
  container.querySelectorAll(selector).forEach((el, i) => {
    if (i >= max) return;
    el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: i * 28, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  });
}

export function rise(container, selector = '[data-f]') {
  if (!container || reducedMotion()) return;
  container.querySelectorAll(selector).forEach((el, i) => {
    el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 360, delay: i * 50, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  });
}

export function shake(el) {
  if (!el) return;
  el.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
    { duration: reducedMotion() ? 1 : 380, easing: 'ease-out' },
  );
}

export function spin(el, ms = 500) {
  if (!el || reducedMotion()) return;
  el.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: ms, easing: 'cubic-bezier(.3,1.3,.5,1)' });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 30) : ms));
