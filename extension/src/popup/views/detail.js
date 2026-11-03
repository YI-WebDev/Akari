// Right pane (design 1a): head, weak-password warning, the field box (user / password with
// strength bits / TOTP ticks / URL / memo), passkeys, and the 最終自動入力 · 更新 · 作成 grid.

import { MSG } from '../../shared/messages.js';
import {
  S, emit, call, itemById, vaultById, strengthOf, reuseOf, isWeak, copyText, forSave, replaceItem, mergeSaved, errText,
  liveToken, live,
} from '../state.js';
import { h, clear, icon, copyGlyph } from './dom.js';
import { vaultColor, relTime, formatDate, safeHttpUrl } from './format.js';
import { scramble, cancelScramble, rise, burst, wait } from './fx.js';
import { totpView } from './totp-view.js';
import { meterEl, setMeter } from './meter.js';
import { tileEl } from './list.js';
import { toast, toastError } from './toast.js';

let view = null; // { id, reveal, totp, els, timers }

export function stopDetail() {
  if (!view) return;
  view.totp?.stop();
  cancelScramble('pass');
  view.timers.forEach(clearTimeout);
  view = null;
}

const masked = (pw) => '•'.repeat(Math.min(pw.length, 16));

function copyButton(field, getValue, label) {
  const btn = h('button', { class: 'ibtn', type: 'button', title: 'コピー', 'aria-label': label + 'をコピー' }, copyGlyph(false));
  btn.addEventListener('click', async () => {
    const v = getValue();
    if (!v) return;
    if (!(await copyText(field, v))) return;
    btn.replaceChildren(copyGlyph(true));
    const t = setTimeout(() => btn.replaceChildren(copyGlyph(false)), 1500);
    view?.timers.push(t);
  });
  return btn;
}

/** Open an http(s) URL in a new tab (the popup cannot follow target=_blank by itself). */
function openUrl(e, href) {
  e.preventDefault();
  chrome.tabs.create({ url: href });
}

function head(it) {
  const v = vaultById(it.vault);
  const fav = h('button', {
    class: 'ibtn boxed fav', type: 'button', title: 'お気に入り', 'aria-label': 'お気に入り', 'aria-pressed': String(!!it.fav),
  }, icon('star', 14));
  fav.addEventListener('click', () => toggleFav(it.id, fav));
  const href = it.type === 'note' ? '' : safeHttpUrl(it.url);
  const meta = [h('span', { class: 'd-vault', vars: { '--vc': vaultColor(v?.hue ?? 30) } }, `[${v?.name || '—'}]`),
    h('span', null, it.type === 'note' ? 'セキュアノート' : 'ログイン')];
  if (it.totp?.secret && it.type !== 'note') meta.push(h('span', null, '· 2FA 有効'));
  if (it.passkeys?.length) meta.push(h('span', null, `· パスキー ${it.passkeys.length}`));
  return h('div', { class: 'd-head', dataset: { f: '' } },
    tileEl(it, 'lg'),
    h('div', { class: 'd-titles' },
      h('div', { class: 'd-title', title: it.title || '' }, it.title || '(無題)'),
      h('div', { class: 'd-meta' }, meta)),
    h('button', { class: 'ibtn boxed', type: 'button', title: '編集', 'aria-label': '編集', onclick: () => emit('edit', it.id) }, icon('pencil', 13)),
    fav,
    href ? h('a', {
      class: 'ibtn boxed', href, target: '_blank', rel: 'noreferrer noopener', title: 'サイトを開く', 'aria-label': 'サイトを開く',
      onclick: (e) => openUrl(e, href),
    }, icon('external', 13)) : null);
}

async function toggleFav(id, btn) {
  if (btn.dataset.busy) return; // one request at a time, so a double click can't send the same value twice
  const it = itemById(id);
  if (!it) return;
  const next = !it.fav;
  const token = liveToken();
  btn.dataset.busy = '1';
  btn.setAttribute('aria-busy', 'true');
  btn.setAttribute('aria-pressed', String(next));
  btn.replaceChildren(icon('star', 14));
  try {
    const res = await call(MSG.VAULT_SAVE_ITEM, { item: forSave({ ...it, fav: next }) });
    if (!live(token)) return;
    const cur = itemById(id) || it;
    replaceItem(mergeSaved(res?.item, { ...cur, fav: next }));
    emit('listChanged'); // re-runs filtering + selection (un-★ under the ★ filter)
  } catch (e) {
    if (!live(token)) return;
    btn.setAttribute('aria-pressed', String(!next));
    btn.replaceChildren(icon('star', 14));
    toastError('保存できませんでした', errText(e));
  } finally {
    delete btn.dataset.busy;
    btn.removeAttribute('aria-busy');
  }
}

function warnText(it) {
  const n = reuseOf(it);
  const weak = strengthOf(it.password).level <= 1;
  if (n > 0) return `${weak ? '弱いパスワードです' : '使い回しのパスワードです'}。ほかの ${n} 件のサイトでも使われています。`;
  return '短く推測されやすいパスワードです。';
}

