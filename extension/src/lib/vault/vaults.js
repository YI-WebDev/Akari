// Vaults (保管庫): create / rename / recolor / delete on decrypted VaultData.

import { toB64url, randomBytes } from '../../shared/bytes.js';
import { AkariError } from '../../shared/errors.js';
import { ERR, VAULT_LIMITS } from '../../shared/messages.js';
import { invalid, isHue } from './common.js';
import { trashItems } from './trash.js';

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
 * Removes a vault. Its items move to `moveTo` (another vault), or go to the ゴミ箱 with it only
 * when `deleteItems` is true: a vault that turns out to hold items the caller did not know about
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
    // they go to the ゴミ箱 like any deleted item; restoring one puts it in the first vault
    deleted = trashItems(data, data.items.filter((it) => it.vault === id).map((it) => it.id), nowMs).length;
  }
  data.vaults.splice(index, 1);
  return { moved, deleted };
}
