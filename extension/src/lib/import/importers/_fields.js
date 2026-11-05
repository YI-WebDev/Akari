// Internal helpers shared by the structured importers (1Password, Bitwarden, Dashlane, Enpass,
// Keeper, Proton Pass, KeePass): a small builder that fills a typed item's template fields
// (dates, months and the Wi-Fi security option via _values.js) and keeps everything else as
// `extra`. Not an importer itself.

import { t } from '../../../shared/i18n.js';
import { typeOf, fieldLabel, optionLabel, isSecretKind, cardBrand } from '../../../shared/item-types.js';
import { toDate, toMonth, wifiSecurity } from './_values.js';

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v == null ? '' : String(v).trim());

/** A label Akari gives a value itself (as opposed to one read from the file). */
export const L = (key, ja, params = null) => t('import.label.' + key, params, ja);

/** A month-only value stored in a date field: expiry → last day of the month, else the 1st. */
function monthToDate(v, key) {
  const m = toMonth(v);
  if (!m) return '';
  const [y, mo] = m.split('-').map(Number);
  const day = key === 'expiry' ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 1;
  return `${m}-${pad(day)}`;
}

// Field names that usually hold a secret (custom fields with no "hidden" flag of their own).
const SECRET_NAME = /(^|[^a-z])(pins?|pin ?code|passwords?|passcode|passphrase|secrets?|private ?key|api ?key|keys?|tokens?|cvv2?|cvc|otp|totp|seed|mnemonic)([^a-z]|$)|暗証|パスワード|パスコード|パスフレーズ|秘密|シークレット|キー|鍵|トークン|セキュリティコード|シード|リカバリー|合言葉/i;
export const looksSecret = (name) => SECRET_NAME.test(str(name)) && !/public|公開/i.test(str(name));

