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

const SAVE_BAR_BUTTON_AT = [1000 - 62, 116];

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
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const all = await send('vault/getAll');
  const item = all.data.items.find((i) => i.username === 'haruka@example.jp');
  assert.equal(item.password, 'Brand-New-Pass-77');
  await page.close();
});

test('two-step login with a saved account (password on a new page) does not offer to save it again', async () => {
  await send('vault/saveItem', {
    item: { type: 'login', title: 'localhost', url: site.origin + '/', username: 'mori@example.jp', password: 'Mori-Pass-55', vault: 'personal' },
  });
  const count = async () => (await send('vault/getAll')).data.items.length;
  const before = await count();
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  const signIn = async (password) => {
    await page.goto(site.origin + '/two-step.html');
    await page.fill('#identifier', 'mori@example.jp');
    await Promise.all([page.waitForURL(/two-step-password\.html/), page.click('#next')]);
    await page.fill('#password', password);
    await page.click('#signin');
    await page.waitForSelector('#status[data-state="submitted"]');
    await page.waitForTimeout(1300);
    await page.mouse.click(...SAVE_BAR_BUTTON_AT);
    await page.waitForTimeout(500);
  };

  await signIn('Mori-Pass-55');
  assert.equal(await count(), before, 'no "Akari に保存しますか？" for a saved account');

  await signIn('Mori-Pass-56');
  const items = (await send('vault/getAll')).data.items;
  assert.equal(items.length, before, 'updated, not added');
  assert.equal(items.find((i) => i.username === 'mori@example.jp').password, 'Mori-Pass-56');
  assert.equal(items.find((i) => i.username === 'haruka@example.jp').password, 'Brand-New-Pass-77', 'the other account untouched');
  await page.close();
});

async function openMenuByClickingOrb(page) {
  await page.goto(site.origin + '/login.html');
  await page.locator('#username').click();
  await page.waitForTimeout(500);
  const r = await page.locator('#username').evaluate((e) => {
    const b = e.getBoundingClientRect();
    return { x: b.x, right: b.right, y: b.y, h: b.height, bottom: b.bottom };
  });
  await page.mouse.click(r.right - 18, r.y + r.h / 2);
  return { row: [r.x + 80, r.bottom + 32] };
}
const filled = (page) => page.evaluate(() => document.getElementById('password').value);

test('inline menu: a click only counts after 500 ms of verified visibility', async () => {
  const page = await ext.context.newPage();
  const { row } = await openMenuByClickingOrb(page);
  await page.mouse.click(...row);
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
  const { row } = await openMenuByClickingOrb(page);
  await page.waitForTimeout(1200);

  await page.evaluate(() => { document.documentElement.style.opacity = '0.01'; });
  await page.mouse.click(...row);
  await page.waitForTimeout(300);
  assert.equal(await filled(page), '', 'translucent <html> must block the click');
  await page.evaluate(() => { document.documentElement.style.opacity = ''; });

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
        document.documentElement.append(d);
      }
    }, kind);
    await page.waitForTimeout(1500);
    await page.mouse.click(...row);
    await page.waitForTimeout(300);
    assert.equal(await filled(page), '', kind + ' decoy overlay must block the click');
    await page.evaluate(() => document.getElementById('decoy').remove());
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(1000);
  await page.mouse.click(...row);
  await page.waitForTimeout(500);
  assert.equal(await filled(page), 'Brand-New-Pass-77');
  await page.close();
});
