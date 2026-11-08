// Akari popup controller (design 1a "Akari Terminal"): boot, loading, lock, new items, and the
// wiring between views. The rest lives in controllers/: view (labels, list refresh, selection,
// search), menus, picking (delete several), autofill (the current tab) and keyboard.

import { MSG } from '../shared/messages.js';
import { send } from '../shared/api.js';
import { typeOf } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
import { useLanguage } from '../shared/locale.js';
import {
  S, on, emit, call, errText, saveUi, setItems, replaceItem, removeItems, addItems, clearSecrets, itemById, visibleItems, ensureSel,
  liveToken, live, setPhase, endEpoch, setSettings, setVaults, setVaultFilter, setListView, setSort, setSearch,
  setSiteQuery, setAutofill, setSel, setTrash, vaultById, defaultVaults,
} from './state.js';
import { clear } from './views/dom.js';
import { siteOf } from './views/format.js';
import { toast, toastError, hideToast, initToast } from './views/toast.js';
import { renderList, renderCounts, scrollToRow, renderViewButton, resetListCache } from './views/list.js';
import { buildPlusMenu } from './views/type-menu.js';
import { renderDetail, stopDetail, showPasswordUpdated } from './views/detail.js';
import { renderPicker, resetPicker } from './views/picker.js';
import { openEditor, closeEditor, editorOpen, requestClose } from './views/editor.js';
import { initGenerator, openGenerator, closeGenerator, resetGenerator } from './views/generator.js';
import { initGate, showGate, setGateStatus } from './views/lock.js';
import { initSettings, openSettings, closeSettings } from './views/settings.js';
import { initHealth, openHealth, closeHealth } from './views/health.js';
import { initTrash, openTrash, closeTrash, refreshTrash } from './views/trash.js';
import { TRASH_DAYS } from '../lib/vault/trash.js';
import {
  renderVaultLabel, renderFilters, refreshList, select, setQuery, typeQuery, cancelTyping, showQuery, prefillSiteQuery,
} from './controllers/view.js';
import { closeMenus, openMenu, menuKeys } from './controllers/menus.js';
import { renderPickMode, setPicking, pick, pickAll, deletePicked, resetPickAnchor } from './controllers/picking.js';
import { activeTab, isWebTab, siteQueryOf, fetchAutofill, refreshAutofill, doAutofill } from './controllers/autofill.js';
import { onKey } from './controllers/keyboard.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

// The soft theme is gone; drop the theme cache older versions kept in localStorage.
try { localStorage.removeItem('akari.themePref'); } catch { /* storage blocked */ }

const REOPEN_KEY = 'akari.reopen'; // views/settings.js sets it before reloading for a new language

/* ───────── data ───────── */

async function loadSettings() {
  try {
    setSettings(await send(MSG.SETTINGS_GET));
  } catch {
    setSettings(null);
  }
}

async function loadData(onDecrypted) {
  const token = S.epoch;
  const data = await call(MSG.VAULT_GET_ALL);
  if (S.epoch !== token) throw new Error('locked meanwhile');
  onDecrypted?.(Array.isArray(data?.vaults) && data.vaults.length ? data.vaults : defaultVaults());
  return applyData(data);
}

function applyData(data) {
  setVaults(data?.vaults);
  setItems(data?.items || []);
  setTrash(data?.trash);
  if (!itemById(S.sel)) setSel(null);
  ensureSel();
  return S.items.length;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/** Used by the gate after unlock/setup and on reload: items + autofill matches.
 *  `onDecrypted(vaults)` fires once vault/getAll returned (the gate's boot log). */
async function loadAll({ onDecrypted } = {}) {
  const token = S.epoch;
  let rendered = false;
  setAutofill(null);
  setSiteQuery('');
  const tab = activeTab();
  const site = tab.then((tb) => { if (S.epoch === token) setSiteQuery(siteQueryOf(tb)); });
  // matches that arrive after the first render are added to the list then
  const af = fetchAutofill(tab).then((res) => {
    if (S.epoch !== token) return;
    setAutofill(res);
    if (rendered && res && S.phase === 'main') renderList();
  });
  const [count] = await Promise.all([loadData(onDecrypted), withTimeout(af, 800), site]);
  rendered = true;
  return count;
}

/* ───────── main view ───────── */

function enterMain({ animate = true } = {}) {
  setPhase('main');
  app.dataset.phase = 'main';
  prefillSiteQuery();
  renderVaultLabel();
  renderFilters();
  renderList({ animate });
  renderDetail({ animate });
  ping(true);
  startStatusPoll();
}

/* ───────── lock ───────── */

let statusTimer = 0;
function startStatusPoll() {
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (S.phase !== 'main') return;
    try {
      const st = await send(MSG.VAULT_STATUS);
      if (st?.locked) lockNow({ remote: true });
    } catch { /* ignore */ }
  }, 10000);
}

