import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, createVaultRecord, openVaultRecord, sealData, exportBackup, importBackup, normalizeData,
  mergeData, makeItem, validateItem, sanitizeItem, defaultData, normalizeUrl, checkRecord,
} from '../../extension/src/lib/vault.js';
import { exportDek } from '../../extension/src/lib/crypto.js';
import { fromB64, toB64, toB64url, randomBytes } from '../../extension/src/shared/bytes.js';

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
    { type: 'card' }, { title: 'x'.repeat(201) }, { url: 'javascript:alert(1)' }, { url: 'ftp://host/x' },
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
