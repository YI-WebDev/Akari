import { send } from '../shared/api.js';
import { AkariError } from '../shared/errors.js';
import { MSG } from '../shared/messages.js';
import { t, getLocale } from '../shared/i18n.js';
import { useLanguage } from '../shared/locale.js';

const PORT_PREFIX = 'akari-passkey:';
const ARM_MS = 600;
const TOAST_MS = 2600;
const PORT_PING_MS = 20_000;
const UNLOCK_LOG_READ_MS = 380;
const reqId = new URLSearchParams(location.search).get('req') || '';

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('[data-screen]')];

let info = null;
let current = 'loading';
let busy = false;
let loading = null;
let armedAt = 0;
let armTimer = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
  if (d < min) return t('たった今');
  if (d < hour) return t('{n}分前', { n: Math.floor(d / min) });
  if (d < day) return t('{n}時間前', { n: Math.floor(d / hour) });
  if (d < 30 * day) return t('{n}日前', { n: Math.floor(d / day) });
  return new Date(ms).toLocaleDateString(getLocale() === 'en' ? 'en' : 'ja-JP');
}

function show(name) {
  const changed = current !== name;
  current = name;
  for (const s of screens) s.hidden = s.dataset.screen !== name;
  if (name === 'expired') $('stDot').dataset.state = 'off';
  if (changed) rearm();
  const titles = { create: t('パスキーを保存'), get: t('パスキーでサインイン'), locked: t('Akari をひらく') };
  document.title = (titles[name] ? titles[name] + ' — ' : '') + 'Akari';
}

let toastTimer = 0;
function toast(message) {
  const toastEl = $('toast');
  $('toastMsg').textContent = message;
  toastEl.classList.add('show');
  $('toastBar').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: TOAST_MS, easing: 'linear', fill: 'forwards' });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), TOAST_MS);
}

function shake(node) {
  node.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
      { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
    { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 260, easing: 'ease-out' },
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

async function verifyUv() {
  const input = uvForm().querySelector('.uv-pw');
  if (!input.value) { uvError(t('パスワードを入力してください')); return false; }
  setBusy(true);
  try {
    await send(MSG.PASSKEY_VERIFY, { reqId, masterPassword: input.value });
    input.value = '';
    info.verified = true;
    return true;
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    if (code === 'NOT_FOUND') show('expired');
    else uvError(code === 'BAD_PASSWORD' ? t('パスワードが違います') : t('確認できませんでした'));
    return false;
  } finally {
    setBusy(false);
  }
}

function withSite(site, template) {
  const [before, after = ''] = t(template).split('{site}');
  site.parentElement.replaceChildren(...[before, site, after].filter((n) => n !== ''));
}

function renderChrome() {
  for (const n of document.querySelectorAll('[data-rp]')) n.textContent = info.rpId;
  $('stOrigin').textContent = info.origin;
  $('stDot').dataset.state = info.locked ? 'locked' : 'ready';
}

function bootLine(key, value) {
  const line = el('div', 'boot-line');
  line.append(el('span', 'ok', '[ ok ]'), el('span', 'bk', key), el('span', 'dots'), el('span', 'bv', value));
  $('bootLog').append(line);
}

function renderLocked() {
  $('lockedSub').textContent = info.kind === 'create'
    ? t('{site} のパスキーを保存するには、マスターパスワードを入力してください', { site: info.rpId })
    : t('{site} にサインインするには、マスターパスワードを入力してください', { site: info.rpId });
  $('pwHint').textContent = '';
  $('pwHint').classList.remove('error');
  $('pwBox').classList.remove('error');
  $('bootLog').replaceChildren();
  show('locked');
  setTimeout(() => $('pw').focus(), 50);
}

function renderCreate() {
  const tile = $('cSiteTile');
  tile.textContent = initial(info.rpName || info.rpId);
  tile.style.setProperty('--hue', hueOf(info.rpId));
  $('cRpId').textContent = info.rpId;
  $('cOrigin').textContent = info.rpName && info.rpName !== info.rpId ? info.rpName + ' · ' + info.origin : info.origin;
  $('cUserDisplay').textContent = info.user.displayName || info.user.name || t('（名前なし）');
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
  $('createLabel').textContent = info.excluded ? t('閉じる') : t('保存する');
  show('create');
  renderUv();
}

function renderGet() {
  $('gRpId').textContent = info.rpId;
  withSite($('gRpId'), '{site} に使うアカウントを選んでください');
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
    const name = c.userDisplayName || c.userName || t('（名前なし）');
    const tile = el('span', 'tile', initial(name));
    tile.style.setProperty('--hue', hueOf(c.userName || name));
    const col = el('div', 'col');
    const used = ago(c.lastUsedAt);
    const meta = [c.userDisplayName && c.userName ? c.userName : null,
      used ? t('最終使用 {when}', { when: used }) : t('未使用'), c.itemTitle || null].filter(Boolean).join(' · ');
    col.append(el('div', 'name', name), el('div', 'meta', meta));
    const caret = el('span', 'caret', '›');
    caret.setAttribute('aria-hidden', 'true');
    label.append(input, caret, tile, col);
    list.append(label);
  });
  $('gCount').textContent = t('{n} 件', { n: info.candidates.length });
  show('get');
  renderUv();
}

