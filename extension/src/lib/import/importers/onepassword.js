// 1Password exports:
//  - .1pux: ZIP with export.data (JSON accounts[].vaults[].items[]) and files/ (attachments).
//  - .1pif: JSON records separated by "***5642bee8-a5ff-11dc-8314-0800200c9a66***" lines.
//  - .zip: treated as 1pux when it holds export.data (or as 1pif when it holds a .1pif file).
// Categories with an Akari type are mapped onto it by 1Password's stable field ids; fields that
// fit no template key (and custom fields of logins) become extra fields.

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { readZip, findEntry } from '../zip.js';
import { hasTemplate, fieldLabel } from '../../../shared/item-types.js';
import { L, fromEntries, LABEL_RULES } from './_fields.js';
import { toDate, toMonth, monthOf } from './_values.js';

const LOGIN = 'login', PASSWORD = 'password', NOTE = 'note';

/** 1pux categoryUuid → Akari type id, or the Japanese name of a kind that is kept as a note (translated when reported). */
const CATEGORIES = {
  '001': LOGIN, '002': 'card', '003': NOTE, '004': 'identity', '005': PASSWORD,
  '006': 'ドキュメント', '100': 'softwareLicense', '101': 'bankAccount', '102': 'database',
  '103': 'driverLicense', '104': '狩猟・釣りのライセンス', '105': 'membership', '106': 'passport',
  '107': 'rewardProgram', '108': 'socialSecurity', '109': 'wifi', '110': 'server',
  '111': 'メールアカウント', '112': 'apiCredential', '113': 'medicalRecord', '114': 'sshKey', '115': 'cryptoWallet',
};

/** 1pif typeName → same as above. system.* records (folders, tombstones) are not items. */
const TYPE_NAMES = {
  'webforms.WebForm': LOGIN, 'passwords.Password': PASSWORD, 'securenotes.SecureNote': NOTE,
  'wallet.financial.CreditCard': 'card', 'wallet.financial.BankAccountUS': 'bankAccount',
  'wallet.computer.License': 'softwareLicense', 'wallet.computer.Router': 'wifi',
  'wallet.computer.Database': 'database', 'wallet.computer.UnixServer': 'server',
  'wallet.government.Passport': 'passport', 'wallet.government.DriversLicense': 'driverLicense',
  'wallet.government.HuntingLicense': '狩猟・釣りのライセンス', 'wallet.government.SsnUS': 'socialSecurity',
  'wallet.membership.Membership': 'membership', 'wallet.membership.RewardProgram': 'rewardProgram',
  'wallet.onlineservices.Email.v2': 'メールアカウント', 'identities.Identity': 'identity',
};

