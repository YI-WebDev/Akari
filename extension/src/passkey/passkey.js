// Passkey consent window. Opened by background/passkey-service.js with ?req=<id>.
// Site-controlled strings (rp name, user names) are only ever set via textContent.

import { send, AkariError } from '../shared/api.js';
import { MSG } from '../shared/messages.js';

const PORT_PREFIX = 'akari-passkey:';
const PASSKEY_VERIFY = 'passkey/verify'; // registered by background/passkey-service.js
// Approve stays disabled this long after the window appears or regains focus, so a
// keystroke or click aimed at the page cannot approve a window that just popped up.
const ARM_MS = 600;
const reqId = new URLSearchParams(location.search).get('req') || '';

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('[data-screen]')];

let info = null;
let current = 'loading';
let busy = false;
let loading = null;
let armedAt = 0;
let armTimer = 0;

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svg(paths, size = 12) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', paths);
  s.append(p);
  return s;
}

const initial = (s) => (Array.from(String(s || '').trim())[0] || '?').toUpperCase();

function hueOf(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function ago(ms) {
  if (!ms) return null;
  const d = Date.now() - ms;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (d < min) return 'たった今';
  if (d < hour) return Math.floor(d / min) + '分前';
  if (d < day) return Math.floor(d / hour) + '時間前';
  if (d < 30 * day) return Math.floor(d / day) + '日前';
  return new Date(ms).toLocaleDateString('ja-JP');
}

function show(name) {
  const changed = current !== name;
  current = name;
  for (const s of screens) s.hidden = s.dataset.screen !== name;
  if (name === 'expired') $('stDot').dataset.state = 'off';
  if (changed) rearm();
  const titles = { create: 'パスキーを保存', get: 'パスキーでサインイン', locked: 'Akari をひらく' };
  document.title = (titles[name] ? titles[name] + ' — ' : '') + 'Akari';
}

let toastTimer = 0;
function toast(message) {
  const t = $('toast');
  $('toastMsg').textContent = message;
  t.classList.add('show');
  $('toastBar').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 2600, easing: 'linear', fill: 'forwards' });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function shake(node) {
  node.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
    { duration: 380, easing: 'ease-out' },
  );
}

const arming = () => performance.now() < armedAt;

function syncButtons() {
  const wait = arming();
  for (const b of document.querySelectorAll('[data-act]')) {
    const isPrimary = b.dataset.act === 'primary';
    b.disabled = busy || (isPrimary && wait);
    b.classList.toggle('arming', isPrimary && wait);
  }
}

function rearm() {
  armedAt = performance.now() + ARM_MS;
  syncButtons();
  clearTimeout(armTimer);
  armTimer = setTimeout(syncButtons, ARM_MS + 20);
}

function setBusy(on) {
  busy = on;
  syncButtons();
}

const uvForm = () => document.querySelector(`[data-screen="${current}"] [data-uv]`);
// 'preferred' (the default) is verified too, like platform authenticators do: sites such as
// Google accept a passkey without a password only when the UV flag is set.
const needsUv = () => !!info && !info.locked && info.uv !== 'discouraged' && !info.verified
  && !(info.kind === 'create' && info.excluded);

function renderUv() {
  const form = uvForm();
  if (!form) return;
  form.hidden = !needsUv();
  form.querySelector('.uv-pw').value = '';
  form.querySelector('.hint').textContent = '';
  form.querySelector('.hint').classList.remove('error');
  form.querySelector('.pw').classList.remove('error');
  if (!form.hidden) setTimeout(() => form.querySelector('.uv-pw').focus(), 50);
}

function uvError(message) {
  const form = uvForm();
  const hint = form.querySelector('.hint');
  hint.textContent = message;
  hint.classList.add('error');
  form.querySelector('.pw').classList.add('error');
  shake(form.querySelector('.pw'));
  form.querySelector('.uv-pw').select();
}

/** Prove the master password for this request. Resolves true when verified. */
async function verifyUv() {
  const input = uvForm().querySelector('.uv-pw');
  if (!input.value) { uvError('パスワードを入力してください'); return false; }
  setBusy(true);
  try {
    await send(PASSKEY_VERIFY, { reqId, masterPassword: input.value });
    input.value = '';
    info.verified = true;
    return true;
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    if (code === 'NOT_FOUND') show('expired');
    else uvError(code === 'BAD_PASSWORD' ? 'パスワードが違います' : '確認できませんでした');
    return false;
  } finally {
    setBusy(false);
  }
}

