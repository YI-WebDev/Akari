// Proton Pass passkeys: decoding Proton's record, carrying the key over to Akari, and signing
// for the public key the site registered with Proton. Also the MessagePack reader they need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createHash, verify as nodeVerify, randomBytes } from 'node:crypto';
import { decodeMsgpack, MsgpackError } from '../../extension/src/lib/import/msgpack.js';
import * as protonpass from '../../extension/src/lib/import/importers/protonpass.js';
import { defaultData, addImportedItems } from '../../extension/src/lib/vault.js';
import { getAssertion } from '../../extension/src/lib/webauthn.js';
import { msgpack, protonPasskeyEntry, T, int128, bytes } from './_proton-passkey.js';

const enc = (s) => new TextEncoder().encode(s);

// ---- MessagePack reader -----------------------------------------------------------------

test('msgpack: the types Proton uses decode, including Vec<u8> as arrays of numbers', () => {
  const v = decodeMsgpack(msgpack({ s: 'パスキー', n: [0, 127, 128, 255, 300, 70000, -1, -32, -100], z: null, b: true, nested: { a: [1, [2, [3]]] } }));
  assert.deepEqual({ ...v, nested: { ...v.nested } }, { s: 'パスキー', n: [0, 127, 128, 255, 300, 70000, -1, -32, -100], z: null, b: true, nested: { a: [1, [2, [3]]] } });
  assert.deepEqual([...decodeMsgpack(Uint8Array.of(0xc4, 3, 1, 2, 3))], [1, 2, 3]); // bin 8
  assert.equal(decodeMsgpack(Uint8Array.of(0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0)), 1.5);
  assert.equal(decodeMsgpack(Uint8Array.of(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe)), -2);
  assert.deepEqual(decodeMsgpack(Uint8Array.of(0xd4, 7, 9)), { ext: 7, data: Uint8Array.of(9) });
  const big = new Array(20).fill(5);
  assert.deepEqual(decodeMsgpack(msgpack(big)), big); // array 16
  // Map keys never reach Object.prototype.
  const m = decodeMsgpack(msgpack({ __proto__: 1, constructor: 2 }));
  assert.equal(Object.getPrototypeOf(m), null);
});

test('msgpack: broken or hostile input throws MsgpackError without allocating what it claims', () => {
  const bad = [
    [],                                   // nothing
    [0x92, 1],                            // array of 2, one element
    [0xdd, 0xff, 0xff, 0xff, 0xff],       // array of 4 billion, no elements
    [0xdf, 0xff, 0xff, 0xff, 0xff],       // map of 4 billion
    [0xc6, 0xff, 0xff, 0xff, 0xff, 1],    // bin of 4 GB
    [0xdb, 0x7f, 0xff, 0xff, 0xff],       // str of 2 GB
    [0xa2, 0xff, 0xfe],                   // invalid UTF-8
    [0xc1],                               // never-used byte
    [0x01, 0x02],                         // trailing bytes
    [...new Array(40).fill(0x91), 0],     // nested too deeply
  ];
  for (const b of bad) assert.throws(() => decodeMsgpack(Uint8Array.from(b)), MsgpackError, JSON.stringify(b.slice(0, 6)));
  assert.throws(() => decodeMsgpack('not bytes'), MsgpackError);
});

// ---- Proton passkeys ----------------------------------------------------------------------

async function p256() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return crypto.subtle.exportKey('jwk', pair.privateKey);
}

const RP = 'shop.example.jp';

/** A Proton Pass data.json with one login per entry of `logins` ({ title, username, passkeys }). */
function protonJson(logins) {
  return {
    encrypted: false,
    version: '1.30.0',
    userId: 'user-1',
    vaults: {
      'share-1': {
        name: 'Personal',
        items: logins.map((l, i) => ({
          itemId: 'item-' + i,
          shareId: 'share-1',
          data: {
            metadata: { name: l.title, note: '', itemUuid: 'uuid-' + i },
            extraFields: [],
            type: 'login',
            content: {
              itemEmail: '', itemUsername: l.username, password: l.password ?? '', urls: [`https://${RP}/`],
              autofillUrls: [{ url: `https://${RP}/`, mode: 1 }], totpUri: '', passkeys: l.passkeys,
            },
          },
          state: 1, aliasEmail: null, contentFormatVersion: 6, createTime: 1700000000, modifyTime: 1710000000, pinned: false,
        })),
      },
    },
  };
}

const parse = (json) => protonpass.parse({ name: 'data.json', bytes: enc(JSON.stringify(json)) }, {});

/** WebAuthn assertion check with node:crypto against the public key the site got from Proton. */
async function signsFor(stored, jwk) {
  const clientDataJSON = enc(JSON.stringify({ type: 'webauthn.get', challenge: 'Y2hhbGxlbmdl', origin: `https://${RP}` }));
  const hash = createHash('sha256').update(clientDataJSON).digest();
  const { authenticatorData, signature, credentialId, userHandle } = await getAssertion({ passkey: stored, rpId: RP, clientDataHash: hash });
  const sitesKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  return {
    ok: nodeVerify('sha256', Buffer.concat([authenticatorData, hash]), { key: sitesKey, dsaEncoding: 'der' }, signature),
    credentialId: Buffer.from(credentialId).toString('base64url'),
    userHandle: Buffer.from(userHandle).toString('base64url'),
  };
}

