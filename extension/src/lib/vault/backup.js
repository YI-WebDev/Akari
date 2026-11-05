// Backups: the encrypted record as a file, and reading one back (validated, then merged into
// the current data). Pure: no chrome.* access.

import { checkRecord, openVaultRecord } from './record.js';
import { checkData } from './schema.js';
import { invalid, isObject, isHue, clampTs } from './common.js';
import { makeItem, validateItem } from './items.js';
import { normalizePasskeys } from './passkeys.js';
import { passwordKeys, mergedHistory } from './passwords.js';

export const BACKUP_FORMAT = 'akari-backup';
export const BACKUP_VERSION = 1;

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
  // a backup from a newer Akari still imports: normalizeData keeps only what this build knows
  const { data } = await openVaultRecord(obj.vault, password, { newer: 'keep' });
  return normalizeData(data);
}

function normalizeVault(v) {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > 64) return null;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 100) : v.id;
  return { id: v.id, name, hue: isHue(v.hue) ? v.hue : 55 };
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
      ...passwordKeys(raw, fields.password, nowMs),
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
      if (login) {
        item.passkeys = data.items[i].passkeys || [];
        const history = mergedHistory(item, data.items[i]); // no password is lost by the merge
        if (history.length) item.passwordHistory = history;
        else delete item.passwordHistory;
      } else {
        delete item.passkeys;
      }
      data.items[i] = item;
      count++;
    }
  }
  return { data, count };
}
