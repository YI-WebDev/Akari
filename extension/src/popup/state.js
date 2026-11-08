import { send } from '../shared/api.js';
import { MSG, ERR, DEFAULT_SETTINGS, DEFAULT_VAULTS } from '../shared/messages.js';
import { estimateStrength } from '../lib/strength.js';
import { passwordHealth, ISSUES, ACTION_ISSUES } from '../lib/health.js';
import { typeOf, searchTextOf } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
import { groupIndex, normMap } from './views/format.js';
import { compileQuery } from './search.js';
import { toast, toastError } from './views/toast.js';

export const S = {
  phase: 'boot',
  epoch: 0,
  settings: { ...DEFAULT_SETTINGS },
  vaults: [...DEFAULT_VAULTS],
  items: [],
  trash: [],
  vault: 'all',
  filter: 'all',
  type: 'all',
  sort: 'recent',
  query: '',
  siteQuery: '',
  sel: null,
  picking: false,
  picked: new Set(),
  af: null,
};

const UI_KEY = 'akari.ui';
try {
  const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
  if (['all', 'recent', 'fav'].includes(saved.filter)) S.filter = saved.filter;
  if (['recent', 'az'].includes(saved.sort)) S.sort = saved.sort;
  if (typeof saved.vault === 'string') S.vault = saved.vault;
  if (typeof saved.type === 'string' && typeOf(saved.type)) S.type = saved.type;
  if (S.type !== 'all') S.filter = 'all';
} catch { }

export function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ filter: S.filter, sort: S.sort, vault: S.vault, type: S.type })); } catch { }
}

export function setPhase(phase) {
  S.phase = phase;
}

export function endEpoch() {
  S.phase = 'locked';
  S.epoch++;
}

