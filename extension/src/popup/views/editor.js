import { MSG } from '../../shared/messages.js';
import {
  typeOf, typeLabel, fieldLabel, optionLabel, hasTemplate, isSecretKind, cardBrand, personName, LIMITS,
} from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { parseOtpauthUri, normalizeSecret, isValidSecret } from '../../lib/totp.js';
import { decodeQrFromDataUrl } from '../../lib/qr.js';
import { S, emit, call, itemById, strengthOf, forSave, mergeSaved, errText } from '../state.js';
import { h, clear, icon, isComposing } from './dom.js';
import {
  letterOf, hueOf, vaultColor, safeHttpUrl, siteOf, withScheme, formatIsoDate, parseDateInput, parseMonthInput,
  digitsOnly, groupDigits,
} from './format.js';
import { rise, shake } from './fx.js';
import { meterEl, setMeter } from './meter.js';
import { totpView } from './totp-view.js';
import { toast, toastError } from './toast.js';
import { TEL_RE } from '../../lib/vault/items.js';

let E = null;
const $ = (id) => document.getElementById(id);

export const editorOpen = () => !!E;

const TOTP_TEXT_MAX = 200;
const DEFAULT_TOTP_DIGITS = 6;
const DEFAULT_TOTP_PERIOD = 30;
const TITLE_MAX_LENGTH = 200;
const CARD_DIGITS_MIN = 8;
const CARD_DIGITS_MAX = 19;
const EXTRA_VALUE_MAX_HEIGHT_PX = 120;
const INITIAL_FOCUS_DELAY_MS = 80;
const GEN_FIELDS = { wifi: 'password', database: 'password', server: 'password', cryptoWallet: 'password' };

