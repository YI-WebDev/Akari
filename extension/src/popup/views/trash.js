import { DAY_MS } from '../../shared/time.js';
import { MSG } from '../../shared/messages.js';
import { typeLabel } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { TRASH_DAYS, TRASH_MS } from '../../lib/vault/trash.js';
import { S, emit, call, errText, liveToken, live, setTrash, vaultById } from '../state.js';
import { h, clear, icon, syncInert, keepFocus, isComposing } from './dom.js';
import { toast, toastError } from './toast.js';
import { tileEl } from './list.js';

const $ = (id) => document.getElementById(id);

let restoreFocus = null;
let asking = null;
let busy = false;

export const isTrashOpen = () => $('trashSheet').classList.contains('open');

const daysLeft = (e, now = Date.now()) => Math.max(1, Math.ceil((e.deletedAt + TRASH_MS - now) / DAY_MS));

function subline(e) {
  const vault = vaultById(e.vault)?.name || t('trash.noVault', null, '削除した保管庫');
  return `${typeLabel(e.type)} · ${vault}`;
}

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

function focusAfter({ index, col }) {
  const rows = [...$('tsList').querySelectorAll('.ts-row')];
  const row = rows[Math.min(index, rows.length - 1)];
  const target = row?.querySelector(`[data-col="${col}"]`) || row?.querySelector('[data-col="restore"]')
    || $('trashSheet').querySelector('[data-close]');
  target?.focus({ preventScroll: true });
}

const indexOf = (id) => S.trash.findIndex((e) => e.id === id);

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

function onKeys(e) {
  if (isComposing(e)) return;
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

export function escapeTrash() {
  if (asking && !busy) {
    ask(null, asking);
    return;
  }
  closeTrash();
}

export function openTrash() {
  restoreFocus = keepFocus();
  asking = null;
  render();
  const sheet = $('trashSheet');
  $('scrim').classList.add('on');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('tsList').scrollTop = 0;
  syncInert();
  setTimeout(() => (sheet.querySelector('[data-col="restore"]') || sheet.querySelector('[data-close]')).focus({ preventScroll: true }), 60);
}

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

export function refreshTrash() {
  if (isTrashOpen() && !busy) render();
}

export function initTrash() {
  const sheet = $('trashSheet');
  sheet.querySelector('[data-close]').addEventListener('click', () => closeTrash());
  $('tsEmpty').addEventListener('click', () => ask('all'));
  sheet.addEventListener('keydown', onKeys);
}
