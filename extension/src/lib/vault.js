// Encrypted vault record, backups, and item helpers — the public API of lib/vault/.
// Pure: no chrome.* access. Each part lives in its own module:
//   record.js        the encrypted `akari.vault` record (KDF, wrapped key, sealed data)
//   schema.js        the VaultData schema version, the empty vault, migrations
//   items.js         item defaults, validation, legacy-key cleanup, the sanitized copy
//   passwords.js     a login's password history and pending password
//   passkeys.js      passkeys from backups and from other managers
//   backup.js        backup files: export, import, merge
//   import-items.js  items from another manager's export
//   vaults.js        vaults (保管庫): create / rename / recolor / delete

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
