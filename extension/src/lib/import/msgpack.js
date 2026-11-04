// Minimal MessagePack reader for importers (Proton Pass keeps each passkey as MessagePack).
// The input comes from a file the user picked, so it is treated as untrusted: every length is
// checked against the bytes that are left before anything is allocated, and nesting is bounded.
//
// nil/bool/int/float/str/bin/array/map are decoded; ext values come back as
// { ext: type, data: Uint8Array }. Maps become plain objects without a prototype (keys as
// strings), 64-bit integers become Numbers.

const MAX_DEPTH = 32;

export class MsgpackError extends Error {}

/** Decode one MessagePack value from `bytes` (Uint8Array). Trailing bytes are an error. */
export function decodeMsgpack(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new MsgpackError('msgpack: bytes expected');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const need = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || pos + n > bytes.length) throw new MsgpackError('msgpack: truncated');
  };
  const take = (n) => {
    need(n);
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const num = (size, get) => {
    need(size);
    const v = get(pos);
    pos += size;
    return v;
  };
  const u8 = () => num(1, (p) => view.getUint8(p));
  const u16 = () => num(2, (p) => view.getUint16(p));
  const u32 = () => num(4, (p) => view.getUint32(p));
  const text = (n) => new TextDecoder('utf-8', { fatal: true }).decode(take(n));

  function list(n, depth) {
    need(n); // every element takes at least one byte
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = read(depth + 1);
    return out;
  }

  function map(n, depth) {
    need(n * 2);
    const out = Object.create(null);
    for (let i = 0; i < n; i++) {
      const k = read(depth + 1);
      out[typeof k === 'string' ? k : String(k)] = read(depth + 1);
    }
    return out;
  }

  const ext = (n) => {
    const type = num(1, (p) => view.getInt8(p));
    return { ext: type, data: take(n) };
  };

  function read(depth) {
    if (depth > MAX_DEPTH) throw new MsgpackError('msgpack: nested too deeply');
    const b = u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f, depth);
    if (b >= 0x90 && b <= 0x9f) return list(b & 0x0f, depth);
    if (b >= 0xa0 && b <= 0xbf) return text(b & 0x1f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return take(u8()).slice();
      case 0xc5: return take(u16()).slice();
      case 0xc6: return take(u32()).slice();
      case 0xc7: return ext(u8());
      case 0xc8: return ext(u16());
      case 0xc9: return ext(u32());
      case 0xca: return num(4, (p) => view.getFloat32(p));
      case 0xcb: return num(8, (p) => view.getFloat64(p));
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: return Number(num(8, (p) => view.getBigUint64(p)));
      case 0xd0: return num(1, (p) => view.getInt8(p));
      case 0xd1: return num(2, (p) => view.getInt16(p));
      case 0xd2: return num(4, (p) => view.getInt32(p));
      case 0xd3: return Number(num(8, (p) => view.getBigInt64(p)));
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: return text(u8());
      case 0xda: return text(u16());
      case 0xdb: return text(u32());
      case 0xdc: return list(u16(), depth);
      case 0xdd: return list(u32(), depth);
      case 0xde: return map(u16(), depth);
      case 0xdf: return map(u32(), depth);
      default: throw new MsgpackError('msgpack: invalid byte 0x' + b.toString(16));
    }
  }

  let value;
  try {
    value = read(0);
  } catch (e) {
    if (e instanceof MsgpackError) throw e;
    throw new MsgpackError('msgpack: ' + (e?.message || 'invalid data')); // e.g. invalid UTF-8
  }
  if (pos !== bytes.length) throw new MsgpackError('msgpack: trailing bytes');
  return value;
}
