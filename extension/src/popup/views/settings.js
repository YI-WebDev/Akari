import { MSG, ERR, DEFAULT_SETTINGS, NEVER_LOCK } from '../../shared/messages.js';
import { S, on, emit, call, strengthOf, errText, liveToken, live, setSettings, putSetting, setDefaultEmail } from '../state.js';
import { syncInert, keepFocus, isComposing } from './dom.js';
import { shake } from './fx.js';
import { setMeter } from './meter.js';
import { toast, toastError } from './toast.js';
import { setTrail, revokeDownloads, arrowNav, setRoving, setBusy } from './io.js';
import { initImport, openImport, resetImport, importBack, importDone } from './import.js';
import { openExport, resetExport, exportBack } from './export.js';
import { initVaults, openVaults, resetVaults, vaultsBack } from './vaults.js';
import { t, browserLocale } from '../../shared/i18n.js';
import { cleanEmail, EMAIL_MAX_LENGTH } from '../../shared/email.js';

export const REOPEN_KEY = 'akari.reopen';

const $ = (id) => document.getElementById(id);
const RELOAD_DELAY_MS = 120;
const SHEET_FOCUS_DELAY_MS = 60;

export const isSettingsOpen = () => $('setSheet').classList.contains('open');

const PAGES = {
  main: { el: 'setMain', title: () => t('設定') },
  vaults: { el: 'vaultsPage', title: () => t('vaults.title', null, '保管庫') },
  import: { el: 'importPage', title: () => t('インポート') },
  export: { el: 'exportPage', title: () => t('エクスポート') },
};
let page = 'main';
let entry = 'main';

function showPage(name, { focus = true } = {}) {
  const prev = page;
  page = name;
  const sheet = $('setSheet');
  sheet.dataset.page = name;
  for (const [k, p] of Object.entries(PAGES)) $(p.el).hidden = k !== name;
  $('setTitle').textContent = PAGES[name].title();
  $('setCmdLine').hidden = name !== 'main';
  $('setBack').hidden = name === 'main';
  if (prev === 'vaults' && name !== 'vaults') resetVaults();
  if (prev === 'import' && name !== 'import') resetImport();
  if (prev === 'export' && name !== 'export') resetExport();
  if (name === 'main') {
    setTrail(null);
    const from = { vaults: $('vaultsOpen'), import: $('importOpen'), export: $('exportOpen') }[prev];
    if (focus) (from || sheet.querySelector('[data-close]')).focus({ preventScroll: true });
  } else if (name === 'vaults') {
    openVaults({ focus });
  } else if (name === 'import') {
    openImport({ focus });
  } else {
    openExport({ focus });
  }
}

function back() {
  if (page === 'vaults' && vaultsBack()) return;
  if (page === 'import' && importBack()) return;
  if (page === 'export' && exportBack()) return;
  if (page === entry) closeSettings();
  else showPage('main');
}

export function escapeSettings() {
  if (page === 'main') {
    if ($('emailForm').contains(document.activeElement) && revertEmail()) return;
    if (!$('neverForm').hidden) { showNeverForm(false); chipOf('autoLockMinutes', NEVER_LOCK)?.focus(); return; }
    if ($('pwToggle').getAttribute('aria-expanded') === 'true') {
      setExpanded($('pwToggle'), $('pwForm'), false);
      resetPwForm();
      $('pwToggle').focus();
      return;
    }
    if (revertEmail()) return;
    closeSettings();
    return;
  }
  if (page === 'import' && importDone()) { closeSettings(); return; }
  back();
}

const CMD_VALUES = {
  language: (v) => `language ${v}`,
  theme: (v) => `theme ${v}`,
  autoLockMinutes: (v) => `auto-lock ${v === NEVER_LOCK ? 'never' : v === 0 ? 'on-browser-close' : `${v}m`}`,
  clipboardClearSeconds: (v) => `clipboard-clear ${v === 0 ? 'off' : `${v}s`}`,
};

function setCmd(text) {
  $('setCmd').textContent = text;
}

const chipOf = (key, value) => document.querySelector(`#setSheet .chips[data-setting="${key}"] [data-value="${value}"]`);