function weakBox(it) {
  return h('div', { class: 'weak', dataset: { f: '' }, role: 'note' },
    h('span', { class: 'weak-bang', 'aria-hidden': 'true' }, '!'),
    h('span', { class: 'weak-text' }, warnText(it)),
    h('button', { class: 'btn-fix', type: 'button', onclick: () => emit('openGen', { target: it.id }) }, '強化する →'));
}

function userRow(it) {
  return h('div', { class: 'f-row' },
    h('span', { class: 'f-label' }, 'ユーザー名'),
    h('span', { class: 'f-value' + (it.username ? '' : ' empty-val') }, it.username || '—'),
    it.username ? copyButton('user', () => itemById(it.id)?.username, 'ユーザー名') : h('span'));
}

function setReveal(on) {
  if (!view?.els.pwText) return;
  const pw = itemById(view.id)?.password || '';
  view.reveal = on;
  const { pwText, eye } = view.els;
  eye.classList.toggle('on', on);
  eye.setAttribute('aria-pressed', String(on));
  eye.setAttribute('aria-label', on ? 'パスワードを隠す' : 'パスワードを表示');
  eye.title = on ? '隠す' : '表示';
  eye.replaceChildren(icon(on ? 'eyeOff' : 'eye', 14));
  pwText.classList.toggle('revealed', on);
  if (on) scramble('pass', pwText, pw, 520);
  else {
    cancelScramble('pass');
    pwText.textContent = masked(pw);
  }
}

function passwordRow(it, animate) {
  const pw = it.password || '';
  if (!pw) {
    return h('div', { class: 'f-row' },
      h('span', { class: 'f-label' }, 'パスワード'), h('span', { class: 'f-value empty-val' }, '—'), h('span'));
  }
  const pwText = h('span', { class: 'pw-text' + (view.reveal ? ' revealed' : ''), 'aria-label': 'パスワード' }, view.reveal ? pw : masked(pw));
  const meter = meterEl();
  setMeter(meter, strengthOf(pw), { animate });
  const eye = h('button', {
    class: 'ibtn' + (view.reveal ? ' on' : ''), type: 'button', title: view.reveal ? '隠す' : '表示',
    'aria-label': view.reveal ? 'パスワードを隠す' : 'パスワードを表示', 'aria-pressed': String(view.reveal),
    onclick: () => setReveal(!view.reveal),
  }, icon(view.reveal ? 'eyeOff' : 'eye', 14));
  view.els.pwText = pwText;
  view.els.eye = eye;
  view.els.meter = meter;
  return h('div', { class: 'f-row top' },
    h('span', { class: 'f-label' }, 'パスワード'),
    h('div', { class: 'pw-col' }, pwText, meter),
    h('div', { class: 'f-btns pw-btns' }, eye, copyButton('pass', () => itemById(it.id)?.password, 'パスワード')));
}

function totpRow(it) {
  const tv = totpView(it.totp);
  view.totp = tv;
  const row = h('div', { class: 'f-row totp-row' },
    h('span', { class: 'f-label' }, '認証コード'),
    tv.col,
    copyButton('totp', () => tv.current(), '認証コード'));
  tv.start(row);
  return row;
}

function urlRow(it) {
  const href = safeHttpUrl(it.url);
  const value = href
    ? h('a', { class: 'f-link', href, target: '_blank', rel: 'noreferrer noopener', title: href, onclick: (e) => openUrl(e, href) }, it.url)
    : h('span', { class: 'f-value' }, it.url);
  return h('div', { class: 'f-row wide' }, h('span', { class: 'f-label' }, 'URL'), value);
}

function noteRow(note) {
  return h('div', { class: 'f-row wide top' }, h('span', { class: 'f-label' }, 'メモ'), h('div', { class: 'f-note' }, note));
}

function passkeysBlock(it) {
  const count = h('span');
  const box = h('div', { class: 'box', role: 'list', 'aria-label': 'パスキー' });
  const sect = h('div', { class: 'sect', dataset: { f: '' } }, h('span', null, 'パスキー'), h('span', { class: 'sect-line' }), count);
  const wrap = [sect, h('div', { dataset: { f: '' } }, box)];
  const render = () => {
    const pks = itemById(it.id)?.passkeys || [];
    count.textContent = String(pks.length);
    clear(box);
    for (const pk of pks) box.append(passkeyEl(it.id, pk, render));
    if (!pks.length) wrap.forEach((el) => el.remove());
  };
  render();
  return wrap;
}

