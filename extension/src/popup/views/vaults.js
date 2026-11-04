// 保管庫 page of the settings sheet: the vaults with their item counts; add one, rename or
// recolor one in place, delete one (its items move to another vault, or go with it).
// The service worker decides (vault/createVault, updateVault, deleteVault) and answers with
// the whole vault list; this page only redraws from S.vaults.

import { MSG, ERR, VAULT_LIMITS } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import { S, on, call, emit, errText, liveToken, live, setItems } from '../state.js';
import { h, clear, icon } from './dom.js';
import { vaultColor } from './format.js';
import { shake } from './fx.js';
import { toast } from './toast.js';
import { cmdLine, arrowNav, setRoving, setBusy, goButton } from './io.js';

const $ = (id) => document.getElementById(id);

/** Colour choices (oklch hues). The first three are the default vaults'. */
export const VAULT_HUES = Object.freeze([55, 255, 150, 330, 200, 300, 100, 20]);

// mode: null (list) | 'add' | 'edit' | 'delete'; id: the vault being edited or deleted;
// err: a message to show again after a redraw
const st = { mode: null, id: null, hue: VAULT_HUES[0], moveTo: null, err: '' };

const countIn = (id) => S.items.filter((i) => i.vault === id).length;
const nameKey = (s) => s.trim().normalize('NFKC').toLowerCase();
const vaultOf = (id) => S.vaults.find((v) => v.id === id) || null;
const quote = (s) => (/^[\p{L}\p{N}_-]+$/u.test(s) ? s : JSON.stringify(s));

function cmdText() {
  const v = vaultOf(st.id);
  if (st.mode === 'add') return 'akari vault add';
  if (st.mode === 'edit' && v) return `akari vault edit ${quote(v.name)}`;
  if (st.mode === 'delete' && v) {
    if (!countIn(v.id)) return `akari vault rm ${quote(v.name)}`;
    const to = vaultOf(st.moveTo);
    return `akari vault rm ${quote(v.name)} ${to ? '--move-to ' + quote(to.name) : '--with-items'}`;
  }
  return 'akari vault ls';
}

/* ── rendering ── */

function render(focus) {
  const page = $('vaultsPage');
  clear(page);
  shown = snapshot();
  const list = h('div', { class: 'vm-list', role: 'list', 'aria-label': t('vaults.list', null, '保管庫') });
  for (const v of S.vaults) {
    if (st.mode === 'edit' && st.id === v.id) list.append(form(v));
    else list.append(row(v));
    if (st.mode === 'delete' && st.id === v.id) list.append(confirmDelete(v));
  }
  const full = S.vaults.length >= VAULT_LIMITS.count;
  page.append(
    cmdLine(cmdText()),
    list,
    st.mode === 'add' ? form(null) : h('button', {
      id: 'vmAdd', class: 'btn-line vm-add', type: 'button', disabled: full, onclick: startAdd,
    }, icon('plus', 12, 2.6), t('vaults.add', null, '新しい保管庫')),
    h('p', { class: 'set-note' }, full
      ? t('vaults.full', { n: VAULT_LIMITS.count }, '保管庫は {n} 個までです。')
      : t('vaults.note', { n: VAULT_LIMITS.count }, '保管庫は {n} 個まで作れます。削除するときは、中のアイテムを別の保管庫に移すか、一緒に削除するかを選べます。')),
  );
  if (focus) setTimeout(() => page.querySelector(focus)?.focus({ preventScroll: false }), 0);
}

function row(v) {
  const n = countIn(v.id);
  const last = S.vaults.length <= 1;
  return h('div', { class: 'vm-row', role: 'listitem', dataset: { vault: v.id } },
    h('span', { class: 'swatch', vars: { '--sw': vaultColor(v.hue) } }),
    h('span', { class: 'vm-name' }, v.name),
    h('span', { class: 'vm-count' }, t('vaults.count', { n }, '{n} 件')),
    h('button', {
      class: 'ibtn', type: 'button', dataset: { act: 'edit' },
      title: t('vaults.edit', null, '名前と色を変える'), 'aria-label': t('vaults.editOf', { name: v.name }, '{name} の名前と色を変える'),
      onclick: () => startEdit(v),
    }, icon('pencil', 13)),
    h('button', {
      class: 'ibtn vm-del', type: 'button', dataset: { act: 'delete' }, disabled: last,
      title: last ? t('vaults.lastOne', null, '最後の保管庫は削除できません') : t('vaults.delete', null, '削除'),
      'aria-label': t('vaults.deleteOf', { name: v.name }, '{name} を削除'),
      onclick: () => startDelete(v),
    }, icon('trash', 13)));
}

