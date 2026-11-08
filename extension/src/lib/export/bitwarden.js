import { fromB64url } from '../../shared/bytes.js';
import { cardBrand } from '../../shared/item-types.js';
import { totpUri, templateEntries } from './csv.js';

export const TYPE_FIELD = 'akari:type';

const TYPE_LOGIN = 1;
const TYPE_SECURE_NOTE = 2;
const TYPE_CARD = 3;
const TYPE_IDENTITY = 4;
const TYPE_SSH_KEY = 5;
const FIELD_TEXT = 0;
const FIELD_HIDDEN = 1;
const GUID_CREDENTIAL_ID_BYTES = 16;
const UNTITLED_NAME = '--';

const IDENTITY_KEYS = ['firstName', 'middleName', 'lastName', 'address1', 'address2', 'city', 'state', 'postalCode',
  'country', 'company', 'email', 'phone'];
const BITWARDEN_BRAND = { 'American Express': 'Amex' };

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const orNull = (s) => (s ? s : null);
const customField = (name, value, hidden) => ({ name, value, type: hidden ? FIELD_HIDDEN : FIELD_TEXT, linkedId: null });

export function bitwardenCredentialId(b64url) {
  const b = fromB64url(b64url);
  if (b.length !== GUID_CREDENTIAL_ID_BYTES) return 'b64.' + b64url;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fido2Credential(pk) {
  return {
    credentialId: bitwardenCredentialId(pk.credentialId),
    keyType: 'public-key',
    keyAlgorithm: 'ECDSA',
    keyCurve: 'P-256',
    keyValue: pk.privateKey,
    rpId: pk.rpId,
    userHandle: pk.userHandle,
    userName: orNull(pk.userName),
    counter: '0',
    rpName: pk.rpId,
    userDisplayName: orNull(pk.userDisplayName),
    discoverable: 'true',
    creationDate: iso(pk.createdAt),
  };
}

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

export function toBitwardenJson(data) {
  const folders = data.vaults.map((v) => ({ id: v.id, name: v.name }));
  const folderIds = new Set(folders.map((f) => f.id));
  const items = data.items.map((it) => {
    const login = (it.type ?? 'login') === 'login';
    const native = login ? null : nativePart(it);
    const history = login && Array.isArray(it.passwordHistory) ? it.passwordHistory : [];
    const out = {
      passwordHistory: history.length ? history.map((h) => ({ lastUsedDate: iso(h.changedAt), password: h.password })) : null,
      revisionDate: iso(it.updatedAt),
      creationDate: iso(it.createdAt),
      deletedDate: null,
      id: it.id,
      organizationId: null,
      folderId: folderIds.has(it.vault) ? it.vault : null,
      type: login ? TYPE_LOGIN : native.type,
      reprompt: 0,
      name: it.title || UNTITLED_NAME,
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
      const legacyLoginFields = [['url', it.url, false], ['username', it.username, false], ['password', it.password, true]];
      for (const [name, value, hidden] of legacyLoginFields) {
        if (value) fields.push(customField(name, value, hidden));
      }
    }
    for (const e of it.extra || []) fields.push(customField(e.label, e.value, e.secret));
    if (fields.length) out.fields = fields;
    return out;
  });
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}
