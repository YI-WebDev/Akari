// Proton Pass exports:
//  - ZIP with "Proton Pass/data.json": { vaults: { <id>: { name, items: [{ itemId, state
//    (1 active, 2 trashed), pinned, createTime, modifyTime, aliasEmail, data: { type,
//    metadata: { name, note }, content: {...}, extraFields: [...] } }] } } }.
//  - a bare data.json, or a CSV (type,name,url,email,username,password,note,totp,createTime,
//    modifyTime,vault).
//  - .pgp exports are decrypted by index.js first; a ZIP holding data.pgp is opened here.
// Login passkeys (JSON only; the CSV has none) come over when they are ES256 on P-256, see below.
// creditCard / identity / sshKey / wifi items map onto the Akari types of the same name. Proton's
// other templates (API credential, database, server, bank account, passport, …) are exported as
// "custom" items that only carry their fields; the template is recognised from the field names
// (English or Japanese, as written by packages/pass/components/Item/Custom/Custom.templates.ts).

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { readZip, findEntry } from '../zip.js';
import { csvToObjects } from '../csv.js';
import { decodeMsgpack } from '../msgpack.js';
import { fromB64, toB64url, concat } from '../../../shared/bytes.js';
import { L, typed, fromEntries, LABEL_RULES } from './_fields.js';
import { toDate, wifiSecurity } from './_values.js';

/** Japanese names of kinds that are kept as secure notes. */
const KINDS = {
  creditCard: 'クレジットカード', identity: '個人情報', alias: 'メールエイリアス', wifi: 'Wi-Fi',
  sshKey: 'SSH キー', custom: 'カスタムアイテム',
};
/** Content keys → labels, for values that end up as extra fields or note lines. */
const LABELS = {
  cardholderName: 'カード名義', number: 'カード番号', verificationCode: 'セキュリティコード',
  expirationDate: '有効期限', pin: 'PIN', ssid: 'SSID', password: 'パスワード', privateKey: '秘密鍵',
  publicKey: '公開鍵', fullName: '氏名', email: 'メール', phoneNumber: '電話', firstName: '名',
  middleName: 'ミドルネーム', lastName: '姓', birthdate: '生年月日', gender: '性別', organization: '組織',
  streetAddress: '住所', zipOrPostalCode: '郵便番号', city: '市区町村', stateOrProvince: '都道府県・州',
  countryOrRegion: '国・地域', company: '会社', jobTitle: '役職', website: 'ウェブサイト',
  socialSecurityNumber: '社会保障番号', passportNumber: 'パスポート番号', licenseNumber: '免許証番号',
  username: 'ユーザー名', url: 'URL', totp: 'TOTP', floor: '階', county: '郡', secondPhoneNumber: '電話 2',
  workPhoneNumber: '勤務先の電話', workEmail: '勤務先のメール', personalWebsite: '個人のウェブサイト',
  xHandle: 'X', linkedin: 'LinkedIn', reddit: 'Reddit', facebook: 'Facebook', yahoo: 'Yahoo', instagram: 'Instagram',
};
const label = (k) => L('proton.' + k, LABELS[k] || k);
const SECRET_KEYS = new Set(['socialSecurityNumber', 'passportNumber', 'licenseNumber', 'verificationCode', 'pin', 'password', 'privateKey']);

/** Proton identity content key → identity template key. */
const IDENTITY = {
  fullName: 'fullName', firstName: 'firstName', middleName: 'middleName', lastName: 'lastName', email: 'email', phoneNumber: 'phone',
  birthdate: 'birthDate', company: 'company', organization: 'company', jobTitle: 'jobTitle',
  streetAddress: 'address1', floor: 'address2', city: 'city', stateOrProvince: 'state',
  zipOrPostalCode: 'postalCode', countryOrRegion: 'country', website: 'website', personalWebsite: 'website',
};
const CARD_TYPES = { 2: 'Visa', 3: 'Mastercard', 4: 'American Express' };
const WIFI_SECURITY = { 1: 'wpa', 2: 'wpa2', 3: 'wpa3', 4: 'wep' };

/**
 * Proton's custom-item templates: [Akari type, [templateKey | null, English name, Japanese name]].
 * null = no template key (the field is kept as an extra field). The Japanese names are Proton's
 * own translations (applications/pass/locales/ja_JP.json — "Address" really is "メールアドレス").
 */
