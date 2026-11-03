// Dashlane exports:
//  - ZIP of CSVs: credentials.csv (username,username2,username3,title,password,note,url,
//    category,otpSecret|otpUrl), securenotes.csv (title,note,…), payments.csv, ids.csv,
//    personalInfo.csv, … — every non-credential row becomes a secure note.
//  - a single credentials.csv (or any of the CSVs above on its own).
//  - the legacy JSON layout ({ AUTHENTIFIANT: [...], SECURENOTE: [...], … }), bare or zipped.

import { ImportError, fieldsToNote, parseOtp, bytesToText, parseJson, isZip } from '../model.js';
import { readZip } from '../zip.js';
import { csvToObjects, pick } from '../csv.js';

const LABELS = {
  account_name: '名称', account_holder: '名義', cc_number: 'カード番号', code: 'セキュリティコード',
  expiration_month: '有効期限（月）', expiration_year: '有効期限（年）', routing_number: 'ルーティング番号',
  account_number: '口座番号', bank_name: '銀行名', iban: 'IBAN', bic: 'BIC', country: '国', state: '州・地域',
  name: '氏名', number: '番号', issue_date: '発行日', expiration_date: '有効期限', place_of_issue: '発行地',
  first_name: '名', middle_name: 'ミドルネーム', last_name: '姓', login: 'ユーザー名', date_of_birth: '生年月日',
  place_of_birth: '出生地', email: 'メール', phone_number: '電話', address: '住所', city: '市区町村', zip: '郵便番号',
  job_title: '役職', url: 'URL', category: 'カテゴリ', type: '種類', title: 'タイトル', item_name: '名称',
};
/** CSV file (base name) → Japanese name of the converted kind. */
const FILE_KINDS = { payments: '支払い情報', ids: '身分証明書', personalinfo: '個人情報' };
/** Legacy JSON section → Japanese name of the converted kind. */
const JSON_KINDS = {
  PAYMENTMEANS_CREDITCARD: 'クレジットカード', PAYMENTMEAN_PAYPAL: 'PayPal', BANKSTATEMENT: '銀行口座',
  IDCARD: '身分証明書', PASSPORT: 'パスポート', DRIVERLICENCE: '運転免許証', SOCIALSECURITYSTATEMENT: '社会保障番号',
  FISCALSTATEMENT: '税務情報', IDENTITY: '個人情報', EMAIL: 'メールアドレス', PHONE: '電話番号', ADDRESS: '住所',
  COMPANY: '会社', PERSONALWEBSITE: 'ウェブサイト',
};

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');

function makeRun() {
  return { items: [], skipped: 0, converted: {}, badTotp: 0 };
}

function convert(run, kind, title, pairs, note) {
  run.converted[kind] = (run.converted[kind] || 0) + 1;
  run.items.push({ type: 'note', title, note: fieldsToNote(pairs, note) });
}

function login(run, { title, url, usernames, password, note, otp, extras }) {
  const [username = '', ...more] = usernames.map(str).filter(Boolean);
  const pairs = more.map((u, i) => [`ユーザー名 ${i + 2}`, u]);
  let totp = null;
  if (str(otp)) {
    totp = parseOtp(otp, username || title);
    if (!totp) { run.badTotp++; pairs.push(['TOTP', otp]); }
  }
  run.items.push({
    type: 'login', title, url, username, password, totp,
    note: joinNote(note, fieldsToNote([...pairs, ...extras])),
  });
}

function fromCsv(run, text, fileName) {
  const { headers, records } = csvToObjects(text);
  const base = fileName.toLowerCase().split('/').pop().replace(/\.csv$/, '');
  const isCredentials = base === 'credentials' || (headers.includes('password') && headers.includes('username'));
  const isNotes = base === 'securenotes' || (!isCredentials && headers.includes('note') && headers.every((h) => ['title', 'note', 'category'].includes(h)));

  for (const rec of records) {
    if (isCredentials) {
      login(run, {
        title: rec.title,
        url: rec.url,
        usernames: [rec.username, rec.username2, rec.username3],
        password: rec.password,
        note: rec.note,
        otp: pick(rec, 'otpurl', 'otpsecret', 'otp'),
        extras: [['カテゴリ', rec.category]],
      });
    } else if (isNotes) {
      run.items.push({ type: 'note', title: rec.title, note: joinNote(rec.note, fieldsToNote([['カテゴリ', rec.category]])) });
    } else {
      const kind = base === 'payments' && /card/i.test(rec.type) ? 'クレジットカード'
        : base === 'payments' && /bank/i.test(rec.type) ? '銀行口座'
          : FILE_KINDS[base] || 'その他';
      const title = pick(rec, 'title', 'item_name', 'account_name', 'name') || kind;
      const pairs = headers.filter((h) => h && h !== 'note').map((h) => [LABELS[h] || h, rec[h]]);
      convert(run, kind, title, pairs, rec.note);
    }
  }
}

function fromLegacyJson(run, json) {
  for (const [section, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e !== 'object') { run.skipped++; continue; }
      if (section === 'AUTHENTIFIANT') {
        login(run, {
          title: e.title,
          url: e.domain,
          usernames: [e.login, e.secondaryLogin, e.email],
          password: e.password,
          note: e.note,
          otp: e.otpSecret || e.otpUrl,
          extras: [],
        });
      } else if (section === 'SECURENOTE') {
        run.items.push({ type: 'note', title: e.title, note: e.content ?? e.note });
      } else {
        const kind = JSON_KINDS[section] || 'その他';
        const pairs = Object.entries(e).filter(([k, v]) => k !== 'note' && v != null && typeof v !== 'object').map(([k, v]) => [k, v]);
        convert(run, kind, str(e.title || e.name || e.bank || e.fullname) || kind, pairs, e.note);
      }
    }
  }
}

const isLegacyJson = (j) => j && typeof j === 'object' && !Array.isArray(j)
  && Object.keys(j).some((k) => k === 'AUTHENTIFIANT' || k === 'SECURENOTE' || k in JSON_KINDS);

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const run = makeRun();
  if (isZip(file.bytes)) {
    const entries = readZip(file.bytes);
    const csvs = entries.filter((e) => /\.csv$/i.test(e.name));
    const jsons = entries.filter((e) => /\.json$/i.test(e.name));
    if (csvs.length) {
      for (const e of csvs) fromCsv(run, bytesToText(await e.bytes()), e.name);
    } else {
      let found = false;
      for (const e of jsons) {
        const j = parseJson(bytesToText(await e.bytes()), 'Dashlane');
        if (isLegacyJson(j)) { fromLegacyJson(run, j); found = true; }
      }
      if (!found) throw new ImportError('INVALID_FORMAT', 'Dashlane の書き出しファイルではありません（ZIP に CSV が見つかりませんでした）');
    }
  } else {
    const text = bytesToText(file.bytes);
    if (/^\s*\{/.test(text)) {
      const j = parseJson(text, 'Dashlane');
      if (!isLegacyJson(j)) throw new ImportError('INVALID_FORMAT', 'Dashlane の書き出しファイルではありません');
      fromLegacyJson(run, j);
    } else {
      fromCsv(run, text, file.name || '');
    }
  }
  const warnings = Object.entries(run.converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (run.badTotp) warnings.push(`読み取れない TOTP 設定 ${run.badTotp} 件はメモに残しました`);
  return { items: run.items, skipped: run.skipped, warnings };
}