function parseTotpInput(text, { title, username }) {
  const s = String(text || '').trim();
  const clampTotpText = (v) => {
    let out = '';
    for (const ch of String(v || '').trim()) {
      if (out.length + ch.length > TOTP_TEXT_MAX) break;
      out += ch;
    }
    return out;
  };
  if (/^otpauth:/i.test(s)) {
    const cfg = parseOtpauthUri(s);
    if (!cfg?.secret) throw new Error(t('URI に秘密鍵（secret）が含まれていません'));
    return { ...cfg, issuer: clampTotpText(cfg.issuer), label: clampTotpText(cfg.label) };
  }
  const secret = normalizeSecret(s);
  if (!isValidSecret(secret)) throw new Error(t('秘密鍵の形式が正しくありません（Base32 の英字と 2〜7 の数字）'));
  return { secret, algorithm: 'SHA1', digits: DEFAULT_TOTP_DIGITS, period: DEFAULT_TOTP_PERIOD, issuer: clampTotpText(title), label: clampTotpText(username) };
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

function inputField(key, label, input, extra = [], below = [], { mono = key === 'password' || key === 'totp' } = {}) {
  const err = h('div', { class: 'field-err', role: 'alert' });
  E.errs[key] = err;
  const wrap = h('div', { class: 'field' + (mono ? ' mono' : '') }, input, extra);
  return h('div', { class: 'ed-row' }, h('label', { for: input.id, title: label }, label), h('div', { class: 'ed-ctl' }, wrap, err, below));
}

function revealButton(el, label, { onToggle } = {}) {
  const eye = h('button', { class: 'ibtn', type: 'button' });
  const set = (on) => {
    if (el.tagName === 'TEXTAREA') el.classList.toggle('masked', !on);
    else el.type = on ? 'text' : 'password';
    eye.classList.toggle('on', on);
    eye.setAttribute('aria-pressed', String(on));
    eye.setAttribute('aria-label', on ? t('detail.hideField', { label }, '{label}を隠す') : t('detail.showField', { label }, '{label}を表示'));
    eye.title = on ? t('detail.hide', null, '隠す') : t('detail.show', null, '表示');
    eye.replaceChildren(icon(on ? 'eyeOff' : 'eye', 14));
    onToggle?.(on);
  };
  let on = false;
  eye.addEventListener('click', () => { on = !on; set(on); });
  set(false);
  return { eye, show: () => { on = true; set(true); } };
}

function derivedTitle() {
  if (!E?.templated) return '';
  const v = (k) => String(E.fields.get(k)?.read() ?? '').trim();
  switch (E.type) {
    case 'card': {
      const n = digitsOnly(v('number'));
      return [cardBrand(n), n.length >= 4 ? '•••• ' + n.slice(-4) : ''].filter(Boolean).join(' ') || v('cardholder');
    }
    case 'identity': return v('fullName') || personName(v('firstName'), v('middleName'), v('lastName'));
    case 'softwareLicense': return v('product');
    case 'apiCredential': case 'server': case 'sshKey': return v('host');
    case 'database': return v('database') || v('host');
    case 'wifi': return v('ssid');
    case 'bankAccount': return v('bankName');
    case 'cryptoWallet': return v('network');
    case 'medicalRecord': return v('patientName') || v('provider');
    case 'membership': return v('organization');
    case 'rewardProgram': return v('company');
    default: return '';
  }
}

function updateHead() {
  const typed = E.els.title.value.trim();
  const auto = derivedTitle();
  if (E.templated) E.els.title.placeholder = auto || t('editor.titleAuto', { type: typeLabel(E.type) }, '空欄なら「{type}」');
  const shownTitle = typed || E.original?.title || auto;
  const tile = E.els.tile;
  tile.textContent = letterOf(shownTitle || (E.type === 'note' ? 'N' : '?'));
  tile.style.setProperty('--h', String(Number.isFinite(E.original?.hue) ? E.original.hue : hueOf({ title: shownTitle })));
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
  eye.setAttribute('aria-label', on ? t('パスワードを隠す') : t('パスワードを表示'));
  eye.title = on ? t('detail.hide', null, '隠す') : t('detail.show', null, '表示');
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
    const meta = [E.totp.issuer, E.totp.label].filter(Boolean).join(' · ')
      || t('{digits} 桁 · {period} 秒', { digits: E.totp.digits || DEFAULT_TOTP_DIGITS, period: E.totp.period || DEFAULT_TOTP_PERIOD });
    tv.col.append(h('span', { class: 'ed-totp-meta', title: meta }, meta));
    const row = h('div', { class: 'ed-totp' },
      tv.col,
      h('button', {
        class: 'ibtn', type: 'button', title: t('認証コードを外す'), 'aria-label': t('認証コードを外す'),
        onclick: () => { E.totp = null; markDirty(); renderTotp(); E.els.totpInput?.focus(); },
      }, icon('x', 11, 3)));
    tv.start(row);
    box.append(row);
    E.els.totpInput = null;
    return;
  }
  const input = h('input', {
    id: 'edTotp', type: 'text', placeholder: t('秘密鍵 または otpauth:// URI'), autocomplete: 'off', spellcheck: 'false',
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
      if (!quiet) setErr('totp', err?.message || t('秘密鍵または URI の形式が正しくありません'));
      return false;
    }
  };
  input.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); tryParse(false); }
  });
  input.addEventListener('paste', () => setTimeout(() => tryParse(false), 0));
  input.addEventListener('blur', () => { if (E?.els.totpInput === input) tryParse(false); });
  input.addEventListener('input', () => setErr('totp', ''));
  E.els.totpInput = input;
  E.els.tryTotp = tryParse;
  const wrap = h('div', { class: 'field mono' }, input);
  const scan = h('button', { class: 'btn-line btn-sm', type: 'button', title: t('表示中のタブの QR コードを読み取る') },
    icon('qr', 12), t('QR を読み取る'), h('span', { class: 'spinner' }));
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
      throw new Error(t('このタブは読み取れませんでした'));
    }
    if (E !== mine) return;
    if (!text) throw new Error(t('このタブに QR コードが見つかりませんでした'));
    if (!/^otpauth:\/\//i.test(text)) throw new Error(t('認証アプリ用の QR コードではありません'));
    let cfg;
    try { cfg = parseTotpInput(text, {}); } catch (err) { throw new Error(err?.message || t('QR コードの内容を読み取れませんでした')); }
    E.totp = cfg;
    if (!E.els.title.value.trim() && cfg.issuer) { E.els.title.value = cfg.issuer; updateHead(); }
    if (E.els.username && !E.els.username.value.trim() && cfg.label) E.els.username.value = cfg.label;
    markDirty();
    renderTotp();
    toast(t('QR コードを読み取りました'), [cfg.issuer, cfg.label].filter(Boolean).join(' · ') || null);
  } catch (e) {
    if (E === mine) setErr('totp', e.message);
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

const FORMAT_ERR = {
  date: () => t('editor.err.date', null, '日付は YYYY-MM-DD の形式で入力してください'),
  month: () => t('editor.err.month', null, 'MM/YYYY（または MM/YY）の形式で入力してください'),
  number: () => t('editor.err.number', null, '数字で入力してください'),
  url: () => t('editor.err.url', null, 'http(s) の URL を入力してください'),
  email: () => t('editor.err.email', null, 'メールアドレスの形式を確認してください'),
  tel: () => t('editor.err.tel', null, '電話番号は数字と + ( ) - で入力してください'),
  card: () => t('editor.err.card', null, 'カード番号は 8〜19 桁の数字で入力してください'),
};
const PLACEHOLDER = { date: 'YYYY-MM-DD', month: 'MM/YYYY', url: 'https://', email: 'name@example.com' };

function selectField(fd, raw) {
  const label = fieldLabel(E.type, fd.key);
  let cur = fd.options.some((o) => o.id === raw) ? raw : '';
  let touched = false;
  const group = h('div', { class: 'vault-pick opt-pick', role: 'radiogroup', 'aria-label': label, id: 'edF-' + fd.key });
  const opts = fd.options.map((o) => ({ id: o.id, text: optionLabel(E.type, fd.key, o.id) }));
  const paint = () => group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.opt === cur)));
  for (const o of opts) {
    group.append(h('button', {
      class: 'vault-chip', type: 'button', role: 'radio', dataset: { opt: o.id },
      onclick: () => { cur = cur === o.id ? '' : o.id; touched = true; markDirty(); paint(); },
    }, o.text));
  }
  paint();
  const row = h('div', { class: 'ed-row' }, h('div', { class: 'ed-label' }, label), h('div', { class: 'ed-ctl' }, group));
  return { row, read: () => cur, validate: () => ({ value: touched ? cur : str(raw) }), focusEl: group };
}