export function setSettings(settings) {
  S.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export function putSetting(key, value) {
  const prev = S.settings[key];
  S.settings = { ...S.settings, [key]: value };
  return prev;
}

export const defaultVaults = () => DEFAULT_VAULTS.map((v) => ({ ...v, name: t(`vault.default.${v.id}`, null, v.name) }));

export function setVaults(vaults) {
  S.vaults = Array.isArray(vaults) && vaults.length ? vaults : defaultVaults();
  if (S.vault !== 'all' && !S.vaults.some((v) => v.id === S.vault)) S.vault = 'all';
}

export function setVaultFilter(id) {
  S.vault = id;
  saveUi();
}

export function setListView(filter, type = 'all') {
  S.filter = filter;
  S.type = type;
  saveUi();
}

export function setSort(sort) {
  S.sort = sort;
  saveUi();
}

export function setSearch(q) {
  S.query = q;
}

export function setSiteQuery(q) {
  S.siteQuery = q;
}

export function setSel(id) {
  S.sel = id;
}

export function setAutofill(af) {
  S.af = af;
}

export function setAutofillState(state) {
  if (S.af) S.af.state = state;
}

export function setPickMode(on) {
  S.picking = on;
  S.picked = new Set();
}

export function setPicked(ids, { replace = false } = {}) {
  if (replace) S.picked = new Set(ids);
  else for (const id of ids) S.picked.add(id);
}

export function togglePicked(id) {
  if (S.picked.has(id)) S.picked.delete(id);
  else S.picked.add(id);
}

export function prunePicked(shown) {
  const before = S.picked.size;
  for (const id of S.picked) if (!shown.has(id)) S.picked.delete(id);
  return S.picked.size !== before;
}

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

export const liveToken = () => S.epoch;
export const live = (token) => S.phase === 'main' && S.epoch === token;

const WRITES = new Set([
  MSG.VAULT_SAVE_ITEM, MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_ITEMS, MSG.VAULT_RESTORE_ITEMS, MSG.VAULT_PURGE_ITEMS,
  MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_IMPORT, MSG.VAULT_IMPORT_ITEMS, MSG.VAULT_CHANGE_PASSWORD,
  MSG.VAULT_CREATE_VAULT, MSG.VAULT_UPDATE_VAULT, MSG.VAULT_DELETE_VAULT,
]);
let writesInFlight = 0;

export async function call(type, payload) {
  const write = WRITES.has(type);
  if (write && writesInFlight++ === 0) emit('saving', true);
  try {
    return await send(type, payload);
  } catch (e) {
    if (e?.code === ERR.LOCKED) emit('locked');
    throw e;
  } finally {
    if (write && --writesInFlight === 0) emit('saving', false);
  }
}

export function errText(e) {
  switch (e?.code) {
    case ERR.BAD_PASSWORD: return t('パスワードが違います');
    case ERR.LOCKED: return t('ロックされています');
    case ERR.NOT_FOUND: return t('アイテムが見つかりません');
    case ERR.INVALID: return t('入力内容を確認してください');
    case ERR.DOMAIN_MISMATCH: return t('このサイトのアイテムではありません');
    case ERR.NOT_EMPTY: return t('保管庫の中身が変わりました。もう一度選んでください');
    default: return t('エラーが発生しました');
  }
}

const strengthCache = new Map();
let reuse = new Map();
let health = null;

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

export function setTrash(trash) {
  S.trash = Array.isArray(trash) ? trash : [];
}

export function addItems(items) {
  const ids = new Set(items.map((i) => i.id));
  S.items = [...items, ...S.items.filter((i) => !ids.has(i.id))];
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

export const healthReport = () => (health ??= passwordHealth(S.items, { strength: strengthOf }));
export const issuesOf = (it) => healthReport().issues.get(it?.id) || [];
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

export const reuseOf = (it) => (it?.type === 'login' && it.password ? Math.max(0, (reuse.get(it.password) || 0) - 1) : 0);

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
  S.trash = [];
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

const NORM_CACHE_MAX = 2000;
const normCache = new Map();
export function normOf(text) {
  const s = String(text || '');
  let m = normCache.get(s);
  if (!m) {
    m = normMap(s);
    if (normCache.size > NORM_CACHE_MAX) normCache.clear();
    normCache.set(s, m);
  }
  return m;
}

let compiled = null;
function query() {
  if (compiled?.raw !== S.query) {
    compiled = compileQuery(S.query, {
      issuesOf,
      vaultName: (id) => vaultById(id)?.name || '',
      textOf: (it) => ({ title: normOf(it.title).norm, rest: normOf(searchTextOf(it)).norm }),
    });
    compiled.raw = S.query;
  }
  return compiled;
}

export const searchQuery = () => query().text;
export const searching = () => !query().empty;
let loose = false;
export const looseResults = () => loose;

export function inVault(it) {
  return S.vault === 'all' || it.vault === S.vault;
}

export const inType = (it) => S.type === 'all' || it.type === S.type;

const LAST_USED_THIS_WEEK_GROUP = 1;
const inFilter = (i, now) => S.filter === 'all' || (S.filter === 'recent' && groupIndex(i.lastUsedAt, now) <= LAST_USED_THIS_WEEK_GROUP) || (S.filter === 'fav' && i.fav);

export function visibleItems(now = Date.now()) {
  const q = query();
  const base = S.items.filter((i) => inVault(i) && inType(i) && inFilter(i, now));
  let v = q.empty ? base : base.filter((i) => q.test(i));
  loose = false;
  if (!v.length && q.text) {
    v = base.filter((i) => q.loose(i));
    loose = v.length > 0;
  }
  if (S.sort === 'az') return v.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ja'));
  return v.sort((a, b) => {
    const ga = groupIndex(a.lastUsedAt, now);
    const gb = groupIndex(b.lastUsedAt, now);
    if (ga !== gb) return ga - gb;
    if (a.lastUsedAt || b.lastUsedAt) return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

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

export function forSave(item) {
  const { passkeys, ...rest } = item;
  return rest;
}

export function mergeSaved(saved, prev) {
  const base = saved && typeof saved === 'object' ? saved : prev;
  return { ...base, passkeys: base.passkeys ?? prev?.passkeys ?? [] };
}

const COPY_LABEL = { user: 'ユーザー名', pass: 'パスワード', totp: '認証コード', gen: '生成したパスワード' };

export async function copyText(field, value, { label = null, secret = null } = {}) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toastError(t('コピーできませんでした'));
    return false;
  }
  const secs = Number(S.settings.clipboardClearSeconds) || 0;
  const sensitive = secret ?? field !== 'user';
  const done = t('copy.done', { label: label != null ? label : t(COPY_LABEL[field]) }, '{label}をコピーしました');
  let sub = null;
  if (sensitive && secs > 0) {
    try {
      await call(MSG.CLIPBOARD_SCHEDULE_CLEAR, { seconds: secs });
      sub = t('{n}秒後にクリップボードから自動で消去します', { n: secs });
    } catch {
      toastError(done, t('自動消去を設定できませんでした'));
      return true;
    }
  }
  toast(done, sub);
  return true;
}
