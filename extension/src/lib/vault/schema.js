import { DEFAULT_VAULTS } from '../../shared/messages.js';
import { t } from '../../shared/i18n.js';
import { invalid, isObject } from './common.js';
import { stripLegacyLoginKeys } from './items.js';

export const DATA_SCHEMA = 2;

const typeUntypedItemsAndStripLegacyKeys = (data) => {
  for (const it of data.items) {
    if (!isObject(it)) continue;
    if (it.type === undefined) it.type = 'login';
    stripLegacyLoginKeys(it);
  }
};

const addTrash = (data) => {
  if (!Array.isArray(data.trash)) data.trash = [];
};

const MIGRATIONS = [typeUntypedItemsAndStripLegacyKeys, addTrash];

export function defaultData(nowMs = Date.now()) {
  const vaults = DEFAULT_VAULTS.map((v) => ({ ...v, name: t(`vault.default.${v.id}`, null, v.name) }));
  return { schema: DATA_SCHEMA, vaults, items: [], trash: [], updatedAt: nowMs };
}

export function checkData(data) {
  if (!isObject(data) || !Array.isArray(data.vaults) || !Array.isArray(data.items)) throw invalid('Malformed vault data');
  if (data.trash !== undefined && !Array.isArray(data.trash)) throw invalid('Malformed vault data');
  return data;
}

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