/** Template key ← 1Password field ids (first one with a value wins). */
const RULES = {
  card: [['cardholder', 'cardholder'], ['number', 'ccnum'], ['expiry', 'expiry'], ['cvv', 'cvv'], ['pin', 'pin']],
  identity: [
    ['firstName', 'firstname'], ['middleName', 'initial'], ['lastName', 'lastname'], ['birthDate', 'birthdate'],
    ['company', 'company'], ['jobTitle', 'jobtitle'], ['email', 'email'],
    ['phone', 'defphone', 'cellphone', 'homephone', 'busphone'], ['website', 'website'],
    ['address1', 'address.street'], ['city', 'address.city'], ['state', 'address.state'],
    ['postalCode', 'address.zip'], ['country', 'address.country'],
  ],
  bankAccount: [
    ['bankName', 'bankName'], ['accountHolder', 'owner'], ['accountType', 'accountType'], ['routingNumber', 'routingNo'],
    ['accountNumber', 'accountNo'], ['swift', 'swift'], ['iban', 'iban'], ['pin', 'telephonePin'],
  ],
  database: [
    ['dbType', 'database_type'], ['host', 'hostname'], ['port', 'port'], ['database', 'database'],
    ['username', 'username'], ['password', 'password'],
  ],
  driverLicense: [
    ['fullName', 'fullname'], ['number', 'number'], ['licenseClass', 'class'], ['birthDate', 'birthdate'],
    ['expiry', 'expiry_date'], ['issuer', 'state', 'country'], ['address', 'address'],
  ],
  membership: [
    ['organization', 'org_name'], ['memberName', 'member_name'], ['memberId', 'membership_no'],
    ['since', 'member_since'], ['expiry', 'expiry_date'], ['pin', 'pin'], ['url', 'website'],
  ],
  passport: [
    ['fullName', 'fullname'], ['number', 'number'], ['nationality', 'nationality'], ['issuingCountry', 'issuing_country'],
    ['birthDate', 'birthdate'], ['issuedOn', 'issue_date'], ['expiry', 'expiry_date'], ['authority', 'issuing_authority'],
  ],
  rewardProgram: [
    ['company', 'company_name'], ['memberName', 'member_name'], ['memberId', 'membership_no'], ['pin', 'pin'], ['url', 'website'],
  ],
  socialSecurity: [['fullName', 'name'], ['number', 'number']],
  wifi: [['ssid', 'network_name'], ['password', 'wireless_password'], ['security', 'wireless_security']],
  server: [['host', 'url'], ['username', 'username'], ['password', 'password'], ['url', 'admin_console_url']],
  apiCredential: [['host', 'hostname'], ['keyId', 'username'], ['secret', 'credential'], ['expiry', 'expires']],
  medicalRecord: [['patientName', 'patient'], ['provider', 'location'], ['doctor', 'healthcareprofessional'], ['medications', 'medication']],
  sshKey: [
    ['privateKey', 'private_key'], ['publicKey', 'public_key'], ['fingerprint', 'fingerprint'],
    ...LABEL_RULES.sshKey.filter(([k]) => ['passphrase', 'host', 'username'].includes(k)),
  ],
  softwareLicense: [
    ['version', 'product_version'], ['licenseKey', 'reg_code'], ['licensee', 'reg_name'], ['email', 'reg_email'],
    ['purchaseDate', 'order_date'], ['url', 'download_link', 'publisher_website'],
  ],
  cryptoWallet: LABEL_RULES.cryptoWallet, // no published field ids; matched by label
};

// Login form fields that carry no data worth keeping (buttons, checkboxes, radios, selects…).
const FORM_NOISE = new Set(['B', 'C', 'I', 'R', 'S']);
const PIF_SEPARATOR = /^\*{3}[0-9a-f-]+\*{3}[ \t]*$/im;

const str = (v) => (v == null ? '' : String(v).trim());
const scalars = (o) => Object.values(o).filter((v) => v != null && typeof v !== 'object').join(' ');
const ADDRESS_PARTS = [['street', 'address1'], ['city', 'city'], ['state', 'state'], ['zip', 'postalCode'], ['country', 'country']];

/** A 1Password address object → one entry (joined), or one entry per part for identities. */
function addressEntries(id, label, a, split) {
  if (!a || typeof a !== 'object') return [{ id, label, value: str(a) }];
  if (!split) return [{ id, label, value: ADDRESS_PARTS.map(([k]) => str(a[k])).filter(Boolean).join(', ') }];
  return ADDRESS_PARTS.map(([k, key]) => ({ id: `${id}.${k}`, label: fieldLabel('identity', key), value: str(a[k]) }));
}

/** Shared state for one parse run. */
function makeRun() {
  return { items: [], skipped: 0, converted: {}, attachments: 0, badTotp: 0 };
}

const otpExtra = (t) => ({ label: t.label || L('otp', 'ワンタイムパスワード'), value: t.value, secret: true });
const toExtra = (e) => ({ label: e.label, value: e.value, secret: !!e.secret });

/**
 * Build the ImportedItem for any 1Password item once its parts are normalised.
 * `entries` are [{ id, label, value, secret }] that are not username/password/url/totp;
 * `totps` are [{ label, value }].
 */
