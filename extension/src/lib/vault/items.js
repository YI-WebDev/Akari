// Items: defaults per type, validation of what the popup may change, the legacy-key cleanup and
// the copy that may leave the service worker. Pure: no chrome.* access.

import { randomInt } from '../../shared/bytes.js';
import { TYPE_IDS, typeOf, hasTemplate, isSecretKind, LIMITS } from '../../shared/item-types.js';
import { invalid, isObject, isHue } from './common.js';

export const FIELD_CAPS = Object.freeze({ title: 200, url: 2048, username: 512, password: 1024, note: 10000 });
// Keys only a 'login' carries (passkeys and passwordUpdatedAt are never editable anyway).
const LOGIN_ONLY = Object.freeze(['url', 'username', 'password', 'totp']);
const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

/**
 * Fills id, timestamps, hue and the other PLAN §2 defaults for the item's type (item-types.js):
 * every type gets `extra: []`; logins add url/username/password/totp/passkeys/passwordUpdatedAt;
 * templated types add `fields: {}`. Given keys are kept as-is (callers validate first).
 */
export function makeItem(partial = {}, nowMs = Date.now()) {
  const given = Object.fromEntries(Object.entries(partial || {}).filter(([, v]) => v !== undefined));
  const type = given.type ?? 'login';
  const item = {
    id: '',
    type,
    vault: 'personal',
    title: '',
    note: '',
    fav: false,
    hue: null,
    extra: [],
    createdAt: nowMs,
    updatedAt: nowMs,
    lastUsedAt: null,
  };
  if (type === 'login') {
    Object.assign(item, {
      url: '', username: '', password: '', totp: null, passkeys: [], passwordUpdatedAt: given.password ? nowMs : null,
    });
  } else if (hasTemplate(type)) {
    item.fields = {};
  }
  Object.assign(item, given);
  if (typeof item.id !== 'string' || !item.id) item.id = crypto.randomUUID();
  if (!isHue(item.hue)) item.hue = randomInt(360);
  if (type === 'login' && !Array.isArray(item.passkeys)) item.passkeys = [];
  return item;
}

/** "github.com/login" → "https://github.com/login". Only http(s) URLs are accepted. */
export function normalizeUrl(url) {
  const s = url.trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw invalid('Invalid url');
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) throw invalid('Only http(s) URLs are allowed');
  return withScheme;
}

