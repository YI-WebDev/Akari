import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, createVaultRecord, openVaultRecord, sealData, exportBackup, importBackup, normalizeData,
  mergeData, makeItem, validateItem, sanitizeItem, defaultData, normalizeUrl, checkRecord,
  addImportedItems, passkeyFromImport, MAX_IMPORT_ITEMS,
} from '../../extension/src/lib/vault.js';
import { createCredential, getAssertion } from '../../extension/src/lib/webauthn.js';
import { exportDek } from '../../extension/src/lib/crypto.js';
import { fromB64, toB64, toB64url, randomBytes } from '../../extension/src/shared/bytes.js';
import { TYPE_IDS, typeOf, hasTemplate, LIMITS } from '../../extension/src/shared/item-types.js';

const OPTS = { iterations: 1000 };
const PW = 'master-password-1';

/** A passkey with the shape passkey-service.js stores (ES256, PKCS8 private key, COSE public key). */
function samplePasskey(over = {}) {
  return {
    credentialId: toB64url(randomBytes(32)),
    rpId: 'github.com',
    userHandle: toB64url(randomBytes(16)),
    userName: 'hina',
    userDisplayName: 'Hina',
    privateKey: toB64url(randomBytes(138)),
    publicKey: toB64url(randomBytes(77)),
    alg: -7,
    signCount: 0,
    createdAt: 1000,
    lastUsedAt: null,
    ...over,
  };
}

const PRIV = samplePasskey().privateKey;

function sampleData() {
  const data = defaultData(1000);
  data.items.push(makeItem({
    title: 'GitHub', url: 'https://github.com', username: 'hina@example.jp', password: 's3cret!',
    passkeys: [samplePasskey({ privateKey: PRIV, publicKey: 'UFVC'.repeat(20) })],
  }, 1000));
  return data;
}

test('createVaultRecord → PLAN §2 shape with kdf params; no plaintext', async () => {
  const data = sampleData();
  const record = await createVaultRecord(PW, data, OPTS);
  assert.equal(record.version, 1);
  assert.equal(record.kdf.name, 'PBKDF2');
  assert.equal(record.kdf.hash, 'SHA-256');
  assert.equal(record.kdf.iterations, 1000);
  assert.equal(fromB64(record.kdf.salt).length, 16);
  for (const box of [record.wrappedKey, record.data]) {
    assert.equal(fromB64(box.iv).length, 12);
    assert.equal(typeof box.ct, 'string');
  }
  const json = JSON.stringify(record);
  for (const secret of [PW, 's3cret!', PRIV, 'hina@example.jp']) assert.ok(!json.includes(secret), secret);
});

test('default iteration count for new records is 600000', async () => {
  const record = await createVaultRecord(PW, defaultData());
  assert.equal(record.kdf.iterations, 600000);
});

test('openVaultRecord round-trip; wrong password → BAD_PASSWORD', async () => {
  const data = sampleData();
  const { record, dek } = await createVault(PW, data, OPTS);
  const opened = await openVaultRecord(record, PW);
  assert.deepEqual(opened.data, data);
  assert.deepEqual(await exportDek(opened.dek), await exportDek(dek));
  await assert.rejects(openVaultRecord(record, 'nope'), { code: 'BAD_PASSWORD' });
});

test('tampered data → INVALID; malformed record → INVALID', async () => {
  const record = await createVaultRecord(PW, sampleData(), OPTS);
  const ct = fromB64(record.data.ct);
  ct[0] ^= 0xff;
  await assert.rejects(openVaultRecord({ ...record, data: { ...record.data, ct: toB64(ct) } }, PW), { code: 'INVALID' });
  await assert.rejects(openVaultRecord({ ...record, version: 2 }, PW), { code: 'INVALID' });
  await assert.rejects(openVaultRecord({ ...record, kdf: { ...record.kdf, iterations: 1e12 } }, PW), { code: 'INVALID' });
  assert.throws(() => checkRecord(null), { code: 'INVALID' });
});

test('sealData uses a new IV each time and keeps key material', async () => {
  const data = sampleData();
  const { record, dek } = await createVault(PW, data, OPTS);
  data.items[0].title = 'GitHub (work)';
  const sealed1 = await sealData(record, dek, data);
  const sealed2 = await sealData(record, dek, data);
  assert.notEqual(sealed1.data.iv, sealed2.data.iv);
  assert.notEqual(sealed1.data.iv, record.data.iv);
  assert.deepEqual(sealed1.kdf, record.kdf);
  assert.deepEqual(sealed1.wrappedKey, record.wrappedKey);
  assert.equal((await openVaultRecord(sealed1, PW)).data.items[0].title, 'GitHub (work)');
});

test('backup export/import with the backup password', async () => {
  const data = sampleData();
  const record = await createVaultRecord(PW, data, OPTS);
  const json = exportBackup(record, Date.UTC(2026, 10, 2));
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'akari-backup');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.exportedAt, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(parsed.vault, record);
  assert.ok(!json.includes('s3cret!'));

  const imported = await importBackup(json, PW);
  assert.deepEqual(imported.vaults, data.vaults);
  assert.equal(imported.items.length, 1);
  assert.deepEqual(imported.items[0], data.items[0]);

  await assert.rejects(importBackup(json, 'wrong'), { code: 'BAD_PASSWORD' });
  await assert.rejects(importBackup('not json', PW), { code: 'INVALID' });
  await assert.rejects(importBackup(JSON.stringify({ format: 'other', version: 1, vault: record }), PW), { code: 'INVALID' });
});

