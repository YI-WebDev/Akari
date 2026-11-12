import { MSG, ERR } from '../../shared/messages.js';
import { S, call, errText, liveToken, live, emit } from '../state.js';
import { h, clear } from './dom.js';
import { yyyymmdd } from './format.js';
import { shake, rise } from './fx.js';
import { cmdLine, logLine, setTrail, arrowNav, setRoving, setBusy, goButton, downloadFile, safeFileName, sentenceWith } from './io.js';
import { t } from '../../shared/i18n.js';

const $ = (id) => document.getElementById(id);
const PGP_MIN = 8;

export const FORMATS = Object.freeze([
  { id: 'akari', arg: 'akari', name: 'Akari バックアップ', desc: '暗号化・Akari で読み込める', ext: 'json', plain: false },
  { id: 'csv', arg: 'csv', name: 'CSV', desc: 'Chrome などで読み込める・平文', ext: 'csv', plain: true },
  { id: 'bitwarden', arg: 'json', name: 'JSON', desc: '多くのアプリで読み込める・平文・パスキーも含む', ext: 'json', plain: true, title: 'Bitwarden と同じ形式の JSON' },
  { id: 'pgp', arg: 'pgp', name: 'PGP 暗号化', desc: 'CSV か JSON をパスフレーズで暗号化', ext: 'pgp', plain: false, pgp: true },
]);
const INNER = Object.freeze(['csv', 'bitwarden']);

let fmt = 'akari';
let inner = 'csv';
let busy = false;
let els = {};
let run = 0;

const formatOf = (id) => FORMATS.find((f) => f.id === id);
const current = () => formatOf(fmt);
const withPgp = () => fmt === 'pgp';
const payload = () => formatOf(withPgp() ? inner : fmt);

