import { LIMITS, extraKind } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';
import { parseOtpauthUri, normalizeSecret, isValidSecret } from '../../lib/totp.js';
import { itemById } from '../state.js';
import { h, clear, icon, svgEl, isComposing } from './dom.js';
import { formatIsoDate, parseDateInput } from './format.js';
import { rise, reducedMotion } from './fx.js';
import { totpView } from './totp-view.js';

const VALUE_MAX_HEIGHT_PX = 120;
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;
const ORDER = ['text', 'hidden', 'totp', 'date'];

const KINDS = {
  text: { icon: 'text', name: () => t('テキスト'), desc: () => t('会員番号やメモ') },
  hidden: { icon: 'eyeOff', name: () => t('秘密'), desc: () => t('伏せて表示（暗証番号など）') },
  totp: { icon: 'otp', name: () => t('認証コード'), desc: () => t('6 桁のコードを作る') },
  date: { icon: 'calendar', name: () => t('日付'), desc: () => t('日付として表示') },
};

const str = (v) => (v == null ? '' : String(v));
const fieldName = () => t('editor.extraLabel', null, '項目名');
const dateError = () => t('日付として読めません（例: 2026-04-01）');
const totpFallbackError = () => t('秘密鍵または URI の形式が正しくありません');
const lineError = () => t('改行を含む値は使えません（1 行で入力してください）');
const multiLine = (s) => str(s).trim().includes('\n');
const oneLine = (s) => str(s).replace(/\r\n?|\n/g, ' ');

function parseTotpValue(text) {
  const s = str(text).trim();
  if (/^otpauth:/i.test(s)) return { cfg: parseOtpauthUri(s), value: s };
  const secret = normalizeSecret(s);
  if (!isValidSecret(secret)) throw new Error(t('秘密鍵の形式が正しくありません（Base32 の英字と 2〜7 の数字）'));
  return { cfg: { secret, algorithm: 'SHA1', digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, issuer: '', label: '' }, value: secret };
}

function tryTotp(text) {
  try { return parseTotpValue(text); } catch { return null; }
}

function totpError(text) {
  try { parseTotpValue(text); return ''; } catch (err) { return err?.message || totpFallbackError(); }
}

function chevDown() {
  const svg = svgEl('svg', { width: 10, height: 10, viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'xf-chev' });
  svg.append(svgEl('path', { d: 'm6 9 6 6 6-6' }));
  return svg;
}

let seq = 0;

