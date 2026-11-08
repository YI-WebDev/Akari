import { ImportError, fieldsToNote, parseOtp, bytesToText, parseJson, isZip } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { readZip } from '../zip.js';
import { csvToObjects, pick } from '../csv.js';
import { personName } from '../../../shared/item-types.js';
import { L, typed, fromEntries, looksSecret } from './_fields.js';
import { monthOf } from './_values.js';

const LABELS = {
  account_name: '名称', account_holder: '名義', cc_number: 'カード番号', code: 'セキュリティコード',
  expiration_month: '有効期限（月）', expiration_year: '有効期限（年）', routing_number: 'ルーティング番号',
  account_number: '口座番号', bank_name: '銀行名', issuing_bank: '発行銀行', iban: 'IBAN', bic: 'BIC', country: '国',
  state: '州・地域', name: '氏名', number: '番号', issue_date: '発行日', expiration_date: '有効期限',
  place_of_issue: '発行地', first_name: '名', middle_name: 'ミドルネーム', last_name: '姓', login: 'ユーザー名',
  date_of_birth: '生年月日', place_of_birth: '出生地', email: 'メール', phone_number: '電話', address: '住所',
  city: '市区町村', zip: '郵便番号', address_recipient: '宛名', address_door_code: 'ドアコード', job_title: '役職',
  url: 'URL', category: 'カテゴリ', type: '種類', title: 'タイトル', item_name: '名称',
};
const label = (col) => (LABELS[col] ? L(col, LABELS[col]) : col);

const JSON_NOTE_KINDS = { FISCALSTATEMENT: '税務情報' };
const LEGACY_SKIP = /^(id|anonid|spaceid|localeformat|lastbackuptime|creationdatetime|usermodificationdatetime|creationdate|updatedate|kwtype|attachments|lastuse|color)$/i;

const LEGACY = {
  PAYMENTMEANS_CREDITCARD: ['card', ['name'], [
    ['cardholder', 'owner', 'cardowner', 'ownername'], ['number', 'cardnumber'], ['cvv', 'securitycode'],
  ]],
  BANKSTATEMENT: ['bankAccount', ['bankaccountname', 'name'], [
    ['bankName', 'bankaccountbank', 'bank'], ['accountHolder', 'bankaccountowner', 'owner'], ['iban', 'bankaccountiban', 'iban'],
    ['swift', 'bankaccountbic', 'bic'], ['accountNumber', 'bankaccountnumber', 'accountnumber'],
  ]],
  PASSPORT: ['passport', ['fullname', 'name'], [
    ['fullName', 'fullname', 'name'], ['number', 'number'], ['issuedOn', 'deliverydate'], ['expiry', 'expiredate'],
    ['authority', 'deliveryplace'], ['birthDate', 'dateofbirth'],
  ]],
  DRIVERLICENCE: ['driverLicense', ['fullname', 'name'], [
    ['fullName', 'fullname', 'name'], ['number', 'number'], ['issuedOn', 'deliverydate'], ['expiry', 'expiredate'],
    ['issuer', 'state', 'deliveryplace'], ['birthDate', 'dateofbirth'],
  ]],
  IDCARD: ['socialSecurity', ['fullname', 'name'], [['fullName', 'fullname', 'name'], ['number', 'number']]],
  SOCIALSECURITYSTATEMENT: ['socialSecurity', ['socialsecurityfullname', 'fullname'], [
    ['fullName', 'socialsecurityfullname', 'fullname'], ['number', 'socialsecuritynumber', 'number'],
  ]],
  IDENTITY: ['identity', [], [
    ['firstName', 'firstname'], ['middleName', 'middlename'], ['lastName', 'lastname'], ['birthDate', 'birthdate', 'dateofbirth'],
  ]],
  EMAIL: ['identity', ['emailname', 'name'], [['email', 'email']]],
  PHONE: ['identity', ['phonename', 'name'], [['phone', 'number', 'phonenumber']]],
  ADDRESS: ['identity', ['addressname', 'name'], [
    ['address1', 'addressfull', 'address'], ['city', 'city'], ['postalCode', 'zipcode', 'zip'], ['state', 'state'], ['country', 'country'],
  ]],
  COMPANY: ['identity', [], [['company', 'name', 'company'], ['jobTitle', 'jobtitle']]],
  PERSONALWEBSITE: ['identity', ['name'], [['website', 'website', 'url']]],
};

