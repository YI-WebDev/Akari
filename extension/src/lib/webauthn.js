import { encode as cborEncode } from './cbor.js';
import { utf8, toB64url, fromB64url, concat, randomBytes, sha256 } from '../shared/bytes.js';

export const AKARI_AAGUID = Uint8Array.from([
  0xea, 0x7f, 0x7b, 0xa3, 0x3d, 0x3b, 0x42, 0xcd, 0x8c, 0x88, 0x2d, 0x82, 0xa9, 0x54, 0x8d, 0x11,
]);

export const COSE_ALG_ES256 = -7;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const COSE_KEY_TYPE = 1;
const COSE_KEY_ALG = 3;
const COSE_KEY_CURVE = -1;
const COSE_KEY_X = -2;
const COSE_KEY_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;
const P256_COORDINATE_BYTES = 32;
const CREDENTIAL_ID_BYTES = 32;
const CLIENT_DATA_HASH_BYTES = 32;
const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' };

const toBytes = (v) => (typeof v === 'string' ? fromB64url(v)
  : v instanceof Uint8Array ? v
    : v instanceof ArrayBuffer ? new Uint8Array(v)
      : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));

const u32be = (n) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

export function buildClientDataJSON({ type, challenge, origin, crossOrigin = false }) {
  if (type !== 'webauthn.create' && type !== 'webauthn.get') throw new TypeError('bad clientData type');
  const ch = typeof challenge === 'string' ? toB64url(fromB64url(challenge)) : toB64url(toBytes(challenge));
  return utf8(JSON.stringify({ type, challenge: ch, origin, crossOrigin: !!crossOrigin }));
}

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

export async function createCredential({ rpId, userHandle, clientDataHash, uv = true }) {
  if (!rpId) throw new TypeError('createCredential: rpId required');
  const handle = toBytes(userHandle);
  if (handle.length < 1 || handle.length > 64) throw new RangeError('createCredential: userHandle must be 1-64 bytes');
  if (toBytes(clientDataHash).length !== CLIENT_DATA_HASH_BYTES) throw new RangeError('createCredential: clientDataHash must be 32 bytes');

  const pair = await crypto.subtle.generateKey(EC_P256, true, ['sign', 'verify']);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const spkiPublicKey = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

  const publicX = rawPub.subarray(1, 1 + P256_COORDINATE_BYTES);
  const publicY = rawPub.subarray(1 + P256_COORDINATE_BYTES, 1 + 2 * P256_COORDINATE_BYTES);
  const cosePublicKey = cborEncode(new Map([
    [COSE_KEY_TYPE, COSE_KTY_EC2],
    [COSE_KEY_ALG, COSE_ALG_ES256],
    [COSE_KEY_CURVE, COSE_CRV_P256],
    [COSE_KEY_X, publicX],
    [COSE_KEY_Y, publicY],
  ]));

  const credentialId = randomBytes(CREDENTIAL_ID_BYTES);
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
  const attestationObject = cborEncode({ fmt: 'none', attStmt: {}, authData });

  return { credentialId, privateKey, cosePublicKey, spkiPublicKey, authData, attestationObject };
}

export async function getAssertion({ passkey, rpId, clientDataHash, uv = true }) {
  if (!passkey || passkey.rpId !== rpId) throw new Error('getAssertion: passkey does not belong to rpId');
  if ((passkey.alg ?? COSE_ALG_ES256) !== COSE_ALG_ES256) throw new Error('getAssertion: unsupported alg');
  const hash = toBytes(clientDataHash);
  if (hash.length !== CLIENT_DATA_HASH_BYTES) throw new RangeError('getAssertion: clientDataHash must be 32 bytes');

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
