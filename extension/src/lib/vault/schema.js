// The decrypted VaultData: its schema version, the empty vault, and the migrations that bring
// data written by older versions up to date. Migrations run in memory whenever data is
// decrypted (readVaultData); the next write stores the migrated data.

import { DEFAULT_VAULTS } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import { invalid, isObject } from './common.js';
import { stripLegacyLoginKeys } from './items.js';

/** Schema of VaultData this build writes. Data without `schema` is schema 0. */
export const DATA_SCHEMA = 2;

/**
 * MIGRATIONS[n] upgrades VaultData from schema n to n + 1, in place. Append a step (and bump
 * DATA_SCHEMA) whenever stored data changes shape; never edit a step that has shipped.
 */
const MIGRATIONS = [
  // 0 → 1: items saved before item types existed have no `type` (they are logins), and notes
  // saved before the type templates still carry empty login keys ('' url / username / password).
  (data) => {
    for (const it of data.items) {
      if (!isObject(it)) continue;
      if (it.type === undefined) it.type = 'login';
      stripLegacyLoginKeys(it);
    }
  },
  // 1 → 2: the ゴミ箱 (lib/vault/trash.js). An older build would store the data back without it,
  // dropping what is in the trash, which is why this is a schema step.
  (data) => {
    if (!Array.isArray(data.trash)) data.trash = [];
  },
];

export function defaultData(nowMs = Date.now()) {
  const vaults = DEFAULT_VAULTS.map((v) => ({ ...v, name: t(`vault.default.${v.id}`, null, v.name) }));
  return { schema: DATA_SCHEMA, vaults, items: [], trash: [], updatedAt: nowMs };
}

export function checkData(data) {
  if (!isObject(data) || !Array.isArray(data.vaults) || !Array.isArray(data.items)) throw invalid('Malformed vault data');
  if (data.trash !== undefined && !Array.isArray(data.trash)) throw invalid('Malformed vault data');
  return data;
}

/**
 * Brings decrypted VaultData up to DATA_SCHEMA (in place) and returns it.
 * Data from a newer Akari: by default refused, since storing it back with this build could drop
 * what it does not know. A backup import passes `newer: 'keep'` and gets it as it is: the
 * import validates every item (normalizeData) and keeps only what this build understands.
 */
export function migrateData(data, { newer = 'refuse' } = {}) {
  checkData(data);
  const from = data.schema ?? 0;
  if (!Number.isInteger(from) || from < 0) throw invalid('Malformed vault schema');
  if (from > DATA_SCHEMA) {
    if (newer === 'keep') return data;
    throw invalid('Vault data was written by a newer version of Akari');
  }
  for (let v = from; v < DATA_SCHEMA; v++) MIGRATIONS[v](data);
  data.schema = DATA_SCHEMA;
  return data;
}
