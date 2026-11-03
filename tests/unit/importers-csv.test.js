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
  // an OTPAuth value we cannot use is kept in the note, not dropped
  assert.equal(items[3].totp, null);
  assert.match(items[3].note, /steam:\/\/ABCDEFGH/);
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
  assert.match(b.note, /Staff Area/);
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
  assert.equal(card.type, 'note');
  assert.equal(card.url, '');
  assert.deepEqual(card.note.split('\n'), [
    'NoteType: Credit Card',
    'Name On Card: Taro Yamada',
    'Type: Visa',
    'Number: 4111111111111111',
    'Security Code: 123',
    'Start Date: January,2020',
    'Expiration Date: December,2030',
    'Notes: Primary card',
    'Do not share: really',
  ]);
  const plain = byTitle(items, 'Plain note');
  assert.equal(plain.type, 'note');
  assert.equal(plain.note, 'Just a plain note');
  assert.equal(plain.fav, true);
  const steam = byTitle(items, 'Steam');
  assert.equal(steam.totp, null);
  assert.match(steam.note, /steam:\/\/ABCDEFGH/);
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
  assert.match(gh.note, /^a note\nsecond line\n\n/);
  assert.match(gh.note, /追加の URL: https:\/\/gist\.github\.com, https:\/\/github\.io/);
  assert.match(gh.note, /Recovery code: ABCD-1234/);
  assert.match(gh.note, /Plan: Pro/);

  const card = byTitle(items, 'My Card');
  assert.equal(card.type, 'note');
  assert.match(card.note, /カード名義: Taro Yamada/);
  assert.match(card.note, /カード番号: 4111111111111111/);
  assert.match(card.note, /セキュリティコード: 123/);
  assert.match(card.note, /PIN: 4321/);
  assert.match(card.note, /有効期限: 12\/30/);

  const id = byTitle(items, 'Taro');
  assert.equal(id.type, 'note');
  assert.match(id.note, /氏名: 山田 太郎/);
  assert.match(id.note, /電話番号: 090-1234-5678/);
  assert.match(id.note, /住所1: 千代田1-1/);
  assert.match(id.note, /都道府県: 東京都/);

  const note = byTitle(items, '秘密のメモ');
  assert.equal(note.type, 'note');
  assert.equal(note.note, 'ほげ\nふが');
});

test('nordpass: missing optional columns, unparseable custom_fields kept, wrong file', async () => {
  const r = await parseNordpass(file('x.csv', 'name,url,username,password,note,type,custom_fields\nA,https://a.test,u,p,n,password,not json\n'), {});
  assert.equal(r.items[0].note, 'n\n\nカスタム項目: not json');
  await assert.rejects(parseNordpass(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseNordpass(fxFile('lastpass/export.csv'), {}), invalid);
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
  assert.match(gh.note, /^メモ\n\n/);
  assert.match(gh.note, /Security answer: blue/);
  assert.match(gh.note, /項目: extra value/);
  assert.doesNotMatch(gh.note, /User ID|Password\$/); // duplicates of Login / Pwd are not repeated

  const safe = byTitle(items, 'Meeting notes');
  assert.equal(safe.type, 'note');
  assert.equal(safe.note, 'Line1\nLine2');

  const ident = byTitle(items, 'My Identity');
  assert.equal(ident.type, 'note');
  assert.equal(ident.note, 'First Name: 太郎\nLast Name: 山田\nEmail: taro@example.jp');

  assert.equal(byTitle(items, 'Bank').password, 's3cret');
});

test('roboform: no RfFieldsV2 column, extra User ID$ differing from Login is kept; wrong file', async () => {
  const r = await parseRoboform(file('x.csv', 'Name,Url,Login,Pwd,Note\nA,https://a.test,u,p,n\n'), {});
  assert.equal(r.items[0].username, 'u');
  assert.equal(r.items[0].note, 'n');
  const alt = await parseRoboform(file('x.csv', 'Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2\nA,https://a.test,,u,p,,,"User ID$,,,txt,other,Password$,,,pwd,p"\n'), {});
  assert.equal(alt.items[0].username, 'u');
  assert.match(alt.items[0].note, /User ID: other/);
  await assert.rejects(parseRoboform(fxFile('chromium/chrome.csv'), {}), invalid);
  await assert.rejects(parseRoboform(fxFile('nordpass/export.csv'), {}), invalid);
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

test('generic: Japanese headers, TOTP, favourite, unknown columns kept in the note', async () => {
  const { items, warnings } = await parseGeneric(fxFile('generic/japanese.csv'), { source: 'generic' });
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.title, '銀行');
  assert.equal(a.url, 'https://bank.example.jp');
  assert.equal(a.username, 'taro');
  assert.equal(a.password, 'p,w');
  assert.equal(a.note, 'メモ内容\n2行目\n\n電話番号: 03-1234-5678');
  assert.equal(a.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(a.fav, true);
  assert.equal(items[1].username, 'hanako@example.jp'); // メール used as the user name
  assert.equal(items[1].fav, false);
  assert.equal(warnings.length, 1); // カテゴリ is organisational and reported
  assert.match(warnings[0], /カテゴリ/);
});

test('generic: English synonyms, e-mail alongside a user name, bare base32 TOTP', async () => {
  const { items } = await parseGeneric(fxFile('generic/english.csv'), {});
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.title, 'GitHub');
  assert.equal(a.url, 'https://github.com');
  assert.equal(a.username, 'alice');
  assert.equal(a.password, 'pw "1"');
  assert.equal(a.note, 'note, with comma\n\nメール: alice@example.com');
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
  const csv = 'url,username,password,constructor,__proto__,tostring,hasownproperty\nhttps://a.test,u,p,c,d,e,f\n';
  const { items } = await parseGeneric(file('x.csv', csv), {});
  assert.equal(items.length, 1);
  assert.doesNotMatch(items[0].note, /function|\[object|native code/);
  assert.match(items[0].note, /tostring: e/);
  assert.match(items[0].note, /hasownproperty: f/);
  assert.equal(items[0].username, 'u');
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
