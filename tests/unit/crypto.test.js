import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PBKDF2_ITERATIONS, deriveKek, generateDek, importDek, exportDek, wrapDek, unwrapDek, encryptJson, decryptJson,
} from '../../extension/src/lib/crypto.js';
import { randomBytes, toB64, fromB64 } from '../../extension/src/shared/bytes.js';

const ITER = 1000;

function flipByte(b64, index = 0) {
  const bytes = fromB64(b64);
  bytes[index] ^= 0x01;
  return toB64(bytes);
}

test('default PBKDF2 iteration count is 600000', () => {
  assert.equal(PBKDF2_ITERATIONS, 600000);
});

test('KEK is non-extractable and limited to wrap/unwrap', async () => {
  const kek = await deriveKek('correct horse', randomBytes(16), ITER);
  assert.equal(kek.extractable, false);
  assert.deepEqual([...kek.usages].sort(), ['unwrapKey', 'wrapKey']);
  assert.equal(kek.algorithm.name, 'AES-GCM');
  assert.equal(kek.algorithm.length, 256);
});

test('DEK wrap/unwrap round-trip with the right password', async () => {
  const salt = randomBytes(16);
  const dek = await generateDek();
  const raw = await exportDek(dek);
  assert.equal(raw.length, 32);
  const wrapped = await wrapDek(await deriveKek('パスワード', salt, ITER), dek);
  assert.equal(fromB64(wrapped.iv).length, 12);
  const back = await unwrapDek(await deriveKek('パスワード', salt, ITER), wrapped);
  assert.deepEqual(await exportDek(back), raw);
});

test('password is NFC-normalized before derivation', async () => {
  const salt = randomBytes(16);
  const dek = await generateDek();
  const nfd = 'ガ'.normalize('NFD') + 'pass';
  const nfc = 'ガ'.normalize('NFC') + 'pass';
  assert.notEqual(nfd, nfc);
  const wrapped = await wrapDek(await deriveKek(nfd, salt, ITER), dek);
  await unwrapDek(await deriveKek(nfc, salt, ITER), wrapped); // does not throw
});

test('wrong password → BAD_PASSWORD', async () => {
  const salt = randomBytes(16);
  const wrapped = await wrapDek(await deriveKek('right', salt, ITER), await generateDek());
  await assert.rejects(unwrapDek(await deriveKek('wrong', salt, ITER), wrapped), { code: 'BAD_PASSWORD' });
});

test('malformed wrapped key → INVALID', async () => {
  const kek = await deriveKek('right', randomBytes(16), ITER);
  await assert.rejects(unwrapDek(kek, { iv: 'AAAA', ct: 'AAAA' }), { code: 'INVALID' });
  await assert.rejects(unwrapDek(kek, null), { code: 'INVALID' });
});

test('encryptJson/decryptJson round-trip and fresh IV each time', async () => {
  const dek = await generateDek();
  const obj = { items: [{ title: '灯', password: 'p@ss' }], n: 1 };
  const a = await encryptJson(dek, obj);
  const b = await encryptJson(dek, obj);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.deepEqual(await decryptJson(dek, a), obj);
  // DEK survives export/import (session resume path)
  assert.deepEqual(await decryptJson(await importDek(await exportDek(dek)), b), obj);
});

test('tampered ciphertext / IV → INVALID', async () => {
  const dek = await generateDek();
  const box = await encryptJson(dek, { secret: 'x' });
  await assert.rejects(decryptJson(dek, { ...box, ct: flipByte(box.ct, 3) }), { code: 'INVALID' });
  await assert.rejects(decryptJson(dek, { ...box, iv: flipByte(box.iv) }), { code: 'INVALID' });
  await assert.rejects(decryptJson(await generateDek(), box), { code: 'INVALID' });
});

test('AAD separates wrapped keys from data boxes (same key, different purpose)', async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
  const wrapped = await wrapDek(key, await generateDek());
  await assert.rejects(decryptJson(key, wrapped), { code: 'INVALID' });
  const box = await encryptJson(key, { a: 1 });
  await assert.rejects(unwrapDek(key, box), { code: 'BAD_PASSWORD' });
});
