// Popup state, a tiny event bus, and derived views over the decrypted items.
// Decrypted items live only in this page's memory and are dropped on lock.

import { send } from '../shared/api.js';
import { MSG, ERR, DEFAULT_SETTINGS, DEFAULT_VAULTS } from '../shared/messages.js';
import { estimateStrength } from '../lib/strength.js';
import { groupIndex, normQuery, normMap } from './views/format.js';
import { toast, toastError } from './views/toast.js';

export const S = {
  phase: 'boot', // boot | setup | locked | main
  epoch: 0, // bumped on every lock; async work started in an older epoch must not touch state
  settings: { ...DEFAULT_SETTINGS },
  vaults: [...DEFAULT_VAULTS],
  items: [],
  vault: 'all',
  filter: 'all', // all | recent | fav
  sort: 'recent', // recent | az
  query: '',
  sel: null,
  af: null, // { tabId, url, site, items, state }
};

const UI_KEY = 'akari.ui';
try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  if (['all', 'recent', 'fav'].includes(saved.filter)) S.filter = saved.filter;
  if (['recent', 'az'].includes(saved.sort)) S.sort = saved.sort;
  if (typeof saved.vault === 'string') S.vault = saved.vault;
} catch { /* ignore */ }

export function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ filter: S.filter, sort: S.sort, vault: S.vault })); } catch { /* ignore */ }
}

/* ── event bus ── */
const subs = new Map();
export function on(ev, fn) {
  if (!subs.has(ev)) subs.set(ev, new Set());
  subs.get(ev).add(fn);
}
export function emit(ev, ...args) {
  for (const fn of subs.get(ev) || []) {
    try { fn(...args); } catch (e) { console.error('[akari popup]', ev, e); }
  }
}

/** Snapshot before an await; `live(token)` afterwards says whether the result may still be applied. */
export const liveToken = () => S.epoch;
export const live = (token) => S.phase === 'main' && S.epoch === token;

// Requests that re-encrypt and store the vault; the status bar shows 保存中… while any is in flight.
const WRITES = new Set([
  MSG.VAULT_SAVE_ITEM, MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_IMPORT, MSG.VAULT_IMPORT_ITEMS, MSG.VAULT_CHANGE_PASSWORD,
]);
let writing = 0;

/** send() that routes LOCKED errors to the lock screen. */
export async function call(type, payload) {
  const write = WRITES.has(type);
  if (write && writing++ === 0) emit('saving', true);
  try {
    return await send(type, payload);
  } catch (e) {
    if (e?.code === ERR.LOCKED) emit('locked');
    throw e;
  } finally {
    if (write && --writing === 0) emit('saving', false);
  }
}

export function errText(e) {
  switch (e?.code) {
    case ERR.BAD_PASSWORD: return 'パスワードが違います';
    case ERR.LOCKED: return 'ロックされています';
    case ERR.NOT_FOUND: return 'アイテムが見つかりません';
    case ERR.INVALID: return '入力内容を確認してください';
    case ERR.DOMAIN_MISMATCH: return 'このサイトのアイテムではありません';
    default: return 'エラーが発生しました';
  }
}

/* ── derived data ── */
const strengthCache = new Map();
let reuse = new Map();

export function strengthOf(pw) {
  if (!pw) return { bits: 0, level: 0, label: '—' };
  let s = strengthCache.get(pw);
  if (!s) {
    s = estimateStrength(pw);
    strengthCache.set(pw, s);
  }
  return s;
}

export function setItems(items) {
  S.items = Array.isArray(items) ? items : [];
  recomputeReuse();
}

export function recomputeReuse() {
  reuse = new Map();
  for (const it of S.items) {
    if (it.type === 'note' || !it.password) continue;
    reuse.set(it.password, (reuse.get(it.password) || 0) + 1);
  }
}

