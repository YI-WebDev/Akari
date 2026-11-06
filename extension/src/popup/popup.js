// Akari popup controller (design 1a "Akari Terminal"): boot, loading, lock, new items, and the
// wiring between views. The rest lives in controllers/: view (labels, list refresh, selection,
// search), menus, picking (delete several), autofill (the current tab) and keyboard.

import { MSG, DEFAULT_VAULTS } from '../shared/messages.js';
import { send } from '../shared/api.js';
import { typeOf } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
import {
  S, on, emit, call, errText, saveUi, setItems, replaceItem, removeItem, clearSecrets, itemById, visibleItems, ensureSel,
  liveToken, live, setPhase, endEpoch, setSettings, setVaults, setVaultFilter, setListView, setSort, setSearch,
  setSiteQuery, setAutofill, setSel,
} from './state.js';
import { clear } from './views/dom.js';
import { siteOf } from './views/format.js';
import { toast, toastError, hideToast } from './views/toast.js';
import { renderList, renderCounts, scrollToRow, renderViewButton } from './views/list.js';
import { buildPlusMenu } from './views/type-menu.js';
import { renderDetail, stopDetail, showPasswordUpdated } from './views/detail.js';
import { renderPicker, resetPicker } from './views/picker.js';
import { openEditor, closeEditor, editorOpen, requestClose } from './views/editor.js';
import { initGenerator, openGenerator, closeGenerator, resetGenerator } from './views/generator.js';
import { initGate, showGate, setGateStatus } from './views/lock.js';
import { initSettings, openSettings, closeSettings } from './views/settings.js';
import { initHealth, openHealth, closeHealth } from './views/health.js';
import {
  renderVaultLabel, renderFilters, refreshList, select, setQuery, showQuery, prefillSiteQuery,
} from './controllers/view.js';
import { closeMenus, openMenu, menuKeys } from './controllers/menus.js';
import { renderPickMode, setPicking, pick, pickAll, deletePicked, resetPickAnchor } from './controllers/picking.js';
import { activeTab, isWebTab, siteQueryOf, fetchAutofill, refreshAutofill, doAutofill } from './controllers/autofill.js';
import { onKey } from './controllers/keyboard.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

// The soft theme is gone; drop the theme cache older versions kept in localStorage.
try { localStorage.removeItem('akari.themePref'); } catch { /* storage blocked */ }

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
  onDecrypted?.(Array.isArray(data?.vaults) && data.vaults.length ? data.vaults : DEFAULT_VAULTS);
  return applyData(data);
}

function applyData(data) {
  setVaults(data?.vaults);
  setItems(data?.items || []);
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
  clearSecrets();
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
  setGateStatus('ロックできませんでした。保管庫はまだひらいています', { err: true });
  toastError('ロックできませんでした', 'もう一度ロックしてください');
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
  $('scrim').addEventListener('click', () => { closeGenerator(); closeSettings(); closeHealth(); });

  const search = $('search');
  search.addEventListener('input', () => setQuery(search.value));
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
    toast('新しいパスワードを保留してコピーしました', 'サイトで変更してから「確定」を押してください');
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
    toast(isNew ? `${item.title} を追加しました` : `${item.title} を保存しました`, isNew ? null : '変更は暗号化して保存されました');
    refreshAutofill();
  });
  on('deleted', (id, title) => {
    if (S.phase !== 'main') return;
    const idx = visibleItems().findIndex((i) => i.id === id);
    removeItem(id); // also drops it from the autofill card
    const rest = visibleItems();
    setSel(rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.id || S.items[0]?.id || null);
    renderList();
    renderDetail({ animate: true });
    toast(`${title || 'アイテム'} を削除しました`);
  });
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
      emit('reloaded');
    } catch (e) {
      if (live(token)) toastError('保管庫を読み込めませんでした', errText(e));
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

  initGenerator();
  initSettings();
  initHealth();
  initGate({ load: loadAll, enter: () => enterMain({ animate: true }) });
}

async function boot() {
  wire();
  const settingsP = loadSettings();
  let status;
  try {
    status = await send(MSG.VAULT_STATUS);
  } catch {
    await settingsP;
    showGate('lock', { instant: true });
    $('lockStatus').textContent = 'Akari のサービスに接続できませんでした';
    $('lockStatus').classList.add('err');
    return;
  }
  await settingsP;
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
  } catch {
    setPhase('locked');
    app.dataset.phase = 'locked';
    showGate('lock', { instant: true });
  }
}

boot();