/** Name + colour form, for a new vault (v = null) or in place of a vault's row. */
function form(v) {
  const hues = h('div', { class: 'vm-hues', role: 'radiogroup', 'aria-label': t('vaults.color', null, '色') });
  VAULT_HUES.forEach((hue, i) => hues.append(h('button', {
    class: 'vm-hue', type: 'button', role: 'radio', dataset: { hue: String(hue) },
    'aria-checked': String(hue === st.hue), 'aria-label': t('vaults.colorN', { n: i + 1 }, '色 {n}'),
    vars: { '--sw': vaultColor(hue) },
    onclick: (e) => pickHue(hues, Number(e.currentTarget.dataset.hue)),
  })));
  setRoving([...hues.children], Math.max(0, VAULT_HUES.indexOf(st.hue)));
  arrowNav(hues, '.vm-hue', { onMove: (b) => b.click() });
  const name = h('input', {
    id: 'vmName', type: 'text', value: v ? v.name : '', maxlength: String(VAULT_LIMITS.name), autocomplete: 'off', spellcheck: 'false',
    placeholder: t('vaults.namePh', null, '保管庫の名前'), 'aria-label': t('vaults.name', null, '保管庫の名前'),
    oninput: () => { $('vmErr').textContent = ''; },
  });
  return h('form', { class: 'vm-form set-form' + (v ? '' : ' vm-new'), novalidate: true, onsubmit: submit },
    h('div', { class: 'field' }, name),
    hues,
    h('div', { class: 'form-foot' },
      h('span', { id: 'vmErr', class: 'field-err', role: 'alert' }),
      h('button', { class: 'btn-text', type: 'button', onclick: cancel }, t('common.cancel', null, 'キャンセル')),
      goButton(v ? t('vaults.save', null, '保存') : t('vaults.create', null, '作成'), { id: 'vmSubmit', type: 'submit' })));
}

function pickHue(group, hue) {
  st.hue = hue;
  const buttons = [...group.children];
  buttons.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.hue) === hue)));
  setRoving(buttons, VAULT_HUES.indexOf(hue));
}

function confirmDelete(v) {
  const n = countIn(v.id);
  const others = S.vaults.filter((x) => x.id !== v.id);
  const box = h('div', { class: 'vm-confirm', role: 'group', 'aria-label': t('vaults.deleteOf', { name: v.name }, '{name} を削除') });
  box.append(h('p', { class: 'io-lead' }, n
    ? t('vaults.askItems', { name: v.name, n }, '「{name}」の {n} 件をどうしますか？')
    : t('vaults.askEmpty', { name: v.name }, '空の保管庫「{name}」を削除します。')));
  const go = goButton('', { id: 'vmDelete', class: 'btn-primary danger' });
  const sync = () => {
    go.querySelector('.go-label').textContent = !n ? t('vaults.deleteGo', null, '削除する')
      : st.moveTo ? t('vaults.moveGo', null, '移して削除') : t('vaults.purgeGo', { n }, '{n} 件ごと削除');
    for (const c of box.querySelectorAll('.vault-chip')) c.setAttribute('aria-checked', String((c.dataset.to || null) === st.moveTo));
    const cmd = $('vaultsPage').querySelector('.io-cmd-text');
    if (cmd) cmd.textContent = cmdText();
  };
  if (n) {
    const pick = h('div', { class: 'vault-pick', role: 'radiogroup', 'aria-label': t('vaults.itemsTo', null, '中のアイテム') });
    for (const o of others) {
      pick.append(h('button', {
        class: 'vault-chip', type: 'button', role: 'radio', dataset: { to: o.id },
        onclick: () => { st.moveTo = o.id; sync(); },
      }, h('span', { class: 'swatch', vars: { '--sw': vaultColor(o.hue) } }), t('vaults.moveTo', { name: o.name }, '{name}に移す')));
    }
    pick.append(h('button', {
      class: 'vault-chip vm-purge', type: 'button', role: 'radio', dataset: { to: '' },
      onclick: () => { st.moveTo = null; sync(); },
    }, t('vaults.withItems', null, '一緒に削除')));
    arrowNav(pick, '.vault-chip', { onMove: (b) => b.click() });
    box.append(pick);
  }
  go.addEventListener('click', () => doDelete(v, go));
  box.append(h('div', { class: 'form-foot' },
    h('span', { id: 'vmErr', class: 'field-err', role: 'alert' }, st.err),
    h('button', { class: 'btn-text', type: 'button', onclick: cancel }, t('common.cancel', null, 'キャンセル')),
    go));
  queueMicrotask(sync);
  return box;
}

/* ── actions ── */

function startAdd() {
  const used = new Set(S.vaults.map((v) => v.hue));
  Object.assign(st, { mode: 'add', id: null, hue: VAULT_HUES.find((x) => !used.has(x)) ?? VAULT_HUES[0] });
  render('#vmName');
}

function startEdit(v) {
  Object.assign(st, { mode: 'edit', id: v.id, hue: v.hue });
  render('#vmName');
}

function startDelete(v) {
  Object.assign(st, { mode: 'delete', id: v.id, moveTo: S.vaults.find((x) => x.id !== v.id)?.id ?? null, err: '' });
  render(countIn(v.id) ? '.vm-confirm .vault-chip[aria-checked="true"]' : '#vmDelete');
}

function cancel() {
  const id = st.id;
  const wasAdd = st.mode === 'add';
  st.mode = null;
  st.err = '';
  render(wasAdd ? '#vmAdd' : `.vm-row[data-vault="${CSS.escape(id || '')}"] [data-act="edit"]`);
}