function emit(run, kind, p) {
  const { title, username, password, totps, entries, notes, tags, fav, createdAt, updatedAt } = p;
  const urls = [...new Set(p.urls.map(str).filter(Boolean))];
  const urlExtra = (list) => list.map((u) => ({ label: L('url', 'URL'), value: u, secret: false }));
  const tagExtra = tags.length ? [{ label: L('tags', 'タグ'), value: tags.join(', '), secret: false }] : [];
  const base = { title, fav, createdAt, updatedAt };
  if (kind === LOGIN || kind === PASSWORD) {
    let totp = null;
    const extraOtp = [];
    for (const t of totps) {
      const cfg = !totp && parseOtp(t.value, username || title);
      if (cfg) totp = cfg;
      else {
        if (!parseOtp(t.value)) run.badTotp++;
        extraOtp.push(otpExtra(t));
      }
    }
    run.items.push({
      ...base, type: 'login', url: urls[0] || '', username, password, totp, note: str(notes),
      extra: [...urlExtra(urls.slice(1)), ...extraOtp, ...entries.map(toExtra), ...tagExtra],
    });
    return;
  }
  const creds = [
    { id: 'username', label: L('username', 'ユーザー名'), value: username },
    { id: 'password', label: L('password', 'パスワード'), value: password, secret: true },
  ];
  if (kind === NOTE) {
    run.items.push({
      ...base, type: 'note', note: str(notes),
      extra: [...creds, ...entries].map(toExtra).concat(urlExtra(urls), totps.map(otpExtra), tagExtra),
    });
    return;
  }
  if (hasTemplate(kind)) {
    const list = [...entries, ...creds];
    const take = (id) => {
      const i = list.findIndex((e) => e.id === id);
      return i < 0 ? null : list.splice(i, 1)[0];
    };
    // Cards: the brand only matters when the number does not tell it; 1pif also keeps the
    // expiry as flat expiry_mm / expiry_yy keys.
    const brand = kind === 'card' ? take('type') || take('cctype') : null;
    let flatExpiry = '';
    if (kind === 'card') {
      const mm = take('expiry_mm'), yy = take('expiry_yy');
      flatExpiry = monthOf(mm?.value, yy?.value);
      if (!flatExpiry) list.push(...[mm, yy].filter(Boolean));
    }
    const b = fromEntries(kind, list, RULES[kind] || []);
    b.put('expiry', flatExpiry);
    if (brand) b.brand(brand.value, brand.label);
    const urlKey = ['url', 'website'].find((k) => RULES[kind]?.some(([key]) => key === k));
    if (urlKey && urls.length && !b.has(urlKey)) b.put(urlKey, urls.shift());
    run.items.push({ ...base, ...b.item({ note: str(notes), extra: [...urlExtra(urls), ...totps.map(otpExtra), ...tagExtra] }) });
    return;
  }
  run.converted[kind] = (run.converted[kind] || 0) + 1;
  run.items.push({
    ...base, type: 'note',
    note: fieldsToNote([
      ...creds.map((e) => [e.label, e.value]), ...urls.map((u) => [L('url', 'URL'), u]),
      ...totps.map((t) => [t.label || L('otp', 'ワンタイムパスワード'), t.value]),
      ...entries.map((e) => [e.label, e.value]), ...tagExtra.map((e) => [e.label, e.value]),
    ], notes),
  });
}

function finish(run) {
  const warnings = Object.entries(run.converted).map(([k, n]) => t('{kind} {n} 件をセキュアノートとして読み込みました', { kind: t(k), n }));
  if (run.attachments) warnings.push(t('添付ファイル・ドキュメントの中身 {n} 件は読み込まれません', { n: run.attachments }));
  if (run.badTotp) warnings.push(t('読み取れない TOTP 設定 {n} 件はカスタムフィールドに残しました', { n: run.badTotp }));
  return { items: run.items, skipped: run.skipped, warnings };
}

// --- 1pux ----------------------------------------------------------------------------------

