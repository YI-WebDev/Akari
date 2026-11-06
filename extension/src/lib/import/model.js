// Shared types and helpers for importers (PLAN.md §7).
//
// ImportedItem = {
//   type: one of shared/item-types.js TYPE_IDS ('login', 'note', 'card', 'identity', 'sshKey', …),
//   title, note,                                  // strings ('' when absent)
//   url, username, password, totp, passkeys,      // login only
//   fields: { [templateKey]: string },            // every other type except note (see item-types.js)
//   extra: [{ label, value, secret: boolean }],   // custom fields that fit no template key, any type
//   fav: boolean, createdAt?: number, updatedAt?: number,   // ms
// }
// totp: TotpConfig | null (lib/totp.js). passkeys: [{ credentialId, rpId, userHandle, userName,
// userDisplayName, privateKey /* PKCS8 ES256, b64url */, createdAt }].
// Records of a kind with no Akari type at all become 'note' items whose note lists their
// fields as "label: value" lines (fieldsToNote), so nothing is lost.

import { parseOtpauthUri, normalizeSecret, isValidSecret } from '../totp.js';
import { TYPE_IDS, typeOf, typeLabel, hasTemplate, LIMITS } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';

export class ImportError extends Error {
  /** @param {'NEEDS_PASSWORD'|'BAD_PASSWORD'|'INVALID_FORMAT'|'UNSUPPORTED'|'EMPTY'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const str = (v) => (v == null ? '' : String(v)).trim();

/** Keep only the template's keys, as non-empty strings (secrets keep surrounding spaces). */
function cleanFields(type, fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const fd of typeOf(type).fields) {
    if (!Object.hasOwn(fields, fd.key) || fields[fd.key] == null) continue;
    const v = fd.kind.startsWith('secret') ? String(fields[fd.key]) : str(fields[fd.key]);
    if (v.trim()) out[fd.key] = v.replace(/\r\n?/g, '\n');
  }
  return out;
}

function cleanExtra(extra) {
  if (!Array.isArray(extra)) return [];
  return extra
    .map((e) => ({ label: str(e?.label) || t('import.label.field', null, '項目'), value: e?.value == null ? '' : String(e.value), secret: !!e?.secret }))
    .filter((e) => e.value.trim());
}

/** Fill defaults and trim strings; returns null for items with nothing worth keeping. */
export function makeImported(p) {
  const type = TYPE_IDS.includes(p.type) ? p.type : 'login';
  const extra = cleanExtra(p.extra);
  let note = p.note == null ? '' : String(p.note).replace(/\r\n?/g, '\n').trim();
  if (extra.length > LIMITS.extraCount) {
    // The SW accepts at most LIMITS.extraCount extra fields; keep the rest as note lines.
    note = [note, fieldsToNote(extra.splice(LIMITS.extraCount).map((e) => [e.label, e.value]))].filter(Boolean).join('\n\n');
  }
  const it = { type, title: str(p.title), note, fav: !!p.fav, extra };
  if (type === 'login') {
    Object.assign(it, {
      url: str(p.url),
      username: str(p.username),
      password: p.password == null ? '' : String(p.password), // passwords keep surrounding spaces
      totp: p.totp || null,
      passkeys: Array.isArray(p.passkeys) ? p.passkeys : [],
    });
  } else if (hasTemplate(type)) {
    it.fields = cleanFields(type, p.fields);
  }
  if (Number.isFinite(p.createdAt)) it.createdAt = p.createdAt;
  if (Number.isFinite(p.updatedAt)) it.updatedAt = p.updatedAt;
  if (!it.title) {
    it.title = type === 'login' ? hostOf(it.url) || it.username : '';
    it.title ||= type === 'note' ? t('import.title.note', null, 'メモ') : typeLabel(type);
  }
  const loginEmpty = type === 'login' && !it.url && !it.username && !it.password && !it.totp && !it.passkeys.length;
  const fieldsEmpty = hasTemplate(type) && !Object.keys(it.fields).length;
  const empty = !it.note && !it.extra.length && (type === 'note' || loginEmpty || fieldsEmpty);
  return empty ? null : it;
}

/** "label: value" lines for fields of item kinds Akari doesn't model. Empty values are dropped. */
export function fieldsToNote(fields, extra = '') {
  const lines = fields.filter(([, v]) => str(v)).map(([k, v]) => `${k}: ${String(v).trim()}`);
  return [lines.join('\n'), str(extra)].filter(Boolean).join('\n\n');
}

/** Accepts an otpauth:// URI or a bare base32 secret; anything else (e.g. steam://) → null. */
export function parseOtp(value, fallbackLabel = '') {
  const v = str(value);
  if (!v) return null;
  if (/^otpauth:\/\//i.test(v)) {
    try { return parseOtpauthUri(v); } catch { return null; }
  }
  const secret = normalizeSecret(v);
  if (!isValidSecret(secret)) return null;
  return { secret, algorithm: 'SHA1', digits: 6, period: 30, issuer: '', label: fallbackLabel };
}

export function hostOf(url) {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url).hostname;
  } catch {
    return '';
  }
}

/** Parse a date given as ms, s, or an ISO / "YYYY-MM-DD hh:mm" string. */
export function toMs(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n); // seconds vs ms
  }
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

const truthy = new Set(['1', 'true', 'yes', 'y', 'on']);
export const isTruthy = (v) => truthy.has(str(v).toLowerCase());

/** Decode text: UTF-8 (BOM stripped) or UTF-16 with BOM. */
export function bytesToText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

export const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** OpenPGP: ASCII armor, or a binary packet (new or old format tag byte). */
export function isPgp(b) {
  if (b.length < 2) return false;
  const head = new TextDecoder().decode(b.subarray(0, 64)).trimStart();
  if (head.startsWith('-----BEGIN PGP MESSAGE-----')) return true;
  const tag = b[0];
  if (!(tag & 0x80)) return false;
  const id = tag & 0x40 ? tag & 0x3f : (tag >> 2) & 0x0f;
  return id === 1 || id === 3; // PKESK or SKESK starts an encrypted message
}

export function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError('INVALID_FORMAT', t('{what} の JSON として読めませんでした', { what }));
  }
}