// ---------- rendering ----------

/** Status bar and `$ passkey …` lines: the request's origin / rpId (textContent only). */
function renderChrome() {
  for (const n of document.querySelectorAll('[data-rp]')) n.textContent = info.rpId;
  $('stOrigin').textContent = info.origin;
  $('stDot').dataset.state = info.locked ? 'locked' : 'ready';
}

/** One `[ ok ] key ····· value` line in the unlock log. */
function bootLine(key, value) {
  const line = el('div', 'boot-line');
  line.append(el('span', 'ok', '[ ok ]'), el('span', 'bk', key), el('span', 'dots'), el('span', 'bv', value));
  $('bootLog').append(line);
}

function renderLocked() {
  $('lockedSub').textContent = info.kind === 'create'
    ? info.rpId + ' のパスキーを保存するには、マスターパスワードを入力してください'
    : info.rpId + ' にサインインするには、マスターパスワードを入力してください';
  $('pwHint').textContent = '';
  $('pwHint').classList.remove('error');
  $('pwBox').classList.remove('error');
  $('bootLog').replaceChildren();
  $('lockOrb').getAnimations().forEach((a) => a.cancel());
  show('locked');
  setTimeout(() => $('pw').focus(), 50);
}

function renderCreate() {
  const tile = $('cSiteTile');
  tile.textContent = initial(info.rpName || info.rpId);
  tile.style.setProperty('--hue', hueOf(info.rpId));
  $('cRpId').textContent = info.rpId;
  $('cOrigin').textContent = info.rpName && info.rpName !== info.rpId ? info.rpName + ' · ' + info.origin : info.origin;
  $('cUserDisplay').textContent = info.user.displayName || info.user.name || '（名前なし）';
  $('cUserName').textContent = info.user.displayName && info.user.name ? info.user.name : '';

  const list = $('vaultList');
  list.replaceChildren();
  for (const v of info.vaults) {
    const label = el('label', 'vault');
    label.style.setProperty('--hue', v.hue);
    const input = el('input');
    input.type = 'radio';
    input.name = 'vault';
    input.value = v.id;
    input.checked = v.id === info.defaultVault;
    label.append(input, el('span', 'dot'), el('span', '', v.name));
    list.append(label);
  }
  if (!list.querySelector('input:checked') && list.querySelector('input')) list.querySelector('input').checked = true;

  $('excludedNotice').hidden = !info.excluded;
  $('vaultField').hidden = !!info.excluded;
  $('createLabel').textContent = info.excluded ? '閉じる' : '保存する';
  show('create');
  renderUv();
}

function renderGet() {
  $('gRpId').textContent = info.rpId;
  $('gOrigin').textContent = info.origin;
  const list = $('accountList');
  list.replaceChildren();
  info.candidates.forEach((c, i) => {
    const label = el('label', 'account');
    const input = el('input');
    input.type = 'radio';
    input.name = 'account';
    input.value = c.credentialId;
    input.checked = i === 0;
    const name = c.userDisplayName || c.userName || '（名前なし）';
    const tile = el('span', 'tile', initial(name));
    tile.style.setProperty('--hue', hueOf(c.userName || name));
    const col = el('div', 'col');
    const used = ago(c.lastUsedAt);
    const meta = [c.userDisplayName && c.userName ? c.userName : null,
      used ? '最終使用 ' + used : '未使用', c.itemTitle || null].filter(Boolean).join(' · ');
    col.append(el('div', 'name', name), el('div', 'meta', meta));
    const check = el('span', 'check');
    check.append(svg('M20 6 9 17l-5-5', 10));
    const caret = el('span', 'caret', '›');
    caret.setAttribute('aria-hidden', 'true');
    label.append(input, caret, tile, col, check);
    list.append(label);
  });
  $('gCount').textContent = info.candidates.length + ' 件';
  show('get');
  renderUv();
}

function renderEmpty() {
  $('eRpId').textContent = info.rpId;
  show('empty');
}

function render() {
  if (!info) return;
  renderChrome();
  if (info.locked) renderLocked();
  else if (info.kind === 'create') renderCreate();
  else if (info.candidates.length) renderGet();
  else renderEmpty();
}

