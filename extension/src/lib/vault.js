// Encrypted vault record (PLAN.md §2), backups, and item helpers. Pure: no chrome.* access.

import { toB64, fromB64, fromB64url, randomBytes, randomInt } from '../shared/bytes.js';
import { AkariError } from '../shared/api.js';
import { ERR, DEFAULT_VAULTS } from '../shared/messages.js';
import {
  PBKDF2_ITERATIONS, deriveKek, generateDek, wrapDek, unwrapDek, encryptJson, decryptJson,
} from './crypto.js';

export const VAULT_VERSION = 1;
export const BACKUP_FORMAT = 'akari-backup';
export const BACKUP_VERSION = 1;
// Bounds for kdf.iterations read from storage or a backup file (guards against a
// crafted backup making PBKDF2 run for hours).
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10000000;
const SALT_BYTES = 16;

export const ITEM_TYPES = Object.freeze(['login', 'note']);
export const FIELD_CAPS = Object.freeze({ title: 200, url: 2048, username: 512, password: 1024, note: 10000 });
const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

const invalid = (message) => new AkariError(ERR.INVALID, message);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHue = (v) => Number.isInteger(v) && v >= 0 && v <= 359;
const isBox = (b) => isObject(b) && typeof b.iv === 'string' && typeof b.ct === 'string';

export function defaultData(nowMs = Date.now()) {
  return { vaults: DEFAULT_VAULTS.map((v) => ({ ...v })), items: [], updatedAt: nowMs };
}

// ---- record ---------------------------------------------------------------

/** Throws INVALID unless `record` has the `akari.vault` v1 shape. */
export function checkRecord(record) {
  const kdf = record?.kdf;
  const ok = isObject(record) && record.version === VAULT_VERSION && isObject(kdf)
    && kdf.name === 'PBKDF2' && kdf.hash === 'SHA-256'
    && Number.isInteger(kdf.iterations) && kdf.iterations >= MIN_ITERATIONS && kdf.iterations <= MAX_ITERATIONS
    && typeof kdf.salt === 'string' && isBox(record.wrappedKey) && isBox(record.data);
  if (!ok) throw invalid('Unsupported vault record');
}

function saltOf(record) {
  try {
    const salt = fromB64(record.kdf.salt);
    if (salt.length >= 8) return salt;
  } catch { /* fall through */ }
  throw invalid('Malformed vault salt');
}

function checkData(data) {
  if (!isObject(data) || !Array.isArray(data.vaults) || !Array.isArray(data.items)) throw invalid('Malformed vault data');
  return data;
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

/** → { dek, data }. Wrong password → BAD_PASSWORD; tampered data → INVALID. */
export async function openVaultRecord(record, password) {
  checkRecord(record);
  const kek = await deriveKek(password, saltOf(record), record.kdf.iterations);
  const dek = await unwrapDek(kek, record.wrappedKey);
  return { dek, data: await readVaultData(record, dek) };
}

/** Decrypts record.data with an already-known DEK (session resume after a SW restart). */
export async function readVaultData(record, dek) {
  checkRecord(record);
  return checkData(await decryptJson(dek, record.data));
}

/** New record with `data` re-encrypted under a fresh IV; key material unchanged. */
export async function sealData(record, dek, data) {
  return { ...record, data: await encryptJson(dek, data) };
}

// ---- backup ---------------------------------------------------------------

/** The backup is the encrypted record as-is; it opens with the master password at export time. */
export function exportBackup(record, nowMs = Date.now()) {
  checkRecord(record);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    vault: record,
  }, null, 2);
}

/** Decrypts a backup with the backup's own password → normalized VaultData (invalid items dropped). */
export async function importBackup(json, password) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw invalid('Not an Akari backup file');
  }
  if (!isObject(obj) || obj.format !== BACKUP_FORMAT || obj.version !== BACKUP_VERSION) {
    throw invalid('Not an Akari backup file');
  }
  const { data } = await openVaultRecord(obj.vault, password);
  return normalizeData(data);
}

function normalizeVault(v) {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > 64) return null;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 100) : v.id;
  return { id: v.id, name, hue: isHue(v.hue) ? v.hue : 55 };
}

// Timestamps from a backup are clamped to [0, now] so a crafted far-future
// updatedAt cannot win every later merge.
const clampTs = (v, fallback, nowMs) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), nowMs) : fallback);

const B64URL = /^[A-Za-z0-9_-]+$/;
function b64urlLength(v) {
  if (typeof v !== 'string' || !B64URL.test(v)) return -1;
  try {
    return fromB64url(v).length;
  } catch {
    return -1;
  }
}
const lengthIn = (v, min, max) => {
  const n = b64urlLength(v);
  return n >= min && n <= max;
};
const HOST_LIKE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const COSE_ALG_ES256 = -7;
const optString = (v, max) => v == null || (typeof v === 'string' && v.length <= max);

/** Full shape check of an imported passkey; returns a copy with only known fields, or null. */
function normalizePasskey(pk, nowMs) {
  const ok = isObject(pk)
    && lengthIn(pk.credentialId, 16, 1023)
    && lengthIn(pk.userHandle, 1, 64)
    && lengthIn(pk.privateKey, 32, 2048)
    && lengthIn(pk.publicKey, 32, 1024)
    && pk.alg === COSE_ALG_ES256
    && typeof pk.rpId === 'string' && HOST_LIKE.test(pk.rpId)
    && (pk.signCount == null || (Number.isSafeInteger(pk.signCount) && pk.signCount >= 0))
    && optString(pk.userName, 256) && optString(pk.userDisplayName, 256)
    && Number.isFinite(pk.createdAt) && (pk.lastUsedAt == null || Number.isFinite(pk.lastUsedAt));
  if (!ok) return null;
  return {
    credentialId: pk.credentialId,
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: pk.userName ?? '',
    userDisplayName: pk.userDisplayName ?? '',
    privateKey: pk.privateKey,
    publicKey: pk.publicKey,
    alg: COSE_ALG_ES256,
    signCount: pk.signCount ?? 0,
    createdAt: clampTs(pk.createdAt, nowMs, nowMs),
    lastUsedAt: clampTs(pk.lastUsedAt, null, nowMs),
  };
}

