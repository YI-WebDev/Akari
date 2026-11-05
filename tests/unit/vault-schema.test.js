// lib/vault/schema.js and the record-format table in lib/vault/record.js: data written by older
// versions is brought up to date when it is decrypted, newer data is refused, and only known
// record versions open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_SCHEMA, defaultData, migrateData, createVault, openVaultRecord, readVaultData, checkRecord,
  normalizeData, mergeData, exportBackup, importBackup,
} from '../../extension/src/lib/vault.js';
import { AkariError } from '../../extension/src/shared/errors.js';

const ITER = 1000; // the lowest count a record may carry; keeps the tests fast
const isInvalid = (e) => e instanceof AkariError && e.code === 'INVALID';

/** VaultData as Akari wrote it before `schema` existed. */
function legacyData() {
  return {
    vaults: [{ id: 'personal', name: '個人', hue: 55 }],
    items: [
      // a login from before item types: no `type`
      { id: 'a', vault: 'personal', title: 'GitHub', url: 'https://github.com', username: 'u', password: 'p', totp: null, passkeys: [], extra: [], createdAt: 1, updatedAt: 1 },
      // a note from before the type templates: empty login keys
      { id: 'b', type: 'note', vault: 'personal', title: 'メモ', note: 'n', url: '', username: '', password: '', totp: null, passkeys: [], passwordUpdatedAt: null, extra: [], createdAt: 1, updatedAt: 1 },
      // a note that still holds a legacy value: kept, never lost
      { id: 'c', type: 'note', vault: 'personal', title: '旧メモ', note: '', url: 'https://example.com', username: '', password: '', extra: [], createdAt: 1, updatedAt: 1 },
    ],
    updatedAt: 1,
  };
}

test('a new vault is written at the current schema', () => {
  assert.equal(defaultData(5).schema, DATA_SCHEMA);
  assert.equal(DATA_SCHEMA, 1);
});

test('schema 0 → 1: type-less items become logins, notes lose their empty login keys', () => {
  const data = migrateData(legacyData());
  assert.equal(data.schema, 1);
  const [a, b, c] = data.items;
  assert.equal(a.type, 'login');
  assert.equal(a.password, 'p');
  assert.deepEqual(Object.keys(b).sort(), ['createdAt', 'extra', 'id', 'note', 'title', 'type', 'updatedAt', 'vault']);
  assert.equal(c.url, 'https://example.com'); // a non-empty legacy value stays
  assert.equal('username' in c, false);
});

test('migrating twice changes nothing more', () => {
  const once = migrateData(legacyData());
  const twice = migrateData(structuredClone(once));
  assert.deepEqual(twice, once);
});

test('data from a newer Akari, or with a malformed schema, is refused', () => {
  assert.throws(() => migrateData({ ...defaultData(1), schema: DATA_SCHEMA + 1 }), isInvalid);
  for (const schema of [-1, 1.5, '1', null]) {
    const data = { ...defaultData(1), schema };
    if (schema === null) {
      assert.equal(migrateData(data).schema, DATA_SCHEMA); // null reads as "no schema" = 0
    } else {
      assert.throws(() => migrateData(data), isInvalid, String(schema));
    }
  }
  assert.throws(() => migrateData({ items: [] }), isInvalid);
});

test('decrypting an old record migrates its data; the next write stores the schema', async () => {
  const { record, dek } = await createVault('correct horse', legacyData(), { iterations: ITER });
  const opened = await openVaultRecord(record, 'correct horse');
  assert.equal(opened.data.schema, DATA_SCHEMA);
  assert.equal(opened.data.items[0].type, 'login');
  const again = await readVaultData(record, dek);
  assert.equal(again.schema, DATA_SCHEMA);
});

test('a backup merge keeps the current schema', () => {
  const current = defaultData(1);
  const incoming = normalizeData(migrateData(legacyData()), 10);
  const { data } = mergeData(current, incoming);
  assert.equal(data.schema, DATA_SCHEMA);
  assert.equal(data.items.length, 3);
});

test('a backup from a newer Akari imports what this build knows; such a vault itself does not open', async () => {
  const newer = {
    ...defaultData(1), schema: DATA_SCHEMA + 1, someNewKey: { x: 1 },
    items: [{ id: 'z', type: 'login', vault: 'personal', title: 'Z', url: '', username: 'u', password: 'p', totp: null, extra: [], futureField: 1, createdAt: 1, updatedAt: 2 }],
  };
  const { record } = await createVault('pw', newer, { iterations: ITER });
  await assert.rejects(openVaultRecord(record, 'pw'), isInvalid);
  const data = await importBackup(exportBackup(record, 5), 'pw');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].title, 'Z');
  assert.equal('futureField' in data.items[0], false);
  assert.equal('someNewKey' in data, false);
});

test('only known record versions are read', async () => {
  const { record } = await createVault('pw', defaultData(1), { iterations: ITER });
  checkRecord(record);
  for (const version of [0, 2, '1', undefined]) {
    assert.throws(() => checkRecord({ ...record, version }), isInvalid, String(version));
    await assert.rejects(openVaultRecord({ ...record, version }, 'pw'), isInvalid, String(version));
  }
  assert.throws(() => checkRecord({ ...record, kdf: { ...record.kdf, name: 'scrypt' } }), isInvalid);
  assert.throws(() => checkRecord({ ...record, kdf: { ...record.kdf, iterations: 999 } }), isInvalid);
});
