// Unencrypted Bitwarden JSON export (PLAN.md §7.3): vaults become folders; logins
// carry TOTP and passkeys (fido2Credentials, Bitwarden's export shape).
//
// Item types (shared/item-types.js) → Bitwarden cipher types:
//   login → 1 login · note → 2 secureNote
//   card → 3 card { cardholderName, brand, number (digits only), expMonth ("1"–"12"), expYear, code }
//   identity → 4 identity (name/address/company/email/phone keys; title, address3, ssn, username,
//     passportNumber, licenseNumber null)
//   sshKey → 5 sshKey { privateKey, publicKey, keyFingerprint }
//   every other type → 2 secureNote whose custom fields are the template values.
// `notes` is always the item's own note (or null).
// Every item that is neither login nor note — native card/identity/sshKey included — gets a
// first custom field { name: 'akari:type', value: '<typeId>', type: 0 } so an import back into
// Akari restores its type. Then: template values with no native Bitwarden key (card PIN, identity
// birthDate/jobTitle/website, SSH passphrase/host/username, every value of a secure-note fallback),
// any legacy login keys of a non-login item, then `extra`. Custom fields: name = display label
// (fieldLabel), type 1 hidden for secret kinds and secret extras, else 0 text; select values are
// written as their option label.

import { fromB64url } from '../../shared/bytes.js';
import { cardBrand } from '../../shared/item-types.js';
import { totpUri, templateEntries } from './csv.js';

/** Custom field naming the Akari type of a non-login, non-note item (read back by the Bitwarden importer). */
export const TYPE_FIELD = 'akari:type';

const TYPE_LOGIN = 1;
const TYPE_SECURE_NOTE = 2;
const TYPE_CARD = 3;
const TYPE_IDENTITY = 4;
const TYPE_SSH_KEY = 5;
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;

// Template keys of 'identity' that Bitwarden's identity has a key of the same name for.
const IDENTITY_KEYS = ['firstName', 'middleName', 'lastName', 'address1', 'address2', 'city', 'state', 'postalCode',
  'country', 'company', 'email', 'phone'];
// Bitwarden spells this brand differently in its card brand list.
const BITWARDEN_BRAND = { 'American Express': 'Amex' };

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const orNull = (s) => (s ? s : null);
const customField = (name, value, hidden) => ({ name, value, type: hidden ? FIELD_HIDDEN : FIELD_TEXT, linkedId: null });

/** Bitwarden keeps 16-byte credential ids as GUIDs and any other length as "b64." + base64url. */
export function bitwardenCredentialId(b64url) {
  const b = fromB64url(b64url);
  if (b.length !== 16) return 'b64.' + b64url;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fido2Credential(pk) {
  return {
    credentialId: bitwardenCredentialId(pk.credentialId),
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: pk.privateKey, // PKCS8, base64url
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: orNull(pk.userName),
    counter: '0', // Akari signs with a constant 0 counter, as synced passkeys do
    rpName: pk.rpId,
    userDisplayName: orNull(pk.userDisplayName),
    discoverable: 'true',
    creationDate: iso(pk.createdAt),
  };
}

/**
 * Native Bitwarden part of a typed item: { type, key, value, used } where `used` lists the
 * template keys written natively (the rest become custom fields).
 */
function nativePart(it) {
  const x = it.fields || {};
  switch (it.type) {
    case 'card': {
      const [year, month] = (x.expiry || '').split('-');
      const brand = cardBrand(x.number);
      return {
        type: TYPE_CARD,
        key: 'card',
        value: {
          cardholderName: orNull(x.cardholder),
          brand: orNull(BITWARDEN_BRAND[brand] ?? brand),
          number: orNull((x.number || '').replace(/\D/g, '')),
          expMonth: month ? String(Number(month)) : null,
          expYear: orNull(year),
          code: orNull(x.cvv),
        },
        used: ['cardholder', 'number', 'expiry', 'cvv'],
      };
    }
    case 'identity': {
      const value = { title: null };
      for (const k of IDENTITY_KEYS) value[k] = orNull(x[k]);
      Object.assign(value, { address3: null, ssn: null, username: null, passportNumber: null, licenseNumber: null });
      return { type: TYPE_IDENTITY, key: 'identity', value, used: IDENTITY_KEYS };
    }
    case 'sshKey':
      return {
        type: TYPE_SSH_KEY,
        key: 'sshKey',
        value: { privateKey: orNull(x.privateKey), publicKey: orNull(x.publicKey), keyFingerprint: orNull(x.fingerprint) },
        used: ['privateKey', 'publicKey', 'fingerprint'],
      };
    default:
      return { type: TYPE_SECURE_NOTE, key: 'secureNote', value: { type: 0 }, used: [] };
  }
}

/**
 * @param {{ vaults: { id: string, name: string }[], items: object[] }} data  decrypted VaultData
 *   (passkey private keys included — they are written as fido2Credentials[].keyValue)
 * @returns {string} pretty-printed JSON
 */
export function toBitwardenJson(data) {
  const folders = data.vaults.map((v) => ({ id: v.id, name: v.name }));
  const folderIds = new Set(folders.map((f) => f.id));
  const items = data.items.map((it) => {
    const login = (it.type ?? 'login') === 'login';
    const native = login ? null : nativePart(it);
    const out = {
      passwordHistory: null,
      revisionDate: iso(it.updatedAt),
      creationDate: iso(it.createdAt),
      deletedDate: null,
      id: it.id,
      organizationId: null,
      folderId: folderIds.has(it.vault) ? it.vault : null,
      type: login ? TYPE_LOGIN : native.type,
      reprompt: 0,
      name: it.title || '--',
      notes: orNull(it.note),
      favorite: !!it.fav,
      collectionIds: null,
    };
    const fields = [];
    if (login) {
      out.login = {
        fido2Credentials: (it.passkeys || []).map(fido2Credential),
        uris: it.url ? [{ match: null, uri: it.url }] : [],
        username: orNull(it.username),
        password: orNull(it.password),
        totp: orNull(totpUri(it)),
      };
    } else {
      out[native.key] = native.value;
      if (it.type !== 'note') fields.push(customField(TYPE_FIELD, it.type, false));
      for (const e of templateEntries(it)) {
        if (!native.used.includes(e.key)) fields.push(customField(e.label, e.value, e.secret));
      }
      // Legacy notes may still carry login fields; keep them so nothing is lost.
      for (const [name, value, hidden] of [['url', it.url, false], ['username', it.username, false], ['password', it.password, true]]) {
        if (value) fields.push(customField(name, value, hidden));
      }
    }
    for (const e of it.extra || []) fields.push(customField(e.label, e.value, e.secret));
    if (fields.length) out.fields = fields;
    return out;
  });
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}