/** An http(s) URL, or a bare host name with a dot ("example.jp/login"); nothing else is a link. */
const isUrlLike = (v) => /^https?:\/\/[^\s/?#]+\S*$/i.test(v)
  || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#]\S*)?$/i.test(v);

// --- typed item builder --------------------------------------------------------------------

/**
 * Builder for one item of `type`. put(key, value) fills the template key when it is free
 * (converting dates, months, the Wi-Fi security option and port numbers); anything that does
 * not fit — unknown key, key already filled, value not convertible — goes to `extra` with the
 * given label (default: the template field's label), so nothing is lost.
 */
export function typed(type) {
  const tpl = new Map((typeOf(type)?.fields || []).map((fd) => [fd.key, fd]));
  const fields = {};
  const extra = [];
  const add = (label, value, secret = false) => {
    if (value == null || typeof value === 'object') return;
    const v = String(value);
    if (v.trim()) extra.push({ label: str(label) || L('field', '項目'), value: v, secret: !!secret });
  };
  const put = (key, value, label, secret) => {
    if (value == null || typeof value === 'object' || !String(value).trim()) return;
    const raw = String(value);
    const fd = tpl.get(key);
    const lab = label || (fd ? fieldLabel(type, key) : key);
    const sec = secret ?? (fd ? isSecretKind(fd.kind) : false);
    if (!fd) return add(lab, raw, sec);
    let v = isSecretKind(fd.kind) ? raw : raw.trim();
    if (fd.kind === 'date') v = toDate(v) || monthToDate(v, key);
    else if (fd.kind === 'month') v = toMonth(v);
    else if (fd.kind === 'select') {
      // An option id, an option label (Akari's own exports write labels), or Wi-Fi security text.
      v = fd.options.find((o) => o.id === v || o.label === v || optionLabel(type, key, o.id) === v)?.id ?? wifiSecurity(v);
    } else if (fd.kind === 'number') v = /^\d{1,10}$/.test(v) ? v : '';
    else if (fd.kind === 'url') v = isUrlLike(v) ? v : ''; // a URL field becomes a link: never a stray word
    if (Object.hasOwn(fields, key)) {
      if (fields[key] !== v || !v) add(lab, raw, sec); // a second, different value is kept too
      return;
    }
    if (v) fields[key] = v;
    else add(lab, raw, sec);
  };
  return {
    type, fields, extra, put, add,
    has: (key) => Object.hasOwn(fields, key),
    /** Card brand: kept only when Akari cannot tell it from the number. */
    brand(value, label) {
      if (str(value) && !cardBrand(fields.number)) add(label || L('cardBrand', 'ブランド'), value);
    },
    item: (p = {}) => ({ ...p, type, fields, extra: [...extra, ...(p.extra || [])] }),
  };
}

/**
 * Fill a typed item from `entries` ([{ id, label, value, secret }]; `id` may be an array of
 * ids). `rules` is [[templateKey, ...matchers]]: a string matches an entry id exactly, a RegExp
 * is tested on the label. For each key, matchers are tried in order and the first unused entry
 * with a value wins. Entries no rule took become extra fields (label, secret flag kept).
 * A value the source marks secret only goes to a non-secret field when the source's own id
 * says it belongs there — a label guess never unmasks it (it stays a secret extra field).
 */
export function fromEntries(type, entries, rules) {
  const b = typed(type);
  const used = new Set();
  const hasId = (e, m) => (Array.isArray(e.id) ? e.id.includes(m) : e.id === m);
  const tpl = new Map((typeOf(type)?.fields || []).map((fd) => [fd.key, fd]));
  for (const [key, ...matchers] of rules) {
    if (b.has(key)) continue;
    const openField = !isSecretKind(tpl.get(key)?.kind);
    for (const m of matchers) {
      const i = entries.findIndex((e, j) => !used.has(j) && str(e.value)
        && (typeof m === 'string' ? hasId(e, m) : m.test(str(e.label)) && !(e.secret && openField)));
      if (i < 0) continue;
      used.add(i);
      b.put(key, entries[i].value, entries[i].label, entries[i].secret || undefined);
      break;
    }
  }
  entries.forEach((e, j) => { if (!used.has(j)) b.add(e.label, e.value, e.secret); });
  return b;
}

/**
 * Field-name patterns (English and Japanese) for each typed template, used where a format has
 * no stable field ids (Enpass, Keeper labels, Proton Pass custom items) and as a fallback.
 */
const R = (...parts) => new RegExp(parts.join('|'), 'i');
export const LABEL_RULES = {
  card: [
    ['cardholder', R('holder', 'name on card', '名義')],
    ['number', R('card ?(number|no)', '^number$', 'カード番号', '^番号$')],
    ['expiry', R('expir', 'exp\\.? ?date', 'valid (thru|until|to)', '有効期限')],
    ['cvv', R('cvv', 'cvc', '^cid$', 'security code', 'verification', 'セキュリティコード')],
    ['pin', R('^pin', '暗証')],
  ],
  identity: [
    ['fullName', R('full ?name', '氏名', 'フルネーム')],
    ['lastName', R('last ?name', 'surname', 'family name', '^姓$', '名字', '苗字')],
    ['firstName', R('first ?name', 'given name', '^名$')],
    ['middleName', R('middle ?name', '^initial$', 'ミドルネーム')],
    ['email', R('e-?mail', 'メール')],
    ['phone', R('phone', 'mobile', '^cell', '^tel', '電話', '携帯')],
    ['birthDate', R('birth ?(date|day)', 'date of birth', '^dob$', '生年月日', '誕生日')],
    ['company', R('company', 'organi[sz]ation', 'employer', '会社', '組織', '勤務先')],
    ['jobTitle', R('job ?title', 'position', 'occupation', '役職', '職業', '肩書')],
    ['postalCode', R('zip', 'postal', 'post ?code', '郵便番号')],
    ['country', R('country', '^国')],
    ['state', R('^state', 'province', 'prefecture', '都道府県', '州')],
    ['city', R('city', 'town', '市区町村', '市町村')],
    ['address2', R('address ?2', 'address line 2', '住所 ?2', '建物')],
    ['address1', R('street', '^address', '^住所')],
    ['website', R('web ?site', '^url$', 'homepage', 'ウェブサイト', 'ホームページ')],
  ],
  apiCredential: [
    ['host', R('host', '^url$', 'endpoint', 'server', 'ホスト', 'エンドポイント')],
    ['secret', R('secret', 'credential', 'token', 'シークレット', '秘密', 'トークン'), R('api ?key', 'apiキー')],
    ['keyId', R('key ?id', 'access ?key ?id', 'client ?id', 'user', 'キー ?id', 'ユーザー')],
    ['expiry', R('expir', '有効期限')],
  ],
  database: [
    ['dbType', R('type', 'kind', '種類', '種別')],
    ['host', R('host', 'server', 'ホスト', 'サーバー')],
    ['port', R('port', 'ポート')],
    ['database', R('^database$', 'database name', 'db ?name', '^db$', '^sid$', 'データベース名', '^データベース$')],
    ['username', R('user', 'login', 'ユーザー')],
    ['password', R('password', 'パスワード')],
  ],
  server: [
    ['host', R('host', 'server', '^ip', 'ip address', '^address', 'ホスト', 'サーバー', 'ipアドレス')],
    ['port', R('port', 'ポート')],
    ['username', R('user', 'login', 'ユーザー')],
    ['password', R('password', 'パスワード')],
    ['url', R('\\burl\\b', '^管理画面( ?の? ?url)?$')], // "Admin console URL", not "Admin console password"
  ],
  softwareLicense: [
    ['product', R('^product( name)?$', '製品名', '^製品$')],
    ['version', R('version', 'バージョン')],
    ['licenseKey', R('licen[cs]e ?(key|code|number)', 'serial', 'product key', 'reg(istration)? ?code', 'ライセンスキー', 'シリアル', 'プロダクトキー')],
    ['licensee', R('licen[cs]ed to', 'licensee', 'registered (to|name)', 'owner', '登録名', '所有者', '使用者')],
    ['email', R('e-?mail', 'メール')],
    ['purchaseDate', R('purchase', 'order date', '購入日')],
    ['expiry', R('expir', '有効期限')],
    ['url', R('web ?site', 'url', 'download', '製品サイト', 'ウェブサイト')],
  ],
  sshKey: [
    ['privateKey', R('private', '秘密鍵')],
    ['publicKey', R('public', '公開鍵')],
    ['fingerprint', R('fingerprint', 'フィンガープリント')],
    ['passphrase', R('passphrase', 'password', 'パスフレーズ', 'パスワード')],
    ['host', R('host', 'server', 'ホスト', 'サーバー')],
    ['username', R('user', 'login', 'ユーザー')],
  ],
  wifi: [
    ['ssid', R('ssid', 'network ?name', 'wi-?fi name', 'ネットワーク名')],
    ['password', R('password', 'passphrase', '^key$', 'network key', 'パスワード')],
    ['security', R('security', 'encryption', 'セキュリティ', '暗号化')],
  ],
  bankAccount: [
    ['bankName', R('bank ?name', '^bank$', 'institution', '銀行名', '金融機関')],
    ['branch', R('branch name', '^branch$', '支店名', '^支店$')],
    ['accountType', R('account type', '^type$', '口座種別', '口座の種類', '預金種目')],
    ['accountNumber', R('account (number|no)', '^account$', '口座番号')],
    ['accountHolder', R('holder', 'owner', 'name on account', 'account name', '名義')],
    ['routingNumber', R('routing', 'sort code', '^aba', 'transit', 'bsb', '支店番号'), R('branch (code|number)', 'ifsc', '支店コード', '店番')],
    ['swift', R('swift', 'bic')],
    ['iban', R('iban')],
    ['pin', R('^pin', '暗証')],
  ],
  cryptoWallet: [
    ['recoveryPhrase', R('recovery', 'seed', 'mnemonic', 'phrase', 'リカバリー', 'シード')],
    ['privateKey', R('private', '秘密鍵')],
    ['address', R('address', 'アドレス')],
    ['network', R('network', 'chain', 'coin', 'currency', 'ネットワーク', '通貨')],
    ['password', R('password', 'パスワード')],
  ],
  driverLicense: [
    ['fullName', R('full ?name', '^name$', 'holder', '氏名', '名前', 'フルネーム')],
    ['number', R('licen[cs]e (number|no)', '^number$', '^no\\.?$', '免許証番号', '^番号$')],
    ['licenseClass', R('class', 'category', '種類', 'クラス', '区分')],
    ['birthDate', R('birth ?date', 'date of birth', '生年月日')],
    ['issuedOn', R('issued? ?(on|date)', 'date issued', 'date of issue', '交付日', '発行日')],
    ['expiry', R('expir', 'valid (thru|until)', '有効期限')],
    ['issuer', R('authority', 'issuer', 'issuing', '^state', '交付者', '発行者', '公安委員会', '発行州')],
    ['address', R('address', '住所')],
  ],
  medicalRecord: [
    ['patientName', R('patient', 'insured', '患者', '被保険者')],
    ['recordNumber', R('record (number|no)', 'chart (number|no)', '診察券', 'カルテ')],
    ['provider', R('provider', 'hospital', 'clinic', 'facility', '医療機関', '病院', 'クリニック')],
    ['doctor', R('doctor', 'physician', 'healthcare professional', '医者', '医師', '担当医')],
    ['insurer', R('insurer', 'insurance (company|provider)', '保険者', '保険会社')],
    ['policyNumber', R('policy', 'insurance (number|no)', '保険証番号', '保険番号')],
    ['bloodType', R('blood', '血液型')],
    ['allergies', R('allerg', 'アレルギー')],
    ['medications', R('medication', 'medicine', '薬')],
  ],
  membership: [
    ['organization', R('organi[sz]ation', 'group', 'club', 'company', '団体', '組織')],
    ['memberName', R('member name', '^name$', '会員名', 'メンバー名', '氏名')],
    ['memberId', R('member(ship)? ?(id|number|no)', '^id$', '会員番号', 'メンバーシップ ?id', 'メンバー ?id')],
    ['since', R('since', 'joined', '入会')],
    ['expiry', R('expir', '有効期限')],
    ['pin', R('^pin', '暗証')],
    ['url', R('web ?site', '^url$', 'ウェブサイト')],
  ],
  passport: [
    ['fullName', R('full ?name', '^name$', '氏名', '名前', 'フルネーム')],
    ['number', R('passport (number|no)', '^number$', '^no\\.?$', '旅券番号', 'パスポート番号', '^番号$')],
    ['nationality', R('nationality', '国籍')],
    ['issuingCountry', R('issuing country', '^country$', '発行国', '^国$')],
    ['birthDate', R('birth ?date', 'date of birth', '生年月日')],
    ['issuedOn', R('issued? ?(on|date)', 'date of issue', '発行日', '交付日')],
    ['expiry', R('expir', '有効期限')],
    ['authority', R('authority', 'issued (by|at)', '発行官庁', '発行機関')],
  ],
  rewardProgram: [
    ['company', R('company', 'program', 'airline', '会社', 'プログラム名')],
    ['memberName', R('member name', '^name$', '会員名', 'メンバー名')],
    ['memberId', R('member(ship)? ?(id|number|no)', 'account (number|no)', '会員番号', 'メンバー ?id')],
    ['expiry', R('expir', '有効期限')],
    ['pin', R('^pin', '暗証')],
    ['url', R('web ?site', '^url$', 'ウェブサイト')],
  ],
  socialSecurity: [
    ['fullName', R('full ?name', '^name$', '氏名', '名前', 'フルネーム')],
    ['number', R('ssn', 'social security', 'number', '番号', 'マイナンバー')],
  ],
};