const TEMPLATES = [
  ['apiCredential', [['keyId', 'API Key', 'APIキー'], ['secret', 'Secret', '秘密'], ['expiry', 'Expiry Date', '有効期限'], [null, 'Permissions', '許可']]],
  ['database', [['host', 'Host', 'ホスト'], ['port', 'Port', 'ポート'], ['username', 'Username', 'ユーザー名'], ['password', 'Password', 'パスワード'], ['dbType', 'Database Type', 'データベース種類']]],
  ['server', [['host', 'Hostname', 'ホスト名'], ['host', 'IP Address', 'IPアドレス'], [null, 'Operating System', 'オペレーティングシステム'], ['username', 'Username', 'ユーザー名'], ['password', 'Password', 'パスワード']]],
  ['softwareLicense', [['licenseKey', 'License Key', 'ライセンスキー'], ['product', 'Product', '製品'], ['expiry', 'Expiry Date', '有効期限'], ['licensee', 'Owner', '所有者']]],
  ['bankAccount', [['bankName', 'Bank Name', '銀行名'], ['accountNumber', 'Account Number', '口座番号'], ['routingNumber', 'Routing Number', '支店番号'], ['accountType', 'Account Type', '口座種別'], ['iban', 'IBAN', 'IBAN'], ['swift', 'SWIFT/BIC', 'SWIFT/BIC'], ['accountHolder', 'Holder Name', '所有者名']]],
  ['cryptoWallet', [[null, 'Wallet Name', 'ウォレット名'], ['address', 'Address', 'メールアドレス'], ['privateKey', 'Private Key', '秘密鍵'], ['recoveryPhrase', 'Seed Phrase', 'シードフレーズ'], ['network', 'Network', 'ネットワーク']]],
  ['driverLicense', [['fullName', 'Full Name', 'フルネーム'], ['number', 'License Number', '免許証番号'], ['issuer', 'Issuing State/Country', '発行州/国'], ['expiry', 'Expiry Date', '有効期限'], ['birthDate', 'Date of Birth', '生年月日'], ['licenseClass', 'Class', 'クラス']]],
  ['medicalRecord', [['patientName', 'Patient Name', '患者氏名'], ['recordNumber', 'Record Number', 'レコード番号'], [null, 'Medical Conditions', '医療状況'], ['medications', 'Medications', '服用している薬'], ['doctor', 'Doctor', '医者'], ['provider', 'Hospital', '病院']]],
  ['membership', [['organization', 'Organization Name', '組織名'], ['memberId', 'Membership ID', 'メンバーシップID'], ['memberName', 'Member Name', 'メンバー名'], ['expiry', 'Expiry Date', '有効期限'], [null, 'Tier/Level', '階級/レベル']]],
  ['passport', [['fullName', 'Full Name', 'フルネーム'], ['number', 'Passport Number', 'パスポート番号'], ['issuingCountry', 'Country', '国'], ['expiry', 'Expiry Date', '有効期限'], ['birthDate', 'Date of Birth', '生年月日'], ['authority', 'Issuing Authority', '発行機関']]],
  ['rewardProgram', [['company', 'Program Name', 'プログラム名'], ['memberId', 'Member ID', 'メンバーID'], [null, 'Points Balance', 'ポイント残高'], ['expiry', 'Expiry Date', '有効期限'], [null, 'Tier/Status', '階級/ステータス']]],
  ['socialSecurity', [['fullName', 'Full Name', 'フルネーム'], ['number', 'SSN', 'SSN'], [null, 'Issuing Country', '発行国']]],
];

const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
// Names that occur in a single template only: at least one must be present to pick it.
const NAME_COUNT = new Map();
for (const [, fields] of TEMPLATES) {
  for (const n of new Set(fields.flatMap(([, ...names]) => names.map(norm)))) NAME_COUNT.set(n, (NAME_COUNT.get(n) || 0) + 1);
}

/** The template a custom item was made from, judged by its field names; null when unclear. */
function detectTemplate(names) {
  const have = new Set(names.map(norm));
  let best = null, bestScore = 0, bestShare = 0;
  for (const [type, fields] of TEMPLATES) {
    const hits = fields.filter(([, ...ns]) => ns.some((n) => have.has(norm(n))));
    const distinctive = hits.some(([, ...ns]) => ns.some((n) => have.has(norm(n)) && NAME_COUNT.get(norm(n)) === 1));
    const share = hits.length / fields.length;
    if (hits.length >= 2 && distinctive && (hits.length > bestScore || (hits.length === bestScore && share > bestShare))) {
      [best, bestScore, bestShare] = [[type, fields], hits.length, share];
    }
  }
  return best;
}