/** One 1pux section field → entries (value kinds: string, concealed, email, date, monthYear…). */
function puxFieldEntries(f, run, splitAddress) {
  const id = str(f.id);
  const label = str(f.title) || id || L('field', '項目');
  const value = f.value && typeof f.value === 'object' ? f.value : {};
  const [kind, x] = Object.entries(value)[0] || [];
  if (x == null || x === '') return [];
  const one = (v, secret = false) => [{ id, label, value: v == null ? '' : String(v), secret }];
  switch (kind) {
    case 'concealed': return one(x, true);
    case 'date': return one(toDate(x) || x);
    case 'monthYear': return one(toMonth(x) || x);
    case 'email': return one(typeof x === 'object' ? x.email_address : x);
    case 'address': return addressEntries(id, label, x, splitAddress);
    case 'reference': return [];
    case 'file':
      run.attachments++;
      return one(str(x.fileName) ? t('（添付ファイル: {name}）', { name: str(x.fileName) }) : t('（添付ファイル: 名前なし）'));
    case 'sshKey': {
      if (typeof x !== 'object') return one(x, true);
      const m = x.metadata || {};
      return [
        { id, label, value: str(x.privateKey || m.privateKey), secret: true },
        { id: 'public_key', label: fieldLabel('sshKey', 'publicKey'), value: str(m.publicKey) },
        { id: 'fingerprint', label: fieldLabel('sshKey', 'fingerprint'), value: str(m.fingerprint) },
        { id: 'key_type', label: L('keyType', '鍵の種類'), value: str(m.keyType) },
      ];
    }
    default:
      return one(typeof x === 'object' ? scalars(x) : x);
  }
}

function from1puxItem(run, item) {
  if (!item || typeof item !== 'object') { run.skipped++; return; }
  if (item.trashed === true || item.state === 'trashed' || item.state === 'deleted') { run.skipped++; return; }
  const kind = CATEGORIES[item.categoryUuid] || 'その他のアイテム';
  const ov = item.overview || {};
  const d = item.details || {};
  let username = '', password = '';
  const totps = [], entries = [];

  for (const f of Array.isArray(d.loginFields) ? d.loginFields : []) {
    if (!f || f.value == null || f.value === '') continue;
    if (f.designation === 'username' && !username) username = f.value;
    else if (f.designation === 'password' && !password) password = f.value;
    else if (!FORM_NOISE.has(f.fieldType)) {
      entries.push({ id: str(f.name) || str(f.id), label: str(f.name) || str(f.id) || L('field', '項目'), value: String(f.value), secret: f.fieldType === 'P' });
    }
  }
  if (!password && typeof d.password === 'string') password = d.password;

  for (const s of Array.isArray(d.sections) ? d.sections : []) {
    for (const f of Array.isArray(s?.fields) ? s.fields : []) {
      if (!f) continue;
      if (f.value && typeof f.value === 'object' && 'totp' in f.value) {
        if (str(f.value.totp)) totps.push({ label: str(f.title), value: str(f.value.totp) });
        continue;
      }
      entries.push(...puxFieldEntries(f, run, kind === 'identity'));
    }
  }
  if (d.documentAttributes) {
    run.attachments++;
    entries.push({ id: 'fileName', label: L('fileName', 'ファイル名'), value: str(d.documentAttributes.fileName) });
  }

  emit(run, kind, {
    title: str(ov.title),
    username,
    password,
    urls: [ov.url, ...(Array.isArray(ov.urls) ? ov.urls.map((u) => u?.url) : [])],
    totps,
    entries,
    notes: d.notesPlain,
    tags: (Array.isArray(ov.tags) ? ov.tags : []).map(str).filter(Boolean),
    fav: Number(item.favIndex) > 0,
    createdAt: toMs(item.createdAt),
    updatedAt: toMs(item.updatedAt),
  });
}

function parse1puxData(run, data) {
  if (!data || !Array.isArray(data.accounts)) {
    throw new ImportError('INVALID_FORMAT', t('1Password の export.data の形式が正しくありません'));
  }
  for (const account of data.accounts) {
    for (const vault of Array.isArray(account?.vaults) ? account.vaults : []) {
      for (const item of Array.isArray(vault?.items) ? vault.items : []) from1puxItem(run, item);
    }
  }
}

// --- 1pif ----------------------------------------------------------------------------------

const PIF_KNOWN = new Set(['fields', 'sections', 'URLs', 'URL', 'notesPlain', 'htmlForm', 'passwordHistory', 'password']);

