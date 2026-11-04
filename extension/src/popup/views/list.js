// Left column (design 1a): 現在のタブ autofill card, grouped rows with counts, empty states,
// plus the counters that live outside the list (filter counts, status bar).

import { typeOf, typeLabel, subtitleOf } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { S, emit, visibleItems, isWeak, itemById, normOf, searchQuery, inVault, vaultById } from '../state.js';
import { h, clear, icon } from './dom.js';
import { GROUPS, groupIndex, letterOf, hueOf, matchRange, normQuery } from './format.js';
import { stagger } from './fx.js';
import { isView, viewName, viewIcon } from './type-menu.js';

const $ = (id) => document.getElementById(id);
const $list = () => $('list');
let afButton = null;

/** q is already normalised; offsets come from the same normalisation map, so they map back exactly. */
function highlight(text, q) {
  const s = String(text || '');
  const r = q ? matchRange(normOf(s), q) : null;
  if (!r) return [s];
  return [s.slice(0, r[0]), h('mark', null, s.slice(r[0], r[1])), s.slice(r[1])];
}

/** Second line: subtitleOf (never secret), or the type's name when that is empty. */
function subtitle(it) {
  const s = subtitleOf(it);
  if (s || it.type === 'login') return { text: s, plain: false };
  return { text: typeLabel(it.type), plain: true };
}

export function tileEl(it, size = '') {
  return h('span', { class: ('tile ' + size).trim(), vars: { '--h': String(hueOf(it)) }, 'aria-hidden': 'true' }, letterOf(it.title));
}

/**
 * A plain click opens the item. In selection mode a click checks it; Ctrl/⌘+click and
 * Shift+click (a range from the last checked row) start selection mode from anywhere.
 */
function onRowClick(e, id) {
  if (S.picking || e.ctrlKey || e.metaKey || e.shiftKey) {
    if (e.shiftKey) window.getSelection()?.removeAllRanges(); // Shift+click also selects text
    emit('pick', id, { range: e.shiftKey });
  } else {
    emit('select', id);
  }
}

function rowEl(it, q) {
  const weak = isWeak(it);
  const totp = it.type === 'login' && !!it.totp?.secret;
  const tag = typeOf(it.type)?.tag || null;
  const sub = subtitle(it);
  return h('div', {
    class: 'row' + (S.picking && it.id === S.sel ? ' cur' : ''), role: 'option', id: 'row-' + it.id,
    'aria-selected': String(S.picking ? S.picked.has(it.id) : it.id === S.sel),
    dataset: { row: '', id: it.id },
    onclick: (e) => onRowClick(e, it.id),
  },
  h('span', { class: 'row-sel' }),
  h('span', { class: 'row-caret', 'aria-hidden': 'true' }, '›'),
  S.picking ? h('span', { class: 'row-check', 'aria-hidden': 'true' }, icon('check', 10, 3.4)) : null,
  tileEl(it),
  h('span', { class: 'row-text' },
    h('span', { class: 'row-title' }, highlight(it.title || '(無題)', q)),
    h('span', { class: 'row-user' + (sub.plain ? ' plain' : '') }, sub.plain ? sub.text : highlight(sub.text, q))),
  weak || totp || tag ? h('span', { class: 'row-flags' },
    weak ? h('span', { class: 'row-weak', title: '弱いパスワード', role: 'img', 'aria-label': '弱いパスワード' }) : null,
    totp ? h('span', { class: 'tag', title: '認証コード（2FA）あり' }, '2FA') : null,
    tag ? h('span', { class: 'tag', title: typeLabel(it.type) }, tag) : null) : null);
}

export function setAfState(state) {
  if (!S.af) return;
  S.af.state = state;
  if (!afButton) return;
  afButton.dataset.state = state;
  afButton.disabled = state !== 'idle';
  clear(afButton);
  if (state === 'run') afButton.append(h('span', { class: 'spinner' }), h('span', null, '入力中'));
  else if (state === 'done') afButton.append(icon('check', 11), h('span', null, '完了'));
  else afButton.append(h('span', null, '⏎ 入力'));
}

