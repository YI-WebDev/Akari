// Enpass JSON export: { folders: [...], items: [{ title, note, category, template_type, favorite,
// trashed, archived, createdAt, updated_at, fields: [{ uid, label, type, value, sensitive,
// deleted }], attachments }] }. Folders are ignored.
// Categories / templates with an Akari type are mapped by field type (ccNumber, username, …),
// the identity template's field uids and, for the rest, the (possibly translated) labels.

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson } from '../model.js';
import { L, fromEntries, LABEL_RULES } from './_fields.js';

/** Enpass category → Japanese name of a kind kept as a secure note (no matching Akari type). */
const KINDS = {
  creditcard: 'クレジットカード', identity: '個人情報', finance: '金融情報', license: 'ライセンス',
  travel: '旅行', computer: 'コンピューター', misc: 'その他', document: 'ドキュメント',
};

/** template_type (e.g. "travel.passport", "computer.wifi") → Akari type. */
const TEMPLATES = [
  [/wi-?fi|wireless|router/, 'wifi'], [/database/, 'database'], [/ssh/, 'sshKey'], [/server|hosting/, 'server'],
  [/\bapi|apikey|apicredential/, 'apiCredential'], [/passport/, 'passport'], [/driv/, 'driverLicense'],
  [/software/, 'softwareLicense'], [/bank/, 'bankAccount'], [/crypto|bitcoin|wallet/, 'cryptoWallet'],
  [/member/, 'membership'], [/reward|loyalty|frequent|mileage/, 'rewardProgram'], [/medical|health/, 'medicalRecord'],
  [/ssn|socialsecurity|social_security/, 'socialSecurity'],
];

const uid = (n) => `uid:${n}`;
/** Template key ← Enpass field type / identity field uid, before the label rules. */
const RULES = {
  card: [['cardholder', 'ccName'], ['number', 'ccNumber'], ['expiry', 'ccExpiry'], ['cvv', 'ccCvc'], ['pin', 'ccPin']],
  identity: [
    ['firstName', uid(130)], ['middleName', uid(131)], ['lastName', uid(132)], ['birthDate', uid(134)],
    ['address1', uid(143)], ['city', uid(144)], ['state', uid(145)], ['country', uid(146)], ['postalCode', uid(147)],
    ['phone', uid(149), uid(151), uid(140), 'phone'], ['company', uid(137)], ['jobTitle', uid(139)],
    ['website', uid(163), 'url'], ['email', uid(165), 'email'],
  ],
  bankAccount: [['bankName', 'ccBankname'], ['accountHolder', 'ccName'], ['pin', 'pin']],
  wifi: [['password', 'password']],
  database: [['username', 'username'], ['password', 'password']],
  server: [['username', 'username'], ['password', 'password'], ['url', 'url']],
  sshKey: [['username', 'username'], ['passphrase', 'password']],
  softwareLicense: [['email', 'email'], ['url', 'url']],
  membership: [['pin', 'pin'], ['url', 'url']],
  rewardProgram: [['pin', 'pin'], ['url', 'url']],
};
const SECRET_TYPES = new Set(['password', 'totp', 'pin', 'ccNumber', 'ccCvc', 'ccPin', 'ccTxnpassword']);

const str = (v) => (v == null ? '' : String(v).trim());
const flag = (v) => v === true || Number(v) === 1;

function typeOfItem(category, template) {
  if (category === 'creditcard') return 'card';
  if (category === 'identity') return 'identity';
  const tt = template.toLowerCase();
  return TEMPLATES.find(([re]) => re.test(tt))?.[1] || null;
}

const toEntry = (f) => ({
  id: [f.type, uid(f.uid)],
  label: str(f.label) || f.type,
  value: String(f.value),
  secret: flag(f.sensitive) || SECRET_TYPES.has(f.type),
});
const toExtra = (e) => ({ label: e.label, value: e.value, secret: e.secret });

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file) {
  const json = parseJson(bytesToText(file.bytes), 'Enpass');
  if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
    throw new ImportError('INVALID_FORMAT', 'Enpass の書き出しファイル（JSON）ではありません');
  }
  const items = [];
  const converted = {};
  let skipped = 0, attachments = 0, badTotp = 0;

  for (const it of json.items) {
    if (!it || typeof it !== 'object' || flag(it.trashed)) { skipped++; continue; }
    if (Array.isArray(it.attachments)) attachments += it.attachments.length;
    const fields = (Array.isArray(it.fields) ? it.fields : [])
      .filter((f) => f && !flag(f.deleted) && f.type !== 'section' && str(f.value));
    const base = {
      title: it.title,
      fav: flag(it.favorite),
      createdAt: toMs(it.createdAt ?? it.created_at),
      updatedAt: toMs(it.updated_at ?? it.updatedAt),
    };
    const category = str(it.category).toLowerCase();

    if (category === 'login' || category === 'password') {
      const take = (type) => {
        const i = fields.findIndex((f) => f.type === type);
        return i < 0 ? null : fields.splice(i, 1)[0].value;
      };
      const username = take('username') ?? take('email') ?? '';
      const password = take('password') ?? '';
      const url = take('url') ?? '';
      let totp = null;
      const otpRaw = take('totp');
      const extra = [];
      if (otpRaw) {
        totp = parseOtp(otpRaw, username || it.title);
        if (!totp) { badTotp++; extra.push({ label: L('otp', 'ワンタイムパスワード'), value: otpRaw, secret: true }); }
      }
      items.push({
        ...base, type: 'login', url, username, password, totp, note: it.note,
        extra: [...extra, ...fields.map(toEntry).map(toExtra)],
      });
      continue;
    }
    if (category === 'note') {
      items.push({ ...base, type: 'note', note: it.note, extra: fields.map(toEntry).map(toExtra) });
      continue;
    }
    const type = typeOfItem(category, str(it.template_type));
    if (type) {
      const entries = fields.map(toEntry);
      const brand = type === 'card' ? entries.findIndex((e) => e.id[0] === 'ccType') : -1;
      const [cardType] = brand >= 0 ? entries.splice(brand, 1) : [];
      const b = fromEntries(type, entries, [...(RULES[type] || []), ...LABEL_RULES[type]]);
      if (cardType) b.brand(cardType.value, cardType.label);
      items.push({ ...base, ...b.item({ note: it.note }) });
      continue;
    }
    const kind = KINDS[category] || 'その他';
    converted[kind] = (converted[kind] || 0) + 1;
    items.push({ ...base, type: 'note', note: fieldsToNote(fields.map((f) => [str(f.label) || f.type, f.value]), it.note) });
  }

  const warnings = Object.entries(converted).map(([k, n]) => `${k} ${n} 件をセキュアノートとして読み込みました`);
  if (attachments) warnings.push(`添付ファイル ${attachments} 件は読み込まれません`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はカスタムフィールドに残しました`);
  return { items, skipped, warnings };
}
