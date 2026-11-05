// Popup state, a tiny event bus, and derived views over the decrypted items.
// Decrypted items live only in this page's memory and are dropped on lock.
//
// Other modules read `S` freely but change it only through the functions below
// (tests/unit/popup-structure.test.js checks that no other file assigns to S).

import { send } from '../shared/api.js';
import { MSG, ERR, DEFAULT_SETTINGS, DEFAULT_VAULTS } from '../shared/messages.js';
import { estimateStrength } from '../lib/strength.js';
import { passwordHealth, ISSUES, ACTION_ISSUES } from '../lib/health.js';
import { typeOf, searchTextOf } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
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
  type: 'all', // all | an item type id (shared/item-types.js)
  sort: 'recent', // recent | az
  query: '',
  siteQuery: '', // the active tab's site, put in the search box on open when it finds something
  sel: null, // the item shown in the detail pane; in selection mode, the row the keyboard is on
  picking: false, // selection mode: clicking a row checks it (for deleting several) instead of opening it
  picked: new Set(), // ids checked in selection mode, always among the visible rows
  af: null, // { tabId, url, site, items, state }
};

const UI_KEY = 'akari.ui';
try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  if (['all', 'recent', 'fav'].includes(saved.filter)) S.filter = saved.filter;
  if (['recent', 'az'].includes(saved.sort)) S.sort = saved.sort;
  if (typeof saved.vault === 'string') S.vault = saved.vault;
  if (typeof saved.type === 'string' && typeOf(saved.type)) S.type = saved.type;
  if (S.type !== 'all') S.filter = 'all'; // one view at a time (older versions combined ★ and a type)
} catch { /* ignore */ }

export function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ filter: S.filter, sort: S.sort, vault: S.vault, type: S.type })); } catch { /* ignore */ }
}

/* ── changes to S (the only writers) ── */

/** 'setup' | 'locked' | 'main'. */
export function setPhase(phase) {
  S.phase = phase;
}

/** Lock: async work started before this must not touch state any more. */
export function endEpoch() {
  S.phase = 'locked';
  S.epoch++;
}

export function setSettings(settings) {
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/** One setting, e.g. before the SW confirmed it; returns the previous value. */
export function putSetting(key, value) {
  const prev = S.settings[key];
  S.settings = { ...S.settings, [key]: value };
  return prev;
}

export function setVaults(vaults) {
  S.vaults = Array.isArray(vaults) && vaults.length ? vaults : [...DEFAULT_VAULTS];
  if (S.vault !== 'all' && !S.vaults.some((v) => v.id === S.vault)) S.vault = 'all';
}

/** Show one vault ('all' = every vault). Saved for the next popup. */
export function setVaultFilter(id) {
  S.vault = id;
  saveUi();
}

/** The list's one view: filter 'all' | 'recent' | 'fav', or a type id with filter 'all'. */
export function setListView(filter, type = 'all') {
  S.filter = filter;
  S.type = type;
  saveUi();
}

export function setSort(sort) {
  S.sort = sort;
  saveUi();
}

/** The search box's text (the input element is the caller's). */
export function setSearch(q) {
  S.query = q;
}

export function setSiteQuery(q) {
  S.siteQuery = q;
}

/** The item shown in the detail pane (in selection mode: the keyboard row). */
export function setSel(id) {
  S.sel = id;
}

/** The current tab's autofill matches, or null. */
export function setAutofill(af) {
  S.af = af;
}

/** 'idle' | 'run' | 'done' on the autofill card. */
export function setAutofillState(state) {
  if (S.af) S.af.state = state;
}

/** Selection mode (delete several) on or off; either way nothing is checked yet. */
export function setPickMode(on) {
  S.picking = on;
  S.picked = new Set();
}

/** Check `ids` (all = true) or exactly these (replace = true). */
export function setPicked(ids, { replace = false } = {}) {
  if (replace) S.picked = new Set(ids);
  else for (const id of ids) S.picked.add(id);
}

export function togglePicked(id) {
  if (S.picked.has(id)) S.picked.delete(id);
  else S.picked.add(id);
}

/** Uncheck rows that are no longer shown. Returns true when something was unchecked. */
export function prunePicked(shown) {
  const before = S.picked.size;
  for (const id of S.picked) if (!shown.has(id)) S.picked.delete(id);
  return S.picked.size !== before;
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
  MSG.VAULT_SAVE_ITEM, MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_ITEMS, MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_IMPORT, MSG.VAULT_IMPORT_ITEMS, MSG.VAULT_CHANGE_PASSWORD,
  MSG.VAULT_CREATE_VAULT, MSG.VAULT_UPDATE_VAULT, MSG.VAULT_DELETE_VAULT,
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
    case ERR.NOT_EMPTY: return '保管庫の中身が変わりました。もう一度選んでください';
    default: return 'エラーが発生しました';
  }
}

