import { checkRecord, openVaultRecord } from './record.js';
import { checkData } from './schema.js';
import { invalid, isObject, isHue, clampTs } from './common.js';
import { makeItem, validateItem } from './items.js';
import { normalizePasskeys } from './passkeys.js';
import { passwordKeys, mergedHistory } from './passwords.js';

export const BACKUP_FORMAT = 'akari-backup';
export const BACKUP_VERSION = 1;
const MAX_VAULT_ID_LENGTH = 64;
const MAX_VAULT_NAME_LENGTH = 100;
const DEFAULT_VAULT_HUE = 55;

export function exportBackup(record, nowMs = Date.now()) {
  checkRecord(record);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    vault: record,
  }, null, 2);
}

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
  const { data } = await openVaultRecord(obj.vault, password, { newer: 'keep' });
  return normalizeData(data);
}

function normalizeVault(v) {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > MAX_VAULT_ID_LENGTH) return null;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, MAX_VAULT_NAME_LENGTH) : v.id;
  return { id: v.id, name, hue: isHue(v.hue) ? v.hue : DEFAULT_VAULT_HUE };
}

function normalizeImportedItem(raw, nowMs) {
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

export function normalizeData(data, nowMs = Date.now()) {
  checkData(data);
  const vaults = new Map();
  for (const v of data.vaults.map(normalizeVault)) if (v && !vaults.has(v.id)) vaults.set(v.id, v);
  const items = new Map();
  for (const raw of data.items) {
    try {
      const item = normalizeImportedItem(raw, nowMs);
      items.set(item.id, item);
    } catch { }
  }
  return { vaults: [...vaults.values()], items: [...items.values()], updatedAt: clampTs(data.updatedAt, nowMs, nowMs) };
}

function isSameTypeAndNewer(incoming, stored) {
  return (incoming.type ?? 'login') === (stored.type ?? 'login') && (incoming.updatedAt || 0) > (stored.updatedAt || 0);
}

export function mergeData(current, incoming) {
  const data = structuredClone(current);
  for (const v of incoming.vaults) {
    if (!data.vaults.some((x) => x.id === v.id)) data.vaults.push(structuredClone(v));
  }
  const vaultIds = new Set(data.vaults.map((v) => v.id));
  const fallbackVault = data.vaults[0]?.id ?? 'personal';
  const index = new Map(data.items.map((it, i) => [it.id, i]));
  const takenCredentialIds = new Set();
  const takenAccountKeys = new Set();
  const accountKey = (pk) => pk.rpId + '\n' + pk.userHandle;
  for (const it of data.items) {
    for (const pk of it.passkeys || []) {
      takenCredentialIds.add(pk.credentialId);
      takenAccountKeys.add(accountKey(pk));
    }
  }
  let count = 0;
  for (const inc of incoming.items) {
    const item = structuredClone(inc);
    if (!vaultIds.has(item.vault)) item.vault = fallbackVault;
    const i = index.get(item.id);
    const login = (item.type ?? 'login') === 'login';
    const isNewItem = i === undefined;
    if (isNewItem) {
      if (login) {
        item.passkeys = (item.passkeys || []).filter((pk) => !takenCredentialIds.has(pk.credentialId) && !takenAccountKeys.has(accountKey(pk)));
        for (const pk of item.passkeys) {
          takenCredentialIds.add(pk.credentialId);
          takenAccountKeys.add(accountKey(pk));
        }
      } else {
        delete item.passkeys;
      }
      index.set(item.id, data.items.length);
      data.items.push(item);
      count++;
    } else if (isSameTypeAndNewer(item, data.items[i])) {
      if (login) {
        item.passkeys = data.items[i].passkeys || [];
        const history = mergedHistory(item, data.items[i]);
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