export function resetExport() {
  run++;
  busy = false;
  fmt = 'akari';
  inner = 'csv';
  for (const k of ['master', 'pass', 'pass2']) if (els[k]) els[k].value = '';
  els = {};
  clear($('exportPage'));
}

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

  const list = h('div', { class: 'fmt-list', role: 'radiogroup', 'aria-label': t('形式'), 'data-f': '' });
  for (const f of FORMATS) {
    list.append(h('button', {
      class: 'fmt', type: 'button', role: 'radio', dataset: { fmt: f.id }, 'aria-describedby': `fmtDesc-${f.id}`,
      title: f.title ? t(f.title) : null, onclick: () => select(f.id),
    },
    h('span', { class: 'fmt-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'fmt-name' }, t(f.name)),
    h('span', { id: `fmtDesc-${f.id}`, class: 'fmt-desc' + (f.plain ? ' plain' : '') }, t(f.desc)),
    h('span', { class: 'fmt-ext', 'aria-hidden': 'true' }, '.' + f.ext)));
  }
  arrowNav(list, '.fmt', { onMove: (b) => select(b.dataset.fmt) });

  const [master, masterField] = field('expMaster', t('確認のため'), t('マスターパスワード'), 'current-password');
  const [pass, passField] = field('expPass', t('{n} 文字以上', { n: PGP_MIN }), t('PGP のパスフレーズ'), 'new-password');
  const [pass2, pass2Field] = field('expPass2', t('もう一度'), t('PGP のパスフレーズ（確認）'), 'new-password');
  const innerPick = h('div', { id: 'expInner', class: 'chips', role: 'radiogroup', 'aria-labelledby': 'expInnerK' },
    ...INNER.map((id) => h('button', { type: 'button', role: 'radio', dataset: { inner: id }, onclick: () => setInner(id) }, formatOf(id).name)));
  arrowNav(innerPick, 'button', { onMove: (b) => b.click() });
  const warn = h('div', { class: 'io-alert', role: 'note' },
    h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'), h('div', { class: 'io-alert-text' }));
  const note = h('p', { class: 'io-note' });
  const attNote = h('p', { class: 'io-note io-att-note', hidden: true },
    t('添付ファイルは含まれません。添付ファイルごと残すには Akari バックアップを選びます。'));
  const err = h('div', { class: 'field-err', role: 'alert' });
  const goBtn = goButton(t('書き出す'), { type: 'submit' });
  const log = h('div', { class: 'io-log', 'aria-live': 'polite' });
  const masterRow = h('div', { class: 'io-row io-row-wide' },
    h('label', { class: 'io-k', for: 'expMaster' }, t('マスターパスワード')), masterField);
  const innerRow = h('div', { class: 'io-row io-row-wide', hidden: true },
    h('span', { id: 'expInnerK', class: 'io-k' }, t('中身')), innerPick);
  const pgpRow = h('div', { class: 'io-row io-row-wide', hidden: true },
    h('label', { class: 'io-k', for: 'expPass' }, t('PGP パスフレーズ')), h('div', { class: 'io-pair' }, passField, pass2Field));
  const form = h('form', { class: 'io-form', novalidate: true, 'aria-label': t('エクスポート'), 'data-f': '' },
    masterRow, innerRow, pgpRow, h('div', { class: 'io-foot' }, err, goBtn));
  form.addEventListener('submit', doExport);
  form.addEventListener('input', () => { if (!busy) els.err.textContent = ''; });
  const cmd = cmdLine('');

  els = { list, master, masterField, pass, passField, pass2, pass2Field, innerPick, warn, note, attNote, err, go: goBtn, log, masterRow, innerRow, pgpRow, cmd };
  clear(page);
  page.append(cmd, list, h('div', { 'data-f': '' }, warn, note, attNote), form, log);
  page.scrollTop = 0;
  sync();
  rise(page, '[data-f]');
  if (focus) list.querySelector('[aria-checked="true"]').focus({ preventScroll: true });
}

function select(id) {
  if (busy || id === fmt) return;
  const was = withPgp();
  fmt = id;
  if (was && !withPgp()) { els.pass.value = ''; els.pass2.value = ''; }
  els.err.textContent = '';
  els.log.replaceChildren();
  sync();
}

function setInner(id) {
  if (busy || id === inner) return;
  inner = id;
  sync();
}

function sync() {
  const f = current();
  const pgp = withPgp();
  const p = payload();
  const radios = [...els.list.children];
  radios.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fmt === fmt)));
  setRoving(radios, radios.findIndex((b) => b.dataset.fmt === fmt));
  const innerBtns = [...els.innerPick.children];
  innerBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.inner === inner)));
  setRoving(innerBtns, innerBtns.findIndex((b) => b.dataset.inner === inner));
  els.cmd.querySelector('.io-cmd-text').textContent = `akari export --format ${p.arg}${pgp ? ' --pgp' : ''}`;
  const needsMaster = f.plain || pgp;
  els.masterRow.hidden = !needsMaster;
  els.innerRow.hidden = !pgp;
  els.pgpRow.hidden = !pgp;
  els.warn.hidden = !needsMaster;
  els.note.hidden = needsMaster;
  els.attNote.hidden = fmt === 'akari' || !S.items.some((it) => it.attachments?.length);
  els.warn.classList.toggle('safe', pgp);
  els.warn.querySelector('.bang').textContent = pgp ? '✓' : '!';
  els.warn.querySelector('.io-alert-text').textContent = pgp
    ? t('PGP のパスフレーズで暗号化して保存します（.{ext}.pgp）。gpg など OpenPGP に対応したアプリで開けます。パスフレーズを忘れると開けません。', { ext: p.ext })
    : t('このファイルは暗号化されません。開けばだれでもパスワードを読めます。使い終わったら削除してください。');
  els.note.textContent = t('Akari のマスターパスワードで暗号化されたまま書き出します。読み込むときも、書き出したときのマスターパスワードを使います。');
  els.go.querySelector('.go-label').textContent = pgp ? t('暗号化して書き出す') : f.plain ? t('平文で書き出す') : t('書き出す');
  els.go.classList.toggle('danger', f.plain);
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
  const v = count != null ? t('{name} · {n} 件', { name, n: count }) : name;
  const lines = [logLine('ok', plain ? t('平文で書き出しました') : t('書き出しました'), v)];
  if (plain) {
    els.warn.hidden = true;
    lines.push(h('div', { class: 'io-alert', role: 'note' },
      h('span', { class: 'bang', 'aria-hidden': 'true' }, '!'),
      h('div', null,
        h('div', { class: 'io-alert-title' }, ...sentenceWith(t('書き出したファイル「{name}」は、使い終わったら削除してください。'), 'name', h('b', null, name))),
        h('div', null, t('暗号化されていないので、開けばだれでもパスワードを読めます。ごみ箱に入れた場合は、ごみ箱も空にしてください。')))));
  }
  els.log.replaceChildren(...lines);
}