function templateField(fd, raw) {
  if (fd.kind === 'select') return selectField(fd, raw);
  const key = fd.key;
  const errKey = 'f:' + key;
  const id = 'edF-' + key;
  const label = fieldLabel(E.type, key);
  const secret = isSecretKind(fd.kind);
  const card = fd.format === 'card';
  const multi = fd.kind === 'multiline' || fd.kind === 'secret-multiline';
  const max = multi ? LIMITS.multilineValue : LIMITS.fieldValue;
  const stored = str(raw);
  let shown = stored;
  if (fd.kind === 'month') shown = formatIsoDate(stored, 'month', { fullYear: true });
  else if (card) shown = groupDigits(stored) || stored;

  let input;
  if (multi) {
    input = h('textarea', { id, rows: fd.kind === 'secret-multiline' ? 4 : 3, spellcheck: 'false', maxlength: max, class: secret ? 'masked' : '' });
  } else {
    input = h('input', {
      id, type: secret ? 'password' : 'text', autocomplete: secret ? 'new-password' : 'off', spellcheck: 'false', maxlength: max,
      placeholder: PLACEHOLDER[fd.kind] || '',
      inputmode: card || fd.kind === 'number' || key === 'cvv' ? 'numeric' : fd.kind === 'email' ? 'email' : fd.kind === 'tel' ? 'tel' : null,
    });
  }
  input.value = shown;
  let touched = false;
  input.addEventListener('input', () => { touched = true; setErr(errKey, ''); });

  const extra = [];
  if (card) {
    const brand = h('span', { class: 'tag ed-brand' });
    const paintBrand = () => { brand.textContent = cardBrand(input.value); brand.hidden = !brand.textContent; };
    input.addEventListener('input', paintBrand);
    paintBrand();
    extra.push(brand);
  }
  let reveal = null;
  if (secret) {
    reveal = revealButton(input, label);
    extra.push(reveal.eye);
  }
  if (GEN_FIELDS[E.type] === key) {
    const mine = E;
    const genLabel = t('editor.generate', null, 'パスワード生成');
    const gen = h('button', { class: 'ibtn', type: 'button', title: genLabel, 'aria-label': genLabel }, icon('regen', 14));
    gen.addEventListener('click', () => emit('openGen', {
      source: 'editor',
      title: E.els.title.value.trim() || derivedTitle() || typeLabel(E.type),
      onUse: (pw) => {
        if (E !== mine) return;
        input.value = pw;
        touched = true;
        reveal?.show();
        markDirty();
        setErr(errKey, '');
      },
    }));
    extra.push(gen);
  }

  if (fd.kind === 'date' || fd.kind === 'month' || card) {
    input.addEventListener('blur', () => {
      if (!E || !touched) return;
      if (fd.kind === 'date') { const v = parseDateInput(input.value); if (v) input.value = v; }
      else if (fd.kind === 'month') { const v = parseMonthInput(input.value); if (v) input.value = formatIsoDate(v, 'month', { fullYear: true }); }
      else if (/^[\d\s-]+$/.test(input.value.normalize('NFKC'))) input.value = groupDigits(input.value);
    });
  }

  const validate = () => {
    if (!touched) return { value: stored };
    const v = input.value;
    if (fd.kind === 'date') { const d = parseDateInput(v); return d == null ? { error: FORMAT_ERR.date() } : { value: d }; }
    if (fd.kind === 'month') { const d = parseMonthInput(v); return d == null ? { error: FORMAT_ERR.month() } : { value: d }; }
    if (card) {
      const s = v.normalize('NFKC').trim();
      if (!s) return { value: '' };
      const d = digitsOnly(s);
      return /^[\d\s-]+$/.test(s) && d.length >= CARD_DIGITS_MIN && d.length <= CARD_DIGITS_MAX ? { value: d } : { error: FORMAT_ERR.card() };
    }
    if (secret || multi) return { value: v.replace(/\r\n?/g, '\n') };
    const s = v.trim();
    if (!s) return { value: '' };
    if (fd.kind === 'number') {
      const d = s.normalize('NFKC');
      return /^\d+$/.test(d) ? { value: d } : { error: FORMAT_ERR.number() };
    }
    if (fd.kind === 'url') {
      const u = withScheme(s);
      return safeHttpUrl(u) ? { value: u } : { error: FORMAT_ERR.url() };
    }
    if (fd.kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(s)) return { error: FORMAT_ERR.email() };
    if (fd.kind === 'tel' && (!TEL_RE.test(s) || !/\p{Nd}/u.test(s))) return { error: FORMAT_ERR.tel() };
    return { value: s };
  };

  const mono = secret || multi || card || ['number', 'date', 'month', 'tel'].includes(fd.kind);
  const row = inputField(errKey, label, input, extra, [], { mono });
  return { row, read: () => input.value, validate, focusEl: input };
}

