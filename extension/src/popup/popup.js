import { MSG } from '../shared/messages.js';
import { send } from '../shared/api.js';
import { typeOf } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
import { useLanguage } from '../shared/locale.js';
import {
  S, on, emit, call, errText, saveUi, setItems, replaceItem, removeItems, addItems, clearSecrets, itemById, visibleItems, ensureSel,
  liveToken, live, setPhase, endEpoch, setSettings, setVaults, setDefaultEmail, setVaultFilter, setListView, setSort, setSearch,
  setSiteQuery, setAutofill, setSel, setTrash, vaultById, defaultVaults,
} from './state.js';
import { clear } from './views/dom.js';
import { siteOf } from './views/format.js';
import { toast, toastError, hideToast, initToast } from './views/toast.js';
import { renderList, renderCounts, scrollToRow, renderViewButton, resetListCache } from './views/list.js';
import { buildPlusMenu } from './views/type-menu.js';
import { initDetail, renderDetail, stopDetail, showPasswordUpdated } from './views/detail.js';
import { renderPicker, resetPicker } from './views/picker.js';
import { openEditor, closeEditor, editorOpen, requestClose } from './views/editor.js';
import { initGenerator, openGenerator, closeGenerator, resetGenerator } from './views/generator.js';
import { initGate, showGate, setGateStatus } from './views/lock.js';
import { initSettings, openSettings, closeSettings, REOPEN_KEY } from './views/settings.js';
import { initHealth, openHealth, closeHealth } from './views/health.js';
import { initBackup, refreshBackup, resetBackup, backupDone } from './views/backup.js';
import { initTrash, openTrash, closeTrash, refreshTrash } from './views/trash.js';
import { TRASH_DAYS } from '../lib/vault/trash.js';
import {
  renderVaultLabel, renderFilters, refreshList, select, setQuery, typeQuery, cancelTyping, showQuery, prefillSiteQuery,
} from './controllers/view.js';
import { closeMenus, openMenu, menuKeys } from './controllers/menus.js';
import { renderPickMode, setPicking, pick, pickAll, deletePicked, resetPickAnchor } from './controllers/picking.js';
import { activeTab, isWebTab, siteQueryOf, fetchAutofill, refreshAutofill, doAutofill } from './controllers/autofill.js';
import { onKey } from './controllers/keyboard.js';
import { SESSION_KEY } from '../shared/storage-keys.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

try { localStorage.removeItem('akari.themePref'); } catch { }

const STATUS_POLL_MS = 10000;
const PING_THROTTLE_MS = 30000;
const AUTOFILL_WAIT_MS = 800;

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
  setDefaultEmail(data?.defaultEmail);
  setItems(data?.items || []);
  setTrash(data?.trash);
  if (!itemById(S.sel)) setSel(null);
  ensureSel();
  return S.items.length;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

async function loadAll({ onDecrypted } = {}) {
  const token = S.epoch;
  let rendered = false;
  setAutofill(null);
  setSiteQuery('');
  const tab = activeTab();
  const site = tab.then((tb) => { if (S.epoch === token) setSiteQuery(siteQueryOf(tb)); });
  const af = fetchAutofill(tab).then((res) => {
    if (S.epoch !== token) return;
    setAutofill(res);
    if (rendered && res && S.phase === 'main') renderList();
  });
  const [count] = await Promise.all([loadData(onDecrypted), withTimeout(af, AUTOFILL_WAIT_MS), site]);
  rendered = true;
  return count;
}

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
  refreshBackup();
}

let statusTimer = 0;
function startStatusPoll() {
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (S.phase !== 'main') return;
    try {
      const st = await send(MSG.VAULT_STATUS);
      if (st?.locked) lockNow({ remote: true });
    } catch { }
  }, STATUS_POLL_MS);
}

function watchSession() {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'session' || S.phase !== 'main') return;
    const c = changes[SESSION_KEY];
    if (!c || c.newValue !== undefined) return;
    send(MSG.VAULT_STATUS).then((st) => { if (st?.locked) lockNow({ remote: true }); }, () => lockNow({ remote: true }));
  });
}

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
  renderPickMode();
  renderCounts();
  resetBackup();
}