export function createExtrasEditor({ list = [], errs, onDirty = () => {}, type = '' }) {
  const entries = [];
  const dirty = () => onDirty();
  let chooser = null;

  const count = h('span', { class: 'ed-sect-count' });
  const rowsEl = h('div', { class: 'xf-rows' });
  const slotMain = h('span', { class: 'ed-slot-main' });
  const slotSub = h('span', { class: 'ed-slot-sub' });
  const slot = h('button', { class: 'ed-slot xf-slot', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    icon('plus', 13, 2.4), slotMain, slotSub);
  const foot = h('div', { class: 'ed-sect-foot xf-foot' }, slot);
  const el = h('div', { class: 'box xf-box', dataset: { f: '' } },
    h('div', { class: 'ed-sect' }, h('span', { class: 'ed-sect-title' }, t('editor.extra', null, '追加の項目'), count)),
    rowsEl, foot);
  const live = h('span', { class: 'xf-live', role: 'status', 'aria-live': 'polite' });
  el.append(live);

  function announce(msg) {
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = msg; });
  }

  const full = () => entries.length >= LIMITS.extraCount;

  function paint() {
    const n = entries.length;
    count.textContent = n ? String(n) : '';
    el.classList.toggle('xf-has', n > 0);
    const off = full();
    slot.classList.toggle('off', off);
    slot.setAttribute('aria-disabled', String(off));
    slotMain.textContent = off ? t('上限の {n} 項目に達しました', { n: LIMITS.extraCount }) : t('editor.extraAdd', null, '項目を追加');
    slotSub.textContent = !n && !off ? t('決まった欄にない値を足せます') : '';
    slotSub.hidden = !slotSub.textContent;
  }

  function grow(area) {
    area.style.height = 'auto';
    area.style.height = Math.min(area.scrollHeight, VALUE_MAX_HEIGHT_PX) + 'px';
  }

  const valueName = (entry) => t('editor.extraValueOf', { label: entry.labelIn.value.trim() || fieldName() }, '{label} の値');
  const setErr = (entry, msg) => errs?.set(entry.errKey, msg || '');

  function touch(entry) {
    entry.touched = true;
    setErr(entry, '');
  }

  function eyeButton(entry) {
    const eye = h('button', { class: 'ibtn xf-eye', type: 'button' });
    const set = (on) => {
      const v = entry.valueEl;
      if (v?.tagName === 'INPUT') v.type = on ? 'text' : 'password';
      else v?.classList.toggle('masked', !on);
      eye.classList.toggle('on', on);
      eye.setAttribute('aria-pressed', String(on));
      const label = entry.labelIn.value.trim() || t('editor.extraValue', null, '値');
      eye.setAttribute('aria-label', on ? t('detail.hideField', { label }, '{label}を隠す') : t('detail.showField', { label }, '{label}を表示'));
      eye.title = on ? t('detail.hide', null, '隠す') : t('detail.show', null, '表示');
      eye.replaceChildren(icon(on ? 'eyeOff' : 'eye', 14));
    };
    let on = false;
    eye.addEventListener('click', () => { on = !on; set(on); });
    set(false);
    return eye;
  }

  const srcText = (entry, input) => (entry.carry ?? input.value);

  function guardMask(entry, input, valid, kids) {
    if (!entry.maskUntilValid || valid(srcText(entry, input))) { entry.maskUntilValid = false; return kids; }
    input.type = 'password';
    input.autocomplete = 'new-password';
    const eye = eyeButton(entry);
    input.addEventListener('input', () => {
      if (!entry.maskUntilValid || !valid(input.value)) return;
      entry.maskUntilValid = false;
      input.type = 'text';
      input.autocomplete = 'off';
      eye.remove();
    });
    return [...kids, eye];
  }

  function textControl(entry, initial) {
    const area = h('textarea', {
      class: 'xf-value', rows: 1, maxlength: LIMITS.extraValue, spellcheck: 'false',
      placeholder: t('editor.extraValue', null, '値'), 'aria-label': valueName(entry),
    });
    area.value = initial;
    area.addEventListener('input', () => { touch(entry); grow(area); });
    entry.valueEl = area;
    requestAnimationFrame(() => grow(area));
    if (entry.kind !== 'hidden') return [area];
    area.classList.add('masked');
    return [area, eyeButton(entry)];
  }

  function dateControl(entry, initial) {
    const input = h('input', {
      class: 'xf-value', type: 'text', maxlength: 32, autocomplete: 'off', spellcheck: 'false',
      placeholder: t('2026-04-01 または 2026/4/1'), 'aria-label': valueName(entry),
    });
    input.value = oneLine(initial);
    input.addEventListener('input', () => touch(entry));
    input.addEventListener('blur', () => {
      if (!entry.touched || entry.valueEl !== input) return;
      const src = srcText(entry, input);
      if (multiLine(src)) { setErr(entry, lineError()); return; }
      const v = parseDateInput(src);
      if (v) input.value = v;
      else if (v == null) setErr(entry, dateError());
    });
    entry.valueEl = input;
    return guardMask(entry, input, (v) => !multiLine(v) && parseDateInput(v) != null, [input]);
  }

  function totpLive(entry) {
    const tv = totpView(entry.totp.cfg);
    entry.tv = tv;
    const cfg = entry.totp.cfg;
    const meta = [cfg.issuer, cfg.label].filter(Boolean).join(' · ')
      || t('{digits} 桁 · {period} 秒', { digits: cfg.digits || DEFAULT_DIGITS, period: cfg.period || DEFAULT_PERIOD });
    tv.col.append(h('span', { class: 'xf-totp-meta', title: meta }, meta));
    const editLabel = t('秘密鍵を編集');
    const edit = h('button', { class: 'ibtn xf-totp-edit', type: 'button', title: editLabel, 'aria-label': editLabel }, icon('pencil', 13));
    edit.addEventListener('click', () => {
      const prev = entry.carry ?? entry.totp.value;
      entry.totp = null;
      touch(entry);
      renderControl(entry, prev);
      entry.valueEl?.focus();
      entry.valueEl?.select();
    });
    entry.valueEl = null;
    entry.focusTarget = edit;
    const wrap = h('div', { class: 'xf-totp', role: 'group', 'aria-label': entry.labelIn.value.trim() || t('認証コード') }, tv.col);
    return { kids: [wrap, edit], start: (host) => tv.start(host) };
  }

  function totpInput(entry, initial) {
    const input = h('input', {
      class: 'xf-value', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: LIMITS.extraValue,
      placeholder: t('秘密鍵 または otpauth:// URI'), 'aria-label': valueName(entry),
    });
    input.value = oneLine(initial);
    const accept = () => {
      if (entry.valueEl !== input) return;
      const v = srcText(entry, input).trim();
      if (!v) { setErr(entry, ''); return; }
      if (multiLine(v)) { setErr(entry, lineError()); return; }
      const parsed = tryTotp(v);
      if (!parsed) { setErr(entry, totpError(v)); return; }
      entry.totp = parsed;
      touch(entry);
      dirty();
      const hadFocus = document.activeElement === input;
      entry.valueEl = null;
      renderControl(entry, '');
      if (hadFocus) entry.focusTarget?.focus();
    };
    input.addEventListener('input', () => touch(entry));
    input.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); accept(); }
    });
    input.addEventListener('paste', () => setTimeout(accept, 0));
    input.addEventListener('blur', () => { if (entry.touched) accept(); });
    entry.valueEl = input;
    return guardMask(entry, input, (v) => !v.trim() || (!multiLine(v) && !!tryTotp(v)), [input]);
  }

  function renderControl(entry, initial) {
    entry.tv?.stop();
    entry.tv = null;
    entry.valueEl = null;
    entry.focusTarget = null;
    let kids;
    let start = null;
    if (entry.kind === 'date') kids = dateControl(entry, initial);
    else if (entry.kind === 'totp' && entry.totp) ({ kids, start } = totpLive(entry));
    else if (entry.kind === 'totp') kids = totpInput(entry, initial);
    else kids = textControl(entry, initial);
    if (!entry.focusTarget) entry.focusTarget = entry.valueEl;
    clear(entry.field);
    entry.field.className = 'field xf-field' + (entry.kind === 'text' || entry.kind === 'hidden' ? '' : ' mono');
    entry.field.append(...kids, entry.remove);
    start?.(entry.field);
    entry.row.dataset.kind = entry.kind;
    paintKind(entry);
    entry.note.hidden = !(type === 'login' && entry.kind === 'totp' && entry.noteLogin);
  }

  function paintKind(entry) {
    const k = KINDS[entry.kind];
    const label = t('種類: {kind}。押すと種類を変えられます', { kind: k.name() });
    entry.kindBtn.setAttribute('aria-label', label);
    entry.kindBtn.title = label;
    entry.kindBtn.replaceChildren(h('span', { class: 'xf-kind-face' },
      icon(k.icon, 12), h('span', { class: 'xf-kind-name' }, k.name()), chevDown()));
  }

  function currentText(entry) {
    if (entry.carry != null) return entry.carry;
    if (entry.kind === 'totp' && entry.totp) return entry.totp.value;
    return entry.valueEl ? entry.valueEl.value : entry.stored;
  }

  function changeKind(entry, kind) {
    if (kind === entry.kind) { entry.kindBtn.focus(); return; }
    const text = currentText(entry);
    const wasSecret = entry.kind === 'hidden' || entry.kind === 'totp' || !!entry.maskUntilValid;
    entry.kind = kind;
    entry.totp = null;
    if (kind === 'totp') entry.noteLogin = true;
    touch(entry);
    dirty();
    let shown = text;
    let err = '';
    if (kind === 'date') {
      const d = multiLine(text) ? null : parseDateInput(text);
      if (multiLine(text)) err = lineError();
      else if (d == null) err = dateError();
      else shown = d;
    } else if (kind === 'totp' && multiLine(text)) {
      err = lineError();
    } else if (kind === 'totp' && text.trim()) {
      entry.totp = tryTotp(text);
      if (entry.totp) shown = '';
      else err = totpError(text);
    }
    entry.maskUntilValid = wasSecret && !!err;
    entry.carry = text;
    renderControl(entry, shown);
    setErr(entry, err);
    if (wasSecret && kind === 'text' && text.trim()) announce(t('値が表示されます'));
    (entry.focusTarget || entry.labelIn).focus();
  }

  function makeRow(x, { fresh = false, kind } = {}) {
    const uid = ++seq;
    const entry = {
      uid, kind: kind || extraKind(x), stored: str(x?.value), touched: fresh, totp: null, tv: null,
      valueEl: null, focusTarget: null, noteLogin: fresh, carry: null,
    };
    entry.errKey = 'x:' + uid;
    const labelIn = h('input', {
      class: 'xf-label', type: 'text', maxlength: LIMITS.extraLabel, autocomplete: 'off', spellcheck: 'false',
      placeholder: fieldName(), 'aria-label': fieldName(),
    });
    labelIn.value = str(x?.label);
    labelIn.title = labelIn.value;
    entry.labelIn = labelIn;
    labelIn.addEventListener('input', () => {
      touch(entry);
      labelIn.title = labelIn.value;
      entry.valueEl?.setAttribute('aria-label', valueName(entry));
    });
    entry.remove = h('button', {
      class: 'ibtn xf-remove', type: 'button',
      title: t('editor.extraRemove', null, '項目を削除'), 'aria-label': t('editor.extraRemove', null, '項目を削除'),
    }, icon('x', 11, 3));
    entry.remove.addEventListener('click', () => removeRow(entry));
    entry.kindBtn = h('button', { class: 'xf-kind', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    entry.kindBtn.addEventListener('click', () => {
      if (chooser?.owner === entry) { closeChooser(); return; }
      openChooser({
        owner: entry,
        verb: 'set',
        current: entry.kind,
        trigger: entry.kindBtn,
        mount: (c) => entry.row.append(c),
        pick: (k) => changeKind(entry, k),
      });
    });
    entry.field = h('div', { class: 'field xf-field' });
    entry.field.addEventListener('input', () => { entry.carry = null; });
    const err = errs ? errs.add(entry.errKey) : h('div', { class: 'field-err', role: 'alert' });
    entry.note = h('div', { class: 'xf-note' }, t('ここに足したコードは自動入力されません。自動入力するなら上の「認証コード」欄へ'));
    entry.row = h('div', { class: 'ed-row xf-row', dataset: { x: String(uid) } },
      h('div', { class: 'xf-name' }, labelIn, entry.kindBtn),
      h('div', { class: 'ed-ctl' }, entry.field, err, entry.note));
    if (entry.kind === 'totp' && entry.stored) entry.totp = tryTotp(entry.stored);
    renderControl(entry, entry.totp ? '' : entry.stored);
    return entry;
  }

  function removeRow(entry) {
    const i = entries.indexOf(entry);
    if (i < 0) return;
    if (chooser?.owner === entry) closeChooser(false);
    entries.splice(i, 1);
    entry.tv?.stop();
    entry.row.remove();
    errs?.remove(entry.errKey);
    dirty();
    paint();
    const next = entries[i] || entries[i - 1];
    (next ? next.labelIn : slot).focus();
  }

  function addRow(kind) {
    if (full()) return;
    const entry = makeRow({ label: '', value: '' }, { fresh: true, kind });
    entries.push(entry);
    rowsEl.append(entry.row);
    dirty();
    paint();
    entry.labelIn.focus();
    entry.row.scrollIntoView({ block: 'nearest' });
    rise(rowsEl, `[data-x="${entry.uid}"]`);
  }

  function closeChooser(focusBack = true) {
    if (!chooser) return;
    const { node, trigger, owner, leave } = chooser;
    chooser = null;
    trigger.removeEventListener('focusout', leave);
    node.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (!owner) slot.hidden = false;
    if (focusBack) trigger.focus();
  }

  function openChooser({ owner = null, verb, current = null, trigger, mount, pick }) {
    closeChooser(false);
    const arg = h('span', { class: 'xf-arg' }, current || ORDER[0]);
    const close = h('button', {
      class: 'kbd-btn xf-esc', type: 'button', title: t('閉じる (esc)'), 'aria-label': t('種類の選択を閉じる'),
    }, 'esc');
    close.addEventListener('click', () => closeChooser());
    const gid = 'xf-kinds-' + ++seq;
    const opts = ORDER.map((kind, i) => {
      const k = KINDS[kind];
      const descId = `${gid}-${kind}`;
      const on = kind === current;
      const b = h('button', {
        class: 'cmd xf-opt' + (on ? ' cur' : ''), type: 'button', tabindex: '-1', dataset: { kind },
        'aria-describedby': descId, 'aria-current': on ? 'true' : null,
      },
      icon(k.icon, 13),
      verb === 'set' ? h('span', { class: 'xf-radio' + (on ? ' on' : ''), 'aria-hidden': 'true' }, on ? '(•)' : '( )') : null,
      h('span', { class: 'xf-opt-name' }, k.name()),
      h('span', { class: 'xf-opt-desc', id: descId }, k.desc()),
      h('span', { class: 'cmd-key', 'aria-hidden': 'true' }, String(i + 1)));
      b.addEventListener('click', () => choose(kind));
      b.addEventListener('focus', () => {
        arg.textContent = kind;
        opts.forEach((o) => o.setAttribute('tabindex', o === b ? '0' : '-1'));
      });
      b.addEventListener('mouseenter', () => b.focus({ preventScroll: true }));
      return b;
    });
    const node = h('div', { class: 'xf-chooser' + (owner ? ' xf-chooser-row' : '') },
      h('div', { class: 'xf-echo' },
        h('span', { class: 'xf-cmd', 'aria-hidden': 'true' },
          h('span', { class: 'ps' }, '$ '), `akari field ${verb} --kind `, arg, h('span', { class: 'cursor' })),
        close),
      h('div', { class: 'cmds xf-opts', role: 'group', 'aria-label': t('種類を選ぶ') }, opts));
    const choose = (kind) => {
      closeChooser(false);
      pick(kind);
    };
    node.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      const i = opts.indexOf(document.activeElement);
      const move = (n) => { e.preventDefault(); opts[(n + opts.length) % opts.length].focus(); };
      if (e.key === 'Escape') { e.preventDefault(); closeChooser(); return; }
      if (/^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); choose(ORDER[+e.key - 1]); return; }
      if (e.key === 'ArrowDown') move(i < 0 ? 0 : i + 1);
      else if (e.key === 'ArrowUp') move(i < 0 ? opts.length - 1 : i - 1);
      else if (e.key === 'Home') move(0);
      else if (e.key === 'End') move(opts.length - 1);
    });
    const inside = (el) => node.contains(el) || trigger.contains(el);
    const leave = (e) => {
      if (inside(e.relatedTarget)) return;
      setTimeout(() => { if (chooser?.node === node && !inside(document.activeElement)) closeChooser(false); }, 0);
    };
    node.addEventListener('focusout', leave);
    trigger.addEventListener('focusout', leave);
    chooser = { node, trigger, owner, leave };
    trigger.setAttribute('aria-expanded', 'true');
    mount(node);
    if (!reducedMotion()) {
      node.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    (opts[ORDER.indexOf(current)] || opts[0]).focus();
    node.scrollIntoView({ block: 'nearest' });
  }

  slot.addEventListener('click', () => {
    if (full()) return;
    if (chooser && !chooser.owner) { closeChooser(); return; }
    openChooser({
      verb: 'add',
      trigger: slot,
      mount: (c) => { slot.hidden = true; foot.append(c); },
      pick: addRow,
    });
  });

  for (const x of Array.isArray(list) ? list : []) {
    const entry = makeRow(x || {});
    entries.push(entry);
    rowsEl.append(entry.row);
  }
  paint();

  function readValue(entry) {
    if (!entry.touched) return { value: entry.stored };
    const src = str(entry.carry ?? entry.valueEl?.value);
    if (entry.kind === 'totp') {
      if (entry.totp) return { value: entry.totp.value };
      const v = src.trim();
      if (!v) return { value: '' };
      if (multiLine(v)) return { error: lineError() };
      const parsed = tryTotp(v);
      return parsed ? { value: parsed.value } : { error: totpError(v) };
    }
    if (entry.kind === 'date') {
      if (multiLine(src)) return { error: lineError() };
      const d = parseDateInput(src);
      return d == null ? { error: dateError() } : { value: d };
    }
    return { value: src.replace(/\r\n?/g, '\n') };
  }

  function collect(bad) {
    const out = [];
    for (const entry of entries) {
      const label = entry.labelIn.value.trim();
      const r = readValue(entry);
      const raw = r.error ? str(entry.carry ?? entry.valueEl?.value) : r.value;
      if (!label && !raw.trim()) continue;
      if (!label && entry.touched) { bad(entry.errKey, t('editor.err.extraLabel', null, '項目名を入力してください'), entry.labelIn); continue; }
      if (r.error) { bad(entry.errKey, r.error, entry.valueEl || entry.labelIn); continue; }
      out.push({ label, value: r.value, kind: entry.kind });
    }
    return out;
  }

  function stop() {
    for (const entry of entries) entry.tv?.stop();
  }

  return { el, collect, stop };
}

