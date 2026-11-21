import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launch, extensionMessenger, serveStatic, sleep, MASTER, ROOT } from './helpers.js';

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
const badgeOf = (tabId) => ext2.page.evaluate((id) => chrome.action.getBadgeText(id == null ? {} : { tabId: id }), tabId);

async function expectBadge(tabId, text, what) {
  let seen;
  for (let i = 0; i < 50; i++) {
    seen = await badgeOf(tabId);
    if (seen === text) break;
    await sleep(100);
  }
  assert.equal(seen, text, what);
  await sleep(300);
  assert.equal(await badgeOf(tabId), text, what + ' (and it stays)');
}

const saveLogin = async (username) => (await send('vault/saveItem', {
  item: { type: 'login', title: 'localhost', url: site.origin + '/', username, vault: 'personal' },
})).data.item;

test('the toolbar badge counts the logins saved for each tab', async () => {
  const other = site.origin.replace('localhost', '127.0.0.1');
  const first = await saveLogin('haruka@example.jp');

  const page = await ext.context.newPage();
  await page.goto(site.origin + '/login.html');
  const tabId = await tabIdOf(site.origin + '/login.html');
  await expectBadge(tabId, '1', 'a site with one saved login');

  const blank = await ext.context.newPage();
  await blank.goto(other + '/login.html');
  const blankId = await tabIdOf(other + '/login.html');
  await expectBadge(blankId, '', 'a site with no saved login');
  const selfId = await ext2.page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  await expectBadge(selfId, '', 'an extension page');
  await expectBadge(null, '', 'no global badge text');

  const second = await saveLogin('minato@example.jp');
  await expectBadge(tabId, '2', 'after adding a login');
  await expectBadge(blankId, '', 'other tabs keep their own count');

  await page.goto(other + '/login.html');
  await expectBadge(tabId, '', 'after navigating to another site');
  await page.goto(site.origin + '/welcome.html');
  await expectBadge(tabId, '2', 'after navigating back');
  await page.reload();
  await expectBadge(tabId, '2', 'after a reload');

  await send('vault/saveItem', { item: { id: second.id, url: 'https://example.org/' } });
  await expectBadge(tabId, '1', 'after editing a login away from the site');
  await send('vault/saveItem', { item: { id: second.id, url: site.origin + '/' } });
  await expectBadge(tabId, '2', 'after editing it back');

  assert.equal((await send('vault/lock')).ok, true);
  await expectBadge(tabId, '', 'while locked');
  await page.reload();
  await expectBadge(tabId, '', 'a reload while locked');
  assert.equal((await send('vault/unlock', { masterPassword: MASTER })).ok, true);
  await expectBadge(tabId, '2', 'after unlocking');

  await blank.bringToFront();
  await expectBadge(blankId, '', 'after switching tabs');
  await page.bringToFront();
  await expectBadge(tabId, '2', 'after switching back');

  await send('vault/deleteItems', { ids: [first.id, second.id] });
  await expectBadge(tabId, '', 'after deleting the logins');

  await blank.close();
  await page.close();
});
