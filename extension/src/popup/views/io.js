// Building blocks shared by the インポート / エクスポート pages of the settings sheet:
// the `$ akari …` command line, "[ ok ]" log lines, the step trail in the sheet head,
// roving arrow-key focus for option grids, and Blob downloads.

import { h, clear } from './dom.js';

const $ = (id) => document.getElementById(id);

/** `$ akari import --from chrome ▌` — decorative; the page says the same in words. */
export function cmdLine(text) {
  return h('div', { class: 'io-cmd', 'aria-hidden': 'true', 'data-f': '' },
    h('span', { class: 'ps' }, '$ '), h('span', { class: 'io-cmd-text' }, text), h('span', { class: 'cursor' }));
}

/**
 * "[ ok ] key ······ value", the boot log's line. state: 'ok' | 'run' | 'err' | 'ask'.
 * Returns the element; `.set(state, k, v)` updates it in place.
 */
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

/**
 * A translated sentence with an element in place of its `{key}` placeholder, as children for h():
 * sentenceWith('ファイル「{name}」を…', 'name', h('b', null, name)).
 */
export function sentenceWith(text, key, el) {
  const mark = `{${key}}`;
  const i = text.indexOf(mark);
  if (i < 0) return [text, el];
  return [text.slice(0, i) || null, el, text.slice(i + mark.length) || null];
}

/** The step trail in the sheet head: done › current › upcoming. Hidden when `steps` is empty. */
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

/** Make exactly one of `items` tabbable (roving tabindex). */
export function setRoving(items, idx) {
  items.forEach((b, k) => { b.tabIndex = k === idx ? 0 : -1; });
}

/**
 * Arrow keys move focus between `selector` children of `root` (a grid of `cols` columns,
 * or a list when cols = 1). `onMove(el)` runs after the move — radio groups select there.
 */
export function arrowNav(root, selector, { cols = 1, onMove } = {}) {
  root.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
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

/* ── downloads ── */

const pending = new Map(); // blob URL → revoke timer

function revoke(url) {
  clearTimeout(pending.get(url));
  pending.delete(url);
  URL.revokeObjectURL(url);
}

/** Save `data` as `name` through a Blob URL and <a download>; the URL is revoked shortly after. */
export function downloadFile(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  pending.set(url, setTimeout(() => revoke(url), 4000));
}

/** Revoke every download URL still alive (sheet closed, vault locked). */
export function revokeDownloads() {
  for (const url of [...pending.keys()]) revoke(url);
}

/** A file name safe to offer to the download manager. */
export function safeFileName(name, fallback) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return s || fallback;
}

/** Spinner-in-a-button busy state (`.busy > .spinner`, `.busy > .go-label`). */
export function setBusy(btn, busy) {
  if (!btn) return;
  // keep the width while the label is swapped for the spinner
  btn.style.minWidth = busy ? `${btn.offsetWidth}px` : '';
  btn.classList.toggle('busy', busy);
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
}

/** <button class="btn-primary"><span class="go-label">label</span><span class="spinner"></span></button> */
export function goButton(label, props = {}) {
  return h('button', { class: 'btn-primary', type: 'button', ...props },
    h('span', { class: 'go-label' }, label), h('span', { class: 'spinner', 'aria-hidden': 'true' }));
}