test('importBackup drops invalid items', async () => {
  const data = sampleData();
  data.items.push({ id: 'bad', type: 'login', url: 'javascript:alert(1)' });
  data.items.push({ type: 'login', title: 'no id' });
  const json = exportBackup(await createVaultRecord(PW, data, OPTS));
  const imported = await importBackup(json, PW);
  assert.deepEqual(imported.items.map((i) => i.title), ['GitHub']);
});

test('normalizeData validates imported passkeys fully and drops bad ones', () => {
  const good = samplePasskey({ extra: 'dropped', lastUsedAt: 2000 });
  const bad = [
    samplePasskey({ credentialId: 'short' }),
    samplePasskey({ credentialId: 'not base64url!' }),
    samplePasskey({ userHandle: toB64url(randomBytes(65)) }),
    samplePasskey({ privateKey: toB64url(randomBytes(8)) }),
    samplePasskey({ publicKey: 42 }),
    samplePasskey({ alg: -257 }),
    samplePasskey({ rpId: '' }),
    samplePasskey({ rpId: 'Evil.COM' }),
    samplePasskey({ rpId: 'a..b' }),
    samplePasskey({ signCount: -1 }),
    samplePasskey({ createdAt: '2026' }),
    samplePasskey({ userName: 'x'.repeat(257) }),
    null,
  ];
  const raw = makeItem({ title: 'T', passkeys: [good, { ...good }, ...bad] }, 1000);
  const { items } = normalizeData({ vaults: [], items: [raw] }, 5000);
  assert.equal(items[0].passkeys.length, 1, 'duplicates by credentialId and invalid entries removed');
  const pk = items[0].passkeys[0];
  assert.ok(!('extra' in pk));
  assert.equal(pk.credentialId, good.credentialId);
  assert.equal(pk.privateKey, good.privateKey);
  assert.equal(pk.lastUsedAt, 2000);
});

test('normalizeData clamps far-future and negative timestamps to [0, now]', () => {
  const now = 1_000_000;
  const raw = makeItem({
    title: 'Future', createdAt: 9e15, updatedAt: 9e15, passwordUpdatedAt: -5, lastUsedAt: now + 1,
    passkeys: [samplePasskey({ createdAt: 9e15, lastUsedAt: 9e15 })],
  }, 1);
  const { items, updatedAt } = normalizeData({ vaults: [], items: [raw], updatedAt: 9e15 }, now);
  const it = items[0];
  assert.deepEqual([it.createdAt, it.updatedAt, it.passwordUpdatedAt, it.lastUsedAt], [now, now, 0, now]);
  assert.deepEqual([it.passkeys[0].createdAt, it.passkeys[0].lastUsedAt], [now, now]);
  assert.equal(updatedAt, now);
});

test('mergeData never replaces or adds to an existing item\'s passkeys', () => {
  const mine = samplePasskey({ rpId: 'a.com' });
  const existing = makeItem({ title: 'Mine', updatedAt: 100, passkeys: [mine] }, 50);
  const current = { ...defaultData(1), items: [existing] };
  const forged = samplePasskey({ rpId: 'a.com', credentialId: mine.credentialId, privateKey: toB64url(randomBytes(138)) });
  const sameAccount = samplePasskey({ rpId: 'a.com', userHandle: mine.userHandle });
  const fresh = samplePasskey({ rpId: 'b.com' });
  const incoming = {
    vaults: [],
    items: [
      { ...existing, title: 'Mine (newer)', updatedAt: 200, passkeys: [forged, samplePasskey()] },
      makeItem({ title: 'New', passkeys: [fresh, sameAccount, { ...forged }] }, 60),
    ],
  };
  const { data, count } = mergeData(current, incoming);
  assert.equal(count, 2);
  assert.equal(data.items[0].title, 'Mine (newer)');
  assert.deepEqual(data.items[0].passkeys, [mine], 'existing passkeys kept as-is');
  assert.deepEqual(data.items[1].passkeys.map((p) => p.credentialId), [fresh.credentialId],
    'new item keeps only passkeys whose credentialId and (rpId, userHandle) are not already present');
});

test('mergeData: newer updatedAt wins, new items/vaults added, inputs untouched', () => {
  const a = makeItem({ title: 'A', updatedAt: 100 }, 50);
  const b = makeItem({ title: 'B', updatedAt: 300 }, 50);
  const current = { ...defaultData(1), items: [a, b] };
  const incoming = {
    vaults: [{ id: 'personal', name: 'Other name', hue: 1 }, { id: 'side', name: '副業', hue: 10 }],
    items: [
      { ...a, title: 'A newer', updatedAt: 200 },
      { ...b, title: 'B older', updatedAt: 250 },
      makeItem({ title: 'C', vault: 'side' }, 60),
      makeItem({ title: 'D', vault: 'ghost' }, 60),
    ],
    updatedAt: 1,
  };
  const before = structuredClone(current);
  const { data, count } = mergeData(current, incoming);
  assert.deepEqual(current, before);
  assert.equal(count, 3);
  assert.deepEqual(data.items.map((i) => i.title), ['A newer', 'B', 'C', 'D']);
  assert.equal(data.vaults.find((v) => v.id === 'personal').name, '個人');
  assert.ok(data.vaults.some((v) => v.id === 'side'));
  assert.equal(data.items[3].vault, 'personal');
});