test('Proton Pass passkey → Akari passkey that signs for the key the site registered', async () => {
  const jwk = await p256();
  const credentialId = randomBytes(32);
  const userHandle = randomBytes(16);
  const out = await parse(protonJson([{
    title: 'Shop', username: 'hanako', password: 'pw-1',
    passkeys: [protonPasskeyEntry({ key: jwk, credentialId, rpId: RP, userHandle, userName: 'hanako@example.jp', userDisplayName: '花子', createTime: 1715000000 })],
  }]));
  assert.deepEqual(out.warnings, []);
  const [pk, ...rest] = out.items[0].passkeys;
  assert.equal(rest.length, 0);
  assert.equal(pk.credentialId, credentialId.toString('base64url'));
  assert.equal(pk.userHandle, userHandle.toString('base64url'));
  assert.equal(pk.rpId, RP);
  assert.equal(pk.userName, 'hanako@example.jp');
  assert.equal(pk.userDisplayName, '花子');
  assert.equal(pk.createdAt, 1715000000 * 1000);

  // Through the vault import (public key derived from the private key), then a sign-in.
  const data = defaultData(1);
  const res = await addImportedItems(data, out.items, data.vaults[0].id, 2);
  assert.deepEqual(res, { added: 1, duplicates: 0, invalid: 0, passkeys: 1 });
  const stored = data.items[0].passkeys[0];
  const a = await signsFor(stored, jwk);
  assert.equal(a.ok, true, 'signature verifies with the public key from Proton');
  assert.equal(a.credentialId, credentialId.toString('base64url'));
  assert.equal(a.userHandle, userHandle.toString('base64url'));
});

test('Proton Pass passkeys: ids from inside the record win; outer copies fill in', async () => {
  const jwk = await p256();
  const inner = randomBytes(20), outer = randomBytes(20), user = randomBytes(8);
  const entry = protonPasskeyEntry({ key: jwk, credentialId: inner, rpId: RP, userHandle: user });
  entry.credentialId = outer.toString('base64');
  // No user handle inside the record: the userHandle / userId fields are used.
  const noUhd = protonPasskeyEntry({ key: jwk, credentialId: randomBytes(16), rpId: RP, userHandle: null });
  noUhd.userHandle = '';
  noUhd.userId = user.toString('base64');
  const out = await parse(protonJson([{ title: 'A', username: 'a', passkeys: [entry, noUhd] }]));
  const [first, second] = out.items[0].passkeys;
  assert.equal(first.credentialId, inner.toString('base64url'));
  assert.equal(second.userHandle, user.toString('base64url'));
});

test('Proton Pass passkeys Akari cannot use are counted, the login itself is kept', async () => {
  const jwk = await p256();
  const ok = protonPasskeyEntry({ key: jwk, credentialId: randomBytes(16), rpId: RP, userHandle: randomBytes(8) });
  const ed25519 = protonPasskeyEntry({
    key: jwk, credentialId: randomBytes(16), rpId: RP, userHandle: randomBytes(8),
    cose: {
      kty: T('assign', 'OKP'), kid: bytes([]), alg: T('assign', 'EdDSA'), kops: [], biv: bytes([]),
      par: [[T('int', -1), T('int', int128(6))], [T('int', -4), T('bytes', bytes(randomBytes(32)))]],
    },
  });
  const futureFormat = protonPasskeyEntry({ key: jwk, credentialId: randomBytes(16), rpId: RP, userHandle: randomBytes(8), version: 2 });
  const garbage = { ...ok, content: 'AAAA' };
  const notB64 = { ...ok, content: '%%%' };
  const out = await parse(protonJson([{ title: 'Mixed', username: 'm', password: 'pw', passkeys: [ok, ed25519, futureFormat, garbage, notB64, null] }]));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].passkeys.length, 1);
  assert.deepEqual(out.warnings, ['パスキー 5 件は Akari が対応していない形式（P-256 以外など）のため読み込めませんでした']);
});

test('importing Proton Pass again adds the passkeys an earlier import left out', async () => {
  const jwk = await p256();
  const passkeys = [protonPasskeyEntry({ key: jwk, credentialId: randomBytes(32), rpId: RP, userHandle: randomBytes(16), userName: 'taro' })];
  const json = protonJson([{ title: 'Shop', username: 'taro', password: 'pw-2', passkeys }, { title: 'Other', username: 'x', password: 'y', passkeys: [] }]);
  const out = await parse(json);

  // An earlier version imported the logins without their passkeys.
  const data = defaultData(1);
  const vault = data.vaults[0].id;
  await addImportedItems(data, out.items.map((it) => ({ ...it, passkeys: [] })), vault, 2);
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].passkeys.length, 0);

  const again = await addImportedItems(data, out.items, vault, 3);
  assert.deepEqual(again, { added: 0, duplicates: 2, invalid: 0, passkeys: 1 });
  assert.equal(data.items.length, 2, 'no second copy of the login');
  const shop = data.items.find((i) => i.title === 'Shop');
  assert.equal(shop.passkeys.length, 1);
  assert.equal(shop.updatedAt, 3);
  assert.equal(data.items.find((i) => i.title === 'Other').updatedAt, 2, 'untouched when nothing was added');
  assert.equal((await signsFor(shop.passkeys[0], jwk)).ok, true);

  // A third import changes nothing: the passkey is already there.
  assert.deepEqual(await addImportedItems(data, out.items, vault, 4), { added: 0, duplicates: 2, invalid: 0, passkeys: 0 });
  assert.equal(shop.passkeys.length, 1);
  assert.equal(shop.updatedAt, 3);
});
