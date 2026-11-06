// Lock screen and first-run setup (design 1a): the 灯 Akari mark, and the boot log whose
// lines appear as the real steps finish — key derivation (vault/unlock or vault/setup),
// decryption (vault/getAll) and loading the items.

import { MSG, ERR, NEVER_LOCK } from '../../shared/messages.js';
import { send } from '../../shared/api.js';
import { S, strengthOf, setPhase } from '../state.js';
import { h, clear, syncInert } from './dom.js';
import { shake, wait, reducedMotion } from './fx.js';
import { setMeter } from './meter.js';

const $ = (id) => document.getElementById(id);
const KDF = 'PBKDF2-SHA256 600k';
const LINE_GAP = 220; // ms between two boot lines, so a fast step still reads as a step
let hooks = { load: async () => 0, enter: () => {} };
let busy = false;
let bootGen = 0;

function idleHint() {
  const m = Number(S.settings.autoLockMinutes);
  if (m === NEVER_LOCK) return 'ひらいたあとは自動ではロックしません（鍵のボタンでロック）';
  return m > 0 ? `${m} 分操作しないと自動でロックします` : 'ブラウザを閉じるとロックします';
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

/** Status line under the current gate form. */
export function setGateStatus(text, opts = {}) {
  status($($('gate').dataset.mode === 'setup' ? 'setupStatus' : 'lockStatus'), text, opts);
}

/* ── boot log ── */

function bootClear() {
  bootGen++;
  clear($('bootLog'));
}

/** Append "[ ok ] key ······ value" (or a pulsing "[ .. ]" while `running`). */
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

/** Lines pushed here appear in order, each at least LINE_GAP after the previous one. */
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

/* ── gate ── */

/** Show the lock or setup screen. `instant` skips the fade (used at popup open). */
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
  if (mode === 'lock') {
    $('lockInput').value = '';
    $('lockInput').disabled = false;
    $('lockField').classList.remove('err');
    status($('lockStatus'), idleHint());
    setTimeout(() => $('lockInput').focus(), instant ? 30 : 200);
  } else {
    $('setupPw').value = '';
    $('setupPw2').value = '';
    updateSetup();
    status($('setupStatus'), '');
    setTimeout(() => $('setupPw').focus(), instant ? 30 : 200);
  }
}

/** Fade the gate out over the main view (popup.css: .gate, .2 s), then reset it. */
async function leave() {
  const gate = $('gate');
  hooks.enter();
  gate.classList.remove('on');
  gate.setAttribute('aria-hidden', 'true');
  syncInert();
  await wait(reducedMotion() ? 0 : 220);
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
    status(st, 'パスワードを入力してください', { err: true });
    shake(field);
    return;
  }
  busy = true;
  field.classList.remove('err');
  $('lockSubmit').classList.add('busy');
  input.blur();
  bootClear();
  status(st, '認証しています…');
  const derive = bootLine('鍵を導出', KDF, { running: true });
  const t0 = performance.now();
  try {
    await send(MSG.VAULT_UNLOCK, { masterPassword: pw });
  } catch (err) {
    derive.remove();
    busy = false;
    $('lockSubmit').classList.remove('busy');
    field.classList.add('err');
    status(st, err?.code === ERR.BAD_PASSWORD ? 'パスワードが違います' : '解除できませんでした。もう一度入力してください', { err: true });
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
      onDecrypted: (vaults) => push(created ? '保管庫を作成' : '保管庫を復号',
        (created ? ['AES-256-GCM'] : []).concat(vaults.map((v) => v.name)).join(' · ')),
    });
  } catch {
    bootClear();
    busy = false;
    $('lockSubmit').classList.remove('busy');
    $('setupSubmit').classList.remove('busy');
    if ($('gate').dataset.mode === 'setup') {
      // the vault exists now: never leave the user on a spent setup form
      try { await send(MSG.VAULT_LOCK); } catch { /* best effort */ }
      setPhase('locked');
      document.getElementById('app').dataset.phase = 'locked';
      showGate('lock');
      status($('lockStatus'), '保管庫を読み込めませんでした。マスターパスワードで解除してください', { err: true });
      return;
    }
    status(st, '保管庫を読み込めませんでした', { err: true });
    return;
  }
  await push('アイテムを読込', `${count} 件`);
  await wait(300);
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
    status(st, !len ? '10 文字以上にしてください' : !lv ? '推測されやすいパスワードです。単語を足すか、記号や数字を混ぜてください' : '2 回の入力が一致しません', { err: true });
    shake($('setupForm'));
    return;
  }
  busy = true;
  $('setupSubmit').classList.add('busy');
  $('setupSubmit').disabled = true;
  bootClear();
  status(st, '保管庫を作成しています…');
  const derive = bootLine('鍵を導出', KDF, { running: true });
  const t0 = performance.now();
  try {
    await send(MSG.VAULT_SETUP, { masterPassword: a });
  } catch (err) {
    derive.remove();
    busy = false;
    $('setupSubmit').classList.remove('busy');
    updateSetup();
    status(st, err?.code === ERR.ALREADY_INITIALIZED ? 'すでに作成されています。開き直してください' : '作成できませんでした', { err: true });
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
    $('gateVersion').textContent = `v${chrome.runtime.getManifest().version} · 暗号化して、このブラウザの中だけに保存します`;
  } catch { /* keep the static text */ }
  $('lockForm').addEventListener('submit', unlock);
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