test('makeItem fills defaults', () => {
  const item = makeItem({ title: 'X', password: 'p' }, 1234);
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal(item.type, 'login');
  assert.equal(item.vault, 'personal');
  assert.equal(item.totp, null);
  assert.equal(item.fav, false);
  assert.deepEqual(item.passkeys, []);
  assert.equal(item.createdAt, 1234);
  assert.equal(item.updatedAt, 1234);
  assert.equal(item.passwordUpdatedAt, 1234);
  assert.equal(item.lastUsedAt, null);
  assert.ok(Number.isInteger(item.hue) && item.hue >= 0 && item.hue <= 359);
  assert.equal(makeItem({ hue: 42 }).hue, 42);
  assert.equal(makeItem({}).passwordUpdatedAt, null);
  assert.notEqual(makeItem({}).id, makeItem({}).id);
});

test('validateItem: types, caps, url normalization, totp', () => {
  assert.deepEqual(validateItem({ title: '  GitHub ', url: 'github.com/login' }), { title: 'GitHub', url: 'https://github.com/login' });
  assert.equal(validateItem({ url: 'http://localhost:8080' }).url, 'http://localhost:8080');
  assert.equal(validateItem({ url: 'localhost:8080' }).url, 'https://localhost:8080');
  assert.equal(validateItem({ url: '' }).url, '');
  assert.equal(validateItem({ id: null, title: 'x' }).id, undefined);
  for (const bad of [
    { type: 'bogus' }, { title: 'x'.repeat(201) }, { url: 'javascript:alert(1)' }, { url: 'ftp://host/x' },
    { username: 'x'.repeat(513) }, { password: 'x'.repeat(1025) }, { note: 'x'.repeat(10001) }, { title: 5 },
    { fav: 'yes' }, { hue: 360 }, { vault: '' }, { totp: { secret: '1!' } }, { totp: { secret: 'JBSWY3DPEHPK3PXP', digits: 7 } },
    { totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'MD5' } }, { totp: 'JBSWY3DPEHPK3PXP' }, null, [],
  ]) {
    assert.throws(() => validateItem(bad), { code: 'INVALID' }, JSON.stringify(bad));
  }
  assert.deepEqual(validateItem({ totp: { secret: 'jbsw y3dp ehpk 3pxp==' } }).totp, {
    secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: '', label: '',
  });
  assert.equal(validateItem({ totp: null }).totp, null);
  // non-editable fields are never passed through
  const out = validateItem({ id: 'i1', passkeys: [{ privateKey: 'x' }], createdAt: 1 });
  assert.deepEqual(out, { id: 'i1' });
  assert.equal(normalizeUrl('  example.com '), 'https://example.com');
});

test('sanitizeItem removes passkey private keys without touching the original', () => {
  const item = sampleData().items[0];
  const clean = sanitizeItem(item);
  assert.equal(clean.passkeys.length, 1);
  assert.ok(!('privateKey' in clean.passkeys[0]));
  assert.equal(clean.passkeys[0].publicKey, 'UFVC'.repeat(20));
  assert.equal(item.passkeys[0].privateKey, PRIV);
  assert.equal(clean.password, 's3cret!');
});

// ---- import from other managers ---------------------------------------------

/** An ImportedItem passkey as importers produce it: real PKCS8 key, no public key. */
async function importedPasskey(over = {}) {
  const cred = await createCredential({ rpId: over.rpId || 'github.com', userHandle: randomBytes(16), clientDataHash: randomBytes(32) });
  return {
    pk: {
      credentialId: toB64url(cred.credentialId), rpId: 'github.com', userHandle: toB64url(randomBytes(16)),
      userName: 'hina', userDisplayName: 'Hina', privateKey: toB64url(cred.privateKey), createdAt: 2000, ...over,
    },
    cred,
  };
}

test('passkeyFromImport derives the COSE public key and applies the backup checks', async () => {
  const { pk, cred } = await importedPasskey({ extra: 'x' });
  const out = await passkeyFromImport(pk, 5000);
  assert.deepEqual(Object.keys(out).sort(), ['alg', 'createdAt', 'credentialId', 'lastUsedAt', 'privateKey', 'publicKey', 'rpId',
    'signCount', 'userDisplayName', 'userHandle', 'userName']);
  assert.equal(out.publicKey, toB64url(cred.cosePublicKey));
  assert.equal(out.privateKey, pk.privateKey);
  assert.deepEqual([out.alg, out.signCount, out.createdAt, out.lastUsedAt], [-7, 0, 2000, null]);
  // Usable for sign-in.
  const a = await getAssertion({ passkey: out, rpId: 'github.com', clientDataHash: randomBytes(32) });
  assert.equal(a.signature[0], 0x30);

  assert.equal((await passkeyFromImport({ ...pk, createdAt: undefined }, 5000)).createdAt, 5000);
  assert.equal((await passkeyFromImport({ ...pk, createdAt: 9e15 }, 5000)).createdAt, 5000, 'clamped to now');
  const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign']);
  const p384Key = toB64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', p384.privateKey)));
  for (const bad of [
    null, 'str', { ...pk, privateKey: toB64url(randomBytes(138)) }, { ...pk, privateKey: p384Key },
    { ...pk, privateKey: undefined }, { ...pk, credentialId: 'short' }, { ...pk, rpId: 'Evil.COM' },
    { ...pk, userHandle: toB64url(randomBytes(65)) }, { ...pk, userName: 'x'.repeat(257) },
  ]) assert.equal(await passkeyFromImport(bad, 5000), null, String(JSON.stringify(bad)).slice(0, 80));
});

