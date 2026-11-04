// Builds a passkey the way Proton Pass writes it into data.json, for tests.
//
// Proton (proton-pass-common, Rust) serialises the passkey with rmp_serde::to_vec_named:
// structs are MessagePack maps keyed by field name, Vec<u8> is an array of numbers,
// Option::None is nil, and its enums are adjacently tagged ({ t, c }). The private COSE key
// comes from passkey-rs: EC2 / ES256 with params crv (-1), x (-2), y (-3) and d (-4).
// The result is wrapped as { c: <bytes>, v: 1 } and data.json stores it as base64.
// This is an independent encoder, so the importer's decoder is checked against it.

const T = (t, c) => (c === undefined ? { t } : { t, c });
const bytes = (b) => ({ __bytes: Uint8Array.from(b) }); // Vec<u8>: an array of numbers
const int128 = (n) => {
  const inner = new Uint8Array(16);
  let v = BigInt(n);
  for (let i = 0; i < 16; i++) { inner[i] = Number(v & 0xffn); v >>= 8n; }
  return { inner: bytes(inner) };
};

function encode(v, out) {
  if (v === null || v === undefined) { out.push(0xc0); return; }
  if (v === true || v === false) { out.push(v ? 0xc3 : 0xc2); return; }
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('floats not needed here');
    if (v >= 0 && v < 128) out.push(v);
    else if (v < 0 && v >= -32) out.push(0x100 + v);
    else if (v >= 0 && v < 256) out.push(0xcc, v);
    else if (v >= 0 && v < 65536) out.push(0xcd, v >> 8, v & 0xff);
    else if (v >= 0 && v <= 0xffffffff) out.push(0xce, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    else if (v < 0 && v >= -128) out.push(0xd0, v & 0xff);
    else throw new Error('int out of range for this helper');
    return;
  }
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    if (b.length < 32) out.push(0xa0 | b.length);
    else if (b.length < 256) out.push(0xd9, b.length);
    else throw new Error('string too long for this helper');
    out.push(...b);
    return;
  }
  if (v.__bytes) { encode([...v.__bytes], out); return; }
  if (Array.isArray(v)) {
    if (v.length < 16) out.push(0x90 | v.length);
    else out.push(0xdc, v.length >> 8, v.length & 0xff);
    for (const x of v) encode(x, out);
    return;
  }
  const entries = Object.entries(v);
  if (entries.length >= 16) throw new Error('map too big for this helper');
  out.push(0x80 | entries.length);
  for (const [k, x] of entries) { encode(k, out); encode(x, out); }
}

export const msgpack = (v) => { const out = []; encode(v, out); return Uint8Array.from(out); };

/**
 * The `content` bytes of a Proton passkey. `key` is a P-256 JWK with d, x, y (base64url), or
 * `cose` overrides the whole COSE key (for unsupported kinds of key).
 */
export function protonContent({ key, cose, credentialId, rpId, userHandle, userName = null, userDisplayName = null, version = 1 }) {
  const b = (s) => bytes(Buffer.from(s, 'base64url'));
  const coseKey = cose || {
    kty: T('assign', 'EC2'),
    kid: bytes([]),
    alg: T('assign', 'ES256'),
    kops: [],
    biv: bytes([]),
    par: [
      [T('int', -1), T('int', int128(1))],
      [T('int', -2), T('bytes', b(key.x))],
      [T('int', -3), T('bytes', b(key.y))],
      [T('int', -4), T('bytes', b(key.d))],
    ],
  };
  const inner = msgpack({
    key: coseKey,
    cid: bytes(credentialId),
    rid: rpId,
    uhd: userHandle ? bytes(userHandle) : null,
    cnt: null,
    ext: { hmac_secret: null },
    udn: userDisplayName,
    un: userName,
  });
  return msgpack({ c: bytes(inner), v: version });
}

/** One entry of a Proton login's content.passkeys, as data.json has it (byte fields in base64). */
export function protonPasskeyEntry(opts) {
  const b64 = (u8) => (u8 ? Buffer.from(u8).toString('base64') : '');
  return {
    keyId: 'key-' + opts.rpId,
    content: b64(protonContent(opts)),
    domain: opts.rpId,
    rpId: opts.rpId,
    rpName: opts.rpName || opts.rpId,
    userName: opts.userName || '',
    userDisplayName: opts.userDisplayName || '',
    userId: b64(opts.userHandle),
    createTime: opts.createTime ?? 1700000000,
    note: '',
    credentialId: b64(opts.credentialId),
    userHandle: b64(opts.userHandle),
    creationData: { osName: 'Windows', osVersion: '11', deviceName: 'Brave', appVersion: 'pass-extension' },
  };
}

export { T, int128, bytes };
