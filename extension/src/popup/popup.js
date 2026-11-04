// Akari popup controller (design 1a "Akari Terminal"): boot, header/menus, status bar,
// keyboard, autofill, wiring between views.

import { MSG, ERR, DEFAULT_SETTINGS, DEFAULT_VAULTS } from '../shared/messages.js';
import { send } from '../shared/api.js';
import { hostnameOf, registrableDomain } from '../shared/domain.js';
import { typeOf, hasTemplate, fieldLabel } from '../shared/item-types.js';
import { t } from '../shared/i18n.js';
import {
  S, on, emit, call, errText, saveUi, setItems, replaceItem, removeItem, removeItems, clearSecrets,
  itemById, visibleItems, ensureSel, copyText, liveToken, live,
} from './state.js';
import { h, clear } from './views/dom.js';
import { siteOf, vaultColor } from './views/format.js';
import { burst, wait } from './views/fx.js';
import { toast, toastError, hideToast } from './views/toast.js';
import {
  renderList, renderCounts, markSelected, scrollToRow, setAfState, afButtonEl, afCandidate, viewCounts, currentView, renderViewButton,
} from './views/list.js';
import { buildPlusMenu, resetPlusMenu, renderViewMenu, moveMenuFocus } from './views/type-menu.js';
import { renderDetail, stopDetail, showPasswordUpdated } from './views/detail.js';
import { renderPicker, resetPicker, askDelete, pickerConfirming, setPickerBusy } from './views/picker.js';
import { openEditor, closeEditor, editorOpen, requestClose } from './views/editor.js';
import { initGenerator, openGenerator, closeGenerator, resetGenerator, isGenOpen } from './views/generator.js';
import { initGate, showGate, gateOpen, setGateStatus } from './views/lock.js';
import { initSettings, openSettings, closeSettings, isSettingsOpen } from './views/settings.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

// The soft theme is gone; drop the theme cache older versions kept in localStorage.
try { localStorage.removeItem('akari.themePref'); } catch { /* storage blocked */ }

/* ───────── data ───────── */