function normalizeTotp(t) {
  if (t === null) return null;
  if (!isObject(t) || typeof t.secret !== 'string') throw invalid('Invalid totp');
  const secret = t.secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]{8,1024}$/.test(secret)) throw invalid('Invalid totp secret');
  const algorithm = t.algorithm == null ? 'SHA1' : String(t.algorithm).toUpperCase().replace('-', '');
  const digits = t.digits ?? 6;
  const period = t.period ?? 30;
  const issuer = t.issuer ?? '';
  const label = t.label ?? '';
  if (!TOTP_ALGORITHMS.includes(algorithm)) throw invalid('Invalid totp algorithm');
  if (digits !== 6 && digits !== 8) throw invalid('Invalid totp digits');
  if (!Number.isInteger(period) || period < 1 || period > 300) throw invalid('Invalid totp period');
  if (typeof issuer !== 'string' || issuer.length > 200) throw invalid('Invalid totp issuer');
  if (typeof label !== 'string' || label.length > 200) throw invalid('Invalid totp label');
  return { secret, algorithm, digits, period, issuer, label };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const TEL_RE = /^\+?[\p{Nd}\s()\-./#*,;‐–—－ー（）＋]+(?:\s*(?:ext\.?|x|内線)\s*\p{Nd}+)?$/iu;
const isMultilineKind = (kind) => kind === 'multiline' || kind === 'secret-multiline';

function isCalendarDate(y, m, d) {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * One template value, normalized by its field's kind; '' when blank. Throws INVALID.
 * Single-line non-secret values are trimmed, secrets keep their spaces, multiline values get LF
 * line ends. A card number keeps its grouping ("-" becomes " ") but must hold 8–19 digits.
 */
export function normalizeFieldValue(fd, value) {
  if (typeof value !== 'string') throw invalid('Invalid ' + fd.key);
  const multiline = isMultilineKind(fd.kind);
  let v = multiline ? value.replace(/\r\n?/g, '\n') : value;
  if (!v.trim()) return '';
  if (!multiline && !isSecretKind(fd.kind)) v = v.trim();
  const bad = () => invalid('Invalid ' + fd.key);
  if (fd.format === 'card') {
    v = v.trim().replace(/-/g, ' ');
    const digits = v.replace(/ /g, '');
    if (!/^\d+$/.test(digits) || digits.length < 8 || digits.length > 19) throw bad();
  }
  switch (fd.kind) {
    case 'date': {
      const m = DATE_RE.exec(v);
      if (!m || !isCalendarDate(+m[1], +m[2], +m[3])) throw bad();
      break;
    }
    case 'month': {
      const m = MONTH_RE.exec(v);
      if (!m || +m[1] < 1 || +m[2] < 1 || +m[2] > 12) throw bad();
      break;
    }
    case 'number':
      if (!/^\d+$/.test(v)) throw bad();
      break;
    case 'email':
      if (!EMAIL_RE.test(v)) throw bad();
      break;
    case 'tel':
      if (!TEL_RE.test(v) || !/\p{Nd}/u.test(v)) throw bad();
      break;
    case 'url':
      v = normalizeUrl(v); // same rules as a login URL: http(s) only
      break;
    case 'select': // stored as an option id (language-neutral), never its label
      if (!fd.options.some((o) => o.id === v)) throw bad();
      break;
    default: // text, secret, multiline, secret-multiline: any string
  }
  if (v.length > (multiline ? LIMITS.multilineValue : LIMITS.fieldValue)) throw invalid(fd.key + ' is too long');
  return v;
}

/** `fields` of a templated type → only non-blank, normalized template values. Unknown keys → INVALID. */
function normalizeFields(type, fields) {
  if (!isObject(fields)) throw invalid('Invalid fields');
  const template = typeOf(type).fields;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const fd = template.find((f) => f.key === key);
    if (!fd) throw invalid(`Unknown field "${key}" for ${type}`);
    const v = normalizeFieldValue(fd, value);
    if (v) out[key] = v;
  }
  return out;
}

/** Custom fields (any type): ≤ LIMITS.extraCount of { label, value, secret }; blank rows are dropped. */
function normalizeExtra(list) {
  if (!Array.isArray(list) || list.length > LIMITS.extraCount) throw invalid('Invalid extra');
  const out = [];
  for (const e of list) {
    if (!isObject(e) || typeof e.label !== 'string' || typeof e.value !== 'string'
      || (e.secret !== undefined && typeof e.secret !== 'boolean')) throw invalid('Invalid extra field');
    const label = e.label.trim();
    const value = e.value.replace(/\r\n?/g, '\n');
    if (label.length > LIMITS.extraLabel || value.length > LIMITS.extraValue) throw invalid('extra field is too long');
    if (!label && !value.trim()) continue;
    out.push({ label, value, secret: e.secret === true });
  }
  return out;
}

/**
 * Validates the user-editable fields that are present on `item` and returns a
 * normalized copy containing only those fields (plus id). Throws INVALID.
 * Non-editable fields (passkeys, timestamps) are never returned.
 *
 * `stored` is the item being updated (null for a new one): its type is used when `item`
 * has none, and the type can never change. Per type (shared/item-types.js):
 * - `fields` only on templated types; keys must be template keys, values strings checked
 *   per kind; `fields: {}` is accepted (and dropped) on login/note.
 * - `extra` on any type.
 * - Login-only keys (url, username, password, totp) on any other type: '' / null are
 *   accepted and dropped (legacy notes were stored with url/username/password = '');
 *   a non-empty value is INVALID unless it equals the stored item's value (a legacy
 *   value is kept, never lost, but cannot be set or changed).
 */
export function validateItem(item, stored = null) {
  if (!isObject(item)) throw invalid('Item must be an object');
  const has = (k) => item[k] !== undefined;
  const out = {};
  if (item.id != null && item.id !== '') {
    if (typeof item.id !== 'string' || item.id.length > 100) throw invalid('Invalid id');
    out.id = item.id;
  }
  const storedType = stored ? stored.type ?? 'login' : null;
  if (has('type')) {
    if (!TYPE_IDS.includes(item.type)) throw invalid('Invalid type');
    if (storedType && item.type !== storedType) throw invalid('Item type cannot change');
    out.type = item.type;
  }
  const type = out.type ?? storedType ?? 'login';
  if (has('vault')) {
    if (typeof item.vault !== 'string' || !item.vault || item.vault.length > 64) throw invalid('Invalid vault');
    out.vault = item.vault;
  }
  for (const key of Object.keys(FIELD_CAPS)) {
    if (!has(key)) continue;
    if (typeof item[key] !== 'string') throw invalid('Invalid ' + key);
    let v = item[key];
    if (key === 'title') v = v.trim();
    if (key === 'url') v = normalizeUrl(v);
    if (v.length > FIELD_CAPS[key]) throw invalid(key + ' is too long');
    out[key] = v;
  }
  if (has('totp')) out.totp = normalizeTotp(item.totp);
  if (has('fav')) {
    if (typeof item.fav !== 'boolean') throw invalid('Invalid fav');
    out.fav = item.fav;
  }
  if (item.hue != null) {
    if (!isHue(item.hue)) throw invalid('Invalid hue');
    out.hue = item.hue;
  }
  if (type !== 'login') {
    for (const key of LOGIN_ONLY) {
      if (!(key in out)) continue;
      if (out[key] === '' || out[key] === null) delete out[key];
      else if (!stored || JSON.stringify(item[key]) !== JSON.stringify(stored[key])) throw invalid(key + ' is only for logins');
    }
  }
  if (has('fields')) {
    if (hasTemplate(type)) out.fields = normalizeFields(type, item.fields);
    else if (!isObject(item.fields) || Object.keys(item.fields).length) throw invalid('fields are not allowed for ' + type);
  }
  if (has('extra')) out.extra = normalizeExtra(item.extra);
  return out;
}

/**
 * A non-login item drops the empty login keys a legacy note was stored with ('' / null / []).
 * Non-empty legacy values stay (validateItem never lets them change).
 */
export function stripLegacyLoginKeys(item) {
  if ((item.type ?? 'login') === 'login') return item;
  for (const key of ['url', 'username', 'password']) if (item[key] === '') delete item[key];
  if (item.totp === null) delete item.totp;
  if (Array.isArray(item.passkeys) && !item.passkeys.length) delete item.passkeys;
  if (item.password === undefined) delete item.passwordUpdatedAt;
  delete item.passwordHistory; // login-only
  delete item.pendingPassword;
  return item;
}

/** Deep copy with passkeys[].privateKey removed — the only form that may leave the SW. */
export function sanitizeItem(item) {
  const copy = structuredClone(item);
  if (Array.isArray(copy.passkeys)) {
    copy.passkeys = copy.passkeys.map((pk) => {
      if (!isObject(pk)) return pk;
      const { privateKey, ...rest } = pk; // eslint-disable-line no-unused-vars
      return rest;
    });
  }
  return copy;
}
