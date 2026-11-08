import { ImportError } from './model.js';
import { t } from '../../shared/i18n.js';

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22;
const MAX_ARCHIVE_COMMENT_LENGTH = 0xffff;
const CENTRAL_DIRECTORY_ENTRY_FIXED_SIZE = 46;
const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const ZIP64_OFFSET_MARKER = 0xffffffff;
const ZIP64_COUNT_MARKER = 0xffff;
const ENCRYPTED_FLAG = 1;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const MAX_ENTRIES = 10000;
export const MAX_ENTRY_BYTES = 64 * 2 ** 20;
export const MAX_TOTAL_BYTES = 256 * 2 ** 20;

const tooBig = () => new ImportError('UNSUPPORTED', t('ファイルが大きすぎます（展開後 64 MB まで）'));

async function inflateRaw(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch {
      throw new ImportError('INVALID_FORMAT', t('ZIP の展開に失敗しました'));
    }
    if (r.done) break;
    n += r.value.length;
    if (n > limit) {
      await reader.cancel().catch(() => {});
      throw new ImportError('INVALID_FORMAT', t('ZIP の展開に失敗しました（サイズが一致しません）'));
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function findEndOfCentralDirectory(bytes) {
  const lastPossible = bytes.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE;
  for (let i = lastPossible; i >= Math.max(0, lastPossible - MAX_ARCHIVE_COMMENT_LENGTH); i--) {
    if (u32(bytes, i) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return i;
  }
  return -1;
}

export function readZip(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new ImportError('INVALID_FORMAT', t('ZIP ファイルとして読めませんでした'));
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  if (p === ZIP64_OFFSET_MARKER || count === ZIP64_COUNT_MARKER) throw new ImportError('UNSUPPORTED', t('ZIP64 形式には対応していません'));
  if (count > MAX_ENTRIES) throw new ImportError('UNSUPPORTED', t('ZIP のファイル数が多すぎます（{max} 個まで）', { max: MAX_ENTRIES }));

  let remainingBytes = MAX_TOTAL_BYTES;
  const entries = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) throw new ImportError('INVALID_FORMAT', t('ZIP の目次が壊れています'));
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28), xlen = u16(bytes, p + 30), clen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + CENTRAL_DIRECTORY_ENTRY_FIXED_SIZE, p + CENTRAL_DIRECTORY_ENTRY_FIXED_SIZE + nlen));
    p += CENTRAL_DIRECTORY_ENTRY_FIXED_SIZE + nlen + xlen + clen;
    if (name.endsWith('/')) continue;

    const read = async () => {
      if (flags & ENCRYPTED_FLAG) throw new ImportError('UNSUPPORTED', t('パスワード付き ZIP には対応していません。暗号化せずに書き出してください'));
      if (u32(bytes, local) !== LOCAL_FILE_HEADER_SIGNATURE) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
      const start = local + LOCAL_FILE_HEADER_FIXED_SIZE + u16(bytes, local + 26) + u16(bytes, local + 28);
      if (start + csize > bytes.length) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
      if (usize > MAX_ENTRY_BYTES || usize > remainingBytes) throw tooBig();
      remainingBytes -= usize;
      const data = bytes.subarray(start, start + csize);
      if (method === METHOD_STORED) {
        if (csize !== usize) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
        return data.slice();
      }
      if (method === METHOD_DEFLATE) {
        const out = await inflateRaw(data, usize);
        if (out.length !== usize) throw new ImportError('INVALID_FORMAT', t('ZIP の展開に失敗しました'));
        return out;
      }
      throw new ImportError('UNSUPPORTED', t('ZIP の圧縮方式 {method} には対応していません', { method }));
    };
    entries.push({ name, size: usize, bytes: read, text: async () => new TextDecoder().decode(await read()) });
  }
  return entries;
}

export function findEntry(entries, ...names) {
  for (const want of names) {
    const w = want.toLowerCase();
    const hit = entries.find((e) => e.name.toLowerCase() === w)
      || entries.find((e) => e.name.toLowerCase().split('/').pop() === w);
    if (hit) return hit;
  }
  return null;
}
