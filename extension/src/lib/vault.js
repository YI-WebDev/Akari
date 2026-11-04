// Encrypted vault record (PLAN.md §2), backups, and item helpers. Pure: no chrome.* access.

import { toB64, fromB64, toB64url, fromB64url, randomBytes, randomInt } from '../shared/bytes.js';
import { AkariError } from '../shared/api.js';
import { ERR, DEFAULT_VAULTS, VAULT_LIMITS } from '../shared/messages.js';
import {
  PBKDF2_ITERATIONS, deriveKek, generateDek, wrapDek, unwrapDek, encryptJson, decryptJson,
} from './crypto.js';
import { encode as cborEncode } from './cbor.js';
import { registrableDomain, isPublicSuffix, isIpAddress } from '../shared/domain.js';
import { TYPE_IDS, typeOf, hasTemplate, isSecretKind, fieldLabel, LIMITS } from '../shared/item-types.js';

export const VAULT_VERSION = 1;
export const BACKUP_FORMAT = 'akari-backup';
export const BACKUP_VERSION = 1;
// Bounds for kdf.iterations read from storage or a backup file (guards against a
// crafted backup making PBKDF2 run for hours).
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 10000000;
const SALT_BYTES = 16;

export const FIELD_CAPS = Object.freeze({ title: 200, url: 2048, username: 512, password: 1024, note: 10000 });
// Keys only a 'login' carries (passkeys and passwordUpdatedAt are never editable anyway).
const LOGIN_ONLY = Object.freeze(['url', 'username', 'password', 'totp']);
const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];

const invalid = (message) => new AkariError(ERR.INVALID, message);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isHue = (v) => Number.isInteger(v) && v >= 0 && v <= 359;
const isBox = (b) => isObject(b) && typeof b.iv === 'string' && typeof b.ct === 'string';

export function defaultData(nowMs = Date.now()) {
  return { vaults: DEFAULT_VAULTS.map((v) => ({ ...v })), items: [], updatedAt: nowMs };
}

// ---- vaults (保管庫): create / rename / recolor / delete on decrypted data -------------

const nameKey = (name) => name.normalize('NFKC').toLowerCase();

