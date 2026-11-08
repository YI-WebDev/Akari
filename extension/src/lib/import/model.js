import { parseOtpauthUri, normalizeSecret, isValidSecret } from '../totp.js';
import { TYPE_IDS, typeOf, typeLabel, hasTemplate, LIMITS } from '../../shared/item-types.js';
import { t } from '../../shared/i18n.js';

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const EPOCH_SECONDS_BELOW = 1e11;
const PGP_ARMOR_HEADER = '-----BEGIN PGP MESSAGE-----';
const PGP_PUBLIC_KEY_ENCRYPTED_SESSION_KEY = 1;
const PGP_SYMMETRIC_KEY_ENCRYPTED_SESSION_KEY = 3;

const str = (v) => (v == null ? '' : String(v)).trim();

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

export function makeImported(p) {
  const type = TYPE_IDS.includes(p.type) ? p.type : 'login';
  const extra = cleanExtra(p.extra);
  let note = p.note == null ? '' : String(p.note).replace(/\r\n?/g, '\n').trim();
  if (extra.length > LIMITS.extraCount) {
    note = [note, fieldsToNote(extra.splice(LIMITS.extraCount).map((e) => [e.label, e.value]))].filter(Boolean).join('\n\n');
  }
  const it = { type, title: str(p.title), note, fav: !!p.fav, extra };
  if (type === 'login') {
    Object.assign(it, {
      url: str(p.url),
      username: str(p.username),
      password: p.password == null ? '' : String(p.password),
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

export function fieldsToNote(fields, extra = '') {
  const lines = fields.filter(([, v]) => str(v)).map(([k, v]) => `${k}: ${String(v).trim()}`);
  return [lines.join('\n'), str(extra)].filter(Boolean).join('\n\n');
}

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

export function toMs(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n < EPOCH_SECONDS_BELOW ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}

const truthy = new Set(['1', 'true', 'yes', 'y', 'on']);
export const isTruthy = (v) => truthy.has(str(v).toLowerCase());

export function bytesToText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

export const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export function isPgp(b) {
  if (b.length < 2) return false;
  const head = new TextDecoder().decode(b.subarray(0, 64)).trimStart();
  if (head.startsWith(PGP_ARMOR_HEADER)) return true;
  const tag = b[0];
  const isPacketHeader = tag & 0x80;
  if (!isPacketHeader) return false;
  const isNewFormat = tag & 0x40;
  const packetType = isNewFormat ? tag & 0x3f : (tag >> 2) & 0x0f;
  return packetType === PGP_PUBLIC_KEY_ENCRYPTED_SESSION_KEY || packetType === PGP_SYMMETRIC_KEY_ENCRYPTED_SESSION_KEY;
}

export function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError('INVALID_FORMAT', t('{what} の JSON として読めませんでした', { what }));
  }
}
