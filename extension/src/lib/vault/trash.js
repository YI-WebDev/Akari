import { DAY_MS } from '../../shared/time.js';
import { AkariError } from '../../shared/errors.js';
import { ERR } from '../../shared/messages.js';
import { isObject } from './common.js';

export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * DAY_MS;

const isLive = (entry, nowMs) => isObject(entry) && Number.isFinite(entry.deletedAt) && nowMs - entry.deletedAt < TRASH_MS;

export function pruneTrash(data, nowMs = Date.now()) {
  if (!Array.isArray(data.trash)) {
    data.trash = [];
    return 0;
  }
  const liveItemIds = new Set(data.items.map((it) => it.id));
  const before = data.trash.length;
  data.trash = data.trash.filter((e) => isLive(e, nowMs) && !liveItemIds.has(e.id));
  return before - data.trash.length;
}

function withoutTakenPasskeys(item, items) {
  if (!Array.isArray(item.passkeys) || !item.passkeys.length) return item;
  const accountKey = (pk) => pk.rpId + '\n' + pk.userHandle;
  const takenCredentialIds = new Set();
  const takenAccountKeys = new Set();
  for (const it of items) {
    for (const pk of it.passkeys || []) {
      takenCredentialIds.add(pk.credentialId);
      takenAccountKeys.add(accountKey(pk));
    }
  }
  const passkeys = item.passkeys.filter((pk) => !takenCredentialIds.has(pk.credentialId) && !takenAccountKeys.has(accountKey(pk)));
  return passkeys.length === item.passkeys.length ? item : { ...item, passkeys };
}

export function trashItems(data, ids, nowMs = Date.now()) {
  pruneTrash(data, nowMs);
  const idsToTrash = new Set(ids);
  const moved = [];
  const keep = [];
  for (const it of data.items) {
    if (idsToTrash.has(it.id)) moved.push({ ...it, deletedAt: nowMs });
    else keep.push(it);
  }
  data.items = keep;
  const movedIds = new Set(moved.map((e) => e.id));
  data.trash = [...moved, ...data.trash.filter((e) => !movedIds.has(e.id))];
  return moved.map((e) => e.id);
}

export function restoreItems(data, ids, nowMs = Date.now()) {
  pruneTrash(data, nowMs);
  const wantedIds = new Set(ids);
  const takenIds = new Set(data.items.map((it) => it.id));
  const restored = [];
  data.trash = data.trash.filter((entry) => {
    if (!wantedIds.has(entry.id) || takenIds.has(entry.id)) return true;
    const { deletedAt: _deletedAt, ...rest } = entry;
    const item = withoutTakenPasskeys(rest, [...data.items, ...restored]);
    if (!data.vaults.some((v) => v.id === item.vault)) item.vault = data.vaults[0].id;
    restored.push(item);
    takenIds.add(item.id);
    return false;
  });
  if (!restored.length) throw new AkariError(ERR.NOT_FOUND, 'Nothing to restore');
  data.items.unshift(...restored);
  return restored;
}

export function purgeTrash(data, ids = null, nowMs = Date.now()) {
  pruneTrash(data, nowMs);
  const before = data.trash.length;
  if (ids === null) data.trash = [];
  else {
    const gone = new Set(ids);
    data.trash = data.trash.filter((e) => !gone.has(e.id));
  }
  return before - data.trash.length;
}

export const liveTrash = (data, nowMs = Date.now()) => (Array.isArray(data.trash) ? data.trash.filter((e) => isLive(e, nowMs)) : []);
