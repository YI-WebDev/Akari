// Item editor (login / secure note) in the 1a field-box language. Replaces the detail pane;
// the list stays visible.

import { MSG } from '../../shared/messages.js';
import { parseOtpauthUri, normalizeSecret, isValidSecret } from '../../lib/totp.js';
import { decodeQrFromDataUrl } from '../../lib/qr.js';
import { S, emit, call, itemById, strengthOf, forSave, mergeSaved, errText } from '../state.js';
import { h, clear, icon } from './dom.js';
import { letterOf, hueOf, vaultColor, safeHttpUrl, siteOf, withScheme } from './format.js';
import { rise, shake } from './fx.js';
import { meterEl, setMeter } from './meter.js';
import { totpView } from './totp-view.js';
import { toast, toastError } from './toast.js';

let E = null;
const $ = (id) => document.getElementById(id);

export const editorOpen = () => !!E;

const TOTP_TEXT_MAX = 200; // the SW rejects longer issuer/label values

/** Parse a pasted base32 secret or otpauth:// URI into a TotpConfig. Throws on invalid input. */
function parseTotpInput(text, { title, username }) {
  const s = String(text || '').trim();
  // whole code points only, staying within the SW's UTF-16 length limit
  const cap = (v) => {
    let out = '';
    for (const ch of String(v || '').trim()) {
      if (out.length + ch.length > TOTP_TEXT_MAX) break;
      out += ch;
    }
    return out;
  };
  if (/^otpauth:/i.test(s)) {
    const cfg = parseOtpauthUri(s); // throws with a Japanese message
    if (!cfg?.secret) throw new Error('URI に秘密鍵（secret）が含まれていません');
    return { ...cfg, issuer: cap(cfg.issuer), label: cap(cfg.label) };
  }
  const secret = normalizeSecret(s);
  if (!isValidSecret(secret)) throw new Error('秘密鍵の形式が正しくありません（Base32 の英字と 2〜7 の数字）');
  return { secret, algorithm: 'SHA1', digits: 6, period: 30, issuer: cap(title), label: cap(username) };
}

function setErr(key, msg) {
  const el = E?.errs[key];
  if (!el) return;
  el.textContent = msg || '';
  el.previousElementSibling?.classList?.toggle('invalid', !!msg);
}

function markDirty() {
  if (E) E.dirty = true;
}

/** One "label | input" row of a field box. The error line sits right after the .field (see setErr). */
function inputField(key, label, input, extra = [], below = []) {
  const err = h('div', { class: 'field-err', role: 'alert' });
  E.errs[key] = err;
  const wrap = h('div', { class: 'field' + (key === 'password' || key === 'totp' ? ' mono' : '') }, input, extra);
  return h('div', { class: 'ed-row' }, h('label', { for: input.id }, label), h('div', { class: 'ed-ctl' }, wrap, err, below));
}

function updateHead() {
  const t = E.els.title.value.trim() || E.original?.title || '';
  const tile = E.els.tile;
  tile.textContent = letterOf(t || (E.type === 'note' ? 'N' : '?'));
  tile.style.setProperty('--h', String(Number.isFinite(E.original?.hue) ? E.original.hue : hueOf({ title: t })));
}

function updateMeter() {
  const pw = E.els.password.value;
  setMeter(E.els.meter, pw ? strengthOf(pw) : {});
}

function setReveal(on) {
  E.reveal = on;
  E.els.password.type = on ? 'text' : 'password';
  const eye = E.els.eye;
  eye.classList.toggle('on', on);
  eye.setAttribute('aria-pressed', String(on));
  eye.setAttribute('aria-label', on ? 'パスワードを隠す' : 'パスワードを表示');
  eye.title = on ? '隠す' : '表示';
  eye.replaceChildren(icon(on ? 'eyeOff' : 'eye', 14));
}