function hintFor(key, v) {
  if (key === 'language') {
    if (v !== 'auto') return v === 'en' ? t('画面を英語で表示します') : t('画面を日本語で表示します');
    return t('ブラウザの言語に合わせます（いまは{lang}）', { lang: browserLocale() === 'ja' ? '日本語' : 'English' });
  }
  if (key === 'theme') {
    if (v === 'light') return t('settings.themeLight', null, '明るい紙の上に灯をともします。ページ上の入力メニューも同じです');
    if (v === 'auto') {
      const now = globalThis.__akariTheme?.current() === 'light' ? t('ライト') : t('ダーク');
      return t('settings.themeAuto', { mode: now }, 'OS の設定に合わせます（いまは{mode}）');
    }
    return t('settings.themeDark', null, 'Akari の暗い画面です');
  }
  if (key === 'autoLockMinutes') {
    if (v === NEVER_LOCK) return t('settings.hintNever', null, '自動ではロックしません。鍵のボタンでロックします');
    return v > 0 ? t('settings.hintIdle', { n: v }, '{n} 分操作しないと自動でロックします') : t('settings.hintBrowser', null, 'ブラウザを閉じるとロックします');
  }
  return v > 0 ? t('settings.hintClip', { n: v }, 'コピーした値は {n} 秒後にクリップボードから消えます') : t('settings.hintClipOff', null, 'コピーした値はクリップボードに残ります');
}

const valueOf = (key, raw) => (key === 'language' || key === 'theme' ? String(raw) : Number(raw));

function syncChips() {
  for (const group of document.querySelectorAll('#setSheet .chips[data-setting]')) {
    const key = group.dataset.setting;
    const value = valueOf(key, S.settings[key] ?? DEFAULT_SETTINGS[key]);
    const chips = [...group.querySelectorAll('button')];
    chips.forEach((b) => b.setAttribute('aria-checked', String(valueOf(key, b.dataset.value) === value)));
    setRoving(chips, Math.max(0, chips.findIndex((b) => valueOf(key, b.dataset.value) === value)));
    $(group.getAttribute('aria-describedby')).textContent = hintFor(key, value);
  }
}

async function setSetting(key, raw) {
  const value = valueOf(key, raw);
  if (S.settings[key] === value) return;
  const prev = putSetting(key, value);
  if (key === 'theme') globalThis.__akariTheme?.apply(value);
  syncChips();
  try {
    const next = await call(MSG.SETTINGS_SET, { patch: { [key]: value } });
    if (next && typeof next === 'object') setSettings(next);
    syncChips();
    setCmd(`akari config set ${CMD_VALUES[key](value)}`);
    emit('settingsChanged', key);
    if (key === 'language') {
      try { sessionStorage.setItem(REOPEN_KEY, 'settings'); } catch { }
      setTimeout(() => location.reload(), RELOAD_DELAY_MS);
    }
  } catch (e) {
    putSetting(key, prev);
    if (key === 'theme') globalThis.__akariTheme?.apply(prev);
    syncChips();
    toastError(t('設定を保存できませんでした'), errText(e));
  }
}

function showNeverForm(open) {
  const form = $('neverForm');
  form.hidden = !open;
  chipOf('autoLockMinutes', NEVER_LOCK)?.classList.toggle('pending', open);
  $('neverPw').value = '';
  $('neverErr').textContent = '';
  if (open) {
    setExpanded($('pwToggle'), $('pwForm'), false);
    resetPwForm();
    $('neverWarn').textContent = t('settings.neverWarn', null,
      'ロックしないと、この PC でブラウザを開ける人なら誰でも、マスターパスワードなしで保管庫を見たり、パスワードやパスキーを使ったりできます。保管庫の鍵はこの PC に保存され、ブラウザを再起動してもひらいたままになります。鍵のボタンでいつでも手動でロックできます。');
    $('neverPw').focus();
  }
}

