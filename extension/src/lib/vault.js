export {
  VAULT_VERSION, checkRecord, createVault, createVaultRecord, openVaultRecord, readVaultData, sealData,
} from './vault/record.js';
export { DATA_SCHEMA, defaultData, migrateData } from './vault/schema.js';
export {
  FIELD_CAPS, makeItem, normalizeUrl, validateItem, stripLegacyLoginKeys, sanitizeItem,
} from './vault/items.js';
export { PASSWORD_HISTORY_MAX, setLoginPassword, setPendingPassword } from './vault/passwords.js';
export { passkeyFromImport } from './vault/passkeys.js';
export { BACKUP_FORMAT, BACKUP_VERSION, exportBackup, importBackup, normalizeData, mergeData } from './vault/backup.js';
export { MAX_IMPORT_ITEMS, addImportedItems } from './vault/import-items.js';
export { createVaultIn, updateVaultIn, deleteVaultIn } from './vault/vaults.js';
export { TRASH_DAYS, TRASH_MS, pruneTrash, trashItems, restoreItems, purgeTrash, liveTrash } from './vault/trash.js';
