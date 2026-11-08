// Settings bottom sheet: language, theme, auto-lock, clipboard clearing, master password, and the
// 保管庫 / インポート / エクスポート pages (views/vaults.js, import.js, export.js) shown inside the same sheet.

import { MSG, ERR, DEFAULT_SETTINGS, NEVER_LOCK } from '../../shared/messages.js';
import { S, emit, call, strengthOf, errText, liveToken, live, setSettings, putSetting } from '../state.js';
import { syncInert, keepFocus } from './dom.js';
import { shake } from './fx.js';
import { setMeter } from './meter.js';
import { toast, toastError } from './toast.js';
import { setTrail, revokeDownloads, arrowNav, setRoving, setBusy } from './io.js';
import { initImport, openImport, resetImport, importBack, importDone } from './import.js';
import { openExport, resetExport, exportBack } from './export.js';
import { initVaults, openVaults, resetVaults, vaultsBack } from './vaults.js';
import { t, browserLocale } from '../../shared/i18n.js';

const $ = (id) => document.getElementById(id);

export const isSettingsOpen = () => $('setSheet').classList.contains('open');

/* ── pages: the settings list, 保管庫, インポート, エクスポート ── */

const PAGES = {
  main: { el: 'setMain', title: () => t('設定') },
  vaults: { el: 'vaultsPage', title: () => t('vaults.title', null, '保管庫') },
  import: { el: 'importPage', title: () => t('インポート') },
  export: { el: 'exportPage', title: () => t('エクスポート') },
};
let page = 'main';
let entry = 'main'; // the page the sheet was opened on: going back from it closes the sheet

function showPage(name, { focus = true } = {}) {
  const prev = page;
  page = name;
  const sheet = $('setSheet');
  sheet.dataset.page = name;
  for (const [k, p] of Object.entries(PAGES)) $(p.el).hidden = k !== name;
  $('setTitle').textContent = PAGES[name].title();
  $('setCmdLine').hidden = name !== 'main'; // the pages draw their own command line
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

/** One step back: inside a page first, then to the list — or out, from the page the sheet opened on. */
function back() {
  if (page === 'vaults' && vaultsBack()) return;
  if (page === 'import' && importBack()) return;
  if (page === 'export' && exportBack()) return;
  if (page === entry) closeSettings();
  else showPage('main');
}

/** Esc peels one layer: an open form on the list, then the same steps as 戻る; it closes the
 *  sheet from the list, from the page it opened on, and after a finished import. */
export function escapeSettings() {
  if (page === 'main') {
    if (!$('neverForm').hidden) { showNeverForm(false); chipOf('autoLockMinutes', NEVER_LOCK)?.focus(); return; }
    if ($('pwToggle').getAttribute('aria-expanded') === 'true') {
      setExpanded($('pwToggle'), $('pwForm'), false);
      resetPwForm();
      $('pwToggle').focus();
      return;
    }
    closeSettings();
    return;
  }
  if (page === 'import' && importDone()) { closeSettings(); return; }
  back();
}

/* ── the list's command line: `akari config`, then what was just set ── */

const CMD_VALUES = {
  language: (v) => `language ${v}`,
  theme: (v) => `theme ${v}`,
  autoLockMinutes: (v) => `auto-lock ${v === NEVER_LOCK ? 'never' : v === 0 ? 'on-browser-close' : `${v}m`}`,
  clipboardClearSeconds: (v) => `clipboard-clear ${v === 0 ? 'off' : `${v}s`}`,
};

function setCmd(text) {
  $('setCmd').textContent = text;
}

/* ── settings list ── */

const chipOf = (key, value) => document.querySelector(`#setSheet .chips[data-setting="${key}"] [data-value="${value}"]`);

/** What the chosen value does, in one line under its chips. */
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
  if (key === 'theme') globalThis.__akariTheme?.apply(value); // at once; undone below if it cannot be saved
  syncChips();
  try {
    const next = await call(MSG.SETTINGS_SET, { patch: { [key]: value } });
    if (next && typeof next === 'object') setSettings(next);
    syncChips();
    setCmd(`akari config set ${CMD_VALUES[key](value)}`);
    emit('settingsChanged', key);
    // every view builds its text in the language it starts in: reload, and come back here
    if (key === 'language') {
      try { sessionStorage.setItem('akari.reopen', 'settings'); } catch { /* storage blocked */ }
      setTimeout(() => location.reload(), 120);
    }
  } catch (e) {
    putSetting(key, prev);
    if (key === 'theme') globalThis.__akariTheme?.apply(prev);
    syncChips();
    toastError(t('設定を保存できませんでした'), errText(e));
  }
}

/* 自動ロック「しない」: the service worker keeps the vault key on this device, so it asks for
   the master password; the form says what that means before anything changes. */

function showNeverForm(open) {
  const form = $('neverForm');
  form.hidden = !open;
  chipOf('autoLockMinutes', NEVER_LOCK)?.classList.toggle('pending', open);
  $('neverPw').value = '';
  $('neverErr').textContent = '';
  if (open) {
    // one master-password form at a time
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

/** The strength meter and the three conditions, as the new password is typed. */
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

/* ── sheet ── */

let restoreFocus = null;

/** Open the sheet on the settings list, or straight on 'vaults' / 'import' / 'export'. */
export function openSettings({ page: start = 'main' } = {}) {
  entry = start;
  syncChips();
  setCmd('akari config');
  showNeverForm(false);
  resetPwForm();
  setExpanded($('pwToggle'), $('pwForm'), false);
  showPage('main', { focus: false });
  restoreFocus = keepFocus();
  $('scrim').classList.add('on');
  const sheet = $('setSheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('setMain').scrollTop = 0;
  syncInert();
  if (start !== 'main') showPage(start);
  else setTimeout(() => sheet.querySelector('[data-close]').focus({ preventScroll: true }), 60);
}

/** Close the sheet. Whatever the import/export pages held (file bytes, parsed items,
 *  typed passwords, pending download URLs) is dropped here — also on lock (popup.js lockNow). */
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
  } catch { /* ignore */ }
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
    // a radio group: arrows choose; landing on しない only moves focus (it asks for the password on Enter),
    // and so do the languages (choosing one reloads the popup)
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
    if (open) showNeverForm(false); // one master-password form at a time
    setExpanded($('pwToggle'), $('pwForm'), open);
    if (open) $('pwCurrent').focus();
    else resetPwForm();
  });
  $('pwNext').addEventListener('input', updatePwMeter);
  $('pwConfirm').addEventListener('input', updatePwMeter);
  $('pwForm').addEventListener('submit', changePassword);
  $('vaultsOpen').addEventListener('click', () => showPage('vaults'));
  $('importOpen').addEventListener('click', () => showPage('import'));
  $('exportOpen').addEventListener('click', () => showPage('export'));
  // Alt+← goes one step back on the vaults / import / export pages
  $('setSheet').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.altKey && e.key === 'ArrowLeft' && page !== 'main') { e.preventDefault(); back(); }
  });
  initImport({ close: closeSettings });
  initVaults();
}