const str = (v) => (v == null ? '' : String(v).trim());

function makeRun() {
  return { items: [], skipped: 0, converted: {}, badTotp: 0, badPasskeys: 0, attachments: 0 };
}

// --- passkeys (login content.passkeys) ------------------------------------------------------
//
// data.json writes a passkey's byte fields (content, credentialId, userHandle, userId) as
// standard base64. `content` is Proton's own record (proton-pass-common, MessagePack with
// named fields): { c: <inner record>, v: 1 }, the inner record being { key, cid, rid, uhd,
// cnt, ext, un, udn } where `key` is the private COSE key { kty, alg, par: [[label, value]…] }.
// Byte strings are arrays of numbers there; enum values are { t: <kind>, c: <value> }.
// Akari signs with ES256 only, so a P-256 key is required; its private scalar (COSE -4)
// becomes a PKCS8 key, the form the vault expects (the public key is derived from it).

const MAX_PASSKEY_BYTES = 64 * 1024;

/** Bytes from a Uint8Array, an array of numbers, or a (standard or URL-safe) base64 string. */
function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) {
    return v.length <= MAX_PASSKEY_BYTES && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? Uint8Array.from(v) : null;
  }
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > MAX_PASSKEY_BYTES * 2 || !/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  try {
    const b = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    return fromB64(b + '='.repeat((4 - (b.length % 4)) % 4));
  } catch {
    return null;
  }
}

const nonEmpty = (...values) => {
  for (const v of values) {
    const b = bytesOf(v);
    if (b && b.length) return b;
  }
  return null;
};

/** { t, c } enum value → c when its kind is `t`. */
const tagged = (v, t) => (v && typeof v === 'object' && v.t === t ? v.c : undefined);

/** COSE integer value { t: 'int', c: { inner: <16 little-endian bytes> } } → Number, else null. */
function coseInt(v) {
  const inner = bytesOf(tagged(v, 'int')?.inner);
  if (!inner || !inner.length || inner.length > 16) return null;
  let n = 0n;
  for (let i = inner.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(inner[i]);
  if (inner[inner.length - 1] & 0x80) n -= 1n << BigInt(inner.length * 8);
  return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

// PKCS8 PrivateKeyInfo for a P-256 key holding only the private scalar (RFC 5915 lets the
// public key be left out): version 0, id-ecPublicKey + prime256v1, ECPrivateKey { 1, d }.
const PKCS8_P256_HEAD = Uint8Array.of(
  0x30, 0x41, 0x02, 0x01, 0x00,
  0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
);

/** Proton's passkey record → the decoded inner record, or null. */
function protonRecord(content) {
  const bytes = bytesOf(content);
  if (!bytes || !bytes.length || bytes.length > MAX_PASSKEY_BYTES) return null;
  try {
    const outer = decodeMsgpack(bytes);
    if (!outer || outer.v !== 1) return null;
    const inner = bytesOf(outer.c);
    const rec = inner && decodeMsgpack(inner);
    return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
  } catch {
    return null;
  }
}

/** The P-256 private scalar of an ES256 COSE key, or null for any other kind of key. */
function p256Scalar(key) {
  if (!key || typeof key !== 'object' || tagged(key.kty, 'assign') !== 'EC2') return null;
  if (key.alg != null && tagged(key.alg, 'assign') !== 'ES256') return null;
  let crv = null, d = null;
  for (const pair of Array.isArray(key.par) ? key.par : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const label = tagged(pair[0], 'int');
    if (label === -1) crv = coseInt(pair[1]);
    else if (label === -4) d = bytesOf(tagged(pair[1], 'bytes'));
  }
  return crv === 1 && d && d.length === 32 ? d : null;
}

/** One entry of content.passkeys → an ImportedItem passkey (model.js), or null. */
function toPasskey(p, fallbackCreatedAt) {
  if (!p || typeof p !== 'object') return null;
  const rec = protonRecord(p.content);
  const d = rec && p256Scalar(rec.key);
  if (!d) return null;
  // The ids inside the record are the ones Proton signed with; the outer copies are fallbacks.
  const credentialId = nonEmpty(rec.cid, p.credentialId);
  const userHandle = nonEmpty(rec.uhd, p.userHandle, p.userId);
  const rpId = str(rec.rid || p.rpId).toLowerCase();
  if (!credentialId || !userHandle || !rpId) return null;
  return {
    credentialId: toB64url(credentialId),
    rpId,
    userHandle: toB64url(userHandle),
    userName: str(p.userName) || str(rec.un),
    userDisplayName: str(p.userDisplayName) || str(rec.udn),
    privateKey: toB64url(concat(PKCS8_P256_HEAD, d)),
    createdAt: toMs(p.createTime) ?? fallbackCreatedAt,
  };
}

/** One extra field { fieldName, type, data: { content | totpUri | timestamp } } → entry. */
function fieldEntry(f) {
  const d = f?.data || {};
  let v = d.content ?? d.totpUri ?? '';
  if (v === '' && d.timestamp != null) {
    const ts = typeof d.timestamp === 'object' ? d.timestamp?.seconds : d.timestamp;
    v = toDate(ts) || str(ts);
  }
  const name = str(f?.fieldName);
  return { id: norm(name), label: name || L('field', '項目'), value: v == null ? '' : String(v), secret: f?.type === 'hidden' || f?.type === 'totp' };
}

/** Every extra field of an item: data.extraFields, content.sections[].sectionFields. */
function allFields(d, c) {
  const list = Array.isArray(d.extraFields) ? [...d.extraFields] : [];
  for (const s of Array.isArray(c.sections) ? c.sections : []) {
    if (s && Array.isArray(s.sectionFields)) list.push(...s.sectionFields);
  }
  return list.filter((f) => f && typeof f === 'object');
}

const MAX_DEPTH = 8; // item content is at most a few levels deep; ignore anything deeper

/**
 * Flatten item content into [label, value] pairs: scalars (enum numbers/booleans are dropped),
 * extra-field arrays, and sections ({ sectionName, sectionFields }). Used for kinds kept as notes.
 */
function flatten(obj, out, depth = 0) {
  if (depth > MAX_DEPTH) return out;
  for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
    if (v == null || v === '' || typeof v === 'number' || typeof v === 'boolean') continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object' && 'fieldName' in x) { const e = fieldEntry(x); out.push([e.label, e.value]); }
        else if (x && typeof x === 'object' && Array.isArray(x.sectionFields)) {
          for (const f of x.sectionFields) { const e = fieldEntry(f); out.push([e.label, e.value]); }
        } else if (typeof x === 'string') out.push([label(k), x]);
      }
    } else if (typeof v === 'object') {
      flatten(v, out, depth + 1);
    } else {
      out.push([label(k), v]);
    }
  }
  return out;
}