/** The SW removes akari.session whenever it locks (auto-lock, other pages): react at once. */
function watchSession() {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'session' || S.phase !== 'main') return;
    const c = changes['akari.session'];
    if (!c || c.newValue !== undefined) return;
    send(MSG.VAULT_STATUS).then((st) => { if (st?.locked) lockNow({ remote: true }); }, () => lockNow({ remote: true }));
  });
}

/** Drop every decrypted value from memory and the DOM. */
function wipeView() {
  cancelTyping();
  clearSecrets();
  resetListCache();
  resetGenerator();
  hideToast();
  clear($('list'));
  clear($('detail'));
  clear($('vaultItems'));
  showQuery('');
  resetPickAnchor();
  resetPicker();
  renderPickMode(); // clearSecrets left selection mode
  renderCounts();
}

async function lockService() {
  for (let i = 0; i < 2; i++) {
    try {
      await send(MSG.VAULT_LOCK);
      return;
    } catch { /* retry once, then check */ }
  }
  try {
    const st = await send(MSG.VAULT_STATUS);
    if (st?.locked) return;
  } catch { /* fall through */ }
  setGateStatus(t('ロックできませんでした。保管庫はまだひらいています'), { err: true });
  toastError(t('ロックできませんでした'), t('もう一度ロックしてください'));
}

async function lockNow({ remote = false } = {}) {
  if (S.phase !== 'main') return;
  endEpoch();
  app.dataset.phase = 'locked';
  clearInterval(statusTimer);
  closeMenus();
  closeGenerator();
  closeSettings();
  closeHealth({ restore: false });
  closeTrash({ restore: false });
  closeEditor();
  stopDetail();
  wipeView();
  showGate('lock');
  if (!remote) await lockService();
}

/* ───────── new items ───────── */

async function newLogin() {
  closeMenus();
  setPicking(false);
  const token = liveToken();
  const tab = await activeTab();
  if (!live(token)) return;
  const prefill = {};
  if (isWebTab(tab)) {
    try {
      const u = new URL(tab.url);
      prefill.url = u.origin;
      prefill.title = siteOf(u.href);
    } catch { /* ignore */ }
  }
  const go = () => openEditor({ type: 'login', prefill });
  if (editorOpen()) requestClose(go);
  else go();
}

function newNote() {
  newItem('note');
}

/** ＋ menu: any item type. Logins get the active tab's site as before. */
function newItem(type) {
  if (type === 'login') { newLogin(); return; }
  closeMenus();
  if (!typeOf(type)) return;
  setPicking(false);
  const go = () => openEditor({ type });
  if (editorOpen()) requestClose(go);
  else go();
}

/* ───────── ゴミ箱 ───────── */

/** Deleted items went to the ゴミ箱 (editor, selection mode): the toast offers 元に戻す. */
function onTrashed(ids, { title = null, trash = null } = {}) {
  if (S.phase !== 'main' || !ids?.length) return;
  const vis = visibleItems();
  const idx = vis.findIndex((i) => ids.includes(i.id));
  removeItems(ids); // also drops them from the autofill card
  if (trash) setTrash(trash);
  const rest = visibleItems();
  setSel(rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.id || S.items[0]?.id || null);
  renderList();
  renderDetail({ animate: true });
  refreshTrash();
  const msg = ids.length === 1 && title
    ? t('trash.movedOne', { title }, '{title} をゴミ箱に移しました')
    : t('trash.moved', { n: ids.length }, '{n} 件をゴミ箱に移しました');
  toast(msg, t('trash.keep', { days: TRASH_DAYS }, '{days} 日後に完全に削除します'), 'ok', {
    action: { label: t('trash.restore', null, '元に戻す'), title: t('trash.undoKey', null, '元に戻す (Ctrl+Z)'), run: () => undoTrash(ids) },
  });
}

async function undoTrash(ids) {
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_RESTORE_ITEMS, { ids });
    if (live(token)) emit('restored', res, { from: 'toast' });
  } catch (e) {
    if (!live(token)) return;
    toastError(t('trash.restoreFailed', null, '元に戻せませんでした'), errText(e));
    emit('reload');
  }
}