test('passkeyFromImport: rpId must be localhost or a registrable, non-public-suffix domain (no IPs)', async () => {
  const { pk } = await importedPasskey();
  for (const rpId of ['github.com', 'accounts.google.com', 'amazon.co.jp', 'user.github.io', 'localhost']) {
    assert.equal((await passkeyFromImport({ ...pk, rpId }, 5000))?.rpId, rpId, rpId);
  }
  for (const rpId of ['com', 'co.jp', 'github.io', 'appspot.com', '127.0.0.1', '10.0.0.1', '::1', '[::1]',
    'router.local', 'example.invalidtld', 'intranet', '', 'Example.com', 'a..b', null]) {
    assert.equal(await passkeyFromImport({ ...pk, rpId }, 5000), null, String(rpId));
  }
  // The addImportedItems path drops such passkeys but keeps the item.
  const data = defaultData(1000);
  const res = await addImportedItems(data, [
    { type: 'login', title: 'io', url: 'https://github.io', username: 'u', password: 'p', passkeys: [{ ...pk, rpId: 'github.io' }] },
  ], 'personal', 5000);
  assert.deepEqual(res, { added: 1, duplicates: 0, invalid: 0, passkeys: 0 });
});

test('addImportedItems: validation, duplicates (existing and in-batch), timestamps, vault', async () => {
  const data = defaultData(1000);
  data.items.push(
    makeItem({ title: 'Mine', url: 'https://github.com/login', username: 'hina', password: 'pw1' }, 1000),
    makeItem({ type: 'note', title: 'Memo', note: 'body' }, 1000),
  );
  const now = 50_000;
  const res = await addImportedItems(data, [
    { type: 'login', title: 'GitHub', url: 'https://GITHUB.com/other', username: 'hina', password: 'pw1' }, // dup of Mine (same host)
    { type: 'login', title: 'GitHub 2', url: 'github.com', username: 'hina', password: 'pw2', fav: true, createdAt: 100, updatedAt: 9e15 },
    { type: 'login', title: 'GitHub 2 again', url: 'https://github.com', username: 'hina', password: 'pw2' }, // in-batch dup
    { type: 'note', title: 'Memo', note: 'body', url: '' }, // dup note
    { type: 'note', title: 'Memo', note: 'other body' },
    { type: 'login', title: 'App', url: 'androidapp://com.example', username: 'u', password: 'p', note: 'n' },
    { title: '  ' + 'T'.repeat(300), username: 'long-title' },
    { type: 'login', title: 'TOTP', totp: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: '', label: '' } },
    { type: 'bogus', title: 'bad type' },
    { type: 'login', title: 'bad pw', password: 'x'.repeat(1025) },
    { type: 'login', title: 'bad totp', totp: { secret: '!!' } },
    { type: 'login', title: 'bad fav', fav: 'yes' },
    null,
    'string',
    { type: 'login', title: 'evil fields', id: 'fixed-id', hue: 9999, vault: 'work', passkeys: 'nope', lastUsedAt: 5 },
  ], 'family', now);
  assert.deepEqual(res, { added: 6, duplicates: 3, invalid: 6, passkeys: 0 });
  const added = data.items.slice(2);
  assert.equal(added.length, 6);
  assert.ok(added.every((it) => it.vault === 'family' && typeof it.id === 'string'));
  assert.ok(added.every((it) => (it.type === 'login' ? it.passkeys.length === 0 : !('passkeys' in it))), 'only logins hold passkeys');
  const gh2 = added.find((i) => i.title === 'GitHub 2');
  assert.equal(gh2.url, 'https://github.com');
  assert.equal(gh2.fav, true);
  assert.deepEqual([gh2.createdAt, gh2.updatedAt, gh2.passwordUpdatedAt], [100, now, now], 'updatedAt clamped to now');
  const app = added.find((i) => i.title === 'App');
  assert.equal(app.url, '');
  assert.equal(app.note, 'n\n\nURL: androidapp://com.example', 'non-http URL kept in the note');
  assert.equal(added.find((i) => i.username === 'long-title').title.length, 200, 'long titles are cut');
  assert.equal(added.find((i) => i.title === 'TOTP').totp.secret, 'JBSWY3DPEHPK3PXP');
  const evil = added.find((i) => i.title === 'evil fields');
  assert.notEqual(evil.id, 'fixed-id');
  assert.equal(evil.vault, 'family');
  assert.ok(evil.hue >= 0 && evil.hue <= 359);
  assert.equal(evil.lastUsedAt, null);
  assert.deepEqual([evil.createdAt, evil.passwordUpdatedAt], [now, null]);

  await assert.rejects(addImportedItems(data, [], 'nope', now), { code: 'INVALID' });
  await assert.rejects(addImportedItems(data, new Array(MAX_IMPORT_ITEMS + 1).fill({}), 'personal', now), { code: 'INVALID' });
  assert.equal(MAX_IMPORT_ITEMS, 20000);
});

