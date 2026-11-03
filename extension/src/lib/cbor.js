// Minimal CBOR (RFC 8949) for WebAuthn: unsigned/negative integers, byte strings,
// text strings, arrays, maps, booleans and null. Maps are written in CTAP2
// canonical key order. Use a Map for integer keys (COSE keys); plain objects
// are treated as text-keyed maps. Decoded maps are always returned as Map.

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

function head(major, n) {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const big = BigInt(n);
  const out = [m | 27];
  for (let i = 7; i >= 0; i--) out.push(Number((big >> BigInt(i * 8)) & 0xffn));
  return out;
}

function encodeInto(out, value) {
  if (value === null) { out.push(0xf6); return; }
  if (value === false) { out.push(0xf4); return; }
  if (value === true) { out.push(0xf5); return; }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('cbor: only safe integers are supported');
    if (value >= 0) out.push(...head(0, value));
    else out.push(...head(1, -1 - value));
    return;
  }
  if (typeof value === 'string') {
    const b = te.encode(value);
    out.push(...head(3, b.length));
    for (const x of b) out.push(x);
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const b = value instanceof Uint8Array ? value
      : value instanceof ArrayBuffer ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    out.push(...head(2, b.length));
    for (const x of b) out.push(x);
    return;
  }
  if (Array.isArray(value)) {
    out.push(...head(4, value.length));
    for (const v of value) encodeInto(out, v);
    return;
  }
  if (typeof value === 'object') {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    const encoded = entries.map(([k, v]) => {
      if (typeof k !== 'string' && !Number.isSafeInteger(k)) throw new TypeError('cbor: map keys must be integers or strings');
      const kb = [];
      encodeInto(kb, k);
      return { kb, v };
    });
    // CTAP2 canonical order: major type, then encoded length, then bytewise.
    encoded.sort((a, b) => {
      if ((a.kb[0] >> 5) !== (b.kb[0] >> 5)) return (a.kb[0] >> 5) - (b.kb[0] >> 5);
      if (a.kb.length !== b.kb.length) return a.kb.length - b.kb.length;
      for (let i = 0; i < a.kb.length; i++) if (a.kb[i] !== b.kb[i]) return a.kb[i] - b.kb[i];
      throw new TypeError('cbor: duplicate map key');
    });
    out.push(...head(5, encoded.length));
    for (const { kb, v } of encoded) {
      for (const x of kb) out.push(x);
      encodeInto(out, v);
    }
    return;
  }
  throw new TypeError('cbor: unsupported value ' + typeof value);
}

/** @returns {Uint8Array} */
export function encode(value) {
  const out = [];
  encodeInto(out, value);
  return Uint8Array.from(out);
}

function readLength(bytes, pos, info) {
  if (info < 24) return [info, pos];
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (!size) throw new Error('cbor: unsupported additional info ' + info);
  if (pos + size > bytes.length) throw new Error('cbor: truncated');
  let n = 0n;
  for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(bytes[pos + i]);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer too large');
  return [Number(n), pos + size];
}

function decodeAt(bytes, pos, depth) {
  if (depth > 32) throw new Error('cbor: nesting too deep');
  if (pos >= bytes.length) throw new Error('cbor: truncated');
  const ib = bytes[pos++];
  const major = ib >> 5;
  const info = ib & 0x1f;
  if (major === 7) {
    if (info === 20) return [false, pos];
    if (info === 21) return [true, pos];
    if (info === 22) return [null, pos];
    throw new Error('cbor: unsupported simple/float value');
  }
  if (major === 6) throw new Error('cbor: tags are not supported');
  let n;
  [n, pos] = readLength(bytes, pos, info);
  switch (major) {
    case 0: return [n, pos];
    case 1: return [-1 - n, pos];
    case 2:
    case 3: {
      if (pos + n > bytes.length) throw new Error('cbor: truncated');
      const slice = bytes.slice(pos, pos + n);
      return [major === 2 ? slice : td.decode(slice), pos + n];
    }
    case 4: {
      if (n > bytes.length - pos) throw new Error('cbor: truncated');
      const arr = [];
      for (let i = 0; i < n; i++) {
        let v;
        [v, pos] = decodeAt(bytes, pos, depth + 1);
        arr.push(v);
      }
      return [arr, pos];
    }
    case 5: {
      if (n * 2 > bytes.length - pos) throw new Error('cbor: truncated');
      const map = new Map();
      for (let i = 0; i < n; i++) {
        let k, v;
        [k, pos] = decodeAt(bytes, pos, depth + 1);
        if (typeof k !== 'string' && typeof k !== 'number') throw new Error('cbor: unsupported map key');
        if (map.has(k)) throw new Error('cbor: duplicate map key');
        [v, pos] = decodeAt(bytes, pos, depth + 1);
        map.set(k, v);
      }
      return [map, pos];
    }
    default:
      throw new Error('cbor: unsupported major type ' + major);
  }
}

/** Decode one item starting at `offset`; returns the value and the offset just past it. */
export function decodePartial(bytes, offset = 0) {
  const [value, end] = decodeAt(bytes, offset, 0);
  return { value, offset: end };
}

/** Decode exactly one item; trailing bytes are an error. */
export function decode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { value, offset } = decodePartial(b, 0);
  if (offset !== b.length) throw new Error('cbor: trailing bytes');
  return value;
}