export function afButtonEl() {
  return afButton;
}

/** The first autofill match that is in the loaded items and the current vault. */
export function afCandidate() {
  if (!S.af?.items?.length) return null;
  for (const m of S.af.items) {
    const local = itemById(m.id);
    const it = local || m;
    if (S.vault === 'all' || !local || local.vault === S.vault) return it;
  }
  return null;
}

function afCard(it) {
  afButton = h('button', {
    class: 'af-btn', type: 'button', dataset: { state: S.af.state },
    'aria-label': `${S.af.site} に自動入力`, title: `${S.af.site} に自動入力`,
    onclick: (e) => { e.stopPropagation(); emit('autofill'); },
  });
  setAfState(S.af.state);
  return h('div', { class: 'af', dataset: { row: '' } },
    h('div', { class: 'af-head' },
      h('span', { class: 'af-pulse', 'aria-hidden': 'true' }),
      h('span', null, '現在のタブ'),
      h('span', { class: 'af-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'af-site' }, S.af.site)),
    h('div', { class: 'af-row' },
      tileEl(it, 'sm'),
      h('span', { class: 'af-user' }, it.username || it.title || ''),
      afButton));
}

const emptyBox = (lines) => h('div', { class: 'empty' }, h('div', { class: 'empty-n' }, '0 件'), ...lines);

function emptyHero() {
  return h('div', { class: 'empty-hero' },
    h('div', { class: 'empty-n' }, '0 件'),
    h('div', { class: 'empty-msg' }, '保管庫は空です。', h('br'), 'ログインやメモを追加すると', h('br'), 'ここに並びます'),
    h('button', { class: 'btn-primary btn-sm', type: 'button', onclick: () => emit('newLogin') }, icon('plus', 12, 2.8), '新規ログイン'));
}

function emptyMessage(q) {
  if (q) {
    return emptyBox([`「${S.query.trim()}」に一致するアイテムはありません`,
      S.type !== 'all' ? [h('br'), t('list.emptyQueryType', { type: typeLabel(S.type) }, '（種類「{type}」で絞り込み中）')] : null]);
  }
  if (S.type !== 'all') {
    const type = S.type;
    return emptyBox([t('list.emptyType', { type: typeLabel(type) }, '{type}はありません'),
      h('div', { class: 'empty-act' }, h('button', {
        class: 'btn-line btn-sm', type: 'button', onclick: () => emit(type === 'login' ? 'newLogin' : 'newItem', type),
      }, icon('plus', 11, 2.6), t('editor.new', { type: typeLabel(type) }, '新規{type}')))]);
  }
  if (S.filter === 'fav') return emptyBox(['お気に入りはまだありません', h('br'), '詳細の ★ で追加できます']);
  if (S.filter === 'recent') return emptyBox(['最近つかったアイテムは', h('br'), 'ありません']);
  return emptyBox(['この保管庫は空です']);
}

function groupEl(label, count) {
  return h('div', { class: 'group', dataset: { row: '' }, role: 'presentation' },
    h('span', null, label), h('span', { class: 'group-line' }), h('span', null, String(count)));
}

/** Items per view in the current vault, ignoring the search: { all, recent, fav, types: Map }. */
export function viewCounts(now = Date.now()) {
  const inV = S.items.filter(inVault);
  const types = new Map();
  for (const it of inV) types.set(it.type, (types.get(it.type) || 0) + 1);
  return {
    all: inV.length,
    recent: inV.filter((i) => groupIndex(i.lastUsedAt, now) <= 1).length,
    fav: inV.filter((i) => i.fav).length,
    types,
  };
}

/** What the list shows: 'all' | 'recent' | 'fav', or a type id (one at a time). */
export const currentView = () => (S.type !== 'all' && typeOf(S.type) ? S.type : S.filter);

/** The 表示 chip: icon, name and count of the current view; accented unless it is すべて. */
export function renderViewButton(counts = viewCounts()) {
  const id = currentView();
  const n = isView(id) ? counts[id] : counts.types.get(id) || 0;
  const name = viewName(id);
  const btn = $('typeBtn');
  btn.classList.toggle('on', id !== 'all');
  const ico = $('viewIco');
  clear(ico);
  ico.append(icon(viewIcon(id), 12));
  $('typeLabel').textContent = name;
  $('viewCount').textContent = S.phase === 'main' ? String(n) : '';
  const label = t('list.viewButton', { view: name, count: n }, '表示: {view}（{count} 件）');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** The 表示 chip, vault label and status bar. */
export function renderCounts(visibleCount, now = Date.now()) {
  renderViewButton(viewCounts(now));
  const v = vaultById(S.vault);
  $('stVault').textContent = `vault: ${S.vault === 'all' || !v ? 'すべて' : v.name}`;
  $('stCount').textContent = `${visibleCount} 件`;
}

export function renderList({ animate = false, keepScroll = true } = {}) {
  const L = $list();
  const top = L.scrollTop;
  clear(L);
  afButton = null;
  const q = searchQuery();
  const now = Date.now();

  const af = S.picking ? null : afCandidate();
  // the tab's own site in the search box (put there on open) keeps the autofill card
  const siteOnly = !q || q === normQuery(S.siteQuery);
  if (af && siteOnly && S.filter === 'all' && (S.type === 'all' || S.type === 'login')) L.append(afCard(af));

  const vis = S.items.length ? visibleItems(now) : [];
  renderCounts(vis.length, now);
  L.toggleAttribute('aria-multiselectable', S.picking);
  if (S.picking) {
    // Only what is on screen can be deleted: a filter or search change unchecks the rest.
    const shown = new Set(vis.map((i) => i.id));
    const before = S.picked.size;
    for (const id of S.picked) if (!shown.has(id)) S.picked.delete(id);
    if (S.picked.size !== before) emit('picked');
  }
  if (!S.items.length) {
    L.append(emptyHero());
    if (animate) stagger(L, '.empty-hero > *');
    return;
  }
  if (!vis.length) {
    L.append(emptyMessage(q));
    return;
  }
  if (S.sort === 'az') {
    L.append(groupEl('A → Z', vis.length));
    for (const it of vis) L.append(rowEl(it, q));
  } else {
    const gi = vis.map((it) => groupIndex(it.lastUsedAt, now));
    const per = new Map();
    for (const g of gi) per.set(g, (per.get(g) || 0) + 1);
    let last = -1;
    vis.forEach((it, k) => {
      if (gi[k] !== last) {
        last = gi[k];
        L.append(groupEl(GROUPS[last], per.get(last)));
      }
      L.append(rowEl(it, q));
    });
  }
  L.setAttribute('aria-activedescendant', S.sel ? 'row-' + S.sel : '');
  if (keepScroll && !animate) L.scrollTop = top;
  else L.scrollTop = 0;
  if (animate) stagger(L);
}

/** Move the selection (or, in selection mode, the checks and the keyboard row) without rebuilding rows. */
export function markSelected() {
  const L = $list();
  L.querySelectorAll('.row').forEach((r) => {
    r.setAttribute('aria-selected', String(S.picking ? S.picked.has(r.dataset.id) : r.dataset.id === S.sel));
    r.classList.toggle('cur', S.picking && r.dataset.id === S.sel);
  });
  L.setAttribute('aria-activedescendant', S.sel ? 'row-' + S.sel : '');
}

export function scrollToRow(id) {
  const L = $list();
  const el = L.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  const top = el.offsetTop;
  const hgt = el.offsetHeight;
  if (top < L.scrollTop + 8) L.scrollTop = top - 36;
  else if (top + hgt > L.scrollTop + L.clientHeight - 8) L.scrollTop = top + hgt - L.clientHeight + 8;
}