/** Items came back from the ゴミ箱: in the list again, the first one selected. */
function onRestored(res) {
  if (S.phase !== 'main') return;
  const items = Array.isArray(res?.items) ? res.items : [];
  setTrash(res?.trash);
  refreshTrash();
  if (!items.length) return;
  addItems(items);
  if (editorOpen()) {
    renderList(); // the editor stays as it is; the restored items are back in the list
  } else {
    setSel(items[0].id);
    revealItem(items[0]);
    renderList();
    renderDetail({ animate: true });
    setTimeout(() => scrollToRow(items[0].id), 0);
  }
  refreshAutofill();
  const msg = items.length === 1
    ? t('trash.restoredOne', { title: items[0].title || t('(無題)') }, '{title} を元に戻しました')
    : t('trash.restored', { n: items.length }, '{n} 件を元に戻しました');
  // one item: say which vault it is in (the first vault, when its own was deleted meanwhile)
  const vault = items.length === 1 ? vaultById(items[0].vault)?.name : null;
  toast(msg, vault ? t('trash.restoredIn', { vault }, '保管庫「{vault}」に戻しました') : null);
}

/* ───────── activity ───────── */

let lastPing = 0;
function ping(force = false) {
  if (S.phase !== 'main') return;
  const now = Date.now();
  if (!force && now - lastPing < 30000) return;
  lastPing = now;
  send(MSG.ACTIVITY_PING).catch(() => {});
}

/* ───────── wiring ───────── */

/** After a save: make sure the saved item is visible (all view, no search, its vault). */
function revealItem(item) {
  if (visibleItems().some((i) => i.id === item.id)) return;
  setListView('all', S.type === item.type ? S.type : 'all');
  setSearch('');
  showQuery('');
  if (S.vault !== 'all' && S.vault !== item.vault) setVaultFilter('all');
  renderVaultLabel();
  renderFilters();
}

function wire() {
  $('menuBtn').addEventListener('click', () => openMenu('main'));
  $('vaultBtn').addEventListener('click', () => openMenu('vault'));
  $('plusBtn').addEventListener('click', () => openMenu('plus'));
  $('typeBtn').addEventListener('click', () => openMenu('type'));
  $('pickBtn').addEventListener('click', () => setPicking(!S.picking));
  $('catcher').addEventListener('click', closeMenus);
  $('mainMenu').addEventListener('keydown', menuKeys);
  $('vaultMenu').addEventListener('keydown', menuKeys);
  $('plusMenu').addEventListener('keydown', menuKeys);
  $('typeMenu').addEventListener('keydown', menuKeys);
  $('openSettings').addEventListener('click', () => {
    closeMenus();
    $('menuBtn').focus({ preventScroll: true }); // where focus returns when the sheet closes
    openSettings();
  });
  $('openHealth').addEventListener('click', () => {
    closeMenus();
    $('menuBtn').focus({ preventScroll: true }); // where focus returns when the screen closes
    openHealth();
  });
  $('openTrash').addEventListener('click', () => {
    closeMenus();
    $('menuBtn').focus({ preventScroll: true });
    openTrash();
  });
  $('manageVaults').addEventListener('click', () => {
    closeMenus();
    $('menuBtn').focus({ preventScroll: true });
    openSettings({ page: 'vaults' });
  });
  buildPlusMenu($('plusMenu'), { onNew: newItem, onGen: () => { closeMenus(); openGenerator({}); } });
  $('plusMenu').setAttribute('aria-label', t('menu.new', null, '新規作成'));
  $('typeMenu').setAttribute('aria-label', t('list.viewMenu', null, '表示するアイテム'));
  renderViewButton();
  $('lockBtn').addEventListener('click', () => lockNow());
  $('scrim').addEventListener('click', () => { closeGenerator(); closeSettings(); closeHealth(); closeTrash(); });

  const search = $('search');
  search.addEventListener('input', () => typeQuery(search.value));
  $('searchClear').addEventListener('click', (e) => {
    e.preventDefault();
    setQuery('');
    search.focus();
  });

  $('sortBtn').addEventListener('click', () => {
    setSort(S.sort === 'az' ? 'recent' : 'az');
    renderFilters();
    refreshList({ animate: true });
  });

  document.addEventListener('keydown', onKey);
  watchSession();
  document.addEventListener('pointerdown', () => ping(), { passive: true });
  document.addEventListener('keydown', () => ping(), { passive: true });

  on('locked', () => lockNow({ remote: true }));
  on('select', (id) => select(id));
  on('pick', (id, opts) => pick(id, opts));
  on('picked', () => { if (S.picking) { resetPicker(); renderPicker(); } }); // the list unchecked rows that left the view
  on('pickAll', () => pickAll(true));
  on('pickNone', () => pickAll(false));
  on('pickExit', () => setPicking(false));
  on('pickDelete', deletePicked);
  on('autofill', doAutofill);
  on('newLogin', newLogin);
  on('newNote', newNote);
  on('newItem', newItem);
  on('edit', (id) => openEditor({ id }));
  on('openGen', (opts) => openGenerator(opts || {}));
  on('openImport', () => { closeMenus(); openSettings({ page: 'import' }); });
  on('listChanged', () => { if (S.phase === 'main') refreshList(); });
  // パスワード診断 handed a login over: show it in the main view, then edit it or fix its password
  on('healthAct', (id, kind) => {
    const item = itemById(id);
    if (S.phase !== 'main' || !item) return;
    const go = () => {
      setSel(id);
      revealItem(item);
      renderList();
      renderDetail({ animate: true });
      setTimeout(() => scrollToRow(id), 0);
      if (kind === 'edit') openEditor({ id });
      else if (kind === 'fix') openGenerator({ target: id });
      else $('list').focus({ preventScroll: true });
    };
    if (editorOpen()) requestClose(go);
    else go();
  });
  on('passwordPending', (id) => {
    if (S.phase !== 'main') return;
    setSel(id);
    renderList();
    renderDetail({ animate: true });
    toast(t('新しいパスワードを保留してコピーしました'), t('サイトで変更してから「確定」を押してください'));
  });
  on('passwordUpdated', (id, info) => {
    if (S.phase !== 'main') return;
    setSel(id);
    renderList();
    showPasswordUpdated(id, info);
  });
  on('saved', (item, isNew) => {
    if (S.phase !== 'main') return;
    replaceItem(item);
    setSel(item.id);
    revealItem(item);
    renderList();
    renderDetail({ animate: true });
    setTimeout(() => scrollToRow(item.id), 0);
    toast(isNew ? t('{title} を追加しました', { title: item.title }) : t('{title} を保存しました', { title: item.title }),
      isNew ? null : t('変更は暗号化して保存されました'));
    refreshAutofill();
  });
  on('trashed', onTrashed);
  on('restored', onRestored);
  on('editorClosed', () => { if (S.phase === 'main') renderDetail({ animate: true }); });
  on('reload', async () => {
    const token = liveToken();
    try {
      const data = await call(MSG.VAULT_GET_ALL);
      if (!live(token)) return;
      applyData(data);
      saveUi();
      renderVaultLabel();
      renderList({ animate: true });
      renderDetail({ animate: true });
      refreshTrash();
      emit('reloaded');
    } catch (e) {
      if (live(token)) toastError(t('保管庫を読み込めませんでした'), errText(e));
    }
  });
  // A vault was added, renamed or recolored (views/vaults.js): items are unchanged.
  on('vaultsChanged', () => {
    if (S.vault !== 'all' && !S.vaults.some((v) => v.id === S.vault)) setVaultFilter('all');
    saveUi();
    renderVaultLabel();
    refreshList();
    renderDetail();
  });
  on('settingsChanged', (key) => {
    if (key === 'autoLockMinutes') ping(true);
  });

  initToast();
  initGenerator();
  initSettings();
  initHealth();
  initTrash();
  initGate({ load: loadAll, enter: () => enterMain({ animate: true }) });
}

