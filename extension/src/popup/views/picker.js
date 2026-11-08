import { t } from '../../shared/i18n.js';
import { S, emit, visibleItems } from '../state.js';
import { h, clear, icon } from './dom.js';
import { rise } from './fx.js';
import { typeLabel, subtitleOf } from '../../shared/item-types.js';
import { tileEl } from './list.js';

const SHOWN = 6;

let confirming = false;
let busy = false;

export function resetPicker() {
  confirming = false;
  busy = false;
}

export const pickerConfirming = () => confirming;

export function askDelete() {
  if (!S.picked.size || busy) return;
  confirming = true;
  renderPicker();
}

export function setPickerBusy(on) {
  busy = on;
  renderPicker();
}

const pickedItems = (vis) => vis.filter((it) => S.picked.has(it.id));

function line(it) {
  return h('div', { class: 'pick-item' },
    tileEl(it, 'sm'),
    h('span', { class: 'pick-text' },
      h('span', { class: 'pick-title' }, it.title || t('(無題)')),
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
    h('span', { class: 'pick-unit' }, t('件を選択中')),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn-line btn-sm', type: 'button', disabled: busy || n === total || !total, onclick: () => emit('pickAll') },
      t('すべて選択 ({n})', { n: total })),
    h('button', { class: 'btn-line btn-sm', type: 'button', disabled: busy || !n, onclick: () => emit('pickNone') }, t('picker.none', null, '解除')));

  const body = n
    ? h('div', { class: 'box pick-list' },
      items.slice(0, SHOWN).map(line),
      n > SHOWN ? h('div', { class: 'pick-more' }, t('ほか {n} 件', { n: n - SHOWN })) : null)
    : h('div', { class: 'pick-empty' },
      t('削除するアイテムを左の一覧で選んでください'),
      h('div', { class: 'pick-keys' },
        h('span', null, h('kbd', null, t('クリック')), t('選ぶ')),
        h('span', null, h('kbd', null, 'Shift'), t('+クリックで範囲')),
        h('span', null, h('kbd', null, 'Ctrl+A'), t('picker.keyAll', null, 'すべて'))));

  const warn = passkeys
    ? h('div', { class: 'weak pick-warn', role: 'note' },
      h('span', { class: 'weak-bang', 'aria-hidden': 'true' }, '!'),
      h('span', { class: 'weak-text' }, t('trash.askPasskeys', { n: passkeys }, 'パスキー {n} 件も一緒にゴミ箱に移ります。ゴミ箱にある間は、そのサイトにパスキーでサインインできません')))
    : null;

  let foot;
  if (confirming && n) {
    const yes = h('button', { class: 'btn-mini danger', type: 'button', disabled: busy, onclick: () => emit('pickDelete') },
      busy ? t('削除中…') : t('削除する'));
    foot = h('div', { class: 'ed-confirm pick-confirm', role: 'alert' },
      h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'),
      h('span', { class: 'grow' }, t('trash.askN', { n }, '{n} 件をゴミ箱に移しますか？ 30 日間は元に戻せます')),
      yes,
      h('button', { class: 'btn-mini', type: 'button', disabled: busy, onclick: () => { resetPicker(); renderPicker(); } }, t('戻る')));
    setTimeout(() => { if (yes.isConnected && !busy) yes.focus({ preventScroll: true }); }, 0);
  } else {
    foot = h('div', { class: 'pick-foot' },
      h('button', { class: 'btn-mini', type: 'button', onclick: () => emit('pickExit') }, t('やめる')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn-mini danger', type: 'button', disabled: !n, onclick: askDelete }, icon('trash', 11), n ? t('{n} 件を削除', { n }) : t('削除')));
  }

  D.append(...[head, body, warn, foot].filter(Boolean));
  if (animate) rise(D, ':scope > *');
}