async function enableNeverLock(e) {
  e.preventDefault();
  const pw = $('neverPw');
  const err = $('neverErr');
  const fail = (msg) => { err.textContent = msg; shake(pw.closest('.field')); pw.focus(); };
  if (!pw.value) return fail(t('settings.neverNeedPw', null, 'マスターパスワードを入力してください'));
  const btn = $('neverSubmit');
  setBusy(btn, true);
  err.textContent = '';
  const token = liveToken();
  try {
    const next = await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK }, masterPassword: pw.value });
    if (!live(token)) return;
    setSettings(next);
    showNeverForm(false);
    syncChips();
    setCmd(`akari config set ${CMD_VALUES.autoLockMinutes(NEVER_LOCK)}`);
    emit('settingsChanged', 'autoLockMinutes');
    toast(t('settings.neverDone', null, 'ロックしない設定にしました'), t('settings.neverDoneSub', null, 'ブラウザを再起動してもひらいたままになります'));
  } catch (e2) {
    if (!live(token)) return;
    if (e2?.code === ERR.BAD_PASSWORD) fail(t('settings.neverBadPw', null, 'マスターパスワードが違います'));
    else err.textContent = t('settings.neverFailed', { why: errText(e2) }, '変更できませんでした（{why}）');
  } finally {
    setBusy(btn, false);
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
  const st = strengthOf(v);
  setMeter($('pwMeter'), v ? st : {});
  $('pwChkLen').classList.toggle('ok', v.length >= 10);
  $('pwChkLv').classList.toggle('ok', !!v && st.level >= 2);
  $('pwChkMatch').classList.toggle('ok', !!v && v === $('pwConfirm').value);
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('pwCurrent').value;
  const next = $('pwNext').value;
  const confirm = $('pwConfirm').value;
  const err = $('pwErr');
  const fail = (msg, el) => { err.textContent = msg; shake(el); el.focus(); };
  if (!current) return fail(t('いまのマスターパスワードを入力してください'), $('pwCurrent'));
  if (next.length < 10) return fail(t('新しいパスワードは 10 文字以上にしてください'), $('pwNext'));
  if (strengthOf(next).level < 2) return fail(t('推測されやすいパスワードです。単語を足すか、記号や数字を混ぜてください'), $('pwNext'));
  if (next !== confirm) return fail(t('確認用のパスワードが一致しません'), $('pwConfirm'));
  if (next === current) return fail(t('いまと同じパスワードです'), $('pwNext'));
  const btn = $('pwSubmit');
  setBusy(btn, true);
  err.textContent = '';
  try {
    const token = liveToken();
    await call(MSG.VAULT_CHANGE_PASSWORD, { current, next });
    if (!live(token)) return;
    resetPwForm();
    setExpanded($('pwToggle'), $('pwForm'), false);
    setCmd('akari passwd');
    toast(t('マスターパスワードを変更しました'), t('次回からは新しいパスワードでひらきます'));
  } catch (e2) {
    if (e2?.code === ERR.BAD_PASSWORD) fail(t('いまのマスターパスワードが違います'), $('pwCurrent'));
    else err.textContent = t('変更できませんでした（{why}）', { why: errText(e2) });
  } finally {
    setBusy(btn, false);
  }
}

let emailSaving = false;
let emailShown = '';

function emailHint(value) {
  if (value.trim() !== S.defaultEmail) {
    return value.trim()
      ? t('settings.emailHintDirty', null, 'Enter で保存します。Esc で元に戻します')
      : t('settings.emailHintUnset', null, 'Enter で既定のメールを外します。Esc で元に戻します');
  }
  return S.defaultEmail
    ? t('settings.emailHintSet', null, 'ページのメール欄を選ぶと、このアドレスを候補の先頭に出します。ID アイテムのメールも続けて出ます')
    : t('settings.emailHintNone', null, 'ここに入れたアドレスを、ページのメール欄からクリック 1 回で入力できます。ID アイテムのメールも候補に出ます');
}

function renderEmail() {
  const value = $('emailInput').value;
  $('emailSave').disabled = emailSaving || value.trim() === S.defaultEmail;
  $('emailClear').hidden = !S.defaultEmail;
  $('emailClear').disabled = emailSaving;
  $('emailHint').textContent = emailHint(value);
}

function showEmailErr(msg, { invalid = !!msg } = {}) {
  $('emailErr').textContent = msg;
  $('emailInput').closest('.field').classList.toggle('invalid', invalid);
  $('emailInput').setAttribute('aria-invalid', String(invalid));
}

function resetEmail() {
  if (emailSaving) return;
  emailShown = S.defaultEmail;
  $('emailInput').value = emailShown;
  showEmailErr('');
  renderEmail();
}

function followEmail() {
  const edited = $('emailInput').value !== emailShown || !!$('emailErr').textContent;
  if (emailSaving || edited) renderEmail();
  else resetEmail();
}

function revertEmail() {
  if (emailSaving || ($('emailInput').value === S.defaultEmail && !$('emailErr').textContent)) return false;
  resetEmail();
  $('emailInput').focus();
  return true;
}

function failEmail(msg) {
  const input = $('emailInput');
  showEmailErr(msg);
  shake(input.closest('.field'));
  input.focus();
}

const badEmailText = (raw) => (raw.length > EMAIL_MAX_LENGTH
  ? t('settings.emailTooLong', { n: EMAIL_MAX_LENGTH }, 'メールアドレスが長すぎます（{n} 文字まで）')
  : t('settings.emailBad', null, 'メールアドレスの形式ではありません（例: you@example.com）'));

function submitEmail(e) {
  e.preventDefault();
  if (emailSaving) return;
  const raw = $('emailInput').value.trim();
  if (raw === S.defaultEmail) return;
  const email = raw && cleanEmail(raw);
  if (raw && !email) return failEmail(badEmailText(raw));
  saveEmail(email, $('emailSave'));
}

