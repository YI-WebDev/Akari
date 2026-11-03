// エクスポート page of the settings sheet (PLAN.md §7.4): 形式 → (マスターパスワード,
// 任意で PGP のパスフレーズ) → ダウンロード.
// The Akari backup stays encrypted (vault/export). Plain formats come back from the service
// worker only after it re-checks the master password (vault/exportPlain); with PGP the text is
// encrypted here before it is saved. Text and passwords are dropped as soon as the download starts.

import { MSG, ERR } from '../../shared/messages.js';
import { call, errText, liveToken, live } from '../state.js';
import { h, clear } from './dom.js';
import { yyyymmdd } from './format.js';
import { shake, rise } from './fx.js';
import { cmdLine, logLine, setTrail, arrowNav, setRoving, setBusy, goButton, downloadFile, safeFileName } from './io.js';

const $ = (id) => document.getElementById(id);
const PGP_MIN = 8;

export const FORMATS = Object.freeze([
  { id: 'akari', name: 'Akari バックアップ', desc: '暗号化・Akari で読み込める', ext: 'json', plain: false },
  { id: 'csv', name: 'CSV', desc: 'Chrome などで読み込める・平文', ext: 'csv', plain: true },
  { id: 'bitwarden', name: 'Bitwarden JSON', desc: '多くのアプリで読み込める・平文・パスキーも含む', ext: 'json', plain: true },
]);

let fmt = 'akari';
let pgp = false;
let busy = false;
let els = {};
let run = 0;

const current = () => FORMATS.find((f) => f.id === fmt);

/** Forget everything typed on the page. */
export function resetExport() {
  run++;
  busy = false;
  fmt = 'akari';
  pgp = false;
  for (const k of ['master', 'pass', 'pass2']) if (els[k]) els[k].value = '';
  els = {};
  clear($('exportPage'));
}

/** The sheet head's back button: the export page has a single step. */
export const exportBack = () => false;

function field(id, placeholder, label, autocomplete) {
  const input = h('input', { id, type: 'password', placeholder, 'aria-label': label, autocomplete, spellcheck: 'false' });
  const wrap = h('div', { class: 'field io-field' }, input);
  input.addEventListener('input', () => wrap.classList.remove('err'));
  return [input, wrap];
}

export function openExport({ focus = true } = {}) {
  resetExport();
  setTrail(null);
  const page = $('exportPage');

  const list = h('div', { class: 'fmt-list', role: 'radiogroup', 'aria-label': '形式', 'data-f': '' });
  for (const f of FORMATS) {
    list.append(h('button', {
      class: 'fmt', type: 'button', role: 'radio', dataset: { fmt: f.id }, 'aria-describedby': `fmtDesc-${f.id}`,
      onclick: () => select(f.id),
    },
    h('span', { class: 'fmt-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'fmt-name' }, f.name),
    h('span', { id: `fmtDesc-${f.id}`, class: 'fmt-desc' + (f.plain ? ' plain' : '') }, f.desc),
    h('span', { class: 'fmt-ext', 'aria-hidden': 'true' }, '.' + f.ext)));
  }
  arrowNav(list, '.fmt', { onMove: (b) => select(b.dataset.fmt) });

  const [master, masterField] = field('expMaster', 'マスターパスワード（確認のため）', 'マスターパスワード', 'current-password');
  const [pass, passField] = field('expPass', `PGP のパスフレーズ（${PGP_MIN} 文字以上）`, 'PGP のパスフレーズ', 'new-password');
  const [pass2, pass2Field] = field('expPass2', 'もう一度', 'PGP のパスフレーズ（確認）', 'new-password');
  const pgpBtn = h('button', {
    id: 'expPgp', class: 'tgl', type: 'button', role: 'switch', 'aria-checked': 'false',
    onclick: () => setPgp(!pgp),
  }, h('span', { class: 'tgl-mark', 'aria-hidden': 'true' }), 'PGP で暗号化');
  const warn = h('div', { class: 'io-alert', role: 'note' },
    h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'), h('div', { class: 'io-alert-text' }));
  const note = h('p', { class: 'io-note' });
  const err = h('div', { class: 'field-err', role: 'alert' });
  const goBtn = goButton('書き出す', { type: 'submit' });
  const log = h('div', { class: 'io-log', 'aria-live': 'polite' });
  const plainRow = h('div', { class: 'io-pair' }, masterField, pgpBtn);
  const pgpRow = h('div', { class: 'io-pair', hidden: true }, passField, pass2Field);
  const form = h('form', { class: 'io-form', novalidate: true, 'aria-label': 'エクスポート', 'data-f': '' },
    plainRow, pgpRow, h('div', { class: 'io-foot' }, err, goBtn));
  form.addEventListener('submit', doExport);
  form.addEventListener('input', () => { if (!busy) els.err.textContent = ''; });
  const cmd = cmdLine('');

  els = { list, master, masterField, pass, passField, pass2, pass2Field, pgpBtn, warn, note, err, go: goBtn, log, plainRow, pgpRow, cmd };
  clear(page);
  page.append(cmd, list, h('div', { 'data-f': '' }, warn, note), form, log);
  page.scrollTop = 0;
  sync();
  rise(page, '[data-f]');
  if (focus) list.querySelector('[aria-checked="true"]').focus({ preventScroll: true });
}

function select(id) {
  if (busy || id === fmt) return;
  fmt = id;
  els.err.textContent = '';
  els.log.replaceChildren();
  sync();
}

function setPgp(on) {
  if (busy) return;
  pgp = on;
  if (!on) { els.pass.value = ''; els.pass2.value = ''; }
  sync();
  if (on) els.pass.focus();
}

/** Reflect format + PGP in the radios, the command line, the warning and the fields. */
function sync() {
  const f = current();
  const radios = [...els.list.children];
  radios.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fmt === fmt)));
  setRoving(radios, radios.findIndex((b) => b.dataset.fmt === fmt));
  els.pgpBtn.setAttribute('aria-checked', String(pgp));
  els.cmd.querySelector('.io-cmd-text').textContent = `akari export --format ${f.id}${f.plain && pgp ? ' --pgp' : ''}`;
  els.plainRow.hidden = !f.plain;
  els.pgpRow.hidden = !(f.plain && pgp);
  els.warn.hidden = !f.plain;
  els.note.hidden = f.plain;
  els.warn.classList.toggle('safe', pgp);
  els.warn.querySelector('.bang').textContent = pgp ? '✓' : '!';
  els.warn.querySelector('.io-alert-text').textContent = pgp
    ? `PGP のパスフレーズで暗号化して保存します（.${f.ext}.pgp）。パスフレーズを忘れると開けません。`
    : 'このファイルは暗号化されません。開けばだれでもパスワードを読めます。使い終わったら削除してください。';
  els.note.textContent = 'Akari のマスターパスワードで暗号化されたまま書き出します。読み込むときも、書き出したときのマスターパスワードを使います。';
  els.go.querySelector('.go-label').textContent = !f.plain ? '書き出す' : pgp ? '暗号化して書き出す' : '平文で書き出す';
}

