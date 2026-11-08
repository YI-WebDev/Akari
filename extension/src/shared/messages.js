export const MSG = Object.freeze({
  VAULT_STATUS: 'vault/status',
  VAULT_SETUP: 'vault/setup',
  VAULT_UNLOCK: 'vault/unlock',
  VAULT_LOCK: 'vault/lock',
  VAULT_GET_ALL: 'vault/getAll',
  VAULT_SAVE_ITEM: 'vault/saveItem',
  VAULT_DELETE_ITEM: 'vault/deleteItem',
  VAULT_DELETE_ITEMS: 'vault/deleteItems',
  VAULT_RESTORE_ITEMS: 'vault/restoreItems',
  VAULT_PURGE_ITEMS: 'vault/purgeItems',
  VAULT_DELETE_PASSKEY: 'vault/deletePasskey',
  VAULT_PENDING_PASSWORD: 'vault/pendingPassword',
  VAULT_CHANGE_PASSWORD: 'vault/changePassword',
  VAULT_EXPORT: 'vault/export',
  VAULT_IMPORT: 'vault/import',
  VAULT_IMPORT_ITEMS: 'vault/importItems',
  VAULT_EXPORT_PLAIN: 'vault/exportPlain',
  VAULT_CREATE_VAULT: 'vault/createVault',
  VAULT_UPDATE_VAULT: 'vault/updateVault',
  VAULT_DELETE_VAULT: 'vault/deleteVault',

  SETTINGS_GET: 'settings/get',
  SETTINGS_SET: 'settings/set',
  SETTINGS_LANGUAGE: 'settings/language',

  CLIPBOARD_SCHEDULE_CLEAR: 'clipboard/scheduleClear',
  ACTIVITY_PING: 'activity/ping',

  AUTOFILL_MATCHES: 'autofill/matches',
  AUTOFILL_FILL: 'autofill/fill',
  AUTOFILL_PAGE_MATCHES: 'autofill/pageMatches',
  AUTOFILL_REQUEST_FILL: 'autofill/requestFill',
  AUTOFILL_OFFER_SAVE: 'autofill/offerSave',
  AUTOFILL_CONFIRM_SAVE: 'autofill/confirmSave',
  AUTOFILL_NOTE_USERNAME: 'autofill/noteUsername',
  AUTOFILL_DO_FILL: 'autofill/doFill',

  PASSKEY_CREATE: 'passkey/create',
  PASSKEY_GET: 'passkey/get',
  PASSKEY_REQUEST: 'passkey/request',
  PASSKEY_RESPOND: 'passkey/respond',
  PASSKEY_ASSERT: 'passkey/assert',
  PASSKEY_SAVE: 'passkey/save',
  PASSKEY_CANCEL: 'passkey/cancel',
  PASSKEY_VERIFY: 'passkey/verify',

  OFFSCREEN_CLEAR_CLIPBOARD: 'offscreen/clearClipboard',
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
  NOT_ALLOWED: 'NOT_ALLOWED',
  FALLBACK: 'FALLBACK',
  NOT_EMPTY: 'NOT_EMPTY',
  INTERNAL: 'INTERNAL',
  INVALID_STATE: 'INVALID_STATE',
  SECURITY: 'SECURITY',
  UV_REQUIRED: 'UV_REQUIRED',
});

export const NEVER_LOCK = -1;

export const DEFAULT_SETTINGS = Object.freeze({
  autoLockMinutes: 15,
  clipboardClearSeconds: 30,
  language: 'auto',
  theme: 'dark',
});

export const VAULT_LIMITS = Object.freeze({ name: 40, count: 20 });

export const DEFAULT_VAULTS = Object.freeze([
  { id: 'personal', name: '個人', hue: 55 },
  { id: 'work', name: '仕事', hue: 255 },
  { id: 'family', name: '家族', hue: 150 },
]);