const str = (v) => (v == null ? '' : String(v));

let extraSeq = 0;

function extraRow(x = {}) {
  const uid = ++extraSeq;
  const errKey = 'x:' + uid;
  const labelIn = h('input', {
    class: 'ex-label', type: 'text', maxlength: LIMITS.extraLabel, autocomplete: 'off', spellcheck: 'false',
    placeholder: t('editor.extraLabel', null, '項目名'), 'aria-label': t('editor.extraLabel', null, '項目名'),
  });
  labelIn.value = str(x.label);
  const value = h('textarea', {
    class: 'ex-value', rows: 1, maxlength: LIMITS.extraValue, spellcheck: 'false', placeholder: t('editor.extraValue', null, '値'),
  });
  value.value = str(x.value);
  const nameValue = () => t('editor.extraValueOf', { label: labelIn.value.trim() || t('editor.extraLabel', null, '項目名') }, '{label} の値');
  value.setAttribute('aria-label', nameValue());
  labelIn.addEventListener('input', () => { value.setAttribute('aria-label', nameValue()); setErr(errKey, ''); });
  const grow = () => {
    value.style.height = 'auto';
    value.style.height = Math.min(value.scrollHeight, EXTRA_VALUE_MAX_HEIGHT_PX) + 'px';
  };
  value.addEventListener('input', grow);

  const entry = { uid, labelIn, value, secret: !!x.secret, touched: !('value' in x) };
  for (const el of [labelIn, value]) el.addEventListener('input', () => { entry.touched = true; });
  const { eye } = revealButton(value, labelIn.value.trim() || t('editor.extraValue', null, '値'));
  const tgl = h('button', {
    class: 'tgl ex-secret', type: 'button', role: 'switch', 'aria-checked': String(entry.secret),
    title: t('editor.extraSecretHint', null, '秘密にすると伏せて表示し、コピー後にクリップボードから消去します'),
  }, h('span', { class: 'tgl-mark', 'aria-hidden': 'true' }), t('editor.extraSecret', null, '秘密'));
  const paintSecret = () => {
    tgl.setAttribute('aria-checked', String(entry.secret));
    eye.hidden = !entry.secret;
    if (!entry.secret) value.classList.remove('masked');
    else if (eye.getAttribute('aria-pressed') !== 'true') value.classList.add('masked');
  };
  tgl.addEventListener('click', () => { entry.secret = !entry.secret; markDirty(); paintSecret(); });
  paintSecret();
  const remove = h('button', {
    class: 'ibtn', type: 'button', title: t('editor.extraRemove', null, '項目を削除'), 'aria-label': t('editor.extraRemove', null, '項目を削除'),
  }, icon('x', 11, 3));
  const err = h('div', { class: 'field-err', role: 'alert' });
  E.errs[errKey] = err;
  entry.row = h('div', { class: 'ed-row ex-row', dataset: { x: String(uid) } },
    h('div', { class: 'ex-name' }, labelIn),
    h('div', { class: 'ed-ctl' }, h('div', { class: 'field' }, value, eye, tgl, remove), err));
  remove.addEventListener('click', () => {
    const i = E.extras.indexOf(entry);
    E.extras.splice(i, 1);
    entry.row.remove();
    delete E.errs[errKey];
    markDirty();
    paintExtras();
    const next = E.extras[i] || E.extras[i - 1];
    (next ? next.labelIn : E.els.extraAdd).focus();
  });
  entry.errKey = errKey;
  setTimeout(grow, 0);
  return entry;
}

