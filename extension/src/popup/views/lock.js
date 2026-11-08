import { MSG, ERR, NEVER_LOCK } from '../../shared/messages.js';
import { send } from '../../shared/api.js';
import { t } from '../../shared/i18n.js';
import { S, strengthOf, setPhase } from '../state.js';
import { h, clear, syncInert, icon } from './dom.js';
import { shake, wait, reducedMotion } from './fx.js';
import { setMeter } from './meter.js';

const $ = (id) => document.getElementById(id);
const KDF = 'PBKDF2-SHA256 600k';
const LINE_GAP = 220;
const GATE_FADE_MS = 220;
const FOCUS_DELAY_INSTANT_MS = 30;
const FOCUS_DELAY_AFTER_FADE_IN_MS = 200;
const LAST_LINE_PAUSE_MS = 300;
let hooks = { load: async () => 0, enter: () => {} };
let busy = false;
let bootGen = 0;

function idleHint() {
  const m = Number(S.settings.autoLockMinutes);
  if (m === NEVER_LOCK) return t('ひらいたあとは自動ではロックしません（鍵のボタンでロック）');
  return m > 0 ? t('{n} 分操作しないと自動でロックします', { n: m }) : t('ブラウザを閉じるとロックします');
}

function status(el, text, { err = false, detail = '' } = {}) {
  clear(el);
  el.classList.toggle('err', err);
  el.append(text);
  if (detail) el.append(' ', h('span', { class: 'mono' }, detail));
}

export function gateOpen() {
  return $('gate').classList.contains('on');
}

export function setGateStatus(text, opts = {}) {
  status($($('gate').dataset.mode === 'setup' ? 'setupStatus' : 'lockStatus'), text, opts);
}

function bootClear() {
  bootGen++;
  clear($('bootLog'));
}

function bootLine(k, v, { running = false } = {}) {
  const tag = h('span', { class: 'boot-tag' }, running ? '[ .. ]' : '[ ok ]');
  const val = h('span', { class: 'boot-v' }, v);
  const line = h('div', { class: 'boot-line', dataset: { state: running ? 'run' : 'ok' } },
    tag, h('span', { class: 'boot-k' }, k), h('span', { class: 'boot-dots', 'aria-hidden': 'true' }), val);
  $('bootLog').append(line);
  return {
    done(value) {
      line.dataset.state = 'ok';
      tag.textContent = '[ ok ]';
      if (value != null) val.textContent = value;
    },
    remove: () => line.remove(),
  };
}

function bootQueue() {
  const gen = bootGen;
  let chain = Promise.resolve();
  let lastAt = performance.now();
  return (k, v) => {
    chain = chain.then(async () => {
      const left = LINE_GAP - (performance.now() - lastAt);
      if (left > 0) await wait(left);
      if (gen !== bootGen) return;
      bootLine(k, v);
      lastAt = performance.now();
    });
    return chain;
  };
}

const secs = (t0) => `${((performance.now() - t0) / 1000).toFixed(2)}s`;

function setRevealed(on) {
  const input = $('lockInput');
  const btn = $('lockReveal');
  input.type = on ? 'text' : 'password';
  input.classList.toggle('shown', on);
  btn.setAttribute('aria-pressed', String(on));
  const label = on ? t('パスワードを隠す') : t('パスワードを表示');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  clear(btn);
  btn.append(icon(on ? 'eyeOff' : 'eye', 15));
}

function watchCaps(input, out) {
  const show = (on) => {
    if (on === !!out.firstChild) return;
    clear(out);
    if (on) out.append(h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'), t('Caps Lock がオンです'));
  };
  const check = (e) => { if (typeof e.getModifierState === 'function') show(e.getModifierState('CapsLock')); };
  input.addEventListener('keydown', check);
  input.addEventListener('keyup', check);
  input.addEventListener('pointerdown', check);
  input.addEventListener('blur', () => show(false));
}

export function showGate(mode, { instant = false } = {}) {
  const gate = $('gate');
  gate.dataset.mode = mode;
  if (instant) gate.classList.add('instant');
  gate.classList.add('on');
  gate.setAttribute('aria-hidden', 'false');
  syncInert();
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => gate.classList.remove('instant')));
  busy = false;
  bootClear();
  for (const id of ['lockSubmit', 'setupSubmit']) $(id).classList.remove('busy');
  for (const id of ['lockCaps', 'setupCaps']) clear($(id));
  if (mode === 'lock') {
    setRevealed(false);
    $('lockInput').value = '';
    $('lockInput').disabled = false;
    $('lockField').classList.remove('err');
    status($('lockStatus'), idleHint());
    const focusDelay = instant ? FOCUS_DELAY_INSTANT_MS : FOCUS_DELAY_AFTER_FADE_IN_MS;
    setTimeout(() => $('lockInput').focus(), focusDelay);
  } else {
    $('setupPw').value = '';
    $('setupPw2').value = '';
    updateSetup();
    status($('setupStatus'), '');
    const focusDelay = instant ? FOCUS_DELAY_INSTANT_MS : FOCUS_DELAY_AFTER_FADE_IN_MS;
    setTimeout(() => $('setupPw').focus(), focusDelay);
  }
}

async function leave() {
  const gate = $('gate');
  hooks.enter();
  gate.classList.remove('on');
  gate.setAttribute('aria-hidden', 'true');
  syncInert();
  await wait(reducedMotion() ? 0 : GATE_FADE_MS);
  if (!gate.classList.contains('on')) bootClear();
}