function passkeyEl(itemId, pk, rerender) {
  const name = pk.userName || pk.userDisplayName || '(名前なし)';
  const actions = h('span', { class: 'pk-actions' });
  const idle = () => {
    clear(actions);
    actions.append(h('button', {
      class: 'ibtn', type: 'button', title: 'パスキーを削除', 'aria-label': `${name} のパスキーを削除`, onclick: confirm,
    }, icon('trash', 13)));
  };
  async function remove(btn) {
    btn.disabled = true;
    const token = liveToken();
    try {
      await call(MSG.VAULT_DELETE_PASSKEY, { itemId, credentialId: pk.credentialId });
      if (!live(token)) return;
      const cur = itemById(itemId);
      if (cur) replaceItem({ ...cur, passkeys: (cur.passkeys || []).filter((p) => p.credentialId !== pk.credentialId) });
      rerender();
      toast('パスキーを削除しました', `${pk.rpId} · ${name}`);
    } catch (e) {
      if (!live(token)) return;
      btn.disabled = false;
      toastError('パスキーを削除できませんでした', errText(e));
    }
  }
  function confirm() {
    clear(actions);
    const yes = h('button', { class: 'btn-mini danger', type: 'button' }, '削除する');
    yes.addEventListener('click', () => remove(yes));
    actions.append(h('span', { class: 'pk-confirm' }, h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'), yes,
      h('button', { class: 'btn-mini', type: 'button', onclick: idle }, 'やめる')));
    yes.focus();
  }
  idle();
  return h('div', { class: 'pk', role: 'listitem' },
    h('span', { class: 'pk-ico', 'aria-hidden': 'true' }, icon('passkey', 15)),
    h('span', { class: 'pk-text' },
      h('span', { class: 'pk-user' }, name),
      h('span', { class: 'pk-meta' }, `${pk.rpId} · 作成 ${formatDate(pk.createdAt)}`)),
    actions);
}

function stats(it) {
  const cell = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'stat-k' }, k), h('div', { class: 'stat-v' }, v));
  if (it.type === 'note') {
    return h('div', { class: 'stats two', dataset: { f: '' } }, cell('更新', formatDate(it.updatedAt)), cell('作成', formatDate(it.createdAt)));
  }
  return h('div', { class: 'stats', dataset: { f: '' } },
    cell('最終自動入力', relTime(it.lastUsedAt)),
    cell('更新', formatDate(it.updatedAt)),
    cell('作成', formatDate(it.createdAt)));
}

function emptyDetail() {
  if (S.items.length) {
    return h('div', { class: 'hint-line' }, 'アイテムを選ぶと', h('br'), 'ここに詳細が表示されます');
  }
  const cmd = (ico, label, key, ev, arg) => h('button', { class: 'cmd', type: 'button', onclick: () => emit(ev, arg) },
    icon(ico, 14), h('span', { class: 'grow' }, label), h('span', { class: 'cmd-key', 'aria-hidden': 'true' }, key));
  return h('div', { class: 'welcome' },
    h('div', { class: 'welcome-brand' },
      h('span', { class: 'mark', 'aria-hidden': 'true' }, '灯'),
      h('div', null,
        h('div', { class: 'welcome-name' }, 'akari', h('span', { class: 'brand-cursor', 'aria-hidden': 'true' }, '_')),
        h('div', { class: 'welcome-sub' }, 'パスワード・認証コード・パスキーをひとつに'))),
    h('div', { class: 'cmds' },
      cmd('key', '新規ログイン', 'L', 'newLogin'),
      cmd('note', 'セキュアノート', 'N', 'newNote'),
      cmd('regen', 'パスワード生成', 'G', 'openGen', {})),
    h('div', { class: 'hint-line' }, '+ メニューからも追加できます'));
}

export function renderDetail({ animate = false, reveal = false } = {}) {
  stopDetail();
  const D = document.getElementById('detail');
  clear(D);
  document.getElementById('cardScroll').scrollTop = 0;
  const it = itemById(S.sel);
  if (!it) {
    D.classList.add('is-empty');
    D.append(emptyDetail());
    if (animate) rise(D, '.welcome > *, .hint-line');
    return;
  }
  D.classList.remove('is-empty');
  view = { id: it.id, reveal, totp: null, els: {}, timers: [] };
  D.append(head(it));
  const box = h('div', { class: 'box', dataset: { f: '' } });
  if (it.type === 'note') {
    box.append(noteRow(it.note || ''));
  } else {
    if (isWeak(it)) D.append(weakBox(it));
    box.append(userRow(it), passwordRow(it, animate));
    if (it.totp?.secret) box.append(totpRow(it));
    if (it.url) box.append(urlRow(it));
    if (it.note) box.append(noteRow(it.note));
  }
  D.append(box);
  if (it.type !== 'note' && it.passkeys?.length) D.append(...passkeysBlock(it));
  D.append(stats(it));
  if (animate) rise(D);
}

/** After the generator saved a new password: reveal it with a long scramble, then burst + toast. */
export async function showPasswordUpdated(id, { password, label, bits }) {
  S.sel = id;
  renderDetail({ reveal: true, animate: true });
  const it = itemById(id);
  if (!view?.els.pwText) return;
  const token = liveToken();
  scramble('pass', view.els.pwText, password, 1000);
  await wait(650);
  if (!live(token) || view?.id !== id) return;
  burst(document.getElementById('app'), view.els.meter);
  toast(`${it?.title || ''} のパスワードを更新しました`, `強度: ${label} · ${bits} bit`);
}
