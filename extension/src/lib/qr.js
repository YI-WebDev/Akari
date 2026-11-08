import jsQR from '../third_party/jsqr.js';

const FAST_MAX_DIM = 1600;

export function decodeQrFromImageData({ data, width, height }) {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return result && result.data ? result.data : null;
}

export async function decodeQrFromDataUrl(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest > FAST_MAX_DIM) {
      const scale = FAST_MAX_DIM / longest;
      const text = decodeQrFromImageData(draw(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale)));
      if (text) return text;
    }
    return decodeQrFromImageData(draw(bitmap, bitmap.width, bitmap.height));
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    const type = m[1] || 'application/octet-stream';
    if (/;base64/i.test(m[2])) {
      const bin = atob(m[3]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(m[3])], { type });
  } catch {
    return null;
  }
}

function draw(bitmap, width, height) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