function fail(message) {
  const err = $('vmErr');
  if (err) err.textContent = message;
  const input = $('vmName');
  if (input) {
    shake(input.closest('.field'));
    input.focus();
  }
}

async function submit(e) {
  e.preventDefault();
  const name = $('vmName').value.trim();
  if (!name) return fail(t('vaults.errName', null, '名前を入力してください'));
  if ([...name].length > VAULT_LIMITS.name) return fail(t('vaults.errLong', { n: VAULT_LIMITS.name }, '名前は {n} 文字までです'));
  if (S.vaults.some((v) => v.id !== st.id && nameKey(v.name) === nameKey(name))) {
    return fail(t('vaults.errDup', null, '同じ名前の保管庫があります'));
  }
  const btn = $('vmSubmit');
  const adding = st.mode === 'add';
  const token = liveToken();
  setBusy(btn, true);
  try {
    const res = adding
      ? await call(MSG.VAULT_CREATE_VAULT, { name, hue: st.hue })
      : await call(MSG.VAULT_UPDATE_VAULT, { id: st.id, name, hue: st.hue });
    if (!live(token)) return;
    S.vaults = res.vaults;
    st.mode = null;
    emit('vaultsChanged');
    render(`.vm-row[data-vault="${CSS.escape(res.vault.id)}"] [data-act="edit"]`);
    toast(adding
      ? t('vaults.created', { name: res.vault.name }, '保管庫「{name}」を作成しました')
      : t('vaults.updated', { name: res.vault.name }, '保管庫「{name}」を変更しました'));
  } catch (err) {
    if (!live(token)) return;
    setBusy(btn, false);
    fail(errText(err));
  }
}

async function doDelete(v, btn) {
  const n = countIn(v.id);
  const moveTo = n ? st.moveTo : null;
  const dest = vaultOf(moveTo);
  const token = liveToken();
  setBusy(btn, true);
  try {
    // Items are deleted only when the user chose so for the items they saw; the service worker
    // refuses (NOT_EMPTY) if the vault holds items this popup does not know about yet.
    const res = await call(MSG.VAULT_DELETE_VAULT, { id: v.id, moveTo, deleteItems: n > 0 && moveTo === null });
    if (!live(token)) return;
    S.vaults = res.vaults;
    st.mode = null;
    st.err = '';
    // The same change on the popup's copy, so the counts are right at once; then read everything again.
    setItems(moveTo ? S.items.map((i) => (i.vault === v.id ? { ...i, vault: moveTo } : i)) : S.items.filter((i) => i.vault !== v.id));
    emit('reload');
    render('#vmAdd');
    toast(t('vaults.deleted', { name: v.name }, '保管庫「{name}」を削除しました'),
      res.moved ? t('vaults.movedN', { n: res.moved, name: dest?.name || '' }, '{n} 件を「{name}」に移しました')
        : res.deleted ? t('vaults.deletedN', { n: res.deleted }, '{n} 件を削除しました') : null);
  } catch (err) {
    if (!live(token)) return;
    setBusy(btn, false);
    st.err = errText(err);
    const e2 = $('vmErr');
    if (e2) e2.textContent = st.err;
    if (err?.code === ERR.NOT_EMPTY) emit('reload'); // read the vault again; the question is redrawn with the real count
  }
}

/* ── page lifecycle (views/settings.js) ── */

const isOpen = () => !$('vaultsPage').hidden;
const snapshot = () => JSON.stringify(S.vaults.map((v) => [v.id, v.name, v.hue, countIn(v.id)]));
let shown = '';

/** Where focus is inside the page, as a selector that still finds it after a redraw. */
function focusSelector() {
  const a = document.activeElement;
  if (!a || !$('vaultsPage').contains(a)) return null;
  if (a.id) return '#' + a.id;
  const row = a.closest('.vm-row');
  if (row && a.dataset.act) return `.vm-row[data-vault="${CSS.escape(row.dataset.vault)}"] [data-act="${a.dataset.act}"]`;
  if (a.dataset.to !== undefined) return `.vm-confirm .vault-chip[data-to="${CSS.escape(a.dataset.to)}"]`;
  return null;
}

/** After the popup re-read the vault: redraw if counts or vaults changed (not over a half-typed name). */
function onReloaded() {
  if (!isOpen() || st.mode === 'add' || st.mode === 'edit' || snapshot() === shown) return;
  if (st.mode === 'delete' && !vaultOf(st.id)) st.mode = null;
  render(focusSelector());
}

export function initVaults() {
  on('reloaded', onReloaded);
}

export function openVaults({ focus = true } = {}) {
  Object.assign(st, { mode: null, err: '' });
  render(focus ? '.vm-row [data-act="edit"]' : null);
  emit('reload'); // counts from another popup or an import meanwhile
}

/** One step back inside the page (an open form or delete question). Returns true when handled. */
export function vaultsBack() {
  if (!st.mode) return false;
  cancel();
  return true;
}

export function resetVaults() {
  Object.assign(st, { mode: null, id: null, moveTo: null, err: '' });
  shown = '';
  clear($('vaultsPage'));
}
