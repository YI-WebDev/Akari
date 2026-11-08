import { utf8, fromUtf8, toB64, fromB64, randomBytes } from '../shared/bytes.js';
import { AkariError } from '../shared/errors.js';
import { ERR } from '../shared/messages.js';

export const PBKDF2_ITERATIONS = 600000;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_AAD = utf8('akari:dek:v1');
const DATA_AAD = utf8('akari:data:v1');
const AES = { name: 'AES-GCM', length: 256 };

const passwordBytes = (password) => utf8(String(password).normalize('NFC'));

function decodeBox(box) {
  try {
    if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string') throw new Error('shape');
    const iv = fromB64(box.iv);
    const ct = fromB64(box.ct);
    if (iv.length !== IV_BYTES || ct.length < GCM_TAG_BYTES) throw new Error('length');
    return { iv, ct };
  } catch {
    throw new AkariError(ERR.INVALID, 'Malformed encrypted payload');
  }
}

export async function deriveKek(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', passwordBytes(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    base, AES, false, ['wrapKey', 'unwrapKey'],
  );
}

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