test('addImportedItems: passkeys pass the strict checks and never duplicate credentialId or rpId+userHandle', async () => {
  const existing = await importedPasskey();
  const data = defaultData(1000);
  const mine = makeItem({ title: 'Mine', url: 'https://github.com', username: 'a', password: '1' }, 1000);
  mine.passkeys.push(await passkeyFromImport(existing.pk, 1000));
  data.items.push(mine);

  const fresh = (await importedPasskey()).pk;
  const fresh2 = (await importedPasskey({ rpId: 'example.com' })).pk;
  const sameCred = { ...(await importedPasskey()).pk, credentialId: existing.pk.credentialId };
  const sameAccount = { ...(await importedPasskey()).pk, userHandle: existing.pk.userHandle };
  const broken = { ...(await importedPasskey()).pk, privateKey: toB64url(randomBytes(138)) };
  const forMine = (await importedPasskey()).pk;
  const res = await addImportedItems(data, [
    { type: 'login', title: 'A', url: 'https://github.com', username: 'b', password: '2', passkeys: [fresh, sameCred, sameAccount, broken, { ...fresh }] },
    { type: 'login', title: 'B', url: 'https://example.com', username: 'c', password: '3', passkeys: [fresh2, { ...fresh, userHandle: toB64url(randomBytes(8)) }] },
    { type: 'login', title: 'dup of Mine', url: 'https://github.com', username: 'a', password: '1', passkeys: [forMine, { ...existing.pk }] },
    { type: 'login', title: 'bad list', username: 'd', passkeys: 'nope' },
  ], 'personal', 9000);
  assert.deepEqual(res, { added: 3, duplicates: 1, invalid: 0, passkeys: 3 });
  // The duplicate login is not added again, but the existing one gets the passkey it lacked (kept ones stay first).
  assert.deepEqual(mine.passkeys.map((p) => p.credentialId), [existing.pk.credentialId, forMine.credentialId]);
  assert.equal(mine.updatedAt, 9000);
  const [a, b] = data.items.slice(1);
  assert.deepEqual(a.passkeys.map((p) => p.credentialId), [fresh.credentialId]);
  assert.deepEqual(b.passkeys.map((p) => p.credentialId), [fresh2.credentialId], 'same credentialId later in the batch is dropped');
  assert.equal(a.passkeys[0].privateKey, fresh.privateKey);
});

// ---- item types (shared/item-types.js) ---------------------------------------

/** A valid value for every template field of `type`, by kind. */
function sampleFields(type) {
  const byKind = {
    text: (fd) => fd.key + ' value', secret: (fd) => 's3cret ' + fd.key, multiline: () => 'line 1\nline 2',
    'secret-multiline': () => '-----BEGIN KEY-----\nAAAA\n-----END KEY-----', date: () => '2030-01-31', month: () => '2030-12',
    email: () => 'hina@example.jp', tel: () => '+81 90-1234-5678', url: () => 'https://example.com/x', number: () => '5432',
    select: (fd) => fd.options[0].id,
  };
  const out = {};
  for (const fd of typeOf(type).fields) out[fd.key] = fd.format === 'card' ? '4111 1111 1111 1111' : byKind[fd.kind](fd);
  return out;
}

const bad = (item, stored, why) => assert.throws(() => validateItem(item, stored), { code: 'INVALID' }, why || JSON.stringify(item));

test('validateItem: template fields are normalized and checked per kind', () => {
  const card = validateItem({
    type: 'card', fields: { cardholder: '  HINA SATO ', number: '4111-1111-1111-1111', expiry: '2027-04', cvv: ' 123', pin: '' },
  }).fields;
  assert.deepEqual(card, { cardholder: 'HINA SATO', number: '4111 1111 1111 1111', expiry: '2027-04', cvv: ' 123' },
    'text trimmed, secrets keep spaces, blanks dropped, card number keeps its grouping');
  assert.equal(validateItem({ type: 'card', fields: { number: '  41111111 ' } }).fields.number, '41111111');
  assert.deepEqual(validateItem({
    type: 'identity',
    fields: { birthDate: '2000-02-29', email: ' hina@example.jp ', phone: '090 (1234) 5678 内線 12', website: 'example.com', lastName: '' },
  }).fields, { birthDate: '2000-02-29', email: 'hina@example.jp', phone: '090 (1234) 5678 内線 12', website: 'https://example.com' });
  assert.deepEqual(validateItem({ type: 'wifi', fields: { ssid: 'Home', security: 'wpa2' } }).fields, { ssid: 'Home', security: 'wpa2' });
  assert.deepEqual(validateItem({ type: 'database', fields: { port: '5432' } }).fields, { port: '5432' });
  assert.deepEqual(validateItem({ type: 'sshKey', fields: { privateKey: 'a\r\nb\rc', publicKey: '  ' } }).fields, { privateKey: 'a\nb\nc' });
  assert.deepEqual(validateItem({ type: 'passport', fields: {} }).fields, {});
  for (const type of TYPE_IDS.filter(hasTemplate)) {
    assert.deepEqual(validateItem({ type, fields: sampleFields(type) }).fields, sampleFields(type), type);
  }

  for (const [type, fields] of [
    ['identity', { birthDate: '2023-02-29' }], ['identity', { birthDate: '2024-13-01' }], ['identity', { birthDate: '2024-04-31' }],
    ['identity', { birthDate: '2024/01/02' }], ['identity', { birthDate: '24-01-02' }], ['identity', { birthDate: '0000-01-01' }],
    ['card', { expiry: '2024-00' }], ['card', { expiry: '2024-13' }], ['card', { expiry: '2024-1' }], ['card', { expiry: '2024-01-01' }],
    ['database', { port: '54a' }], ['database', { port: '-1' }], ['database', { port: '５４３２' }], ['server', { port: '22.0' }],
    ['identity', { email: 'nope' }], ['identity', { email: 'a b@c' }], ['identity', { phone: 'call me' }], ['identity', { phone: '+-()' }],
    ['server', { url: 'javascript:alert(1)' }], ['server', { url: 'data:text/html,<b>x</b>' }], ['server', { url: 'ftp://host/x' }],
    ['wifi', { security: 'WPA2' }], ['wifi', { security: 'wpa4' }],
    ['card', { number: '4111' }], ['card', { number: '4111x1111111111' }], ['card', { number: '1'.repeat(20) }],
    ['card', { bogus: 'x' }], ['card', { cardholder: 5 }], ['card', { cardholder: null }], ['card', JSON.parse('{"__proto__":"x"}')],
    ['card', 'x'], ['card', []], ['card', null],
    ['note', { body: 'x' }], ['login', { number: '4111111111111111' }], ['note', 'x'],
  ]) bad({ type, fields }, null, type + ' ' + JSON.stringify(fields));
  assert.equal(validateItem({ type: 'note', fields: {} }).fields, undefined, 'empty fields on note/login are dropped');
  assert.equal(validateItem({ fields: {} }).fields, undefined);

  // Caps: LIMITS.fieldValue for single-line kinds, LIMITS.multilineValue for multiline ones.
  assert.equal(validateItem({ type: 'apiCredential', fields: { keyId: 'k'.repeat(LIMITS.fieldValue) } }).fields.keyId.length, LIMITS.fieldValue);
  bad({ type: 'apiCredential', fields: { keyId: 'k'.repeat(LIMITS.fieldValue + 1) } });
  bad({ type: 'apiCredential', fields: { secret: 's'.repeat(LIMITS.fieldValue + 1) } });
  assert.equal(validateItem({ type: 'sshKey', fields: { privateKey: 'k'.repeat(LIMITS.multilineValue) } }).fields.privateKey.length, LIMITS.multilineValue);
  bad({ type: 'sshKey', fields: { privateKey: 'k'.repeat(LIMITS.multilineValue + 1) } });
  bad({ type: 'medicalRecord', fields: { allergies: 'k'.repeat(LIMITS.multilineValue + 1) } });
});

