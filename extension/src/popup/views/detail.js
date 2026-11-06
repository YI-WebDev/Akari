// Right pane (design 1a): head, weak-password warning, the field box (user / password with
// strength bits / TOTP ticks / URL / memo), passkeys, and the 最終自動入力 · 更新 · 作成 grid.
// Templated types (card, identity, SSH key, …) get their template fields in the same field-box
// language — secrets masked with reveal + copy — then extra fields, the note and 更新 · 作成.

import { MSG } from '../../shared/messages.js';
import {
  typeOf, typeLabel, fieldLabel, optionLabel, hasTemplate, isSecretKind, cardBrand, maskTail,
} from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import {
  S, emit, call, setSel, itemById, vaultById, strengthOf, reuseOf, isWeak, copyText, forSave, replaceItem, mergeSaved, errText,
  liveToken, live,
} from '../state.js';
import { h, clear, icon, copyGlyph } from './dom.js';
import {
  vaultColor, relTime, formatDate, safeHttpUrl, hueOf, formatIsoDate, daysUntil, digitsOnly, groupDigits,
} from './format.js';
import { scramble, cancelScramble, rise, wait, DIGITS } from './fx.js';
import { totpView } from './totp-view.js';
import { meterEl, setMeter } from './meter.js';
import { tileEl } from './list.js';
import { renderPicker } from './picker.js';
import { toast, toastError } from './toast.js';

// { id, reveal, totp, els, timers, shown: revealed field keys, scr: scramble keys in use }
let view = null;

export function stopDetail() {
  if (!view) return;
  view.totp?.stop();
  cancelScramble('pass');
  for (const k of view.scr) cancelScramble(k);
  view.timers.forEach(clearTimeout);
  view = null;
}

const masked = (pw) => '•'.repeat(Math.min(pw.length, 16));

function copyButton(field, getValue, label, opts) {
  const aria = opts ? t('detail.copyField', { label }, '{label}をコピー') : label + 'をコピー';
  const btn = h('button', { class: 'ibtn', type: 'button', title: t('detail.copy', null, 'コピー'), 'aria-label': aria }, copyGlyph(false));
  btn.addEventListener('click', async () => {
    const v = getValue();
    if (!v) return;
    if (!(await copyText(field, v, opts))) return;
    btn.replaceChildren(copyGlyph(true));
    const tm = setTimeout(() => btn.replaceChildren(copyGlyph(false)), 1500);
    view?.timers.push(tm);
  });
  return btn;
}

/** Open an http(s) URL in a new tab (the popup cannot follow target=_blank by itself). */
function openUrl(e, href) {
  e.preventDefault();
  chrome.tabs.create({ url: href });
}

/** Text with soft breaks after . - _ / @, so a long host wraps at its dots rather than mid-word. */
function breakable(text) {
  return String(text).split(/(?<=[.\-_/@])/).flatMap((part, i) => (i ? [h('wbr'), part] : [part]));
}

/**
 * Title block: the tile, the title (up to two lines, so long hosts are not cut), the actions as
 * one compact group beside it, and under both a meta line that may wrap: [vault] type, then
 * badges for what the item carries (2FA, passkeys).
 */
function head(it) {
  const v = vaultById(it.vault);
  const fav = h('button', {
    class: 'ibtn fav', type: 'button', title: 'お気に入り', 'aria-label': 'お気に入り', 'aria-pressed': String(!!it.fav),
  }, icon('star', 14));
  fav.addEventListener('click', () => toggleFav(it.id, fav));
  const href = it.type === 'login' ? safeHttpUrl(it.url) : '';
  const login = it.type === 'login';
  const badge = (text, title) => h('span', { class: 'd-badge', title }, text);
  const meta = [
    h('span', { class: 'd-vault', vars: { '--vc': vaultColor(v?.hue ?? 30) } }, `[${v?.name || '—'}]`),
    h('span', { class: 'd-type' }, typeLabel(it.type)),
    login && it.totp?.secret ? badge('2FA', '認証コード（2FA）あり') : null,
    login && it.passkeys?.length ? badge(`パスキー ${it.passkeys.length}`, 'このサイトのパスキー') : null,
  ];
  return h('div', { class: 'd-head', dataset: { f: '' } },
    tileEl(it, 'lg'),
    h('div', { class: 'd-title', title: it.title || '' }, breakable(it.title || '(無題)')),
    h('div', { class: 'd-acts', role: 'group', 'aria-label': '操作' },
      h('button', { class: 'ibtn', type: 'button', title: '編集', 'aria-label': '編集', onclick: () => emit('edit', it.id) }, icon('pencil', 13)),
      fav,
      href ? h('a', {
        class: 'ibtn', href, target: '_blank', rel: 'noreferrer noopener', title: 'サイトを開く', 'aria-label': 'サイトを開く',
        onclick: (e) => openUrl(e, href),
      }, icon('external', 13)) : null),
    h('div', { class: 'd-meta' }, meta));
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
    h('button', { class: 'btn-fix', type: 'button', onclick: () => emit('openGen', { target: it.id }) }, '強化する', icon('arrowRight', 11, 2.6)));
}

