import { typeOf, typeLabel, subtitleOf } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import {
  S, emit, visibleItems, isWeak, itemById, normOf, searchQuery, searching, looseResults, inVault, setAutofillState, prunePicked,
} from '../state.js';
import { h, clear, icon, brLines } from './dom.js';
import { groupName, groupIndex, letterOf, hueOf, matchRange, normQuery } from './format.js';
import { isView, viewName, viewIcon } from './type-menu.js';

const $ = (id) => document.getElementById(id);
const $list = () => $('list');
let afButton = null;

let rowCache = new Map();

export function resetListCache() {
  rowCache = new Map();
}

function highlight(text, q) {
  const s = String(text || '');
  const r = q ? matchRange(normOf(s), q) : null;
  if (!r) return [s];
  return [s.slice(0, r[0]), h('mark', null, s.slice(r[0], r[1])), s.slice(r[1])];
}

function subtitle(it) {
  const s = subtitleOf(it);
  if (s || it.type === 'login') return { text: s, plain: false };
  return { text: typeLabel(it.type), plain: true };
}

export function tileEl(it, size = '') {
  return h('span', { class: ('tile ' + size).trim(), vars: { '--h': String(hueOf(it)) }, 'aria-hidden': 'true' }, letterOf(it.title));
}

function onRowClick(e, id) {
  const extendsRange = e.shiftKey;
  if (S.picking || e.ctrlKey || e.metaKey || extendsRange) {
    if (extendsRange) window.getSelection()?.removeAllRanges();
    emit('pick', id, { range: extendsRange });
  } else {
    emit('select', id);
  }
}

function rowFlags(it) {
  const weak = isWeak(it);
  const totp = it.type === 'login' && !!it.totp?.secret;
  const tag = typeOf(it.type)?.tag || null;
  if (!weak && !totp && !tag) return null;
  return h('span', { class: 'row-flags' },
    weak ? h('span', { class: 'row-weak', title: t('弱いパスワード'), role: 'img', 'aria-label': t('弱いパスワード') }) : null,
    totp ? h('span', { class: 'tag', title: t('認証コード（2FA）あり') }, '2FA') : null,
    tag ? h('span', { class: 'tag', title: typeLabel(it.type) }, tag) : null);
}

function cachedRow(it, q, next) {
  const sig = `${q}\u0000${S.picking ? 1 : 0}\u0000${isWeak(it) ? 1 : 0}`;
  const hit = rowCache.get(it.id);
  let el;
  if (hit && hit.it === it && hit.sig === sig) {
    el = hit.el;
    el.setAttribute('aria-selected', String(S.picking ? S.picked.has(it.id) : it.id === S.sel));
    el.classList.toggle('cur', S.picking && it.id === S.sel);
  } else {
    el = rowEl(it, q);
  }
  next.set(it.id, { it, sig, el });
  return el;
}

function rowEl(it, q) {
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
    h('span', { class: 'row-title' }, highlight(it.title || t('(無題)'), q)),
    h('span', { class: 'row-user' + (sub.plain ? ' plain' : '') }, sub.plain ? sub.text : highlight(sub.text, q))),
  rowFlags(it));
}

export function setAfState(state) {
  if (!S.af) return;
  setAutofillState(state);
  if (!afButton) return;
  afButton.dataset.state = state;
  afButton.disabled = state !== 'idle';
  clear(afButton);
  if (state === 'run') afButton.append(h('span', { class: 'spinner' }), h('span', null, t('入力中')));
  else if (state === 'done') afButton.append(icon('check', 11), h('span', null, t('完了')));
  else afButton.append(h('span', null, t('⏎ 入力')));
}

export function afButtonEl() {
  return afButton;
}

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
    'aria-label': t('{site} に自動入力', { site: S.af.site }), title: t('{site} に自動入力', { site: S.af.site }),
    onclick: (e) => { e.stopPropagation(); emit('autofill'); },
  });
  setAfState(S.af.state);
  return h('div', { class: 'af', dataset: { row: '' } },
    h('div', { class: 'af-head' },
      h('span', { class: 'af-label' }, t('現在のタブ')),
      h('span', { class: 'af-site' }, S.af.site)),
    h('div', { class: 'af-row' },
      tileEl(it, 'sm'),
      h('span', { class: 'af-user' }, it.username || it.title || ''),
      afButton));
}

