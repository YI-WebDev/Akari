// Import/export through the real service worker, and the vendored OpenPGP.js running
// inside an extension page under the extension CSP (script-src 'self' 'wasm-unsafe-eval':
// WebAssembly for OpenPGP.js's Argon2 S2K, no JS eval).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, extensionMessenger, MASTER } from './helpers.js';
import { csvToObjects } from '../../extension/src/lib/import/csv.js';
import { createCredential } from '../../extension/src/lib/webauthn.js';
import { encryptPgp } from '../../extension/src/lib/pgp.js';
import * as openpgp from '../../extension/src/third_party/openpgp.js';
import { toB64url, randomBytes } from '../../extension/src/shared/bytes.js';

let ext, send, page;

// GnuPG 2.4.7 `gpg --symmetric --cipher-algo AES256 --armor`, passphrase "gnupg-pass".
const GPG_ARMORED = `-----BEGIN PGP MESSAGE-----

jA0ECQMIxAMoVCotbrjw0lgBfqi3+m9drUIu2Knilk4qIc67HoorMeFu+pW5mBci
OZriAa57aYG4Co/leM6d1GeySmBXSfhdQMrswN9/+ndTRe14rvdEFNZIKnnnF6DK
RsTfV27obrj9
=Auuc
-----END PGP MESSAGE-----
`;

before(async () => {
  ext = await launch();
  ({ send, page } = await extensionMessenger(ext));
  assert.equal((await send('vault/setup', { masterPassword: MASTER })).ok, true);
});
after(async () => ext?.close());

async function passkey(rpId) {
  const cred = await createCredential({ rpId, userHandle: randomBytes(16), clientDataHash: randomBytes(32) });
  return {
    credentialId: toB64url(cred.credentialId), rpId, userHandle: toB64url(randomBytes(16)),
    userName: 'hina', userDisplayName: 'Hina', privateKey: toB64url(cred.privateKey), createdAt: Date.UTC(2025, 0, 1),
  };
}