async function saveEmail(email, btn) {
  const input = $('emailInput');
  emailSaving = true;
  input.readOnly = true;
  showEmailErr('');
  setBusy(btn, true);
  renderEmail();
  const token = liveToken();
  try {
    const res = await call(MSG.VAULT_SET_DEFAULT_EMAIL, { email });
    if (!live(token)) return;
    setDefaultEmail(typeof res?.defaultEmail === 'string' ? res.defaultEmail : email);
    emailShown = S.defaultEmail;
    input.value = emailShown;
    setCmd(S.defaultEmail ? `akari config set default-email ${S.defaultEmail}` : 'akari config unset default-email');
  } catch (e2) {
    if (!live(token)) return;
    if (e2?.code === ERR.INVALID) failEmail(badEmailText(input.value.trim()));
    else showEmailErr(t('settings.emailFailed', { why: errText(e2) }, '保存できませんでした（{why}）'), { invalid: false });
  } finally {
    emailSaving = false;
    input.readOnly = false;
    setBusy(btn, false);
    renderEmail();
    const ae = document.activeElement;
    if (!live(token)) resetEmail();
    else if (isSettingsOpen() && (!ae || ae === document.body || $('emailForm').contains(ae))) input.focus();
  }
}

function clearEmail() {
  if (emailSaving || !S.defaultEmail) return;
  saveEmail('', $('emailClear'));
}

let restoreFocus = null;

export function openSettings({ page: start = 'main' } = {}) {
  entry = start;
  syncChips();
  setCmd('akari config');
  showNeverForm(false);
  resetPwForm();
  setExpanded($('pwToggle'), $('pwForm'), false);
  resetEmail();
  showPage('main', { focus: false });
  restoreFocus = keepFocus();
  $('scrim').classList.add('on');
  const sheet = $('setSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('setMain').scrollTop = 0;
  syncInert();
  if (start !== 'main') showPage(start);
  else setTimeout(() => sheet.querySelector('[data-close]').focus({ preventScroll: true }), SHEET_FOCUS_DELAY_MS);
}

export function closeSettings() {
  const sheet = $('setSheet');
  resetVaults();
  resetImport();
  resetExport();
  revokeDownloads();
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open', 'dragging');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('genSheet').classList.contains('open')) $('scrim').classList.remove('on');
  showNeverForm(false);
  resetPwForm();
  resetEmail();
  showPage('main', { focus: false });
  syncInert();
  restoreFocus?.();
  restoreFocus = null;
  emit('sheetClosed');
}

export function initSettings() {
  try {
    const m = chrome.runtime.getManifest();
    $('setVersion').textContent = `akari v${m.version} · ${t('暗号化して、このブラウザの中だけに保存します')}`;
  } catch { }
  $('setSheet').querySelector('[data-close]').addEventListener('click', closeSettings);
  $('setBack').addEventListener('click', back);
  for (const group of document.querySelectorAll('#setSheet .chips[data-setting]')) {
    const key = group.dataset.setting;
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      const lockOff = key === 'autoLockMinutes' && Number(b.dataset.value) === NEVER_LOCK;
      if (lockOff && S.settings.autoLockMinutes !== NEVER_LOCK) return showNeverForm(true);
      if (key === 'autoLockMinutes') showNeverForm(false);
      setSetting(key, b.dataset.value);
    });
    arrowNav(group, 'button[data-value]', {
      onMove: (b) => {
        if (key === 'language') return;
        if (key === 'autoLockMinutes' && Number(b.dataset.value) === NEVER_LOCK) return;
        b.click();
      },
    });
  }
  $('neverForm').addEventListener('submit', enableNeverLock);
  $('neverPw').addEventListener('input', () => { $('neverErr').textContent = ''; });
  $('neverCancel').addEventListener('click', () => { showNeverForm(false); chipOf('autoLockMinutes', NEVER_LOCK)?.focus(); });
  $('pwToggle').addEventListener('click', () => {
    const open = $('pwToggle').getAttribute('aria-expanded') !== 'true';
    if (open) showNeverForm(false);
    setExpanded($('pwToggle'), $('pwForm'), open);
    if (open) $('pwCurrent').focus();
    else resetPwForm();
  });
  $('pwNext').addEventListener('input', updatePwMeter);
  $('pwConfirm').addEventListener('input', updatePwMeter);
  $('pwForm').addEventListener('submit', changePassword);
  $('emailForm').addEventListener('submit', submitEmail);
  $('emailInput').addEventListener('input', () => { showEmailErr(''); renderEmail(); });
  $('emailClear').addEventListener('click', clearEmail);
  on('reloaded', followEmail);
  $('vaultsOpen').addEventListener('click', () => showPage('vaults'));
  $('importOpen').addEventListener('click', () => showPage('import'));
  $('exportOpen').addEventListener('click', () => showPage('export'));
  $('setSheet').addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.altKey && e.key === 'ArrowLeft' && page !== 'main') { e.preventDefault(); back(); }
  });
  initImport({ close: closeSettings });
  initVaults();
}
