// Item types and their field templates. The service worker validates against this,
// importers map other managers' records onto it, exporters read it, and the popup
// builds the detail view and the editor from it.
//
// Stored item (every type): { id, type, vault, title, note, fav, hue, createdAt, updatedAt,
//   lastUsedAt, extra: [{ label, value, secret }] }
// 'login' adds url, username, password, totp, passkeys, passwordUpdatedAt.
// Every other type except 'note' adds fields: { [key]: string } for its template's keys.
//
// Field kinds:
//   text · secret (masked, copy, clipboard auto-clear) · multiline · secret-multiline ·
//   date ('YYYY-MM-DD') · month ('YYYY-MM') · email · tel · url · number (digits as text) ·
//   select (stores one of `options[].id`)
//
// Labels here are the Japanese source text. Display code must go through typeLabel /
// groupLabel / fieldLabel / optionLabel so a future UI language can override them
// (shared/i18n.js keys: type.<id>, group.<id>, field.<type>.<key>, option.<type>.<key>.<id>).

import { t } from './i18n.js';

const f = (key, label, kind = 'text', extra = {}) => Object.freeze({ key, label, kind, ...extra });
const opt = (id, label) => Object.freeze({ id, label });

export const GROUPS = Object.freeze([
  { id: 'basic', label: '基本' },
  { id: 'tech', label: 'テクノロジー' },
  { id: 'finance', label: 'ファイナンス' },
  { id: 'personal', label: '個人' },
]);

/**
 * id: stored type · label: Japanese name · tag: short mono badge for list rows (null = none) ·
 * fields: template (login/note have their own fixed fields) ·
 * dedupe: field keys that identify the same record when importing (plus title).
 */
