// Message contract between extension contexts. PLAN.md §3 documents payloads.
// Content scripts cannot import modules, so they hard-code these strings;
// keep the values stable.

export const MSG = Object.freeze({
  VAULT_STATUS: 'vault/status',
  VAULT_SETUP: 'vault/setup',
  VAULT_UNLOCK: 'vault/unlock',
  VAULT_LOCK: 'vault/lock',
  VAULT_GET_ALL: 'vault/getAll',
  VAULT_SAVE_ITEM: 'vault/saveItem',
  VAULT_DELETE_ITEM: 'vault/deleteItem',
  VAULT_DELETE_PASSKEY: 'vault/deletePasskey',
  VAULT_CHANGE_PASSWORD: 'vault/changePassword',
  VAULT_EXPORT: 'vault/export',
  VAULT_IMPORT: 'vault/import',
  VAULT_IMPORT_ITEMS: 'vault/importItems', // items parsed from another manager's export
  VAULT_EXPORT_PLAIN: 'vault/exportPlain', // CSV / Bitwarden JSON, master password required
  VAULT_CREATE_VAULT: 'vault/createVault',
  VAULT_UPDATE_VAULT: 'vault/updateVault', // name and/or hue
  VAULT_DELETE_VAULT: 'vault/deleteVault', // its items move to `moveTo`, or go with it only when `deleteItems` is true

  SETTINGS_GET: 'settings/get',
  SETTINGS_SET: 'settings/set',

  CLIPBOARD_SCHEDULE_CLEAR: 'clipboard/scheduleClear',
  ACTIVITY_PING: 'activity/ping',

  AUTOFILL_MATCHES: 'autofill/matches',
  AUTOFILL_FILL: 'autofill/fill',
  AUTOFILL_PAGE_MATCHES: 'autofill/pageMatches',
  AUTOFILL_REQUEST_FILL: 'autofill/requestFill',
  AUTOFILL_OFFER_SAVE: 'autofill/offerSave',
  AUTOFILL_CONFIRM_SAVE: 'autofill/confirmSave',
  // SW -> content script
  AUTOFILL_DO_FILL: 'autofill/doFill',
  AUTOFILL_FILL_BEST: 'autofill/fillBest',

  PASSKEY_CREATE: 'passkey/create',
  PASSKEY_GET: 'passkey/get',
  PASSKEY_REQUEST: 'passkey/request',
  PASSKEY_RESPOND: 'passkey/respond',
  PASSKEY_CANCEL: 'passkey/cancel', // bridge → SW when the page aborts
  PASSKEY_VERIFY: 'passkey/verify', // consent window → SW: master-password re-prompt for UV
});

export const ERR = Object.freeze({
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'ALREADY_INITIALIZED',
  LOCKED: 'LOCKED',
  BAD_PASSWORD: 'BAD_PASSWORD',
  NOT_FOUND: 'NOT_FOUND',
  INVALID: 'INVALID',
  DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
  FORBIDDEN: 'FORBIDDEN',
  NOT_ALLOWED: 'NOT_ALLOWED', // WebAuthn NotAllowedError (user cancelled / timed out)
  FALLBACK: 'FALLBACK', // let the browser's own WebAuthn handle the request
  NOT_EMPTY: 'NOT_EMPTY', // a vault still holds items and the request said neither where to move them nor to delete them
  INTERNAL: 'INTERNAL',
});

// autoLockMinutes value for "ロックしない": never lock on its own, also not when the browser
// closes (the vault key is kept on this device). 0 = lock when the browser closes.
export const NEVER_LOCK = -1;

export const DEFAULT_SETTINGS = Object.freeze({
  autoLockMinutes: 15,
  clipboardClearSeconds: 30,
});

// Vaults (保管庫) the user can make: name length in characters, how many in all.
export const VAULT_LIMITS = Object.freeze({ name: 40, count: 20 });

export const DEFAULT_VAULTS = Object.freeze([
  { id: 'personal', name: '個人', hue: 55 },
  { id: 'work', name: '仕事', hue: 255 },
  { id: 'family', name: '家族', hue: 150 },
]);
