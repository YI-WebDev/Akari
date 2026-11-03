// Akari as a WebAuthn authenticator (ES256 only, attestation "none").
// Pure module: runs in the service worker and in Node tests (WebCrypto only).

import { encode as cborEncode } from './cbor.js';
import { utf8, toB64url, fromB64url, concat, randomBytes, sha256 } from '../shared/bytes.js';

// Akari's fixed AAGUID: ea7f7ba3-3d3b-42cd-8c88-2d82a9548d11
export const AKARI_AAGUID = Uint8Array.from([
  0xea, 0x7f, 0x7b, 0xa3, 0x3d, 0x3b, 0x42, 0xcd, 0x8c, 0x88, 0x2d, 0x82, 0xa9, 0x54, 0x8d, 0x11,
]);

export const COSE_ALG_ES256 = -7;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08; // backup eligible: the vault syncs/exports like a synced passkey
const FLAG_BS = 0x10; // backup state
const FLAG_AT = 0x40;

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' };

const toBytes = (v) => (typeof v === 'string' ? fromB64url(v)
  : v instanceof Uint8Array ? v
    : v instanceof ArrayBuffer ? new Uint8Array(v)
      : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));

const u32be = (n) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/**
 * CollectedClientData in spec member order. Call only with the origin the service
 * worker derived from the message sender, never with a page-supplied value.
 * @returns {Uint8Array} UTF-8 JSON bytes
 */
export function buildClientDataJSON({ type, challenge, origin, crossOrigin = false }) {
  if (type !== 'webauthn.create' && type !== 'webauthn.get') throw new TypeError('bad clientData type');
  const ch = typeof challenge === 'string' ? toB64url(fromB64url(challenge)) : toB64url(toBytes(challenge));
  return utf8(JSON.stringify({ type, challenge: ch, origin, crossOrigin: !!crossOrigin }));
}

/** WebCrypto returns raw r‖s (IEEE P1363); WebAuthn wants an ASN.1 DER Ecdsa-Sig-Value. */
export function rawSignatureToDer(raw) {
  const sig = toBytes(raw);
  if (sig.length !== 64) throw new Error('rawSignatureToDer: expected 64 bytes');
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0] & 0x80 ? concat(Uint8Array.of(0), v) : v;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const r = int(sig.subarray(0, 32));
  const s = int(sig.subarray(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/**
 * Make a new discoverable ES256 credential.
 * @returns {Promise<{ credentialId: Uint8Array, privateKey: Uint8Array, cosePublicKey: Uint8Array,
 *   spkiPublicKey: Uint8Array, authData: Uint8Array, attestationObject: Uint8Array }>}
 */
export async function createCredential({ rpId, userHandle, clientDataHash, uv = true }) {
  if (!rpId) throw new TypeError('createCredential: rpId required');
  const handle = toBytes(userHandle);
  if (handle.length < 1 || handle.length > 64) throw new RangeError('createCredential: userHandle must be 1-64 bytes');
  if (toBytes(clientDataHash).length !== 32) throw new RangeError('createCredential: clientDataHash must be 32 bytes');

  const pair = await crypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spkiPublicKey = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)); // 0x04 ‖ x ‖ y

  const cosePublicKey = cborEncode(new Map([
    [1, 2], // kty: EC2
    [3, COSE_ALG_ES256], // alg
    [-1, 1], // crv: P-256
    [-2, rawPub.subarray(1, 33)], // x
    [-3, rawPub.subarray(33, 65)], // y
  ]));

  const credentialId = randomBytes(32);
  const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | FLAG_AT;
  const authData = concat(
    await sha256(utf8(rpId)),
    Uint8Array.of(flags),
    u32be(0),
    AKARI_AAGUID,
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    cosePublicKey,
  );
  // CTAP2 canonical key order puts these as fmt, attStmt, authData.
  const attestationObject = cborEncode({ fmt: 'none', attStmt: {}, authData });

  return { credentialId, privateKey, cosePublicKey, spkiPublicKey, authData, attestationObject };
}

/**
 * Sign an assertion with a stored passkey (PLAN.md §2 Passkey shape, b64url fields).
 * signCount stays 0, as with synced passkeys.
 * @returns {Promise<{ authenticatorData: Uint8Array, signature: Uint8Array, userHandle: Uint8Array, credentialId: Uint8Array }>}
 */
export async function getAssertion({ passkey, rpId, clientDataHash, uv = true }) {
  if (!passkey || passkey.rpId !== rpId) throw new Error('getAssertion: passkey does not belong to rpId');
  if ((passkey.alg ?? COSE_ALG_ES256) !== COSE_ALG_ES256) throw new Error('getAssertion: unsupported alg');
  const hash = toBytes(clientDataHash);
  if (hash.length !== 32) throw new RangeError('getAssertion: clientDataHash must be 32 bytes');

  const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS;
  const authenticatorData = concat(await sha256(utf8(rpId)), Uint8Array.of(flags), u32be(0));
  const key = await crypto.subtle.importKey('pkcs8', fromB64url(passkey.privateKey), EC_P256, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(authenticatorData, hash)));

  return {
    authenticatorData,
    signature: rawSignatureToDer(raw),
    userHandle: fromB64url(passkey.userHandle),
    credentialId: fromB64url(passkey.credentialId),
  };
}