function paintExtras() {
  E.els.extraCount.textContent = E.extras.length ? String(E.extras.length) : '';
  E.els.extraAdd.disabled = E.extras.length >= LIMITS.extraCount;
}

function extrasBox(list) {
  const count = h('span', { class: 'ex-count' });
  const add = h('button', { class: 'btn-line btn-sm', type: 'button' }, icon('plus', 11, 2.6), t('editor.extraAdd', null, '項目を追加'));
  E.els.extraCount = count;
  E.els.extraAdd = add;
  const rows = h('div', { class: 'ex-rows' });
  E.extras = [];
  for (const x of list) {
    const entry = extraRow(x);
    E.extras.push(entry);
    rows.append(entry.row);
  }
  add.addEventListener('click', () => {
    if (E.extras.length >= LIMITS.extraCount) return;
    const entry = extraRow();
    E.extras.push(entry);
    rows.append(entry.row);
    markDirty();
    paintExtras();
    entry.labelIn.focus();
    rise(rows, `[data-x="${entry.uid}"]`);
  });
  paintExtras();
  return h('div', { class: 'box ex-box', dataset: { f: '' } },
    h('div', { class: 'ed-row ex-head' },
      h('div', { class: 'ed-label' }, t('editor.extra', null, '追加の項目'), ' ', count),
      h('div', { class: 'ex-tools' }, add)),
    rows);
}