test('validateItem: extra on any type, with count and length limits', () => {
  for (const type of TYPE_IDS) {
    const extra = [{ label: ' PIN ', value: ' 12\r\n34', secret: true }, { label: '', value: ' ', secret: false }, { label: 'x', value: '' }];
    assert.deepEqual(validateItem({ type, extra }).extra, [{ label: 'PIN', value: ' 12\n34', secret: true }, { label: 'x', value: '', secret: false }], type);
  }
  assert.deepEqual(validateItem({ extra: [] }).extra, []);
  const max = Array.from({ length: LIMITS.extraCount }, (_, i) => ({ label: 'l' + i, value: 'v', secret: false }));
  assert.equal(validateItem({ extra: max }).extra.length, LIMITS.extraCount);
  assert.equal(validateItem({ extra: [{ label: 'l'.repeat(LIMITS.extraLabel), value: 'v'.repeat(LIMITS.extraValue), secret: false }] }).extra.length, 1);
  for (const extra of [
    'x', {}, null, [...max, { label: 'one more', value: 'v', secret: false }], [null], ['x'],
    [{ label: 'l'.repeat(LIMITS.extraLabel + 1), value: 'v', secret: false }], [{ label: 'l', value: 'v'.repeat(LIMITS.extraValue + 1), secret: false }],
    [{ label: 'l', value: 'v', secret: 'yes' }], [{ label: 'l', value: 5, secret: false }], [{ value: 'v', secret: false }],
  ]) bad({ type: 'card', extra }, null, String(JSON.stringify(extra)).slice(0, 80));
});

test('validateItem: login-only keys on other types: empty legacy values dropped, others refused unless unchanged', () => {
  // Legacy notes were stored with url/username/password = '' and totp = null; the popup sends them back.
  assert.deepEqual(validateItem({ type: 'note', title: 'Memo', url: '', username: '', password: '', totp: null, passkeys: [] }),
    { type: 'note', title: 'Memo' });
  assert.deepEqual(validateItem({ type: 'card', url: '  ', fields: { cvv: '1' } }), { type: 'card', fields: { cvv: '1' } });
  for (const item of [
    { type: 'note', password: 'p' }, { type: 'card', username: 'u' }, { type: 'wifi', url: 'https://router.example' },
    { type: 'note', totp: { secret: 'JBSWY3DPEHPK3PXP' } }, { type: 'note', url: 'javascript:alert(1)' },
  ]) bad(item);

  // A stored legacy note with a non-empty value keeps it (never lost) but cannot change it.
  const legacy = { ...makeItem({ title: 'Old', url: 'https://router.example', username: 'admin', password: 'pw' }, 1), type: 'note' };
  assert.deepEqual(validateItem({ ...legacy, fav: true }, legacy), {
    id: legacy.id, type: 'note', vault: 'personal', title: 'Old', url: 'https://router.example', username: 'admin', password: 'pw',
    note: '', fav: true, hue: legacy.hue, extra: [],
  });
  bad({ id: legacy.id, password: 'changed' }, legacy);
  bad({ id: legacy.id, username: 'someone' }, makeItem({ type: 'note' }, 1));

  // The stored type is used when the payload has none, and can never change.
  const card = makeItem({ type: 'card', fields: { number: '4111111111111111' } }, 1);
  assert.deepEqual(validateItem({ id: card.id, fields: { cvv: '999' } }, card), { id: card.id, fields: { cvv: '999' } });
  bad({ id: card.id, fields: { cvv: '999' } }, null, 'without the stored item, fields default to a login');
  bad({ id: card.id, type: 'identity' }, card);
  bad({ id: card.id, type: 'login' }, card);
  bad({ type: 'bogus' });
});

