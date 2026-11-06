// インポート page of the settings sheet (PLAN.md §7.4):
// 読み込み元 → ファイル (→ パスワード / パスフレーズ) → 確認 → 完了.
// Another manager's export is parsed here in the popup (lib/import); only the normalised
// items go to the service worker (vault/importItems). The file bytes and the parsed items
// live in this module alone and are dropped when the page or the sheet closes, or the vault locks.
// The Akari backup keeps its own path: file + the backup's master password → vault/import.

import { MSG, ERR } from '../../shared/messages.js';
import { S, emit, call, errText, liveToken, live } from '../state.js';
import { h, clear, svgEl } from './dom.js';
import { shake, rise, reducedMotion } from './fx.js';
import { vaultColor } from './format.js';
import { toast } from './toast.js';
import { cmdLine, logLine, setTrail, arrowNav, setRoving, setBusy, goButton } from './io.js';

const $ = (id) => document.getElementById(id);
const MB = 1024 * 1024;
const MAX_BYTES = 64 * MB;
const BACKUP_MAX = 20 * MB;
const COLS = 4;
const LEAD = '別のパスワードマネージャーから移行するには、そのアプリでデータを書き出してから、ここで読み込みます。読み込んだら、書き出したファイルは削除してください。';
const AKARI = Object.freeze({ id: 'akari', name: 'Akari バックアップ', exts: ['json'], own: true });
const STEPS = ['読み込み元', 'ファイル', '確認', '完了'];
const STEPS_BACKUP = ['読み込み元', 'ファイル', '完了'];

let lib = null; // { SOURCES, parseImport, isPgp } — lib/import, loaded when the page first opens
let st = fresh();
let run = 0; // bumped on every step change / new file / reset: async results of an older run are dropped
let hooks = { close: () => {} };
let lastId = null; // the source picked last, focused again on the source list

function fresh() {
  return { step: 'source', source: null, file: null, needs: null, parsed: null, vault: null, busy: false, els: {} };
}

const isImportPage = () => {
  const sheet = $('setSheet');
  return sheet.classList.contains('open') && sheet.dataset.page === 'import';
};

async function loadLib() {
  if (lib) return lib;
  const [index, model] = await Promise.all([import('../../lib/import/index.js'), import('../../lib/import/model.js')]);
  lib = { SOURCES: index.SOURCES, parseImport: index.parseImport, isPgp: model.isPgp };
  return lib;
}