test('vault/importItems counts added, duplicates, invalid and passkeys', async () => {
  let r = await send('vault/saveItem', { item: { title: 'Existing', url: 'https://example.com', username: 'haruka', password: 'pw-0' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pk = await passkey('github.com');
  const items = [
    { type: 'login', title: 'example.com', url: 'https://example.com/login', username: 'haruka', password: 'pw-0', passkeys: [] },
    { type: 'login', title: 'GitHub', url: 'https://github.com', username: 'hina', password: 'gh, "pw"', fav: true, passkeys: [pk, { ...pk }] },
    { type: 'login', title: 'Broken passkey', url: 'https://gitlab.com', username: 'x', password: 'y',
      passkeys: [{ ...(await passkey('gitlab.com')), privateKey: toB64url(randomBytes(140)) }] },
    { type: 'note', title: '暗証番号', note: '1234\n5678', passkeys: [] },
    { type: 'note', title: '暗証番号', note: '1234\n5678', passkeys: [] },
    { type: 'login', title: 'Too long', password: 'x'.repeat(2000), passkeys: [] },
    { type: 'login', title: 'TOTP', url: 'https://totp.example', username: 't', totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'Ex', label: 't' }, passkeys: [] },
  ];
  r = await send('vault/importItems', { items, vault: 'work' });
  assert.deepEqual(r, { ok: true, data: { added: 4, duplicates: 2, invalid: 1, passkeys: 1 } });

  r = await send('vault/importItems', { items, vault: 'no-such-vault' });
  assert.equal(r.error.code, 'INVALID');

  r = await send('vault/getAll');
  assert.equal(r.data.items.length, 5);
  const gh = r.data.items.find((i) => i.title === 'GitHub');
  assert.equal(gh.vault, 'work');
  assert.equal(gh.passkeys.length, 1);
  assert.ok(!('privateKey' in gh.passkeys[0]), 'private key never leaves the SW');
  assert.equal(r.data.items.find((i) => i.title === 'Broken passkey').passkeys.length, 0);

  // Nothing decrypted in storage.
  const local = await ext.sw.evaluate(() => chrome.storage.local.get(null));
  assert.ok(!JSON.stringify(local).includes('暗証番号'));
});

test('vault/exportPlain: wrong master password refused; CSV and Bitwarden JSON parse back', async () => {
  let r = await send('vault/exportPlain', { format: 'csv', masterPassword: 'wrong password' });
  assert.equal(r.error.code, 'BAD_PASSWORD');

  r = await send('vault/exportPlain', { format: 'csv', masterPassword: MASTER });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.data.filename, /^akari-export-\d{8}\.csv$/);
  assert.equal(r.data.count, 5);
  const { headers, records } = csvToObjects(r.data.text);
  assert.deepEqual(headers, ['name', 'url', 'username', 'password', 'note', 'totp', 'vault', 'favorite']);
  const gh = records.find((x) => x.name === 'GitHub');
  assert.deepEqual([gh.password, gh.vault, gh.favorite], ['gh, "pw"', '仕事', 'true']);
  assert.match(records.find((x) => x.name === 'TOTP').totp, /^otpauth:\/\/totp\/Ex:t\?secret=JBSWY3DPEHPK3PXP/);
  assert.equal(records.find((x) => x.name === '暗証番号').note, '1234\n5678');

  // Re-importing the CSV rows changes nothing: all duplicates.
  const back = records.map((x) => ({
    type: x.url || x.username || x.password ? 'login' : 'note', title: x.name, url: x.url, username: x.username,
    password: x.password, note: x.note, passkeys: [],
  }));
  r = await send('vault/importItems', { items: back, vault: 'personal' });
  assert.deepEqual(r.data, { added: 0, duplicates: 5, invalid: 0, passkeys: 0 });

  r = await send('vault/exportPlain', { format: 'bitwarden', masterPassword: MASTER });
  assert.match(r.data.filename, /^akari-export-\d{8}\.json$/);
  const bw = JSON.parse(r.data.text);
  assert.equal(bw.encrypted, false);
  assert.ok(bw.folders.some((f) => f.id === 'work' && f.name === '仕事'));
  const item = bw.items.find((i) => i.name === 'GitHub');
  assert.equal(item.type, 1);
  assert.equal(item.folderId, 'work');
  const [fido] = item.login.fido2Credentials;
  assert.equal(fido.rpId, 'github.com');
  assert.equal(fido.keyType, 'public-key');
  assert.match(fido.credentialId, /^b64\./);
  // keyValue is a usable PKCS8 P-256 key.
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(fido.keyValue, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  assert.equal(key.algorithm.namedCurve, 'P-256');
  assert.equal(bw.items.find((i) => i.name === '暗証番号').type, 2);
});

test('vendored OpenPGP.js loads in an extension page and round-trips under the extension CSP', async () => {
  const argon2 = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'argon' }),
    passwords: ['pw'],
    config: { s2kType: openpgp.enums.s2k.argon2, s2kArgon2Params: { passes: 1, parallelism: 1, memoryExponent: 10 } },
  });
  const fromNode = await encryptPgp('name,url\r\n日本語,https://example.com\r\n', 'node-pass', { filename: 'x.csv' });
  const out = await page.evaluate(async ([gpg, nodeMsg, argonMsg]) => {
    const { encryptPgp, decryptPgp } = await import(chrome.runtime.getURL('src/lib/pgp.js'));
    const td = new TextDecoder();
    const te = new TextEncoder();
    const armored = await encryptPgp('ページ内,テスト\r\n', 'page-pass', { filename: 'akari-export.csv' });
    const codeOf = (p) => p.then(() => 'OK', (e) => e.code || String(e));
    return {
      roundTrip: td.decode(await decryptPgp(te.encode(armored), 'page-pass')),
      wrong: await codeOf(decryptPgp(te.encode(armored), 'nope')),
      gnupg: td.decode(await decryptPgp(te.encode(gpg), 'gnupg-pass')),
      node: td.decode(await decryptPgp(te.encode(nodeMsg), 'node-pass')),
      argon2: td.decode(await decryptPgp(te.encode(argonMsg), 'pw')),
      evalBlocked: (() => { try { new Function('return 1'); return false; } catch { return true; } })(),
      armored,
    };
  }, [GPG_ARMORED, fromNode, argon2]);
  assert.equal(out.roundTrip, 'ページ内,テスト\r\n');
  assert.equal(out.wrong, 'BAD_PASSWORD');
  assert.equal(out.gnupg, 'from,gnupg\r\nテスト,1\r\n');
  assert.equal(out.node, 'name,url\r\n日本語,https://example.com\r\n');
  assert.equal(out.argon2, 'argon', 'Argon2 S2K (e.g. newer Proton exports) decrypts via WebAssembly');
  assert.equal(out.evalBlocked, true, 'the CSP must still block JS eval');
  // What the page wrote opens in Node too.
  const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: out.armored }), passwords: ['page-pass'], format: 'binary' });
  assert.equal(new TextDecoder().decode(data), 'ページ内,テスト\r\n');
  assert.deepEqual(ext.errors, []);
});