function load() {
  loading ||= (async () => {
    try {
      info = await send(MSG.PASSKEY_REQUEST, { reqId });
      render();
    } catch {
      show('expired');
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---------- actions ----------

async function respond(payload) {
  if (busy) return;
  setBusy(true);
  try {
    await send(MSG.PASSKEY_RESPOND, { reqId, ...payload });
    // The service worker closes this window once the request settles.
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    if (code === 'LOCKED' || code === 'UV_REQUIRED') await load();
    else if (code === 'NOT_FOUND') show('expired');
    else toast('うまくいきませんでした。もう一度お試しください');
  } finally {
    setBusy(false);
  }
}

function cancel() {
  if (current === 'expired' || current === 'loading') { window.close(); return; }
  respond({ approve: false });
}

function fallback() {
  respond({ approve: false, fallback: true });
}

async function primary() {
  if (busy || arming()) return;
  switch (current) {
    case 'create': {
      if (info.excluded) { respond({ approve: true }); return; }
      const vault = document.querySelector('input[name="vault"]:checked')?.value;
      if (needsUv() && !(await verifyUv())) return;
      respond({ approve: true, vault });
      return;
    }
    case 'get': {
      const credentialId = document.querySelector('input[name="account"]:checked')?.value;
      if (!credentialId) { toast('アカウントを選んでください'); return; }
      if (needsUv() && !(await verifyUv())) return;
      respond({ approve: true, credentialId });
      return;
    }
    case 'empty': fallback(); return;
    case 'expired': window.close(); return;
    case 'locked': $('unlockForm').requestSubmit(); return;
    default:
  }
}

async function unlock(event) {
  event.preventDefault();
  if (busy) return;
  const input = $('pw');
  const hint = $('pwHint');
  const box = $('pwBox');
  const masterPassword = input.value;
  if (!masterPassword) {
    hint.textContent = 'パスワードを入力してください';
    hint.classList.add('error');
    box.classList.add('error');
    shake(box);
    return;
  }
  setBusy(true);
  $('goBtn').classList.add('busy');
  hint.classList.remove('error');
  box.classList.remove('error');
  hint.textContent = '鍵を準備しています…';
  try {
    await send(MSG.VAULT_UNLOCK, { masterPassword });
    bootLine('保管庫を解除', 'PBKDF2 · AES-256-GCM');
    // Unlocking here is a fresh proof for this request (sets user verification).
    const verified = await send(PASSKEY_VERIFY, { reqId, masterPassword }).then(() => true, () => false);
    if (verified) bootLine('本人確認', 'マスターパスワード');
    input.value = '';
    await $('lockOrb').animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }],
      { duration: 380, easing: 'cubic-bezier(.6,0,.2,1)', fill: 'forwards' },
    ).finished.catch(() => {});
    setBusy(false);
    await load();
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    hint.textContent = code === 'BAD_PASSWORD' ? 'パスワードが違います'
      : code === 'NOT_INITIALIZED' ? 'Akari のセットアップがまだ済んでいません'
        : 'ひらけませんでした';
    hint.classList.add('error');
    box.classList.add('error');
    shake(box);
    input.select();
  } finally {
    $('goBtn').classList.remove('busy');
    if (busy) setBusy(false);
  }
}

// ---------- wiring ----------

document.addEventListener('click', (event) => {
  const act = event.target.closest('[data-act]')?.dataset.act;
  if (act === 'cancel') cancel();
  else if (act === 'fallback') fallback();
  else if (act === 'primary') primary();
});

document.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  } else if (event.key === 'Enter') {
    const t = event.target;
    // Buttons, links and the unlock form handle Enter themselves.
    if (t.closest?.('button, a, form')) return;
    event.preventDefault();
    primary();
  }
});

$('unlockForm').addEventListener('submit', unlock);
for (const form of document.querySelectorAll('[data-uv]')) {
  form.addEventListener('submit', (event) => { event.preventDefault(); primary(); });
}
window.addEventListener('focus', rearm);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rearm(); });

// A live port, pinged regularly, keeps the service worker (and this request) alive.
try {
  const port = chrome.runtime.connect({ name: PORT_PREFIX + reqId });
  const ping = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); } catch { clearInterval(ping); }
  }, 20_000);
  port.onMessage.addListener((msg) => {
    // Ignored while this window is unlocking itself: it reloads after proving the password.
    if (msg?.type === 'refresh' && current === 'locked' && !busy) load();
  });
  port.onDisconnect.addListener(() => clearInterval(ping));
} catch {
  // extension context gone; the next action reports the request as expired
}

load();
