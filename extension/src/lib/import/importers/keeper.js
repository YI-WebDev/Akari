// Keeper JSON export: { shared_folders: [...], records: [{ title, $type, login, password,
// login_url, notes, custom_fields: { name | "$type:label:n": value }, folders }] }.
// TOTP lives in custom_fields "TFC:Keeper" (legacy) or "$oneTimeCode…" (v3 records).
// Record types with an Akari type are mapped by Keeper's field types ($paymentCard, $name,
// $accountNumber:passportNumber, …); everything else becomes extra fields.
// Folders and shared folders are ignored.

import { ImportError, fieldsToNote, parseOtp, bytesToText, parseJson } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { personName } from '../../../shared/item-types.js';
import { L, fromEntries, LABEL_RULES, looksSecret } from './_fields.js';

const address = (p) => [
  ['address1', `${p}.street1`], ['address2', `${p}.street2`], ['city', `${p}.city`], ['state', `${p}.state`],
  ['postalCode', `${p}.zip`], ['country', `${p}.country`],
];

/**
 * Keeper record $type → login / note, [Akari type, rules] (template key ← entry ids, see
 * entriesOf), or the Japanese name of a kind kept as a secure note (translated when reported).
 */
const TYPES = {
  login: 'login', general: 'login', encryptedNotes: 'note',
  bankCard: ['card', [
    ['number', 'paymentCard.cardNumber'], ['expiry', 'paymentCard.cardExpirationDate'], ['cvv', 'paymentCard.cardSecurityCode'],
    ['cardholder', 'text:cardholderName'], ['pin', 'pinCode'],
  ]],
  address: ['identity', address('address')],
  contact: ['identity', [
    ['firstName', 'name.first'], ['middleName', 'name.middle'], ['lastName', 'name.last'], ['company', 'text:company'],
    ['email', 'email'], ['phone', 'phone'], ['birthDate', 'birthDate'], ...address('address'),
  ]],
  bankAccount: ['bankAccount', [
    ['accountType', 'bankAccount.accountType', 'bankAccount.otherType'], ['routingNumber', 'bankAccount.routingNumber'],
    ['accountNumber', 'bankAccount.accountNumber'], ['accountHolder', 'name'],
  ]],
  driverLicense: ['driverLicense', [
    ['number', 'accountNumber:dlNumber', 'accountNumber'], ['fullName', 'name'], ['birthDate', 'birthDate'],
    ['expiry', 'expirationDate'], ['issuedOn', 'date:dateIssued'],
  ]],
  passport: ['passport', [
    ['number', 'accountNumber:passportNumber', 'accountNumber'], ['fullName', 'name'], ['birthDate', 'birthDate'],
    ['expiry', 'expirationDate'], ['issuedOn', 'date:dateIssued'],
  ]],
  membership: ['membership', [['memberId', 'accountNumber'], ['memberName', 'name'], ['url', 'url']]],
  healthInsurance: ['medicalRecord', [['policyNumber', 'accountNumber'], ['patientName', 'name:insuredsName', 'name']]],
  ssnCard: ['socialSecurity', [['number', 'accountNumber:identityNumber', 'accountNumber'], ['fullName', 'name']]],
  serverCredentials: ['server', [
    ['host', 'host.hostName'], ['port', 'host.port'], ['username', 'login'], ['password', 'password'], ['url', 'url'],
  ]],
  databaseCredentials: ['database', [
    ['dbType', 'text:type'], ['host', 'host.hostName'], ['port', 'host.port'], ['username', 'login'], ['password', 'password'],
  ]],
  sshKeys: ['sshKey', [
    ['privateKey', 'keyPair.privateKey'], ['publicKey', 'keyPair.publicKey'], ['passphrase', 'password'],
    ['host', 'host.hostName'], ['username', 'login'],
  ]],
  softwareLicense: ['softwareLicense', [['licenseKey', 'licenseNumber'], ['expiry', 'expirationDate'], ['url', 'url']]],
  wifiCredentials: ['wifi', [
    ['ssid', 'text:SSID'], ['password', 'password'], ['security', 'wifiEncryption', 'text:security'],
    ...LABEL_RULES.wifi.filter(([k]) => k === 'ssid' || k === 'security'),
  ]],
  birthCertificate: '出生証明書', file: 'ファイル', photo: '写真',
};

