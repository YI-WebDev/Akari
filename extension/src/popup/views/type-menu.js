// The two type menus (design 1a), each under a `$ akari …` line that follows focus:
// ＋ 新規作成 lists the 基本 types with icons and opens the other groups in a second panel,
// and the 種類 filter shows the types present in the vault, with counts, as 3-column grids
// grouped by GROUPS. Built from static type metadata only; counts are numbers.

import { GROUPS, ITEM_TYPES, typeLabel, groupLabel } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { h, clear, icon } from './dom.js';

// single-letter shortcuts in the ＋ menu's first panel (L / N also in the welcome commands)
const KEYS = { login: 'l', note: 'n', card: 'c', identity: 'i' };

// Icon per type, and tile hues (oklch): one per 基本 type, one per group in the その他 panel.
const TYPE_ICONS = {
  login: 'login', note: 'note', card: 'card', identity: 'idCard',
  apiCredential: 'code', database: 'database', server: 'server', softwareLicense: 'badge', sshKey: 'terminal', wifi: 'wifi',
  bankAccount: 'bank', cryptoWallet: 'wallet',
  driverLicense: 'car', medicalRecord: 'medical', membership: 'users', passport: 'passport', rewardProgram: 'gift', socialSecurity: 'shieldUser',
};
const HUES = { login: 45, note: 85, card: 150, identity: 255, gen: 350, tech: 210, finance: 150, personal: 300 };

/** A coloured icon tile; without a hue it is greyed (その他). */
function tileIcon(name, hue, size) {
  const vars = hue == null ? { '--tile-c': '0.02', '--tile-bg-c': '0.02' } : { '--h': String(hue) };
  return h('span', { class: 'tile pm-tile', vars, 'aria-hidden': 'true' }, icon(name, size));
}

function cmdLine(initial) {
  const arg = h('span', { class: 'tp-arg' }, initial);
  const el = h('div', { class: 'tp-cmd', 'aria-hidden': 'true' }, h('span', { class: 'ps' }, '$ '), 'akari ', arg, h('span', { class: 'cursor' }));
  return { el, set: (s) => { arg.textContent = s; } };
}

/** The command line follows the focused / hovered cell (data-cmd). */
function followCmd(menu, cmd, fallback) {
  const show = (e) => {
    const b = e.target.closest?.('[data-cmd]');
    cmd.set(b && menu.contains(b) ? b.dataset.cmd : fallback());
  };
  menu.addEventListener('focusin', show);
  menu.addEventListener('pointerover', show);
  menu.addEventListener('pointerleave', () => {
    const b = menu.contains(document.activeElement) ? document.activeElement.closest('[data-cmd]') : null;
    cmd.set(b ? b.dataset.cmd : fallback());
  });
}

/** The mono tag next to a type's name, unless the name already says it (ID, API認証情報, SSHキー, WiFi…). */
export function tagShown(id) {
  const tag = ITEM_TYPES.find((x) => x.id === id)?.tag;
  return !!tag && !typeLabel(id).toLowerCase().includes(tag.toLowerCase());
}

function groupHead(groupId, count) {
  return h('div', { class: 'tp-group', role: 'presentation' },
    h('span', null, groupLabel(groupId)), h('span', { class: 'group-line' }), count != null ? h('span', null, String(count)) : null);
}

/**
 * ＋ menu. First panel: the 基本 types, その他 (#newOther), パスワード生成. その他 swaps in
 * the other groups as 2-column grids under a back button; Esc / Backspace / ← on the back
 * button return. Static, so it is built once; resetPlusMenu shows the first panel again.
 * Ids #newLogin / #newNote / #newGen and the L / N / G keys are kept from the old menu.
 */
export function buildPlusMenu(menu, { onNew, onGen }) {
  clear(menu);
  const cmd = cmdLine('new login');
  const keyHint = (key) => h('span', { class: 'menu-key', 'aria-hidden': 'true' }, key.toUpperCase());
  const item = (ty, hue, size) => {
    const key = ty.group === 'basic' ? KEYS[ty.id] : null;
    return h('button', {
      class: 'pm-item', type: 'button', role: 'menuitem',
      id: ty.id === 'login' ? 'newLogin' : ty.id === 'note' ? 'newNote' : null,
      dataset: { type: ty.id, cmd: `new ${ty.id}`, ...(key ? { key } : {}) },
      'aria-keyshortcuts': key ? key.toUpperCase() : null,
      'aria-label': t('menu.newType', { type: typeLabel(ty.id) }, '新規 {type}'),
      onclick: () => onNew(ty.id),
    }, tileIcon(TYPE_ICONS[ty.id], hue, size), h('span', { class: 'pm-name' }, typeLabel(ty.id)), key ? keyHint(key) : null);
  };

  const otherLabel = t('menu.other', null, 'その他');
  const others = ITEM_TYPES.filter((x) => x.group !== 'basic');
  const otherBtn = h('button', {
    id: 'newOther', class: 'pm-item', type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    dataset: { key: 'o', cmd: 'new --help' }, 'aria-keyshortcuts': 'O',
    onclick: () => show('more'),
  }, tileIcon('more', null, 14), h('span', { class: 'pm-name' }, otherLabel), h('span', { class: 'v-count' }, String(others.length)), icon('chevRight', 12));
  const main = h('div', { class: 'pm-panel pm-main' },
    h('div', { role: 'group', 'aria-label': groupLabel('basic'), class: 'pm-list' },
      ...ITEM_TYPES.filter((x) => x.group === 'basic').map((ty) => item(ty, HUES[ty.id], 15)), otherBtn),
    h('div', { class: 'menu-sep', role: 'separator' }),
    h('button', {
      id: 'newGen', class: 'pm-item', type: 'button', role: 'menuitem', dataset: { key: 'g', cmd: 'gen' }, 'aria-keyshortcuts': 'G',
      onclick: onGen,
    }, tileIcon('key', HUES.gen, 15), h('span', { class: 'pm-name' }, t('menu.generator', null, 'パスワード生成')), keyHint('g')));

  const back = h('button', {
    class: 'pm-back', type: 'button', role: 'menuitem', dataset: { cmd: 'new' }, 'aria-label': t('menu.back', null, '戻る'),
    onclick: () => show('main', otherBtn),
  }, icon('chevLeft', 12), h('span', null, otherLabel));
  const more = h('div', { class: 'pm-panel pm-more', role: 'group', 'aria-label': otherLabel }, back);
  for (const g of GROUPS) {
    const types = others.filter((x) => x.group === g.id);
    if (!types.length) continue;
    more.append(groupHead(g.id), h('div', { class: 'tp-grid', role: 'group', 'aria-label': groupLabel(g.id) },
      ...types.map((ty) => item(ty, HUES[g.id], 13))));
  }

  const show = (panel, focus) => {
    menu.dataset.panel = panel;
    otherBtn.setAttribute('aria-expanded', String(panel === 'more'));
    (focus || (panel === 'more' ? more : main).querySelector('.pm-item')).focus({ preventScroll: true });
  };
  menu.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const at = document.activeElement;
    if (menu.dataset.panel !== 'more') {
      if (e.key === 'ArrowRight' && at === otherBtn) { e.preventDefault(); show('more'); }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace' || (e.key === 'ArrowLeft' && at === back)) {
      e.preventDefault();
      e.stopPropagation(); // Esc goes back a panel instead of closing the menu
      show('main', otherBtn);
    }
  });
  menu.append(cmd.el, main, more);
  resetPlusMenu(menu);
  followCmd(menu, cmd, () => 'new');
}

