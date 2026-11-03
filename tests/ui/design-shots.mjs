// Renders the reference design 1a (design/Akari Terminal.dc.html via design/support.js)
// into tests/ui/screenshots/design-*.png for side-by-side comparison with popup-*.png.
// Needs network access for the React UMD bundles (unpkg) and Google Fonts that the design loads.
// Usage: node tests/ui/design-shots.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from '../../tools/browser.mjs';
import { startServer } from '../../tools/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screenshots');
await mkdir(OUT, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[design]', m.text()); });

try {
  await page.goto(`${base}/design/${encodeURIComponent('Akari Terminal.dc.html')}`);
  const r = page.locator('[data-akt]').first();
  await r.waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  const shot = (name) => r.screenshot({ path: join(OUT, `design-${name}.png`) });
  await shot('main');

  // weak item (amazon) selected, then the generator aimed at it
  await page.locator('[data-id="amazon"]').click();
  await page.waitForTimeout(900);
  await shot('weak');
  await page.getByText('強化する').click();
  await page.waitForTimeout(1200);
  await shot('generator');
  await page.getByText('パスフレーズ', { exact: true }).click();
  await page.waitForTimeout(900);
  await shot('generator-phrase');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // vault menu + plus menu
  await r.hover();
  await page.locator('[data-akt] > div').first().locator('button').first().click();
  await page.waitForTimeout(600);
  await shot('vaultmenu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.locator('button[title="新規作成"]').click();
  await page.waitForTimeout(600);
  await shot('plusmenu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // search with no hits
  await page.locator('[data-akt] input').first().fill('zzz');
  await page.waitForTimeout(500);
  await shot('search-empty');
  await page.locator('[data-akt] input').first().fill('');
  await page.waitForTimeout(300);

  // lock screen, then the boot log while unlocking
  await page.locator('button[title="ロック"]').click();
  await page.waitForTimeout(1200);
  await shot('lock');
  await page.locator('input[type="password"]').fill('correct horse');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await shot('unlocking');
  console.log('design shots written to', OUT);
} finally {
  await browser.close();
  server.close();
}
