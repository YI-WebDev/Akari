// Bitwarden JSON export: unencrypted, password-protected (PBKDF2-SHA256), or a ZIP with
// data.json + attachments/. Item types: 1 login, 2 secure note, 3 card, 4 identity, 5 SSH key.
//
// Password-protected exports: key = PBKDF2-SHA256(password, utf8(salt string), kdfIterations, 32 B),
// stretched with HKDF-Expand(SHA-256, info "enc" / "mac", 32 B). `encKeyValidation_DO_NOT_EDIT`
// and `data` are EncStrings "2.<iv b64>|<ciphertext b64>|<mac b64>" — AES-256-CBC with
// HMAC-SHA256(macKey, iv ‖ ciphertext), verified before decrypting.

import { ImportError, fieldsToNote, parseOtp, toMs, bytesToText, parseJson, isZip } from '../model.js';
import { readZip, findEntry } from '../zip.js';
import { utf8, fromUtf8, fromB64, toB64url, fromB64url, concat } from '../../../shared/bytes.js';

const KINDS = { 3: 'クレジットカード', 4: '個人情報', 5: 'SSH キー' };

const CARD = [['cardholderName', 'カード名義'], ['brand', 'ブランド'], ['number', 'カード番号'], ['code', 'セキュリティコード']];
const IDENTITY = [
  ['title', '敬称'], ['firstName', '名'], ['middleName', 'ミドルネーム'], ['lastName', '姓'],
  ['company', '会社'], ['email', 'メール'], ['phone', '電話'], ['username', 'ユーザー名'],
  ['address1', '住所 1'], ['address2', '住所 2'], ['address3', '住所 3'], ['city', '市区町村'],
  ['state', '都道府県・州'], ['postalCode', '郵便番号'], ['country', '国'],
  ['ssn', '社会保障番号'], ['passportNumber', 'パスポート番号'], ['licenseNumber', '免許証番号'],
];
const SSH = [['privateKey', '秘密鍵'], ['publicKey', '公開鍵'], ['keyFingerprint', 'フィンガープリント']];

const pairs = (obj, map) => map.map(([k, label]) => [label, obj?.[k]]);
const joinNote = (...parts) => parts.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean).join('\n\n');

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
  return fields.filter((f) => f && f.type !== 3).map((f) => [String(f.name ?? '').trim() || 'フィールド', f.value]);
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
  const converted = {};
  let skipped = 0, badTotp = 0, badPasskeys = 0;
  for (const c of json.items) {
    if (!c || typeof c !== 'object' || c.deletedDate) { skipped++; continue; }
    const base = {
      title: c.name,
      fav: c.favorite === true,
      createdAt: toMs(c.creationDate),
      updatedAt: toMs(c.revisionDate),
    };
    const custom = customFields(c.fields);

    if (c.type === 1) {
      const l = c.login || {};
      const uris = (Array.isArray(l.uris) ? l.uris : []).map((u) => String(u?.uri ?? '').trim()).filter(Boolean);
      const extras = uris.slice(1).map((u) => ['URL', u]);
      let totp = null;
      if (l.totp) {
        totp = parseOtp(l.totp, l.username || c.name);
        if (!totp) { badTotp++; extras.push(['TOTP', l.totp]); }
      }
      const passkeys = [];
      for (const f of Array.isArray(l.fido2Credentials) ? l.fido2Credentials : []) {
        const pk = await toPasskey(f, base.createdAt);
        if (pk) passkeys.push(pk);
        else badPasskeys++;
      }
      items.push({
        ...base,
        type: 'login',
        url: uris[0] || '',
        username: l.username,
        password: l.password,
        totp,
        passkeys,
        note: joinNote(c.notes, fieldsToNote([...extras, ...custom])),
      });
      continue;
    }
    if (c.type === 2) {
      items.push({ ...base, type: 'note', note: joinNote(c.notes, fieldsToNote(custom)) });
      continue;
    }
    const kind = KINDS[c.type] || 'その他のアイテム';
    let fields = [];
    if (c.type === 3) {
      const card = c.card || {};
      const exp = [card.expMonth && String(card.expMonth).padStart(2, '0'), card.expYear].filter(Boolean).join('/');
      fields = [...pairs(card, CARD.slice(0, 3)), ['有効期限', exp], ...pairs(card, CARD.slice(3))];
    } else if (c.type === 4) {
      fields = pairs(c.identity, IDENTITY);
    } else if (c.type === 5) {
      fields = pairs(c.sshKey, SSH);
    }
    converted[kind] = (converted[kind] || 0) + 1;
    items.push({ ...base, type: 'note', note: fieldsToNote([...fields, ...custom], c.notes) });
  }

  for (const [kind, n] of Object.entries(converted)) warnings.push(`${kind} ${n} 件をセキュアノートとして読み込みました`);
  if (badTotp) warnings.push(`読み取れない TOTP 設定 ${badTotp} 件はメモに残しました`);
  if (badPasskeys) warnings.push(`パスキー ${badPasskeys} 件は Akari が対応していない形式（P-256 以外など）のため読み込めませんでした`);
  return { items, skipped, warnings };
}