/* ── derived data ── */
const strengthCache = new Map();
let reuse = new Map();
let health = null; // the パスワード診断 report, see healthReport()

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
  health = null;
  reuse = new Map();
  for (const it of S.items) {
    if (it.type !== 'login' || !it.password) continue;
    reuse.set(it.password, (reuse.get(it.password) || 0) + 1);
  }
}

/* パスワード診断 (lib/health.js), over every vault so reuse across vaults counts; rebuilt when items change */
export const healthReport = () => (health ??= passwordHealth(S.items, { strength: strengthOf }));
/** The item's issues (ISSUES order), [] when it has none. */
export const issuesOf = (it) => healthReport().issues.get(it?.id) || [];
/** Logins per issue in the current vault, and how many need action: { logins, action, weak, reused, old, no2fa }. */
export function healthCounts() {
  const out = { logins: 0, action: 0, ...Object.fromEntries(ISSUES.map((k) => [k, 0])) };
  for (const it of S.items) {
    if (!inVault(it) || it.type !== 'login' || !it.password) continue;
    out.logins++;
    const list = issuesOf(it);
    for (const k of list) out[k]++;
    if (list.some((k) => ACTION_ISSUES.includes(k))) out.action++;
  }
  return out;
}

/** How many *other* items share this item's password. */
export const reuseOf = (it) => (it?.type === 'login' && it.password ? Math.max(0, (reuse.get(it.password) || 0) - 1) : 0);

/** Weak / reused password warnings are for logins only. */
export function isWeak(it) {
  if (!it || it.type !== 'login' || !it.password) return false;
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
  removeItems([id]);
}

export function removeItems(ids) {
  const gone = new Set(ids);
  S.items = S.items.filter((i) => !gone.has(i.id));
  for (const id of gone) S.picked.delete(id);
  if (S.af) {
    S.af.items = S.af.items.filter((m) => !gone.has(m.id));
    if (!S.af.items.length) S.af = null;
  }
  recomputeReuse();
}

export function clearSecrets() {
  S.items = [];
  S.af = null;
  S.sel = null;
  S.query = '';
  S.siteQuery = '';
  S.picking = false;
  S.picked = new Set();
  strengthCache.clear();
  normCache.clear();
  reuse = new Map();
  health = null;
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

export const inType = (it) => S.type === 'all' || it.type === S.type;

/** Title plus the item's non-secret text (searchTextOf never contains secret values). */
export const matchesQuery = (it, q) => !q || normOf(it.title).norm.includes(q) || normOf(searchTextOf(it)).norm.includes(q);

export function visibleItems(now = Date.now()) {
  const q = searchQuery();
  const v = S.items.filter((i) => inVault(i) && inType(i)
    && (S.filter === 'all' || (S.filter === 'recent' && groupIndex(i.lastUsedAt, now) <= 1) || (S.filter === 'fav' && i.fav))
    && matchesQuery(i, q));
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

/**
 * Copy and, for secrets, schedule the clipboard clear. `field` is one of COPY_LABEL's keys,
 * or any field with { label, secret } given (item fields and extra fields).
 */
export async function copyText(field, value, { label = null, secret = null } = {}) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toastError('コピーできませんでした');
    return false;
  }
  const secs = Number(S.settings.clipboardClearSeconds) || 0;
  const sensitive = secret ?? field !== 'user';
  const done = label != null ? t('copy.done', { label }, '{label}をコピーしました') : COPY_LABEL[field] + 'をコピーしました';
  let sub = null;
  if (sensitive && secs > 0) {
    try {
      await call(MSG.CLIPBOARD_SCHEDULE_CLEAR, { seconds: secs });
      sub = `${secs}秒後にクリップボードから自動で消去します`;
    } catch {
      // copied, but nothing will clear it — say so instead of promising
      toastError(done, '自動消去を設定できませんでした');
      return true;
    }
  }
  toast(done, sub);
  return true;
}
