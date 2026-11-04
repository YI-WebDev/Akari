// Left column (design 1a): 現在のタブ autofill card, grouped rows with counts, empty states,
// plus the counters that live outside the list (filter counts, status bar).

import { typeOf, typeLabel, subtitleOf } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { S, emit, visibleItems, isWeak, itemById, normOf, searchQuery, inVault, inType, vaultById } from '../state.js';
import { h, clear, icon } from './dom.js';
import { GROUPS, groupIndex, letterOf, hueOf, matchRange, normQuery } from './format.js';
import { stagger } from './fx.js';
import { tagShown } from './type-menu.js';

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

function rowEl(it, q) {
  const weak = isWeak(it);
  const totp = it.type === 'login' && !!it.totp?.secret;
  const tag = typeOf(it.type)?.tag || null;
  const sub = subtitle(it);
  return h('div', {
    class: 'row', role: 'option', id: 'row-' + it.id, 'aria-selected': String(it.id === S.sel),
    dataset: { row: '', id: it.id },
    onclick: () => emit('select', it.id),
  },
  h('span', { class: 'row-sel' }),
  h('span', { class: 'row-caret', 'aria-hidden': 'true' }, '›'),
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

/** Per-type counts in the current vault (for the 種類 menu). */
export function typeCounts() {
  const counts = new Map();
  for (const it of S.items) if (inVault(it)) counts.set(it.type, (counts.get(it.type) || 0) + 1);
  return counts;
}

/** The 種類 button under the filter chips: "種類  すべて ▾", or the chosen type in accent. */
export function renderTypeButton() {
  const on = S.type !== 'all' && !!typeOf(S.type);
  const name = on ? typeLabel(S.type) : t('list.typeAll', null, 'すべて');
  const btn = $('typeBtn');
  btn.classList.toggle('on', on);
  $('typeK').textContent = t('list.type', null, '種類');
  $('typeLabel').textContent = name;
  const tag = on && tagShown(S.type) ? typeOf(S.type).tag : null;
  $('typeTag').textContent = tag || '';
  $('typeTag').hidden = !tag;
  const label = t('list.typeFilter', { type: name }, '種類で絞り込む: {type}');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  const clr = $('typeClear');
  clr.hidden = !on;
  clr.title = t('list.typeClear', null, '種類の絞り込みを解除');
  clr.setAttribute('aria-label', clr.title);
}

/** Filter counts (vault- and type-scoped, ignoring the query, as in the design), vault label and status bar. */
export function renderCounts(visibleCount, now = Date.now()) {
  renderTypeButton();
  const inV = S.items.filter((i) => inVault(i) && inType(i));
  const counts = {
    all: inV.length,
    recent: inV.filter((i) => groupIndex(i.lastUsedAt, now) <= 1).length,
    fav: inV.filter((i) => i.fav).length,
  };
  const names = { all: 'すべて', recent: '最近', fav: 'お気に入り' };
  for (const b of $('filters').querySelectorAll('button[data-filter]')) {
    const n = counts[b.dataset.filter];
    b.querySelector('.count').textContent = S.phase === 'main' ? String(n) : '';
    b.setAttribute('aria-label', `${names[b.dataset.filter]} ${n} 件`);
  }
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

  const af = afCandidate();
  // the tab's own site in the search box (put there on open) keeps the autofill card
  const siteOnly = !q || q === normQuery(S.siteQuery);
  if (af && siteOnly && S.filter === 'all' && (S.type === 'all' || S.type === 'login')) L.append(afCard(af));

  const vis = S.items.length ? visibleItems(now) : [];
  renderCounts(vis.length, now);
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

/** Move the selection without rebuilding rows, so the caret and highlight transitions play. */
export function markSelected() {
  const L = $list();
  L.querySelectorAll('.row').forEach((r) => r.setAttribute('aria-selected', String(r.dataset.id === S.sel)));
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
