// Right pane in selection mode (S.picking): what is checked, select all / none, and deleting
// the checked items after a confirmation. popup.js owns the mode; this file only draws it and
// reports the user's choice through the event bus ('pickAll', 'pickNone', 'pickExit', 'pickDelete').

import { S, emit, visibleItems } from '../state.js';
import { h, clear, icon } from './dom.js';
import { rise } from './fx.js';
import { typeLabel, subtitleOf } from '../../shared/item-types.js';
import { tileEl } from './list.js';

const SHOWN = 6; // names listed in the pane; the rest are counted

let confirming = false;
let busy = false;

/** Leave the "really delete?" step (selection changed, Esc, やめる). */
export function resetPicker() {
  confirming = false;
  busy = false;
}

export const pickerConfirming = () => confirming;

/** Ask before deleting (the Delete key, or the button). */
export function askDelete() {
  if (!S.picked.size || busy) return;
  confirming = true;
  renderPicker();
}

export function setPickerBusy(on) {
  busy = on;
  renderPicker();
}

/** Checked items in list order (the list keeps S.picked to visible rows). */
const pickedItems = (vis) => vis.filter((it) => S.picked.has(it.id));

function line(it) {
  return h('div', { class: 'pick-item' },
    tileEl(it, 'sm'),
    h('span', { class: 'pick-text' },
      h('span', { class: 'pick-title' }, it.title || '(無題)'),
      h('span', { class: 'pick-sub' }, subtitleOf(it) || typeLabel(it.type))));
}

export function renderPicker({ animate = false } = {}) {
  const D = document.getElementById('detail');
  if (!D) return;
  clear(D);
  D.classList.remove('is-empty');
  const vis = visibleItems();
  const items = pickedItems(vis);
  const n = items.length;
  const total = vis.length;
  const passkeys = items.reduce((sum, it) => sum + (it.type === 'login' && Array.isArray(it.passkeys) ? it.passkeys.length : 0), 0);

  const head = h('div', { class: 'pick-head' },
    h('span', { class: 'pick-n' }, String(n)),
    h('span', { class: 'pick-unit' }, '件を選択中'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn-line btn-sm', type: 'button', disabled: busy || n === total || !total, onclick: () => emit('pickAll') },
      `すべて選択 (${total})`),
    h('button', { class: 'btn-line btn-sm', type: 'button', disabled: busy || !n, onclick: () => emit('pickNone') }, '解除'));

  const body = n
    ? h('div', { class: 'box pick-list' },
      items.slice(0, SHOWN).map(line),
      n > SHOWN ? h('div', { class: 'pick-more' }, `ほか ${n - SHOWN} 件`) : null)
    : h('div', { class: 'pick-empty' },
      '削除するアイテムを左の一覧で選んでください',
      h('div', { class: 'pick-keys' },
        h('span', null, h('kbd', null, 'クリック'), '選ぶ'),
        h('span', null, h('kbd', null, 'Shift'), '+クリックで範囲'),
        h('span', null, h('kbd', null, 'Ctrl+A'), 'すべて')));

  const warn = passkeys
    ? h('div', { class: 'weak pick-warn', role: 'note' },
      h('span', { class: 'weak-bang', 'aria-hidden': 'true' }, '!'),
      h('span', { class: 'weak-text' }, `パスキー ${passkeys} 件も一緒に削除されます。そのサイトにはパスキーでサインインできなくなります`))
    : null;

  let foot;
  if (confirming && n) {
    const yes = h('button', { class: 'btn-mini danger', type: 'button', disabled: busy, onclick: () => emit('pickDelete') },
      busy ? '削除中…' : '削除する');
    foot = h('div', { class: 'ed-confirm pick-confirm', role: 'alert' },
      h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'),
      h('span', { class: 'grow' }, `${n} 件を削除しますか？ 元に戻せません`),
      yes,
      h('button', { class: 'btn-mini', type: 'button', disabled: busy, onclick: () => { resetPicker(); renderPicker(); } }, '戻る'));
    setTimeout(() => { if (yes.isConnected && !busy) yes.focus({ preventScroll: true }); }, 0);
  } else {
    foot = h('div', { class: 'pick-foot' },
      h('button', { class: 'btn-mini', type: 'button', onclick: () => emit('pickExit') }, 'やめる'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn-mini danger', type: 'button', disabled: !n, onclick: askDelete }, icon('trash', 11), n ? `${n} 件を削除` : '削除'));
  }

  D.append(...[head, body, warn, foot].filter(Boolean));
  if (animate) rise(D, ':scope > *');
}
