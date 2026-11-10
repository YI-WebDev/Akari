import { GROUPS, ITEM_TYPES, typeLabel, groupLabel } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { h, clear, icon, isComposing } from './dom.js';

const KEYS = { login: 'l', note: 'n', card: 'c', identity: 'i' };

export const TYPE_ICONS = {
  login: 'login', note: 'note', card: 'card', identity: 'idCard',
  apiCredential: 'code', database: 'database', server: 'server', softwareLicense: 'badge', sshKey: 'terminal', wifi: 'wifi',
  bankAccount: 'bank', cryptoWallet: 'wallet',
  driverLicense: 'car', medicalRecord: 'medical', membership: 'users', passport: 'passport', rewardProgram: 'gift', socialSecurity: 'shieldUser',
};
const HUES = { login: 45, note: 85, card: 150, identity: 255, gen: 350, tech: 210, finance: 150, personal: 300 };

function tileIcon(name, hue, size) {
  const vars = hue == null ? { '--tile-c': '0.02', '--tile-bg-c': '0.02' } : { '--h': String(hue) };
  return h('span', { class: 'tile pm-tile', vars, 'aria-hidden': 'true' }, icon(name, size));
}

function cmdLine(initial) {
  const arg = h('span', { class: 'tp-arg' }, initial);
  const el = h('div', { class: 'tp-cmd', 'aria-hidden': 'true' }, h('span', { class: 'ps' }, '$ '), 'akari ', arg, h('span', { class: 'cursor' }));
  return { el, set: (s) => { arg.textContent = s; } };
}

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

function groupHead(groupId, count) {
  return h('div', { class: 'tp-group', role: 'presentation' },
    h('span', null, groupLabel(groupId)), h('span', { class: 'group-line' }), count != null ? h('span', null, String(count)) : null);
}

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
    if (isComposing(e)) return;
    const at = document.activeElement;
    if (menu.dataset.panel !== 'more') {
      if (e.key === 'ArrowRight' && at === otherBtn) { e.preventDefault(); show('more'); }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace' || (e.key === 'ArrowLeft' && at === back)) {
      e.preventDefault();
      e.stopPropagation();
      show('main', otherBtn);
    }
  });
  menu.append(cmd.el, main, more);
  resetPlusMenu(menu);
  followCmd(menu, cmd, () => 'new');
}

export function resetPlusMenu(menu) {
  menu.dataset.panel = 'main';
  menu.querySelector('#newOther')?.setAttribute('aria-expanded', 'false');
}

const VIEWS = {
  all: ['list.viewAll', 'すべて', 'rows', ''],
  recent: ['list.viewRecent', '最近', 'clock', ' --recent'],
  fav: ['list.viewFav', 'お気に入り', 'star', ' --fav'],
};
export const isView = (id) => Object.hasOwn(VIEWS, id);
export const viewName = (id) => (isView(id) ? t(VIEWS[id][0], null, VIEWS[id][1]) : typeLabel(id));
export const viewIcon = (id) => (isView(id) ? VIEWS[id][2] : TYPE_ICONS[id] || 'note');

export function renderViewMenu(menu, { counts, current, onPick }) {
  clear(menu);
  const lsOf = (id) => (isView(id) ? 'ls' + VIEWS[id][3] : `ls --type ${id}`);
  const cmd = cmdLine(lsOf(current));
  const mark = (on) => h('span', { class: 'v-mark', 'aria-hidden': 'true' }, on ? icon('check', 10, 3) : null);
  const cell = (id, count, extraClass = '') => h('button', {
    class: ('tp-cell ' + extraClass).trim(), type: 'button', role: 'menuitemradio', 'aria-checked': String(current === id),
    dataset: { type: id, cmd: lsOf(id) },
    'aria-label': t('menu.typeCount', { type: viewName(id), count }, '{type} {count} 件'),
    onclick: () => onPick(id),
  }, h('span', { class: 'tp-ico', 'aria-hidden': 'true' }, icon(viewIcon(id), 12)),
  h('span', { class: 'tp-name' }, viewName(id)), h('span', { class: 'v-count' }, String(count)), mark(current === id));

  menu.append(h('div', { class: 'tp-top' }, cmd.el),
    h('div', { class: 'tp-grid tp-views', role: 'group', 'aria-label': t('list.views', null, '表示') },
      ...Object.keys(VIEWS).map((id) => cell(id, counts[id], counts[id] || id === 'all' ? '' : 'zero'))));
  for (const g of GROUPS) {
    const types = ITEM_TYPES.filter((x) => x.group === g.id && ((counts.types.get(x.id) || 0) > 0 || x.id === current));
    if (!types.length) continue;
    const grid = h('div', { class: 'tp-grid', role: 'group', 'aria-label': groupLabel(g.id) });
    let sum = 0;
    for (const ty of types) {
      const n = counts.types.get(ty.id) || 0;
      sum += n;
      grid.append(cell(ty.id, n, n ? '' : 'zero'));
    }
    menu.append(groupHead(g.id, sum), grid);
  }
  followCmd(menu, cmd, () => lsOf(current));
}

const navX = new WeakMap();
const SAME_ROW_PX = 4;

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
  const sticky = navX.get(menu);
  const cx = sticky && sticky.el === cur ? sticky.x : r.left + r.width / 2;
  const rows = items.map((b) => ({ b, r: box(b) }));
  const ahead = rows.filter((x) => (down ? x.r.top > r.top + SAME_ROW_PX : x.r.top < r.top - SAME_ROW_PX));
  const pool = ahead.length ? ahead : rows;
  const tops = pool.map((x) => x.r.top);
  const rowTop = down ? Math.min(...tops) : Math.max(...tops);
  const row = pool.filter((x) => Math.abs(x.r.top - rowTop) < SAME_ROW_PX);
  row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx));
  navX.set(menu, { x: cx, el: row[0].b });
  return go(row[0].b);
}