async function doExport(e) {
  e.preventDefault();
  if (busy) return;
  const f = current();
  els.err.textContent = '';
  els.log.replaceChildren();
  if (f.id === 'akari') return exportBackup();

  const masterPassword = els.master.value;
  if (!masterPassword) return fail(t('マスターパスワードを入力してください'), els.masterField, els.master);
  const encrypt = withPgp();
  const out = payload();
  let passphrase = '';
  if (encrypt) {
    passphrase = els.pass.value;
    if (passphrase.length < PGP_MIN) return fail(t('パスフレーズは {n} 文字以上にしてください', { n: PGP_MIN }), els.passField, els.pass);
    if (passphrase !== els.pass2.value) return fail(t('確認用のパスフレーズが一致しません'), els.pass2Field, els.pass2);
  }
  const my = run;
  const token = liveToken();
  busy = true;
  setBusy(els.go, true);
  els.log.replaceChildren(logLine('run', encrypt ? t('書き出して暗号化中') : t('書き出し中'), encrypt ? `${out.name} → PGP` : out.name));
  let text = null;
  try {
    let res;
    try {
      res = await call(MSG.VAULT_EXPORT_PLAIN, { format: out.id, masterPassword });
    } catch (e2) {
      if (my !== run || !live(token)) return;
      els.log.replaceChildren();
      if (e2?.code === ERR.BAD_PASSWORD) { fail(t('マスターパスワードが違います'), els.masterField, els.master); els.master.select(); }
      else fail(t('書き出せませんでした（{why}）', { why: errText(e2) }));
      return;
    }
    if (my !== run || !live(token)) return;
    text = typeof res?.text === 'string' ? res.text : '';
    let name = safeFileName(res?.filename, `akari-export-${yyyymmdd()}.${out.ext}`);
    let data = text;
    let type = out.id === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    if (encrypt) {
      try {
        const { encryptPgp } = await import('../../lib/pgp.js');
        data = await encryptPgp(text, passphrase, { filename: name });
      } catch {
        if (my !== run || !live(token)) return;
        els.log.replaceChildren();
        fail(t('PGP で暗号化できませんでした。ファイルは保存していません'));
        return;
      }
      if (my !== run || !live(token)) return;
      name += '.pgp';
      type = 'application/pgp-encrypted';
    }
    downloadFile(data, name, type);
    data = null;
    wipeInputs();
    done(name, res?.count, { plain: !encrypt });
    if (encrypt) await noteBackup();
  } finally {
    text = null;
    passphrase = '';
    if (my === run) {
      busy = false;
      setBusy(els.go, false);
    }
  }
}

/** An encrypted file was handed to the browser to save: the backup reminder starts again. */
async function noteBackup() {
  try {
    await call(MSG.BACKUP_RECORD);
  } catch { }
  emit('backupDone');
}

async function exportBackup() {
  const my = run;
  const token = liveToken();
  busy = true;
  setBusy(els.go, true);
  els.log.replaceChildren(logLine('run', t('書き出し中'), t('Akari バックアップ')));
  try {
    const res = await call(MSG.VAULT_EXPORT);
    if (my !== run || !live(token)) return;
    const json = typeof res?.json === 'string' ? res.json : JSON.stringify(res?.json ?? res);
    const name = `akari-backup-${yyyymmdd()}.json`;
    downloadFile(json, name, 'application/json');
    done(name, null, { plain: false });
    await noteBackup();
  } catch (e) {
    if (my !== run || !live(token)) return;
    els.log.replaceChildren();
    fail(t('書き出せませんでした（{why}）', { why: errText(e) }));
  } finally {
    if (my === run) {
      busy = false;
      setBusy(els.go, false);
    }
  }
}