test('makeItem: per-type defaults', () => {
  const card = makeItem({ type: 'card' }, 7);
  assert.deepEqual(Object.keys(card).sort(), ['createdAt', 'extra', 'fav', 'fields', 'hue', 'id', 'lastUsedAt', 'note', 'title', 'type', 'updatedAt', 'vault']);
  assert.deepEqual([card.fields, card.extra, card.createdAt], [{}, [], 7]);
  const note = makeItem({ type: 'note', title: 'n' }, 7);
  assert.deepEqual(Object.keys(note).sort(), ['createdAt', 'extra', 'fav', 'hue', 'id', 'lastUsedAt', 'note', 'title', 'type', 'updatedAt', 'vault']);
  const login = makeItem({}, 7);
  for (const k of ['url', 'username', 'password', 'totp', 'passkeys', 'passwordUpdatedAt', 'extra']) assert.ok(k in login, k);
  assert.ok(!('fields' in login));
  for (const type of TYPE_IDS) assert.equal(makeItem({ type }).type, type);
});

test('sanitizeItem leaves fields and extra intact', () => {
  const item = makeItem({ type: 'sshKey', fields: sampleFields('sshKey'), extra: [{ label: 'k', value: 'v', secret: true }] }, 1);
  const clean = sanitizeItem(item);
  assert.deepEqual(clean, item);
  assert.notEqual(clean.fields, item.fields, 'deep copy');
  assert.equal(clean.fields.privateKey, item.fields.privateKey, 'item secrets are the popup\'s to show; only passkey keys are stripped');
});

test('backup export/import keeps fields and extra; legacy note keys; invalid typed items dropped', async () => {
  const data = defaultData(1000);
  const extra = [{ label: 'メモ欄', value: 'v', secret: false }, { label: '暗証', value: '0000', secret: true }];
  for (const type of TYPE_IDS.filter(hasTemplate)) data.items.push(makeItem({ type, title: type, fields: sampleFields(type), extra, vault: 'work' }, 1000));
  data.items.push(makeItem({ title: 'Login', url: 'https://a.example', username: 'u', password: 'p', extra }, 1000));
  // Legacy notes: stored with every login key, empty or (theoretically) filled.
  const legacyEmpty = { ...makeItem({ title: 'legacy' }, 1000), type: 'note', note: 'body' };
  const legacyFilled = { ...makeItem({ title: 'legacy filled', url: 'https://router.example', username: 'admin', password: 'pw' }, 1000), type: 'note' };
  data.items.push(legacyEmpty, legacyFilled);
  data.items.push(makeItem({ type: 'identity', title: 'bad date', fields: { birthDate: '1990/01/02' } }, 1000));
  data.items.push(makeItem({ type: 'card', title: 'unknown key', fields: { bogus: 'x' } }, 1000));
  data.items.push(makeItem({ type: 'note', title: 'fields on note', fields: { x: '1' } }, 1000));

  const json = exportBackup(await createVaultRecord(PW, data, OPTS), 5000);
  const imported = await importBackup(json, PW);
  const byTitle = new Map(imported.items.map((i) => [i.title, i]));
  for (const type of TYPE_IDS.filter(hasTemplate)) assert.deepEqual(byTitle.get(type), data.items.find((i) => i.title === type), type);
  assert.deepEqual(byTitle.get('Login').extra, extra);
  assert.deepEqual(byTitle.get('legacy'), {
    id: legacyEmpty.id, type: 'note', vault: 'personal', title: 'legacy', note: 'body', fav: false, hue: legacyEmpty.hue,
    extra: [], createdAt: 1000, updatedAt: 1000, lastUsedAt: null,
  }, 'empty legacy login keys are dropped');
  assert.deepEqual([byTitle.get('legacy filled').url, byTitle.get('legacy filled').password], ['https://router.example', 'pw'],
    'a filled legacy value survives a backup round trip');
  assert.ok(!('passkeys' in byTitle.get('legacy filled')));
  for (const t of ['bad date', 'unknown key', 'fields on note']) assert.ok(!byTitle.has(t), t);

  // mergeData: same id but a different type is skipped; typed items replace by updatedAt.
  const current = structuredClone(imported);
  const card = current.items.find((i) => i.type === 'card');
  const incoming = {
    vaults: [],
    items: [
      { ...structuredClone(card), type: 'identity', fields: {}, updatedAt: 9000 },
      { ...structuredClone(current.items.find((i) => i.type === 'wifi')), fields: { ssid: 'New' }, updatedAt: 9000 },
    ],
  };
  const merged = mergeData(current, incoming);
  assert.equal(merged.count, 1);
  assert.deepEqual(merged.data.items.find((i) => i.id === card.id), card);
  const wifi = merged.data.items.find((i) => i.type === 'wifi');
  assert.deepEqual(wifi.fields, { ssid: 'New' });
  assert.ok(!('passkeys' in wifi), 'non-login items never get a passkey list');
});