const str = (v) => (v == null ? '' : String(v).trim());
const isIban = (v) => /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(str(v).replace(/\s/g, '').toUpperCase());
const isBic = (v) => /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(str(v).toUpperCase());

const columnPairs = (rec, headers) => headers.filter((h) => h && h !== 'note').map((h) => [label(h), rec[h]]);

function makeRun() {
  return { items: [], skipped: 0, converted: {}, badTotp: 0 };
}

function asNote(run, kind, title, pairs, note) {
  run.converted[kind] = (run.converted[kind] || 0) + 1;
  run.items.push({ type: 'note', title, note: fieldsToNote(pairs, note) });
}

function login(run, { title, url, usernames, password, note, otp, extra }) {
  const [username = '', ...more] = usernames.map(str).filter(Boolean);
  const list = more.map((u, i) => ({ label: L('usernameN', 'ユーザー名 {n}', { n: i + 2 }), value: u, secret: false }));
  let totp = null;
  if (str(otp)) {
    totp = parseOtp(otp, username || title);
    if (!totp) { run.badTotp++; list.push({ label: L('otp', 'ワンタイムパスワード'), value: otp, secret: true }); }
  }
  run.items.push({ type: 'login', title, url, username, password, totp, note, extra: [...list, ...extra] });
}

const rest = (b, rec, headers, used) => {
  for (const h of headers) if (h && !used.includes(h)) b.add(label(h), rec[h], looksSecret(h));
};

function payment(run, rec, headers) {
  const title = pick(rec, 'account_name', 'title', 'name');
  if (/card/i.test(rec.type)) {
    const b = typed('card');
    b.put('cardholder', rec.account_holder);
    b.put('number', rec.cc_number);
    b.put('cvv', rec.code);
    b.put('expiry', monthOf(rec.expiration_month, rec.expiration_year));
    if (!b.has('expiry')) b.add(L('expiry', '有効期限'), [rec.expiration_month, rec.expiration_year].map(str).filter(Boolean).join('/'));
    rest(b, rec, headers, ['type', 'account_name', 'account_holder', 'cc_number', 'code', 'expiration_month', 'expiration_year', 'note']);
    run.items.push(b.item({ title, note: rec.note }));
  } else if (/bank/i.test(rec.type)) {
    const b = typed('bankAccount');
    b.put('bankName', pick(rec, 'issuing_bank', 'bank_name', 'bank'));
    b.put('accountHolder', rec.account_holder);
    const acct = pick(rec, 'account_number'), routing = pick(rec, 'routing_number');
    b.put(isIban(acct) ? 'iban' : 'accountNumber', acct);
    b.put(isBic(routing) ? 'swift' : 'routingNumber', routing);
    b.put('iban', rec.iban);
    b.put('swift', rec.bic);
    rest(b, rec, headers, ['type', 'account_name', 'account_holder', 'account_number', 'routing_number', 'issuing_bank', 'bank_name', 'bank', 'iban', 'bic', 'note']);
    run.items.push(b.item({ title, note: rec.note }));
  } else {
    asNote(run, '支払い情報', title || t('支払い情報'), columnPairs(rec, headers), rec.note);
  }
}

const ID_TYPES = {
  passport: ['passport', [['fullName', 'name'], ['number', 'number'], ['issuedOn', 'issue_date'], ['expiry', 'expiration_date'], ['authority', 'place_of_issue']]],
  license: ['driverLicense', [['fullName', 'name'], ['number', 'number'], ['issuedOn', 'issue_date'], ['expiry', 'expiration_date'], ['issuer', 'place_of_issue', 'state']]],
  social_security: ['socialSecurity', [['fullName', 'name'], ['number', 'number']]],
  card: ['socialSecurity', [['fullName', 'name'], ['number', 'number']]],
};

