// The header and list-bar menus: ≡ メニュー (main: パスワード診断, ゴミ箱, 保管庫を管理, 設定), 保管庫 (vault),
// ＋ 新規作成 (plus) and 表示 (type), with the keyboard inside an open menu.

import { typeOf } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { S, setVaultFilter, setListView, healthCounts } from '../state.js';
import { h, clear } from '../views/dom.js';
import { vaultColor } from '../views/format.js';
import { resetPlusMenu, renderViewMenu, moveMenuFocus } from '../views/type-menu.js';
import { viewCounts, currentView } from '../views/list.js';
import { renderVaultLabel, renderFilters, refreshList } from './view.js';

const $ = (id) => document.getElementById(id);

export const MENUS = {
  main: ['menuBtn', 'mainMenu'], vault: ['vaultBtn', 'vaultMenu'], plus: ['plusBtn', 'plusMenu'], type: ['typeBtn', 'typeMenu'],
};

export function closeMenus() {
  for (const [btn, menu] of Object.values(MENUS)) {
    $(menu).classList.remove('open');
    $(btn).setAttribute('aria-expanded', 'false');
  }
  $('catcher').classList.remove('on');
}

/** The open menu's key ('main' | 'vault' | 'plus' | 'type'), or null. */
export const openMenuKey = () => Object.keys(MENUS).find((k) => $(MENUS[k][1]).classList.contains('open')) || null;
export const menuOpen = () => !!openMenuKey();

export function openMenu(which) {
  const app = $('app');
  const [btn, menu] = MENUS[which].map($);
  const wasOpen = menu.classList.contains('open');
  closeMenus();
  if (wasOpen) return;
  if (which === 'main') renderMainMenu();
  if (which === 'vault') renderVaultMenu();
  if (which === 'plus') resetPlusMenu(menu);
  if (which === 'type') {
    renderTypeFilterMenu();
    // under the 種類 button, but never past the bottom of the 480px popup
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
  const entries = [{ id: 'all', name: t('すべての保管庫'), count: S.items.length, color: 'var(--accent)' }]
    .concat(S.vaults.map((v) => ({ id: v.id, name: v.name, count: S.items.filter((i) => i.vault === v.id).length, color: vaultColor(v.hue) })));
  for (const v of entries) {
    const on = S.vault === v.id;
    box.append(h('button', {
      class: 'menu-item vault-opt', type: 'button', role: 'menuitemradio', 'aria-checked': String(on),
      onclick: () => chooseVault(v.id),
    },
    h('span', { class: 'swatch', vars: { '--sw': v.color } }),
    h('span', { class: 'grow' }, v.name),
    h('span', { class: 'v-count' }, String(v.count)),
    h('span', { class: 'v-mark', 'aria-hidden': 'true' }, on ? '✓' : '')));
  }
}

/** ≡ メニュー: パスワード診断 shows how many logins in the current vault need action. */
function renderMainMenu() {
  const n = healthCounts().action;
  $('healthCount').textContent = String(n);
  $('openHealth').setAttribute('aria-label', t('menu.health', { count: n }, 'パスワード診断（要対応 {count} 件）'));
  const tn = S.trash.length;
  $('trashCount').textContent = String(tn);
  $('openTrash').setAttribute('aria-label', t('menu.trash', { count: tn }, 'ゴミ箱（{count} 件）'));
}

function chooseVault(id) {
  closeMenus();
  $('vaultBtn').focus({ preventScroll: true });
  if (S.vault === id) return;
  setVaultFilter(id);
  renderVaultLabel();
  refreshList({ animate: true });
}

/* 表示: one filter for the list, a view (すべて / 最近 / お気に入り) or a type */

function renderTypeFilterMenu() {
  renderViewMenu($('typeMenu'), { counts: viewCounts(), current: currentView(), onPick: chooseView });
}

/** Show a view ('all' | 'recent' | 'fav') or a type id. */
function chooseView(id) {
  closeMenus();
  $('typeBtn').focus({ preventScroll: true });
  const filter = id === 'recent' || id === 'fav' ? id : 'all';
  const type = filter === 'all' && id !== 'all' && typeOf(id) ? id : 'all';
  if (S.filter === filter && S.type === type) return;
  setListView(filter, type);
  renderFilters();
  refreshList({ animate: true });
}

export function menuKeys(e) {
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