async function unlock(e) {
  e.preventDefault();
  if (busy) return;
  const input = $('lockInput');
  const field = $('lockField');
  const st = $('lockStatus');
  const pw = input.value;
  if (!pw) {
    field.classList.add('err');
    status(st, t('パスワードを入力してください'), { err: true });
    shake(field);
    return;
  }
  busy = true;
  field.classList.remove('err');
  $('lockSubmit').classList.add('busy');
  setRevealed(false);
  input.blur();
  bootClear();
  status(st, t('認証しています…'));
  const derive = bootLine(t('鍵を導出'), KDF, { running: true });
  const t0 = performance.now();
  try {
    await send(MSG.VAULT_UNLOCK, { masterPassword: pw });
  } catch (err) {
    derive.remove();
    busy = false;
    $('lockSubmit').classList.remove('busy');
    field.classList.add('err');
    status(st, err?.code === ERR.BAD_PASSWORD ? t('パスワードが違います') : t('解除できませんでした。もう一度入力してください'), { err: true });
    shake(field);
    input.select();
    input.focus();
    return;
  }
  input.value = '';
  derive.done(`${KDF} · ${secs(t0)}`);
  await finish(st, { created: false });
}

async function finish(st, { created }) {
  const push = bootQueue();
  let count = 0;
  try {
    count = await hooks.load({
      onDecrypted: (vaults) => push(created ? t('保管庫を作成') : t('保管庫を復号'),
        (created ? ['AES-256-GCM'] : []).concat(vaults.map((v) => v.name)).join(' · ')),
    });
  } catch {
    bootClear();
    busy = false;
    $('lockSubmit').classList.remove('busy');
    $('setupSubmit').classList.remove('busy');
    if ($('gate').dataset.mode === 'setup') {
      try { await send(MSG.VAULT_LOCK); } catch { }
      setPhase('locked');
      document.getElementById('app').dataset.phase = 'locked';
      showGate('lock');
      status($('lockStatus'), t('保管庫を読み込めませんでした。マスターパスワードで解除してください'), { err: true });
      return;
    }
    status(st, t('保管庫を読み込めませんでした'), { err: true });
    return;
  }
  await push(t('アイテムを読込'), t('{n} 件', { n: count }));
  await wait(LAST_LINE_PAUSE_MS);
  await leave();
  busy = false;
  $('lockSubmit').classList.remove('busy');
  $('setupSubmit').classList.remove('busy');
}

function setupState() {
  const a = $('setupPw').value;
  const b = $('setupPw2').value;
  const st = strengthOf(a);
  return { a, b, st, len: a.length >= 10, lv: st.level >= 2, match: !!a && a === b };
}

function updateSetup() {
  const { a, st, len, lv, match } = setupState();
  setMeter($('setupMeter'), a ? st : {});
  $('chkLen').classList.toggle('ok', len);
  $('chkLv').classList.toggle('ok', lv);
  $('chkMatch').classList.toggle('ok', match);
  $('setupSubmit').disabled = !(len && lv && match) || busy;
}

async function setup(e) {
  e.preventDefault();
  if (busy) return;
  const { a, len, lv, match } = setupState();
  const st = $('setupStatus');
  if (!(len && lv && match)) {
    status(st, !len ? t('10 文字以上にしてください') : !lv ? t('推測されやすいパスワードです。単語を足すか、記号や数字を混ぜてください') : t('2 回の入力が一致しません'), { err: true });
    shake($('setupForm'));
    return;
  }
  busy = true;
  $('setupSubmit').classList.add('busy');
  $('setupSubmit').disabled = true;
  bootClear();
  status(st, t('保管庫を作成しています…'));
  const derive = bootLine(t('鍵を導出'), KDF, { running: true });
  const t0 = performance.now();
  try {
    await send(MSG.VAULT_SETUP, { masterPassword: a });
  } catch (err) {
    derive.remove();
    busy = false;
    $('setupSubmit').classList.remove('busy');
    updateSetup();
    status(st, err?.code === ERR.ALREADY_INITIALIZED ? t('すでに作成されています。開き直してください') : t('作成できませんでした'), { err: true });
    return;
  }
  $('setupPw').value = '';
  $('setupPw2').value = '';
  derive.done(`${KDF} · ${secs(t0)}`);
  await finish(st, { created: true });
}

export function initGate({ load, enter }) {
  hooks = { load, enter };
  try {
    $('gateVersion').textContent = `v${chrome.runtime.getManifest().version} · ${t('暗号化して、このブラウザの中だけに保存します')}`;
  } catch { }
  $('lockForm').addEventListener('submit', unlock);
  $('lockReveal').addEventListener('pointerdown', (e) => e.preventDefault());
  $('lockReveal').addEventListener('click', () => {
    if (busy) return;
    setRevealed($('lockInput').type === 'password');
    $('lockInput').focus({ preventScroll: true });
  });
  watchCaps($('lockInput'), $('lockCaps'));
  watchCaps($('setupPw'), $('setupCaps'));
  watchCaps($('setupPw2'), $('setupCaps'));
  $('lockInput').addEventListener('input', () => {
    if ($('lockField').classList.contains('err')) {
      $('lockField').classList.remove('err');
      status($('lockStatus'), idleHint());
    }
  });
  $('setupForm').addEventListener('submit', setup);
  $('setupPw').addEventListener('input', updateSetup);
  $('setupPw2').addEventListener('input', updateSetup);
}