async function lockService() {
  for (let i = 0; i < 2; i++) {
    try {
      await send(MSG.VAULT_LOCK);
      return;
    } catch { }
  }
  try {
    const st = await send(MSG.VAULT_STATUS);
    if (st?.locked) return;
  } catch { }
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
    } catch { }
  }
  const go = () => openEditor({ type: 'login', prefill });
  if (editorOpen()) requestClose(go);
  else go();
}

function newNote() {
  newItem('note');
}

function newItem(type) {
  if (type === 'login') { newLogin(); return; }
  closeMenus();
  if (!typeOf(type)) return;
  setPicking(false);
  const go = () => openEditor({ type });
  if (editorOpen()) requestClose(go);
  else go();
}

function onTrashed(ids, { title = null, trash = null } = {}) {
  if (S.phase !== 'main' || !ids?.length) return;
  const vis = visibleItems();
  const idx = vis.findIndex((i) => ids.includes(i.id));
  removeItems(ids);
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

function onRestored(res) {
  if (S.phase !== 'main') return;
  const items = Array.isArray(res?.items) ? res.items : [];
  setTrash(res?.trash);
  refreshTrash();
  if (!items.length) return;
  addItems(items);
  if (editorOpen()) {
    renderList();
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
  const vault = items.length === 1 ? vaultById(items[0].vault)?.name : null;
  toast(msg, vault ? t('trash.restoredIn', { vault }, '保管庫「{vault}」に戻しました') : null);
}

let lastPing = 0;
function ping(force = false) {
  if (S.phase !== 'main') return;
  const now = Date.now();
  if (!force && now - lastPing < PING_THROTTLE_MS) return;
  lastPing = now;
  send(MSG.ACTIVITY_PING).catch(() => {});
}

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
    $('menuBtn').focus({ preventScroll: true });
    openSettings();
  });
  $('openHealth').addEventListener('click', () => {
    closeMenus();
    $('menuBtn').focus({ preventScroll: true });
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
  on('picked', () => { if (S.picking) { resetPicker(); renderPicker(); } });
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
  on('saved', (item, isNew, { keepEditor = false } = {}) => {
    if (S.phase !== 'main') return;
    replaceItem(item);
    setSel(item.id);
    revealItem(item);
    renderList();
    renderDetail({ animate: true });
    setTimeout(() => scrollToRow(item.id), 0);
    if (!keepEditor) toast(isNew ? t('{title} を追加しました', { title: item.title }) : t('{title} を保存しました', { title: item.title }),
      isNew ? null : t('変更は暗号化して保存されました'));
    refreshAutofill();
  });
  on('backupDone', backupDone);
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
      refreshBackup();
      emit('reloaded');
    } catch (e) {
      if (live(token)) toastError(t('保管庫を読み込めませんでした'), errText(e));
    }
  });
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
  initDetail();
  initGenerator();
  initSettings();
  initHealth();
  initTrash();
  initBackup({ open: () => { closeMenus(); openSettings({ page: 'export' }); } });
  initGate({ load: loadAll, enter: () => enterMain({ animate: true }) });
}

function reopenAfterLanguage() {
  let target = null;
  try {
    target = sessionStorage.getItem(REOPEN_KEY);
    sessionStorage.removeItem(REOPEN_KEY);
  } catch { }
  if (target !== 'settings' || S.phase !== 'main') return;
  openSettings();
  setTimeout(() => document.querySelector('#setSheet [data-setting="language"] [aria-checked="true"]')?.focus({ preventScroll: true }), 80);
}

async function boot() {
  const statusP = send(MSG.VAULT_STATUS).then((s) => ({ s }), (e) => ({ e }));
  await loadSettings();
  useLanguage(S.settings?.language);
  globalThis.__akariTheme?.apply(S.settings?.theme);
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