// ---- a password change on the site ----------------------------------------------------
//
// 強化する holds the new password as pendingPassword (views/generator.js) instead of replacing
// the current one, which the site still wants (its "current password" field, and autofill on
// the login form). The banner keeps it at hand until the user confirms the change or drops it;
// every replaced password stays in the history below the fields.

async function settlePending(id, action, btns) {
  const cur = itemById(id);
  const next = cur?.pendingPassword?.password;
  if (!cur || !next) return;
  btns.forEach((b) => { b.disabled = true; });
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_PENDING_PASSWORD, { id, action });
    if (!live(token)) return;
    replaceItem(mergeSaved(res?.item, cur));
    if (action === 'confirm') {
      emit('passwordUpdated', id, { password: next, ...strengthOf(next) });
    } else {
      renderDetail({ animate: true });
      toast('保留中のパスワードを破棄しました', '今のパスワードはそのままです');
    }
  } catch (e) {
    if (!live(token)) return;
    btns.forEach((b) => { b.disabled = false; });
    toastError(action === 'confirm' ? '確定できませんでした' : '破棄できませんでした', errText(e));
  }
}

function pendingBox(it) {
  const site = it.type === 'login' ? safeHttpUrl(it.url) : '';
  const acts = h('div', { class: 'pend-acts' });
  const idle = () => {
    const confirm = h('button', { class: 'btn-mini primary', type: 'button' }, icon('check', 11, 3), '確定する');
    const drop = h('button', { class: 'btn-mini', type: 'button', onclick: askDrop }, '取り消す');
    confirm.addEventListener('click', () => settlePending(it.id, 'confirm', [confirm, drop]));
    clear(acts);
    acts.append(
      copyButton('pending', () => itemById(it.id)?.pendingPassword?.password, '新しいパスワード', { label: '新しいパスワード', secret: true }),
      site ? h('button', {
        class: 'btn-mini', type: 'button', title: site,
        onclick: () => chrome.tabs.create({ url: site }),
      }, 'サイトで変更', icon('external', 10)) : null,
      h('span', { class: 'grow' }), drop, confirm);
  };
  // Dropping it after the site took it would lock the user out: ask first.
  function askDrop() {
    const yes = h('button', { class: 'btn-mini danger', type: 'button' }, '破棄する');
    yes.addEventListener('click', () => settlePending(it.id, 'discard', [yes]));
    clear(acts);
    acts.append(h('span', { class: 'pend-q grow' }, 'サイトで変更済みなら「確定」を。破棄しますか？'), yes,
      h('button', { class: 'btn-mini', type: 'button', onclick: idle }, '戻る'));
    yes.focus();
  }
  idle();
  return h('div', { class: 'pend', dataset: { f: '' }, role: 'status' },
    h('div', { class: 'pend-head' }, icon('clock', 13), h('span', { class: 'grow' }, '新しいパスワードを保留中'),
      h('span', { class: 'pend-date' }, relTime(it.pendingPassword.createdAt))),
    h('div', { class: 'pend-text' }, 'サイトでパスワードを変更できたら「確定」を押してください。それまで自動入力は今のパスワードを使います。'),
    acts);
}

