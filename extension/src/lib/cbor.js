const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

const MAJOR_UINT = 0;
const MAJOR_NEGATIVE_INT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;
const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;
const MAX_NESTING_DEPTH = 32;

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

function compareCanonicalKeys(a, b) {
  if ((a.kb[0] >> 5) !== (b.kb[0] >> 5)) return (a.kb[0] >> 5) - (b.kb[0] >> 5);
  if (a.kb.length !== b.kb.length) return a.kb.length - b.kb.length;
  for (let i = 0; i < a.kb.length; i++) if (a.kb[i] !== b.kb[i]) return a.kb[i] - b.kb[i];
  throw new TypeError('cbor: duplicate map key');
}

function encodeInto(out, value) {
  if (value === null) { out.push((MAJOR_SIMPLE << 5) | SIMPLE_NULL); return; }
  if (value === false) { out.push((MAJOR_SIMPLE << 5) | SIMPLE_FALSE); return; }
  if (value === true) { out.push((MAJOR_SIMPLE << 5) | SIMPLE_TRUE); return; }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('cbor: only safe integers are supported');
    if (value >= 0) out.push(...head(MAJOR_UINT, value));
    else out.push(...head(MAJOR_NEGATIVE_INT, -1 - value));
    return;
  }
  if (typeof value === 'string') {
    const b = te.encode(value);
    out.push(...head(MAJOR_TEXT, b.length));
    for (const x of b) out.push(x);
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const b = value instanceof Uint8Array ? value
      : value instanceof ArrayBuffer ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    out.push(...head(MAJOR_BYTES, b.length));
    for (const x of b) out.push(x);
    return;
  }
  if (Array.isArray(value)) {
    out.push(...head(MAJOR_ARRAY, value.length));
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
    encoded.sort(compareCanonicalKeys);
    out.push(...head(MAJOR_MAP, encoded.length));
    for (const { kb, v } of encoded) {
      for (const x of kb) out.push(x);
      encodeInto(out, v);
    }
    return;
  }
  throw new TypeError('cbor: unsupported value ' + typeof value);
}

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
  if (depth > MAX_NESTING_DEPTH) throw new Error('cbor: nesting too deep');
  if (pos >= bytes.length) throw new Error('cbor: truncated');
  const ib = bytes[pos++];
  const major = ib >> 5;
  const info = ib & 0x1f;
  if (major === MAJOR_SIMPLE) {
    if (info === SIMPLE_FALSE) return [false, pos];
    if (info === SIMPLE_TRUE) return [true, pos];
    if (info === SIMPLE_NULL) return [null, pos];
    throw new Error('cbor: unsupported simple/float value');
  }
  if (major === MAJOR_TAG) throw new Error('cbor: tags are not supported');
  let n;
  [n, pos] = readLength(bytes, pos, info);
  switch (major) {
    case MAJOR_UINT: return [n, pos];
    case MAJOR_NEGATIVE_INT: return [-1 - n, pos];
    case MAJOR_BYTES:
    case MAJOR_TEXT: {
      if (pos + n > bytes.length) throw new Error('cbor: truncated');
      const slice = bytes.slice(pos, pos + n);
      return [major === MAJOR_BYTES ? slice : td.decode(slice), pos + n];
    }
    case MAJOR_ARRAY: {
      if (n > bytes.length - pos) throw new Error('cbor: truncated');
      const arr = [];
      for (let i = 0; i < n; i++) {
        let v;
        [v, pos] = decodeAt(bytes, pos, depth + 1);
        arr.push(v);
      }
      return [arr, pos];
    }
    case MAJOR_MAP: {
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

export function decodePartial(bytes, offset = 0) {
  const [value, end] = decodeAt(bytes, offset, 0);
  return { value, offset: end };
}

export function decode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { value, offset } = decodePartial(b, 0);
  if (offset !== b.length) throw new Error('cbor: trailing bytes');
  return value;
}