const ID_ALIASES = { driver_license: 'license', driving_licence: 'license', id_card: 'card', ssn: 'social_security' };

function idRow(run, rec, headers) {
  const kind = str(rec.type).toLowerCase().replace(/[\s-]/g, '_');
  const known = ID_TYPES[ID_ALIASES[kind] || kind];
  const title = pick(rec, 'name', 'title');
  if (!known) {
    const name = kind === 'tax_number' ? '税番号' : '身分証明書';
    asNote(run, name, title || t(name), columnPairs(rec, headers), rec.note);
    return;
  }
  const entries = headers.filter((h) => h && h !== 'type' && h !== 'note').map((h) => ({ id: h, label: label(h), value: rec[h], secret: looksSecret(h) }));
  run.items.push(fromEntries(known[0], entries, known[1]).item({ title, note: rec.note }));
}

function personalInfo(run, records) {
  const used = ['type', 'title', 'first_name', 'middle_name', 'last_name', 'login', 'date_of_birth', 'email', 'email_type',
    'item_name', 'phone_number', 'address', 'country', 'state', 'city', 'zip', 'address_building', 'address_apartment',
    'address_floor', 'job_title', 'url', 'note'];
  const fill = (b, rec) => {
    b.put('firstName', rec.first_name);
    b.put('middleName', rec.middle_name);
    b.put('lastName', rec.last_name);
    b.add(L('honorific', '敬称'), rec.title);
    b.add(L('username', 'ユーザー名'), rec.login);
    b.put('birthDate', rec.date_of_birth);
    b.put('email', rec.email);
    b.put('phone', rec.phone_number);
    b.put('address1', rec.address);
    b.put('address2', [rec.address_building, rec.address_apartment, rec.address_floor].map(str).filter(Boolean).join(' '));
    b.put('city', rec.city);
    b.put('state', rec.state);
    b.put('postalCode', rec.zip);
    b.put('country', rec.country);
    b.put('jobTitle', rec.job_title);
    b.put('website', rec.url);
    for (const [k, v] of Object.entries(rec)) if (!used.includes(k)) b.add(label(k), v, looksSecret(k));
  };
  const names = records.filter((r) => str(r.type).toLowerCase() === 'name');
  if (names.length === 1) {
    const b = typed('identity');
    const n = names[0];
    for (const rec of [n, ...records.filter((r) => r !== n)]) fill(b, rec);
    const note = records.map((r) => str(r.note)).filter(Boolean).join('\n\n');
    run.items.push(b.item({ title: personName(n.first_name, n.middle_name, n.last_name) || n.item_name, note }));
    return;
  }
  for (const rec of records) {
    const b = typed('identity');
    fill(b, rec);
    run.items.push(b.item({ title: str(rec.item_name) || personName(rec.first_name, rec.middle_name, rec.last_name), note: rec.note }));
  }
}

function fromCsv(run, text, fileName) {
  const { headers, records } = csvToObjects(text);
  const base = fileName.toLowerCase().split('/').pop().replace(/\.csv$/, '');
  const has = (...cols) => cols.every((c) => headers.includes(c));
  const isCredentials = base === 'credentials' || has('password', 'username');
  const isNotes = base === 'securenotes' || (!isCredentials && headers.includes('note') && headers.every((h) => ['title', 'note', 'category'].includes(h)));
  const isPayments = base === 'payments' || has('type', 'account_name', 'cc_number');
  const isIds = base === 'ids' || has('type', 'number', 'place_of_issue');
  const isPersonal = base === 'personalinfo' || has('type', 'first_name', 'item_name');

  if (isPersonal && !isCredentials) { personalInfo(run, records); return; }
  for (const rec of records) {
    if (isCredentials) {
      login(run, {
        title: rec.title,
        url: rec.url,
        usernames: [rec.username, rec.username2, rec.username3],
        password: rec.password,
        note: rec.note,
        otp: pick(rec, 'otpurl', 'otpsecret', 'otp'),
        extra: [{ label: label('category'), value: rec.category, secret: false }],
      });
    } else if (isNotes) {
      run.items.push({ type: 'note', title: rec.title, note: rec.note, extra: [{ label: label('category'), value: rec.category, secret: false }] });
    } else if (isPayments) {
      payment(run, rec, headers);
    } else if (isIds) {
      idRow(run, rec, headers);
    } else {
      const title = pick(rec, 'title', 'item_name', 'account_name', 'name') || t('その他');
      asNote(run, 'その他', title, columnPairs(rec, headers), rec.note);
    }
  }
}

