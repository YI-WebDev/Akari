// "パスワード生成" bottom sheet (design 1a): CLI-style command line, coloured characters,
// 12-segment meter, ランダム / パスフレーズ, [x] toggles.

import { MSG } from '../../shared/messages.js';
import { generatePassword } from '../../lib/generator.js';
import {
  emit, call, itemById, copyText, forSave, replaceItem, mergeSaved, errText, liveToken, live,
} from '../state.js';
import { h, clear, icon, copyGlyph, syncInert, keepFocus } from './dom.js';
import { safeHttpUrl } from './format.js';
import { scrambleWith, cancelScramble, spin } from './fx.js';
import { setMeter } from './meter.js';
import { toastError } from './toast.js';

const KEY = 'akari.gen';
const LABELS = ['—', '弱い', '普通', '強い', '非常に強い'];
const RANGE = { random: [8, 48], phrase: [3, 8] };

const opts = { mode: 'random', length: 20, words: 4, upper: true, digits: true, symbols: true, avoidAmbiguous: false };
try { Object.assign(opts, pick(JSON.parse(localStorage.getItem(KEY) || '{}'))); } catch { /* ignore */ }

function pick(o) {
  const out = {};
  if (o.mode === 'random' || o.mode === 'phrase') out.mode = o.mode;
  if (Number.isInteger(o.length)) out.length = clamp(o.length, ...RANGE.random);
  if (Number.isInteger(o.words)) out.words = clamp(o.words, ...RANGE.phrase);
  for (const k of ['upper', 'digits', 'symbols', 'avoidAmbiguous']) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const saveOpts = () => { try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch { /* ignore */ } };

export const levelFromBits = (bits) => (!bits ? 0 : bits < 40 ? 1 : bits < 64 ? 2 : bits < 88 ? 3 : 4);

const NO_CTX = Object.freeze({ target: null, source: null, onUse: null, title: '' });
let ctx = NO_CTX;
let restoreFocus = null;
let pw = '';
let bits = 0;
let dragging = false;
let copiedTimer = 0;
let wipeTimer = 0;
let busy = false;
const $ = (id) => document.getElementById(id);

/** Forget the generated password and the caller context (incl. the editor's onUse closure). */
export function resetGenerator() {
  cancelScramble('gen');
  clearTimeout(wipeTimer);
  clearTimeout(copiedTimer);
  pw = '';
  bits = 0;
  ctx = NO_CTX;
  restoreFocus = null;
  clear($('genChars'));
  $('genChars').removeAttribute('aria-busy');
  $('genChars').removeAttribute('aria-label');
  setMeter($('genMeter'), {});
}

export const isGenOpen = () => $('genSheet').classList.contains('open');

function renderChars(text) {
  const box = $('genChars');
  clear(box);
  for (const c of Array.from(text)) {
    const cls = /\d/.test(c) ? 'cd' : /[A-Za-z]/.test(c) ? 'cl' : 'cs';
    box.append(h('span', { class: cls }, c));
  }
  box.setAttribute('aria-label', '生成したパスワード');
}

function renderStrength() {
  const lv = levelFromBits(bits);
  setMeter($('genMeter'), { bits, level: lv, label: LABELS[lv] });
}

/** The options as the equivalent `akari gen` command line. */
export function genCommand(o = opts) {
  if (o.mode === 'phrase') {
    return `akari gen --words ${o.words} --dict ja-romaji${o.upper ? ' --capitalize' : ''}${o.digits ? ' --digits' : ''}${o.symbols ? ' --symbols' : ''}`;
  }
  return `akari gen --length ${o.length}${o.upper ? ' --upper' : ''}${o.digits ? ' --digits' : ''}${o.symbols ? ' --symbols' : ''}${o.avoidAmbiguous ? ' --no-ambiguous' : ''}`;
}

function renderControls() {
  const isR = opts.mode === 'random';
  $('modeRandom').setAttribute('aria-checked', String(isR));
  $('modePhrase').setAttribute('aria-checked', String(!isR));
  const [mn, mx] = RANGE[opts.mode];
  const v = isR ? opts.length : opts.words;
  const pct = ((v - mn) / (mx - mn) * 100).toFixed(1) + '%';
  $('sliderLabel').textContent = isR ? '長さ' : '単語数';
  $('sliderFill').style.width = pct;
  $('sliderKnob').style.left = pct;
  $('sliderVal').textContent = String(v);
  const sl = $('slider');
  sl.setAttribute('aria-valuemin', mn);
  sl.setAttribute('aria-valuemax', mx);
  sl.setAttribute('aria-valuenow', v);
  sl.setAttribute('aria-valuetext', isR ? `${v} 文字` : `${v} 語`);
  for (const b of $('genToggles').querySelectorAll('.tgl')) {
    const k = b.dataset.opt;
    b.setAttribute('aria-checked', String(!!opts[k]));
    b.hidden = k === 'avoidAmbiguous' && !isR;
  }
  $('genCmd').textContent = genCommand();
}

function generate() {
  const r = generatePassword({ ...opts });
  pw = r.password;
  bits = Math.round(r.bits);
}

/** Decode the password into the output; #genChars is aria-busy until it has settled. */
function decode(ms) {
  const box = $('genChars');
  box.setAttribute('aria-busy', 'true');
  scrambleWith('gen', pw, ms, renderChars, undefined, () => box.removeAttribute('aria-busy'));
}

function regen(ms = 440) {
  generate();
  decode(ms);
  renderStrength();
  spin($('genRegen').querySelector('svg'));
}

function slideTo(clientX) {
  const r = $('slider').getBoundingClientRect();
  const t = clamp((clientX - r.left) / r.width, 0, 1);
  setValue(Math.round(RANGE[opts.mode][0] + t * (RANGE[opts.mode][1] - RANGE[opts.mode][0])), false);
}

function setValue(v, animate) {
  const key = opts.mode === 'random' ? 'length' : 'words';
  v = clamp(v, ...RANGE[opts.mode]);
  if (v === opts[key]) return;
  opts[key] = v;
  saveOpts();
  renderControls();
  cancelScramble('gen');
  generate();
  renderStrength();
  if (animate) decode(320);
  else renderChars(pw);
}

/** The login's site, when the generator was opened for one (強化する). */
const siteOf = (item) => (item?.type === 'login' ? safeHttpUrl(item.url) : '');

function applyLabel() {
  if (ctx.source === 'editor') return 'パスワードに使う';
  if (ctx.target) return siteOf(itemById(ctx.target)) ? 'サイトで変更する' : '保留してコピー';
  return 'コピーして閉じる';
}

export function openGenerator({ target = null, source = null, onUse = null, title = '' } = {}) {
  const item = target ? itemById(target) : null;
  clearTimeout(wipeTimer);
  ctx = { target: item ? item.id : null, source, onUse, title };
  const chip = $('genChip');
  const chipText = item ? item.title : source === 'editor' ? title || '新規ログイン' : '';
  chip.textContent = chipText;
  chip.hidden = !chipText;
  $('genApply').textContent = applyLabel();
  if (ctx.target && siteOf(item)) $('genApply').append(icon('external', 11, 2.6));
  $('genApply').disabled = false;
  $('genSite').hidden = !ctx.target;
  $('genAkariOnly').hidden = !ctx.target;
  $('genAkariOnly').disabled = false;
  $('genCopy').replaceChildren(copyGlyph(false));
  renderControls();
  restoreFocus = keepFocus();
  $('scrim').classList.add('on');
  const sheet = $('genSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  syncInert();
  regen();
  setTimeout(() => $('genApply').focus({ preventScroll: true }), 60);
}

export function closeGenerator() {
  const sheet = $('genSheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('setSheet').classList.contains('open')) $('scrim').classList.remove('on');
  cancelScramble('gen');
  syncInert();
  restoreFocus?.();
  restoreFocus = null;
  // drop the secret and the caller context now; the characters once the sheet has slid away
  pw = '';
  bits = 0;
  ctx = NO_CTX;
  clearTimeout(wipeTimer);
  wipeTimer = setTimeout(() => { if (!isGenOpen()) resetGenerator(); }, 600);
  emit('sheetClosed');
}

function setBusy(on) {
  busy = on;
  $('genApply').disabled = on;
  $('genAkariOnly').disabled = on;
}

async function apply() {
  if (busy || !pw) return;
  const password = pw;
  const genBits = bits;
  const lv = levelFromBits(genBits);
  if (ctx.source === 'editor') {
    ctx.onUse?.(password, { bits: genBits, level: lv, label: LABELS[lv] });
    closeGenerator();
    return;
  }
  if (!ctx.target) {
    const token = liveToken();
    await copyText('gen', password);
    if (live(token)) closeGenerator();
    return;
  }
  await holdForSite(password);
}

/**
 * 強化する: the site still has the old password, so the new one is held (pendingPassword) and
 * copied, and the login's saved URL opens (to sign in and change it there). The login keeps working with the current
 * password until the user confirms the change in the detail pane (or the save prompt sees it).
 */
async function holdForSite(password) {
  const item = itemById(ctx.target);
  if (!item) { closeGenerator(); return; }
  setBusy(true);
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_PENDING_PASSWORD, { id: item.id, action: 'set', password });
    if (!live(token)) return;
    replaceItem(mergeSaved(res?.item, { ...item, pendingPassword: { password, createdAt: Date.now() } }));
    await copyText('gen', password);
    const site = siteOf(item);
    closeGenerator();
    emit('passwordPending', item.id);
    if (site) chrome.tabs.create({ url: site }); // the saved URL; the popup closes here
  } catch (e) {
    if (live(token)) toastError('保留できませんでした', errText(e));
  } finally {
    setBusy(false);
  }
}

/** Akari だけ更新: the site was already changed by hand. The replaced password stays in the history. */
async function updateNow() {
  if (busy || !pw || !ctx.target) return;
  const password = pw;
  const genBits = bits;
  const lv = levelFromBits(genBits);
  const item = itemById(ctx.target);
  if (!item) { closeGenerator(); return; }
  setBusy(true);
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_SAVE_ITEM, { item: forSave({ ...item, password }) });
    if (!live(token)) return;
    replaceItem(mergeSaved(res?.item, { ...item, password, updatedAt: Date.now() }));
    closeGenerator();
    emit('passwordUpdated', item.id, { password, level: lv, label: LABELS[lv], bits: genBits });
  } catch (e) {
    if (live(token)) toastError('パスワードを更新できませんでした', errText(e));
  } finally {
    setBusy(false);
  }
}

