import { MSG, ERR } from '../../shared/messages.js';
import { call, itemById, replaceItem, errText, liveToken, live } from '../state.js';
import { t } from '../../shared/i18n.js';
import { h, clear, icon } from './dom.js';
import { toast, toastError } from './toast.js';

// Desktop apps a login is linked to. Only Akari Desktop adds them; the popup shows them and unlinks.

const listOf = (item) => (item?.type === 'login' && Array.isArray(item.apps) ? item.apps : []);
const same = (a, b) => a.exe === b.exe && (a.signer ?? null) === (b.signer ?? null);
const metaOf = (a) => [a.signer || t('署名なし'), a.title].filter(Boolean).join(' · ');

function appRow(a, actions) {
  return h('div', { class: 'pk app-row', role: 'listitem' },
    h('span', { class: 'pk-ico', 'aria-hidden': 'true' }, icon('terminal', 15)),
    h('span', { class: 'pk-text' },
      h('span', { class: 'pk-user app-exe' }, a.exe),
      h('span', { class: 'pk-meta' }, metaOf(a))),
    actions);
}

function withoutApp(item, app) {
  const rest = listOf(item).filter((x) => !same(x, app));
  const { apps, ...other } = item;
  return rest.length ? { ...other, apps: rest } : other;
}

/** Detail view: the section, with an in-row confirmation before unlinking right away. */
export function appsDetail(it) {
  if (!listOf(it).length) return [];
  const count = h('span');
  const box = h('div', { class: 'box', role: 'list', 'aria-label': t('detail.apps', null, 'アプリ') });
  const sect = h('div', { class: 'sect', dataset: { f: '' } }, h('span', null, t('detail.apps', null, 'アプリ')), h('span', { class: 'sect-line' }), count);
  const wrap = [sect, h('div', { dataset: { f: '' } }, box)];
  const render = () => {
    const apps = listOf(itemById(it.id));
    count.textContent = String(apps.length);
    clear(box);
    for (const a of apps) box.append(detailRow(it.id, a, render));
    if (!apps.length) wrap.forEach((el) => el.remove());
  };
  render();
  return wrap;
}

function detailRow(itemId, a, rerender) {
  const actions = h('span', { class: 'pk-actions' });
  const idle = () => {
    clear(actions);
    actions.append(h('button', {
      class: 'ibtn', type: 'button', title: t('アプリの紐付けを外す'), 'aria-label': t('{exe} の紐付けを外す', { exe: a.exe }), onclick: confirm,
    }, icon('x', 13)));
  };
  async function remove(btn) {
    btn.disabled = true;
    const token = liveToken();
    try {
      await call(MSG.VAULT_UNLINK_APP, { itemId, exe: a.exe, signer: a.signer ?? null });
    } catch (e) {
      if (!live(token)) return;
      if (e?.code !== ERR.NOT_FOUND) {
        btn.disabled = false;
        toastError(t('紐付けを外せませんでした'), errText(e));
        return;
      }
    }
    if (!live(token)) return;
    const cur = itemById(itemId);
    if (cur) replaceItem(withoutApp(cur, a));
    rerender();
    toast(t('紐付けを外しました'), a.exe);
  }
  function confirm() {
    clear(actions);
    const yes = h('button', { class: 'btn-mini danger', type: 'button' }, t('外す'));
    yes.addEventListener('click', () => remove(yes));
    actions.append(h('span', { class: 'pk-confirm' }, h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'), yes,
      h('button', { class: 'btn-mini', type: 'button', onclick: idle }, t('やめる'))));
    yes.focus();
  }
  idle();
  return appRow(a, actions);
}

/** Editor: "unlink" only marks the row; the links go when the item is saved (see unlinkMarked). */
export function createAppsEditor({ item = null, onDirty = () => {} } = {}) {
  const rows = listOf(item).map((a) => ({ a, removed: false }));
  if (!rows.length) return { el: null, marked: () => [], changed: () => 0 };
  const count = h('span', { class: 'ed-sect-count' }, String(rows.length));
  const list = h('div', { role: 'list', 'aria-label': t('detail.apps', null, 'アプリ') });
  for (const s of rows) {
    const actions = h('span', { class: 'pk-actions' });
    s.el = appRow(s.a, actions);
    s.render = () => {
      s.el.classList.toggle('removed', s.removed);
      s.el.querySelector('.pk-meta').textContent = s.removed ? t('保存すると紐付けを外します') : metaOf(s.a);
      clear(actions);
      const btn = s.removed
        ? h('button', { class: 'btn-mini', type: 'button', 'aria-label': t('{exe} の紐付けを残す', { exe: s.a.exe }) }, icon('undo', 12), t('apps.keep', null, '残す'))
        : h('button', { class: 'ibtn', type: 'button', title: t('アプリの紐付けを外す'), 'aria-label': t('{exe} の紐付けを外す', { exe: s.a.exe }) }, icon('x', 13));
      btn.addEventListener('click', () => {
        s.removed = !s.removed;
        s.render();
        onDirty();
        s.btn.focus();
      });
      s.btn = btn;
      actions.append(btn);
    };
    s.render();
    list.append(s.el);
  }
  const el = h('div', { class: 'box', dataset: { f: '' } },
    h('div', { class: 'ed-sect' }, h('span', { class: 'ed-sect-title' }, t('detail.apps', null, 'アプリ'), count)),
    list);
  return {
    el,
    marked: () => rows.filter((s) => s.removed).map((s) => s.a),
    changed: () => rows.filter((s) => s.removed).length,
  };
}

/** After saving: unlink what the editor marked, from the item as it is stored now. Returns the latest item and the first error. */
export async function unlinkMarked(saved, marked) {
  let item = saved;
  let error = null;
  for (const a of marked) {
    try {
      const res = await call(MSG.VAULT_UNLINK_APP, { itemId: saved.id, exe: a.exe, signer: a.signer ?? null });
      item = res?.item ? { ...res.item, passkeys: res.item.passkeys ?? item.passkeys } : withoutApp(item, a);
    } catch (e) {
      if (e?.code === ERR.NOT_FOUND) item = withoutApp(item, a);
      else error ??= e;
    }
  }
  return { item, error };
}