function legacyTyped(run, section, e) {
  const [type, titleKeys, rules] = LEGACY[section];
  const entries = Object.entries(e)
    .filter(([k, v]) => k !== 'note' && v != null && typeof v !== 'object' && !LEGACY_SKIP.test(k))
    .map(([k, v]) => ({ id: k.toLowerCase(), label: k, value: String(v), secret: looksSecret(k) }));
  const titleEntry = titleKeys.map((k) => entries.find((x) => x.id === k && str(x.value))).find(Boolean);
  const mapped = new Set(rules.flat());
  const take = (id) => {
    const i = entries.findIndex((x) => x.id === id);
    return i < 0 ? undefined : entries.splice(i, 1)[0].value;
  };
  const titleIsAlsoMapped = titleEntry && mapped.has(titleEntry.id);
  if (titleEntry && !titleIsAlsoMapped) entries.splice(entries.indexOf(titleEntry), 1);
  const month = type === 'card' ? take('expiremonth') : undefined;
  const year = type === 'card' ? take('expireyear') : undefined;
  const b = fromEntries(type, entries, rules);
  if (type === 'card') {
    b.put('expiry', monthOf(month, year));
    if (!b.has('expiry')) b.add(L('expiry', '有効期限'), [month, year].map(str).filter(Boolean).join('/'));
  }
  const title = str(titleEntry?.value) || (type === 'identity' ? personName(e.firstName ?? e.FirstName, e.middleName ?? e.MiddleName, e.lastName ?? e.LastName) : '');
  run.items.push(b.item({ title, note: e.note }));
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
          extra: [],
        });
      } else if (section === 'SECURENOTE') {
        run.items.push({ type: 'note', title: e.title, note: e.content ?? e.note });
      } else if (section === 'PAYMENTMEAN_PAYPAL') {
        login(run, { title: e.name || 'PayPal', url: '', usernames: [e.login], password: e.password, note: e.note, otp: '', extra: [] });
      } else if (LEGACY[section]) {
        legacyTyped(run, section, e);
      } else {
        const kind = JSON_NOTE_KINDS[section] || 'その他';
        const pairs = Object.entries(e).filter(([k, v]) => k !== 'note' && v != null && typeof v !== 'object' && !LEGACY_SKIP.test(k));
        asNote(run, kind, str(e.title || e.name || e.fullname) || t(kind), pairs, e.note);
      }
    }
  }
}

const isLegacyJson = (j) => j && typeof j === 'object' && !Array.isArray(j)
  && Object.keys(j).some((k) => k === 'AUTHENTIFIANT' || k === 'SECURENOTE' || k === 'PAYMENTMEAN_PAYPAL' || k in LEGACY || k in JSON_NOTE_KINDS);

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
      if (!found) throw new ImportError('INVALID_FORMAT', t('Dashlane の書き出しファイルではありません（ZIP に CSV が見つかりませんでした）'));
    }
  } else {
    const text = bytesToText(file.bytes);
    if (/^\s*\{/.test(text)) {
      const j = parseJson(text, 'Dashlane');
      if (!isLegacyJson(j)) throw new ImportError('INVALID_FORMAT', t('Dashlane の書き出しファイルではありません'));
      fromLegacyJson(run, j);
    } else {
      fromCsv(run, text, file.name || '');
    }
  }
  const warnings = Object.entries(run.converted).map(([k, n]) => t('{kind} {n} 件をセキュアノートとして読み込みました', { kind: t(k), n }));
  if (run.badTotp) warnings.push(t('読み取れない TOTP 設定 {n} 件はカスタムフィールドに残しました', { n: run.badTotp }));
  return { items: run.items, skipped: run.skipped, warnings };
}