/** Back to the ＋ menu's first panel (before it opens). */
export function resetPlusMenu(menu) {
  menu.dataset.panel = 'main';
  menu.querySelector('#newOther')?.setAttribute('aria-expanded', 'false');
}

/**
 * 種類 filter menu: すべての種類, then the types that have items in the current vault
 * (and the chosen one), grouped, each with its count.
 */
export function renderTypeMenu(menu, { counts, total, current, onPick }) {
  clear(menu);
  const lsOf = (id) => (id === 'all' ? 'ls' : `ls --type ${id}`);
  const cmd = cmdLine(lsOf(current));
  const mark = (on) => h('span', { class: 'v-mark', 'aria-hidden': 'true' }, on ? '✓' : '');
  const cell = (id, name, count, extraClass = '') => h('button', {
    class: ('tp-cell ' + extraClass).trim(), type: 'button', role: 'menuitemradio', 'aria-checked': String(current === id),
    dataset: { type: id, cmd: lsOf(id) },
    'aria-label': t('menu.typeCount', { type: name, count }, '{type} {count} 件'),
    onclick: () => onPick(id),
  }, h('span', { class: 'tp-name' }, name), h('span', { class: 'v-count' }, String(count)), mark(current === id));

  const head = h('div', { class: 'tp-top' }, cmd.el,
    cell('all', t('list.allTypes', null, 'すべての種類'), total, 'tp-all'));
  menu.append(head);
  for (const g of GROUPS) {
    const types = ITEM_TYPES.filter((x) => x.group === g.id && ((counts.get(x.id) || 0) > 0 || x.id === current));
    if (!types.length) continue;
    const grid = h('div', { class: 'tp-grid', role: 'group', 'aria-label': groupLabel(g.id) });
    let sum = 0;
    for (const ty of types) {
      const n = counts.get(ty.id) || 0;
      sum += n;
      grid.append(cell(ty.id, typeLabel(ty.id), n, n ? '' : 'zero'));
    }
    menu.append(groupHead(g.id, sum), grid);
  }
  followCmd(menu, cmd, () => lsOf(current));
}

const navX = new WeakMap(); // menu → { x, el }: the column a run of ↑↓ started in

/**
 * Arrow keys inside an open menu: ↑↓ move to the nearest cell in the row above / below
 * (wrapping), ←→ step through grid cells, Home / End jump. Returns true when handled.
 */
export function moveMenuFocus(menu, key) {
  const items = [...menu.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent !== null);
  if (!items.length) return false;
  const cur = document.activeElement;
  const i = items.indexOf(cur);
  const go = (b) => { b.focus(); return true; };
  if (key === 'Home') return go(items[0]);
  if (key === 'End') return go(items[items.length - 1]);
  if (i < 0) return (key === 'ArrowDown' || key === 'ArrowUp') ? go(items[key === 'ArrowDown' ? 0 : items.length - 1]) : false;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (!cur.closest('.tp-grid, .tp-top')) return false;
    return go(items[(i + (key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]);
  }
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return false;
  const down = key === 'ArrowDown';
  const box = (b) => b.getBoundingClientRect();
  const r = box(cur);
  // keep the column through short rows (セキュアノート ↓ ID ↓ データベース)
  const sticky = navX.get(menu);
  const cx = sticky && sticky.el === cur ? sticky.x : r.left + r.width / 2;
  const rows = items.map((b) => ({ b, r: box(b) }));
  const ahead = rows.filter((x) => (down ? x.r.top > r.top + 4 : x.r.top < r.top - 4));
  const pool = ahead.length ? ahead : rows; // wrap around
  const tops = pool.map((x) => x.r.top);
  const rowTop = down ? Math.min(...tops) : Math.max(...tops); // next row, or the far end when wrapping
  const row = pool.filter((x) => Math.abs(x.r.top - rowTop) < 4);
  row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx));
  navX.set(menu, { x: cx, el: row[0].b });
  return go(row[0].b);
}
