const SVG_NS = 'http://www.w3.org/2000/svg';

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

/** The key belongs to an IME composition (confirming or cancelling it), not to a shortcut. */
export const isComposing = (e) => e.isComposing || e.keyCode === 229;

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const brLines = (text) => String(text).split('\n').flatMap((s, i) => (i ? [h('br'), s] : [s]));

const ICONS = {
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  import: [['path', { d: 'M12 20V9M7 14l5-5 5 5M5 4h14' }]],
  arrowRight: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  x: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  star: [['path', { d: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z' }]],
  rows: [['path', { d: 'M4 6h16M4 12h16M4 18h10' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
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
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }]],
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
  chevLeft: [['path', { d: 'm15 6-6 6 6 6' }]],
  chevRight: [['path', { d: 'm9 6 6 6-6 6' }]],
  login: [['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' }], ['path', { d: 'm10 17 5-5-5-5M15 12H3' }]],
  card: [['rect', { x: 2, y: 5, width: 20, height: 14, rx: 2 }], ['path', { d: 'M2 10h20M6 15h4' }]],
  idCard: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 9, cy: 10.5, r: 2.5 }], ['path', { d: 'M5.5 17a3.5 3.5 0 0 1 7 0M15 9.5h3M15 13.5h3' }]],
  more: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
  ],
  code: [['path', { d: 'm8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16' }]],
  database: [['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }], ['path', { d: 'M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3' }]],
  server: [['rect', { x: 3, y: 3, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 14, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 6.5h.01M7 17.5h.01' }]],
  badge: [['circle', { cx: 12, cy: 9, r: 6 }], ['path', { d: 'M8.5 13.8 7 22l5-3 5 3-1.5-8.2' }]],
  terminal: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'm7 9 3 3-3 3M12 15h5' }]],
  wifi: [['path', { d: 'M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01' }]],
  bank: [['path', { d: 'M3 21h18M12 3 3 8h18zM5 11v7M9.5 11v7M14.5 11v7M19 11v7' }]],
  wallet: [['rect', { x: 3, y: 6, width: 18, height: 14, rx: 2 }], ['path', { d: 'M6 6V4.5A1.5 1.5 0 0 1 7.5 3H17M21 11h-4a2 2 0 0 0 0 4h4' }]],
  car: [['path', { d: 'M3 16v-4l2.5-6h13L21 12v4zM3 12h18' }], ['circle', { cx: 7, cy: 16, r: 2 }], ['circle', { cx: 17, cy: 16, r: 2 }]],
  medical: [['path', { d: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z' }]],
  users: [['circle', { cx: 9, cy: 8, r: 4 }], ['path', { d: 'M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3' }]],
  passport: [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['circle', { cx: 12, cy: 10, r: 3.5 }], ['path', { d: 'M9 17.5h6' }]],
  gift: [['rect', { x: 3, y: 8, width: 18, height: 4, rx: 1 }], ['path', { d: 'M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M12 8C10.5 4 7 4 7 6s2 2 5 2 5 0 5-2-3.5-2-5 2' }]],
  shieldUser: [['path', { d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }], ['circle', { cx: 12, cy: 10, r: 2.2 }], ['path', { d: 'M8.5 16.5a3.5 3.5 0 0 1 7 0' }]],
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

export function syncInert() {
  const byId = (id) => document.getElementById(id);
  const gate = byId('gate').classList.contains('on');
  const sheets = ['genSheet', 'setSheet', 'healthSheet', 'trashSheet'];
  const sheet = sheets.some((id) => byId(id).classList.contains('open'));
  for (const sel of ['.hdr', '.body']) document.querySelector(sel).inert = gate || sheet;
  for (const id of sheets) byId(id).inert = gate;
}

export function keepFocus() {
  const prev = document.activeElement;
  return () => {
    if (prev && prev.isConnected && prev !== document.body && !prev.closest('[inert]')) prev.focus({ preventScroll: true });
  };
}

export function copyGlyph(copied) {
  const svg = icon(copied ? 'check' : 'copy', 13);
  if (copied) svg.classList.add('copied-ico');
  return svg;
}