const toExtra = (e) => ({ label: e.label, value: e.value, secret: !!e.secret });

function pushLogin(run, p) {
  const otpExtra = [];
  let totp = null;
  for (const raw of p.totps.map(str).filter(Boolean)) {
    const cfg = !totp && parseOtp(raw, p.username || p.title);
    if (cfg) totp = cfg;
    else {
      if (!parseOtp(raw)) run.badTotp++;
      otpExtra.push({ label: L('otp', 'ワンタイムパスワード'), value: raw, secret: true });
    }
  }
  const urls = [...new Set(p.urls.map(str).filter(Boolean))];
  run.items.push({
    type: 'login', title: p.title, url: urls[0] || '', username: p.username, password: p.password, totp,
    passkeys: p.passkeys || [],
    fav: p.fav, createdAt: p.createdAt, updatedAt: p.updatedAt, note: p.note,
    extra: [...urls.slice(1).map((u) => ({ label: L('url', 'URL'), value: u, secret: false })), ...otpExtra, ...p.extra],
  });
}

function creditCard(c, entries) {
  const b = typed('card');
  b.put('cardholder', c.cardholderName, label('cardholderName'));
  b.put('number', c.number, label('number'));
  b.put('expiry', c.expirationDate, label('expirationDate'));
  b.put('cvv', c.verificationCode, label('verificationCode'));
  b.put('pin', c.pin, label('pin'));
  b.brand(CARD_TYPES[c.cardType] || (typeof c.cardType === 'string' ? c.cardType : ''));
  return b.item({ extra: entries.map(toExtra) });
}

function identity(c, entries) {
  const b = typed('identity');
  const extra = [];
  for (const [k, v] of Object.entries(c)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object' && 'fieldName' in x) extra.push(toExtra(fieldEntry(x)));
        else if (x && typeof x === 'object' && Array.isArray(x.sectionFields)) extra.push(...x.sectionFields.map((f) => toExtra(fieldEntry(f))));
      }
    } else if (typeof v === 'string') {
      if (IDENTITY[k]) b.put(IDENTITY[k], v, label(k));
      else b.add(label(k), v, SECRET_KEYS.has(k));
    }
  }
  return b.item({ extra: [...extra, ...entries.map(toExtra)] });
}