const emptyBox = (lines) => h('div', { class: 'empty' }, h('div', { class: 'empty-n' }, t('{n} 件', { n: 0 })), ...lines);

function emptyHero() {
  return h('div', { class: 'empty-hero' },
    h('div', { class: 'empty-n' }, t('{n} 件', { n: 0 })),
    h('div', { class: 'empty-msg' }, brLines(t('ログインやメモを追加すると\nここに並びます'))));
}

function emptyMessage(q) {
  if (q || searching()) {
    return emptyBox([t('「{q}」に一致するアイテムはありません', { q: S.query.trim() }),
      S.type !== 'all' ? [h('br'), t('list.emptyQueryType', { type: typeLabel(S.type) }, '（種類「{type}」で絞り込み中）')] : null]);
  }
  if (S.type !== 'all') {
    const type = S.type;
    return emptyBox([t('list.emptyType', { type: typeLabel(type) }, '{type}はありません'),
      h('div', { class: 'empty-act' }, h('button', {
        class: 'btn-line btn-sm', type: 'button', onclick: () => emit(type === 'login' ? 'newLogin' : 'newItem', type),
      }, icon('plus', 11, 2.6), t('editor.new', { type: typeLabel(type) }, '新規{type}')))]);
  }
  if (S.filter === 'fav') return emptyBox([t('お気に入りはまだありません'), h('br'), t('詳細の ★ で追加できます')]);
  if (S.filter === 'recent') return emptyBox(brLines(t('最近つかったアイテムは\nありません')));
  return emptyBox([t('この保管庫は空です')]);
}

function groupEl(label, count) {
  return h('div', { class: 'group', dataset: { row: '' }, role: 'presentation' },
    h('span', null, label), h('span', { class: 'group-line' }), h('span', null, String(count)));
}

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

export const currentView = () => (S.type !== 'all' && typeOf(S.type) ? S.type : S.filter);

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

export function renderCounts(now = Date.now()) {
  renderViewButton(viewCounts(now));
}

export function renderList({ animate = false, keepScroll = true } = {}) {
  const L = $list();
  const top = L.scrollTop;
  afButton = null;
  const q = searchQuery();
  const now = Date.now();
  const children = [];
  const next = new Map();

  const af = S.picking ? null : afCandidate();
  const siteOnly = !searching() || q === normQuery(S.siteQuery);
  const unfiltered = S.filter === 'all' && (S.type === 'all' || S.type === 'login');
  if (af && siteOnly && unfiltered) children.push(afCard(af));

  const vis = S.items.length ? visibleItems(now) : [];
  renderCounts(now);
  L.toggleAttribute('aria-multiselectable', S.picking);
  if (S.picking) {
    if (prunePicked(new Set(vis.map((i) => i.id)))) emit('picked');
  }
  if (!S.items.length) {
    children.push(emptyHero());
  } else if (!vis.length) {
    children.push(emptyMessage(q));
  } else {
    const hq = siteOnly ? '' : q;
    const row = (it) => cachedRow(it, hq, next);
    if (looseResults()) {
      children.push(groupEl(t('list.loose', { q: S.query.trim() }, '「{q}」に近いもの'), vis.length));
      for (const it of vis) children.push(row(it));
    } else if (S.sort === 'az') {
      children.push(groupEl('A–Z', vis.length));
      for (const it of vis) children.push(row(it));
    } else {
      appendGroups(children, vis, row, vis.map((it) => groupIndex(it.lastUsedAt, now)), groupName);
    }
  }
  rowCache = next;
  L.replaceChildren(...children);
  L.setAttribute('aria-activedescendant', vis.length && S.sel ? 'row-' + S.sel : '');
  if (keepScroll && !animate) L.scrollTop = top;
  else L.scrollTop = 0;
}

function appendGroups(out, vis, row, keys, label) {
  const per = new Map();
  for (const g of keys) per.set(g, (per.get(g) || 0) + 1);
  let last;
  vis.forEach((it, k) => {
    if (k === 0 || keys[k] !== last) {
      last = keys[k];
      out.push(groupEl(label(last), per.get(last)));
    }
    out.push(row(it));
  });
}

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