async function copyGenerated() {
  if (!pw || !(await copyText('gen', pw))) return;
  $('genCopy').replaceChildren(copyGlyph(true));
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => $('genCopy').replaceChildren(copyGlyph(false)), 1500);
}

export function initGenerator() {
  $('genRegen').addEventListener('click', () => regen());
  $('genCopy').addEventListener('click', copyGenerated);
  $('genCopyText').addEventListener('click', copyGenerated);
  $('genApply').addEventListener('click', apply);
  $('genAkariOnly').addEventListener('click', updateNow);
  $('genSheet').querySelector('[data-close]').addEventListener('click', closeGenerator);
  $('modeRandom').addEventListener('click', () => { if (opts.mode !== 'random') { opts.mode = 'random'; saveOpts(); renderControls(); regen(); } });
  $('modePhrase').addEventListener('click', () => { if (opts.mode !== 'phrase') { opts.mode = 'phrase'; saveOpts(); renderControls(); regen(); } });
  $('genToggles').addEventListener('click', (e) => {
    const b = e.target.closest('.tgl');
    if (!b) return;
    opts[b.dataset.opt] = !opts[b.dataset.opt];
    saveOpts();
    renderControls();
    regen();
  });

  const sl = $('slider');
  sl.addEventListener('pointerdown', (e) => {
    dragging = true;
    sl.classList.add('drag');
    try { sl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    slideTo(e.clientX);
  });
  sl.addEventListener('pointermove', (e) => { if (dragging) slideTo(e.clientX); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sl.classList.remove('drag');
    decode(320);
  };
  sl.addEventListener('pointerup', end);
  sl.addEventListener('pointercancel', end);
  sl.addEventListener('keydown', (e) => {
    const key = opts.mode === 'random' ? 'length' : 'words';
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (step) setValue(opts[key] + step, true);
    else if (e.key === 'Home') setValue(RANGE[opts.mode][0], true);
    else if (e.key === 'End') setValue(RANGE[opts.mode][1], true);
    else return;
    e.preventDefault();
  });
  renderControls();
}