test('addImportedItems: every type, same validation, exact-duplicate dedupe, field salvage', async () => {
  const data = defaultData(1000);
  const visa = { type: 'card', title: 'Visa', fields: { number: '4111111111111111', expiry: '2027-04', cvv: '123' } };
  data.items.push(makeItem(visa, 1000));
  const now = 9000;
  const all = TYPE_IDS.filter(hasTemplate).map((type) => ({
    type, title: 'All ' + type, fields: sampleFields(type), extra: [{ label: 'x', value: 'y', secret: true }],
  }));
  const gh = { type: 'login', title: 'GH', url: 'https://github.com', username: 'hina', password: 'pw' };
  const res = await addImportedItems(data, [
    ...all,
    ...structuredClone(all), // a true duplicate: the identical record imported twice → 1
    // True duplicates of the existing card: separators and case of the number, and the title's case/spaces, do not matter.
    { ...visa, title: ' visa ', fields: { ...visa.fields, number: '4111 1111 1111 1111' } },
    { ...visa, fields: { ...visa.fields, number: '4111-1111-1111-1111' } },
    // Different records that share identifying values are all kept:
    { ...visa, fields: { ...visa.fields, expiry: '2031-04', cvv: '987' } }, // a renewed card (same number, new expiry/CVV)
    { type: 'apiCredential', title: 'OpenAI', fields: { host: 'api.openai.com', secret: 'sk-one' } },
    { type: 'apiCredential', title: 'OpenAI', fields: { host: 'api.openai.com', secret: 'sk-two' } }, // same host, other secret
    { type: 'wifi', title: 'Home', fields: { ssid: 'Home', password: 'pw-a' } },
    { type: 'wifi', title: 'Home', fields: { ssid: 'Home', password: 'pw-b' } }, // same network name, other password
    { type: 'wifi', title: 'Home', fields: { ssid: 'Home', password: 'PW-A' } }, // secrets compare exactly, case included
    { type: 'note', title: 'メモ', extra: [{ label: '項目', value: 'a', secret: false }] }, // untitled CSV rows,
    { type: 'note', title: 'メモ', extra: [{ label: '項目', value: 'b', secret: false }] }, // different custom fields
    { type: 'note', title: 'メモ', extra: [{ label: '項目', value: 'b', secret: true }] },
    { type: 'identity', title: 'Me', fields: { lastName: 'Sato' }, note: 'n' },
    { type: 'identity', title: 'Me', fields: { lastName: 'Sato' }, note: 'other' }, // other note
    { type: 'passport', title: 'Passport', fields: { number: 'TK1234567' } },
    { type: 'passport', title: 'Passport', fields: { number: 'tk 123 4567' } }, // dup: number without separators / case
    { type: 'passport', title: 'Passport', fields: { number: 'TR1234567' } }, // letters count
    // Logins: host + username + password, plus note, TOTP secret and extra.
    gh,
    { ...gh, note: 'second account' },
    { ...gh, totp: { secret: 'JBSWY3DPEHPK3PXP' } },
    { ...gh, extra: [{ label: 'PIN', value: '1', secret: true }] },
    { ...gh, title: 'Other title', url: 'https://GITHUB.com/login' }, // dup: same host, title not compared
    // Salvage: values that fail their kind's check move to extra; a select label maps to its id.
    { type: 'identity', title: 'Salvaged', fields: { lastName: 'Sato', birthDate: '1990/01/02', bogus: 'kept', port: 5 } },
    { type: 'wifi', title: 'Office', fields: { ssid: 'Office', security: 'WPA2' } },
    { type: 'note', title: 'note fields', fields: { x: 1 } }, // a note has no template: all into extra
    // Invalid: login-only keys on other types, bad extra, unknown type.
    { type: 'card', title: 'with url', url: 'https://bank.example', fields: { number: '5555555555554444' } },
    { type: 'card', title: 'bad extra', extra: 'nope' },
    { type: 'bogus', title: 'x' },
    // Passkeys on a non-login are ignored.
    { type: 'server', title: 'srv', fields: { host: 'h' }, passkeys: [(await importedPasskey()).pk] },
  ], 'personal', now);
  const n = all.length;
  assert.equal(n, 16);
  assert.deepEqual(res, { added: n + 21, duplicates: n + 4, invalid: 3, passkeys: 0 });
  const added = data.items.slice(1);
  for (const it of all) {
    const got = added.find((i) => i.title === it.title);
    assert.deepEqual([got.type, got.fields, got.extra, got.vault], [it.type, it.fields, it.extra, 'personal'], it.type);
    assert.ok(!('passkeys' in got) && !('url' in got) && !('passwordUpdatedAt' in got), it.type);
  }
  const salvaged = added.find((i) => i.title === 'Salvaged');
  assert.deepEqual(salvaged.fields, { lastName: 'Sato' });
  assert.deepEqual(salvaged.extra, [
    { label: '生年月日', value: '1990/01/02', secret: false },
    { label: 'bogus', value: 'kept', secret: false },
    { label: 'port', value: '5', secret: false },
  ]);
  assert.deepEqual(added.find((i) => i.title === 'Office').fields, { ssid: 'Office', security: 'wpa2' });
  const count = (title) => added.filter((i) => i.title === title).length;
  for (const it of all) assert.equal(count(it.title), 1, 'identical record imported twice → 1: ' + it.type);
  assert.deepEqual(added.filter((i) => i.title === 'Visa').map((i) => i.fields), [{ ...visa.fields, expiry: '2031-04', cvv: '987' }],
    'the renewed card is added; the separator/case variants of the existing card are not');
  assert.deepEqual(added.filter((i) => i.title === 'OpenAI').map((i) => i.fields.secret), ['sk-one', 'sk-two']);
  assert.deepEqual(added.filter((i) => i.title === 'Home').map((i) => i.fields.password), ['pw-a', 'pw-b', 'PW-A']);
  assert.equal(count('メモ'), 3);
  assert.equal(count('Me'), 2);
  assert.deepEqual(added.filter((i) => i.title === 'Passport').map((i) => i.fields.number), ['TK1234567', 'TR1234567']);
  assert.equal(count('GH'), 4);
  assert.equal(count('Other title'), 0);
  const noteFields = added.find((i) => i.title === 'note fields');
  assert.deepEqual([noteFields.fields, noteFields.extra], [undefined, [{ label: 'x', value: '1', secret: false }]]);
  assert.ok(!('passkeys' in added.find((i) => i.title === 'srv')));
  assert.ok(!added.some((i) => ['with url', 'bad extra'].includes(i.title)));
});
