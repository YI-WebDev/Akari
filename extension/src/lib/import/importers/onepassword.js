// 1Password exports:
//  - .1pux: ZIP with export.data (JSON accounts[].vaults[].items[]) and files/ (attachments).
//  - .1pif: JSON records separated by "***5642bee8-a5ff-11dc-8314-0800200c9a66***" lines.
//  - .zip: treated as 1pux when it holds export.data (or as 1pif when it holds a .1pif file).

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { readZip, findEntry } from '../zip.js';

const LOGIN = 'login', PASSWORD = 'password', NOTE = 'note';

/** 1pux categoryUuid → login / password / note, or the Japanese name of a converted kind. */
const CATEGORIES = {
  '001': LOGIN, '002': 'クレジットカード', '003': NOTE, '004': '個人情報', '005': PASSWORD,
  '006': 'ドキュメント', '100': 'ソフトウェアライセンス', '101': '銀行口座', '102': 'データベース',
  '103': '運転免許証', '104': '狩猟・釣りのライセンス', '105': '会員証', '106': 'パスポート',
  '107': 'ポイントプログラム', '108': '社会保障番号', '109': 'Wi-Fi', '110': 'サーバー',
  '111': 'メールアカウント', '112': 'API 認証情報', '113': '医療記録', '114': 'SSH キー', '115': '暗号資産ウォレット',
};

/** 1pif typeName → same as above. system.* records (folders, tombstones) are not items. */
const TYPE_NAMES = {
  'webforms.WebForm': LOGIN, 'passwords.Password': PASSWORD, 'securenotes.SecureNote': NOTE,
  'wallet.financial.CreditCard': 'クレジットカード', 'wallet.financial.BankAccountUS': '銀行口座',
  'wallet.computer.License': 'ソフトウェアライセンス', 'wallet.computer.Router': 'Wi-Fi',
  'wallet.computer.Database': 'データベース', 'wallet.computer.UnixServer': 'サーバー',
  'wallet.government.Passport': 'パスポート', 'wallet.government.DriversLicense': '運転免許証',
  'wallet.government.HuntingLicense': '狩猟・釣りのライセンス', 'wallet.government.SsnUS': '社会保障番号',
  'wallet.membership.Membership': '会員証', 'wallet.membership.RewardProgram': 'ポイントプログラム',
  'wallet.onlineservices.Email.v2': 'メールアカウント', 'identities.Identity': '個人情報',
};