const quote = (s) => (/[\s'"]/.test(s) ? `'${String(s).replace(/'/g, '')}'` : s);
const isImportError = (e) => e?.name === 'ImportError' && typeof e.code === 'string';
const steps = () => (st.source?.own ? STEPS_BACKUP : STEPS);

/* ── memory ── */

function wipeFile() {
  st.file?.bytes?.fill(0);
  st.file = null;
}

/** Forget the file, the parsed items and every field of the page. */
export function resetImport() {
  run++;
  wipeFile();
  if (st.parsed) st.parsed.items = null;
  st = fresh();
  clear($('importPage'));
  $('setSheet').classList.remove('dragging');
}

/* ── page plumbing ── */

function go(step) {
  run++;
  st.step = step;
  st.busy = false;
}

function mount(stepIdx, kids) {
  const page = $('importPage');
  clear(page);
  page.append(...kids.filter(Boolean));
  page.scrollTop = 0;
  setTrail(steps(), stepIdx);
  rise(page, '[data-f]');
}

function foot(...kids) {
  return h('div', { class: 'io-foot', 'data-f': '' }, ...kids);
}

const backBtn = () => h('button', { class: 'btn-text', type: 'button', onclick: () => importBack() }, '戻る');

/** The sheet head's back button: one step back, or false to leave the page. */
/** The import has finished (its result is on screen): Esc closes the sheet from here. */
export const importDone = () => st.step === 'done';

export function importBack() {
  switch (st.step) {
    case 'file': renderSource(); return true;
    case 'review': renderFile(); return true;
    case 'done': renderSource(); return true;
    default: return false;
  }
}

export async function openImport({ focus = true } = {}) {
  resetImport();
  const my = run;
  if (!lib) {
    const line = logLine('run', '読み込み元を準備中');
    mount(0, [cmdLine('akari import'), line]);
    try {
      await loadLib();
    } catch {
      if (my === run) line.set('err', '読み込み機能をひらけませんでした');
      return;
    }
    if (my !== run || !isImportPage()) return;
  }
  renderSource({ focus });
}

/* ── 1. 読み込み元 ── */

function renderSource({ focus = true } = {}) {
  go('source');
  wipeFile();
  st.source = null;
  st.parsed = null;
  st.needs = null;
  const all = [AKARI, ...lib.SOURCES];
  const grid = h('div', { class: 'src-grid', role: 'group', 'aria-label': '読み込み元' });
  for (const s of all) {
    grid.append(h('button', {
      class: 'src' + (s.own ? ' own' : ''), type: 'button', tabindex: '-1', dataset: { id: s.id },
      'aria-label': `${s.name}（${s.exts.join(', ')}）`,
      onclick: () => chooseSource(s),
    }, h('span', { class: 'src-name' }, s.name), h('span', { class: 'src-ext' }, s.exts.join(', '))));
  }
  arrowNav(grid, '.src', { cols: COLS });
  const buttons = [...grid.children];
  const cur = Math.max(0, all.findIndex((s) => s.id === lastId));
  setRoving(buttons, cur);
  const err = h('div', { class: 'field-err', role: 'alert' });
  st.els = { err };
  mount(0, [
    cmdLine('akari import --from'),
    h('p', { class: 'io-lead', 'data-f': '' }, LEAD),
    h('div', { class: 'src-wrap', 'data-f': '' }, grid,
      h('div', { class: 'drop-veil', 'aria-hidden': 'true' },
        h('span', null, h('span', { class: 'ps' }, '$ '), 'ドロップすると形式を判定して読み込みます', h('span', { class: 'cursor' })))),
    err,
  ]);
  if (focus) buttons[cur].focus({ preventScroll: true });
}

function chooseSource(s) {
  st.source = s;
  lastId = s.id;
  renderFile();
}

/* ── 2. ファイル (+ パスワード) ── */

const upIcon = () => {
  const svg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M12 16V4M7 9l5-5 5 5' }), svgEl('path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }));
  return svg;
};

function renderFile({ focus = true } = {}) {
  go('file');
  wipeFile();
  st.parsed = null;
  st.needs = null;
  const s = st.source;
  const backup = !!s.own;
  const exts = s.exts.map((x) => '.' + x);
  const what = backup ? 'Akari で書き出したバックアップ'
    : s.id === 'pgp' ? 'PGP で暗号化したエクスポート'
      : s.id === 'generic' ? 'ほかのアプリから書き出した CSV'
        : `${s.name} から書き出したファイル`;
  const els = {};
  els.input = h('input', { id: 'impFile', type: 'file', accept: exts.join(','), 'aria-describedby': 'impDropSub' });
  els.input.addEventListener('change', () => {
    const f = els.input.files?.[0];
    els.input.value = ''; // the File stays readable; the input no longer holds it
    if (f) takeFile(f);
  });
  els.name = h('span', { class: 'drop-name' }, 'ファイルを選ぶ…');
  els.drop = h('label', { class: 'drop', 'data-f': '' },
    els.input,
    h('span', { class: 'drop-ico', 'aria-hidden': 'true' }, upIcon()),
    h('span', { class: 'drop-text' },
      h('span', { class: 'drop-main' }, h('span', { class: 'ps', 'aria-hidden': 'true' }, '$ '), els.name),
      h('span', { id: 'impDropSub', class: 'drop-sub' }, `${exts.join(' ')} · ${what} · ここにドロップしても読み込めます`)));
  els.log = h('div', { class: 'io-log', 'aria-live': 'polite' });

  els.pwLabel = h('label', { class: 'io-k', for: 'impPw' }, backup ? 'マスターパスワード' : 'パスワード');
  els.pw = h('input', { id: 'impPw', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'impPwHint' });
  els.pwField = h('div', { class: 'field io-field' }, els.pw);
  els.pwGo = goButton(backup ? '読み込む' : '開く', { type: 'submit', class: 'btn-primary btn-sm' });
  els.pwHint = h('div', { id: 'impPwHint', class: 'io-hint' },
    backup ? 'バックアップを書き出したときの Akari のマスターパスワード' : '');
  els.form = h('form', { class: 'io-pass', novalidate: true, hidden: !backup, 'data-f': '' },
    els.pwLabel, els.pwField, els.pwGo, els.pwHint);
  els.form.addEventListener('submit', (e) => { e.preventDefault(); submitPassword(); });
  els.pw.addEventListener('input', () => {
    els.pwField.classList.remove('err');
    if (!st.busy) els.err.textContent = '';
  });
  els.err = h('div', { class: 'field-err', role: 'alert' });
  els.cmd = cmdLine(backup ? 'akari import --backup' : `akari import --from ${s.id}`);
  const notes = h('ul', { class: 'io-notes', 'data-f': '' },
    h('li', null, 'ファイルはこの端末の中だけで読み取ります。どこにも送信しません。'),
    backup ? h('li', null, '読み込んだアイテムは、いまの保管庫に追加されます。') : h('li', null, '読み込みが終わったら、書き出したファイルは削除してください。'));
  st.els = els;
  mount(1, [els.cmd, els.drop, els.log, els.form, notes, foot(backBtn(), els.err)]);
  if (focus) els.input.focus({ preventScroll: true });
}

function setCmd(text) {
  st.els.cmd?.querySelector('.io-cmd-text')?.replaceChildren(text);
}

function fail(msg, el) {
  if (!st.els.err) return;
  st.els.err.textContent = msg;
  if (el) shake(el);
}

async function takeFile(f) {
  if (st.step !== 'file' || st.busy) return;
  const limit = st.source.own ? BACKUP_MAX : MAX_BYTES;
  if (f.size > limit) return fail(`ファイルが大きすぎます（${limit / MB} MB まで）`, st.els.drop);
  if (!f.size) return fail('空のファイルです', st.els.drop);
  const my = ++run;
  const token = liveToken();
  let bytes;
  try {
    bytes = new Uint8Array(await f.arrayBuffer());
  } catch {
    if (my === run) fail('ファイルを読めませんでした', st.els.drop);
    return;
  }
  if (my !== run || !live(token)) { bytes.fill(0); return; }
  acceptBytes(f.name, bytes);
}

/** A file is in hand: show it, then parse it (or wait for the backup's password). */
function acceptBytes(name, bytes) {
  const { els } = st;
  wipeFile();
  st.file = { name, bytes };
  st.needs = null;
  els.err.textContent = '';
  els.name.textContent = name;
  els.drop.classList.add('has-file');
  setCmd(st.source.own ? `akari import --backup ${quote(name)}` : `akari import --from ${st.source.id} ${quote(name)}`);
  if (st.source.own) {
    els.log.replaceChildren(logLine('ok', 'ファイルを選択', `${name} · ${kb(bytes.length)}`));
    els.pw.focus();
    return;
  }
  els.form.hidden = true;
  parse();
}

const kb = (n) => (n < 1024 ? `${n} B` : n < MB ? `${(n / 1024).toFixed(1)} KB` : `${(n / MB).toFixed(1)} MB`);

async function parse(password) {
  const my = run;
  const token = liveToken();
  const { els } = st;
  st.busy = true;
  els.err.textContent = '';
  els.pwField.classList.remove('err');
  if (password) setBusy(els.pwGo, true);
  els.log.replaceChildren(logLine('run', password ? '復号・解析中' : '解析中', st.file.name));
  const t0 = performance.now();
  try {
    const out = await lib.parseImport({
      source: st.source.id,
      file: { name: st.file.name, bytes: st.file.bytes },
      ...(password ? { password } : {}),
    });
    if (my !== run || !live(token)) return;
    out.ms = performance.now() - t0;
    out.fileName = st.file.name;
    wipeFile();
    st.parsed = out;
    renderReview();
  } catch (e) {
    if (my !== run || !live(token)) return;
    st.busy = false;
    setBusy(els.pwGo, false);
    const code = isImportError(e) ? e.code : '';
    if (code === 'NEEDS_PASSWORD') return askPassword(e.message);
    if (code === 'BAD_PASSWORD') return askPassword(null, { wrong: true });
    els.log.replaceChildren(logLine('err', '読み込めませんでした', st.file.name));
    fail(code && e.message ? e.message : 'このファイルを読み込めませんでした。読み込み元と形式を確認してください', els.drop);
  }
}

/** The file is encrypted: ask for the PGP passphrase or the export password, then retry. */
function askPassword(hint, { wrong = false } = {}) {
  const { els } = st;
  const pgp = lib.isPgp(st.file.bytes);
  const label = pgp ? 'パスフレーズ' : 'パスワード';
  st.needs = label;
  els.pwLabel.textContent = label;
  els.pw.placeholder = pgp ? 'PGP のパスフレーズ' : '書き出すときに設定したパスワード';
  if (hint) els.pwHint.textContent = hint;
  else if (!els.pwHint.textContent) els.pwHint.textContent = pgp ? 'PGP で暗号化されたファイルです。' : 'パスワードで保護されたファイルです。';
  const wasHidden = els.form.hidden;
  els.form.hidden = false;
  els.log.replaceChildren(logLine('ask', `${label}が必要です`, st.file.name));
  if (wasHidden && !reducedMotion()) {
    els.form.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  if (wrong) {
    els.pwField.classList.add('err');
    fail(`${label}が違います`, els.pwField);
    els.pw.select();
  }
  els.pw.focus();
}

function submitPassword() {
  if (st.busy) return;
  const { els } = st;
  if (!st.file) {
    fail('ファイルを選んでください', els.drop);
    els.input.focus();
    return;
  }
  const v = els.pw.value;
  if (!v) {
    els.pwField.classList.add('err');
    fail(st.source.own ? 'バックアップのマスターパスワードを入力してください' : `${st.needs || 'パスワード'}を入力してください`, els.pwField);
    els.pw.focus();
    return;
  }
  if (st.source.own) importBackup(v);
  else parse(v);
}

/* ── Akari バックアップ ── */

const BACKUP_HEAD = /^\s*\{\s*"format"\s*:\s*"akari-backup"/;
const looksLikeBackup = (bytes) => BACKUP_HEAD.test(new TextDecoder().decode(bytes.subarray(0, 256)));

async function importBackup(pw) {
  const { els } = st;
  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(st.file.bytes);
    if (JSON.parse(json)?.format !== 'akari-backup') throw new Error('format');
  } catch {
    fail('Akari のバックアップファイルではありません', els.drop);
    return;
  }
  const my = run;
  const token = liveToken();
  const name = st.file.name;
  st.busy = true;
  setBusy(els.pwGo, true);
  els.err.textContent = '';
  els.log.replaceChildren(logLine('run', '復号・読み込み中', name));
  try {
    const res = await call(MSG.VAULT_IMPORT, { json, masterPassword: pw });
    if (!live(token)) return;
    emit('reload');
    const count = res?.count ?? 0;
    if (my !== run) { toast(`${count} 件を読み込みました`, name); return; }
    renderDone({ backup: true, count, name });
  } catch (e) {
    if (!live(token) || my !== run) return;
    st.busy = false;
    setBusy(els.pwGo, false);
    els.log.replaceChildren(logLine('ok', 'ファイルを選択', `${name} · ${kb(st.file?.bytes.length || 0)}`));
    if (e?.code === ERR.BAD_PASSWORD) {
      els.pwField.classList.add('err');
      fail('バックアップのパスワードが違います', els.pwField);
      els.pw.select();
      els.pw.focus();
    } else if (e?.code === ERR.INVALID) fail('バックアップファイルを読み込めませんでした');
    else fail('読み込めませんでした（' + errText(e) + '）');
  }
}

/* ── drop on the source list: detect the format ── */

async function dropOnSource(f) {
  if (f.size > MAX_BYTES) return fail(`ファイルが大きすぎます（${MAX_BYTES / MB} MB まで）`);
  const my = ++run;
  const token = liveToken();
  st.busy = true;
  let bytes;
  let id = null;
  try {
    bytes = new Uint8Array(await f.arrayBuffer());
    if (looksLikeBackup(bytes)) id = 'akari';
    else if (lib.isPgp(bytes)) id = 'pgp';
    else {
      const { detectSource } = await import('../../lib/import/detect.js');
      id = await detectSource({ name: f.name, bytes });
    }
  } catch { id = null; }
  if (my !== run || !live(token)) { bytes?.fill(0); return; }
  st.busy = false;
  const s = id === 'akari' ? AKARI : lib.SOURCES.find((x) => x.id === id);
  if (!s || !bytes) {
    bytes?.fill(0);
    fail('ファイルの形式が分かりませんでした。読み込み元を選んでください');
    return;
  }
  if (f.size > (s.own ? BACKUP_MAX : MAX_BYTES)) { bytes.fill(0); return fail('ファイルが大きすぎます'); }
  st.source = s;
  lastId = s.id;
  renderFile({ focus: false });
  acceptBytes(f.name, bytes);
}

/* ── 3. 確認 ── */

function countOf(items, skipped) {
  const n = { login: 0, note: 0, totp: 0, passkey: 0, skipped: Number(skipped) || 0 };
  for (const it of items) {
    if (it.type === 'note') n.note++;
    else n.login++;
    if (it.totp) n.totp++;
    n.passkey += Array.isArray(it.passkeys) ? it.passkeys.length : 0;
  }
  return n;
}

function defaultVault() {
  if (st.vault && S.vaults.some((v) => v.id === st.vault)) return st.vault;
  if (S.vault !== 'all' && S.vaults.some((v) => v.id === S.vault)) return S.vault;
  return S.vaults[0]?.id || 'personal';
}

function vaultPicker() {
  st.vault = defaultVault();
  const group = h('div', { class: 'vault-pick', role: 'radiogroup', 'aria-labelledby': 'impVaultK' });
  const sync = () => {
    const chips = [...group.children];
    chips.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.vault === st.vault)));
    setRoving(chips, Math.max(0, chips.findIndex((b) => b.dataset.vault === st.vault)));
    setCmd(reviewCmd());
  };
  for (const v of S.vaults) {
    group.append(h('button', {
      class: 'vault-chip', type: 'button', role: 'radio', dataset: { vault: v.id },
      onclick: () => { st.vault = v.id; sync(); },
    }, h('span', { class: 'swatch', vars: { '--sw': vaultColor(v.hue) } }), v.name));
  }
  arrowNav(group, '.vault-chip', { onMove: (b) => b.click() });
  sync();
  return group;
}

const vaultArg = (id) => quote(S.vaults.find((v) => v.id === id)?.name || id);
const reviewCmd = () => `akari import --from ${st.parsed.source} ${quote(st.parsed.fileName)} --vault ${vaultArg(st.vault)} --dry-run`;

function renderReview({ focus = true } = {}) {
  go('review');
  const p = st.parsed;
  const items = p.items;
  const n = countOf(items, p.skipped);
  const stat = (k, v, cls = '') => h('div', { class: `stat ${cls}${v ? '' : ' zero'}` },
    h('div', { class: 'stat-k' }, k), h('div', { class: 'stat-v' }, String(v)));
  const stats = h('div', { class: 'stats io-stats', role: 'group', 'aria-label': '読み込む内容', 'data-f': '' },
    stat('ログイン', n.login), stat('ノート', n.note), stat('認証コード', n.totp), stat('パスキー', n.passkey), stat('スキップ', n.skipped, 'skip'));

  const warnings = (Array.isArray(p.warnings) ? p.warnings : []).filter(Boolean).slice(0, 100);
  const warnBox = warnings.length
    ? h('ul', { class: 'io-warns', 'aria-label': '注意', tabindex: '0', 'data-f': '' }, warnings.map((w) => h('li', null, String(w))))
    : null;

  const titles = items.slice(0, 4).map((it) => h('span', { class: 'io-title', title: it.title || '' }, it.title || '（無題）'));
  const more = items.length - titles.length;
  const sample = h('div', { class: 'io-row', 'data-f': '' },
    h('span', { class: 'io-k' }, '例'),
    h('div', { class: 'io-sample' }, h('div', { class: 'io-titles' }, titles), more > 0 ? h('span', { class: 'io-more' }, `ほか ${more} 件`) : null));

  const err = h('div', { class: 'field-err', role: 'alert' });
  const goBtn = goButton(`${items.length} 件を取り込む`, { onclick: doImport });
  const cmd = cmdLine('');
  st.els = { err, go: goBtn, cmd };
  const picker = vaultPicker();
  mount(2, [
    cmd,
    h('div', { class: 'io-log', 'data-f': '' },
      logLine('ok', `${items.length} 件を解析`, `${p.fileName} · ${(p.ms / 1000).toFixed(2)}s`)),
    stats,
    warnBox,
    h('div', { class: 'io-row', 'data-f': '' }, h('span', { id: 'impVaultK', class: 'io-k' }, '保管庫'), picker),
    sample,
    foot(backBtn(), err, goBtn),
  ]);
  if (focus) goBtn.focus({ preventScroll: true });
}

async function doImport() {
  if (st.busy || !st.parsed?.items) return;
  const my = run;
  const token = liveToken();
  const { els } = st;
  const items = st.parsed.items;
  const vault = st.vault;
  const name = st.parsed.fileName;
  const source = st.parsed.source;
  st.busy = true;
  els.err.textContent = '';
  setBusy(els.go, true);
  try {
    const res = await call(MSG.VAULT_IMPORT_ITEMS, { items, vault });
    if (!live(token)) return;
    if (st.parsed && my === run) st.parsed.items = null;
    emit('reload');
    const r = {
      added: Number(res?.added) || 0, duplicates: Number(res?.duplicates) || 0,
      invalid: Number(res?.invalid) || 0, passkeys: Number(res?.passkeys) || 0,
    };
    if (my !== run) { // the page was left meanwhile: report in a toast
      toast(`${r.added} 件を追加しました`, `重複 ${r.duplicates} · 無効 ${r.invalid} · ${name} は削除してください`);
      return;
    }
    renderDone({ ...r, vault, name, source });
  } catch (e) {
    if (!live(token) || my !== run) return;
    st.busy = false;
    setBusy(els.go, false);
    els.err.textContent = '取り込めませんでした（' + errText(e) + '）';
  }
}

/* ── 4. 完了 ── */

export const resultText = (r) => `${r.added} 件を追加 · 重複 ${r.duplicates} · 無効 ${r.invalid}` + (r.passkeys ? ` · パスキー ${r.passkeys}` : '');

function renderDone(r) {
  go('done');
  st.parsed = null;
  wipeFile();
  const vaultName = S.vaults.find((v) => v.id === r.vault)?.name || r.vault || '';
  const close = goButton('閉じる', { onclick: () => hooks.close() });
  const again = h('button', { class: 'btn-line', type: 'button', onclick: () => renderSource() }, '続けて読み込む');
  let body;
  if (r.backup) {
    body = [
      cmdLine(`akari import --backup ${quote(r.name)}`),
      h('div', { class: 'io-log', 'data-f': '' }, logLine('ok', `${r.count} 件を読み込みました`, r.name)),
      h('p', { class: 'io-note', 'data-f': '' }, 'バックアップのアイテムを、いまの保管庫に追加しました。バックアップのファイルは暗号化されたままです。'),
    ];
  } else {
    body = [
      cmdLine(`akari import --from ${r.source} ${quote(r.name)} --vault ${vaultArg(r.vault)}`),
      h('div', { class: 'io-log io-result', role: 'status', 'data-f': '' }, logLine('ok', resultText(r), `保管庫: ${vaultName}`)),
      h('div', { class: 'io-alert', role: 'note', 'data-f': '' },
        h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'),
        h('div', null,
          h('div', { class: 'io-alert-title' }, '書き出したファイル「', h('b', null, r.name), '」は削除してください。'),
          h('div', null, 'パスワードが暗号化されずに残っています。ごみ箱に入れた場合は、ごみ箱も空にしてください。'))),
    ];
  }
  st.els = {};
  mount(steps().length - 1, [...body, foot(again, h('span', { class: 'grow' }), close)]);
  close.focus({ preventScroll: true });
}

/* ── init ── */

export function initImport({ close }) {
  hooks = { close };
  const sheet = $('setSheet');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const accepting = () => isImportPage() && !!lib && !st.busy && (st.step === 'source' || st.step === 'file');
  // a file dropped anywhere else must not navigate the popup away
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!accepting() || !sheet.contains(e.target)) e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
  sheet.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !accepting()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    sheet.classList.add('dragging');
  });
  sheet.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !sheet.contains(e.relatedTarget)) sheet.classList.remove('dragging');
  });
  sheet.addEventListener('drop', (e) => {
    sheet.classList.remove('dragging');
    if (!hasFiles(e) || !accepting()) return;
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (st.step === 'source') dropOnSource(f);
    else takeFile(f);
  });
}
