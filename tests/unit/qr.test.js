import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { decodeQrFromImageData, decodeQrFromDataUrl } from '../../extension/src/lib/qr.js';
import { parseOtpauthUri } from '../../extension/src/lib/totp.js';

const URI = 'otpauth://totp/Akari:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Akari&algorithm=SHA1&digits=6&period=30';

/**
 * Render text as a QR code into an RGBA buffer.
 * `canvas` pads the symbol onto a larger noisy background at (offX, offY).
 */
function render(text, { scale = 5, quiet = 4, invert = false, canvas = null, ec = 'M' } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: ec });
  const n = qr.modules.size;
  const side = (n + quiet * 2) * scale;
  const w = canvas ? canvas.width : side;
  const h = canvas ? canvas.height : side;
  const ox = canvas ? canvas.x : 0;
  const oy = canvas ? canvas.y : 0;
  const data = new Uint8ClampedArray(w * h * 4);
  const dark = invert ? 255 : 0;
  const light = invert ? 0 : 255;
  for (let i = 0; i < w * h; i++) {
    // background: mid-grey when embedded in a larger canvas, else the light colour
    const bg = canvas ? 170 : light;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const on = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx);
      const v = on ? dark : light;
      const o = ((y + oy) * w + (x + ox)) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  return { data, width: w, height: h };
}

test('decodes an otpauth URI rendered with the qrcode library', () => {
  assert.equal(decodeQrFromImageData(render(URI)), URI);
});

test('decoded QR text is accepted by parseOtpauthUri', () => {
  const cfg = parseOtpauthUri(decodeQrFromImageData(render(URI)));
  assert.equal(cfg.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(cfg.issuer, 'Akari');
});

for (const scale of [4, 6, 10]) {
  test(`decodes at module scale ${scale}`, () => {
    assert.equal(decodeQrFromImageData(render(URI, { scale })), URI);
  });
}

test('decodes a long payload and Japanese text', () => {
  const long = 'otpauth://totp/' + encodeURIComponent('灯:ユーザー') + '?secret=' + 'ABCDEFGH'.repeat(8) + '&issuer=' + encodeURIComponent('灯');
  assert.equal(decodeQrFromImageData(render(long, { scale: 4 })), long);
});

test('decodes a QR embedded off-centre in a larger image', () => {
  const img = render(URI, { scale: 5, canvas: { width: 900, height: 600, x: 313, y: 141 } });
  assert.equal(decodeQrFromImageData(img), URI);
});

test('decodes an inverted (light-on-dark) QR', () => {
  assert.equal(decodeQrFromImageData(render(URI, { invert: true })), URI);
});

test('returns null when there is no QR code', () => {
  const w = 200;
  const h = 200;
  const blank = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(decodeQrFromImageData({ data: blank, width: w, height: h }), null);
  const noise = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = (s >>> 16) & 255; }
  assert.equal(decodeQrFromImageData({ data: noise, width: w, height: h }), null);
});

test('decodeQrFromDataUrl returns null for input that is not an image data URL', async () => {
  assert.equal(await decodeQrFromDataUrl(''), null);
  assert.equal(await decodeQrFromDataUrl('not a data url'), null);
  assert.equal(await decodeQrFromDataUrl(undefined), null);
});
