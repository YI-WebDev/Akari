import { h, clear, isComposing } from './dom.js';

const $ = (id) => document.getElementById(id);

export function cmdLine(text) {
  return h('div', { class: 'io-cmd', 'aria-hidden': 'true', 'data-f': '' },
    h('span', { class: 'ps' }, '$ '), h('span', { class: 'io-cmd-text' }, text), h('span', { class: 'cursor' }));
}

export function logLine(state, k, v = '') {
  const tag = h('span', { class: 'boot-tag' });
  const key = h('span', { class: 'boot-k' });
  const val = h('span', { class: 'boot-v' });
  const line = h('div', { class: 'boot-line io-line' }, tag, key, h('span', { class: 'boot-dots', 'aria-hidden': 'true' }), val);
  line.set = (s, k2, v2 = '') => {
    line.dataset.state = s;
    tag.textContent = { run: '[ .. ]', err: '[ !! ]', ask: '[ ?? ]' }[s] || '[ ok ]';
    key.textContent = k2;
    val.textContent = v2;
    val.title = v2;
  };
  line.set(state, k, v);
  return line;
}

export function sentenceWith(text, key, el) {
  const mark = `{${key}}`;
  const i = text.indexOf(mark);
  if (i < 0) return [text, el];
  return [text.slice(0, i) || null, el, text.slice(i + mark.length) || null];
}

export function setTrail(steps, current) {
  const ol = $('setTrail');
  clear(ol);
  ol.hidden = !steps?.length;
  (steps || []).forEach((label, i) => {
    const li = h('li', { class: i < current ? 'done' : i === current ? 'cur' : '' }, label);
    if (i === current) li.setAttribute('aria-current', 'step');
    ol.append(li);
  });
}

export function setRoving(items, idx) {
  items.forEach((b, k) => { b.tabIndex = k === idx ? 0 : -1; });
}

export function arrowNav(root, selector, { cols = 1, onMove } = {}) {
  root.addEventListener('keydown', (e) => {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = [...root.querySelectorAll(selector)].filter((b) => !b.disabled);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    let n;
    if (step != null) n = i + step;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else return;
    e.preventDefault();
    n = Math.max(0, Math.min(items.length - 1, n));
    if (n === i) return;
    setRoving(items, n);
    items[n].focus();
    onMove?.(items[n]);
  });
}

const DOWNLOAD_URL_LIFETIME_MS = 4000;
const revokeTimers = new Map();

function revoke(url) {
  clearTimeout(revokeTimers.get(url));
  revokeTimers.delete(url);
  URL.revokeObjectURL(url);
}

export function downloadFile(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  revokeTimers.set(url, setTimeout(() => revoke(url), DOWNLOAD_URL_LIFETIME_MS));
}

export function revokeDownloads() {
  for (const url of [...revokeTimers.keys()]) revoke(url);
}

export function safeFileName(name, fallback) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return s || fallback;
}

export function setBusy(btn, busy) {
  if (!btn) return;
  btn.style.minWidth = busy ? `${btn.offsetWidth}px` : '';
  btn.classList.toggle('busy', busy);
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
}

export function goButton(label, props = {}) {
  return h('button', { class: 'btn-primary', type: 'button', ...props },
    h('span', { class: 'go-label' }, label), h('span', { class: 'spinner', 'aria-hidden': 'true' }));
}
