// Drives the real popup page against the real service worker (unpacked extension in Chrome).
// setup → add login (generator + TOTP) → weak password → 強化する → lock/unlock (boot log) → settings/export.
// Screenshots go to tests/ui/screenshots/ext-*.png. Usage: node tests/ui/extension-smoke.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launch, MASTER, ROOT, serveStatic } from '../e2e/helpers.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
const ext = await launch();
const errors = [...ext.errors];
let fx = null;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
const steps = [];
const step = (name) => { steps.push(name); console.log('…', name); };

try {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 600, height: 430 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('crash', () => errors.push('popup page crashed'));
  const shot = (n) => page.screenshot({ path: join(OUT, `ext-${n}.png`) });
  const toastText = () => page.locator('#toastMsg').textContent();

  step('setup screen');
  await page.goto(ext.url('src/popup/popup.html'));
  await page.waitForSelector('#gate.on[data-mode="setup"]');
  await page.fill('#setupPw', MASTER);
  await page.fill('#setupPw2', MASTER);
  assert.equal(await page.locator('#setupSubmit').isDisabled(), false, 'setup button enabled for a strong password');
  await page.click('#setupSubmit');
  await page.waitForSelector('#app[data-phase="main"]', { timeout: 30000 });
  await page.waitForSelector('#gate:not(.on)', { state: 'attached' });
  await page.waitForTimeout(900);
  await shot('empty');

  step('new login with generated password + TOTP secret');
  await page.click('#plusBtn');
  await page.click('#newLogin');
  await page.fill('#edTitle', 'example.com');
  await page.fill('#edUrl', 'https://example.com/login');
  await page.fill('#edUser', 'alice@example.com');
  await page.click('.field .ibtn[title="パスワード生成"]');
  await page.waitForSelector('#genSheet.open');
  assert.equal(await page.locator('#genApply').textContent(), 'パスワードに使う');
  await page.waitForTimeout(600);
  await page.click('#genApply');
  const pw = await page.inputValue('#edPw');
  assert.ok(pw.length >= 8, 'generated password applied to the editor');
  await page.fill('#edTotp', 'JBSWY3DPEHPK3PXP');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ed-totp .totp-code');
  await page.click('.ed-foot .btn-primary');
  await page.waitForSelector('#editor[hidden]', { state: 'attached' });
  assert.match(await toastText(), /example\.com を追加しました/);
  await page.waitForTimeout(700);
  assert.match(await page.locator('.detail .totp-code').textContent(), /^\d{3} \d{3}$/);
  assert.equal(await page.locator('.detail .ticks span').count(), 30, '30-tick TOTP bar');
  assert.equal(await page.locator('.row .tag').textContent(), '2FA', '2FA tag on the row');
  await shot('detail');

  step('favourite persists');
  await page.click('.d-head .fav');
  await page.waitForTimeout(400);
  const fav = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items[0].fav);
  assert.equal(fav, true);

  step('weak password → 強化する');
  await page.click('.d-head .ibtn[title="編集"]');
  await page.fill('#edPw', 'abc12345');
  await page.click('.ed-foot .btn-primary');
  await page.waitForSelector('.weak');
  assert.equal(await page.locator('.row-weak').count(), 1, 'weak dot in the list');
  assert.equal(await page.locator('.weak-text').textContent(), '短く推測されやすいパスワードです。');
  await page.click('.weak .btn-fix');
  await page.waitForSelector('#genSheet.open');
  assert.equal(await page.locator('#genApply').textContent(), 'このパスワードに更新');
  assert.match(await page.locator('#genCmd').textContent(), /^akari gen (--length \d+|--words \d+ --dict ja-romaji)/);
  await page.waitForTimeout(600);
  await page.click('#genApply');
  await page.waitForTimeout(900);
  assert.match(await toastText(), /example\.com のパスワードを更新しました/);
  assert.match(await page.locator('#toastSub').textContent(), /^強度: .+ · \d+ bit$/);
  await page.waitForTimeout(500);
  await shot('updated');
  assert.equal(await page.locator('.weak').count(), 0);

  step('copy schedules clipboard clear');
  await page.click('.pw-btns .ibtn:nth-child(2)');
  await page.waitForTimeout(300);
  assert.equal(await toastText(), 'パスワードをコピーしました');
  assert.equal(await page.locator('#toastSub').textContent(), '30秒後にクリップボードから自動で消去します');

  step('lock → wrong password → unlock');
  await page.click('#lockBtn');
  await page.waitForSelector('#gate.on[data-mode="lock"]');
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.row').count(), 0, 'list cleared on lock');
  await page.fill('#lockInput', 'not the password');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#lockStatus.err', { timeout: 30000 });
  assert.equal(await page.locator('#lockStatus').textContent(), 'パスワードが違います');
  await page.fill('#lockInput', MASTER);
  await page.keyboard.press('Enter');
  // the boot log follows the real steps: derive (vault/unlock) → decrypt (vault/getAll) → items
  await page.waitForSelector('.boot-line[data-state="ok"]:has-text("アイテムを読込")', { timeout: 30000 });
  assert.deepEqual(await page.locator('.boot-line .boot-k').allTextContents(), ['鍵を導出', '保管庫を復号', 'アイテムを読込']);
  assert.match(await page.locator('.boot-line').first().locator('.boot-v').textContent(), /^PBKDF2-SHA256 600k · \d+\.\d\ds$/);
  assert.equal(await page.locator('.boot-line').nth(2).locator('.boot-v').textContent(), '1 件');
  await page.waitForSelector('#app[data-phase="main"]', { timeout: 30000 });
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.row').count(), 1);

  step('settings: clipboard clearing + export (no theme choice)');
  await page.click('#vaultBtn');
  await page.click('#openSettings');
  await page.waitForSelector('#setSheet.open');
  assert.equal(await page.locator('[data-setting="theme"]').count(), 0, 'theme choice removed');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
  await page.click('[data-setting="clipboardClearSeconds"] [data-value="60"]');
  await page.waitForTimeout(400);
  const getSettings = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'settings/get' })).data);
  assert.equal((await getSettings()).clipboardClearSeconds, 60);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
  assert.match(download.suggestedFilename(), /^akari-backup-\d{8}\.json$/);
  await page.waitForTimeout(500);
  await shot('settings');
  await page.click('[data-setting="clipboardClearSeconds"] [data-value="30"]');
  await page.waitForTimeout(300);
  assert.equal((await getSettings()).clipboardClearSeconds, 30);

  step('reopen popup restores unlocked state');
  await page.reload();
  await page.waitForSelector('#app[data-phase="main"]', { timeout: 15000 });
  assert.equal(await page.locator('.row').count(), 1);

  const getAll = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items);
  const sendMsg = (type, payload) => page.evaluate(([t, p]) => chrome.runtime.sendMessage({ ...p, type: t }), [type, payload]);

  step('host:port URLs are accepted and saved as https');
  for (const [input, expected] of [['localhost:3000', 'https://localhost:3000'], ['example.com:8443/login', 'https://example.com:8443/login']]) {
    await page.click('#plusBtn');
    await page.click('#newLogin');
    await page.fill('#edUrl', input);
    await page.fill('#edUser', 'port-user');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const saved = (await getAll()).find((i) => i.url === expected);
    assert.ok(saved, `saved ${input} as ${expected}`);
    assert.equal(saved.title, new URL(expected).hostname, 'title derived from the host');
  }

  step('autofill fills exactly the account the card shows (vault filter 個人)');
  fx = await serveStatic(join(ROOT, 'tests', 'fixtures', 'login'));
  {
    const loginUrl = fx.origin + '/login.html';
    const site = await ext.context.newPage();
    await site.goto(loginUrl);
    // 個人 first, then 仕事: the SW lists the newer (仕事) match first, which the old code filled
    const home = (await sendMsg('vault/saveItem', { item: { type: 'login', vault: 'personal', title: 'fixture', url: loginUrl, username: 'bob-home', password: 'Home-Pass-456!x' } })).data.item;
    await sendMsg('vault/saveItem', { item: { type: 'login', vault: 'work', title: 'fixture', url: loginUrl, username: 'alice-work', password: 'Work-Pass-123!x' } });
    const tab = await ext.sw.evaluate(async (u) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url === u);
      return { id: t.id, url: t.url };
    }, loginUrl);
    // the popup was opened as a tab, so point its "active tab" at the fixture and record fills
    await page.addInitScript((t) => {
      chrome.tabs.query = async () => [{ ...t, active: true }];
      window.close = () => { window.__closed = true; };
      const sm = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...rest) => {
        if (m?.type === 'autofill/fill') (window.__fills ||= []).push(m.itemId);
        return sm(m, ...rest);
      };
    }, tab);
    await page.bringToFront();
    await page.reload();
    await page.waitForSelector('#app[data-phase="main"]', { timeout: 15000 });
    await page.click('#vaultBtn');
    await page.click('#vaultItems .menu-item:has-text("個人")');
    await page.waitForSelector('.af-btn');
    assert.equal(await page.locator('.af-user').textContent(), 'bob-home', 'card shows the 個人 account');
    await page.click('.af-btn');
    await page.waitForSelector('.af-btn[data-state="done"]', { timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => window.__fills), [home.id], 'popup sent the card\'s item');
    assert.equal(await site.inputValue('#username'), 'bob-home', 'the page got the 個人 account');
    await page.waitForTimeout(300);
    await shot('autofill');
    await page.waitForFunction(() => window.__closed === true, null, { timeout: 2000 }); // ~700 ms after "done"
    await site.close();
  }

  step('a lock from elsewhere reaches the popup at once (storage.onChanged, not the 10 s poll)');
  // a second extension page stands in for the SW's auto-lock alarm
  const other = await ext.context.newPage();
  await other.goto(ext.url('src/popup/popup.html'));
  await other.waitForSelector('#app[data-phase="main"]', { timeout: 15000 });
  await page.bringToFront();
  const t0 = Date.now();
  await withTimeout(other.evaluate(() => chrome.runtime.sendMessage({ type: 'vault/lock' })), 8000, 'vault/lock');
  await page.waitForSelector('#gate.on[data-mode="lock"]', { timeout: 3000 });
  const latency = Date.now() - t0;
  assert.equal(await page.locator('.row').count(), 0, 'list wiped');
  assert.equal(await page.locator('#genChars span').count(), 0, 'generator wiped');
  assert.equal(await page.locator('#toastMsg').textContent(), '', 'toast text wiped');
  console.log(`   (lock noticed after ${latency} ms)`);

  console.log('\nall steps passed:', steps.length);
} catch (e) {
  console.error('FAILED at step:', steps.at(-1));
  console.error(e);
  process.exitCode = 1;
} finally {
  if (errors.length) {
    console.log('errors:');
    for (const e of errors) console.log('  ' + e);
  }
  await withTimeout(ext.close(), 20000, 'browser close').catch((e) => console.log(e.message));
  // after the browser is gone no keep-alive connection holds the fixture server open
  if (fx) await withTimeout(fx.close(), 10000, 'fixture server close').catch((e) => console.log(e.message));
}
