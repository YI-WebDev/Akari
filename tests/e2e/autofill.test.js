// Autofill and save prompt on the fixture login pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launch, extensionMessenger, serveStatic, MASTER, ROOT } from './helpers.js';

let ext, ext2, send, site;

before(async () => {
  ext = await launch();
  ext2 = await extensionMessenger(ext);
  send = ext2.send;
  assert.equal((await send('vault/setup', { masterPassword: MASTER })).ok, true);
  site = await serveStatic(path.join(ROOT, 'tests/fixtures/login'));
});
after(async () => {
  await ext?.close();
  await site?.close();
});

const tabIdOf = (url) => ext2.page.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, url);

test('popup-style fill only on the matching site', async () => {
  const saved = await send('vault/saveItem', {
    item: { type: 'login', title: 'localhost', url: site.origin + '/', username: 'haruka@example.jp', password: 'S0ra-Kumo!42', vault: 'personal' },
  });
  const itemId = saved.data.item.id;

  const page = await ext.context.newPage();
  await page.goto(site.origin + '/login.html');
  const tabId = await tabIdOf(site.origin + '/login.html');

  const m = await send('autofill/matches', { tabId });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual(m.data.items.map((i) => i.id), [itemId]);
  assert.ok(!JSON.stringify(m.data).includes('S0ra-Kumo'), 'matches must not carry passwords');

  const r = await send('autofill/fill', { tabId, itemId });
  assert.deepEqual(r, { ok: true, data: { filled: true } });
  assert.equal(await page.inputValue('#username'), 'haruka@example.jp');
  assert.equal(await page.inputValue('#password'), 'S0ra-Kumo!42');

  // A different site must be refused even when asked explicitly.
  const other = await ext.context.newPage();
  await other.goto('http://127.0.0.1:' + new URL(site.origin).port + '/login.html');
  const otherTab = await tabIdOf('http://127.0.0.1:' + new URL(site.origin).port + '/login.html');
  const denied = await send('autofill/fill', { tabId: otherTab, itemId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'DOMAIN_MISMATCH');
  assert.equal(await other.inputValue('#password'), '');
  await other.close();
  await page.close();
});

test('submitting a new password offers an update and saves it', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/login.html');
  await page.fill('#username', 'haruka@example.jp');
  await page.fill('#password', 'Brand-New-Pass-77');
  await page.click('#submit');
  // The bar lives in a closed shadow root; click 保存 by its fixed position (top-right card).
  // Clicks only count once the bar has been verifiably visible for 500 ms (clickjacking guard).
  await page.waitForTimeout(1300);
  await page.mouse.click(1000 - 62, 116);
  await page.waitForTimeout(500);
  const all = await send('vault/getAll');
  const item = all.data.items.find((i) => i.username === 'haruka@example.jp');
  assert.equal(item.password, 'Brand-New-Pass-77');
  await page.close();
});

// The inline menu lives in a closed shadow root: orb and first row are clicked by position.
async function openMenu(page) {
  await page.goto(site.origin + '/login.html');
  await page.locator('#username').click();
  await page.waitForTimeout(500);
  const r = await page.locator('#username').evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { x: b.x, right: b.right, y: b.y, h: b.height, bottom: b.bottom };
  });
  await page.mouse.click(r.right - 18, r.y + r.h / 2); // orb
  return { row: [r.x + 80, r.bottom + 32] };
}
const filled = (page) => page.evaluate(() => document.getElementById('password').value);

test('inline menu: a click only counts after 500 ms of verified visibility', async () => {
  const page = await ext.context.newPage();
  const { row } = await openMenu(page);
  await page.mouse.click(...row); // straight away: refused
  await page.waitForTimeout(300);
  assert.equal(await filled(page), '', 'early click must be ignored');
  await page.waitForTimeout(1000);
  await page.mouse.click(...row);
  await page.waitForTimeout(500);
  assert.equal(await filled(page), 'Brand-New-Pass-77');
  await page.close();
});

test('inline menu: invisible or covered menu never fills (clickjacking)', async () => {
  const page = await ext.context.newPage();
  const { row } = await openMenu(page);
  await page.waitForTimeout(1200); // menu is trusted by now...

  // ...but the page fades the whole document: refused
  await page.evaluate(() => { document.documentElement.style.opacity = '0.01'; });
  await page.mouse.click(...row);
  await page.waitForTimeout(300);
  assert.equal(await filled(page), '', 'translucent <html> must block the click');
  await page.evaluate(() => { document.documentElement.style.opacity = ''; });

  // pointer-events:none decoys painted over the menu: refused (and the timer restarts). One stacked above
  // our host in the same layer, one in the top layer (popover), which nothing in the page can sit above.
  for (const kind of ['stacked', 'top-layer']) {
    await page.evaluate((k) => {
      const d = document.createElement('div');
      d.id = 'decoy';
      d.style.cssText = 'position:fixed;inset:0;margin:0;border:0;background:rgba(255,0,0,.25);pointer-events:none;z-index:2147483647';
      if (k === 'top-layer') {
        d.popover = 'manual';
        document.body.append(d);
        d.showPopover();
      } else {
        document.documentElement.append(d); // after Akari's host in tree order
      }
    }, kind);
    await page.waitForTimeout(1500);
    await page.mouse.click(...row);
    await page.waitForTimeout(300);
    assert.equal(await filled(page), '', kind + ' decoy overlay must block the click');
    await page.evaluate(() => document.getElementById('decoy').remove());
    await page.waitForTimeout(1000);
  }

  // once the page is clean again and the menu has been visible long enough, it works
  await page.waitForTimeout(1000);
  await page.mouse.click(...row);
  await page.waitForTimeout(500);
  assert.equal(await filled(page), 'Brand-New-Pass-77');
  await page.close();
});
