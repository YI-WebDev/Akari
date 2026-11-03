import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeZip } from './_zip.js';
import { SOURCES, parseImport } from '../../extension/src/lib/import/index.js';
import { detectSource } from '../../extension/src/lib/import/detect.js';
import { parse as parseApple } from '../../extension/src/lib/import/importers/apple.js';
import { parse as parseChromium } from '../../extension/src/lib/import/importers/chromium.js';
import { parse as parseFirefox } from '../../extension/src/lib/import/importers/firefox.js';
import { parse as parseLastpass } from '../../extension/src/lib/import/importers/lastpass.js';
import { parse as parseNordpass } from '../../extension/src/lib/import/importers/nordpass.js';
import { parse as parseRoboform } from '../../extension/src/lib/import/importers/roboform.js';
import { parse as parseKaspersky } from '../../extension/src/lib/import/importers/kaspersky.js';
import { parse as parseGeneric } from '../../extension/src/lib/import/importers/generic.js';
import { isSecretLabel, toDate, toMonth } from '../../extension/src/lib/import/importers/_csv.js';

const fx = (path) => new Uint8Array(readFileSync(new URL('../fixtures/import/' + path, import.meta.url)));
const fxText = (path) => readFileSync(new URL('../fixtures/import/' + path, import.meta.url), 'utf8');
const file = (name, text) => ({ name, bytes: new TextEncoder().encode(text) });
const fxFile = (path) => ({ name: path.split('/').pop(), bytes: fx(path) });

const invalid = (e) => e.name === 'ImportError' && e.code === 'INVALID_FORMAT';
const byTitle = (items, title) => items.find((i) => i.title === title);

// ---- Apple Passwords / Safari ----