function renderTotp() {
  E.totpView?.stop();
  E.totpView = null;
  const box = E.els.totpBox;
  clear(box);
  setErr('totp', '');
  if (E.totp) {
    const tv = totpView(E.totp);
    E.totpView = tv;
    const meta = [E.totp.issuer, E.totp.label].filter(Boolean).join(' · ') || `${E.totp.digits || 6} 桁 · ${E.totp.period || 30} 秒`;
    tv.col.append(h('span', { class: 'ed-totp-meta', title: meta }, meta));
    const row = h('div', { class: 'ed-totp' },
      tv.col,
      h('button', {
        class: 'ibtn', type: 'button', title: '認証コードを外す', 'aria-label': '認証コードを外す',
        onclick: () => { E.totp = null; markDirty(); renderTotp(); E.els.totpInput?.focus(); },
      }, icon('x', 11, 3)));
    tv.start(row);
    box.append(row);
    E.els.totpInput = null;
    return;
  }
  const input = h('input', {
    id: 'edTotp', type: 'text', placeholder: '秘密鍵 または otpauth:// URI', autocomplete: 'off', spellcheck: 'false',
  });
  const tryParse = (quiet) => {
    const v = input.value.trim();
    if (!v) { setErr('totp', ''); return true; }
    try {
      E.totp = parseTotpInput(v, { title: E.els.title.value.trim(), username: E.els.username?.value.trim() });
      markDirty();
      renderTotp();
      return true;
    } catch (err) {
      if (!quiet) setErr('totp', err?.message || '秘密鍵または URI の形式が正しくありません');
      return false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); tryParse(false); }
  });
  input.addEventListener('paste', () => setTimeout(() => tryParse(false), 0));
  input.addEventListener('blur', () => { if (E?.els.totpInput === input) tryParse(false); });
  input.addEventListener('input', () => setErr('totp', ''));
  E.els.totpInput = input;
  E.els.tryTotp = tryParse;
  const wrap = h('div', { class: 'field mono' }, input);
  const scan = h('button', { class: 'btn-line btn-sm', type: 'button', title: '表示中のタブの QR コードを読み取る' },
    icon('qr', 12), 'QR を読み取る', h('span', { class: 'spinner' }));
  scan.addEventListener('click', () => scanQr(scan));
  box.append(wrap, h('div', { class: 'ed-totp-tools' }, scan));
}