function sshKey(c, entries) {
  const list = [
    { id: 'privateKey', label: label('privateKey'), value: str(c.privateKey), secret: true },
    { id: 'publicKey', label: label('publicKey'), value: str(c.publicKey) },
    ...entries,
  ];
  return fromEntries('sshKey', list, [['privateKey', 'privateKey'], ['publicKey', 'publicKey'], ...LABEL_RULES.sshKey]).item();
}

function wifi(c, entries) {
  const b = typed('wifi');
  b.put('ssid', c.ssid, label('ssid'));
  b.put('password', c.password, label('password'));
  b.put('security', WIFI_SECURITY[c.security] || (typeof c.security === 'string' ? wifiSecurity(c.security) || c.security : ''),
    L('wifiSecurity', 'セキュリティ'));
  return b.item({ extra: entries.map(toExtra) });
}

/** A custom item: one of Proton's templates when recognisable, else a note with extra fields. */
function custom(entries) {
  const tpl = detectTemplate(entries.map((e) => e.label));
  if (!tpl) return null;
  const [type, fields] = tpl;
  // Matched by field name — a name, not an id, so a hidden value never lands in a visible field.
  const named = (...names) => ({ test: (label) => names.map(norm).includes(norm(label)) });
  const rules = [];
  for (const [key, ...names] of fields) {
    if (!key) continue;
    const rule = rules.find(([k]) => k === key);
    if (rule) rule.push(named(...names));
    else rules.push([key, named(...names)]);
  }
  // An API credential with a single key keeps it as the secret, not as the key id.
  if (type === 'apiCredential' && !entries.some((e) => ['secret', '秘密'].includes(e.id) && str(e.value))) {
    rules.unshift(['secret', named('API Key', 'APIキー')]);
  }
  return fromEntries(type, entries, rules).item();
}

function fromJson(run, json) {
  if (json?.encrypted === true) {
    throw new ImportError('UNSUPPORTED', '暗号化された Proton Pass の書き出しは、PGP 暗号化（.pgp）か暗号化なしで書き出したファイルを選んでください');
  }
  if (!json || typeof json !== 'object' || !json.vaults || typeof json.vaults !== 'object') {
    throw new ImportError('INVALID_FORMAT', 'Proton Pass の書き出しファイル（data.json）ではありません');
  }
  for (const vault of Object.values(json.vaults)) {
    for (const it of Array.isArray(vault?.items) ? vault.items : []) {
      if (!it || typeof it !== 'object' || !it.data || it.state === 2) { run.skipped++; continue; }
      const d = it.data;
      const m = d.metadata || {};
      const c = d.content && typeof d.content === 'object' ? d.content : {};
      const base = { title: str(m.name), note: m.note, fav: it.pinned === true, createdAt: toMs(it.createTime), updatedAt: toMs(it.modifyTime) };
      const extraFields = Array.isArray(d.extraFields) ? d.extraFields : [];
      const fields = d.type === 'identity' ? extraFields.filter((f) => f && typeof f === 'object') : allFields(d, c);

      if (d.type === 'login') {
        const passkeys = [];
        for (const p of Array.isArray(c.passkeys) ? c.passkeys : []) {
          const pk = toPasskey(p, base.createdAt);
          if (pk) passkeys.push(pk);
          else run.badPasskeys++;
        }
        const email = str(c.itemEmail), user = str(c.itemUsername || c.username);
        const otherTotps = fields.filter((f) => f.type === 'totp').map((f) => f.data?.totpUri);
        const extra = fields.filter((f) => f.type !== 'totp').map((f) => toExtra(fieldEntry(f)));
        pushLogin(run, {
          ...base,
          username: user || email,
          password: c.password,
          urls: Array.isArray(c.urls) ? c.urls : [],
          totps: [c.totpUri, ...otherTotps],
          passkeys,
          extra: user && email ? [{ label: label('email'), value: email, secret: false }, ...extra] : extra,
        });
        continue;
      }
      const entries = fields.map(fieldEntry);
      let item = null;
      if (d.type === 'note') item = { type: 'note', extra: entries.map(toExtra) };
      else if (d.type === 'creditCard') item = creditCard(c, entries);
      else if (d.type === 'identity') item = identity(c, entries);
      else if (d.type === 'sshKey') item = sshKey(c, entries);
      else if (d.type === 'wifi') item = wifi(c, entries);
      else if (d.type === 'custom') item = custom(entries);
      if (item) {
        run.items.push({ ...base, ...item });
        continue;
      }
      // Aliases, custom items of no known template, and item types this importer does not know.
      const kind = KINDS[d.type] || 'その他のアイテム';
      run.converted[kind] = (run.converted[kind] || 0) + 1;
      if (d.type === 'alias' || d.type === 'custom') {
        const note = d.type === 'alias' ? fieldsToNote([[L('alias', 'エイリアス'), it.aliasEmail]], m.note) : m.note;
        run.items.push({ ...base, type: 'note', note, extra: entries.map(toExtra) });
      } else {
        const pairs = [...flatten(c, []), ...extraFields.map(fieldEntry).map((e) => [e.label, e.value])];
        run.items.push({ ...base, type: 'note', note: fieldsToNote(pairs, m.note) });
      }
    }
  }
}