function vaultPicker() {
  const group = h('div', { class: 'vault-pick', role: 'radiogroup', 'aria-label': t('vaults.label', null, '保管庫') });
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
  return h('div', { class: 'ed-row' }, h('div', { class: 'ed-label' }, t('vaults.label', null, '保管庫')), h('div', { class: 'ed-ctl' }, group));
}

function kindLabel() {
  const v = S.vaults.find((x) => x.id === E.vault);
  return [h('span', { class: 'd-vault', vars: { '--vc': vaultColor(v?.hue ?? 30) } }, `[${v?.name || '—'}]`),
    h('span', null, typeLabel(E.type))];
}

function footIdle() {
  const foot = E.els.foot;
  clear(foot);
  if (E.original) {
    foot.append(h('button', { class: 'btn-text danger', type: 'button', onclick: confirmDelete }, t('削除')));
  }
  foot.append(h('span', { class: 'grow' }),
    h('button', { class: 'btn-line', type: 'button', onclick: () => requestClose() }, t('キャンセル')),
    E.els.save);
}

function footConfirm(text, yesLabel, onYes, noLabel = t('やめる')) {
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
  const pk = E.original?.passkeys?.length || 0;
  const ask = pk
    ? t('trash.askPasskeys', { n: pk }, 'パスキー {n} 件も一緒にゴミ箱に移ります。ゴミ箱にある間は、そのサイトにパスキーでサインインできません')
    : t('trash.ask', null, 'ゴミ箱に移しますか？ 30 日間は元に戻せます');
  footConfirm(ask, t('削除する'), async (btn) => {
    const mine = E;
    if (!mine || mine.busy) return;
    mine.busy = true;
    btn.disabled = true;
    const { id, title } = mine.original;
    try {
      const res = await call(MSG.VAULT_DELETE_ITEM, { id });
      if (E !== mine) return;
      closeEditor();
      emit('trashed', [id], { title, trash: res?.trash });
    } catch (e) {
      if (E !== mine) return;
      mine.busy = false;
      btn.disabled = false;
      toastError(t('削除できませんでした'), errText(e));
    }
  });
}

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
  footConfirm(t('変更を破棄しますか？'), t('破棄する'), done, t('編集を続ける'));
}

function collectExtras(bad) {
  const out = [];
  for (const x of E.extras) {
    const label = x.labelIn.value.trim();
    const value = x.value.value.replace(/\r\n?/g, '\n');
    if (!label && !value.trim()) continue;
    if (!label && x.touched) { bad(x.errKey, t('editor.err.extraLabel', null, '項目名を入力してください'), x.labelIn); continue; }
    out.push({ label, value, secret: !!x.secret });
  }
  return out;
}