/** A vault name as stored: trimmed, 1–VAULT_LIMITS.name characters, no control characters, unique. */
function vaultName(data, name, exceptId) {
  if (typeof name !== 'string') throw invalid('Vault name required');
  const v = name.trim();
  if (!v) throw invalid('Vault name required');
  if ([...v].length > VAULT_LIMITS.name) throw invalid(`Vault name too long (max ${VAULT_LIMITS.name})`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw invalid('Vault name has control characters');
  if (data.vaults.some((x) => x.id !== exceptId && nameKey(x.name) === nameKey(v))) throw invalid('Duplicate vault name');
  return v;
}

/** Adds a vault with a fresh id; returns it. */
export function createVaultIn(data, { name, hue }) {
  if (data.vaults.length >= VAULT_LIMITS.count) throw invalid(`Too many vaults (max ${VAULT_LIMITS.count})`);
  if (!isHue(hue)) throw invalid('Invalid hue');
  const vault = { id: '', name: vaultName(data, name), hue };
  do vault.id = 'v-' + toB64url(randomBytes(6)); while (data.vaults.some((x) => x.id === vault.id));
  data.vaults.push(vault);
  return { ...vault };
}

/** Renames and/or recolors a vault; returns it. */
export function updateVaultIn(data, id, { name, hue }) {
  const vault = data.vaults.find((x) => x.id === id);
  if (!vault) throw new AkariError(ERR.NOT_FOUND, 'Vault not found');
  if (name === undefined && hue === undefined) throw invalid('Nothing to change');
  if (hue !== undefined && !isHue(hue)) throw invalid('Invalid hue');
  if (name !== undefined) vault.name = vaultName(data, name, id);
  if (hue !== undefined) vault.hue = hue;
  return { ...vault };
}

/**
 * Removes a vault. Its items move to `moveTo` (another vault), or are deleted with it only when
 * `deleteItems` is true: a vault that turns out to hold items the caller did not know about
 * (another popup, an import meanwhile) is refused with NOT_EMPTY instead of emptied silently.
 * The last vault cannot go. Returns how many items were moved / deleted.
 */
export function deleteVaultIn(data, id, { moveTo = null, deleteItems = false } = {}, nowMs = Date.now()) {
  const index = data.vaults.findIndex((x) => x.id === id);
  if (index < 0) throw new AkariError(ERR.NOT_FOUND, 'Vault not found');
  if (data.vaults.length <= 1) throw invalid('The last vault cannot be deleted');
  if (moveTo !== null && (moveTo === id || !data.vaults.some((x) => x.id === moveTo))) throw invalid('Unknown vault to move to');
  if (moveTo !== null && deleteItems) throw invalid('Either move the items or delete them');
  if (moveTo === null && !deleteItems && data.items.some((it) => it.vault === id)) {
    throw new AkariError(ERR.NOT_EMPTY, 'Vault is not empty');
  }
  let moved = 0;
  let deleted = 0;
  if (moveTo !== null) {
    for (const it of data.items) {
      if (it.vault !== id) continue;
      it.vault = moveTo;
      it.updatedAt = nowMs;
      moved++;
    }
  } else {
    const keep = data.items.filter((it) => it.vault !== id);
    deleted = data.items.length - keep.length;
    data.items = keep;
  }
  data.vaults.splice(index, 1);
  return { moved, deleted };
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
  // The backup's own item is its "stored" state, so a legacy note keeps a non-empty url/username/password.
  const fields = validateItem(raw, raw);
  if (!fields.id) throw invalid('Item without id');
  const createdAt = clampTs(raw.createdAt, nowMs, nowMs);
  const login = (fields.type ?? 'login') === 'login';
  return makeItem({
    ...fields,
    ...(login && {
      passkeys: normalizePasskeys(raw.passkeys, nowMs),
      passwordUpdatedAt: clampTs(raw.passwordUpdatedAt, null, nowMs),
    }),
    createdAt,
    updatedAt: clampTs(raw.updatedAt, createdAt, nowMs),
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
 *   An item whose type differs from the stored item with the same id is skipped.
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
    const login = (item.type ?? 'login') === 'login';
    if (i === undefined) {
      if (login) {
        item.passkeys = (item.passkeys || []).filter((pk) => !credIds.has(pk.credentialId) && !accounts.has(accountKey(pk)));
        for (const pk of item.passkeys) {
          credIds.add(pk.credentialId);
          accounts.add(accountKey(pk));
        }
      } else {
        delete item.passkeys; // only logins hold passkeys
      }
      index.set(item.id, data.items.length);
      data.items.push(item);
      count++;
    } else if ((item.type ?? 'login') === (data.items[i].type ?? 'login') && (item.updatedAt || 0) > (data.items[i].updatedAt || 0)) {
      if (login) item.passkeys = data.items[i].passkeys || [];
      else delete item.passkeys;
      data.items[i] = item;
      count++;
    }
  }
  return { data, count };
}

// ---- import from other managers (PLAN.md §7.3) ----------------------------

export const MAX_IMPORT_ITEMS = 20000;
const IMPORT_FIELDS = ['type', 'title', 'url', 'username', 'password', 'note', 'totp', 'fav', 'fields', 'extra'];

/**
 * Passkey from another manager's export (lib/import ImportedItem: PKCS8 ES256 private
 * key, no public key) → stored Passkey, or null. The private key must import as a
 * P-256 ECDSA key; its COSE public key is derived from it, then the passkey goes
 * through the same checks as a backup import. The rpId must also be a registrable
 * domain that is not a public suffix ("com", "github.io"), or "localhost"; no IPs.
 */
export async function passkeyFromImport(pk, nowMs = Date.now()) {
  if (!isObject(pk) || !lengthIn(pk.privateKey, 32, 2048) || !importableRpId(pk.rpId)) return null;
  let publicKey;
  try {
    const key = await crypto.subtle.importKey('pkcs8', fromB64url(pk.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const { x, y } = await crypto.subtle.exportKey('jwk', key);
    publicKey = toB64url(cborEncode(new Map([[1, 2], [3, COSE_ALG_ES256], [-1, 1], [-2, fromB64url(x)], [-3, fromB64url(y)]])));
  } catch {
    return null;
  }
  return normalizePasskey({
    credentialId: pk.credentialId,
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: pk.userName ?? '',
    userDisplayName: pk.userDisplayName ?? '',
    privateKey: pk.privateKey,
    publicKey,
    alg: COSE_ALG_ES256,
    signCount: 0,
    createdAt: Number.isFinite(pk.createdAt) ? pk.createdAt : nowMs,
    lastUsedAt: null,
  }, nowMs);
}

function importableRpId(rpId) {
  if (typeof rpId !== 'string' || !HOST_LIKE.test(rpId)) return false;
  if (rpId === 'localhost') return true;
  return !isIpAddress(rpId) && registrableDomain(rpId) !== null && !isPublicSuffix(rpId);
}

function hostKey(url) {
  try {
    return url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

// Identifiers written with or without separators ("4111 1111…" = "4111-1111…", "TK 123 4567" = "tk1234567").
const COMPACT_KEYS = new Set(['number', 'accountNumber', 'iban']);
const compact = (v) => String(v ?? '').toLowerCase().replace(/[^0-9a-z]/g, '');
const titleKey = (title) => String(title ?? '').trim().toLowerCase();

/**
 * Import dedupe skips EXACT duplicates only, so two different records are never merged
 * (a renewed card, a second API key for the same host, two "Home" Wi-Fi networks…).
 * - Logins: host + username + password + note + TOTP secret + extra; the title too when
 *   host, username and password are all empty (e.g. TOTP only).
 * - Every other type: type + title (trimmed, lowercased) + note + every template value,
 *   secrets included (as stored; card/account/license/passport/SSN numbers and IBANs
 *   compared without separators or case) + extra (label, value, secret).
 */
function duplicateKey(it) {
  const type = it.type ?? 'login';
  const extra = (it.extra || []).map((e) => [e.label, e.value, !!e.secret]);
  if (type === 'login') {
    const id = [hostKey(it.url), it.username ?? '', it.password ?? ''];
    const title = id.some(Boolean) ? '' : titleKey(it.title);
    return JSON.stringify([type, ...id, title, it.note ?? '', it.totp?.secret ?? '', extra]);
  }
  const f = it.fields || {};
  const fields = Object.keys(f).sort().map((k) => [k, COMPACT_KEYS.has(k) ? compact(f[k]) : f[k]]);
  return JSON.stringify([type, titleKey(it.title), it.note ?? '', fields, extra]);
}

/**
 * Import only: a field value that fails its kind's check (a "1990/01/02" date, a hyphenated port…),
 * or a key the type's template does not have, moves to `extra` instead of making the whole item invalid.
 * A select value given as an option label ("WPA2") is mapped to its id ("wpa2").
 */
function salvageFields(type, item) {
  const template = typeOf(type).fields;
  const kept = {};
  const moved = [];
  for (const [key, raw] of Object.entries(item.fields)) {
    if (raw == null || typeof raw === 'object') continue;
    let value = String(raw);
    const fd = template.find((f) => f.key === key);
    if (fd?.kind === 'select') {
      const lc = value.trim().toLowerCase();
      value = fd.options.find((o) => o.id === lc || o.label.toLowerCase() === lc)?.id ?? value;
    }
    if (fd) {
      try {
        normalizeFieldValue(fd, value);
        kept[key] = value;
        continue;
      } catch { /* moved to extra below */ }
    }
    if (value.trim()) moved.push({ label: fd ? fieldLabel(type, key) : key, value, secret: fd ? isSecretKind(fd.kind) : false });
  }
  item.fields = kept;
  if (moved.length && (item.extra === undefined || Array.isArray(item.extra))) item.extra = [...(item.extra || []), ...moved];
}

/** Editable fields of an ImportedItem; a login's non-http(s) URL (androidapp://…) moves into the note. */
function importFields(raw, vaultId) {
  const fields = { vault: vaultId };
  for (const k of IMPORT_FIELDS) if (raw[k] !== undefined) fields[k] = raw[k];
  if (typeof fields.title === 'string') fields.title = fields.title.trim().slice(0, FIELD_CAPS.title);
  const type = fields.type ?? 'login';
  if (TYPE_IDS.includes(type) && isObject(fields.fields)) salvageFields(type, fields);
  if (type === 'login' && typeof fields.url === 'string' && fields.url.trim()
    && (fields.note === undefined || typeof fields.note === 'string')) {
    try {
      normalizeUrl(fields.url);
    } catch {
      fields.note = [fields.note, 'URL: ' + fields.url.trim()].filter(Boolean).join('\n\n');
      fields.url = '';
    }
  }
  return fields;
}

/**
 * Adds items parsed from another manager's export to `data` (in place) as new items
 * of vault `vaultId`, which must exist. Every type is accepted; items that fail
 * validateItem are counted as invalid (template values that fail their kind's check
 * are kept in `extra` first, see salvageFields), duplicates of existing (or earlier)
 * items are skipped, and passkeys (logins only) are kept only when valid and not
 * already present (credentialId or rpId + userHandle).
 * @returns {Promise<{ added: number, duplicates: number, invalid: number, passkeys: number }>}
 */
export async function addImportedItems(data, list, vaultId, nowMs = Date.now()) {
  if (!Array.isArray(list) || list.length > MAX_IMPORT_ITEMS) throw invalid('Too many items');
  if (!data.vaults.some((v) => v.id === vaultId)) throw invalid('Unknown vault');
  const seen = new Set(data.items.map(duplicateKey));
  const credIds = new Set();
  const accounts = new Set();
  const accountKey = (pk) => pk.rpId + '\n' + pk.userHandle;
  for (const it of data.items) {
    for (const pk of it.passkeys || []) {
      credIds.add(pk.credentialId);
      accounts.add(accountKey(pk));
    }
  }
  const out = { added: 0, duplicates: 0, invalid: 0, passkeys: 0 };
  for (const raw of list) {
    let fields;
    try {
      if (!isObject(raw)) throw invalid('Item must be an object');
      fields = validateItem(importFields(raw, vaultId));
    } catch {
      out.invalid++;
      continue;
    }
    const createdAt = clampTs(raw.createdAt, nowMs, nowMs);
    const updatedAt = Math.max(clampTs(raw.updatedAt, createdAt, nowMs), createdAt);
    const login = (fields.type ?? 'login') === 'login';
    const item = makeItem({
      ...fields, createdAt, updatedAt,
      ...(login && { passkeys: [], passwordUpdatedAt: fields.password ? updatedAt : null }),
    }, nowMs);
    const key = duplicateKey(item);
    if (seen.has(key)) {
      out.duplicates++;
      continue;
    }
    seen.add(key);
    if (login) {
      for (const p of Array.isArray(raw.passkeys) ? raw.passkeys : []) {
        const pk = await passkeyFromImport(p, nowMs);
        if (!pk || credIds.has(pk.credentialId) || accounts.has(accountKey(pk))) continue;
        credIds.add(pk.credentialId);
        accounts.add(accountKey(pk));
        item.passkeys.push(pk);
      }
      out.passkeys += item.passkeys.length;
    }
    data.items.push(item);
    out.added++;
  }
  return out;
}

// ---- items ----------------------------------------------------------------

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
function normalizeFieldValue(fd, value) {
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
