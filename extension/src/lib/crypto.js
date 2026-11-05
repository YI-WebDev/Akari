// Key derivation and AES-256-GCM helpers (WebCrypto only; runs in the SW and in Node tests).
// Master password --PBKDF2--> KEK (non-extractable) wraps a random DEK; the DEK encrypts the vault JSON.

import { utf8, fromUtf8, toB64, fromB64, randomBytes } from '../shared/bytes.js';
import { AkariError } from '../shared/errors.js';
import { ERR } from '../shared/messages.js';

export const PBKDF2_ITERATIONS = 600000;
const IV_BYTES = 12;
const DEK_AAD = utf8('akari:dek:v1');
const DATA_AAD = utf8('akari:data:v1');
const AES = { name: 'AES-GCM', length: 256 };

// NFC so the same password typed via different IMEs/OSes yields the same bytes.
const passwordBytes = (password) => utf8(String(password).normalize('NFC'));

function decodeBox(box) {
  try {
    if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string') throw new Error('shape');
    const iv = fromB64(box.iv);
    const ct = fromB64(box.ct);
    if (iv.length !== IV_BYTES || ct.length < 16) throw new Error('length');
    return { iv, ct };
  } catch {
    throw new AkariError(ERR.INVALID, 'Malformed encrypted payload');
  }
}

/** PBKDF2-SHA256 → non-extractable AES-GCM key usable only to wrap/unwrap the DEK. */
export async function deriveKek(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', passwordBytes(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    base, AES, false, ['wrapKey', 'unwrapKey'],
  );
}

/** Random 256-bit data key. Extractable: its raw bytes live in storage.session while unlocked. */
export function generateDek() {
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
}

export function importDek(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function exportDek(key) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function wrapDek(kek, dek) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: DEK_AAD });
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** GCM authentication failure here means the KEK (i.e. the password) is wrong → BAD_PASSWORD. */
export async function unwrapDek(kek, wrapped) {
  const { iv, ct } = decodeBox(wrapped);
  try {
    return await crypto.subtle.unwrapKey(
      'raw', ct, kek, { name: 'AES-GCM', iv, additionalData: DEK_AAD },
      AES, true, ['encrypt', 'decrypt'],
    );
  } catch {
    throw new AkariError(ERR.BAD_PASSWORD, 'Wrong master password');
  }
}

export async function encryptJson(dek, obj) {
  const iv = randomBytes(IV_BYTES);
  const pt = utf8(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: DATA_AAD }, dek, pt);
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** GCM authentication failure here means the ciphertext was tampered with → INVALID. */
export async function decryptJson(dek, box) {
  const { iv, ct } = decodeBox(box);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: DATA_AAD }, dek, ct);
  } catch {
    throw new AkariError(ERR.INVALID, 'Vault data failed integrity check');
  }
  try {
    return JSON.parse(fromUtf8(new Uint8Array(pt)));
  } catch {
    throw new AkariError(ERR.INVALID, 'Vault data is not valid JSON');
  }
}
