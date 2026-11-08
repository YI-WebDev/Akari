// ゴミ箱: a sheet opened from the ≡ menu. Deleted items wait here for TRASH_DAYS (lib/vault/trash.js)
// and can be put back or deleted for good; the toast after a delete offers 元に戻す for the same
// items. The sheet shows titles and the vault, never a secret, and is emptied when it closes.

import { MSG } from '../../shared/messages.js';
import { typeLabel } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { TRASH_DAYS, TRASH_MS } from '../../lib/vault/trash.js';
import { S, emit, call, errText, liveToken, live, setTrash, vaultById } from '../state.js';
import { h, clear, icon, syncInert, keepFocus } from './dom.js';
import { toast, toastError } from './toast.js';
import { tileEl } from './list.js';

const $ = (id) => document.getElementById(id);
const DAY_MS = 24 * 60 * 60 * 1000;

let restoreFocus = null;
let asking = null; // id of the row asking 完全に削除しますか, or 'all' for ゴミ箱を空にする
let busy = false;

export const isTrashOpen = () => $('trashSheet').classList.contains('open');

/** Whole days left before the entry is gone (at least 1 while it is listed). */
const daysLeft = (e, now = Date.now()) => Math.max(1, Math.ceil((e.deletedAt + TRASH_MS - now) / DAY_MS));

function subline(e) {
  const vault = vaultById(e.vault)?.name || t('trash.noVault', null, '削除した保管庫');
  return `${typeLabel(e.type)} · ${vault}`;
}

/* ── rendering ── */

function rowEl(e, now) {
  const title = e.title || t('(無題)');
  const days = daysLeft(e, now);
  const acts = h('div', { class: 'ts-acts' });
  if (asking === e.id) {
    const yes = h('button', { class: 'btn-mini danger', type: 'button', disabled: busy, onclick: () => purge([e.id]) },
      busy ? t('削除中…') : t('削除する'));
    acts.append(h('span', { class: 'ts-ask', role: 'alert' },
      h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'),
      t('trash.askOne', null, '完全に削除しますか？元に戻せません')),
    yes,
    h('button', { class: 'btn-mini', type: 'button', disabled: busy, dataset: { col: 'no' }, onclick: () => ask(null, e.id) }, t('やめる')));
    setTimeout(() => { if (yes.isConnected && !busy) yes.focus({ preventScroll: true }); }, 0);
  } else {
    acts.append(
      h('span', { class: 'ts-left', title: t('trash.leftTitle', { date: new Date(e.deletedAt + TRASH_MS).toLocaleDateString() }, '{date} に完全に削除されます') },
        t('trash.left', { n: days }, 'あと {n} 日')),
      h('button', {
        class: 'btn-mini', type: 'button', dataset: { col: 'restore' }, disabled: busy,
        'aria-label': t('trash.restoreOf', { title }, '{title} を元に戻す'), onclick: () => restore([e.id]),
      }, icon('undo', 11), t('trash.restore', null, '元に戻す')),
      h('button', {
        class: 'icon-btn ts-purge', type: 'button', dataset: { col: 'purge' }, disabled: busy,
        title: t('trash.purge', null, '完全に削除'), 'aria-label': t('trash.purgeOf', { title }, '{title} を完全に削除'),
        onclick: () => ask(e.id),
      }, icon('trash', 13)));
  }
  return h('li', { class: 'ts-row' + (asking === e.id ? ' asking' : ''), id: 'ts-row-' + e.id, dataset: { id: e.id } },
    tileEl(e),
    h('span', { class: 'row-text' },
      h('span', { class: 'row-title' }, title),
      h('span', { class: 'row-user plain' }, subline(e))),
    acts);
}

function render({ focus = null } = {}) {
  const now = Date.now();
  const list = $('tsList');
  const n = S.trash.length;
  $('tsSub').textContent = n
    ? t('trash.sub', { n, days: TRASH_DAYS }, '{n} 件 · 削除してから {days} 日で完全に消えます')
    : '';
  const empty = $('tsEmpty');
  empty.hidden = !n || asking === 'all';
  empty.disabled = busy;
  renderAskAll();
  clear(list);
  if (!n) {
    list.append(h('li', { class: 'ts-none' },
      h('span', { class: 'ts-none-ico', 'aria-hidden': 'true' }, icon('trash', 18)),
      h('span', { class: 'ts-none-h' }, t('trash.empty', null, 'ゴミ箱は空です')),
      h('span', null, t('trash.emptyNote', { days: TRASH_DAYS }, '削除したアイテムは {days} 日間ここに残り、元に戻せます'))));
  } else {
    for (const e of S.trash) list.append(rowEl(e, now));
  }
  if (focus) focusAfter(focus);
}