export const ITEM_TYPES = Object.freeze([
  { id: 'login', label: 'ログイン', group: 'basic', tag: null, fields: [], dedupe: [] },
  { id: 'note', label: 'セキュアノート', group: 'basic', tag: 'NOTE', fields: [], dedupe: [] },
  {
    id: 'card', label: 'クレジットカード', group: 'basic', tag: 'CARD',
    fields: [
      f('cardholder', '名義'),
      f('number', 'カード番号', 'secret', { format: 'card' }),
      f('expiry', '有効期限', 'month'),
      f('cvv', 'セキュリティコード', 'secret'),
      f('pin', 'PIN', 'secret'),
    ],
    dedupe: ['number'],
  },
  {
    id: 'identity', label: 'ID', group: 'basic', tag: 'ID',
    fields: [
      f('fullName', '氏名'), f('lastName', '姓'), f('firstName', '名'), f('middleName', 'ミドルネーム'),
      f('email', 'メール', 'email'), f('phone', '電話', 'tel'), f('birthDate', '生年月日', 'date'),
      f('company', '会社'), f('jobTitle', '役職'),
      f('postalCode', '郵便番号'), f('country', '国'), f('state', '都道府県・州'), f('city', '市区町村'),
      f('address1', '住所 1'), f('address2', '住所 2'),
      f('website', 'ウェブサイト', 'url'),
    ],
    dedupe: ['fullName', 'lastName', 'firstName', 'email'],
  },
  {
    id: 'apiCredential', label: 'API認証情報', group: 'tech', tag: 'API',
    fields: [
      f('host', 'ホスト・URL'), f('keyId', 'キー ID'), f('secret', 'シークレット', 'secret'),
      f('expiry', '有効期限', 'date'),
    ],
    dedupe: ['host', 'keyId'],
  },
  {
    id: 'database', label: 'データベース', group: 'tech', tag: 'DB',
    fields: [
      f('dbType', '種類'), f('host', 'ホスト'), f('port', 'ポート', 'number'), f('database', 'データベース名'),
      f('username', 'ユーザー名'), f('password', 'パスワード', 'secret'),
    ],
    dedupe: ['host', 'port', 'database', 'username'],
  },
  {
    id: 'server', label: 'サーバー', group: 'tech', tag: 'SRV',
    fields: [
      f('host', 'ホスト・IP'), f('port', 'ポート', 'number'), f('username', 'ユーザー名'),
      f('password', 'パスワード', 'secret'), f('url', '管理画面', 'url'),
    ],
    dedupe: ['host', 'port', 'username'],
  },
  {
    id: 'softwareLicense', label: 'ソフトウェアライセンス', group: 'tech', tag: 'LIC',
    fields: [
      f('product', '製品名'), f('version', 'バージョン'), f('licenseKey', 'ライセンスキー', 'secret'),
      f('licensee', '登録名'), f('email', '登録メール', 'email'),
      f('purchaseDate', '購入日', 'date'), f('expiry', '有効期限', 'date'), f('url', '製品サイト', 'url'),
    ],
    dedupe: ['licenseKey'],
  },
  {
    id: 'sshKey', label: 'SSHキー', group: 'tech', tag: 'SSH',
    fields: [
      f('privateKey', '秘密鍵', 'secret-multiline'), f('publicKey', '公開鍵', 'multiline'),
      f('fingerprint', 'フィンガープリント'), f('passphrase', 'パスフレーズ', 'secret'),
      f('host', 'ホスト'), f('username', 'ユーザー名'),
    ],
    dedupe: ['fingerprint', 'publicKey'],
  },
  {
    id: 'wifi', label: 'WiFiネットワーク', group: 'tech', tag: 'WIFI',
    fields: [
      f('ssid', 'ネットワーク名'), f('password', 'パスワード', 'secret'),
      f('security', 'セキュリティ', 'select', {
        options: [opt('wpa3', 'WPA3'), opt('wpa2', 'WPA2'), opt('wpa', 'WPA'), opt('wep', 'WEP'), opt('none', 'なし')],
      }),
    ],
    dedupe: ['ssid'],
  },
  {
    id: 'bankAccount', label: '銀行口座', group: 'finance', tag: 'BANK',
    fields: [
      f('bankName', '銀行名'), f('branch', '支店'), f('accountType', '口座種別'),
      f('accountNumber', '口座番号', 'secret'), f('accountHolder', '口座名義'),
      f('routingNumber', '支店番号・ルーティング番号'), f('swift', 'SWIFT / BIC'),
      f('iban', 'IBAN', 'secret'), f('pin', '暗証番号', 'secret'),
    ],
    dedupe: ['bankName', 'accountNumber', 'iban'],
  },
  {
    id: 'cryptoWallet', label: '暗号通貨ウォレット', group: 'finance', tag: 'WLT',
    fields: [
      f('network', 'ネットワーク'), f('address', 'アドレス'),
      f('recoveryPhrase', 'リカバリーフレーズ', 'secret-multiline'), f('privateKey', '秘密鍵', 'secret'),
      f('password', 'パスワード', 'secret'),
    ],
    dedupe: ['address'],
  },
  {
    id: 'driverLicense', label: '運転免許証', group: 'personal', tag: 'DL',
    fields: [
      f('fullName', '氏名'), f('number', '免許証番号', 'secret'), f('licenseClass', '種類'),
      f('birthDate', '生年月日', 'date'), f('issuedOn', '交付日', 'date'), f('expiry', '有効期限', 'date'),
      f('issuer', '交付者'), f('address', '住所'),
    ],
    dedupe: ['number'],
  },
  {
    id: 'medicalRecord', label: '医療記録', group: 'personal', tag: 'MED',
    fields: [
      f('patientName', '患者名'), f('provider', '医療機関'), f('recordNumber', '診察券番号'), f('doctor', '担当医'), f('insurer', '保険者'),
      f('policyNumber', '保険証番号', 'secret'), f('bloodType', '血液型'),
      f('allergies', 'アレルギー', 'multiline'), f('medications', '服用中の薬', 'multiline'),
    ],
    dedupe: ['provider', 'policyNumber'],
  },
  {
    id: 'membership', label: 'メンバーシップ', group: 'personal', tag: 'MEM',
    fields: [
      f('organization', '団体名'), f('memberName', '会員名'), f('memberId', '会員番号'),
      f('since', '入会日', 'date'), f('expiry', '有効期限', 'date'), f('pin', 'PIN', 'secret'),
      f('url', 'ウェブサイト', 'url'),
    ],
    dedupe: ['organization', 'memberId'],
  },
  {
    id: 'passport', label: 'パスポート', group: 'personal', tag: 'PASS',
    fields: [
      f('fullName', '氏名'), f('number', '旅券番号', 'secret'), f('nationality', '国籍'),
      f('issuingCountry', '発行国'), f('birthDate', '生年月日', 'date'),
      f('issuedOn', '発行日', 'date'), f('expiry', '有効期限', 'date'), f('authority', '発行官庁'),
    ],
    dedupe: ['number'],
  },
  {
    id: 'rewardProgram', label: '報酬プログラム', group: 'personal', tag: 'RWD',
    fields: [
      f('company', '会社'), f('memberName', '会員名'), f('memberId', '会員番号'),
      f('expiry', '有効期限', 'date'), f('pin', 'PIN', 'secret'), f('url', 'ウェブサイト', 'url'),
    ],
    dedupe: ['company', 'memberId'],
  },
  {
    id: 'socialSecurity', label: '社会保障', group: 'personal', tag: 'SSN',
    fields: [f('fullName', '氏名'), f('number', '番号（マイナンバー・SSN など）', 'secret')],
    dedupe: ['number'],
  },
].map((t) => Object.freeze({ ...t, fields: Object.freeze(t.fields), dedupe: Object.freeze(t.dedupe) })));