function fromCsv(run, text) {
  const { headers, records } = csvToObjects(text);
  if (!headers.includes('type') || !headers.includes('name')) {
    throw new ImportError('INVALID_FORMAT', 'Proton Pass の書き出しファイル（CSV）ではありません');
  }
  for (const rec of records) {
    const type = str(rec.type);
    const base = { title: str(rec.name), createdAt: toMs(rec.createtime), updatedAt: toMs(rec.modifytime) };
    // Several URLs are joined in one cell; split only where the next part starts with a scheme.
    // (Linear pattern: no \s* on both sides of an alternative, which backtracks quadratically.)
    const urls = str(rec.url).split(/\r?\n|,(?=\s*[a-z][a-z0-9+.-]*:\/\/)/i).map(str);
    const email = str(rec.email), user = str(rec.username);
    if (type === 'login' || !type) {
      pushLogin(run, {
        ...base, fav: false, username: user || email, password: rec.password, urls, totps: [rec.totp],
        extra: user && email ? [{ label: label('email'), value: email, secret: false }] : [], note: rec.note,
      });
    } else if (type === 'note') {
      run.items.push({ ...base, type: 'note', note: rec.note });
    } else {
      // The CSV carries no card / identity / … fields, only what fits the login columns.
      const kind = KINDS[type] || 'その他のアイテム';
      run.converted[kind] = (run.converted[kind] || 0) + 1;
      const pairs = [[label('url'), rec.url], [label('email'), email], [label('username'), user], [label('password'), rec.password], [label('totp'), rec.totp]];
      run.items.push({ ...base, type: 'note', note: fieldsToNote(type === 'alias' ? [[L('alias', 'エイリアス'), email], ...pairs.slice(2)] : pairs, rec.note) });
    }
  }
}

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file, ctx = {}) {
  const run = makeRun();
  if (isZip(file.bytes)) {
    const entries = readZip(file.bytes);
    const data = findEntry(entries, 'Proton Pass/data.json', 'data.json');
    let json;
    if (data) {
      json = parseJson(bytesToText(await data.bytes()), 'Proton Pass');
    } else {
      const pgp = findEntry(entries, 'Proton Pass/data.pgp', 'data.pgp');
      if (!pgp) throw new ImportError('INVALID_FORMAT', 'Proton Pass の ZIP に data.json が見つかりませんでした');
      if (!ctx.password) throw new ImportError('NEEDS_PASSWORD', 'PGP で暗号化された Proton Pass の書き出しです。パスフレーズを入力してください');
      const { decryptPgp } = await import('../../pgp.js');
      json = parseJson(bytesToText(await decryptPgp(await pgp.bytes(), ctx.password)), 'Proton Pass');
    }
    run.attachments = entries.filter((e) => e !== data && /(^|\/)files\//i.test(e.name)).length;
    fromJson(run, json);
  } else {
    const text = bytesToText(file.bytes);
    if (/^\s*\{/.test(text)) fromJson(run, parseJson(text, 'Proton Pass'));
    else fromCsv(run, text);
  }
  const warnings = Object.entries(run.converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (run.badPasskeys) warnings.push(`パスキー ${run.badPasskeys} 件は Akari が対応していない形式（P-256 以外など）のため読み込めませんでした`);
  if (run.attachments) warnings.push(`添付ファイル ${run.attachments} 件は読み込まれません`);
  if (run.badTotp) warnings.push(`読み取れない TOTP 設定 ${run.badTotp} 件はカスタムフィールドに残しました`);
  return { items: run.items, skipped: run.skipped, warnings };
}