/** After a language change the popup reloads; it comes back to the settings sheet. */
function reopenAfterLanguage() {
  let target = null;
  try {
    target = sessionStorage.getItem(REOPEN_KEY);
    sessionStorage.removeItem(REOPEN_KEY);
  } catch { /* storage blocked */ }
  if (target !== 'settings' || S.phase !== 'main') return;
  openSettings();
  setTimeout(() => document.querySelector('#setSheet [data-setting="language"] [aria-checked="true"]')?.focus({ preventScroll: true }), 80);
}

async function boot() {
  // the language comes first: the views build their text as they are wired
  const statusP = send(MSG.VAULT_STATUS).then((s) => ({ s }), (e) => ({ e }));
  await loadSettings();
  useLanguage(S.settings?.language);
  globalThis.__akariTheme?.apply(S.settings?.theme); // shared/theme.js already drew the last one
  wire();
  const { s: status, e: statusErr } = await statusP;
  if (statusErr) {
    showGate('lock', { instant: true });
    $('lockStatus').textContent = t('Akari のサービスに接続できませんでした');
    $('lockStatus').classList.add('err');
    return;
  }
  if (!status?.initialized) {
    setPhase('setup');
    app.dataset.phase = 'setup';
    showGate('setup', { instant: true });
    return;
  }
  if (status.locked) {
    setPhase('locked');
    app.dataset.phase = 'locked';
    showGate('lock', { instant: true });
    return;
  }
  try {
    await loadAll();
    enterMain({ animate: true });
    reopenAfterLanguage();
  } catch {
    setPhase('locked');
    app.dataset.phase = 'locked';
    showGate('lock', { instant: true });
  }
}

boot();