// Login form fields that carry no data worth keeping (buttons, checkboxes, radios, selects…).
const FORM_NOISE = new Set(['B', 'C', 'I', 'R', 'S']);
const PIF_SEPARATOR = /^\*{3}[0-9a-f-]+\*{3}[ \t]*$/im;

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');
const isoDate = (secs) => {
  const d = new Date(toMs(secs) ?? NaN);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : str(secs);
};
const monthYear = (v) => {
  const s = str(v);
  return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}/${s.slice(4)}` : s;
};
const address = (a) => (a && typeof a === 'object'
  ? [a.street, a.city, a.state, a.zip, a.country].map(str).filter(Boolean).join(', ')
  : str(a));

/** Shared state for one parse run. */
function makeRun() {
  return { items: [], skipped: 0, converted: {}, attachments: 0, badTotp: 0 };
}

/**
 * Build the ImportedItem for any 1Password item once its parts are normalised.
 * `extras` are [label, value] pairs that are not username/password/url/totp.
 */
function emit(run, kind, p) {
  const { title, username, password, urls, totps, extras, notes, tags, fav, createdAt, updatedAt } = p;
  const urlList = [...new Set(urls.map(str).filter(Boolean))];
  const tagLine = tags.length ? [['タグ', tags.join(', ')]] : [];
  if (kind === LOGIN || kind === PASSWORD) {
    let totp = null;
    const extraOtp = [];
    for (const raw of totps) {
      const cfg = !totp && parseOtp(raw, username || title);
      if (cfg) totp = cfg;
      else {
        if (!parseOtp(raw)) run.badTotp++;
        extraOtp.push(['TOTP', raw]);
      }
    }
    run.items.push({
      type: 'login', title, url: urlList[0] || '', username, password, totp, fav, createdAt, updatedAt,
      note: joinNote(notes, fieldsToNote([...urlList.slice(1).map((u) => ['URL', u]), ...extraOtp, ...extras, ...tagLine])),
    });
    return;
  }
  const otpLines = totps.map((t) => ['TOTP', t]);
  if (kind === NOTE) {
    run.items.push({
      type: 'note', title, fav, createdAt, updatedAt,
      note: joinNote(notes, fieldsToNote([['ユーザー名', username], ['パスワード', password], ...urlList.map((u) => ['URL', u]), ...otpLines, ...extras, ...tagLine])),
    });
    return;
  }
  run.converted[kind] = (run.converted[kind] || 0) + 1;
  run.items.push({
    type: 'note', title, fav, createdAt, updatedAt,
    note: fieldsToNote([['ユーザー名', username], ['パスワード', password], ...urlList.map((u) => ['URL', u]), ...otpLines, ...extras, ...tagLine], notes),
  });
}

function finish(run) {
  const warnings = Object.entries(run.converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (run.attachments) warnings.push(`添付ファイル・ドキュメントの中身 ${run.attachments} 件は読み込まれません`);
  if (run.badTotp) warnings.push(`読み取れない TOTP 設定 ${run.badTotp} 件はメモに残しました`);
  return { items: run.items, skipped: run.skipped, warnings };
}

// --- 1pux ----------------------------------------------------------------------------------

/** One 1pux section field → [label, value] pairs (value kinds: string, concealed, email, date…). */
function puxFieldPairs(f, run) {
  const label = str(f.title) || str(f.id) || 'フィールド';
  const value = f.value && typeof f.value === 'object' ? f.value : {};
  const [kind, x] = Object.entries(value)[0] || [];
  if (x == null || x === '') return [];
  switch (kind) {
    case 'date': return [[label, isoDate(x)]];
    case 'monthYear': return [[label, monthYear(x)]];
    case 'email': return [[label, typeof x === 'object' ? x.email_address : x]];
    case 'address': return [[label, address(x)]];
    case 'reference': return [];
    case 'file':
      run.attachments++;
      return [[label, `（添付ファイル: ${str(x.fileName) || '名前なし'}）`]];
    case 'sshKey': {
      if (typeof x !== 'object') return [[label, x]];
      const m = x.metadata || {};
      return [[label, x.privateKey || m.privateKey], ['公開鍵', m.publicKey], ['フィンガープリント', m.fingerprint]];
    }
    default:
      return [[label, typeof x === 'object' ? Object.values(x).filter((v) => v != null && typeof v !== 'object').join(' ') : x]];
  }
}

function from1puxItem(run, item) {
  if (!item || typeof item !== 'object') { run.skipped++; return; }
  if (item.trashed === true || item.state === 'trashed' || item.state === 'deleted') { run.skipped++; return; }
  const kind = CATEGORIES[item.categoryUuid] || 'その他のアイテム';
  const ov = item.overview || {};
  const d = item.details || {};
  let username = '', password = '';
  const totps = [], extras = [];

  for (const f of Array.isArray(d.loginFields) ? d.loginFields : []) {
    if (!f || f.value == null || f.value === '') continue;
    if (f.designation === 'username' && !username) username = f.value;
    else if (f.designation === 'password' && !password) password = f.value;
    else if (!FORM_NOISE.has(f.fieldType)) extras.push([str(f.name) || str(f.id) || 'フィールド', f.value]);
  }
  if (!password && typeof d.password === 'string') password = d.password;

  for (const s of Array.isArray(d.sections) ? d.sections : []) {
    for (const f of Array.isArray(s?.fields) ? s.fields : []) {
      if (!f) continue;
      if (f.value && typeof f.value === 'object' && 'totp' in f.value) {
        if (str(f.value.totp)) totps.push(str(f.value.totp));
        continue;
      }
      extras.push(...puxFieldPairs(f, run));
    }
  }
  if (d.documentAttributes) {
    run.attachments++;
    extras.push(['ファイル名', d.documentAttributes.fileName]);
  }

  emit(run, kind, {
    title: str(ov.title),
    username,
    password,
    urls: [ov.url, ...(Array.isArray(ov.urls) ? ov.urls.map((u) => u?.url) : [])],
    totps,
    extras,
    notes: d.notesPlain,
    tags: (Array.isArray(ov.tags) ? ov.tags : []).map(str).filter(Boolean),
    fav: Number(item.favIndex) > 0,
    createdAt: toMs(item.createdAt),
    updatedAt: toMs(item.updatedAt),
  });
}

function parse1puxData(run, data) {
  if (!data || !Array.isArray(data.accounts)) {
    throw new ImportError('INVALID_FORMAT', '1Password の export.data の形式が正しくありません');
  }
  for (const account of data.accounts) {
    for (const vault of Array.isArray(account?.vaults) ? account.vaults : []) {
      for (const item of Array.isArray(vault?.items) ? vault.items : []) from1puxItem(run, item);
    }
  }
}

// --- 1pif ----------------------------------------------------------------------------------

const PIF_KNOWN = new Set(['fields', 'sections', 'URLs', 'URL', 'notesPlain', 'htmlForm', 'passwordHistory', 'password']);

function pifFieldValue(f) {
  switch (f.k) {
    case 'date': return isoDate(f.v);
    case 'monthYear': return monthYear(f.v);
    case 'address': return address(f.v);
    default: return typeof f.v === 'object' && f.v ? Object.values(f.v).filter((v) => v != null && typeof v !== 'object').join(' ') : f.v;
  }
}

function from1pifRecord(run, rec) {
  const typeName = str(rec.typeName);
  if (rec.trashed === true || typeName === 'system.Tombstone') { run.skipped++; return; }
  if (typeName.startsWith('system.')) return; // folders, saved searches
  const kind = TYPE_NAMES[typeName] || 'その他のアイテム';
  const sc = rec.secureContents || {};
  let username = '', password = '';
  const totps = [], extras = [];

  for (const f of Array.isArray(sc.fields) ? sc.fields : []) {
    if (!f || f.value == null || f.value === '') continue;
    if (f.designation === 'username' && !username) username = f.value;
    else if (f.designation === 'password' && !password) password = f.value;
    else if (!FORM_NOISE.has(f.type)) extras.push([str(f.name) || str(f.id) || 'フィールド', f.value]);
  }
  if (!password && typeof sc.password === 'string') password = sc.password;

  const sectionNames = new Set();
  for (const s of Array.isArray(sc.sections) ? sc.sections : []) {
    for (const f of Array.isArray(s?.fields) ? s.fields : []) {
      if (!f) continue;
      sectionNames.add(f.n);
      if (f.v == null || f.v === '') continue;
      if (/^TOTP_/i.test(str(f.n)) || f.k === 'totp') { totps.push(str(f.v)); continue; }
      if (f.k === 'reference') continue;
      extras.push([str(f.t) || str(f.n) || 'フィールド', pifFieldValue(f)]);
    }
  }
  // Older records keep wallet data as flat secureContents keys (often duplicated in sections).
  if (kind !== LOGIN && kind !== PASSWORD) {
    for (const [k, v] of Object.entries(sc)) {
      if (PIF_KNOWN.has(k) || sectionNames.has(k) || v == null || typeof v === 'object') continue;
      extras.push([k, v]);
    }
  }

  const fave = rec.faveIndex ?? rec.openContents?.faveIndex;
  emit(run, kind, {
    title: str(rec.title),
    username,
    password,
    urls: [rec.location, sc.URL, ...(Array.isArray(sc.URLs) ? sc.URLs.map((u) => u?.url) : [])],
    totps,
    extras,
    notes: sc.notesPlain,
    tags: (Array.isArray(rec.openContents?.tags) ? rec.openContents.tags : []).map(str).filter(Boolean),
    fav: Number.isFinite(Number(fave)) && Number(fave) !== 0,
    createdAt: toMs(rec.createdAt),
    updatedAt: toMs(rec.updatedAt),
  });
}

function parse1pifText(run, text) {
  const chunks = text.split(PIF_SEPARATOR).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    let rec;
    try {
      rec = JSON.parse(chunk);
    } catch {
      run.skipped++;
      continue;
    }
    if (rec && typeof rec === 'object') from1pifRecord(run, rec);
    else run.skipped++;
  }
}

// --- entry point ---------------------------------------------------------------------------

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const run = makeRun();
  if (isZip(file.bytes)) {
    const entries = readZip(file.bytes);
    const data = findEntry(entries, 'export.data');
    if (data) {
      parse1puxData(run, parseJson(bytesToText(await data.bytes()), '1Password（export.data）'));
      // Attachment bodies live under files/; documents and file fields were also counted per item.
      run.attachments = Math.max(run.attachments, entries.filter((e) => /^files\//i.test(e.name)).length);
      return finish(run);
    }
    const pif = entries.find((e) => /\.1pif$/i.test(e.name));
    if (pif) {
      parse1pifText(run, bytesToText(await pif.bytes()));
      return finish(run);
    }
    throw new ImportError('INVALID_FORMAT', '1Password の書き出しファイル（1PUX）ではありません。ZIP に export.data が見つかりませんでした');
  }
  const text = bytesToText(file.bytes);
  if (PIF_SEPARATOR.test(text)) {
    parse1pifText(run, text);
  } else if (/^\s*\{/.test(text)) {
    const json = parseJson(text, '1Password');
    if (Array.isArray(json?.accounts)) parse1puxData(run, json); // a bare export.data
    else if (json && typeof json === 'object' && 'typeName' in json) from1pifRecord(run, json); // single 1pif record
    else throw new ImportError('INVALID_FORMAT', '1Password の書き出しファイルではありません');
  } else {
    throw new ImportError('INVALID_FORMAT', '1Password の書き出しファイル（1PUX / 1PIF）ではありません');
  }
  return finish(run);
}
