// Tiny DOM builder. Text always goes through text nodes / textContent, never innerHTML,
// so vault data cannot inject markup. Icons are built from static constants only.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div', { class: 'row', onclick: fn, dataset: { id } }, child, 'text', [more])
 * Special props: class, text, dataset, vars (CSS custom properties), style (object), on* listeners.
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  appendKids(el, kids);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Static icon geometry (from the design). [tag, attrs] tuples.
const ICONS = {
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  star: [['path', { d: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z' }]],
  copy: [['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
  eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [
    ['path', { d: 'M3 3l18 18' }],
    ['path', { d: 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }],
  ],
  shield: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }], ['path', { d: 'M12 8v5M12 16h.01' }]],
  regen: [['path', { d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 4.5 }], ['path', { d: 'm10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2' }]],
  note: [['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }], ['path', { d: 'M14 3v6h6M8 13h8M8 17h5' }]],
  pencil: [['path', { d: 'M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z' }], ['path', { d: 'm13.5 6.5 4 4' }]],
  trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6' }], ['path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3' }]],
  passkey: [
    ['circle', { cx: 9, cy: 8, r: 4 }],
    ['path', { d: 'M2.5 20a6.5 6.5 0 0 1 10.2-5.3' }],
    ['circle', { cx: 18, cy: 13.5, r: 2.5 }],
    ['path', { d: 'M18 16v5M18 19h2' }],
  ],
  qr: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['path', { d: 'M14 14h3v3h-3zM21 14v.01M14 21h.01M17.5 21H21v-3.5' }],
  ],
  wand: [['path', { d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  external: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
};

export function icon(name, size = 14, strokeWidth) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (strokeWidth) svg.style.strokeWidth = strokeWidth;
  for (const [tag, attrs] of ICONS[name] || []) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  }
  return svg;
}

export function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}

/** Make everything behind an open sheet or the lock gate inert, so Tab stays in the dialog. */
export function syncInert() {
  const byId = (id) => document.getElementById(id);
  const gate = byId('gate').classList.contains('on');
  const sheet = byId('genSheet').classList.contains('open') || byId('setSheet').classList.contains('open');
  for (const sel of ['.hdr', '.body', '.status']) document.querySelector(sel).inert = gate || sheet;
  byId('genSheet').inert = gate;
  byId('setSheet').inert = gate;
}

/** Remember focus when a dialog opens; returns a function that restores it. */
export function keepFocus() {
  const prev = document.activeElement;
  return () => {
    if (prev && prev.isConnected && prev !== document.body && !prev.closest('[inert]')) prev.focus({ preventScroll: true });
  };
}

/** Copy button contents: copy icon, or the green check for ~1.5 s. */
export function copyGlyph(copied) {
  const svg = icon(copied ? 'check' : 'copy', 13);
  if (copied) svg.classList.add('copied-ico');
  return svg;
}
