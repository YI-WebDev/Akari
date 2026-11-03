// Bitwarden JSON export: unencrypted, password-protected (PBKDF2-SHA256), or a ZIP with
// data.json + attachments/. Item types: 1 login, 2 secure note, 3 card, 4 identity, 5 SSH key,
// 6 bank account, 7 driver's license, 8 passport — each mapped onto the Akari type of that kind.
// Akari's own exports add a custom field "akari:type" (any TYPE_IDS value); with it the item is
// rebuilt as that type, custom fields named like its template fields filling them.
//
// Password-protected exports: key = PBKDF2-SHA256(password, utf8(salt string), kdfIterations, 32 B),
// stretched with HKDF-Expand(SHA-256, info "enc" / "mac", 32 B). `encKeyValidation_DO_NOT_EDIT`
// and `data` are EncStrings "2.<iv b64>|<ciphertext b64>|<mac b64>" — AES-256-CBC with
// HMAC-SHA256(macKey, iv ‖ ciphertext), verified before decrypting.

import { ImportError, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { readZip, findEntry } from '../zip.js';
import { utf8, fromUtf8, fromB64, toB64url, fromB64url, concat } from '../../../shared/bytes.js';
import { TYPE_IDS, typeOf, fieldLabel, personName } from '../../../shared/item-types.js';
import { L, typed, monthOf } from './_fields.js';

/**
 * Bitwarden key → Akari template key, per item type. Keys not listed become extra fields with
 * the label given in EXTRA (secret when marked so).
 */
const MAP = {
  3: ['card', 'card', { cardholderName: 'cardholder', number: 'number', code: 'cvv' }],
  4: ['identity', 'identity', {
    firstName: 'firstName', middleName: 'middleName', lastName: 'lastName', company: 'company', email: 'email',
    phone: 'phone', address1: 'address1', address2: 'address2', city: 'city', state: 'state',
    postalCode: 'postalCode', country: 'country',
  }],
  5: ['sshKey', 'sshKey', { privateKey: 'privateKey', publicKey: 'publicKey', keyFingerprint: 'fingerprint' }],
  6: ['bankAccount', 'bankAccount', {
    bankName: 'bankName', nameOnAccount: 'accountHolder', accountType: 'accountType', accountNumber: 'accountNumber',
    routingNumber: 'routingNumber', branchNumber: 'branch', pin: 'pin', swiftCode: 'swift', iban: 'iban',
  }],
  7: ['driverLicense', 'driversLicense', {
    licenseNumber: 'number', licenseClass: 'licenseClass', dateOfBirth: 'birthDate', issueDate: 'issuedOn',
    expirationDate: 'expiry', issuingAuthority: 'issuer', issuingState: 'issuer', issuingCountry: 'issuer',
  }],
  8: ['passport', 'passport', {
    passportNumber: 'number', nationality: 'nationality', issuingCountry: 'issuingCountry', dateOfBirth: 'birthDate',
    issueDate: 'issuedOn', expirationDate: 'expiry', issuingAuthority: 'authority',
  }],
};

/** Label key, Japanese label and secrecy for Bitwarden keys that have no template key of their own. */
const EXTRA_LABELS = {
  title: ['honorific', '敬称'], username: ['username', 'ユーザー名'], address3: ['address3', '住所 3'],
  ssn: ['ssn', '社会保障番号', true], passportNumber: ['passportNumber', 'パスポート番号', true],
  licenseNumber: ['licenseNumber', '免許証番号', true], bankContactPhone: ['bankPhone', '銀行の電話番号'],
  issuingState: ['issuingState', '発行州'], issuingCountry: ['issuingCountry', '発行国'],
  sex: ['sex', '性別'], birthPlace: ['birthPlace', '出生地'], passportType: ['passportType', '種類'],
  nationalIdentificationNumber: ['nationalId', '国民識別番号', true],
};
/** [label, secret] for a Bitwarden key (labels resolved when used, in the current UI language). */
const extraLabel = (k) => {
  const e = EXTRA_LABELS[k];
  return e ? [L(e[0], e[1]), e[2]] : [];
};
const NAME_KEYS = new Set(['firstName', 'middleName', 'lastName', 'givenName', 'surname']);

// --- password-protected export -------------------------------------------------------------

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function deriveKeys(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const key = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: utf8(salt), iterations, hash: 'SHA-256' }, base, 256));
  // HKDF-Expand with L = 32 is a single block: T(1) = HMAC(PRK, info ‖ 0x01).
  return {
    enc: await hmac(key, concat(utf8('enc'), Uint8Array.of(1))),
    mac: await hmac(key, concat(utf8('mac'), Uint8Array.of(1))),
  };
}