async function scanQr(btn) {
  const mine = E;
  setErr('totp', '');
  btn.classList.add('busy');
  btn.disabled = true;
  try {
    let text = null;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      if (E !== mine) return;
      text = await decodeQrFromDataUrl(dataUrl);
    } catch {
      throw new Error('このタブは読み取れませんでした');
    }
    if (E !== mine) return; // editor closed, replaced or locked meanwhile
    if (!text) throw new Error('このタブに QR コードが見つかりませんでした');
    if (!/^otpauth:\/\//i.test(text)) throw new Error('認証アプリ用の QR コードではありません');
    let cfg;
    try { cfg = parseTotpInput(text, {}); } catch (err) { throw new Error(err?.message || 'QR コードの内容を読み取れませんでした'); }
    E.totp = cfg;
    if (!E.els.title.value.trim() && cfg.issuer) { E.els.title.value = cfg.issuer; updateHead(); }
    if (E.els.username && !E.els.username.value.trim() && cfg.label) E.els.username.value = cfg.label;
    markDirty();
    renderTotp();
    toast('QR コードを読み取りました', [cfg.issuer, cfg.label].filter(Boolean).join(' · ') || null);
  } catch (e) {
    if (E === mine) setErr('totp', e.message);
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

function vaultPicker() {
  const group = h('div', { class: 'vault-pick', role: 'radiogroup', 'aria-label': '保管庫' });
  const render = () => {
    clear(group);
    for (const v of S.vaults) {
      const on = v.id === E.vault;
      group.append(h('button', {
        class: 'vault-chip', type: 'button', role: 'radio', 'aria-checked': String(on),
        onclick: () => { E.vault = v.id; markDirty(); render(); E.els.sub.replaceChildren(...kindLabel()); },
      }, h('span', { class: 'swatch', vars: { '--sw': vaultColor(v.hue) } }), v.name));
    }
  };
  render();
  return h('div', { class: 'ed-row' }, h('div', { class: 'ed-label' }, '保管庫'), h('div', { class: 'ed-ctl' }, group));
}

/** "[個人] ログイン", as in the detail head. */
function kindLabel() {
  const v = S.vaults.find((x) => x.id === E.vault);
  return [h('span', { class: 'd-vault', vars: { '--vc': vaultColor(v?.hue ?? 30) } }, `[${v?.name || '—'}]`),
    h('span', null, E.type === 'note' ? 'セキュアノート' : 'ログイン')];
}

function footIdle() {
  const foot = E.els.foot;
  clear(foot);
  if (E.original) {
    foot.append(h('button', { class: 'btn-text danger', type: 'button', onclick: confirmDelete }, '削除'));
  }
  foot.append(h('span', { class: 'grow' }),
    h('button', { class: 'btn-line', type: 'button', onclick: () => requestClose() }, 'キャンセル'),
    E.els.save);
}

function footConfirm(text, yesLabel, onYes, noLabel = 'やめる') {
  const foot = E.els.foot;
  clear(foot);
  const yes = h('button', { class: 'btn-mini danger', type: 'button' }, yesLabel);
  yes.addEventListener('click', () => onYes(yes));
  foot.append(h('div', { class: 'ed-confirm grow', role: 'alert' },
    h('span', { class: 'pk-q', 'aria-hidden': 'true' }, '?'), h('span', { class: 'grow' }, text), yes,
    h('button', { class: 'btn-mini', type: 'button', onclick: footIdle }, noLabel)));
  yes.focus();
}

function confirmDelete() {
  footConfirm('このアイテムを削除しますか？', '削除する', async (btn) => {
    const mine = E;
    if (!mine || mine.busy) return;
    mine.busy = true;
    btn.disabled = true;
    const { id, title } = mine.original;
    try {
      await call(MSG.VAULT_DELETE_ITEM, { id });
      if (E !== mine) return;
      closeEditor();
      emit('deleted', id, title);
    } catch (e) {
      if (E !== mine) return;
      mine.busy = false;
      btn.disabled = false;
      toastError('削除できませんでした', errText(e));
    }
  });
}

/** Close, asking first when there are unsaved changes. `then` runs after closing. Refused while saving. */
export function requestClose(then) {
  if (!E) { then?.(); return; }
  if (E.busy) {
    shake(E.els.foot);
    return;
  }
  const done = () => {
    closeEditor();
    if (then) then();
    else emit('editorClosed');
  };
  if (!E.dirty) { done(); return; }
  shake(E.els.foot);
  footConfirm('変更を破棄しますか？', '破棄する', done, '編集を続ける');
}

function collect() {
  const els = E.els;
  let firstBad = null;
  const bad = (key, msg, el) => { setErr(key, msg); if (!firstBad) firstBad = el; };
  Object.keys(E.errs).forEach((k) => setErr(k, ''));
  const title = els.title.value.trim();
  const note = els.note.value.replace(/\s+$/, '');
  if (E.type === 'note') {
    if (!title) bad('title', 'タイトルを入力してください', els.title);
    if (firstBad) return { firstBad };
    return { value: { title, note, vault: E.vault, fav: E.fav } };
  }
  const url = withScheme(els.url.value); // "localhost:3000" → "https://localhost:3000"
  if (url && !safeHttpUrl(url)) bad('url', 'http(s) の URL を入力してください', els.url);
  const finalTitle = title || (url && safeHttpUrl(url) ? siteOf(url) : '');
  if (!finalTitle) bad('title', 'タイトルかウェブサイトを入力してください', els.title);
  if (!E.totp && els.totpInput?.value.trim() && !els.tryTotp(false)) {
    if (!firstBad) firstBad = els.totpInput;
  }
  if (firstBad) return { firstBad };
  return {
    value: {
      title: finalTitle, url, username: els.username.value.trim(), password: els.password.value,
      totp: E.totp || null, note, vault: E.vault, fav: E.fav,
    },
  };
}

async function save(e) {
  e.preventDefault();
  if (!E || E.busy) return;
  const r = collect();
  if (r.firstBad) {
    shake(r.firstBad.closest('.ed-row') || r.firstBad);
    r.firstBad.focus();
    return;
  }
  const mine = E;
  mine.busy = true;
  mine.els.save.classList.add('busy');
  const isNew = !mine.original;
  const payload = isNew
    ? { type: mine.type, hue: hueOf({ title: r.value.title }), ...r.value }
    : { ...forSave(mine.original), ...r.value };
  try {
    const res = await call(MSG.VAULT_SAVE_ITEM, { item: payload });
    if (E !== mine) return; // locked (or replaced) while saving
    const saved = mergeSaved(res?.item, mine.original ? { ...mine.original, ...r.value } : payload);
    closeEditor();
    emit('saved', saved, isNew);
  } catch (err) {
    if (E !== mine) return;
    mine.busy = false;
    mine.els.save.classList.remove('busy');
    toastError('保存できませんでした', errText(err));
  }
}

/**
 * openEditor({ id }) edits an item; openEditor({ type: 'login'|'note', prefill: { url, title } }) creates one.
 */
export function openEditor({ id = null, type = 'login', prefill = {} } = {}) {
  closeEditor();
  const original = id ? itemById(id) : null;
  const kind = original?.type === 'note' || (!original && type === 'note') ? 'note' : 'login';
  const src = original || prefill;
  E = {
    original, type: kind, dirty: false, busy: false, reveal: false,
    vault: original?.vault || (S.vault !== 'all' ? S.vault : S.vaults[0]?.id || 'personal'),
    fav: !!original?.fav, totp: original?.totp?.secret ? { ...original.totp } : null,
    els: {}, errs: {}, totpView: null,
  };
  const els = E.els;

  els.tile = h('span', { class: 'tile lg', 'aria-hidden': 'true' });
  els.sub = h('div', { class: 'd-meta' }, kindLabel());
  const fav = h('button', {
    class: 'ibtn boxed fav', type: 'button', title: 'お気に入り', 'aria-label': 'お気に入り', 'aria-pressed': String(E.fav),
  }, icon('star', 14));
  fav.addEventListener('click', () => {
    E.fav = !E.fav;
    markDirty();
    fav.setAttribute('aria-pressed', String(E.fav));
    fav.replaceChildren(icon('star', 14));
  });
  const heading = original
    ? (kind === 'note' ? 'セキュアノートを編集' : 'ログインを編集')
    : (kind === 'note' ? '新規セキュアノート' : '新規ログイン');

  els.title = h('input', { id: 'edTitle', type: 'text', value: src.title || '', placeholder: kind === 'note' ? '例: Wi-Fi のパスワード' : '例: github.com', autocomplete: 'off', maxlength: 200 });
  els.title.addEventListener('input', updateHead);
  els.note = h('textarea', { id: 'edNote', rows: kind === 'note' ? 7 : 3, placeholder: kind === 'note' ? 'ここに書いた内容は暗号化して保存されます' : '', spellcheck: 'false' });
  els.note.value = src.note || '';

  const main = h('div', { class: 'box', dataset: { f: '' } }, inputField('title', 'タイトル', els.title));
  const meta = h('div', { class: 'box', dataset: { f: '' } });
  const scroll = h('div', { class: 'ed-scroll' },
    h('div', { class: 'd-head ed-head', dataset: { f: '' } }, els.tile,
      h('div', { class: 'd-titles' }, h('div', { class: 'ed-heading' }, heading), els.sub), fav),
    main, meta);

  if (kind === 'login') {
    els.url = h('input', { id: 'edUrl', type: 'text', value: src.url || '', placeholder: 'https://example.com/login', autocomplete: 'off', spellcheck: 'false' });
    els.username = h('input', { id: 'edUser', type: 'text', value: src.username || '', placeholder: 'メールアドレスやユーザー名', autocomplete: 'off', spellcheck: 'false' });
    els.password = h('input', { id: 'edPw', type: 'password', value: src.password || '', autocomplete: 'new-password', spellcheck: 'false' });
    els.password.addEventListener('input', updateMeter);
    els.eye = h('button', { class: 'ibtn', type: 'button', title: '表示', 'aria-label': 'パスワードを表示', 'aria-pressed': 'false', onclick: () => setReveal(!E.reveal) }, icon('eye', 14));
    const gen = h('button', { class: 'ibtn', type: 'button', title: 'パスワード生成', 'aria-label': 'パスワード生成' }, icon('regen', 14));
    gen.addEventListener('click', () => emit('openGen', {
      source: 'editor',
      title: els.title.value.trim(),
      onUse: (pw) => {
        if (!E) return;
        els.password.value = pw;
        setReveal(true);
        updateMeter();
        markDirty();
        setErr('password', '');
      },
    }));
    els.meter = meterEl('ed-meter');
    els.totpBox = h('div', { class: 'ed-totp-box' });
    E.errs.totp = h('div', { class: 'field-err', role: 'alert' });
    main.append(
      inputField('url', 'URL', els.url),
      inputField('username', 'ユーザー名', els.username),
      inputField('password', 'パスワード', els.password, [els.eye, gen], [els.meter]),
      h('div', { class: 'ed-row' }, h('div', { class: 'ed-label' }, '認証コード'), h('div', { class: 'ed-ctl' }, els.totpBox, E.errs.totp)),
    );
  }
  meta.append(vaultPicker(),
    h('div', { class: 'ed-row' }, h('label', { for: 'edNote' }, 'メモ'), h('div', { class: 'ed-ctl' }, h('div', { class: 'field' }, els.note))));

  els.save = h('button', { class: 'btn-primary', type: 'submit' }, h('span', { class: 'go-label' }, '保存'), h('span', { class: 'spinner' }));
  els.foot = h('div', { class: 'ed-foot' });
  const form = h('form', { class: 'ed-form', novalidate: true, 'aria-label': heading }, scroll, els.foot);
  form.addEventListener('submit', save);
  form.addEventListener('input', markDirty);

  const host = $('editor');
  clear(host);
  host.append(form);
  footIdle();
  updateHead();
  if (kind === 'login') {
    updateMeter();
    renderTotp();
  }
  $('cardScroll').hidden = true;
  host.hidden = false;
  rise(scroll);
  setTimeout(() => (original ? els.title : (kind === 'login' && els.title.value ? els.username : els.title))?.focus({ preventScroll: true }), 80);
}

export function closeEditor() {
  if (!E) return;
  E.totpView?.stop();
  E = null;
  const host = $('editor');
  clear(host);
  host.hidden = true;
  $('cardScroll').hidden = false;
}
