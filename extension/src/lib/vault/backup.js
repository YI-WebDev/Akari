import { checkRecord, openVaultRecord } from './record.js';
import { checkData } from './schema.js';
import { invalid, isObject, isHue, clampTs, MAX_VAULT_ID_LENGTH } from './common.js';
import { makeItem, validateItem } from './items.js';
import { normalizeAttachments } from './attachments.js';
import { ATTACHMENT_LIMITS } from '../../shared/messages.js';
import { normalizePasskeys } from './passkeys.js';
import { passwordKeys, mergedHistory } from './passwords.js';

export const BACKUP_FORMAT = 'akari-backup';
export const BACKUP_VERSION = 1;
const MAX_VAULT_NAME_LENGTH = 100;
const DEFAULT_VAULT_HUE = 55;

export function exportBackup(record, nowMs = Date.now(), attachments = null) {
  checkRecord(record);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    vault: record,
    ...(attachments && Object.keys(attachments).length && { attachments }),
  }, null, 2);
}

export async function importBackup(json, password) {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw invalid('Not an Akari backup file');
  }
  if (!isObject(obj) || obj.format !== BACKUP_FORMAT || obj.version !== BACKUP_VERSION
    || (obj.attachments !== undefined && !isObject(obj.attachments))) {
    throw invalid('Not an Akari backup file');
  }
  const { data } = await openVaultRecord(obj.vault, password, { newer: 'keep' });
  return { ...normalizeData(data), attachments: obj.attachments ?? {} };
}

function normalizeVault(v) {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id || v.id.length > MAX_VAULT_ID_LENGTH) return null;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, MAX_VAULT_NAME_LENGTH) : v.id;
  return { id: v.id, name, hue: isHue(v.hue) ? v.hue : DEFAULT_VAULT_HUE };
}

function normalizeImportedItem(raw, nowMs) {
  if (!isObject(raw)) throw invalid('Item must be an object');
  const { attachments, ...rest } = raw;
  const fields = validateItem(rest, rest);
  if (!fields.id) throw invalid('Item without id');
  const { list, skipped } = normalizeAttachments(attachments, nowMs);
  const createdAt = clampTs(raw.createdAt, nowMs, nowMs);
  const login = (fields.type ?? 'login') === 'login';
  const item = makeItem({
    ...fields,
    ...(list.length && { attachments: list }),
    ...(login && {
      passkeys: normalizePasskeys(raw.passkeys, nowMs),
      passwordUpdatedAt: clampTs(raw.passwordUpdatedAt, null, nowMs),
      ...passwordKeys(raw, fields.password, nowMs),
    }),
    createdAt,
    updatedAt: clampTs(raw.updatedAt, createdAt, nowMs),
    lastUsedAt: clampTs(raw.lastUsedAt, null, nowMs),
  }, nowMs);
  return { item, skipped };
}

export function normalizeData(data, nowMs = Date.now()) {
  checkData(data);
  const vaults = new Map();
  for (const v of data.vaults.map(normalizeVault)) if (v && !vaults.has(v.id)) vaults.set(v.id, v);
  const items = new Map();
  const skippedAttachments = new Map();
  for (const raw of data.items) {
    try {
      const { item, skipped } = normalizeImportedItem(raw, nowMs);
      items.set(item.id, item);
      skippedAttachments.set(item.id, skipped);
    } catch { }
  }
  return {
    vaults: [...vaults.values()], items: [...items.values()], updatedAt: clampTs(data.updatedAt, nowMs, nowMs), skippedAttachments,
  };
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
  const trashed = new Map((Array.isArray(data.trash) ? data.trash : []).filter(isObject).map((e) => [e.id, e]));
  const ids = [];
  let skippedAttachments = 0;
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
      if (trashed.has(item.id)) skippedAttachments += keepStoredAttachments(item, trashed.get(item.id));
      index.set(item.id, data.items.length);
      data.items.push(item);
      ids.push(item.id);
    } else if (isSameTypeAndNewer(item, data.items[i])) {
      if (login) {
        item.passkeys = data.items[i].passkeys || [];
        const history = mergedHistory(item, data.items[i]);
        if (history.length) item.passwordHistory = history;
        else delete item.passwordHistory;
      } else {
        delete item.passkeys;
      }
      skippedAttachments += keepStoredAttachments(item, data.items[i]);
      data.items[i] = item;
      ids.push(item.id);
    }
  }
  return { data, count: ids.length, ids, skippedAttachments };
}

function keepStoredAttachments(item, stored) {
  const list = Array.isArray(stored.attachments) ? [...stored.attachments] : [];
  let skipped = 0;
  for (const a of Array.isArray(item.attachments) ? item.attachments : []) {
    const same = list.find((x) => x.id === a.id);
    if (same ? same.key !== a.key : list.length >= ATTACHMENT_LIMITS.perItem) skipped++;
    else if (!same) list.push(a);
  }
  if (list.length) item.attachments = list;
  else delete item.attachments;
  return skipped;
}
