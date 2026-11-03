// The 12-segment strength meter of design 1a. Fill follows the bits (capped at 110),
// the colour follows the level. Segments light up left to right with an 18 ms stagger.

import { h } from './dom.js';

export const SEGS = 12;
const MAX_BITS = 110;

export const segFill = (bits) => (bits > 0 ? Math.max(1, Math.round((Math.min(bits, MAX_BITS) / MAX_BITS) * SEGS)) : 0);

function ensureSegs(meter) {
  const box = meter.querySelector('.segs');
  if (box.children.length !== SEGS) {
    box.replaceChildren();
    for (let i = 0; i < SEGS; i++) box.append(h('span', { vars: { '--d': `${i * 18}ms` } }));
  }
  return box.children;
}

/** <div class="meter"><div class="segs">×12</div><span class="lv-label"></span></div> */
export function meterEl(cls = '') {
  const meter = h('div', { class: ('meter ' + cls).trim(), 'data-lv': '0' }, h('div', { class: 'segs' }), h('span', { class: 'lv-label' }, '—'));
  ensureSegs(meter);
  return meter;
}

/**
 * Show a strength on a meter. `text` defaults to "<bits>bit · <label>" ("—" when empty).
 * With `animate`, the segments start empty and fill on the next frames (the design's sweep).
 */
export function setMeter(meter, { bits = 0, level = 0, label = '—' } = {}, { text, animate = false } = {}) {
  if (!meter) return;
  const segs = ensureSegs(meter);
  const fill = segFill(bits);
  meter.querySelector('.lv-label').textContent = text ?? (bits > 0 ? `${bits}bit · ${label}` : '—');
  const apply = () => {
    meter.dataset.lv = String(bits > 0 ? level : 0);
    for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', i < fill);
  };
  if (!animate) { apply(); return; }
  meter.dataset.lv = '0';
  for (const s of segs) s.classList.remove('on');
  requestAnimationFrame(() => requestAnimationFrame(apply));
}