async function loadSettings() {
  try {
    const s = await send(MSG.SETTINGS_GET);
    S.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  } catch {
    S.settings = { ...DEFAULT_SETTINGS };
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
  S.vaults = Array.isArray(data?.vaults) && data.vaults.length ? data.vaults : [...DEFAULT_VAULTS];
  setItems(data?.items || []);
  if (S.vault !== 'all' && !S.vaults.some((v) => v.id === S.vault)) S.vault = 'all';
  if (!itemById(S.sel)) S.sel = null;
  ensureSel();
  return S.items.length;
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

const isWebTab = (tab) => /^https?:\/\//i.test(tab?.url || '');

/** The tab's site as a search: its registrable domain, so "accounts.google.com" also finds google.com logins. */
function siteQueryOf(tab) {
  if (!isWebTab(tab)) return '';
  const host = hostnameOf(tab.url);
  return host ? registrableDomain(host) || host.replace(/^www\./, '') : '';
}

/** Autofill matches for the tab, or null. Does not touch state. */
async function fetchAutofill(tabP) {
  const tab = await tabP;
  if (!tab?.id || !isWebTab(tab)) return null;
  try {
    const res = await call(MSG.AUTOFILL_MATCHES, { tabId: tab.id });
    if (!res?.items?.length) return null;
    const url = res.url || tab.url;
    return { tabId: tab.id, url, site: siteOf(url), items: res.items, state: 'idle' };
  } catch {
    return null;
  }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/** Used by the gate after unlock/setup and on reload: items + autofill matches.
 *  `onDecrypted(vaults)` fires once vault/getAll returned (the gate's boot log). */
async function loadAll({ onDecrypted } = {}) {
  const token = S.epoch;
  let rendered = false;
  S.af = null;
  S.siteQuery = '';
  const tab = activeTab();
  const site = tab.then((t) => { if (S.epoch === token) S.siteQuery = siteQueryOf(t); });
  // matches that arrive after the first render are added to the list then
  const af = fetchAutofill(tab).then((res) => {
    if (S.epoch !== token) return;
    S.af = res;
    if (rendered && res && S.phase === 'main') renderList();
  });
  const [count] = await Promise.all([loadData(onDecrypted), withTimeout(af, 800), site]);
  rendered = true;
  return count;
}

/** Re-query matches after an edit (a saved URL may now match the tab, or no longer). */
async function refreshAutofill() {
  const token = liveToken();
  const res = await fetchAutofill(activeTab());
  if (!live(token) || (S.af && S.af.state !== 'idle')) return;
  S.af = res;
  renderList();
}

/* ───────── main view ───────── */

function renderVaultLabel() {
  const v = S.vaults.find((x) => x.id === S.vault);
  const all = S.vault === 'all' || !v;
  $('vaultLabel').textContent = all ? 'すべて' : v.name;
  $('vaultDot').style.background = all ? 'var(--accent)' : vaultColor(v.hue);
}

/** The list bar: the 表示 chip and the sort toggle. */
function renderFilters() {
  renderViewButton();
  const sort = S.sort === 'az' ? 'A-Z' : '新着';
  $('sortBtn').textContent = sort;
  $('sortBtn').title = $('sortBtn').ariaLabel = `並び替え: ${sort}（クリックで切り替え）`;
}

/** Status bar dot: 保存中… while a change is on its way to the encrypted store. */
function renderSaving(saving) {
  const el = $('stSave');
  el.dataset.state = saving ? 'saving' : 'saved';
  $('stSaveText').textContent = saving ? '保存中…' : '保存済み';
}

/**
 * Open on the tab's site as if the user had typed it, but only when that finds something
 * (an empty list on every other site would be in the way). Esc or the clear button undoes it.
 */
function prefillSiteQuery() {
  const q = S.siteQuery;
  if (!q || S.query) return;
  S.query = q;
  if (!visibleItems().length) {
    S.query = '';
    return;
  }
  $('search').value = q;
  $('searchClear').hidden = false;
  $('searchKey').hidden = true;
  ensureSel();
}

function enterMain({ animate = true } = {}) {
  S.phase = 'main';
  app.dataset.phase = 'main';
  prefillSiteQuery();
  renderVaultLabel();
  renderFilters();
  renderList({ animate });
  renderDetail({ animate });
  ping(true);
  startStatusPoll();
}

/** Rebuild list (and detail if the selection moved) after the visible set changed. */
function refreshList({ animate = false } = {}) {
  const moved = ensureSel();
  renderList({ animate, keepScroll: !animate });
  if (moved && !editorOpen()) renderDetail({ animate: true });
  else if (S.picking) renderPicker(); // the count of rows to "select all" may have changed
}

/* ───────── selection (delete several) ───────── */

let pickAnchor = null; // the row last checked or unchecked: Shift+click spans from here

function renderPickMode() {
  app.toggleAttribute('data-picking', S.picking);
  $('pickBtn').setAttribute('aria-pressed', String(S.picking));
}

function enterPicking() {
  closeMenus();
  S.picking = true;
  S.picked = new Set();
  pickAnchor = null;
  resetPicker();
  renderPickMode();
}

/** The 選択 button, Esc: switch selection mode on or off. */
function setPicking(on) {
  if (on === S.picking) return;
  if (on && editorOpen()) {
    requestClose(() => setPicking(true));
    return;
  }
  if (on) {
    enterPicking();
  } else {
    S.picking = false;
    S.picked = new Set();
    pickAnchor = null;
    resetPicker();
    renderPickMode();
  }
  renderList({ keepScroll: true });
  renderDetail({ animate: true });
}

/** Check or uncheck a row; `range` (Shift) checks every row from the last one clicked. */
function pick(id, { range = false } = {}) {
  const entering = !S.picking;
  if (entering) {
    if (editorOpen()) {
      requestClose(() => pick(id, { range }));
      return;
    }
    const from = range ? S.sel : null; // Shift+click from the normal view spans from the open item
    enterPicking();
    pickAnchor = from;
  }
  const vis = visibleItems();
  const at = vis.findIndex((i) => i.id === id);
  if (at < 0) return;
  const from = range && pickAnchor ? vis.findIndex((i) => i.id === pickAnchor) : -1;
  if (from >= 0) {
    const [a, b] = from < at ? [from, at] : [at, from];
    for (let i = a; i <= b; i++) S.picked.add(vis[i].id);
  } else if (S.picked.has(id)) {
    S.picked.delete(id);
  } else {
    S.picked.add(id);
  }
  pickAnchor = id;
  S.sel = id;
  resetPicker();
  if (entering) {
    renderList({ keepScroll: true });
    renderDetail({ animate: true });
  } else {
    markSelected();
    renderPicker();
  }
}

/** Check every visible row (Ctrl+A, すべて選択), or none. */
function pickAll(all) {
  if (!S.picking) {
    if (editorOpen()) return;
    enterPicking();
    renderList({ keepScroll: true });
  }
  S.picked = new Set(all ? visibleItems().map((i) => i.id) : []);
  resetPicker();
  markSelected();
  renderDetail();
}

async function deletePicked() {
  const ids = visibleItems().filter((i) => S.picked.has(i.id)).map((i) => i.id);
  if (!ids.length) return;
  const token = liveToken();
  setPickerBusy(true);
  try {
    const res = await call(MSG.VAULT_DELETE_ITEMS, { ids });
    if (!live(token)) return;
    const first = visibleItems().findIndex((i) => S.picked.has(i.id));
    removeItems(ids);
    S.picking = false;
    S.picked = new Set();
    pickAnchor = null;
    resetPicker();
    renderPickMode();
    const rest = visibleItems();
    S.sel = rest[Math.min(Math.max(first, 0), rest.length - 1)]?.id || S.items[0]?.id || null;
    renderList({ animate: true });
    renderDetail({ animate: true });
    toast(`${Number(res?.deleted) || ids.length} 件を削除しました`);
  } catch (e) {
    if (!live(token)) return;
    resetPicker();
    renderPicker();
    toastError('削除できませんでした', errText(e));
    if (e?.code === ERR.NOT_FOUND) emit('reload'); // deleted elsewhere meanwhile: show what is left
  }
}

function select(id, { scroll = false } = {}) {
  if (!id) return;
  if (editorOpen()) {
    requestClose(() => doSelect(id, scroll, true));
    return;
  }
  doSelect(id, scroll, false);
}

function doSelect(id, scroll, force) {
  if (id === S.sel && !force) return;
  S.sel = id;
  markSelected();
  if (!S.picking) renderDetail({ animate: true }); // in selection mode ↑↓ only move the keyboard row
  if (scroll) setTimeout(() => scrollToRow(id), 0);
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
  $('search').value = '';
  $('searchClear').hidden = true;
  $('searchKey').hidden = false;
  pickAnchor = null;
  resetPicker();
  renderPickMode(); // clearSecrets left selection mode
  renderCounts(0);
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
  S.phase = 'locked';
  S.epoch++;
  app.dataset.phase = 'locked';
  clearInterval(statusTimer);
  closeMenus();
  closeGenerator();
  closeSettings();
  closeEditor();
  stopDetail();
  wipeView();
  showGate('lock');
  if (!remote) await lockService();
}

/* ───────── menus ───────── */

const MENUS = { vault: ['vaultBtn', 'vaultMenu'], plus: ['plusBtn', 'plusMenu'], type: ['typeBtn', 'typeMenu'] };

function closeMenus() {
  for (const [btn, menu] of Object.values(MENUS)) {
    $(menu).classList.remove('open');
    $(btn).setAttribute('aria-expanded', 'false');
  }
  $('catcher').classList.remove('on');
}

/** The open menu's key ('vault' | 'plus' | 'type'), or null. */
const openMenuKey = () => Object.keys(MENUS).find((k) => $(MENUS[k][1]).classList.contains('open')) || null;
const menuOpen = () => !!openMenuKey();

function openMenu(which) {
  const [btn, menu] = MENUS[which].map($);
  const wasOpen = menu.classList.contains('open');
  closeMenus();
  if (wasOpen) return;
  if (which === 'vault') renderVaultMenu();
  if (which === 'plus') resetPlusMenu(menu);
  if (which === 'type') {
    renderTypeFilterMenu();
    // under the 種類 button, but never past the bottom of the 430px popup
    menu.style.maxHeight = '';
    const below = btn.getBoundingClientRect().bottom - app.getBoundingClientRect().top + 4;
    const top = Math.max(48, Math.min(below, app.clientHeight - menu.offsetHeight - 6));
    menu.style.top = top + 'px';
    menu.style.maxHeight = app.clientHeight - top - 6 + 'px';
  }
  menu.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  $('catcher').classList.add('on');
  const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
  setTimeout(() => first?.focus({ preventScroll: true }), 0);
}

function renderVaultMenu() {
  const box = $('vaultItems');
  clear(box);
  const entries = [{ id: 'all', name: 'すべての保管庫', count: S.items.length, color: 'var(--accent)' }]
    .concat(S.vaults.map((v) => ({ id: v.id, name: v.name, count: S.items.filter((i) => i.vault === v.id).length, color: vaultColor(v.hue) })));
  for (const v of entries) {
    const on = S.vault === v.id;
    box.append(h('button', {
      class: 'menu-item vault-opt', type: 'button', role: 'menuitemradio', 'aria-checked': String(on),
      onclick: () => setVault(v.id),
    },
    h('span', { class: 'swatch', vars: { '--sw': v.color } }),
    h('span', { class: 'grow' }, v.name),
    h('span', { class: 'v-count' }, String(v.count)),
    h('span', { class: 'v-mark', 'aria-hidden': 'true' }, on ? '✓' : '')));
  }
}

function setVault(id) {
  closeMenus();
  $('vaultBtn').focus({ preventScroll: true });
  if (S.vault === id) return;
  S.vault = id;
  saveUi();
  renderVaultLabel();
  refreshList({ animate: true });
}

/* 表示: one filter for the list, a view (すべて / 最近 / お気に入り) or a type */

function renderTypeFilterMenu() {
  renderViewMenu($('typeMenu'), { counts: viewCounts(), current: currentView(), onPick: setView });
}

function setView(id) {
  closeMenus();
  $('typeBtn').focus({ preventScroll: true });
  const filter = id === 'recent' || id === 'fav' ? id : 'all';
  const type = filter === 'all' && id !== 'all' && typeOf(id) ? id : 'all';
  if (S.filter === filter && S.type === type) return;
  S.filter = filter;
  S.type = type;
  saveUi();
  renderFilters();
  refreshList({ animate: true });
}

function menuKeys(e) {
  if (e.isComposing || e.keyCode === 229) return;
  const menu = e.currentTarget;
  if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    if (moveMenuFocus(menu, e.key)) e.preventDefault();
    return;
  }
  // the + menu's L / N / C / I / O / G shortcuts (only on the panel that is showing)
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  const hit = [...menu.querySelectorAll('button[data-key]')].find((b) => b.dataset.key === e.key.toLowerCase() && b.offsetParent !== null);
  if (hit) {
    e.preventDefault();
    hit.click();
  }
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

/* ───────── autofill ───────── */

async function doAutofill() {
  if (!S.af || S.af.state !== 'idle') return;
  // exactly the account the card shows (vault filter applied)
  const target = afCandidate();
  if (!target) return;
  const { tabId, site } = S.af;
  const token = liveToken();
  setAfState('run');
  const t0 = performance.now();
  try {
    const res = await call(MSG.AUTOFILL_FILL, { tabId, itemId: target.id });
    const left = 450 - (performance.now() - t0);
    if (left > 0) await wait(left);
    if (!live(token)) return;
    if (!res?.filled) {
      setAfState('idle');
      toastError('入力欄が見つかりませんでした', 'ページを確認してもう一度お試しください');
      return;
    }
    setAfState('done');
    burst(app, afButtonEl());
    toast(`${site} に自動入力しました`, 'ユーザー名とパスワードを入力');
    const local = itemById(target.id);
    if (local) replaceItem({ ...local, lastUsedAt: Date.now() });
    setTimeout(() => window.close(), 700);
  } catch (e) {
    if (!live(token)) return;
    setAfState('idle');
    toastError('自動入力できませんでした', errText(e));
  }
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

/* ───────── keyboard ───────── */

function onKey(e) {
  // keys that confirm/cancel Japanese IME conversion must not trigger shortcuts
  if (e.isComposing || e.keyCode === 229) return;
  if (S.phase !== 'main' || gateOpen()) return;
  const ae = document.activeElement;
  const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
  const search = $('search');

  if (e.key === 'Escape') {
    if (isGenOpen()) { closeGenerator(); e.preventDefault(); return; }
    if (isSettingsOpen()) { closeSettings(); e.preventDefault(); return; }
    if (menuOpen()) {
      const which = openMenuKey();
      closeMenus();
      $(MENUS[which][0]).focus();
      e.preventDefault();
      return;
    }
    if (editorOpen()) { requestClose(); e.preventDefault(); return; }
    if (S.picking && pickerConfirming()) { resetPicker(); renderPicker(); e.preventDefault(); return; }
    // In the search box Esc clears the query first; otherwise it leaves selection mode.
    if (S.picking && !(ae === search && S.query)) { setPicking(false); e.preventDefault(); return; }
    if (S.query) { setQuery(''); e.preventDefault(); return; }
    if (typing) ae.blur();
    return;
  }
  if (isGenOpen() || isSettingsOpen() || menuOpen()) return;
  if (e.key === '/' && !typing) {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }
  if (editorOpen()) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && !typing) {
    e.preventDefault();
    pickAll(true);
    return;
  }
  if (S.picking && !typing) {
    if (e.key === ' ' && !(ae && ae.tagName === 'BUTTON')) {
      e.preventDefault();
      if (S.sel) pick(S.sel);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      askDelete();
      return;
    }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (typing && ae !== search) return;
    const v = visibleItems();
    if (!v.length) return;
    e.preventDefault();
    let i = v.findIndex((x) => x.id === S.sel);
    i = e.key === 'ArrowDown' ? Math.min(v.length - 1, i + 1) : Math.max(0, i - 1);
    select(v[i].id, { scroll: true });
    return;
  }
  if (e.key === 'Enter') {
    if (typing && ae !== search) return;
    if (ae && (ae.tagName === 'BUTTON' || ae.tagName === 'A')) return;
    if (S.picking) return; // no password copy while choosing what to delete
    const target = primarySecret(itemById(S.sel));
    if (!target) return;
    e.preventDefault();
    if (typing) ae.blur();
    copyText(target.field, target.value, target.opts);
  }
}

/** What ⏎ copies: a login's password, or the first filled single-line secret of a templated item. */
function primarySecret(it) {
  if (!it) return null;
  if (it.type === 'login') return it.password ? { field: 'pass', value: it.password } : null;
  if (!hasTemplate(it.type)) return null;
  for (const fd of typeOf(it.type).fields) {
    const v = it.fields?.[fd.key];
    if (fd.kind !== 'secret' || !v) continue;
    const value = fd.format === 'card' ? String(v).replace(/\D/g, '') : String(v);
    return { field: fd.key, value, opts: { label: fieldLabel(it.type, fd.key), secret: true } };
  }
  return null;
}

/* ───────── search ───────── */

function setQuery(q) {
  S.query = q;
  const input = $('search');
  if (input.value !== q) input.value = q;
  $('searchClear').hidden = !q;
  $('searchKey').hidden = !!q;
  refreshList();
}

/* ───────── wiring ───────── */

function wire() {
  $('vaultBtn').addEventListener('click', () => openMenu('vault'));
  $('plusBtn').addEventListener('click', () => openMenu('plus'));
  $('typeBtn').addEventListener('click', () => openMenu('type'));
  $('pickBtn').addEventListener('click', () => setPicking(!S.picking));
  $('catcher').addEventListener('click', closeMenus);
  $('vaultMenu').addEventListener('keydown', menuKeys);
  $('plusMenu').addEventListener('keydown', menuKeys);
  $('typeMenu').addEventListener('keydown', menuKeys);
  $('openSettings').addEventListener('click', () => { closeMenus(); openSettings(); });
  $('manageVaults').addEventListener('click', () => { closeMenus(); openSettings({ page: 'vaults' }); });
  buildPlusMenu($('plusMenu'), { onNew: newItem, onGen: () => { closeMenus(); openGenerator({}); } });
  $('plusMenu').setAttribute('aria-label', t('menu.new', null, '新規作成'));
  $('typeMenu').setAttribute('aria-label', t('list.viewMenu', null, '表示するアイテム'));
  renderViewButton();
  $('lockBtn').addEventListener('click', () => lockNow());
  $('scrim').addEventListener('click', () => { closeGenerator(); closeSettings(); });

  const search = $('search');
  search.addEventListener('input', () => setQuery(search.value));
  $('searchClear').addEventListener('click', (e) => {
    e.preventDefault();
    setQuery('');
    search.focus();
  });

  $('sortBtn').addEventListener('click', () => {
    S.sort = S.sort === 'az' ? 'recent' : 'az';
    saveUi();
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
  on('listChanged', () => { if (S.phase === 'main') refreshList(); });
  on('passwordPending', (id) => {
    if (S.phase !== 'main') return;
    S.sel = id;
    renderList();
    renderDetail({ animate: true });
    toast('新しいパスワードを保留してコピーしました', 'サイトで変更してから「確定」を押してください');
  });
  on('passwordUpdated', (id, info) => {
    if (S.phase !== 'main') return;
    S.sel = id;
    renderList();
    showPasswordUpdated(id, info);
  });
  on('saved', (item, isNew) => {
    if (S.phase !== 'main') return;
    replaceItem(item);
    S.sel = item.id;
    if (!visibleItems().some((i) => i.id === item.id)) {
      // make sure the saved item is visible
      S.filter = 'all';
      if (S.type !== 'all' && S.type !== item.type) S.type = 'all';
      S.query = '';
      $('search').value = '';
      $('searchClear').hidden = true;
      $('searchKey').hidden = false;
      if (S.vault !== 'all' && S.vault !== item.vault) S.vault = 'all';
      saveUi();
      renderVaultLabel();
      renderFilters();
    }
    renderList();
    renderDetail({ animate: true });
    setTimeout(() => scrollToRow(item.id), 0);
    toast(isNew ? `${item.title} を追加しました` : `${item.title} を保存しました`, isNew ? null : '変更は暗号化して保存されました');
    refreshAutofill();
  });
  on('deleted', (id, title) => {
    if (S.phase !== 'main') return;
    const vis = visibleItems();
    const idx = vis.findIndex((i) => i.id === id);
    removeItem(id);
    if (S.af) {
      S.af.items = S.af.items.filter((m) => m.id !== id);
      if (!S.af.items.length) S.af = null;
    }
    const rest = visibleItems();
    S.sel = rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.id || S.items[0]?.id || null;
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
    if (S.vault !== 'all' && !S.vaults.some((v) => v.id === S.vault)) S.vault = 'all';
    saveUi();
    renderVaultLabel();
    refreshList();
    renderDetail();
  });
  on('settingsChanged', (key) => {
    if (key === 'autoLockMinutes') ping(true);
  });
  on('saving', renderSaving);

  initGenerator();
  initSettings();
  initGate({ load: loadAll, enter: () => enterMain({ animate: true }) });
}

async function boot() {
  wire();
  const settingsP = loadSettings();
  let status;
  try {
    status = await send(MSG.VAULT_STATUS);
  } catch (e) {
    await settingsP;
    showGate('lock', { instant: true });
    $('lockStatus').textContent = 'Akari のサービスに接続できませんでした';
    $('lockStatus').classList.add('err');
    return;
  }
  await settingsP;
  if (!status?.initialized) {
    S.phase = 'setup';
    app.dataset.phase = 'setup';
    showGate('setup', { instant: true });
    return;
  }
  if (status.locked) {
    S.phase = 'locked';
    app.dataset.phase = 'locked';
    showGate('lock', { instant: true });
    return;
  }
  try {
    await loadAll();
    enterMain({ animate: true });
  } catch {
    S.phase = 'locked';
    app.dataset.phase = 'locked';
    showGate('lock', { instant: true });
  }
}

boot();