/** Decrypt a type-2 EncString; returns null when the MAC does not match (wrong password). */
async function decryptEncString(s, keys) {
  const m = /^2\.([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)$/.exec(String(s).trim());
  if (!m) throw new ImportError('INVALID_FORMAT', 'Bitwarden の暗号化データの形式が正しくありません');
  let iv, ct, mac;
  try {
    [iv, ct, mac] = [fromB64(m[1]), fromB64(m[2]), fromB64(m[3])];
  } catch {
    throw new ImportError('INVALID_FORMAT', 'Bitwarden の暗号化データの形式が正しくありません');
  }
  if (iv.length !== 16 || mac.length !== 32 || !ct.length || ct.length % 16) {
    throw new ImportError('INVALID_FORMAT', 'Bitwarden の暗号化データの形式が正しくありません');
  }
  const macKey = await crypto.subtle.importKey('raw', keys.mac, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', macKey, mac, concat(iv, ct)))) return null;
  const aes = await crypto.subtle.importKey('raw', keys.enc, 'AES-CBC', false, ['decrypt']);
  try {
    return fromUtf8(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aes, ct)));
  } catch {
    throw new ImportError('INVALID_FORMAT', 'Bitwarden の暗号化データを復号できませんでした');
  }
}

async function decryptExport(j, password) {
  if (!j.passwordProtected) {
    throw new ImportError('UNSUPPORTED', 'Bitwarden アカウントの鍵で暗号化されたファイルには対応していません。「パスワード保護」か暗号化なしで書き出してください');
  }
  const kdf = j.kdfType == null ? 0 : Number(j.kdfType);
  if (kdf === 1) throw new ImportError('UNSUPPORTED', 'Argon2id で保護されたファイルには対応していません。PBKDF2 か暗号化なしで書き出してください');
  if (kdf !== 0) throw new ImportError('UNSUPPORTED', 'このキー導出方式で保護されたファイルには対応していません。PBKDF2 か暗号化なしで書き出してください');
  const iterations = Number(j.kdfIterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000 // Bitwarden's own maximum
    || typeof j.salt !== 'string' || !j.salt
    || typeof j.encKeyValidation_DO_NOT_EDIT !== 'string' || typeof j.data !== 'string') {
    throw new ImportError('INVALID_FORMAT', 'パスワード保護された Bitwarden ファイルの形式が正しくありません');
  }
  if (!password) {
    throw new ImportError('NEEDS_PASSWORD', 'パスワードで保護された Bitwarden のファイルです。書き出し時に設定したパスワードを入力してください');
  }
  const keys = await deriveKeys(password, j.salt, iterations);
  if ((await decryptEncString(j.encKeyValidation_DO_NOT_EDIT, keys)) == null) {
    throw new ImportError('BAD_PASSWORD', 'パスワードが違います');
  }
  const plain = await decryptEncString(j.data, keys);
  if (plain == null) throw new ImportError('INVALID_FORMAT', 'ファイルが壊れているか、書き換えられています');
  return parseJson(plain, 'Bitwarden（復号後）');
}

// --- passkeys (login.fido2Credentials) -----------------------------------------------------

