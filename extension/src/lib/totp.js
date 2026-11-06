// TOTP (RFC 6238) / HOTP (RFC 4226) and otpauth:// URI handling.

import { t } from '../shared/i18n.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/** Canonical base32: upper-case, no whitespace, hyphens or '=' padding. */
export function normalizeSecret(str) {
  return String(str ?? '').replace(/[\s　=-]+/g, '').toUpperCase();
}

/** True when `str` is a usable base32 secret (>= 40 bits, whole number of bytes). */
export function isValidSecret(str) {
  const s = normalizeSecret(str);
  if (s.length < 8 || /[^A-Z2-7]/.test(s)) return false;
  return ![1, 3, 6].includes(s.length % 8); // these lengths cannot encode whole bytes
}

/** RFC 4648 base32 → bytes (case-insensitive; spaces, hyphens and padding ignored). */
export function base32Decode(str) {
  const s = normalizeSecret(str);
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B32.indexOf(s[i]);
    if (v < 0) throw new Error(t('秘密鍵に使えない文字が含まれています'));
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

/** bytes → RFC 4648 base32 (no padding). */
export function base32Encode(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function algorithmOf(name) {
  const key = String(name || 'SHA1').toUpperCase().replace(/-/g, '');
  if (!ALGORITHMS[key]) throw new Error(t('未対応のアルゴリズムです: {name}', { name }));
  return key;
}

/**
 * Parse `otpauth://totp/Issuer:label?secret=…&issuer=…&algorithm=…&digits=…&period=…`.
 * Throws an Error with a Japanese message when the URI cannot be used.
 */
export function parseOtpauthUri(uri) {
  let url;
  try {
    url = new URL(String(uri ?? '').trim());
  } catch {
    throw new Error(t('otpauth:// から始まる URI ではありません'));
  }
  if (url.protocol !== 'otpauth:') throw new Error(t('otpauth:// から始まる URI ではありません'));
  const type = url.hostname.toLowerCase();
  if (type === 'hotp') throw new Error(t('カウンター方式（HOTP）には対応していません'));
  if (type !== 'totp') throw new Error(t('時間ベース（TOTP）の URI ではありません'));

  const params = url.searchParams;
  const secret = normalizeSecret(params.get('secret'));
  if (!secret) throw new Error(t('URI に秘密鍵（secret）が含まれていません'));
  if (!isValidSecret(secret)) throw new Error(t('秘密鍵の形式が正しくありません'));

  let label = '';
  try {
    label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    label = url.pathname.replace(/^\/+/, '');
  }
  let issuer = (params.get('issuer') || '').trim();
  const colon = label.indexOf(':');
  if (colon >= 0) {
    if (!issuer) issuer = label.slice(0, colon).trim();
    label = label.slice(colon + 1);
  }
  label = label.trim();

  const digits = params.has('digits') ? Number(params.get('digits')) : 6;
  if (digits !== 6 && digits !== 8) throw new Error(t('桁数は 6 または 8 のみ対応しています'));
  const period = params.has('period') ? Number(params.get('period')) : 30;
  if (!Number.isInteger(period) || period < 1 || period > 300) throw new Error(t('更新間隔（period）は 1〜300 秒のみ対応しています'));

  return { secret, algorithm: algorithmOf(params.get('algorithm')), digits, period, issuer, label };
}

/** Build an otpauth:// URI from a TotpConfig. */
export function buildOtpauthUri(config) {
  const { secret, algorithm = 'SHA1', digits = 6, period = 30, issuer = '', label = '' } = config;
  const path = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` : encodeURIComponent(label);
  const q = [`secret=${normalizeSecret(secret)}`];
  if (issuer) q.push(`issuer=${encodeURIComponent(issuer)}`);
  q.push(`algorithm=${algorithmOf(algorithm)}`, `digits=${digits}`, `period=${period}`);
  return `otpauth://totp/${path}?${q.join('&')}`;
}

/** HOTP (RFC 4226) for an explicit counter. */
export async function generateHotp(config, counter) {
  const { secret, algorithm = 'SHA1', digits = 6 } = config;
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret),
    { name: 'HMAC', hash: ALGORITHMS[algorithmOf(algorithm)] },
    false,
    ['sign'],
  );
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32));
  msg.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg.buffer));
  const off = h[h.length - 1] & 0x0f; // dynamic truncation
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** TOTP code (RFC 6238) for the given time. */
export async function generateTotp(config, nowMs = Date.now()) {
  const period = config.period || 30;
  return generateHotp(config, Math.floor(nowMs / 1000 / period));
}

/** Whole seconds until the current code changes (1..period). */
export function remainingSeconds(config, nowMs = Date.now()) {
  const period = config.period || 30;
  return period - (Math.floor(nowMs / 1000) % period);
}
