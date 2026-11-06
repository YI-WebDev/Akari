// Minimal ZIP reader (central directory) for export archives: stored and deflate
// entries, inflated with the platform DecompressionStream. No ZIP64, no encryption.

import { ImportError } from './model.js';
import { t } from '../../shared/i18n.js';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Limits against ZIP bombs: export archives are far below these.
export const MAX_ENTRIES = 10000;
export const MAX_ENTRY_BYTES = 64 * 2 ** 20;
export const MAX_TOTAL_BYTES = 256 * 2 ** 20;

const tooBig = () => new ImportError('UNSUPPORTED', t('ファイルが大きすぎます（展開後 64 MB まで）'));

/** Inflate, counting output as it streams so a lying header can't make us allocate more than `limit`. */
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

/**
 * @param {Uint8Array} bytes
 * @returns {{ name: string, size: number, bytes(): Promise<Uint8Array>, text(): Promise<string> }[]}
 */
export function readZip(bytes) {
  // End of central directory: scan back over a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('INVALID_FORMAT', t('ZIP ファイルとして読めませんでした'));
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new ImportError('UNSUPPORTED', t('ZIP64 形式には対応していません'));
  if (count > MAX_ENTRIES) throw new ImportError('UNSUPPORTED', t('ZIP のファイル数が多すぎます（{max} 個まで）', { max: MAX_ENTRIES }));

  let budget = MAX_TOTAL_BYTES; // shared by every entry of this archive
  const entries = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== 0x02014b50) throw new ImportError('INVALID_FORMAT', t('ZIP の目次が壊れています'));
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nlen = u16(bytes, p + 28), xlen = u16(bytes, p + 30), clen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;

    const read = async () => {
      if (flags & 1) throw new ImportError('UNSUPPORTED', t('パスワード付き ZIP には対応していません。暗号化せずに書き出してください'));
      if (u32(bytes, local) !== 0x04034b50) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      if (start + csize > bytes.length) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
      if (usize > MAX_ENTRY_BYTES || usize > budget) throw tooBig();
      budget -= usize;
      const data = bytes.subarray(start, start + csize);
      if (method === 0) {
        if (csize !== usize) throw new ImportError('INVALID_FORMAT', t('ZIP のエントリが壊れています'));
        return data.slice();
      }
      if (method === 8) {
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

/** Find an entry by exact path, or by file name anywhere in the archive (case-insensitive). */
export function findEntry(entries, ...names) {
  for (const want of names) {
    const w = want.toLowerCase();
    const hit = entries.find((e) => e.name.toLowerCase() === w)
      || entries.find((e) => e.name.toLowerCase().split('/').pop() === w);
    if (hit) return hit;
  }
  return null;
}