function fail(msg, wrap, input) {
  els.err.textContent = msg;
  if (wrap) { wrap.classList.add('err'); shake(wrap); }
  input?.focus();
}

function wipeInputs() {
  for (const k of ['master', 'pass', 'pass2']) if (els[k]) els[k].value = '';
}

function done(name, count, { plain }) {
  const v = count != null ? `${name} · ${count} 件` : name;
  els.log.replaceChildren(logLine('ok', plain ? '平文で書き出しました' : '書き出しました', v));
}

async function doExport(e) {
  e.preventDefault();
  if (busy) return;
  const f = current();
  els.err.textContent = '';
  els.log.replaceChildren();
  if (!f.plain) return exportBackup();

  const masterPassword = els.master.value;
  if (!masterPassword) return fail('マスターパスワードを入力してください', els.masterField, els.master);
  const withPgp = pgp;
  let passphrase = '';
  if (withPgp) {
    passphrase = els.pass.value;
    if (passphrase.length < PGP_MIN) return fail(`パスフレーズは ${PGP_MIN} 文字以上にしてください`, els.passField, els.pass);
    if (passphrase !== els.pass2.value) return fail('確認用のパスフレーズが一致しません', els.pass2Field, els.pass2);
  }
  const my = run;
  const token = liveToken();
  busy = true;
  setBusy(els.go, true);
  els.log.replaceChildren(logLine('run', withPgp ? '書き出して暗号化中' : '書き出し中', f.name));
  let text = null;
  try {
    let res;
    try {
      res = await call(MSG.VAULT_EXPORT_PLAIN, { format: f.id, masterPassword });
    } catch (e2) {
      if (my !== run || !live(token)) return;
      els.log.replaceChildren();
      if (e2?.code === ERR.BAD_PASSWORD) { fail('マスターパスワードが違います', els.masterField, els.master); els.master.select(); }
      else fail('書き出せませんでした（' + errText(e2) + '）');
      return;
    }
    if (my !== run || !live(token)) return;
    text = typeof res?.text === 'string' ? res.text : '';
    let name = safeFileName(res?.filename, `akari-export-${yyyymmdd()}.${f.ext}`);
    let data = text;
    let type = f.id === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    if (withPgp) {
      try {
        const { encryptPgp } = await import('../../lib/pgp.js');
        data = await encryptPgp(text, passphrase, { filename: name });
      } catch {
        if (my !== run || !live(token)) return;
        els.log.replaceChildren();
        fail('PGP で暗号化できませんでした。ファイルは保存していません');
        return;
      }
      if (my !== run || !live(token)) return;
      name += '.pgp';
      type = 'application/pgp-encrypted';
    }
    downloadFile(data, name, type);
    data = null;
    wipeInputs();
    done(name, res?.count, { plain: !withPgp });
  } finally {
    text = null;
    passphrase = '';
    if (my === run) {
      busy = false;
      setBusy(els.go, false);
    }
  }
}

async function exportBackup() {
  const my = run;
  const token = liveToken();
  busy = true;
  setBusy(els.go, true);
  els.log.replaceChildren(logLine('run', '書き出し中', 'Akari バックアップ'));
  try {
    const res = await call(MSG.VAULT_EXPORT);
    if (my !== run || !live(token)) return;
    const json = typeof res?.json === 'string' ? res.json : JSON.stringify(res?.json ?? res);
    const name = `akari-backup-${yyyymmdd()}.json`;
    downloadFile(json, name, 'application/json');
    done(name, null, { plain: false });
  } catch (e) {
    if (my !== run || !live(token)) return;
    els.log.replaceChildren();
    fail('書き出せませんでした（' + errText(e) + '）');
  } finally {
    if (my === run) {
      busy = false;
      setBusy(els.go, false);
    }
  }
}
