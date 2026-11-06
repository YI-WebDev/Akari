// Passphrase-based OpenPGP (PLAN.md §7.2) on top of the vendored OpenPGP.js.
// Only symmetric (SKESK) messages: Akari holds no OpenPGP keys.

import {
  readMessage, decrypt, createMessage, encrypt, enums,
  SymEncryptedSessionKeyPacket, PublicKeyEncryptedSessionKeyPacket,
} from '../third_party/openpgp.js';
import { ImportError } from './import/model.js';
import { t } from '../shared/i18n.js';

const te = new TextEncoder();

// Written messages: SKESK v4 + SEIPD v1 (MDC), AES-256, iterated+salted S2K —
// RFC 4880 constructs that GnuPG 2.2+, Proton Pass and other OpenPGP.js apps open.
const WRITE_CONFIG = {
  preferredSymmetricAlgorithm: enums.symmetric.aes256,
  preferredCompressionAlgorithm: enums.compression.uncompressed,
  aeadProtect: false,
  s2kType: enums.s2k.iterated,
};

// Limits for files we open: their cost parameters come from the file itself.
const MAX_SKESK_PACKETS = 4; // OpenPGP.js runs the S2K of every passphrase packet until one works
// Argon2 S2K (RFC 9580): passes t, lanes p, memory 2^m KiB. OpenPGP.js / Proton Pass
// defaults are t=3, p=4, m=16 (64 MiB); m=20 is 1 GiB. Iterated+salted S2K needs no
// limit: its one-byte count caps the hashed input at 65,011,712 bytes.
const ARGON2_MAX = { passes: 10, parallelism: 16, memoryExponent: 20 };
const MAX_DECOMPRESSED = 64 * 2 ** 20;
const READ_CONFIG = {
  maxDecompressedMessageSize: MAX_DECOMPRESSED,
  maxArgon2MemoryExponent: ARGON2_MAX.memoryExponent,
};

const isArmored = (bytes) => new TextDecoder().decode(bytes.subarray(0, 512)).includes('-----BEGIN PGP MESSAGE-----');

async function wasmAllowed() {
  try {
    await WebAssembly.compile(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)); // empty module
    return true;
  } catch {
    return false;
  }
}

/**
 * Decrypt a passphrase-encrypted OpenPGP message (ASCII-armored or binary).
 * @param {Uint8Array} bytes
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>} the literal data as stored (text-mode data in its canonical CRLF form)
 */
export async function decryptPgp(bytes, passphrase) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decryptPgp: bytes must be a Uint8Array');
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new ImportError('NEEDS_PASSWORD', t('PGP で暗号化されたファイルです。パスフレーズを入力してください'));
  }
  let message;
  try {
    message = isArmored(bytes)
      ? await readMessage({ armoredMessage: new TextDecoder().decode(bytes) })
      : await readMessage({ binaryMessage: bytes });
  } catch {
    throw new ImportError('INVALID_FORMAT', t('PGP のファイルとして読めませんでした'));
  }
  const skesks = message.packets.filter((p) => p instanceof SymEncryptedSessionKeyPacket);
  if (!skesks.length) {
    if (message.packets.some((p) => p instanceof PublicKeyEncryptedSessionKeyPacket)) {
      throw new ImportError('UNSUPPORTED', t('公開鍵で暗号化されたファイルには対応していません。パスフレーズ（共通鍵）で暗号化して書き出してください'));
    }
    throw new ImportError('INVALID_FORMAT', t('パスフレーズで暗号化された PGP メッセージではありません'));
  }
  if (skesks.length > MAX_SKESK_PACKETS) {
    throw new ImportError('UNSUPPORTED', t('パスフレーズ用の鍵パケットが多すぎるファイルには対応していません'));
  }
  const argon2 = skesks.map((p) => p.s2k).filter((s2k) => s2k?.type === 'argon2');
  if (argon2.some((s2k) => s2k.t > ARGON2_MAX.passes || s2k.p > ARGON2_MAX.parallelism || s2k.encodedM > ARGON2_MAX.memoryExponent)) {
    throw new ImportError('UNSUPPORTED', t('Argon2 の設定（計算回数・メモリー）が大きすぎるファイルには対応していません'));
  }
  // OpenPGP.js runs Argon2 in WebAssembly. The extension CSP allows that ('wasm-unsafe-eval';
  // JS eval stays blocked), but where a context does not, say so instead of "wrong passphrase".
  if (argon2.length === skesks.length && !(await wasmAllowed())) {
    throw new ImportError('UNSUPPORTED', t('Argon2 で暗号化されたファイルには対応していません。別の方式で暗号化して書き出してください'));
  }
  try {
    const { data } = await decrypt({ message, passwords: [passphrase], format: 'binary', config: READ_CONFIG });
    return data;
  } catch (e) {
    const msg = String(e?.message || '');
    // decrypt() wraps the original error as `cause`.
    if (e?.name === 'Argon2OutOfMemoryError' || e?.cause?.name === 'Argon2OutOfMemoryError') {
      throw new ImportError('UNSUPPORTED', t('Argon2 の計算に必要なメモリーを確保できませんでした'));
    }
    if (/maximum decompressed (message )?size exceeded/i.test(msg)) {
      throw new ImportError('UNSUPPORTED', t('ファイルが大きすぎます（展開後 64 MB まで）'));
    }
    if (/not authenticated|unsupported|not supported|unknown/i.test(msg)) {
      throw new ImportError('UNSUPPORTED', t('このファイルの暗号化方式には対応していません'));
    }
    // Without a session-key packet a wrong passphrase and a damaged file fail the same way.
    throw new ImportError('BAD_PASSWORD', t('パスフレーズが違うか、ファイルが壊れています'));
  }
}

/**
 * Encrypt `data` with a passphrase.
 * @param {string|Uint8Array} data  strings are stored as UTF-8 bytes, unchanged
 * @param {string} passphrase
 * @param {{ filename?: string }} [opts]  name recorded in the literal data packet
 * @returns {Promise<string>} ASCII-armored message
 */
export async function encryptPgp(data, passphrase, { filename = '' } = {}) {
  if (typeof passphrase !== 'string' || !passphrase) throw new TypeError('encryptPgp: passphrase required');
  const binary = typeof data === 'string' ? te.encode(data) : data;
  if (!(binary instanceof Uint8Array)) throw new TypeError('encryptPgp: data must be a string or Uint8Array');
  const message = await createMessage({ binary, filename, format: 'binary' });
  return encrypt({ message, passwords: [passphrase], format: 'armored', config: WRITE_CONFIG });
}