function totpDetailRow(label, cfg, key, ctx) {
  const tv = totpView(cfg);
  ctx.onStop(() => tv.stop());
  const row = h('div', { class: 'f-row totp-row xf-totp-row' },
    h('span', { class: 'f-label', title: label }, label),
    tv.col,
    ctx.copyButton(key, () => tv.current(), label, { label }));
  tv.start(row);
  return row;
}

export function extraDetailRows(it, ctx) {
  const rows = [];
  const skip = ctx.skip || (() => false);
  (Array.isArray(it?.extra) ? it.extra : []).forEach((x, i) => {
    const value = str(x?.value);
    if (!x || (!value && !x.label) || skip(x)) return;
    const kind = extraKind(x);
    const key = 'x:' + i;
    const label = str(x.label) || t('detail.extraUntitled', null, '（無題の項目）');
    const get = () => str(itemById(it.id)?.extra?.[i]?.value);
    if (kind === 'totp' && value) {
      const parsed = tryTotp(value);
      rows.push(parsed
        ? totpDetailRow(label, parsed.cfg, key, ctx)
        : ctx.secretRow({ key, label, get, multiline: value.includes('\n') }));
      return;
    }
    if (kind === 'hidden' && value) {
      rows.push(ctx.secretRow({ key, label, get, multiline: value.includes('\n') }));
      return;
    }
    if (kind === 'date' && value) {
      rows.push(ctx.plainRow({ key, label, kind: 'date', display: formatIsoDate(value), copyValue: () => formatIsoDate(get()) }));
      return;
    }
    rows.push(ctx.plainRow({ key, label, kind: /^https?:\/\//i.test(value.trim()) ? 'url' : 'text', display: value, copyValue: get }));
  });
  return rows;
}
