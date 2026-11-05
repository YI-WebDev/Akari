// Items from another manager's export (lib/import ImportedItem) added to VaultData, with exact
// duplicates skipped. Pure: no chrome.* access.

import { TYPE_IDS, typeOf, fieldLabel, isSecretKind } from '../../shared/item-types.js';
import { invalid, isObject, clampTs } from './common.js';
import { FIELD_CAPS, makeItem, normalizeUrl, validateItem, normalizeFieldValue } from './items.js';
import { passkeyFromImport } from './passkeys.js';

export const MAX_IMPORT_ITEMS = 20000;
const IMPORT_FIELDS = ['type', 'title', 'url', 'username', 'password', 'note', 'totp', 'fav', 'fields', 'extra'];

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
 * already present (credentialId or rpId + userHandle). A duplicate login still gets
 * the passkeys it lacks, so importing again after an import that dropped them (or
 * from a manager whose passkeys Akari could not read before) brings them in.
 * @returns {Promise<{ added: number, duplicates: number, invalid: number, passkeys: number }>}
 */
export async function addImportedItems(data, list, vaultId, nowMs = Date.now()) {
  if (!Array.isArray(list) || list.length > MAX_IMPORT_ITEMS) throw invalid('Too many items');
  if (!data.vaults.some((v) => v.id === vaultId)) throw invalid('Unknown vault');
  const seen = new Map(data.items.map((it) => [duplicateKey(it), it]));
  const credIds = new Set();
  const accounts = new Set();
  const accountKey = (pk) => pk.rpId + '\n' + pk.userHandle;
  for (const it of data.items) {
    for (const pk of it.passkeys || []) {
      credIds.add(pk.credentialId);
      accounts.add(accountKey(pk));
    }
  }
  /** Valid passkeys of `raw` not yet anywhere in the vault, appended to `into`; returns how many. */
  async function takePasskeys(raw, into) {
    let n = 0;
    for (const p of Array.isArray(raw.passkeys) ? raw.passkeys : []) {
      const pk = await passkeyFromImport(p, nowMs);
      if (!pk || credIds.has(pk.credentialId) || accounts.has(accountKey(pk))) continue;
      credIds.add(pk.credentialId);
      accounts.add(accountKey(pk));
      into.push(pk);
      n++;
    }
    return n;
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
    const same = seen.get(key);
    if (same) {
      out.duplicates++;
      if (login && (same.type ?? 'login') === 'login') {
        if (!Array.isArray(same.passkeys)) same.passkeys = [];
        const n = await takePasskeys(raw, same.passkeys);
        if (n) {
          out.passkeys += n;
          same.updatedAt = Math.max(same.updatedAt || 0, nowMs);
        }
      }
      continue;
    }
    seen.set(key, item);
    if (login) out.passkeys += await takePasskeys(raw, item.passkeys);
    data.items.push(item);
    out.added++;
  }
  return out;
}