/** Standard or URL-safe base64 (padding optional) → b64url, or '' when it does not decode. */
function toB64urlSafe(v) {
  const s = String(v ?? '').trim();
  if (!s || !/^[A-Za-z0-9+/_-]+=*$/.test(s)) return '';
  try {
    const b = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = fromB64(b + '='.repeat((4 - (b.length % 4)) % 4));
    return bytes.length ? toB64url(bytes) : '';
  } catch {
    return '';
  }
}

/** Bitwarden stores 16-byte credential ids as GUID strings and others as "b64.<b64url>". */
function credentialIdOf(v) {
  const s = String(v ?? '').trim();
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) {
    const hex = s.replace(/-/g, '');
    return toB64url(Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16)));
  }
  return toB64urlSafe(s.startsWith('b64.') ? s.slice(4) : s);
}

async function toPasskey(f, fallbackCreatedAt) {
  if (!f || typeof f !== 'object') return null;
  if ((f.keyType && f.keyType !== 'public-key') || !/^ecdsa$/i.test(f.keyAlgorithm || '') || !/^p-?256$/i.test(f.keyCurve || '')) return null;
  const credentialId = credentialIdOf(f.credentialId);
  const userHandle = toB64urlSafe(f.userHandle);
  const privateKey = toB64urlSafe(f.keyValue);
  const rpId = String(f.rpId ?? '').trim().toLowerCase();
  if (!credentialId || !userHandle || !privateKey || !rpId) return null;
  try {
    await crypto.subtle.importKey('pkcs8', fromB64url(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch {
    return null;
  }
  return {
    credentialId,
    rpId,
    userHandle,
    userName: String(f.userName ?? ''),
    userDisplayName: String(f.userDisplayName ?? ''),
    privateKey,
    createdAt: toMs(f.creationDate) ?? fallbackCreatedAt ?? Date.now(),
  };
}

// --- items ---------------------------------------------------------------------------------

/** Custom fields: 0 text, 1 hidden, 2 boolean, 3 linked (points at another field; no value). */
function customFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.filter((f) => f && f.type !== 3)
    .map((f) => ({ label: String(f.name ?? '').trim() || L('field', '項目'), value: f.value, secret: f.type === 1 }));
}

/**
 * Akari's own Bitwarden exports carry the item type in a custom field "akari:type"; with it,
 * custom fields named like a template field (display label, Japanese source label or key) go
 * back into that field. Returns the custom fields that matched none.
 */
const MARKER = 'akari:type';
function fillByName(b, custom) {
  const fds = typeOf(b.type)?.fields || [];
  const rest = [];
  for (const e of custom) {
    const fd = fds.find((x) => !b.has(x.key) && [fieldLabel(b.type, x.key), x.label, x.key].includes(e.label));
    if (fd) b.put(fd.key, e.value, e.label, e.secret || undefined);
    else rest.push(e);
  }
  return rest;
}

/** Card, identity, SSH key, bank account, driver's license or passport → typed item. */
function typedItem(c, custom, marked = false) {
  const [type, prop, keys] = MAP[c.type];
  const src = c[prop] && typeof c[prop] === 'object' ? c[prop] : {};
  const b = typed(type);
  if (type === 'driverLicense' || type === 'passport') {
    b.put('fullName', personName(src.firstName ?? src.givenName, src.middleName, src.lastName ?? src.surname));
  }
  for (const [k, key] of Object.entries(keys)) b.put(key, src[k], ...extraLabel(k));
  if (type === 'card') {
    b.put('expiry', monthOf(src.expMonth, src.expYear));
    if (!b.has('expiry')) b.add(L('expiry', '有効期限'), [src.expMonth, src.expYear].filter((v) => v != null && v !== '').join('/'));
    b.brand(src.brand);
  }
  for (const [k, v] of Object.entries(src)) {
    if (k in keys || (type !== 'identity' && NAME_KEYS.has(k)) || (type === 'card' && /^(expMonth|expYear|brand)$/.test(k))) continue;
    b.add(extraLabel(k)[0] || k, v, extraLabel(k)[1]);
  }
  return b.item({ note: c.notes, extra: marked ? fillByName(b, custom) : custom });
}

/** A type Bitwarden has no cipher for, exported by Akari as a secure note + custom fields. */
function markedNote(c, type, custom) {
  const b = typed(type);
  return b.item({ note: c.notes, extra: fillByName(b, custom) });
}

/** @returns {Promise<{ items: object[], skipped: number, warnings: string[] }>} */
export async function parse(file, ctx = {}) {
  const warnings = [];
  let json;
  if (isZip(file.bytes)) {
    const entries = readZip(file.bytes);
    const data = findEntry(entries, 'data.json');
    if (!data) throw new ImportError('INVALID_FORMAT', 'Bitwarden の ZIP に data.json が見つかりませんでした');
    const others = entries.filter((e) => e !== data).length;
    if (others) warnings.push(`添付ファイル ${others} 件は読み込まれません`);
    json = parseJson(bytesToText(await data.bytes()), 'Bitwarden');
  } else {
    json = parseJson(bytesToText(file.bytes), 'Bitwarden');
  }
  if (json && json.encrypted === true) json = await decryptExport(json, ctx.password);
  if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
    throw new ImportError('INVALID_FORMAT', 'Bitwarden の書き出しファイル（JSON）ではありません');
  }

  const items = [];
  let skipped = 0, unknown = 0, badTotp = 0, badPasskeys = 0;
  for (const c of json.items) {
    if (!c || typeof c !== 'object' || c.deletedDate) { skipped++; continue; }
    const base = {
      title: c.name,
      fav: c.favorite === true,
      createdAt: toMs(c.creationDate),
      updatedAt: toMs(c.revisionDate),
    };
    const fields = Array.isArray(c.fields) ? c.fields : [];
    const mark = String(fields.find((f) => f?.name === MARKER)?.value ?? '').trim();
    const akari = TYPE_IDS.includes(mark) ? mark : null;
    const custom = customFields(fields.filter((f) => f?.name !== MARKER)); // the marker itself is never kept

    if (c.type === 1) {
      const l = c.login || {};
      const uris = (Array.isArray(l.uris) ? l.uris : []).map((u) => String(u?.uri ?? '').trim()).filter(Boolean);
      const extra = uris.slice(1).map((u) => ({ label: L('url', 'URL'), value: u, secret: false }));
      let totp = null;
      if (l.totp) {
        totp = parseOtp(l.totp, l.username || c.name);
        if (!totp) { badTotp++; extra.push({ label: L('otp', 'ワンタイムパスワード'), value: l.totp, secret: true }); }
      }
      const passkeys = [];
      for (const f of Array.isArray(l.fido2Credentials) ? l.fido2Credentials : []) {
        const pk = await toPasskey(f, base.createdAt);
        if (pk) passkeys.push(pk);
        else badPasskeys++;
      }
      items.push({
        ...base, type: 'login', url: uris[0] || '', username: l.username, password: l.password, totp, passkeys,
        note: c.notes, extra: [...extra, ...custom],
      });
    } else if (akari && akari !== 'login' && akari !== 'note' && MAP[c.type]?.[0] !== akari) {
      items.push({ ...base, ...markedNote(c, akari, custom) });
    } else if (MAP[c.type]) {
      items.push({ ...base, ...typedItem(c, custom, !!akari) });
    } else {
      if (c.type !== 2 && !akari) unknown++;
      items.push({ ...base, type: 'note', note: c.notes, extra: custom });
    }
  }

  if (unknown) warnings.push(`種類の分からないアイテム ${unknown} 件をセキュアノートとして読み込みました`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はカスタムフィールドに残しました`);
  if (badPasskeys) warnings.push(`パスキー ${badPasskeys} 件は Akari が対応していない形式（P-256 以外など）のため読み込めませんでした`);
  return { items, skipped, warnings };
}
