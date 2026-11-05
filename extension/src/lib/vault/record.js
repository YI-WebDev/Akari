// The encrypted `akari.vault` record: master password --KDF--> KEK wraps a random DEK, and the
// DEK encrypts the VaultData JSON. Pure: no chrome.* access.

import { toB64, fromB64, randomBytes } from '../../shared/bytes.js';
import {
  PBKDF2_ITERATIONS, deriveKek, generateDek, wrapDek, unwrapDek, encryptJson, decryptJson,
} from '../crypto.js';
import { invalid, isObject, isBox } from './common.js';
import { migrateData } from './schema.js';

/** Record version this build writes. */
export const VAULT_VERSION = 1;
// Bounds for kdf.iterations read from storage or a backup file (guards against a
// crafted backup making PBKDF2 run for hours).
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10000000;
const SALT_BYTES = 16;

function saltOf(record) {
  try {
    const salt = fromB64(record.kdf.salt);
    if (salt.length >= 8) return salt;
  } catch { /* fall through */ }
  throw invalid('Malformed vault salt');
}

/**
 * Record versions this build reads: the shape check and the KEK derivation of each. A new key
 * derivation (Argon2id, …) is a new version added here; records of older versions stay readable,
 * and the rest of the code only goes through formatOf().
 */
const RECORD_FORMATS = new Map([
  [1, {
    valid: (kdf) => kdf.name === 'PBKDF2' && kdf.hash === 'SHA-256'
      && Number.isInteger(kdf.iterations) && kdf.iterations >= MIN_ITERATIONS && kdf.iterations <= MAX_ITERATIONS
      && typeof kdf.salt === 'string',
    kek: (record, password) => deriveKek(password, saltOf(record), record.kdf.iterations),
  }],
]);

function formatOf(record) {
  const format = isObject(record) ? RECORD_FORMATS.get(record.version) : null; // a number: '1' is not version 1
  const ok = format && isObject(record.kdf) && format.valid(record.kdf) && isBox(record.wrappedKey) && isBox(record.data);
  if (!ok) throw invalid('Unsupported vault record');
  return format;
}

/** Throws INVALID unless `record` has the shape of a record version this build reads. */
export function checkRecord(record) {
  formatOf(record);
}

/** Creates a new record and also returns the DEK so the caller can stay unlocked without a second PBKDF2 run. */
export async function createVault(password, data, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(password, salt, iterations);
  const dek = await generateDek();
  const record = {
    version: VAULT_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    wrappedKey: await wrapDek(kek, dek),
    data: await encryptJson(dek, data),
  };
  return { record, dek };
}

export async function createVaultRecord(password, data, opts) {
  return (await createVault(password, data, opts)).record;
}

/** → { dek, data }. Wrong password → BAD_PASSWORD; tampered data → INVALID. `opts` as readVaultData. */
export async function openVaultRecord(record, password, opts) {
  const kek = await formatOf(record).kek(record, password);
  const dek = await unwrapDek(kek, record.wrappedKey);
  return { dek, data: await readVaultData(record, dek, opts) };
}

/**
 * Decrypts record.data with an already-known DEK (also on session resume after a SW restart)
 * and brings it up to the current schema. `opts.newer`: see migrateData (lib/vault/schema.js).
 */
export async function readVaultData(record, dek, opts) {
  checkRecord(record);
  return migrateData(await decryptJson(dek, record.data), opts);
}

/** New record with `data` re-encrypted under a fresh IV; key material unchanged. */
export async function sealData(record, dek, data) {
  return { ...record, data: await encryptJson(dek, data) };
}