function collect() {
  const els = E.els;
  const problems = [];
  const bad = (key, msg, el) => { setErr(key, msg); problems.push(el); };
  Object.keys(E.errs).forEach((k) => setErr(k, ''));
  const title = els.title.value.trim();
  const note = els.note.value.replace(/\s+$/, '');
  const extra = collectExtras(bad);
  const firstBad = () => problems.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];

  if (E.type === 'note' || (!E.templated && E.type !== 'login')) {
    if (!title) bad('title', t('タイトルを入力してください'), els.title);
    if (problems.length) return { firstBad: firstBad() };
    return { value: { title, note, vault: E.vault, fav: E.fav, extra } };
  }

  if (E.templated) {
    const fields = {};
    let filled = false;
    for (const [key, f] of E.fields) {
      const r = f.validate();
      if (String(f.read() ?? '').trim()) filled = true;
      if (r.error) bad('f:' + key, r.error, f.focusEl);
      else fields[key] = r.value;
    }
    let finalTitle = title || derivedTitle();
    if (!finalTitle && (filled || note || extra.length)) finalTitle = typeLabel(E.type);
    if (!finalTitle) bad('title', t('editor.err.empty', null, 'タイトルか項目を入力してください'), els.title);
    if (problems.length) return { firstBad: firstBad() };
    return { value: { title: finalTitle, fields, note, vault: E.vault, fav: E.fav, extra } };
  }

  const url = withScheme(els.url.value);
  if (url && !safeHttpUrl(url)) bad('url', t('http(s) の URL を入力してください'), els.url);
  const finalTitle = title || (url && safeHttpUrl(url) ? siteOf(url) : '');
  if (!finalTitle) bad('title', t('タイトルかウェブサイトを入力してください'), els.title);
  if (!E.totp && els.totpInput?.value.trim() && !els.tryTotp(false)) problems.push(els.totpInput);
  if (problems.length) return { firstBad: firstBad() };
  return {
    value: {
      title: finalTitle, url, username: els.username.value.trim(), password: els.password.value,
      totp: E.totp || null, note, vault: E.vault, fav: E.fav, extra,
    },
  };
}

async function save(e) {
  e.preventDefault();
  if (!E || E.busy) return;
  const r = collect();
  if (r.firstBad) {
    shake(r.firstBad.closest('.ed-row') || r.firstBad);
    (r.firstBad.matches('[role="radiogroup"]') ? r.firstBad.querySelector('button') : r.firstBad).focus();
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
    if (E !== mine) return;
    const saved = mergeSaved(res?.item, mine.original ? { ...mine.original, ...r.value } : payload);
    closeEditor();
    emit('saved', saved, isNew);
  } catch (err) {
    if (E !== mine) return;
    mine.busy = false;
    mine.els.save.classList.remove('busy');
    toastError(t('保存できませんでした'), errText(err));
  }
}