export const TYPE_IDS = Object.freeze(ITEM_TYPES.map((t) => t.id));
const BY_ID = new Map(ITEM_TYPES.map((t) => [t.id, t]));

export const typeOf = (id) => BY_ID.get(id) || null;

// Display labels — always use these instead of `.label` so the UI language can change.
export const typeLabel = (id) => t('type.' + id, null, BY_ID.get(id)?.label ?? id);
export const groupLabel = (id) => t('group.' + id, null, GROUPS.find((g) => g.id === id)?.label ?? id);
export function fieldLabel(typeId, key) {
  const fd = BY_ID.get(typeId)?.fields.find((x) => x.key === key);
  return t(`field.${typeId}.${key}`, null, fd?.label ?? key);
}
export function optionLabel(typeId, key, optionId) {
  const o = BY_ID.get(typeId)?.fields.find((x) => x.key === key)?.options?.find((x) => x.id === optionId);
  return t(`option.${typeId}.${key}.${optionId}`, null, o?.label ?? optionId);
}
/** Types whose data lives in `fields` (everything except login and note). */
export const hasTemplate = (id) => !!BY_ID.get(id)?.fields.length;
export const isSecretKind = (kind) => kind === 'secret' || kind === 'secret-multiline';

/** Length caps, also enforced by the service worker. */
export const LIMITS = Object.freeze({
  fieldValue: 4096,
  multilineValue: 16384,
  extraCount: 100,
  extraLabel: 200,
  extraValue: 16384,
});

const digits = (s) => String(s || '').replace(/\D/g, '');

export function cardBrand(number) {
  const n = digits(number);
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^35(2[89]|[3-8]\d)/.test(n)) return 'JCB';
  if (/^3(0[0-5]|[689])/.test(n)) return 'Diners Club';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  if (/^62/.test(n)) return 'UnionPay';
  return '';
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** A name from its parts: family name first for CJK names ("田中 三郎"), otherwise "John Q Smith". */
export function personName(first, middle, last) {
  const [f, m, l] = [first, middle, last].map((s) => String(s ?? '').trim());
  return (CJK.test(f + m + l) ? [l, f, m] : [f, m, l]).filter(Boolean).join(' ');
}

/** "•••• 1234" — never more than the last four digits. */
export const maskTail = (v) => {
  const s = String(v || '').replace(/\s/g, '');
  return s ? '•••• ' + s.slice(-4) : '';
};

/** One-line, non-secret summary for list rows and search. */
export function subtitleOf(item) {
  const x = item.fields || {};
  const join = (...v) => v.filter(Boolean).join(' · ');
  switch (item.type) {
    case 'login': return item.username || '';
    case 'note': return ''; // note bodies often hold secrets; the list shows the type label instead
    case 'card': return join(cardBrand(x.number), maskTail(x.number), x.expiry && x.expiry.slice(5) + '/' + x.expiry.slice(2, 4));
    case 'identity': return join(x.fullName || personName(x.firstName, x.middleName, x.lastName), x.email);
    case 'apiCredential': return join(x.host, x.keyId);
    case 'database': return join(x.dbType, x.host && (x.port ? `${x.host}:${x.port}` : x.host), x.database);
    case 'server': return join(x.host && (x.port ? `${x.host}:${x.port}` : x.host), x.username);
    case 'softwareLicense': return join(x.product, x.version, x.licensee);
    case 'sshKey': return join(x.fingerprint, x.host);
    case 'wifi': return join(x.ssid, x.security && optionLabel('wifi', 'security', x.security));
    case 'bankAccount': return join(x.bankName, maskTail(x.accountNumber || x.iban));
    case 'cryptoWallet': return join(x.network, x.address && x.address.slice(0, 6) + '…' + x.address.slice(-4));
    case 'driverLicense': case 'passport': return join(x.fullName, maskTail(x.number));
    case 'socialSecurity': return x.fullName || ''; // no digits of a national ID in the list or search
    case 'medicalRecord': return join(x.patientName, x.provider);
    case 'membership': return join(x.organization, x.memberName);
    case 'rewardProgram': return join(x.company, x.memberName);
    default: return '';
  }
}

/** Non-secret text that search should match (title is searched separately). */
export function searchTextOf(item) {
  const t = typeOf(item.type);
  const parts = [subtitleOf(item)];
  if (item.type === 'login') parts.push(item.url || '');
  for (const fd of t?.fields || []) {
    if (!isSecretKind(fd.kind)) parts.push(item.fields?.[fd.key] || '');
  }
  for (const e of item.extra || []) if (!e.secret) parts.push(e.label, e.value);
  return parts.filter(Boolean).join('\n');
}
