// Renders the toolbar icons from tools/icon.html: design 1a's brand mark, an orange
// square-ish tile (#FF7A45) with a dark 灯 (#14100D) and a glow ring.
// Each size is rendered natively (not downscaled) so the glyph gets pixel hinting;
// the small sizes drop the glow and use a bigger glyph to stay legible.
// Usage: node tools/make-icons.mjs

import { mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { startServer } from './serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'src', 'assets', 'icons');

// tile: px inside the canvas, radius ≈ 1/4 of the tile (the design's 24px tile has a 6px radius)
const SIZES = [
  { size: 16, tile: 16, radius: 4, glyph: 0.8, ring: 0, glow: 0 },
  { size: 32, tile: 30, radius: 7, glyph: 0.72, ring: 0, glow: 0 },
  { size: 48, tile: 42, radius: 10, glyph: 0.68, ring: 1.5, glow: 4 },
  { size: 128, tile: 104, radius: 26, glyph: 0.64, ring: 4, glow: 12 },
];

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
try {
  await mkdir(OUT, { recursive: true });
  for (const { size, tile, radius, glyph, ring, glow } of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.goto(`${base}/tools/icon.html`);
    await page.evaluate((v) => {
      const el = document.getElementById('icon');
      for (const [k, val] of Object.entries(v)) el.style.setProperty(k, val);
    }, { '--s': size + 'px', '--t': tile + 'px', '--r': radius + 'px', '--g': String(glyph), '--ring': ring + 'px', '--glow': glow + 'px' });
    await page.evaluate(() => document.fonts.load("700 16px 'M PLUS 1 Code'", '灯'));
    await page.evaluate(() => document.fonts.ready);
    const file = join(OUT, `icon-${size}.png`);
    await page.locator('#icon').screenshot({ path: file, omitBackground: true });
    console.log(`icon-${size}.png ${(await stat(file)).size} B`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