/** How many *other* items share this item's password. */
export const reuseOf = (it) => (it?.password ? Math.max(0, (reuse.get(it.password) || 0) - 1) : 0);

export function isWeak(it) {
  if (!it || it.type === 'note' || !it.password) return false;
  return strengthOf(it.password).level <= 1 || reuseOf(it) > 0;
}

export const itemById = (id) => S.items.find((i) => i.id === id) || null;
export const vaultById = (id) => S.vaults.find((v) => v.id === id) || null;

export function replaceItem(item) {
  const i = S.items.findIndex((x) => x.id === item.id);
  if (i >= 0) S.items[i] = item;
  else S.items.unshift(item);
  recomputeReuse();
}

export function removeItem(id) {
  S.items = S.items.filter((i) => i.id !== id);
  recomputeReuse();
}

export function clearSecrets() {
  S.items = [];
  S.af = null;
  S.sel = null;
  S.query = '';
  strengthCache.clear();
  normCache.clear();
  reuse = new Map();
}

/* ── search (NFKC + lower-case, shared with the highlighter so offsets agree) ── */
const normCache = new Map();
export function normOf(text) {
  const s = String(text || '');
  let m = normCache.get(s);
  if (!m) {
    m = normMap(s);
    if (normCache.size > 2000) normCache.clear();
    normCache.set(s, m);
  }
  return m;
}

export const searchQuery = () => normQuery(S.query);

export function inVault(it) {
  return S.vault === 'all' || it.vault === S.vault;
}

export function visibleItems(now = Date.now()) {
  const q = searchQuery();
  const v = S.items.filter((i) => inVault(i)
    && (S.filter === 'all' || (S.filter === 'recent' && groupIndex(i.lastUsedAt, now) <= 1) || (S.filter === 'fav' && i.fav))
    && (!q || normOf(i.title).norm.includes(q) || (i.type !== 'note' && normOf(i.username).norm.includes(q))));
  if (S.sort === 'az') return v.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
  return v.sort((a, b) => {
    const ga = groupIndex(a.lastUsedAt, now);
    const gb = groupIndex(b.lastUsedAt, now);
    if (ga !== gb) return ga - gb;
    if (a.lastUsedAt || b.lastUsedAt) return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/** Keep the selection on a visible item when the visible set changes. Returns true if it changed. */
export function ensureSel() {
  const vis = visibleItems();
  if (vis.length && !vis.some((i) => i.id === S.sel)) {
    S.sel = vis[0].id;
    return true;
  }
  if (!S.sel && S.items.length) {
    S.sel = S.items[0].id;
    return true;
  }
  return false;
}

/** Item payload for vault/saveItem: passkeys are owned by the service worker and never sent back. */
export function forSave(item) {
  const { passkeys, ...rest } = item;
  return rest;
}

/** The saved item from the SW, keeping the local passkey list if the response omits it. */
export function mergeSaved(saved, prev) {
  const base = saved && typeof saved === 'object' ? saved : prev;
  return { ...base, passkeys: base.passkeys ?? prev?.passkeys ?? [] };
}

/* ── clipboard ── */
const COPY_LABEL = { user: 'ユーザー名', pass: 'パスワード', totp: '認証コード', gen: '生成したパスワード' };

export async function copyText(field, value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toastError('コピーできませんでした');
    return false;
  }
  const secs = Number(S.settings.clipboardClearSeconds) || 0;
  const sensitive = field !== 'user';
  let sub = null;
  if (sensitive && secs > 0) {
    try {
      await call(MSG.CLIPBOARD_SCHEDULE_CLEAR, { seconds: secs });
      sub = `${secs}秒後にクリップボードから自動で消去します`;
    } catch {
      // copied, but nothing will clear it — say so instead of promising
      toastError(COPY_LABEL[field] + 'をコピーしました', '自動消去を設定できませんでした');
      return true;
    }
  }
  toast(COPY_LABEL[field] + 'をコピーしました', sub);
  return true;
}