/** Field types used as "$type" keys in custom_fields. */
const FIELD_LABELS = {
  text: 'テキスト', note: 'メモ', multiline: 'メモ', secret: 'シークレット', url: 'URL', email: 'メール',
  phone: '電話', name: '氏名', address: '住所', birthDate: '生年月日', date: '日付',
  expirationDate: '有効期限', paymentCard: 'カード', bankAccount: '口座', accountNumber: '番号',
  host: 'ホスト', keyPair: '鍵ペア', securityQuestion: '秘密の質問', pinCode: 'PIN',
  licenseNumber: 'ライセンス番号', login: 'ユーザー名', password: 'パスワード', checkbox: 'チェック',
};
/** Keys inside object-valued fields (paymentCard, name, address, host, securityQuestion…). */
const SUB_LABELS = {
  cardNumber: 'カード番号', cardExpirationDate: '有効期限', cardSecurityCode: 'セキュリティコード',
  question: '秘密の質問', answer: '答え', first: '名', middle: 'ミドルネーム', last: '姓',
  hostName: 'ホスト名', port: 'ポート', accountType: '口座の種類', routingNumber: 'ルーティング番号',
  accountNumber: '口座番号', otherType: '口座の種類（その他）', street1: '住所 1', street2: '住所 2', city: '市区町村',
  state: '州・地域', zip: '郵便番号', country: '国', privateKey: '秘密鍵', publicKey: '公開鍵', number: '番号', ext: '内線',
  region: '地域', type: '種類',
};
/** Labels Keeper's own record types give their fields ("$date:dateActive:1" …). */
const BUILTIN_LABELS = {
  cardholderName: 'カード名義', company: '会社', dateActive: '有効化日', dateIssued: '発行日', dlNumber: '免許証番号',
  identityNumber: '番号', insuredsName: '被保険者', passportNumber: 'パスポート番号', type: '種類',
};
const DATE_TYPES = new Set(['birthDate', 'date', 'expirationDate']);
const NOTE_TYPES = new Set(['note', 'multiline']);
const SECRET_TYPES = new Set(['secret', 'password', 'pinCode', 'oneTimeCode', 'licenseNumber']);
const SECRET_SUBS = new Set(['cardNumber', 'cardSecurityCode', 'privateKey', 'answer', 'accountNumber']);

const str = (v) => (v == null ? '' : String(v).trim());
const joinNote = (...parts) => parts.map(str).filter(Boolean).join('\n\n');