export function openEditor({ id = null, type = 'login', prefill = {} } = {}) {
  closeEditor();
  const original = id ? itemById(id) : null;
  const kind = original ? String(original.type || 'login') : (typeOf(type) ? type : 'login');
  const templated = hasTemplate(kind);
  const src = original || prefill;
  E = {
    original, type: kind, templated, dirty: false, busy: false, reveal: false,
    vault: original?.vault || (S.vault !== 'all' ? S.vault : S.vaults[0]?.id || 'personal'),
    fav: !!original?.fav, totp: original?.totp?.secret ? { ...original.totp } : null,
    els: {}, errs: {}, totpView: null, fields: new Map(), extras: [],
  };
  const els = E.els;

  els.tile = h('span', { class: 'tile lg', 'aria-hidden': 'true' });
  els.sub = h('div', { class: 'd-meta' }, kindLabel());
  const fav = h('button', {
    class: 'ibtn boxed fav', type: 'button', title: t('お気に入り'), 'aria-label': t('お気に入り'), 'aria-pressed': String(E.fav),
  }, icon('star', 14));
  fav.addEventListener('click', () => {
    E.fav = !E.fav;
    markDirty();
    fav.setAttribute('aria-pressed', String(E.fav));
    fav.replaceChildren(icon('star', 14));
  });
  const heading = original
    ? t('editor.edit', { type: typeLabel(kind) }, '{type}を編集')
    : t('editor.new', { type: typeLabel(kind) }, '新規{type}');

  const titlePh = kind === 'note' ? t('例: Wi-Fi のパスワード') : kind === 'login' ? t('例: github.com') : '';
  els.title = h('input', { id: 'edTitle', type: 'text', value: src.title || '', placeholder: titlePh, autocomplete: 'off', maxlength: TITLE_MAX_LENGTH });
  els.title.addEventListener('input', updateHead);
  els.note = h('textarea', { id: 'edNote', rows: kind === 'note' ? 7 : 3, placeholder: kind === 'note' ? t('ここに書いた内容は暗号化して保存されます') : '', spellcheck: 'false' });
  els.note.value = src.note || '';
  const noteRow = h('div', { class: 'ed-row' }, h('label', { for: 'edNote' }, t('メモ')), h('div', { class: 'ed-ctl' }, h('div', { class: 'field' }, els.note)));

  const main = h('div', { class: 'box', dataset: { f: '' } }, inputField('title', t('タイトル'), els.title));
  const meta = h('div', { class: 'box', dataset: { f: '' } }, vaultPicker());

  if (kind === 'login') {
    els.url = h('input', { id: 'edUrl', type: 'text', value: src.url || '', placeholder: 'https://example.com/login', autocomplete: 'off', spellcheck: 'false' });
    els.username = h('input', { id: 'edUser', type: 'text', value: src.username || '', placeholder: t('メールアドレスやユーザー名'), autocomplete: 'off', spellcheck: 'false' });
    els.password = h('input', { id: 'edPw', type: 'password', value: src.password || '', autocomplete: 'new-password', spellcheck: 'false' });
    els.password.addEventListener('input', updateMeter);
    els.eye = h('button', {
      class: 'ibtn', type: 'button', title: t('detail.show', null, '表示'), 'aria-label': t('パスワードを表示'), 'aria-pressed': 'false', onclick: () => setReveal(!E.reveal),
    }, icon('eye', 14));
    const genLabel = t('editor.generate', null, 'パスワード生成');
    const gen = h('button', { class: 'ibtn', type: 'button', title: genLabel, 'aria-label': genLabel }, icon('regen', 14));
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
      inputField('username', t('ユーザー名'), els.username),
      inputField('password', t('パスワード'), els.password, [els.eye, gen], [els.meter]),
      h('div', { class: 'ed-row' }, h('div', { class: 'ed-label' }, t('認証コード')), h('div', { class: 'ed-ctl' }, els.totpBox, E.errs.totp)),
    );
    meta.append(noteRow);
  } else if (templated) {
    for (const fd of typeOf(kind).fields) {
      const f = templateField(fd, original?.fields?.[fd.key] ?? '');
      E.fields.set(fd.key, f);
      main.append(f.row);
    }
    meta.append(noteRow);
  } else {
    main.append(noteRow);
  }

  const scroll = h('div', { class: 'ed-scroll' },
    h('div', { class: 'd-head ed-head', dataset: { f: '' } }, els.tile,
      h('div', { class: 'd-titles' }, h('div', { class: 'ed-heading' }, heading), els.sub), fav),
    main, extrasBox(Array.isArray(original?.extra) ? original.extra : []), meta);

  els.save = h('button', { class: 'btn-primary', type: 'submit' }, h('span', { class: 'go-label' }, t('保存')), h('span', { class: 'spinner' }));
  els.foot = h('div', { class: 'ed-foot' });
  const form = h('form', { class: 'ed-form', novalidate: true, 'aria-label': heading, dataset: { type: kind } }, scroll, els.foot);
  form.addEventListener('submit', save);
  form.addEventListener('input', () => {
    markDirty();
    if (E?.templated) updateHead();
  });

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
  setTimeout(() => (original ? els.title : (kind === 'login' && els.title.value ? els.username : els.title))?.focus({ preventScroll: true }), INITIAL_FOCUS_DELAY_MS);
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