function renderEmpty() {
  $('eRpId').textContent = info.rpId;
  withSite($('eRpId'), '{site} のパスキーは Akari に保存されていません');
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

async function respond(payload) {
  if (busy) return;
  setBusy(true);
  try {
    await send(MSG.PASSKEY_RESPOND, { reqId, ...payload });
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    if (code === 'LOCKED' || code === 'UV_REQUIRED') await load();
    else if (code === 'NOT_FOUND') show('expired');
    else toast(t('Akari から返事がありませんでした。もう一度押してください'));
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
      if (!credentialId) { toast(t('アカウントを選んでください')); return; }
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
    hint.textContent = t('パスワードを入力してください');
    hint.classList.add('error');
    box.classList.add('error');
    shake(box);
    return;
  }
  setBusy(true);
  $('goBtn').classList.add('busy');
  hint.classList.remove('error');
  box.classList.remove('error');
  hint.textContent = t('鍵を準備しています…');
  try {
    await send(MSG.VAULT_UNLOCK, { masterPassword });
    bootLine(t('保管庫を解除'), 'PBKDF2 · AES-256-GCM');
    const verified = await send(MSG.PASSKEY_VERIFY, { reqId, masterPassword }).then(() => true, () => false);
    if (verified) bootLine(t('本人確認'), t('マスターパスワード'));
    input.value = '';
    await new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : UNLOCK_LOG_READ_MS));
    setBusy(false);
    await load();
  } catch (e) {
    const code = e instanceof AkariError ? e.code : '';
    hint.textContent = code === 'BAD_PASSWORD' ? t('パスワードが違います')
      : code === 'NOT_INITIALIZED' ? t('Akari のセットアップがまだ済んでいません')
        : t('解除できませんでした。もう一度入力してください');
    hint.classList.add('error');
    box.classList.add('error');
    shake(box);
    input.select();
  } finally {
    $('goBtn').classList.remove('busy');
    if (busy) setBusy(false);
  }
}

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
    if (event.target.closest?.('button, a, form')) return;
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

try {
  const port = chrome.runtime.connect({ name: PORT_PREFIX + reqId });
  const ping = setInterval(() => {
    try { port.postMessage({ type: 'ping' }); } catch { clearInterval(ping); }
  }, PORT_PING_MS);
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'refresh' && current === 'locked' && !busy) load();
  });
  port.onDisconnect.addListener(() => clearInterval(ping));
} catch {
}

async function start() {
  let settings = null;
  try {
    settings = await send(MSG.SETTINGS_GET);
  } catch {
  }
  useLanguage(settings?.language || 'auto', document.documentElement);
  if (settings) globalThis.__akariTheme?.apply(settings.theme);
  load();
}

start();