/** "$type:label:n" → { type, raw (label as written), label, custom }; `custom` = the user gave a label. */
function fieldLabel(key) {
  if (!key.startsWith('$')) return { type: '', raw: key, label: key, custom: true };
  const [type, raw] = key.slice(1).split(':');
  const label = Object.hasOwn(BUILTIN_LABELS, str(raw)) ? L(`keeper.${raw}`, BUILTIN_LABELS[raw])
    : str(raw) || (FIELD_LABELS[type] ? L(`keeper.${type}`, FIELD_LABELS[type]) : type); // unknown: the file's own text
  return { type, raw: str(raw), label, custom: !!str(raw) };
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

/**
 * One custom field → entries { id: [type, "type:label", "type.sub"…], label, value, secret }.
 * Objects give one entry per key ($name and $phone become one line unless `splitName`).
 */
function entriesOf(key, v, out, splitName, depth = 0) {
  if (depth > MAX_DEPTH) return;
  const { type, raw, label } = fieldLabel(key);
  const ids = raw ? [type, `${type}:${raw}`] : [type];
  if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
    for (const x of v) entriesOf(key, x, out, splitName, depth + 1);
    return;
  }
  const secret = SECRET_TYPES.has(type) || (!type && looksSecret(raw));
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    out.push({ id: ids, label, value: fieldValue(v, type), secret });
  } else if (type === 'name' && !splitName) {
    out.push({ id: ids, label, value: personName(v.first, v.middle, v.last), secret });
  } else if (type === 'phone') {
    out.push({ id: ids, label, value: [str(v.number), str(v.ext) && `(${L('keeper.ext', '内線')} ${str(v.ext)})`].filter(Boolean).join(' ') });
  } else {
    for (const [k, x] of Object.entries(v)) {
      out.push({
        id: [...ids.map((id) => `${id}.${k}`)], label: SUB_LABELS[k] ? L(`keeper.${k}`, SUB_LABELS[k]) : k,
        value: fieldValue(x, k), secret: secret || SECRET_SUBS.has(k),
      });
    }
  }
}

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const json = parseJson(bytesToText(file.bytes), 'Keeper');
  if (!json || typeof json !== 'object' || !Array.isArray(json.records)) {
    throw new ImportError('INVALID_FORMAT', t('Keeper の書き出しファイル（JSON）ではありません'));
  }
  const items = [];
  const converted = {};
  let skipped = 0, badTotp = 0;

  for (const r of json.records) {
    if (!r || typeof r !== 'object') { skipped++; continue; }
    const kind = r.$type ? TYPES[r.$type] || 'その他のアイテム' : 'login';
    const typedKind = Array.isArray(kind) ? kind : null;
    const otps = [], entries = [], bodies = [];
    for (const [key, v] of Object.entries(r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {})) {
      if (key === 'TFC:Keeper' || /^\$oneTimeCode(:|$)/.test(key)) {
        for (const line of fieldValue(v).split('\n')) if (line) otps.push(line);
        continue;
      }
      const { type, custom } = fieldLabel(key);
      if (NOTE_TYPES.has(type) && !custom) bodies.push(fieldValue(v, type)); // e.g. the text of encryptedNotes
      else entriesOf(key, v, entries, typedKind?.[0] === 'identity');
    }
    const notes = joinNote(r.notes, bodies.join('\n\n'));
    const creds = [
      { id: 'login', label: L('username', 'ユーザー名'), value: str(r.login) },
      { id: 'password', label: L('password', 'パスワード'), value: r.password == null ? '' : String(r.password), secret: true },
      { id: 'url', label: L('url', 'URL'), value: str(r.login_url) },
    ];
    const otpExtra = (t) => ({ label: L('otp', 'ワンタイムパスワード'), value: t, secret: true });
    const toExtra = (e) => ({ label: e.label, value: e.value, secret: !!e.secret });

    if (kind === 'login') {
      let totp = null;
      const extra = [];
      for (const raw of otps) {
        const cfg = !totp && parseOtp(raw, r.login || r.title);
        if (cfg) totp = cfg;
        else {
          if (!parseOtp(raw)) badTotp++;
          extra.push(otpExtra(raw));
        }
      }
      items.push({
        type: 'login', title: r.title, url: r.login_url, username: r.login, password: r.password, totp,
        note: notes, extra: [...extra, ...entries.map(toExtra)],
      });
    } else if (kind === 'note') {
      items.push({ type: 'note', title: r.title, note: notes, extra: [...creds, ...entries].map(toExtra).concat(otps.map(otpExtra)) });
    } else if (typedKind) {
      const b = fromEntries(typedKind[0], [...entries, ...creds], typedKind[1]);
      items.push(b.item({ title: r.title, note: notes, extra: otps.map(otpExtra) }));
    } else {
      converted[kind] = (converted[kind] || 0) + 1;
      const pairs = [...creds, ...otps.map(otpExtra), ...entries].map((e) => [e.label, e.value]);
      items.push({ type: 'note', title: r.title, note: fieldsToNote(pairs, notes) });
    }
  }

  const warnings = Object.entries(converted).map(([k, n]) => t('{kind} {n} 件をセキュアノートとして読み込みました', { kind: t(k), n }));
  if (badTotp) warnings.push(t('読み取れない TOTP 設定 {n} 件はカスタムフィールドに残しました', { n: badTotp }));
  return { items, skipped, warnings };
}
