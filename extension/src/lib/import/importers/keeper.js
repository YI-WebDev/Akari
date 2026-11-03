// Keeper JSON export: { shared_folders: [...], records: [{ title, $type, login, password,
// login_url, notes, custom_fields: { name | "$type:label:n": value }, folders }] }.
// TOTP lives in custom_fields "TFC:Keeper" (legacy) or "$oneTimeCode…" (v3 records).
// Folders and shared folders are ignored.

import { ImportError, fieldsToNote, parseOtp, bytesToText, parseJson } from '../model.js';

/** Keeper record $type → login / note, or the Japanese name of a converted kind. */
const TYPES = {
  login: 'login', general: 'login', encryptedNotes: 'note',
  bankCard: 'クレジットカード', bankAccount: '銀行口座', address: '住所', contact: '連絡先',
  databaseCredentials: 'データベース', serverCredentials: 'サーバー', wifiCredentials: 'Wi-Fi',
  sshKeys: 'SSH キー', softwareLicense: 'ソフトウェアライセンス', passport: 'パスポート',
  driverLicense: '運転免許証', membership: '会員証', birthCertificate: '出生証明書',
  healthInsurance: '健康保険', ssnCard: '社会保障番号', file: 'ファイル', photo: '写真',
};

/** Field types used as "$type" keys in custom_fields. */
const FIELD_LABELS = {
  text: 'テキスト', note: 'メモ', multiline: 'メモ', secret: 'シークレット', url: 'URL', email: 'メール',
  phone: '電話', name: '氏名', address: '住所', birthDate: '生年月日', date: '日付',
  expirationDate: '有効期限', paymentCard: 'カード', bankAccount: '口座', accountNumber: '番号',
  host: 'ホスト', keyPair: '鍵ペア', securityQuestion: '秘密の質問', pinCode: 'PIN',
  licenseNumber: 'ライセンス番号', login: 'ユーザー名', password: 'パスワード',
};
/** Keys inside object-valued fields (paymentCard, name, address, host, securityQuestion…). */
const SUB_LABELS = {
  cardNumber: 'カード番号', cardExpirationDate: '有効期限', cardSecurityCode: 'セキュリティコード',
  question: '秘密の質問', answer: '答え', first: '名', middle: 'ミドルネーム', last: '姓',
  hostName: 'ホスト名', port: 'ポート', accountType: '口座の種類', routingNumber: 'ルーティング番号',
  accountNumber: '口座番号', street1: '住所 1', street2: '住所 2', city: '市区町村', state: '州・地域',
  zip: '郵便番号', country: '国', privateKey: '秘密鍵', publicKey: '公開鍵', number: '番号', ext: '内線',
};
const DATE_TYPES = new Set(['birthDate', 'date', 'expirationDate']);
const NOTE_TYPES = new Set(['note', 'multiline']);

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');

/** "$type:label:n" → { type, label }; `custom` is true when the user gave the field a label. */
function fieldLabel(key) {
  if (!key.startsWith('$')) return { type: '', label: key, custom: true };
  const [type, label] = key.slice(1).split(':');
  return { type, label: str(label) || FIELD_LABELS[type] || type, custom: !!str(label) };
}

const MAX_DEPTH = 8; // Keeper values nest a level or two; anything deeper is ignored

function fieldValue(v, type, depth = 0) {
  if (v == null || depth > MAX_DEPTH) return '';
  if (Array.isArray(v)) return v.map((x) => fieldValue(x, type, depth + 1)).filter(Boolean).join('\n');
  if (typeof v === 'object') return '';
  if (typeof v === 'number' && DATE_TYPES.has(type)) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(v);
  }
  return String(v);
}

/** A custom field → [label, value] pairs (appended to `out`); objects give one pair per key. */
function fieldPairs(label, type, v, out, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
    for (const x of v) fieldPairs(label, type, x, out, depth + 1);
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) out.push([SUB_LABELS[k] || k, fieldValue(x, k)]);
  } else {
    out.push([label, fieldValue(v, type)]);
  }
}

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const json = parseJson(bytesToText(file.bytes), 'Keeper');
  if (!json || typeof json !== 'object' || !Array.isArray(json.records)) {
    throw new ImportError('INVALID_FORMAT', 'Keeper の書き出しファイル（JSON）ではありません');
  }
  const items = [];
  const converted = {};
  let skipped = 0, badTotp = 0;

  for (const r of json.records) {
    if (!r || typeof r !== 'object') { skipped++; continue; }
    const kind = r.$type ? TYPES[r.$type] || 'その他のアイテム' : 'login';
    const otps = [], extras = [], bodies = [];
    for (const [key, v] of Object.entries(r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {})) {
      if (key === 'TFC:Keeper' || /^\$oneTimeCode(:|$)/.test(key)) {
        for (const line of fieldValue(v).split('\n')) if (line) otps.push(line);
        continue;
      }
      const { type, label, custom } = fieldLabel(key);
      if (NOTE_TYPES.has(type) && !custom) bodies.push(fieldValue(v, type)); // e.g. the text of encryptedNotes
      else fieldPairs(label, type, v, extras);
    }
    const notes = joinNote(r.notes, bodies.join('\n\n'));

    if (kind === 'login') {
      let totp = null;
      const otpExtras = [];
      for (const raw of otps) {
        const cfg = !totp && parseOtp(raw, r.login || r.title);
        if (cfg) totp = cfg;
        else {
          if (!parseOtp(raw)) badTotp++;
          otpExtras.push(['TOTP', raw]);
        }
      }
      items.push({
        type: 'login', title: r.title, url: r.login_url, username: r.login, password: r.password, totp,
        note: joinNote(notes, fieldsToNote([...otpExtras, ...extras])),
      });
      continue;
    }
    const base = [['ユーザー名', r.login], ['パスワード', r.password], ['URL', r.login_url], ...otps.map((t) => ['TOTP', t])];
    if (kind === 'note') {
      items.push({ type: 'note', title: r.title, note: joinNote(notes, fieldsToNote([...base, ...extras])) });
      continue;
    }
    converted[kind] = (converted[kind] || 0) + 1;
    items.push({ type: 'note', title: r.title, note: fieldsToNote([...base, ...extras], notes) });
  }

  const warnings = Object.entries(converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はメモに残しました`);
  return { items, skipped, warnings };
}
