import { toB64, fromB64, randomBytes } from '../../shared/bytes.js';
import {
  PBKDF2_ITERATIONS, deriveKek, generateDek, wrapDek, unwrapDek, encryptJson, decryptJson,
} from '../crypto.js';
import { invalid, isObject, isBox } from './common.js';
import { migrateData } from './schema.js';

export const VAULT_VERSION = 1;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10000000;
const SALT_BYTES = 16;
const MIN_SALT_BYTES = 8;

function saltOf(record) {
  try {
    const salt = fromB64(record.kdf.salt);
    if (salt.length >= MIN_SALT_BYTES) return salt;
  } catch { }
  throw invalid('Malformed vault salt');
}

const RECORD_FORMATS = new Map([
  [1, {
    valid: (kdf) => kdf.name === 'PBKDF2' && kdf.hash === 'SHA-256'
      && Number.isInteger(kdf.iterations) && kdf.iterations >= MIN_ITERATIONS && kdf.iterations <= MAX_ITERATIONS
      && typeof kdf.salt === 'string',
    kek: (record, password) => deriveKek(password, saltOf(record), record.kdf.iterations),
  }],
]);

function formatOf(record) {
  const format = isObject(record) ? RECORD_FORMATS.get(record.version) : null;
  const isSupported = format && isObject(record.kdf) && format.valid(record.kdf) && isBox(record.wrappedKey) && isBox(record.data);
  if (!isSupported) throw invalid('Unsupported vault record');
  return format;
}

export function checkRecord(record) {
  formatOf(record);
}

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

export async function openVaultRecord(record, password, opts) {
  const kek = await formatOf(record).kek(record, password);
  const dek = await unwrapDek(kek, record.wrappedKey);
  return { dek, data: await readVaultData(record, dek, opts) };
}

export async function readVaultData(record, dek, opts) {
  checkRecord(record);
  return migrateData(await decryptJson(dek, record.data), opts);
}

export async function sealData(record, dek, data) {
  return { ...record, data: await encryptJson(dek, data) };
}