test('apple: Title,URL,Username,Password,Notes,OTPAuth', async () => {
  const { items, skipped, warnings } = await parseApple(fxFile('apple/passwords.csv'), { source: 'apple' });
  assert.equal(items.length, 4);
  assert.equal(skipped, 0); // the blank ",,,,," row is not data
  assert.deepEqual(warnings, []);
  const a = items[0];
  assert.equal(a.title, 'example.com (alice)');
  assert.equal(a.url, 'https://example.com/login');
  assert.equal(a.username, 'alice');
  assert.equal(a.password, 'p@ss,word "1"');
  assert.equal(a.note, 'line1\nline2 メモ');
  assert.equal(a.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(a.totp.issuer, 'Example');
  assert.equal(a.type, 'login');
  assert.equal(items[1].username, '太郎');
  assert.equal(items[1].password, 'パスワード123');
  assert.equal(items[1].totp, null);
  // an OTPAuth value we cannot use is kept as a secret custom field, not dropped
  assert.equal(items[3].totp, null);
  assert.equal(items[3].note, '');
  assert.deepEqual(items[3].extra, [{ label: 'ワンタイムパスワード', value: 'steam://ABCDEFGH', secret: true }]);
  assert.deepEqual(a.extra, []);
});

test('apple: older Safari export without Notes, column order irrelevant', async () => {
  const { items } = await parseApple(fxFile('apple/safari-old.csv'), { source: 'safari' });
  assert.equal(items.length, 1);
  assert.equal(items[0].note, '');
  assert.equal(items[0].totp.digits, 8);
  const re = await parseApple(file('x.csv', 'Password,OTPAuth,Username,URL,Title\npw,,u,https://a.test,A\n'), {});
  assert.equal(re.items[0].username, 'u');
  assert.equal(re.items[0].title, 'A');
});

test('apple: other CSVs are INVALID_FORMAT and the message names the app', async () => {
  await assert.rejects(parseApple(fxFile('chromium/chrome.csv'), { source: 'apple' }), (e) => invalid(e) && /Apple Passwords/.test(e.message));
  await assert.rejects(parseApple(fxFile('chromium/chrome.csv'), { source: 'safari' }), (e) => invalid(e) && /Safari/.test(e.message) && /列が見つかりません/.test(e.message));
  await assert.rejects(parseApple(file('x.csv', ''), {}), invalid);
});

// ---- Chrome / Brave / Edge ----

test('chromium: name,url,username,password,note with quotes, newlines, Japanese', async () => {
  const { items, skipped } = await parseChromium(fxFile('chromium/chrome.csv'), { source: 'chrome' });
  assert.equal(skipped, 0);
  assert.equal(items.length, 3);
  assert.equal(items[0].password, 'pw,1');
  assert.equal(items[0].note, 'メモ, "quoted"\nsecond line');
  assert.equal(items[1].title, '日本語サイト');
  assert.equal(items[1].username, '花子');
  assert.equal(items[2].url, 'android://hash@com.example.app/');
});

test('chromium: older exports without a note column; reordered columns', async () => {
  const edge = await parseChromium(fxFile('chromium/edge-no-note.csv'), { source: 'edge' });
  assert.equal(edge.items.length, 2);
  assert.equal(edge.items[1].password, 'p"w');
  assert.equal(edge.items[0].note, '');
  const r = await parseChromium(file('x.csv', 'password,note,username,url,name\r\npw,n,u,https://a.test/,A\r\n'), {});
  assert.equal(r.items[0].title, 'A');
  assert.equal(r.items[0].note, 'n');
  assert.equal(r.items[0].username, 'u');
});

test('chromium: title falls back to the host; wrong file names the browser', async () => {
  const r = await parseChromium(file('x.csv', 'name,url,username,password\n,https://www.example.com/x,u,p\n'), {});
  assert.equal(r.items[0].title, 'www.example.com');
  await assert.rejects(parseChromium(fxFile('apple/passwords.csv'), { source: 'brave' }), (e) => invalid(e) && /Brave/.test(e.message));
  await assert.rejects(parseChromium(fxFile('firefox/logins.csv'), { source: 'edge' }), (e) => invalid(e) && /Edge/.test(e.message));
  await assert.rejects(parseChromium(fxFile('kaspersky/export.txt'), { source: 'chrome' }), invalid);
});

// ---- Firefox ----

test('firefox: timestamps, realm, host as title, sync entries left out with a warning', async () => {
  const { items, skipped, warnings } = await parseFirefox(fxFile('firefox/logins.csv'), { source: 'firefox' });
  assert.equal(items.length, 3);
  assert.equal(skipped, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /同期/);
  const [a, b, c] = items;
  assert.equal(a.title, 'www.example.com');
  assert.equal(a.password, 'pw,1');
  assert.equal(a.createdAt, 1700000000000);
  assert.equal(a.updatedAt, 1700000200000);
  assert.equal(b.title, 'intranet.local');
  assert.equal(b.note, '');
  assert.deepEqual(b.extra, [{ label: 'HTTP 認証の領域', value: 'Staff Area', secret: false }]); // a field, not note text
  assert.deepEqual(a.extra, []);
  assert.equal(c.title, '日本語.example.jp');
  assert.equal(c.username, '太郎');
  assert.equal('createdAt' in c, false);
});

test('firefox: legacy "hostname" column, wrong file', async () => {
  const r = await parseFirefox(file('x.csv', 'hostname,username,password,formSubmitURL,httpRealm,usernameField,passwordField\nhttps://a.test,u,p,https://a.test,,,\n'), {});
  assert.equal(r.items[0].title, 'a.test');
  await assert.rejects(parseFirefox(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseFirefox(fxFile('lastpass/export.csv'), {}), invalid);
});

// ---- LastPass ----

test('lastpass: logins, TOTP, fav, structured and plain secure notes', async () => {
  const { items, skipped, warnings } = await parseLastpass(fxFile('lastpass/export.csv'), { source: 'lastpass' });
  assert.equal(items.length, 5);
  assert.equal(skipped, 0);
  assert.equal(warnings.length, 1); // folders are not imported
  const gh = byTitle(items, 'GitHub');
  assert.equal(gh.type, 'login');
  assert.equal(gh.password, 'pw,1');
  assert.equal(gh.note, 'my notes\nsecond line');
  assert.equal(gh.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(gh.fav, true);
  assert.equal(byTitle(items, 'No URL').url, ''); // "http://" is LastPass's empty url
  assert.equal(byTitle(items, 'No URL').fav, false);

  const card = byTitle(items, 'My Visa');
  assert.equal(card.type, 'card');
  assert.equal('url' in card, false); // only logins carry url / username / password
  assert.deepEqual(card.fields, { cardholder: 'Taro Yamada', number: '4111111111111111', expiry: '2030-12', cvv: '123' });
  assert.deepEqual(card.extra, [
    { label: 'Type', value: 'Visa', secret: false },
    { label: 'Start Date', value: '2020-01', secret: false }, // "Month,Year" → YYYY-MM here too
  ]);
  assert.equal(card.note, 'Primary card\nDo not share: really'); // the free text after "Notes:" only

  const plain = byTitle(items, 'Plain note');
  assert.equal(plain.type, 'note');
  assert.equal(plain.note, 'Just a plain note');
  assert.equal(plain.fav, true);
  const steam = byTitle(items, 'Steam');
  assert.equal(steam.totp, null);
  assert.equal(steam.note, '');
  assert.deepEqual(steam.extra, [{ label: 'ワンタイムパスワード', value: 'steam://ABCDEFGH', secret: true }]);
  assert.deepEqual(gh.extra, []);
});

test('lastpass: older export without totp / grouping, columns reordered; wrong file', async () => {
  const r = await parseLastpass(file('x.csv', 'name,fav,extra,url,password,username\nSite,1,memo,https://a.test,pw,u\n'), {});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].fav, true);
  assert.equal(r.items[0].note, 'memo');
  assert.deepEqual(r.warnings, []);
  await assert.rejects(parseLastpass(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseLastpass(fxFile('apple/passwords.csv'), {}), invalid);
});

test('lastpass: every mapped NoteType becomes its Akari type; others stay notes', async () => {
  const { items, skipped, warnings } = await parseLastpass(fxFile('lastpass/notetypes.csv'), {});
  assert.equal(items.length, 15);
  assert.equal(skipped, 1); // the empty Credit Card placeholder
  assert.deepEqual(warnings, []);
  const labels = (it) => it.extra.map((e) => e.label);
  const plainExtras = (it) => it.extra.every((e) => !e.secret);

  const bank = byTitle(items, 'Bank');
  assert.equal(bank.type, 'bankAccount');
  assert.deepEqual(bank.fields, {
    bankName: 'Mizuho', accountType: 'Checking', routingNumber: '123456789', accountNumber: '00112233',
    swift: 'MHCBJPJT', iban: 'GB82WEST12345698765432', pin: '4321',
  });
  assert.deepEqual(labels(bank), ['Branch Address', 'Branch Phone']);
  assert.equal(bank.note, 'Main account\nsecond line');
  assert.equal(bank.fav, true);

  const home = byTitle(items, 'Home');
  assert.equal(home.type, 'identity');
  assert.deepEqual(home.fields, {
    lastName: 'Yamada', firstName: 'Taro', email: 'taro@example.jp', phone: '03-1111-2222', birthDate: '1990-03-05',
    company: 'Example KK', postalCode: '100-0001', country: 'JP', state: 'Tokyo', city: 'Chiyoda', address1: '1-1 Chiyoda', address2: 'Bldg 2',
  });
  assert.deepEqual(labels(home), ['Title', 'Username', 'Evening Phone', 'Mobile Phone', 'Address 3']); // the 2nd phone etc. are not lost
  assert.ok(plainExtras(home));

  const dl = byTitle(items, 'License');
  assert.equal(dl.type, 'driverLicense');
  assert.deepEqual(dl.fields, {
    fullName: 'Taro Yamada', number: 'D1234567', licenseClass: 'B', birthDate: '1990-03-05', expiry: '2030-01-15', address: '1-1 Chiyoda',
  });
  assert.deepEqual(labels(dl), ['City / Town', 'State', 'ZIP / Postal Code', 'Country', 'Sex', 'Height']);
  assert.ok(plainExtras(dl)); // "ZIP / Postal Code" is not a "code" secret

  const pass = byTitle(items, 'Passport');
  assert.equal(pass.type, 'passport');
  assert.deepEqual(pass.fields, {
    fullName: 'Taro Yamada', number: 'TK1234567', nationality: 'Japanese', issuingCountry: 'Japan',
    birthDate: '1990-03-05', issuedOn: '2020-06-01', expiry: '2030-05-31', authority: 'MOFA',
  });
  assert.deepEqual(labels(pass), ['Type', 'Sex']);

  const ssn = byTitle(items, 'SSN');
  assert.equal(ssn.type, 'socialSecurity');
  assert.deepEqual(ssn.fields, { fullName: 'Taro Yamada', number: '123-45-6789' });
  assert.equal(ssn.note, 'keep safe');

  const db = byTitle(items, 'Prod DB');
  assert.equal(db.type, 'database');
  assert.deepEqual(db.fields, { dbType: 'MySQL', host: 'db.example.com', port: '3306', database: 'app', username: 'root', password: 'dbpw' });
  assert.deepEqual(labels(db), ['SID', 'Alias']);

  const srv = byTitle(items, 'Server');
  assert.equal(srv.type, 'server');
  assert.deepEqual(srv.fields, { host: 'srv.example.com', username: 'admin', password: 'srvpw' });

  const ssh = byTitle(items, 'Deploy key');
  assert.equal(ssh.type, 'sshKey');
  // the PEM block keeps its "Proc-Type: …" header line instead of splitting it off as a field
  assert.equal(ssh.fields.privateKey, '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIEabc\n-----END RSA PRIVATE KEY-----');
  assert.deepEqual({ ...ssh.fields, privateKey: undefined }, {
    privateKey: undefined, publicKey: 'ssh-rsa AAAAB3Nza user@host', passphrase: 'pp', host: 'git.example.com',
  });
  assert.deepEqual(ssh.extra.map((e) => [e.label, e.value]), [['Bit Strength', '2048'], ['Format', 'RSA'], ['Date', 'June,1,2020']]);
  assert.equal(ssh.note, 'deploy key');

  const lic = byTitle(items, 'Editor');
  assert.equal(lic.type, 'softwareLicense');
  assert.deepEqual(lic.fields, { version: '2.1', licenseKey: 'AAAA-BBBB', licensee: 'Taro', purchaseDate: '2021-04-02', url: 'https://vendor.example' });
  assert.deepEqual(labels(lic), ['Support Email', 'Publisher', 'Price', 'Number of Licenses']);
  assert.ok(plainExtras(lic));

  const wifi = byTitle(items, 'Home WiFi');
  assert.equal(wifi.type, 'wifi');
  assert.deepEqual(wifi.fields, { ssid: 'HomeNet', password: 'wifipw', security: 'wpa2' }); // option id, not the label
  assert.deepEqual(labels(wifi), ['Connection Type', 'Connection Mode', 'Encryption']);

  const gym = byTitle(items, 'Gym');
  assert.equal(gym.type, 'membership');
  assert.deepEqual(gym.fields, { organization: 'Gym', memberName: 'Taro', memberId: 'M-1', url: 'https://gym.example' });
  // "Month,Year" cannot fill a day-precise date: kept as written
  assert.deepEqual(gym.extra.map((e) => [e.label, e.value, e.secret]), [
    ['Telephone', '03-9999-9999', false], ['Start Date', 'January,2020', false], ['Expiration Date', 'December,2030', false], ['Password', 'gympw', true],
  ]);

  const health = byTitle(items, 'Health');
  assert.equal(health.type, 'medicalRecord');
  assert.deepEqual(health.fields, { patientName: 'Taro', insurer: 'Kenpo', doctor: 'Dr. Sato', policyNumber: 'P-123' });
  assert.equal(health.extra.length, 7);

  // NoteTypes Akari has no type for keep the old listing
  const mail = byTitle(items, 'Mail');
  assert.equal(mail.type, 'note');
  assert.equal(mail.note, 'NoteType: Email Account\nUsername: me\nPassword: mailpw\nServer: imap.example.com\nPort: 993\nNotes: hello');
  assert.deepEqual(mail.extra, []);
  const gift = byTitle(items, 'Gift');
  assert.equal(gift.type, 'note');
  assert.match(gift.note, /^NoteType: Custom_123456\nGift Code: XYZ/);

  // values that do not fit their slot are kept as custom fields, not dropped
  const odd = byTitle(items, 'Odd card');
  assert.equal(odd.type, 'card');
  assert.deepEqual(odd.fields, { cardholder: 'Hanako', number: '5555555555554444', cvv: '456' });
  assert.deepEqual(odd.extra.map((e) => [e.label, e.value]), [['Type', 'Mastercard'], ['Start Date', 'someday'], ['Expiration Date', 'soon']]);
});

test('lastpass: a single Full Name goes to fullName (First / Last stay separate); product and patient keys', async () => {
  const note = (body, name) => `http://sn,,,"NoteType:${body}",${name}\n`;
  const csv = 'url,username,password,extra,name\n'
    + note('Address\nFull Name:Taro Yamada\nEmail Address:t@example.jp', 'A')
    + note('Address\nFirst Name:Taro\nLast Name:Yamada', 'B')
    + note('Software License\nProduct Name:Editor\nVersion:3\nLicense Key:K-1', 'C')
    + note('Health Insurance\nMember Name:Hanako\nPatient ID:7788\nCompany:Kenpo', 'D');
  const { items } = await parseLastpass(file('x.csv', csv), {});
  assert.deepEqual(items[0].fields, { fullName: 'Taro Yamada', email: 't@example.jp' });
  assert.deepEqual(items[1].fields, { lastName: 'Yamada', firstName: 'Taro' });
  assert.deepEqual(items[2].fields, { product: 'Editor', version: '3', licenseKey: 'K-1' });
  assert.deepEqual(items[3].fields, { patientName: 'Hanako', recordNumber: '7788', insurer: 'Kenpo' });
});

test('lastpass: custom fields are secret when the label says number / code / password / PIN / key', async () => {
  const extra = 'NoteType:Bank Account\nBank Name:X\nCustomer Number:998\nOnline Banking Password:pw\nSecurity Code Hint:abc\nTelephone Number:03\nBranch Name:Ginza\nApp Key:k\nNotes:n';
  const csv = `url,username,password,extra,name\nhttp://sn,,,"${extra}",B\n`;
  const { items } = await parseLastpass(file('x.csv', csv), {});
  assert.deepEqual(items[0].extra.map((e) => [e.label, e.secret]), [
    ['Customer Number', true], ['Online Banking Password', true], ['Security Code Hint', true],
    ['Telephone Number', false], ['Branch Name', false], ['App Key', true],
  ]);
  assert.equal(items[0].note, 'n');
});

test('import dates: month and day spellings are converted to ISO, doubtful ones are refused', () => {
  assert.equal(toMonth('December,2030'), '2030-12');
  assert.equal(toMonth('Dec 2030'), '2030-12');
  assert.equal(toMonth('12/30'), '2030-12');
  assert.equal(toMonth('12/2030'), '2030-12');
  assert.equal(toMonth('2030-12'), '2030-12');
  assert.equal(toMonth('2030年12月'), '2030-12');
  assert.equal(toMonth('2030-12-31'), '2030-12');
  assert.equal(toMonth('13/2030'), null);
  assert.equal(toMonth('2030'), null);
  assert.equal(toMonth('soon'), null);
  assert.equal(toMonth(''), null);
  assert.equal(toDate('January,15,1990'), '1990-01-15');
  assert.equal(toDate('15 January 1990'), '1990-01-15');
  assert.equal(toDate('1990/1/5'), '1990-01-05');
  assert.equal(toDate('1990-01-05T00:00:00Z'), '1990-01-05');
  assert.equal(toDate('19900105'), '1990-01-05');
  assert.equal(toDate('1990年1月5日'), '1990-01-05');
  assert.equal(toDate('31/12/2030'), '2030-12-31');
  assert.equal(toDate('12/31/2030'), '2030-12-31');
  assert.equal(toDate('01/02/2030'), null); // day-first or month-first: cannot tell
  assert.equal(toDate('February,30,2030'), null);
  assert.equal(toDate('December,2030'), null); // no day
});

test('import labels: secret-looking names are masked, look-alikes are not', () => {
  for (const l of ['PIN', 'Card PIN', 'Security Code', 'API key', 'apiKey', 'client_secret', 'Access Token', 'パスワード', '暗証番号', 'Pass', 'Recovery code']) {
    assert.equal(isSecretLabel(l), true, l);
  }
  for (const l of ['Public Key', 'Passport', 'Phone', 'ZIP / Postal Code', 'Country code', 'Telephone', 'Website', 'City', 'Number of Licenses', '電話番号']) {
    assert.equal(isSecretLabel(l, { numbers: true }), false, l);
  }
  assert.equal(isSecretLabel('Account Number'), false); // numbers are only secret where the caller says so
  assert.equal(isSecretLabel('Account Number', { numbers: true }), true);
  assert.equal(isSecretLabel('口座番号', { numbers: true }), true);
});

// ---- NordPass ----

test('nordpass: login, card, identity, note; folder rows are dropped', async () => {
  const { items, skipped, warnings } = await parseNordpass(fxFile('nordpass/export.csv'), { source: 'nordpass' });
  assert.equal(items.length, 4); // the "folder" row is not an item
  assert.equal(skipped, 0);
  assert.equal(warnings.length, 1);
  const gh = byTitle(items, 'GitHub');
  assert.equal(gh.type, 'login');
  assert.equal(gh.url, 'https://github.com');
  assert.equal(gh.username, 'alice');
  assert.equal(gh.password, 'pw,1');
  assert.equal(gh.note, 'a note\nsecond line'); // additional URLs and custom fields are custom fields now
  assert.deepEqual(gh.extra, [
    { label: '追加の URL', value: 'https://gist.github.com', secret: false },
    { label: '追加の URL', value: 'https://github.io', secret: false },
    { label: 'Recovery code', value: 'ABCD-1234', secret: true }, // type "hidden"
    { label: 'Plan', value: 'Pro', secret: false },
  ]);

  const card = byTitle(items, 'My Card');
  assert.equal(card.type, 'card');
  assert.deepEqual(card.fields, { cardholder: 'Taro Yamada', number: '4111111111111111', expiry: '2030-12', cvv: '123', pin: '4321' });
  assert.deepEqual(card.extra, [{ label: '郵便番号', value: '100-0001', secret: false }]); // billing zip has no card slot

  const id = byTitle(items, 'Taro');
  assert.equal(id.type, 'identity');
  assert.deepEqual(id.fields, {
    fullName: '山田 太郎', email: 'taro@example.jp', phone: '090-1234-5678',
    postalCode: '100-0001', country: 'JP', state: '東京都', city: '千代田区', address1: '千代田1-1', address2: 'Bldg 2',
  });
  assert.deepEqual(id.extra, []);

  const note = byTitle(items, '秘密のメモ');
  assert.equal(note.type, 'note');
  assert.equal(note.note, 'ほげ\nふが');
});

test('nordpass: missing optional columns, unparseable custom_fields kept, wrong file', async () => {
  const r = await parseNordpass(file('x.csv', 'name,url,username,password,note,type,custom_fields\nA,https://a.test,u,p,n,password,not json\n'), {});
  assert.equal(r.items[0].note, 'n');
  assert.deepEqual(r.items[0].extra, [{ label: 'カスタム項目', value: 'not json', secret: false }]);
  await assert.rejects(parseNordpass(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseNordpass(fxFile('lastpass/export.csv'), {}), invalid);
});

const NORD_HEAD = 'name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type,custom_fields\n';

test('nordpass: card expiry formats; an unreadable expiry stays a custom field', async () => {
  const card = async (expiry) => (await parseNordpass(file('x.csv', NORD_HEAD + `Card,,,,,,Hanako,5555555555554444,456,,${expiry},,,,,,,,,,,credit_card,\n`), {})).items[0];
  assert.equal((await card('12/30')).fields.expiry, '2030-12');
  assert.equal((await card('03/2028')).fields.expiry, '2028-03');
  assert.equal((await card('2029-07')).fields.expiry, '2029-07');
  assert.equal((await card('2029-07-31')).fields.expiry, '2029-07');
  const bad = await card('someday');
  assert.equal('expiry' in bad.fields, false);
  assert.deepEqual(bad.extra, [{ label: '有効期限', value: 'someday', secret: false }]);
});

test('nordpass: full_name is kept as written in identity.fullName (never split); on other rows it is a custom field', async () => {
  const name = async (full) => (await parseNordpass(file('x.csv', NORD_HEAD + `Id,,,,,,,,,,,,,${full},,,,,,,,identity,\n`), {})).items[0].fields;
  for (const full of ['山田 太郎', '山田　太郎', 'Taro Yamada', '山田太郎', 'Mary Jane Watson']) {
    assert.deepEqual(await name(full), { fullName: full }, full);
  }
  const card = await parseNordpass(file('x.csv', NORD_HEAD + 'Card,,,,,,Hanako,5555555555554444,456,,12/30,,,Hanako Yamada,,,,,,,,credit_card,\n'), {});
  assert.deepEqual(card.items[0].extra, [{ label: '氏名', value: 'Hanako Yamada', secret: false }]);
});

test('nordpass: columns with no place in a row\'s type become custom fields, secrets masked', async () => {
  const csv = NORD_HEAD
    + 'Memo,https://a.test,,me,notepw,body,,,,,,,,,,,,,,,,note,"[{""label"":""Backup code"",""type"":""text"",""value"":""777""},{""label"":""Hint"",""type"":""hidden"",""value"":""cat""}]"\n'
    + 'Site,https://s.test,,u,pw,,Hanako,5555555555554444,456,1111,12/30,,,Taro Yamada,,,,,,,,password,\n';
  const { items } = await parseNordpass(file('x.csv', csv), {});
  const [memo, site] = items;
  assert.equal(memo.type, 'note');
  assert.equal(memo.note, 'body');
  assert.deepEqual(memo.extra.map((e) => [e.label, e.value, e.secret]), [
    ['URL', 'https://a.test', false], ['ユーザー名', 'me', false], ['パスワード', 'notepw', true],
    ['Backup code', '777', true], // no "hidden" type, but the label says code
    ['Hint', 'cat', true], // "hidden"
  ]);
  assert.equal(site.type, 'login');
  assert.equal(site.password, 'pw');
  assert.deepEqual(site.extra.map((e) => [e.value, e.secret]), [
    ['Hanako', false], ['5555555555554444', true], ['456', true], ['1111', true], ['12/30', false], ['Taro Yamada', false],
  ]);
});

// ---- RoboForm ----

test('roboform: logins, RfFieldsV2 extras and TOTP, Safenote and Identity rows', async () => {
  const { items, skipped, warnings } = await parseRoboform(fxFile('roboform/export.csv'), { source: 'roboform' });
  assert.equal(items.length, 4);
  assert.equal(skipped, 0);
  assert.equal(warnings.length, 1);
  const gh = byTitle(items, 'GitHub');
  assert.equal(gh.type, 'login');
  assert.equal(gh.url, 'https://github.com/login');
  assert.equal(gh.username, 'alice');
  assert.equal(gh.password, 'pw1');
  assert.equal(gh.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(gh.note, 'メモ');
  assert.deepEqual(gh.extra, [
    { label: 'Security answer', value: 'blue', secret: true }, // field type "pwd"
    { label: '項目', value: 'extra value', secret: false },
  ]); // duplicates of Login / Pwd (User ID$, Password$) are not repeated

  const safe = byTitle(items, 'Meeting notes');
  assert.equal(safe.type, 'note');
  assert.equal(safe.note, 'Line1\nLine2');
  assert.deepEqual(safe.extra, []);

  const ident = byTitle(items, 'My Identity');
  assert.equal(ident.type, 'identity');
  assert.deepEqual(ident.fields, { firstName: '太郎', lastName: '山田', email: 'taro@example.jp' });
  assert.deepEqual(ident.extra, []);

  assert.equal(byTitle(items, 'Bank').password, 's3cret');
});

test('roboform: no RfFieldsV2 column, extra User ID$ differing from Login is kept; wrong file', async () => {
  const r = await parseRoboform(file('x.csv', 'Name,Url,Login,Pwd,Note\nA,https://a.test,u,p,n\n'), {});
  assert.equal(r.items[0].username, 'u');
  assert.equal(r.items[0].note, 'n');
  const alt = await parseRoboform(file('x.csv', 'Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\nA,https://a.test,,u,p,,,"User ID$,,,txt,other,Password$,,,pwd,p"\n'), {});
  assert.equal(alt.items[0].username, 'u');
  assert.deepEqual(alt.items[0].extra, [{ label: 'User ID', value: 'other', secret: false }]);
  assert.equal(alt.items[0].note, '');
  await assert.rejects(parseRoboform(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseRoboform(fxFile('nordpass/export.csv'), {}), invalid);
});

const ROBO_HEAD = 'Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\n';

test('roboform: identity fields fill the template, birthday becomes a date, the rest are custom fields', async () => {
  const fields = '"First Name$,,,txt,Taro,Last Name$,,,txt,Yamada,Birthday$,,,txt,March 5 1990,Zip$,,,txt,100-0001,City$,,,txt,Chiyoda,Company$,,,txt,Example KK,Mother\'s maiden name,,,pwd,Suzuki,Favourite colour,,,txt,blue"';
  const { items } = await parseRoboform(file('x.csv', ROBO_HEAD + `Me,,,,,about me,,${fields}\n`), {});
  const me = items[0];
  assert.equal(me.type, 'identity');
  assert.equal(me.note, 'about me');
  assert.deepEqual(me.fields, {
    lastName: 'Yamada', firstName: 'Taro', birthDate: '1990-03-05', company: 'Example KK', postalCode: '100-0001', city: 'Chiyoda',
  });
  assert.deepEqual(me.extra, [
    { label: "Mother's maiden name", value: 'Suzuki', secret: true },
    { label: 'Favourite colour', value: 'blue', secret: false },
  ]);
});

test('roboform: a Full Name field fills identity.fullName', async () => {
  const r = await parseRoboform(file('x.csv', ROBO_HEAD + 'Me,,,,,,,"Full Name$,,,txt,山田 太郎,Email$,,,txt,t@example.jp"\n'), {});
  assert.equal(r.items[0].type, 'identity');
  assert.deepEqual(r.items[0].fields, { fullName: '山田 太郎', email: 't@example.jp' });
});

test('roboform: a row with fields but no identity key stays a note; unreadable birthday is kept', async () => {
  const none = await parseRoboform(file('x.csv', ROBO_HEAD + 'Form,,,,,,,"Foo,,,txt,bar"\n'), {});
  assert.equal(none.items[0].type, 'note');
  assert.equal(none.items[0].note, 'Foo: bar');
  const bd = await parseRoboform(file('x.csv', ROBO_HEAD + 'Me,,,,,,,"First Name$,,,txt,Taro,Birthday$,,,txt,someday"\n'), {});
  assert.equal(bd.items[0].type, 'identity');
  assert.equal('birthDate' in bd.items[0].fields, false);
  assert.deepEqual(bd.items[0].extra, [{ label: 'Birthday', value: 'someday', secret: false }]);
});

// ---- Kaspersky ----

test('kaspersky: websites, applications, notes; multi-line comment / text', async () => {
  const { items, skipped } = await parseKaspersky(fxFile('kaspersky/export.txt'), { source: 'kaspersky' });
  assert.equal(skipped, 0);
  assert.equal(items.length, 4);
  const site = items[0];
  assert.equal(site.title, 'Example (Work)');
  assert.equal(site.url, 'https://example.com');
  assert.equal(site.username, 'alice@example.com');
  assert.equal(site.password, 'pw:1');
  assert.equal(site.note, 'first line\nsecond: line with colon');
  assert.equal(items[1].title, '日本語サイト');
  assert.equal(items[1].username, '太郎');
  assert.equal(items[1].note, '');
  const app = items[2];
  assert.equal(app.title, 'Steam');
  assert.equal(app.url, '');
  assert.equal(app.username, 'gamer'); // no "Login": the "Login name" is the user name
  assert.equal(app.password, 'steampw');
  const note = items[3];
  assert.equal(note.type, 'note');
  assert.equal(note.title, 'Wifi');
  assert.equal(note.note, 'SSID: home\nPassword: abc\nlast line');
});

test('kaspersky: unknown "Key: value" lines are custom fields (masked by name); keyless lines stay in the note', async () => {
  const text = 'Websites\n\nWebsite name: S\nWebsite URL: https://s.test\nLogin: u\nPassword: p\nSecurity question: first pet\nPIN: 1234\nstray line\nComment: hello\n---\n'
    + 'Notes\n\nName: N\nCode: 77\nText: body\n';
  const { items } = await parseKaspersky(file('x.txt', text), {});
  assert.equal(items.length, 2);
  assert.equal(items[0].note, 'hello\n\nstray line');
  assert.deepEqual(items[0].extra, [
    { label: 'Security question', value: 'first pet', secret: false },
    { label: 'PIN', value: '1234', secret: true },
  ]);
  assert.equal(items[1].type, 'note');
  assert.equal(items[1].note, 'body');
  assert.deepEqual(items[1].extra, [{ label: 'Code', value: '77', secret: true }]);
});

test('kaspersky: CRLF and UTF-8 BOM', async () => {
  const text = fxText('kaspersky/export.txt').replace(/\r?\n/g, '\r\n');
  const bytes = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  const lf = await parseKaspersky(fxFile('kaspersky/export.txt'), {});
  const crlf = await parseKaspersky({ name: 'x.txt', bytes }, {});
  assert.deepEqual(crlf.items, lf.items);
});

test('kaspersky: sections may be missing, last entry without a closing separator, wrong file', async () => {
  const r = await parseKaspersky(file('x.txt', 'Notes\n\nName: A\nText: body\n\nWebsites\n\nWebsite name: S\nWebsite URL: https://s.test\nLogin: u\nPassword: p'), {});
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].note, 'body');
  assert.equal(r.items[1].username, 'u');
  await assert.rejects(parseKaspersky(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseKaspersky(file('x.txt', 'hello\nworld'), {}), invalid);
  await assert.rejects(parseKaspersky(file('x.txt', ''), {}), invalid);
});

// ---- Generic ----

test('generic: Japanese headers, TOTP, favourite, unknown columns kept as custom fields', async () => {
  const { items, warnings } = await parseGeneric(fxFile('generic/japanese.csv'), { source: 'generic' });
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.title, '銀行');
  assert.equal(a.url, 'https://bank.example.jp');
  assert.equal(a.username, 'taro');
  assert.equal(a.password, 'p,w');
  assert.equal(a.note, 'メモ内容\n2行目');
  assert.deepEqual(a.extra, [{ label: '電話番号', value: '03-1234-5678', secret: false }]);
  assert.equal(a.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(a.fav, true);
  assert.equal(items[1].username, 'hanako@example.jp'); // メール used as the user name
  assert.equal(items[1].fav, false);
  assert.equal(warnings.length, 1); // カテゴリ is organisational and reported
  assert.match(warnings[0], /カテゴリ/);
});

test('generic: unknown columns become custom fields, masked when the header looks secret', async () => {
  const csv = 'url,username,password,Security PIN,API Token,Backup Code,Zip Code,Memo2\nhttps://a.test,u,p,1,2,3,100,4\n';
  const { items } = await parseGeneric(file('x.csv', csv), {});
  assert.equal(items[0].note, '');
  assert.deepEqual(items[0].extra.map((e) => [e.label, e.value, e.secret]), [
    ['Security PIN', '1', true], ['API Token', '2', true], ['Backup Code', '3', true], ['Zip Code', '100', false], ['Memo2', '4', false], // the header's own spelling
  ]);
  // a row with only custom fields is a secure note
  const only = await parseGeneric(file('x.csv', 'title,password,Extra Info\nT,,hi\n'), {});
  assert.equal(only.items[0].type, 'note');
  assert.deepEqual(only.items[0].extra, [{ label: 'Extra Info', value: 'hi', secret: false }]);
});

test('generic: a type column with an Akari type (id, Japanese or English name) imports that type', async () => {
  const { items, warnings } = await parseGeneric(fxFile('generic/akari-types.csv'), {});
  assert.equal(items.length, 9);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /type/); // only the unrecognised value ("Business") is reported
  assert.deepEqual(items.map((i) => i.type), ['login', 'card', 'card', 'wifi', 'server', 'passport', 'sshKey', 'note', 'login']);

  const [gh, card, jp, wifi, srv, pass, ssh, memo, odd] = items;
  assert.equal(gh.password, 'pw');
  assert.deepEqual(card.fields, { cardholder: 'Taro Yamada', number: '4111 1111 1111 1111', expiry: '2030-12', cvv: '123' });
  assert.equal(card.note, 'card note');
  assert.deepEqual(card.extra, [{ label: 'Recovery PIN', value: '9876', secret: true }, { label: 'custom', value: 'billing', secret: false }]);
  // Japanese type name and Japanese-label matching are covered below; here a stray password column is kept, masked
  assert.deepEqual(jp.fields, { cardholder: '山田太郎', number: '4222222222222222', expiry: '2031-05', cvv: '999' });
  assert.deepEqual(jp.extra, [{ label: 'password', value: 'cardpw', secret: true }]);
  assert.deepEqual(wifi.fields, { ssid: 'HomeNet', password: 'wifipw', security: 'wpa2' });
  assert.deepEqual(srv.fields, { host: 'srv.example.com', port: '22', username: 'root', password: 'srvpw', url: 'https://admin.example' });
  assert.deepEqual(srv.extra, [{ label: 'totp', value: 'JBSWY3DPEHPK3PXP', secret: true }]); // a server has no TOTP slot
  assert.deepEqual(pass.fields, { fullName: 'Taro Yamada', number: 'TK123', birthDate: '1990-03-05', expiry: '2030-05-31' });
  assert.deepEqual(ssh.fields, { host: 'git.example.com' });
  assert.equal(memo.note, 'remember this');
  assert.equal(odd.url, 'https://odd.example');
});

test('generic: type names — every Akari type by id, Japanese label and English name', async () => {
  const names = [
    ['Credit Card', 'card'], ['クレジットカード', 'card'], ['Identity', 'identity'], ['ID', 'identity'], ['Bank Account', 'bankAccount'],
    ["Driver's License", 'driverLicense'], ['運転免許証', 'driverLicense'], ['Social Security', 'socialSecurity'], ['API Key', 'apiCredential'],
    ['Crypto Wallet', 'cryptoWallet'], ['Medical Record', 'medicalRecord'], ['Software License', 'softwareLicense'], ['sshKey', 'sshKey'],
    ['Reward Program', 'rewardProgram'], ['メンバーシップ', 'membership'], ['WiFiネットワーク', 'wifi'], ['Wi-Fi', 'wifi'], ['Database', 'database'],
    ['Secure Note', 'note'], ['セキュアノート', 'note'], ['ログイン', 'login'], ['Passport', 'passport'], ['SERVER', 'server'],
  ];
  const csv = 'type,title,password\n' + names.map(([n], i) => `"${n}",T${i},pw`).join('\n') + '\n';
  const { items, warnings } = await parseGeneric(file('x.csv', csv), {});
  assert.deepEqual(items.map((i) => i.type), names.map(([, id]) => id));
  assert.deepEqual(warnings, []);
});

test('generic: typed rows match template keys by key or Japanese label; selects store option ids; misfits stay custom fields', async () => {
  const jp = await parseGeneric(file('x.csv', 'type,title,password,カード番号,有効期限,名義\nクレジットカード,V,,4111111111111111,2030/12,Taro\n'), {});
  assert.deepEqual(jp.items[0].fields, { cardholder: 'Taro', number: '4111111111111111', expiry: '2030-12' });
  assert.deepEqual(jp.items[0].extra, []);
  const wifi = await parseGeneric(file('x.csv', 'type,title,password,ssid,security\nwifi,A,pw,Net,Open\nwifi,B,pw,Net2,weird\nwifi,C,pw,Net3,なし\nwifi,D,pw,Net4,WPA3\n'), {});
  assert.deepEqual(wifi.items.map((i) => i.fields.security), ['none', undefined, 'none', 'wpa3']);
  assert.deepEqual(wifi.items[1].extra, [{ label: 'security', value: 'weird', secret: false }]);
  const srv = await parseGeneric(file('x.csv', 'type,title,password,host,port\nserver,S,pw,h,abc\nserver,T,pw,h,5 432\n'), {});
  assert.equal(srv.items[0].fields.port, undefined);
  assert.deepEqual(srv.items[0].extra, [{ label: 'port', value: 'abc', secret: false }]);
  assert.equal(srv.items[1].fields.port, '5432');
  const dates = await parseGeneric(file('x.csv', 'type,title,password,fullname,birthdate,expiry\npassport,P,,Taro,1990/3/5,31/12/2030\npassport,Q,,Hanako,someday,\n'), {});
  assert.deepEqual(dates.items[0].fields, { fullName: 'Taro', birthDate: '1990-03-05', expiry: '2030-12-31' });
  assert.equal(dates.items[1].fields.birthDate, undefined);
  assert.deepEqual(dates.items[1].extra, [{ label: 'birthdate', value: 'someday', secret: false }]);
});

test('generic: typed rows fill fullName / product / patientName / recordNumber / reward expiry by key or Japanese label', async () => {
  const csv = 'type,title,password,fullName,氏名,product,製品名,patientName,診察券番号,expiry\n'
    + 'identity,Me,,Taro Yamada,ignored,,,,,\n'
    + 'identity,Me2,,,山田 太郎,,,,,\n'
    + 'softwareLicense,Editor,,,,Editor Pro,,,,2031-01-31\n'
    + 'ソフトウェアライセンス,Editor2,,,,,エディタ,,,\n'
    + 'Medical Record,Clinic,,,,,,Hanako,12345,\n'
    + 'rewardProgram,Airline,pw,,,,,,,2030-06-30\n';
  const { items } = await parseGeneric(file('x.csv', csv), {});
  assert.deepEqual(items.map((i) => i.type), ['identity', 'identity', 'softwareLicense', 'softwareLicense', 'medicalRecord', 'rewardProgram']);
  assert.deepEqual(items[0].fields, { fullName: 'Taro Yamada' });
  assert.deepEqual(items[0].extra, [{ label: '氏名', value: 'ignored', secret: false }]); // the second column naming the same key is kept, not lost
  assert.deepEqual(items[1].fields, { fullName: '山田 太郎' });
  assert.deepEqual(items[2].fields, { product: 'Editor Pro', expiry: '2031-01-31' });
  assert.deepEqual(items[3].fields, { product: 'エディタ' });
  assert.deepEqual(items[4].fields, { patientName: 'Hanako', recordNumber: '12345' });
  assert.deepEqual(items[5].fields, { expiry: '2030-06-30' });
  assert.deepEqual(items[5].extra, [{ label: 'password', value: 'pw', secret: true }]);
});

test('generic: custom-field labels and the unused-columns warning keep the header spelling', async () => {
  const { items, warnings } = await parseGeneric(file('x.csv', 'URL,UserName,Password,Folder,Security Question,Backup CODE\nhttps://a.test,u,p,Work,pet,7\n'), {});
  assert.deepEqual(items[0].extra.map((e) => [e.label, e.value, e.secret]), [['Security Question', 'pet', false], ['Backup CODE', '7', true]]);
  assert.match(warnings[0], /: Folder$/);
  // typed rows too: the first column that names a key fills it, the other keeps its label
  const typed = await parseGeneric(file('x.csv', 'Type,Title,Card Holder,cardHolder,Billing Zip,Number\ncard,V,Taro,Hanako,100,4111\n'), {});
  assert.deepEqual(typed.items[0].fields, { cardholder: 'Taro', number: '4111' });
  assert.deepEqual(typed.items[0].extra.map((e) => e.label), ['cardHolder', 'Billing Zip']);
});

test('generic: a type column plus a template-field column is enough (no password / url needed)', async () => {
  const card = await parseGeneric(file('x.csv', 'type,title,number,expiry,cardholder\ncard,Visa,4111111111111111,12/30,Taro\nクレジットカード,x,1,2,3\n'), {});
  assert.equal(card.items.length, 2);
  assert.equal(card.items[0].type, 'card');
  assert.deepEqual(card.items[0].fields, { number: '4111111111111111', expiry: '2030-12', cardholder: 'Taro' });
  assert.equal(card.items[1].type, 'card');
  const jp = await parseGeneric(file('x.csv', '種類,タイトル,カード番号\nクレジットカード,V,4111\n'), {});
  assert.deepEqual(jp.items[0].fields, { number: '4111' });
  assert.equal((await parseGeneric(file('x.csv', 'Item Type,Name,Host\nserver,S,h.test\n'), {})).items[0].fields.host, 'h.test');
  // still rejected: no type column, a type column with nothing it can fill, unrelated columns
  await assert.rejects(parseGeneric(file('x.csv', 'title,number,expiry\nV,4111,12/30\n'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', 'type,title,note\ncard,V,hi\n'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', 'type,a,b\n1,2,3\n'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', '種類,タイトル\nx,y\n'), {}), invalid); // 種類 is also the database "type" label, but it is the type column itself
});

test('generic: English synonyms, e-mail alongside a user name, bare base32 TOTP', async () => {
  const { items } = await parseGeneric(fxFile('generic/english.csv'), {});
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.title, 'GitHub');
  assert.equal(a.url, 'https://github.com');
  assert.equal(a.username, 'alice');
  assert.equal(a.password, 'pw "1"');
  assert.equal(a.note, 'note, with comma');
  assert.deepEqual(a.extra, [{ label: 'メール', value: 'alice@example.com', secret: false }]);
  assert.equal(a.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(a.fav, true);
  assert.equal(items[1].username, 'bob@example.com');
  assert.equal(items[1].fav, false);
});

test('generic: Bitwarden-style CSV; rows with only a note become secure notes', async () => {
  const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
    + 'Work,1,login,GitHub,,,0,https://github.com,alice,pw,otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP\n'
    + ',0,note,Memo,remember this,,0,,,,\n';
  const { items, warnings } = await parseGeneric(file('bw.csv', csv), {});
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://github.com');
  assert.equal(items[0].fav, true);
  assert.equal(items[0].totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(items[1].type, 'note');
  assert.equal(items[1].title, 'Memo');
  assert.equal(items[1].note, 'remember this');
  assert.match(warnings[0], /folder/);
});

test('generic: acceptance rules and wrong files', async () => {
  // password alone is enough
  const p = await parseGeneric(file('x.csv', 'Pass\nsecret\n'), {});
  assert.equal(p.items[0].password, 'secret');
  // url + username is enough
  const u = await parseGeneric(file('x.csv', 'Site;User\nhttps://a.test;bob\n'), {});
  assert.equal(u.items[0].username, 'bob');
  assert.equal(u.items[0].url, 'https://a.test');
  // username alone, url alone, unrelated columns are not
  await assert.rejects(parseGeneric(file('x.csv', 'username,note\nbob,hi\n'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', 'url,note\nhttps://a.test,hi\n'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', 'a,b,c\n1,2,3\n'), {}), (e) => invalid(e) && /列が見つかりません/.test(e.message));
  await assert.rejects(parseGeneric(fxFile('kaspersky/export.txt'), {}), invalid);
  await assert.rejects(parseGeneric(file('x.csv', ''), {}), invalid);
});

test('generic: tab and semicolon delimited files, wide characters in headers', async () => {
  const tsv = await parseGeneric(file('x.tsv', 'ＵＲＬ\tユーザー名\tパスワード\nhttps://a.test\tbob\tpw\n'), {});
  assert.equal(tsv.items[0].username, 'bob');
  assert.equal(tsv.items[0].password, 'pw');
});

// ---- through parseImport (index.js loader map) ----

test('parseImport: brave / safari / generic use the new modules and keep their source id', async () => {
  const brave = await parseImport({ source: 'brave', file: fxFile('chromium/chrome.csv') });
  assert.equal(brave.source, 'brave');
  assert.equal(brave.items.length, 3);
  const safari = await parseImport({ source: 'safari', file: fxFile('apple/passwords.csv') });
  assert.equal(safari.items.length, 4);
  const generic = await parseImport({ source: 'generic', file: fxFile('generic/english.csv') });
  assert.equal(generic.items.length, 2);
  await assert.rejects(parseImport({ source: 'firefox', file: fxFile('apple/passwords.csv') }), invalid);
});

// ---- detect.js ----

const zipOf = (files) => ({ name: 'export.zip', bytes: makeZip(files) });

// one sample per source id in SOURCES (pgp is the wrapper itself and is covered separately)
const SAMPLES = {
  '1password': () => zipOf({ 'export.attributes': fxText('detect/1password/export.attributes'), 'export.data': fxText('detect/1password/export.data') }),
  apple: () => fxFile('apple/passwords.csv'),
  bitwarden: () => fxFile('detect/bitwarden/data.json'),
  brave: () => fxFile('chromium/chrome.csv'),
  chrome: () => fxFile('chromium/chrome.csv'),
  dashlane: () => fxFile('detect/dashlane/credentials.csv'),
  edge: () => fxFile('chromium/edge-no-note.csv'),
  enpass: () => fxFile('detect/enpass/enpass.json'),
  firefox: () => fxFile('firefox/logins.csv'),
  kaspersky: () => fxFile('kaspersky/export.txt'),
  keepass: () => fxFile('detect/keepass/keepass.xml'),
  keeper: () => fxFile('detect/keeper/keeper.json'),
  lastpass: () => fxFile('lastpass/export.csv'),
  nordpass: () => fxFile('nordpass/export.csv'),
  protonpass: () => zipOf({ 'Proton Pass/data.json': fxText('detect/protonpass/data.json') }),
  roboform: () => fxFile('roboform/export.csv'),
  safari: () => fxFile('apple/safari-old.csv'),
  generic: () => fxFile('generic/japanese.csv'),
};
// Same-format sources share a module, so they are detected as its canonical id.
const DETECTED_AS = { brave: 'chrome', edge: 'chrome', safari: 'apple' };

test('detect: a sample for every source id', async () => {
  for (const s of SOURCES.filter((x) => x.id !== 'pgp')) {
    assert.ok(SAMPLES[s.id], 'missing detect sample for ' + s.id);
    assert.equal(await detectSource(SAMPLES[s.id]()), DETECTED_AS[s.id] || s.id, s.id);
  }
});

test('detect: ZIP archives are opened', async () => {
  assert.equal(await detectSource(zipOf({ 'export.data': '{}', 'export.attributes': '{}' })), '1password');
  assert.equal(await detectSource(zipOf({ '1password-export/export.data': '{}' })), '1password');
  assert.equal(await detectSource(zipOf({ 'Proton Pass/data.json': fxText('detect/protonpass/data.json') })), 'protonpass');
  assert.equal(await detectSource(zipOf({ 'data.json': fxText('detect/protonpass/data.json') })), 'protonpass');
  assert.equal(await detectSource(zipOf({ 'data.json': fxText('detect/bitwarden/data.json'), 'attachments/a.txt': 'x' })), 'bitwarden');
  assert.equal(await detectSource(zipOf({ 'credentials.csv': fxText('detect/dashlane/credentials.csv'), 'securenotes.csv': 'title,note\n' })), 'dashlane');
  assert.equal(await detectSource(zipOf({ 'readme.txt': 'nothing here' })), null);
  assert.equal(await detectSource({ name: 'bad.zip', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) }), null);
});

test('detect: JSON shapes', async () => {
  assert.equal(await detectSource(fxFile('detect/bitwarden/encrypted.json')), 'bitwarden');
  assert.equal(await detectSource(file('x.json', '{"encrypted":false,"folders":[],"items":[]}')), 'bitwarden');
  assert.equal(await detectSource(fxFile('detect/enpass/enpass.json')), 'enpass');
  assert.equal(await detectSource(fxFile('detect/keeper/keeper.json')), 'keeper');
  assert.equal(await detectSource(file('data.json', fxText('detect/protonpass/data.json'))), 'protonpass');
  assert.equal(await detectSource(file('x.json', '{"AUTHENTIFIANT":[{"title":"t","password":"p"}],"SECURENOTE":[]}')), 'dashlane'); // legacy Dashlane
  assert.equal(await detectSource(zipOf({ 'dashlane/export.json': '{"AUTHENTIFIANT":[]}' })), 'dashlane');
  assert.equal(await detectSource(file('x.json', '{"hello":"world"}')), null);
  assert.equal(await detectSource(file('x.json', '[1,2,3]')), null);
  assert.equal(await detectSource(file('x.json', '{broken')), null);
});

test('detect: 1pif, KeePass XML, Kaspersky text', async () => {
  assert.equal(await detectSource(fxFile('detect/1password/sample.1pif')), '1password');
  assert.equal(await detectSource(file('x.xml', '<?xml version="1.0"?><other/>')), null);
  assert.equal(await detectSource(file('x.xml', '﻿<?xml version="1.0"?>\n<KeePassFile><Root/></KeePassFile>')), 'keepass');
  const bom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fxText('kaspersky/export.txt').replace(/\n/g, '\r\n'))]));
  assert.equal(await detectSource({ name: 'x.txt', bytes: bom }), 'kaspersky');
  assert.equal(await detectSource(file('x.txt', 'Notes\n\nName: only a note\nText: body\n---\n')), 'kaspersky');
  assert.equal(await detectSource(file('x.txt', 'Name: no heading\nText: body\n')), null);
});

test('detect: CSV header fingerprints, most specific first', async () => {
  assert.equal(await detectSource(fxFile('detect/protonpass/export.csv')), 'protonpass'); // has name,url,username,password too
  assert.equal(await detectSource(fxFile('apple/safari-old.csv')), 'apple');
  assert.equal(await detectSource(fxFile('chromium/edge-no-note.csv')), 'chrome');
  assert.equal(await detectSource(file('x.csv', 'name,url,username,password,note\n')), 'chrome');
  assert.equal(await detectSource(file('x.csv', 'name,url,username,password,note,totp,vault,favorite\nA,https://a.test,u,p,,,Personal,1\n')), 'generic'); // Akari's own CSV
  assert.equal(await detectSource(file('x.csv', 'url,username,password,extra,name,grouping,fav\n')), 'lastpass');
  assert.equal(await detectSource(file('x.csv', 'Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\n')), 'roboform');
  assert.equal(await detectSource(file('x.csv', 'url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged\n')), 'firefox');
  assert.equal(await detectSource(file('x.csv', 'a,b,c\n1,2,3\n')), null);
  assert.equal(await detectSource(file('x.csv', 'username,note\nbob,hi\n')), null);
});

test('detect: a type column makes a title/url/username/password CSV generic, not Apple', async () => {
  assert.equal(await detectSource(file('x.csv', 'Title,URL,Username,Password,Notes,OTPAuth\n')), 'apple'); // exact Apple header
  assert.equal(await detectSource(file('x.csv', 'Title,URL,Username,Password\nA,https://a.test,u,p\n')), 'apple');
  assert.equal(await detectSource(file('x.csv', 'type,title,url,username,password,note\ncard,A,,,,\n')), 'generic');
  assert.equal(await detectSource(file('x.csv', 'Title,URL,Username,Password,Notes,OTPAuth,Item Type\n')), 'generic');
  assert.equal(await detectSource(file('x.csv', 'title,url,username,password,種類\n')), 'generic');
  assert.equal(await detectSource(fxFile('generic/akari-types.csv')), 'generic');
  // a typed CSV with only card columns is generic too; a type column alone is nothing
  assert.equal(await detectSource(file('x.csv', 'type,title,number,expiry\ncard,V,4111,12/30\n')), 'generic');
  assert.equal(await detectSource(file('x.csv', 'type,note\nx,y\n')), null);
  // formats with their own type column keep winning
  assert.equal(await detectSource(fxFile('nordpass/export.csv')), 'nordpass');
  assert.equal(await detectSource(fxFile('detect/protonpass/export.csv')), 'protonpass');
});

test('detect: nothing recognisable, PGP, empty and binary input', async () => {
  assert.equal(await detectSource(file('x.txt', '')), null);
  assert.equal(await detectSource(file('x.txt', 'just some text\nwith lines')), null);
  assert.equal(await detectSource({ name: 'x.bin', bytes: new Uint8Array([0, 1, 2, 3, 250, 251, 252]) }), null);
  assert.equal(await detectSource(file('x.asc', '-----BEGIN PGP MESSAGE-----\n\nabc\n-----END PGP MESSAGE-----\n')), null);
  // Buffers (Node) work as well as plain Uint8Arrays
  assert.equal(await detectSource({ name: 'x.csv', bytes: readFileSync(new URL('../fixtures/import/lastpass/export.csv', import.meta.url)) }), 'lastpass');
});

// ---- hostile input: must stay fast and fail cleanly ----

const fast = async (fn, ms = 200) => {
  const t = performance.now();
  const r = await fn();
  const dt = performance.now() - t;
  assert.ok(dt < ms, `took ${dt.toFixed(0)} ms (limit ${ms})`);
  return r;
};
const bytesOf = (s) => ({ name: 'x.txt', bytes: new TextEncoder().encode(s) });

test('kaspersky / detect: 160 KB of blank lines is not quadratic', async () => {
  const blanks = ' \n'.repeat(80000);
  assert.equal(await fast(() => detectSource(bytesOf(blanks))), null);
  await fast(() => assert.rejects(parseKaspersky(bytesOf(blanks), {}), invalid));
  // blank lines between the heading and the entry, and inside a block, are still fine
  const real = 'Websites\n\n' + blanks + 'Website name: x\nWebsite URL: https://a.test\nLogin: u\nPassword: p\n' + blanks;
  assert.equal(await fast(() => detectSource(bytesOf(real))), 'kaspersky');
  const out = await fast(() => parseKaspersky(bytesOf(real), {}));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].username, 'u');
});

test('kaspersky / detect: very long whitespace lines, separators and headings', async () => {
  const wide = ' '.repeat(160000);
  assert.equal(await fast(() => detectSource(bytesOf(wide + 'x'))), null);
  await fast(() => assert.rejects(parseKaspersky(bytesOf(wide + 'x'), {}), invalid));
  const tail = await fast(() => parseKaspersky(bytesOf('Notes\n\nName: a\nText: b\n' + wide + '\n---\n'), {}));
  assert.equal(tail.items[0].note, 'b');
  await fast(() => assert.rejects(parseKaspersky(bytesOf('---\n'.repeat(40000)), {}), invalid));
  const headings = await fast(() => detectSource(bytesOf('Websites\n\n'.repeat(20000))));
  assert.equal(headings, null); // headings alone are not entries
  assert.equal(await fast(() => detectSource(bytesOf(wide + '\nNotes' + wide + '\n'))), null);
});

test('lastpass / generic / detect: long whitespace in CSV cells and headers stays linear', async () => {
  const csv = 'url,username,password,extra,name\nhttp://sn,,,"NoteType:X\n' + ' \n'.repeat(80000) + 'Key:v",n\n';
  const r = await fast(() => parseLastpass(file('x.csv', csv), {}));
  assert.equal(r.items[0].note, 'NoteType: X\nKey: v');
  const wideHeader = ' '.repeat(160000) + ',a\n1,2\n';
  assert.equal(await fast(() => detectSource(file('x.csv', wideHeader))), null);
  await fast(() => assert.rejects(parseGeneric(file('x.csv', wideHeader), {}), invalid));
  const wideCell = `url,username,password,note\nhttps://a.test,u,p,"${' '.repeat(160000)}"\n`;
  assert.equal((await fast(() => parseGeneric(file('x.csv', wideCell), {}))).items.length, 1);
});

test('detect: oversized CSV header and deeply nested JSON do not hang or throw', async () => {
  const columns = Array.from({ length: 1000 }, (_, i) => 'c' + i).join(',');
  assert.equal(await fast(() => detectSource(file('x.csv', columns + '\n1,2\n'))), null);
  assert.equal(await fast(() => detectSource(file('x.json', '['.repeat(100000) + ']'.repeat(100000)))), null);
});

test('csv caps: too many rows is UNSUPPORTED through the importers', async () => {
  const rows = 'Title,URL,Username,Password\n' + 'a,https://a.test,u,p\n'.repeat(50001);
  await assert.rejects(parseApple(file('x.csv', rows), {}), (e) => e.name === 'ImportError' && e.code === 'UNSUPPORTED');
});

// ---- generic: prototype-looking column names ----

test('generic: columns named constructor / __proto__ / toString never leak Object members', async () => {
  const csv = 'url,username,password,constructor,__proto__,toString,hasOwnProperty\nhttps://a.test,u,p,c,d,e,f\n';
  const { items } = await parseGeneric(file('x.csv', csv), {});
  assert.equal(items.length, 1);
  assert.equal(items[0].note, '');
  assert.doesNotMatch(JSON.stringify(items[0].extra), /function|\[object|native code/);
  assert.deepEqual(items[0].extra.map((e) => [e.label, e.value]), [['constructor', 'c'], ['__proto__', 'd'], ['toString', 'e'], ['hasOwnProperty', 'f']]);
  assert.equal(items[0].username, 'u');
});

test('lastpass: a NoteType named like an Object member is just an unknown note', async () => {
  const csv = 'url,username,password,extra,name\nhttp://sn,,,"NoteType:constructor\nKey:v",n\n';
  const r = await parseLastpass(file('x.csv', csv), {});
  assert.equal(r.items[0].type, 'note');
  assert.equal(r.items[0].note, 'NoteType: constructor\nKey: v');
});

// ---- detect: ZIP limits ----

// patch a ZIP's headers: oversized entries / entry count
const patchZip = (bytes, { usize, count } = {}) => {
  const b = Buffer.from(bytes);
  for (let i = 0; i + 4 <= b.length; i++) {
    if (usize !== undefined && b.readUInt32LE(i) === 0x02014b50) b.writeUInt32LE(usize, i + 24);
    if (count !== undefined && b.readUInt32LE(i) === 0x06054b50) { b.writeUInt16LE(count, i + 8); b.writeUInt16LE(count, i + 10); }
  }
  return { name: 'x.zip', bytes: new Uint8Array(b) };
};
const unsupported = (e) => e.name === 'ImportError' && e.code === 'UNSUPPORTED';

test('detect: ZIP size / entry caps surface as UNSUPPORTED, not as "unknown format"', async () => {
  const bw = fxText('detect/bitwarden/data.json');
  // sanity: the unpatched archive is detected
  assert.equal(await detectSource(zipOf({ 'data.json': bw })), 'bitwarden');
  // the entry that decides the format claims to be 128 MB
  await assert.rejects(detectSource(patchZip(zipOf({ 'data.json': bw }).bytes, { usize: 128 * 2 ** 20 })), unsupported);
  // far too many entries
  await assert.rejects(detectSource(patchZip(zipOf({ 'data.json': bw }).bytes, { count: 10001 })), unsupported);
  // a header that lies about the size is just a broken archive
  assert.equal(await detectSource(patchZip(zipOf({ 'data.json': bw }).bytes, { usize: 3 })), null);
  // an oversized entry that is only probed (unrelated .json) is skipped, not fatal
  assert.equal(await detectSource(patchZip(zipOf({ 'notes.json': '{}', 'readme.txt': 'x' }).bytes, { usize: 128 * 2 ** 20 })), null);
});