function normalizePasskeys(list, nowMs) {
  if (!Array.isArray(list)) return [];
  const out = new Map();
  for (const pk of list.map((p) => normalizePasskey(p, nowMs))) {
    if (pk && !out.has(pk.credentialId)) out.set(pk.credentialId, pk);
  }
  return [...out.values()];
}

function normalizeImportedItem(raw, nowMs) {
  const fields = validateItem(raw);
  if (!fields.id) throw invalid('Item without id');
  const createdAt = clampTs(raw.createdAt, nowMs, nowMs);
  return makeItem({
    ...fields,
    passkeys: normalizePasskeys(raw.passkeys, nowMs),
    createdAt,
    updatedAt: clampTs(raw.updatedAt, createdAt, nowMs),
    passwordUpdatedAt: clampTs(raw.passwordUpdatedAt, null, nowMs),
    lastUsedAt: clampTs(raw.lastUsedAt, null, nowMs),
  }, nowMs);
}

/** Validates untrusted VaultData (e.g. from a backup), dropping entries that do not validate. */
export function normalizeData(data, nowMs = Date.now()) {
  checkData(data);
  const vaults = new Map();
  for (const v of data.vaults.map(normalizeVault)) if (v && !vaults.has(v.id)) vaults.set(v.id, v);
  const items = new Map();
  for (const raw of data.items) {
    try {
      const item = normalizeImportedItem(raw, nowMs);
      items.set(item.id, item);
    } catch { /* skip invalid item */ }
  }
  return { vaults: [...vaults.values()], items: [...items.values()], updatedAt: clampTs(data.updatedAt, nowMs, nowMs) };
}

/**
 * Merges normalized `incoming` into `current` (neither is modified).
 * - Vaults: unknown ids are added; existing vaults keep their name/hue.
 * - Items: by id, the newer updatedAt wins for the user-visible fields.
 * - Passkeys: an import never replaces or adds to an existing item's passkeys.
 *   Only items new to this vault bring their passkeys, minus any whose
 *   credentialId or (rpId, userHandle) is already present anywhere in the vault.
 * @returns {{ data: object, count: number }} count = items added or replaced
 */
export function mergeData(current, incoming) {
  const data = structuredClone(current);
  for (const v of incoming.vaults) {
    if (!data.vaults.some((x) => x.id === v.id)) data.vaults.push(structuredClone(v));
  }
  const vaultIds = new Set(data.vaults.map((v) => v.id));
  const fallbackVault = data.vaults[0]?.id ?? 'personal';
  const index = new Map(data.items.map((it, i) => [it.id, i]));
  const credIds = new Set();
  const accounts = new Set();
  const accountKey = (pk) => pk.rpId + '\n' + pk.userHandle;
  for (const it of data.items) {
    for (const pk of it.passkeys || []) {
      credIds.add(pk.credentialId);
      accounts.add(accountKey(pk));
    }
  }
  let count = 0;
  for (const inc of incoming.items) {
    const item = structuredClone(inc);
    if (!vaultIds.has(item.vault)) item.vault = fallbackVault;
    const i = index.get(item.id);
    if (i === undefined) {
      item.passkeys = (item.passkeys || []).filter((pk) => !credIds.has(pk.credentialId) && !accounts.has(accountKey(pk)));
      for (const pk of item.passkeys) {
        credIds.add(pk.credentialId);
        accounts.add(accountKey(pk));
      }
      index.set(item.id, data.items.length);
      data.items.push(item);
      count++;
    } else if ((item.updatedAt || 0) > (data.items[i].updatedAt || 0)) {
      item.passkeys = data.items[i].passkeys || [];
      data.items[i] = item;
      count++;
    }
  }
  return { data, count };
}

// ---- items ----------------------------------------------------------------

/** Fills id, timestamps, hue and the other PLAN §2 defaults. */
export function makeItem(partial = {}, nowMs = Date.now()) {
  const given = Object.fromEntries(Object.entries(partial || {}).filter(([, v]) => v !== undefined));
  const item = {
    id: '',
    type: 'login',
    vault: 'personal',
    title: '',
    url: '',
    username: '',
    password: '',
    totp: null,
    note: '',
    fav: false,
    hue: null,
    passkeys: [],
    createdAt: nowMs,
    updatedAt: nowMs,
    passwordUpdatedAt: given.password ? nowMs : null,
    lastUsedAt: null,
    ...given,
  };
  if (typeof item.id !== 'string' || !item.id) item.id = crypto.randomUUID();
  if (!isHue(item.hue)) item.hue = randomInt(360);
  if (!Array.isArray(item.passkeys)) item.passkeys = [];
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

/**
 * Validates the user-editable fields that are present on `item` and returns a
 * normalized copy containing only those fields (plus id). Throws INVALID.
 * Non-editable fields (passkeys, timestamps) are never returned.
 */
export function validateItem(item) {
  if (!isObject(item)) throw invalid('Item must be an object');
  const has = (k) => item[k] !== undefined;
  const out = {};
  if (item.id != null && item.id !== '') {
    if (typeof item.id !== 'string' || item.id.length > 100) throw invalid('Invalid id');
    out.id = item.id;
  }
  if (has('type')) {
    if (!ITEM_TYPES.includes(item.type)) throw invalid('Invalid type');
    out.type = item.type;
  }
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
  return out;
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
