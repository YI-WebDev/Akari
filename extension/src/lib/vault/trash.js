// ゴミ箱: deleted items wait in `data.trash` for TRASH_DAYS before they are gone for good, so a
// delete can be undone. A trashed item is the stored item as it was, plus `deletedAt`. Nothing
// reads `data.trash` except these helpers: autofill, passkeys, the health report and the
// plaintext exports only ever see `data.items`.

import { AkariError } from '../../shared/errors.js';
import { ERR } from '../../shared/messages.js';
import { isObject } from './common.js';

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_MS = TRASH_DAYS * DAY_MS;

const isLive = (entry, nowMs) => isObject(entry) && Number.isFinite(entry.deletedAt) && nowMs - entry.deletedAt < TRASH_MS;

/**
 * Drops what has been in the trash for TRASH_DAYS, anything malformed, and an entry whose id is a
 * live item again (a backup import brought it back). Returns how many went.
 */
export function pruneTrash(data, nowMs = Date.now()) {
  if (!Array.isArray(data.trash)) {
    data.trash = [];
    return 0;
  }
  const live = new Set(data.items.map((it) => it.id));
  const before = data.trash.length;
  data.trash = data.trash.filter((e) => isLive(e, nowMs) && !live.has(e.id));
  return before - data.trash.length;
}

/** Passkeys a restored login may not bring back: the vault already has the credential or the account. */
function withoutTakenPasskeys(item, items) {
  if (!Array.isArray(item.passkeys) || !item.passkeys.length) return item;
  const creds = new Set();
  const accounts = new Set();
  for (const it of items) {
    for (const pk of it.passkeys || []) {
      creds.add(pk.credentialId);
      accounts.add(pk.rpId + '\n' + pk.userHandle);
    }
  }
  const passkeys = item.passkeys.filter((pk) => !creds.has(pk.credentialId) && !accounts.has(pk.rpId + '\n' + pk.userHandle));
  return passkeys.length === item.passkeys.length ? item : { ...item, passkeys };
}

/**
 * Moves the items with these ids from `items` to the trash (newest first). Ids that are not
 * there (deleted from another window meanwhile) are skipped. Returns the ids that moved.
 */
export function trashItems(data, ids, nowMs = Date.now()) {
  pruneTrash(data, nowMs);
  const gone = new Set(ids);
  const moved = [];
  const keep = [];
  for (const it of data.items) {
    if (gone.has(it.id)) moved.push({ ...it, deletedAt: nowMs });
    else keep.push(it);
  }
  data.items = keep;
  const movedIds = new Set(moved.map((e) => e.id));
  data.trash = [...moved, ...data.trash.filter((e) => !movedIds.has(e.id))]; // one entry per id
  return moved.map((e) => e.id);
}

/**
 * Puts trashed items back. One whose vault was deleted meanwhile goes to the first vault; one
 * whose id is in use again is skipped. Returns the restored items (stored form, no deletedAt).
 */
export function restoreItems(data, ids, nowMs = Date.now()) {
  pruneTrash(data, nowMs);
  const want = new Set(ids);
  const taken = new Set(data.items.map((it) => it.id));
  const restored = [];
  data.trash = data.trash.filter((entry) => {
    if (!want.has(entry.id) || taken.has(entry.id)) return true;
    const { deletedAt: _deletedAt, ...rest } = entry; // eslint-disable-line no-unused-vars
    // a passkey registered again (or imported) while this login was in the trash wins
    const item = withoutTakenPasskeys(rest, [...data.items, ...restored]);
    if (!data.vaults.some((v) => v.id === item.vault)) item.vault = data.vaults[0].id;
    restored.push(item);
    taken.add(item.id);
    return false;
  });
  if (!restored.length) throw new AkariError(ERR.NOT_FOUND, 'Nothing to restore');
  data.items.unshift(...restored);
  return restored;
}

/** Deletes trashed items for good: these ids, or everything when `ids` is null. Returns how many. */
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

/** The trash as it should be shown: live entries only, newest first. */
export const liveTrash = (data, nowMs = Date.now()) => (Array.isArray(data.trash) ? data.trash.filter((e) => isLive(e, nowMs)) : []);