function renderAskAll() {
  const box = $('tsAskAll');
  clear(box);
  box.hidden = asking !== 'all';
  if (asking !== 'all') return;
  const yes = h('button', { class: 'btn-mini danger', type: 'button', disabled: busy, onclick: () => purge(null) },
    busy ? t('削除中…') : t('trash.emptyGo', { n: S.trash.length }, '{n} 件を完全に削除'));
  box.append(
    h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'),
    h('span', { class: 'grow' }, t('trash.askAll', null, 'ゴミ箱のアイテムをすべて完全に削除しますか？元に戻せません')),
    yes,
    h('button', { class: 'btn-mini', type: 'button', disabled: busy, onclick: () => ask(null, 'all') }, t('やめる')));
  setTimeout(() => { if (yes.isConnected && !busy) yes.focus({ preventScroll: true }); }, 0);
}

/** Where focus goes after a redraw: the same column of the row at `index` (or the one before), else ×. */
function focusAfter({ index, col }) {
  const rows = [...$('tsList').querySelectorAll('.ts-row')];
  const row = rows[Math.min(index, rows.length - 1)];
  const target = row?.querySelector(`[data-col="${col}"]`) || row?.querySelector('[data-col="restore"]')
    || $('trashSheet').querySelector('[data-close]');
  target?.focus({ preventScroll: true });
}

const indexOf = (id) => S.trash.findIndex((e) => e.id === id);

/* ── actions ── */

/** Ask before 完全に削除 (`id`, or 'all'); `ask(null, from)` cancels and puts focus back. */
function ask(id, from = null) {
  if (busy) return;
  asking = id;
  if (id) { render(); return; }
  if (from === 'all') {
    render();
    $('tsEmpty').focus({ preventScroll: true });
  } else {
    render({ focus: { index: Math.max(0, indexOf(from)), col: 'purge' } });
  }
}

async function restore(ids) {
  if (busy) return;
  const index = Math.max(0, indexOf(ids[0]));
  busy = true;
  render();
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_RESTORE_ITEMS, { ids });
    if (!live(token)) return;
    busy = false;
    emit('restored', res, { from: 'trash' });
    if (isTrashOpen()) render({ focus: { index, col: 'restore' } });
  } catch (e) {
    if (!live(token)) return;
    busy = false;
    if (isTrashOpen()) render({ focus: { index, col: 'restore' } });
    toastError(t('trash.restoreFailed', null, '元に戻せませんでした'), errText(e));
    emit('reload');
  }
}

/** 完全に削除: these ids, or everything when `ids` is null. */
async function purge(ids) {
  if (busy) return;
  const index = ids ? Math.max(0, indexOf(ids[0])) : 0;
  busy = true;
  render();
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_PURGE_ITEMS, ids ? { ids } : { all: true });
    if (!live(token)) return;
    busy = false;
    asking = null;
    setTrash(res.trash);
    emit('trashChanged');
    if (isTrashOpen()) render({ focus: { index, col: 'purge' } });
    toast(t('trash.purged', { n: res.purged }, '{n} 件を完全に削除しました'));
  } catch (e) {
    if (!live(token)) return;
    busy = false;
    asking = null;
    if (isTrashOpen()) render({ focus: { index, col: 'purge' } });
    toastError(t('削除できませんでした'), errText(e));
    emit('reload');
  }
}

/* ── keyboard: ↑↓ move between rows in the same column ── */

function onKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const btn = e.target.closest?.('.ts-row [data-col]');
  if (!btn) return;
  const rows = [...$('tsList').querySelectorAll('.ts-row')];
  const i = rows.indexOf(btn.closest('.ts-row'));
  const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  (next.querySelector(`[data-col="${btn.dataset.col}"]`) || next.querySelector('[data-col]'))?.focus({ preventScroll: true });
}

/** Esc: a pending 完全に削除 first, then the sheet. */
export function escapeTrash() {
  if (asking && !busy) {
    ask(null, asking);
    return;
  }
  closeTrash();
}

/* ── the sheet ── */

export function openTrash() {
  restoreFocus = keepFocus();
  asking = null; // busy stays as it is: a request started before the sheet was closed may still be running
  render();
  const sheet = $('trashSheet');
  $('scrim').classList.add('on');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('tsList').scrollTop = 0;
  syncInert();
  setTimeout(() => (sheet.querySelector('[data-col="restore"]') || sheet.querySelector('[data-close]')).focus({ preventScroll: true }), 60);
}

/** Close and drop what the sheet showed. `restore: false` when the caller moves focus itself. */
export function closeTrash({ restore: back = true } = {}) {
  const sheet = $('trashSheet');
  asking = null;
  clear($('tsList'));
  clear($('tsAskAll'));
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (!['genSheet', 'setSheet', 'healthSheet'].some((id) => $(id).classList.contains('open'))) $('scrim').classList.remove('on');
  syncInert();
  if (back) restoreFocus?.();
  restoreFocus = null;
}

/** Redraw when the trash changed elsewhere (a delete or 元に戻す from the toast) while it is open. */
export function refreshTrash() {
  if (isTrashOpen() && !busy) render();
}

export function initTrash() {
  const sheet = $('trashSheet');
  sheet.querySelector('[data-close]').addEventListener('click', () => closeTrash());
  $('tsEmpty').addEventListener('click', () => ask('all'));
  sheet.addEventListener('keydown', onKeys);
}
