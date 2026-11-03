// Settings bottom sheet: auto-lock, clipboard clearing, master password, and the
// インポート / エクスポート pages (views/import.js, views/export.js) shown inside the same sheet.

import { MSG, ERR, DEFAULT_SETTINGS } from '../../shared/messages.js';
import { S, emit, call, strengthOf, errText, liveToken, live } from '../state.js';
import { syncInert, keepFocus } from './dom.js';
import { shake } from './fx.js';
import { setMeter } from './meter.js';
import { toast, toastError } from './toast.js';
import { setTrail, revokeDownloads } from './io.js';
import { initImport, openImport, resetImport, importBack } from './import.js';
import { openExport, resetExport, exportBack } from './export.js';

const $ = (id) => document.getElementById(id);

export const isSettingsOpen = () => $('setSheet').classList.contains('open');

/* ── pages: the settings list, インポート, エクスポート ── */

const PAGES = {
  main: { el: 'setMain', title: '設定', sub: 'akari config' },
  import: { el: 'importPage', title: 'インポート', sub: 'akari import' },
  export: { el: 'exportPage', title: 'エクスポート', sub: 'akari export' },
};
let page = 'main';

function showPage(name, { focus = true } = {}) {
  const prev = page;
  page = name;
  const sheet = $('setSheet');
  sheet.dataset.page = name;
  for (const [k, p] of Object.entries(PAGES)) $(p.el).hidden = k !== name;
  $('setTitle').textContent = PAGES[name].title;
  $('setSub').textContent = PAGES[name].sub;
  $('setBack').hidden = name === 'main';
  $('setBack').title = '戻る (alt+←)';
  if (prev === 'import' && name !== 'import') resetImport();
  if (prev === 'export' && name !== 'export') resetExport();
  if (name === 'main') {
    setTrail(null);
    if (focus) ({ import: $('importOpen'), export: $('exportOpen') }[prev] || sheet.querySelector('[data-close]')).focus({ preventScroll: true });
  } else if (name === 'import') {
    openImport({ focus });
  } else {
    openExport({ focus });
  }
}

function back() {
  if (page === 'import' && importBack()) return;
  if (page === 'export' && exportBack()) return;
  showPage('main');
}

/* ── settings list ── */

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

/* ── sheet ── */

let restoreFocus = null;

/** Open the sheet on the settings list, or straight on 'import' / 'export'. */
export function openSettings({ page: start = 'main' } = {}) {
  syncChips();
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
  resetImport();
  resetExport();
  revokeDownloads();
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open', 'dragging');
  sheet.setAttribute('aria-hidden', 'true');
  if (!$('genSheet').classList.contains('open')) $('scrim').classList.remove('on');
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
    $('setVersion').textContent = `akari v${m.version} · ゼロ知識・端末内で暗号化`;
  } catch { /* ignore */ }
  $('setSheet').querySelector('[data-close]').addEventListener('click', closeSettings);
  $('setBack').addEventListener('click', back);
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
  $('importOpen').addEventListener('click', () => showPage('import'));
  $('exportOpen').addEventListener('click', () => showPage('export'));
  // Alt+← goes one step back on the import / export pages
  $('setSheet').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.altKey && e.key === 'ArrowLeft' && page !== 'main') { e.preventDefault(); back(); }
  });
  initImport({ close: closeSettings });
}
