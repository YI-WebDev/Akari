// Unencrypted Bitwarden JSON export (PLAN.md §7.3): vaults become folders; logins
// carry TOTP and passkeys (fido2Credentials, Bitwarden's export shape).

import { fromB64url } from '../../shared/bytes.js';
import { totpUri } from './csv.js';

const TYPE_LOGIN = 1;
const TYPE_SECURE_NOTE = 2;
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const orNull = (s) => (s ? s : null);

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
 * @param {{ vaults: { id: string, name: string }[], items: object[] }} data  decrypted VaultData
 *   (passkey private keys included — they are written as fido2Credentials[].keyValue)
 * @returns {string} pretty-printed JSON
 */
export function toBitwardenJson(data) {
  const folders = data.vaults.map((v) => ({ id: v.id, name: v.name }));
  const folderIds = new Set(folders.map((f) => f.id));
  const items = data.items.map((it) => {
    const out = {
      passwordHistory: null,
      revisionDate: iso(it.updatedAt),
      creationDate: iso(it.createdAt),
      deletedDate: null,
      id: it.id,
      organizationId: null,
      folderId: folderIds.has(it.vault) ? it.vault : null,
      type: it.type === 'note' ? TYPE_SECURE_NOTE : TYPE_LOGIN,
      reprompt: 0,
      name: it.title || '--',
      notes: orNull(it.note),
      favorite: !!it.fav,
      collectionIds: null,
    };
    if (it.type === 'note') {
      out.secureNote = { type: 0 };
      // A secure note has no login fields; keep any as custom fields so nothing is lost.
      const fields = [['url', it.url, FIELD_TEXT], ['username', it.username, FIELD_TEXT], ['password', it.password, FIELD_HIDDEN]]
        .filter(([, value]) => value)
        .map(([name, value, type]) => ({ name, value, type, linkedId: null }));
      if (fields.length) out.fields = fields;
    } else {
      out.login = {
        fido2Credentials: (it.passkeys || []).map(fido2Credential),
        uris: it.url ? [{ match: null, uri: it.url }] : [],
        username: orNull(it.username),
        password: orNull(it.password),
        totp: orNull(totpUri(it)),
      };
    }
    return out;
  });
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}