/** Earlier passwords of a login (newest first), folded; each can be shown, copied or put back. */
function historyBlock(it) {
  const list = it.passwordHistory || [];
  if (!list.length) return [];
  const box = h('div', { class: 'box hist', role: 'list', 'aria-label': '以前のパスワード', hidden: true });
  const head = h('button', { class: 'sect sect-btn', type: 'button', 'aria-expanded': 'false', dataset: { f: '' } },
    icon('chevRight', 11), h('span', null, '以前のパスワード'), h('span', { class: 'sect-line' }), h('span', null, String(list.length)));
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(open));
    box.hidden = !open;
  });
  for (const entry of list) box.append(historyRow(it, entry));
  return [head, h('div', { dataset: { f: '' } }, box)];
}

function historyRow(it, entry) {
  const text = h('span', { class: 'hist-pw' }, masked(entry.password));
  let shown = false;
  const eye = h('button', { class: 'ibtn', type: 'button', title: '表示', 'aria-label': '以前のパスワードを表示', 'aria-pressed': 'false' }, icon('eye', 13));
  eye.addEventListener('click', () => {
    shown = !shown;
    text.textContent = shown ? entry.password : masked(entry.password);
    text.classList.toggle('revealed', shown);
    eye.setAttribute('aria-pressed', String(shown));
    eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye', 13));
  });
  const back = h('button', { class: 'btn-mini', type: 'button', title: 'このパスワードに戻す（今のパスワードは履歴に残ります）' }, '戻す');
  back.addEventListener('click', () => restorePassword(it.id, entry.password, back));
  return h('div', { class: 'hist-row', role: 'listitem' },
    h('div', { class: 'hist-text' }, text, h('span', { class: 'hist-date' }, `${formatDate(entry.changedAt)} まで使用`)),
    h('span', { class: 'f-btns' }, eye, copyButton('history', () => entry.password, '以前のパスワード', { label: '以前のパスワード', secret: true }), back));
}

async function restorePassword(id, password, btn) {
  const cur = itemById(id);
  if (!cur) return;
  btn.disabled = true;
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_SAVE_ITEM, { item: { id, password } });
    if (!live(token)) return;
    replaceItem(mergeSaved(res?.item, cur));
    emit('listChanged');
    renderDetail({ animate: true });
    toast('以前のパスワードに戻しました', '戻す前のパスワードは履歴に残しました');
  } catch (e) {
    if (!live(token)) return;
    btn.disabled = false;
    toastError('戻せませんでした', errText(e));
  }
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

// Extra fields that are more addresses of the same login: imports keep a login's second,
// third… URL there (Proton Pass, Bitwarden, 1Password, KeePass, NordPass label them "URL").
const URL_LABEL = /^(url|uri|website|web ?site|ウェブサイト|サイト|ホームページ)\s*\d*$/i;
const isUrlExtra = (x) => !!x && !x.secret && URL_LABEL.test(str(x.label).trim())
  && !!str(x.value).trim() && !str(x.value).includes('\n');

