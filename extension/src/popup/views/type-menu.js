// The two type palettes (design 1a): ＋ 新規作成 with every item type, and the 種類 filter
// with the types present in the vault and their counts. Both are grouped by GROUPS into
// 3-column grids under a `$ akari …` line that follows focus. Built from static type
// metadata only; counts are numbers.

import { GROUPS, ITEM_TYPES, typeLabel, groupLabel } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { h, clear, icon } from './dom.js';

// single-letter shortcuts inside the ＋ menu (and the welcome commands)
const KEYS = { login: 'l', note: 'n' };

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
 * ＋ menu: 新規作成 for every type, then パスワード生成. Static, so it is built once.
 * Ids #newLogin / #newNote / #newGen and the L / N / G keys are kept from the old menu.
 */
export function buildPlusMenu(menu, { onNew, onGen }) {
  clear(menu);
  const cmd = cmdLine('new login');
  menu.append(cmd.el);
  for (const g of GROUPS) {
    const types = ITEM_TYPES.filter((x) => x.group === g.id);
    if (!types.length) continue;
    const grid = h('div', { class: 'tp-grid', role: 'group', 'aria-label': groupLabel(g.id) });
    for (const ty of types) {
      const key = KEYS[ty.id];
      grid.append(h('button', {
        class: 'tp-cell', type: 'button', role: 'menuitem',
        id: ty.id === 'login' ? 'newLogin' : ty.id === 'note' ? 'newNote' : null,
        dataset: { type: ty.id, cmd: `new ${ty.id}`, ...(key ? { key } : {}) },
        'aria-keyshortcuts': key ? key.toUpperCase() : null,
        'aria-label': t('menu.newType', { type: typeLabel(ty.id) }, '新規 {type}'),
        onclick: () => onNew(ty.id),
      },
      h('span', { class: 'tp-name' }, typeLabel(ty.id)),
      tagShown(ty.id) ? h('span', { class: 'tag' }, ty.tag) : null,
      key ? h('span', { class: 'menu-key', 'aria-hidden': 'true' }, key.toUpperCase()) : null));
    }
    menu.append(groupHead(g.id), grid);
  }
  menu.append(h('div', { class: 'menu-sep', role: 'separator' }),
    h('button', {
      id: 'newGen', class: 'menu-item', type: 'button', role: 'menuitem', dataset: { key: 'g', cmd: 'gen' }, 'aria-keyshortcuts': 'G',
      onclick: onGen,
    }, h('span', { class: 'menu-ico' }, icon('regen', 14)), h('span', { class: 'grow' }, t('menu.generator', null, 'パスワード生成')),
    h('span', { class: 'menu-key', 'aria-hidden': 'true' }, 'G')));
  followCmd(menu, cmd, () => 'new login');
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