function pifFieldEntries(f, splitAddress) {
  const id = str(f.n);
  const label = str(f.t) || id || L('field', '項目');
  const one = (v, secret = false) => [{ id, label, value: v == null ? '' : String(v), secret }];
  switch (f.k) {
    case 'concealed': return one(f.v, true);
    case 'date': return one(toDate(f.v) || f.v);
    case 'monthYear': return one(toMonth(f.v) || f.v);
    case 'address': return addressEntries(id, label, f.v, splitAddress);
    default: return one(typeof f.v === 'object' && f.v ? scalars(f.v) : f.v);
  }
}

function from1pifRecord(run, rec) {
  const typeName = str(rec.typeName);
  if (rec.trashed === true || typeName === 'system.Tombstone') { run.skipped++; return; }
  if (typeName.startsWith('system.')) return; // folders, saved searches
  const kind = TYPE_NAMES[typeName] || 'その他のアイテム';
  const sc = rec.secureContents || {};
  let username = '', password = '';
  const totps = [], entries = [];

  for (const f of Array.isArray(sc.fields) ? sc.fields : []) {
    if (!f || f.value == null || f.value === '') continue;
    if (f.designation === 'username' && !username) username = f.value;
    else if (f.designation === 'password' && !password) password = f.value;
    else if (!FORM_NOISE.has(f.type)) {
      entries.push({ id: str(f.name) || str(f.id), label: str(f.name) || str(f.id) || L('field', '項目'), value: String(f.value), secret: f.type === 'P' });
    }
  }
  if (!password && typeof sc.password === 'string') password = sc.password;

  const sectionNames = new Set();
  for (const s of Array.isArray(sc.sections) ? sc.sections : []) {
    for (const f of Array.isArray(s?.fields) ? s.fields : []) {
      if (!f) continue;
      sectionNames.add(f.n);
      if (f.v == null || f.v === '') continue;
      if (/^TOTP_/i.test(str(f.n)) || f.k === 'totp') { totps.push({ label: str(f.t), value: str(f.v) }); continue; }
      if (f.k === 'reference') continue;
      entries.push(...pifFieldEntries(f, kind === 'identity'));
    }
  }
  // Older records keep wallet data as flat secureContents keys (often duplicated in sections).
  if (kind !== LOGIN && kind !== PASSWORD) {
    for (const [k, v] of Object.entries(sc)) {
      if (PIF_KNOWN.has(k) || sectionNames.has(k) || v == null || typeof v === 'object') continue;
      entries.push({ id: k, label: k, value: String(v) });
    }
  }

  const fave = rec.faveIndex ?? rec.openContents?.faveIndex;
  emit(run, kind, {
    title: str(rec.title),
    username,
    password,
    urls: [rec.location, sc.URL, ...(Array.isArray(sc.URLs) ? sc.URLs.map((u) => u?.url) : [])],
    totps,
    entries,
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
      parse1puxData(run, parseJson(bytesToText(await data.bytes()), t('1Password（export.data）')));
      // Attachment bodies live under files/; documents and file fields were also counted per item.
      run.attachments = Math.max(run.attachments, entries.filter((e) => /^files\//i.test(e.name)).length);
      return finish(run);
    }
    const pif = entries.find((e) => /\.1pif$/i.test(e.name));
    if (pif) {
      parse1pifText(run, bytesToText(await pif.bytes()));
      return finish(run);
    }
    throw new ImportError('INVALID_FORMAT', t('1Password の書き出しファイル（1PUX）ではありません。ZIP に export.data が見つかりませんでした'));
  }
  const text = bytesToText(file.bytes);
  if (PIF_SEPARATOR.test(text)) {
    parse1pifText(run, text);
  } else if (/^\s*\{/.test(text)) {
    const json = parseJson(text, '1Password');
    if (Array.isArray(json?.accounts)) parse1puxData(run, json); // a bare export.data
    else if (json && typeof json === 'object' && 'typeName' in json) from1pifRecord(run, json); // single 1pif record
    else throw new ImportError('INVALID_FORMAT', t('1Password の書き出しファイルではありません'));
  } else {
    throw new ImportError('INVALID_FORMAT', t('1Password の書き出しファイル（1PUX / 1PIF）ではありません'));
  }
  return finish(run);
}
