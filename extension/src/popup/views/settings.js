// Settings bottom sheet: auto-lock, clipboard clearing, master password, backup.

import { MSG, ERR, DEFAULT_SETTINGS } from '../../shared/messages.js';
import { S, emit, call, strengthOf, errText, liveToken, live } from '../state.js';
import { yyyymmdd } from './format.js';
import { syncInert, keepFocus } from './dom.js';
import { shake } from './fx.js';
import { setMeter } from './meter.js';
import { toast, toastError } from './toast.js';

const $ = (id) => document.getElementById(id);

export const isSettingsOpen = () => $('setSheet').classList.contains('open');

function syncChips() {
  for (const group of document.querySelectorAll('#setSheet .chips[data-setting]')) {
    const key = group.dataset.setting;
    const cur = String(S.settings[key] ?? DEFAULT_SETTINGS[key]);
    for (const b of group.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === cur));
  }
}

async function setSetting(key, raw) {
  const value = Number(raw);
  const prev = S.settings[key];
  if (prev === value) return;
  S.settings = { ...S.settings, [key]: value };
  syncChips();
  try {
    const next = await call(MSG.SETTINGS_SET, { patch: { [key]: value } });
    if (next && typeof next === 'object') S.settings = { ...DEFAULT_SETTINGS, ...next };
    syncChips();
    emit('settingsChanged', key);
  } catch (e) {
    S.settings = { ...S.settings, [key]: prev };
    syncChips();
    toastError('設定を保存できませんでした', errText(e));
  }
}

function setExpanded(btn, form, open) {
  btn.setAttribute('aria-expanded', String(open));
  form.hidden = !open;
}

function resetPwForm() {
  for (const id of ['pwCurrent', 'pwNext', 'pwConfirm']) $(id).value = '';
  $('pwErr').textContent = '';
  updatePwMeter();
}

function updatePwMeter() {
  const v = $('pwNext').value;
  setMeter($('pwMeter'), v ? strengthOf(v) : {});
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('pwCurrent').value;
  const next = $('pwNext').value;
  const confirm = $('pwConfirm').value;
  const err = $('pwErr');
  const fail = (msg, el) => { err.textContent = msg; shake(el); el.focus(); };
  if (!current) return fail('いまのマスターパスワードを入力してください', $('pwCurrent'));
  if (next.length < 10) return fail('新しいパスワードは 10 文字以上にしてください', $('pwNext'));
  if (strengthOf(next).level < 2) return fail('もう少し推測されにくくしてください', $('pwNext'));
  if (next !== confirm) return fail('確認用のパスワードが一致しません', $('pwConfirm'));
  if (next === current) return fail('いまと同じパスワードです', $('pwNext'));
  const btn = $('pwSubmit');
  btn.disabled = true;
  err.textContent = '';
  try {
    const token = liveToken();
    await call(MSG.VAULT_CHANGE_PASSWORD, { current, next });
    if (!live(token)) return;
    resetPwForm();
    setExpanded($('pwToggle'), $('pwForm'), false);
    toast('マスターパスワードを変更しました', '次回からは新しいパスワードでひらきます');
  } catch (e2) {
    if (e2?.code === ERR.BAD_PASSWORD) fail('いまのマスターパスワードが違います', $('pwCurrent'));
    else err.textContent = '変更できませんでした（' + errText(e2) + '）';
  } finally {
    btn.disabled = false;
  }
}

async function exportBackup() {
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    const token = liveToken();
    const res = await call(MSG.VAULT_EXPORT);
    if (!live(token)) return;
    const json = typeof res?.json === 'string' ? res.json : JSON.stringify(res?.json ?? res);
    const name = `akari-backup-${yyyymmdd()}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('バックアップを書き出しました', name);
  } catch (e) {
    toastError('書き出せませんでした', errText(e));
  } finally {
    btn.disabled = false;
  }
}

async function importBackup(e) {
  e.preventDefault();
  const file = $('importFile').files?.[0];
  const pw = $('importPw').value;
  const err = $('importErr');
  err.textContent = '';
  if (!file) { err.textContent = 'ファイルを選んでください'; shake($('importFile').parentElement); return; }
  if (!pw) { err.textContent = 'バックアップのマスターパスワードを入力してください'; shake($('importPw')); $('importPw').focus(); return; }
  if (file.size > 20 * 1024 * 1024) { err.textContent = 'ファイルが大きすぎます'; return; }
  const btn = $('importSubmit');
  btn.disabled = true;
  try {
    const json = await file.text();
    try { JSON.parse(json); } catch { err.textContent = 'Akari のバックアップファイルではありません'; return; }
    const token = liveToken();
    const res = await call(MSG.VAULT_IMPORT, { json, masterPassword: pw });
    if (!live(token)) return;
    $('importPw').value = '';
    $('importFile').value = '';
    $('importFileName').textContent = 'ファイルを選ぶ…';
    setExpanded($('importToggle'), $('importForm'), false);
    toast(`${res?.count ?? 0} 件を読み込みました`, file.name);
    emit('reload');
  } catch (e2) {
    if (e2?.code === ERR.BAD_PASSWORD) { err.textContent = 'バックアップのパスワードが違います'; shake($('importPw')); }
    else if (e2?.code === ERR.INVALID) err.textContent = 'バックアップファイルを読み込めませんでした';
    else err.textContent = '読み込めませんでした（' + errText(e2) + '）';
  } finally {
    btn.disabled = false;
  }
}

export function openSettings() {
  syncChips();
  resetPwForm();
  setExpanded($('pwToggle'), $('pwForm'), false);
  setExpanded($('importToggle'), $('importForm'), false);
  $('importErr').textContent = '';
  restoreFocus = keepFocus();
  $('scrim').classList.add('on');
  const sheet = $('setSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  sheet.querySelector('.set-scroll').scrollTop = 0;
  syncInert();
  setTimeout(() => sheet.querySelector('[data-close]').focus({ preventScroll: true }), 60);
}

let restoreFocus = null;

export function closeSettings() {
  const sheet = $('setSheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('genSheet').classList.contains('open')) $('scrim').classList.remove('on');
  resetPwForm();
  $('importPw').value = '';
  syncInert();
  restoreFocus?.();
  restoreFocus = null;
  emit('sheetClosed');
}

export function initSettings() {
  try {
    const m = chrome.runtime.getManifest();
    $('setVersion').textContent = `akari v${m.version} · ゼロ知識・端末内で暗号化`;
  } catch { /* ignore */ }
  $('setSheet').querySelector('[data-close]').addEventListener('click', closeSettings);
  for (const group of document.querySelectorAll('#setSheet .chips[data-setting]')) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) setSetting(group.dataset.setting, b.dataset.value);
    });
  }
  $('pwToggle').addEventListener('click', () => {
    const open = $('pwToggle').getAttribute('aria-expanded') !== 'true';
    setExpanded($('pwToggle'), $('pwForm'), open);
    if (open) $('pwCurrent').focus();
    else resetPwForm();
  });
  $('pwNext').addEventListener('input', updatePwMeter);
  $('pwForm').addEventListener('submit', changePassword);
  $('exportBtn').addEventListener('click', exportBackup);
  $('importToggle').addEventListener('click', () => {
    const open = $('importToggle').getAttribute('aria-expanded') !== 'true';
    setExpanded($('importToggle'), $('importForm'), open);
  });
  $('importFile').addEventListener('change', () => {
    const f = $('importFile').files?.[0];
    $('importFileName').textContent = f ? f.name : 'ファイルを選ぶ…';
  });
  $('importForm').addEventListener('submit', importBackup);
}