/** A login's addresses in one box, each opening in a new tab (http/https only; others stay text). */
function websitesRow(it) {
  const seen = new Set();
  const urls = [it.url, ...(Array.isArray(it.extra) ? it.extra : []).filter(isUrlExtra).map((x) => x.value)]
    .map((u) => str(u).trim())
    .filter((u) => u && !seen.has(u) && seen.add(u));
  if (!urls.length) return null;
  const list = h('div', { class: 'w-list', role: 'list', 'aria-label': t('detail.websites', null, 'ウェブサイト') });
  // https:// and a bare trailing / are left out so similar addresses differ before the ellipsis;
  // http:// stays visible (not encrypted). The full address is in the tooltip.
  const shortOf = (u) => u.replace(/^https:\/\//i, '').replace(/^([^/?#]+)\/$/, '$1');
  for (const u of urls) {
    const href = safeHttpUrl(u);
    list.append(href
      ? h('a', {
        class: 'w-url', role: 'listitem', href, target: '_blank', rel: 'noreferrer noopener', title: href,
        'aria-label': t('detail.openSite', { url: u }, '{url} を開く'), onclick: (e) => openUrl(e, href),
      }, h('span', { class: 'w-text' }, shortOf(u)), icon('external', 11))
      : h('span', { class: 'w-url plain', role: 'listitem', title: u }, h('span', { class: 'w-text' }, u)));
  }
  return h('div', { class: 'f-row wide top w-row' }, h('span', { class: 'f-label' }, t('detail.websites', null, 'ウェブサイト')), list);
}

function noteRow(note) {
  return h('div', { class: 'f-row wide top' }, h('span', { class: 'f-label' }, 'メモ'), h('div', { class: 'f-note' }, note));
}

/* ───────── templated fields ───────── */

const str = (v) => (v == null ? '' : String(v));

/** "期限切れ" / "あと N 日" next to an expiry (date or card month), null when far away. */
function expiryTag(value) {
  const days = daysUntil(value);
  if (days == null || days > 60) return null;
  if (days < 0) return h('span', { class: 'tag exp-tag over' }, t('detail.expired', null, '期限切れ'));
  return h('span', { class: 'tag exp-tag soon' }, t('detail.expiresIn', { days }, 'あと {days} 日'));
}

function labelEl(label, sub) {
  return h('span', { class: 'f-label', title: label }, sub ? [h('span', { class: 'f-label-t' }, label), h('span', { class: 'f-sub' }, sub)] : label);
}

/**
 * A non-secret value with its copy button. `kind` picks the presentation: url → link opened
 * with chrome.tabs.create (http/https only), multiline → scrollable mono box, else one line.
 */
function plainRow({ key, label, kind, display, copyValue, tag = null }) {
  if (!display) {
    return h('div', { class: 'f-row' }, labelEl(label), h('span', { class: 'f-value empty-val' }, '—'), h('span'));
  }
  const copy = copyButton(key, copyValue, label, { label, secret: false });
  if (kind === 'multiline' || display.includes('\n')) {
    return h('div', { class: 'f-row top' }, labelEl(label),
      h('div', { class: 'ml-box', tabindex: '0', role: 'region', 'aria-label': label }, display), copy);
  }
  let value;
  const href = kind === 'url' ? safeHttpUrl(display) : '';
  if (href) value = h('a', { class: 'f-link', href, target: '_blank', rel: 'noreferrer noopener', title: href, onclick: (e) => openUrl(e, href) }, display);
  else value = h('span', { class: 'f-value', title: display }, display);
  if (tag) value = h('span', { class: 'f-val-line' }, value, tag);
  return h('div', { class: 'f-row' }, labelEl(label), value, copy);
}

function maskOf(v, { card, multiline }) {
  if (card) {
    const d = digitsOnly(v);
    return d.length > 4 ? '•••• •••• •••• ' + d.slice(-4) : masked(v);
  }
  if (multiline) return '•'.repeat(16);
  return masked(v);
}

/**
 * A secret value: masked until the eye reveals it (scramble), copied with clipboard
 * auto-clear. Card numbers are grouped in 4s when shown and copied as digits only;
 * secret-multiline values reveal into the scrollable mono box. `mirror` (an element elsewhere,
 * the card face's CVV) shows the same masked or revealed value.
 */
function secretRow({ key, label, get, multiline = false, card = false, sub = '', mirror = null }) {
  view.scr.add(key);
  const text = h(multiline ? 'div' : 'span', {
    class: multiline ? 'ml-box secret' : 'pw-text' + (card ? ' card-num' : ''), 'aria-label': label,
    ...(multiline ? { tabindex: '0', role: 'region' } : {}),
  });
  const hint = multiline ? h('span', { class: 'ml-hint' }, t('detail.secretHidden', null, '秘密の値 · 表示で確認')) : null;
  const eye = h('button', { class: 'ibtn', type: 'button' });
  const paint = (on, animate) => {
    const v = get();
    eye.classList.toggle('on', on);
    eye.setAttribute('aria-pressed', String(on));
    eye.setAttribute('aria-label', on ? t('detail.hideField', { label }, '{label}を隠す') : t('detail.showField', { label }, '{label}を表示'));
    eye.title = on ? t('detail.hide', null, '隠す') : t('detail.show', null, '表示');
    eye.replaceChildren(icon(on ? 'eyeOff' : 'eye', 14));
    text.classList.toggle('revealed', on);
    if (hint) hint.hidden = on; // a fixed hint: line or word counts would say how long the secret is
    if (on) {
      const target = card ? groupDigits(v) : v;
      if (animate) scramble(key, text, target, multiline ? 420 : 520, card ? DIGITS : undefined);
      else text.textContent = target;
    } else {
      cancelScramble(key);
      text.textContent = maskOf(v, { card, multiline });
    }
    if (mirror) {
      mirror.textContent = on ? v : masked(v);
      mirror.classList.toggle('revealed', on);
    }
  };
  eye.addEventListener('click', () => {
    if (!view) return;
    const on = !view.shown.has(key);
    if (on) view.shown.add(key);
    else view.shown.delete(key);
    paint(on, true);
  });
  paint(view.shown.has(key), false);
  const copy = copyButton(key, () => (card ? digitsOnly(get()) : get()), label, { label, secret: true });
  const btns = h('div', { class: 'f-btns' }, eye, copy);
  if (multiline) return h('div', { class: 'f-row top' }, labelEl(label, sub), h('div', { class: 'ml-col' }, text, hint), btns);
  return h('div', { class: 'f-row' }, labelEl(label, sub), text, btns);
}

/** Display text of a template field: ISO dates through formatIsoDate, select ids through optionLabel. */
function displayOf(typeId, fd, v) {
  if (fd.kind === 'date' || fd.kind === 'month') return formatIsoDate(v, fd.kind);
  if (fd.kind === 'select') return optionLabel(typeId, fd.key, v);
  return v;
}

function fieldRows(it) {
  const rows = [];
  for (const fd of typeOf(it.type).fields) {
    const v = str(it.fields?.[fd.key]);
    if (!v.trim()) continue;
    const label = fieldLabel(it.type, fd.key);
    const get = () => str(itemById(it.id)?.fields?.[fd.key]);
    if (isSecretKind(fd.kind)) {
      const card = fd.format === 'card';
      const mirror = it.type === 'card' && fd.key === 'cvv' ? view.els.faceCvv || null : null; // the card face's CVV
      rows.push(secretRow({ key: 'f:' + fd.key, label, get, multiline: fd.kind === 'secret-multiline', card, sub: card ? cardBrand(v) : '', mirror }));
      continue;
    }
    const display = displayOf(it.type, fd, v);
    rows.push(plainRow({
      key: fd.key, label, kind: fd.kind, display, copyValue: () => displayOf(it.type, fd, get()),
      tag: fd.key === 'expiry' ? expiryTag(v) : null,
    }));
  }
  return rows;
}

/**
 * User-defined fields, after the template (or login) fields, in the same style. A web address
 * in one is a link. `skip` leaves out fields shown elsewhere (a login's URLs: websitesRow).
 */
function extraRows(it, skip = () => false) {
  const rows = [];
  (Array.isArray(it.extra) ? it.extra : []).forEach((x, i) => {
    const value = str(x?.value);
    if (!x || (!value && !x.label) || skip(x)) return;
    const label = str(x.label) || t('detail.extraUntitled', null, '（無題の項目）');
    const get = () => str(itemById(it.id)?.extra?.[i]?.value);
    if (x.secret && value) rows.push(secretRow({ key: 'x:' + i, label, get, multiline: value.includes('\n') }));
    else rows.push(plainRow({ key: 'x:' + i, label, kind: /^https?:\/\//i.test(value.trim()) ? 'url' : 'text', display: value, copyValue: get }));
  });
  return rows;
}

/**
 * The card's face in one line: brand · •••• 1234 · CVV ••• · MM/YY. The CVV stays masked
 * like its field row below and is revealed with that row's eye (secretRow's `mirror`).
 */
function cardLine(it) {
  const x = it.fields || {};
  const num = digitsOnly(x.number);
  const exp = str(x.expiry);
  const cvv = str(x.cvv);
  if (!num && !exp && !cvv) return null;
  const days = daysUntil(exp);
  const brand = cardBrand(num);
  const cvvText = cvv ? h('span', { class: 'cl-cvv-v' }, masked(cvv)) : null;
  view.els.faceCvv = cvvText;
  return h('div', {
    class: 'cardline' + (days != null && days < 0 ? ' expired' : ''), dataset: { f: '' }, vars: { '--h': String(hueOf(it)) },
    'aria-hidden': 'true', // the same facts are in the field rows below
  },
  h('span', { class: 'cl-chip' }),
  h('span', { class: 'cl-brand' }, brand || typeLabel('card')),
  num ? h('span', { class: 'cl-num' }, maskTail(num)) : null,
  h('span', { class: 'grow' }),
  cvv ? h('span', { class: 'cl-cvv' }, h('span', { class: 'cl-k' }, t('detail.cardCvv', null, 'CVV')), cvvText) : null,
  exp ? h('span', { class: 'cl-exp' }, h('span', { class: 'cl-k' }, t('detail.cardExp', null, 'EXP')), formatIsoDate(exp, 'month')) : null,
  exp ? expiryTag(exp) : null);
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
  if (it.type !== 'login') {
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
    h('div', { class: 'welcome-head' },
      h('div', { class: 'welcome-name' }, '保管庫は空です'),
      h('div', { class: 'welcome-sub' }, 'Chrome やほかのパスワードマネージャーから移すか、ひとつずつ追加します。')),
    h('div', null, h('button', { class: 'btn-primary', type: 'button', onclick: () => emit('openImport') },
      icon('import', 13), 'ほかのアプリから読み込む')),
    h('div', { class: 'cmds' },
      cmd('key', '新規ログイン', 'L', 'newLogin'),
      cmd('note', 'セキュアノート', 'N', 'newNote'),
      cmd('regen', 'パスワード生成', 'G', 'openGen', {})),
    h('div', { class: 'hint-line' }, t('detail.welcomeHint', null, 'カードや ID なども ＋ メニューから追加できます')));
}

export function renderDetail({ animate = false, reveal = false } = {}) {
  stopDetail();
  const D = document.getElementById('detail');
  clear(D);
  document.getElementById('cardScroll').scrollTop = 0;
  if (S.picking) {
    renderPicker({ animate });
    return;
  }
  const it = itemById(S.sel);
  if (!it) {
    D.classList.add('is-empty');
    D.append(emptyDetail());
    if (animate) rise(D, '.welcome > *, .hint-line');
    return;
  }
  D.classList.remove('is-empty');
  view = { id: it.id, reveal, totp: null, els: {}, timers: [], shown: new Set(), scr: new Set() };
  D.append(head(it));
  const box = h('div', { class: 'box', dataset: { f: '' } });
  if (it.type === 'login') {
    if (it.pendingPassword?.password) D.append(pendingBox(it)); // the change in progress, rather than the warning
    else if (isWeak(it)) D.append(weakBox(it));
    box.append(userRow(it), passwordRow(it, animate));
    if (it.totp?.secret) box.append(totpRow(it));
    const sites = websitesRow(it);
    if (sites) box.append(sites);
    box.append(...extraRows(it, isUrlExtra));
    if (it.note) box.append(noteRow(it.note));
  } else if (hasTemplate(it.type)) {
    box.classList.add('tpl');
    if (it.type === 'card') {
      const line = cardLine(it);
      if (line) D.append(line);
    }
    box.append(...fieldRows(it), ...extraRows(it));
    if (it.note) box.append(noteRow(it.note));
    if (!box.children.length) {
      box.append(h('div', { class: 'f-row wide' }, h('span', { class: 'f-label' }, '—'),
        h('span', { class: 'f-value empty-val' }, t('detail.noFields', null, 'まだ何も入力されていません'))));
    }
  } else {
    // secure note (and any type this popup does not know yet): title, note, extra
    box.append(noteRow(it.note || ''), ...extraRows(it));
  }
  D.append(box);
  if (it.type === 'login' && it.passkeys?.length) D.append(...passkeysBlock(it));
  if (it.type === 'login') D.append(...historyBlock(it));
  D.append(stats(it));
  if (animate) rise(D);
}

/** After the generator saved a new password: decode it with a long scramble, then the toast. */
export async function showPasswordUpdated(id, { password, label, bits }) {
  setSel(id);
  renderDetail({ reveal: true, animate: true });
  const it = itemById(id);
  if (!view?.els.pwText) return;
  const token = liveToken();
  scramble('pass', view.els.pwText, password, 1000);
  await wait(650);
  if (!live(token) || view?.id !== id) return;
  toast(`${it?.title || ''} のパスワードを更新しました`, `強度: ${label} · ${bits} bit`);
}
