// Drives the real popup page against the real service worker (unpacked extension in Chrome).
// setup → add login (generator + TOTP) → weak password → 強化する → a credit card (＋ menu, reveal / copy,
// edit + extra field, 種類 filter, delete) → lock/unlock (boot log) → settings/export
// → import a Chrome CSV (インポート) → export CSV with the master password (エクスポート) → autofill → remote lock.
// Screenshots go to tests/ui/screenshots/ext-*.png. Usage: node tests/ui/extension-smoke.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, MASTER, ROOT, serveStatic } from '../e2e/helpers.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
const ext = await launch();
const errors = [...ext.errors];
let fx = null;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
const steps = [];
const step = (name) => { steps.push(name); console.log('…', name); };

try {
  let page = await ext.context.newPage(); // replaced by a fresh popup in the 「しない」 restart step
  await page.setViewportSize({ width: 680, height: 480 });
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

  step('weak password → 強化する: held until the site is changed, then confirmed; the old one is kept');
  await page.click('.d-head .ibtn[title="編集"]');
  await page.fill('#edPw', 'abc12345');
  await page.click('.ed-foot .btn-primary');
  await page.waitForSelector('.weak');
  assert.equal(await page.locator('.row-weak').count(), 1, 'weak dot in the list');
  assert.equal(await page.locator('.weak-text').textContent(), '短く推測されやすいパスワードです。');
  await page.click('.weak .btn-fix');
  await page.waitForSelector('#genSheet.open');
  assert.equal(await page.locator('#genApply').textContent(), 'サイトで変更する');
  assert.ok(await page.locator('#genSite').isVisible(), 'the sheet says the site is not changed by Akari');
  assert.match(await page.locator('#genCmd').textContent(), /^akari gen (--length \d+|--words \d+ --dict ja-romaji)/);
  await page.waitForTimeout(600);
  {
    // The login's saved URL opens in a new tab (answered locally: no network in tests).
    await ext.context.route('https://example.com/login', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>login</title>' }));
    const opened = ext.context.waitForEvent('page');
    await page.click('#genApply');
    const sitePage = await opened;
    await sitePage.waitForLoadState('domcontentloaded');
    assert.equal(sitePage.url(), 'https://example.com/login', 'the saved URL opens');
    await sitePage.close();
    await page.bringToFront();
    await page.waitForSelector('.pend');
    let it = (await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items))
      .find((i) => i.password === 'abc12345');
    assert.ok(it, 'the current password stays until the change is confirmed');
    const next = it.pendingPassword?.password;
    assert.ok(next && next !== 'abc12345', 'the new password is held');
    await page.click('.pend .btn-mini.primary'); // 確定する
    await page.waitForSelector('.pend', { state: 'detached' });
    await page.waitForTimeout(900);
    assert.match(await toastText(), /example\.com のパスワードを更新しました/);
    assert.match(await page.locator('#toastSub').textContent(), /^強度: .+ · \d+ bit$/);
    it = (await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items)).find((i) => i.id === it.id);
    assert.equal(it.password, next);
    assert.equal(it.pendingPassword, undefined);
    assert.equal(it.passwordHistory[0].password, 'abc12345', 'the replaced password is in the history');
    assert.equal(await page.locator('.sect-btn:has-text("以前のパスワード")').count(), 1);
  }
  await page.waitForTimeout(500);
  await shot('updated');
  assert.equal(await page.locator('.weak').count(), 0);

  step('copy schedules clipboard clear');
  await page.click('.pw-btns .ibtn:nth-child(2)');
  await page.waitForTimeout(300);
  assert.equal(await toastText(), 'パスワードをコピーしました');
  assert.equal(await page.locator('#toastSub').textContent(), '30秒後にクリップボードから自動で消去します');

  step('credit card: create via ＋, reveal + copy the number, edit, filter by 種類, delete');
  {
    const items = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items);
    await page.click('#plusBtn');
    await page.click('#plusMenu [data-type="card"]');
    await page.waitForSelector('.ed-form[data-type="card"]');
    assert.equal(await page.locator('.ed-heading').textContent(), '新規クレジットカード');
    await page.fill('#edTitle', 'テスト JCB');
    await page.fill('#edF-cardholder', 'TARO YAMADA');
    await page.fill('#edF-number', '3530 1113 3330 0000');
    assert.equal(await page.locator('.ed-brand').textContent(), 'JCB', 'brand while typing');
    await page.fill('#edF-expiry', '09/29');
    await page.fill('#edF-cvv', '123');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.match(await toastText(), /テスト JCB を追加しました/);
    let card = (await items()).find((i) => i.type === 'card');
    assert.ok(card, 'the service worker stored the card');
    assert.equal(card.title, 'テスト JCB');
    assert.equal(card.fields.number.replace(/\s/g, ''), '3530111333300000');
    assert.equal(card.fields.expiry, '2029-09', 'MM/YY stored as YYYY-MM');
    assert.equal(card.fields.cvv, '123');
    assert.equal(card.url, undefined, 'no login keys on a card');
    const sel = page.locator('.row[aria-selected="true"]');
    assert.equal(await sel.locator('.tag').textContent(), 'CARD');
    assert.equal(await sel.locator('.row-user').textContent(), 'JCB · •••• 0000 · 09/29');
    assert.equal(await page.locator('.cardline .cl-brand').textContent(), 'JCB');
    assert.equal(await page.locator('.card-num').textContent(), '•••• •••• •••• 0000');
    await page.click('.f-row:has(.card-num) .ibtn[aria-pressed]');
    await page.waitForFunction(() => document.querySelector('.card-num')?.textContent === '3530 1113 3330 0000');
    await page.click('.f-row:has(.card-num) .ibtn[title="コピー"]');
    await page.waitForTimeout(300);
    assert.equal(await toastText(), 'カード番号をコピーしました');
    assert.equal(await page.locator('#toastSub').textContent(), '30秒後にクリップボードから自動で消去します');
    await shot('card');

    // edit: a new expiry and an extra field
    await page.click('.d-head .ibtn[title="編集"]');
    assert.equal(await page.inputValue('#edF-expiry'), '09/2029', 'months are edited as MM/YYYY');
    await page.fill('#edF-expiry', '2030-01');
    await page.click('.ex-head .btn-line');
    await page.fill('.ex-row .ex-label', 'カード会社 電話');
    await page.fill('.ex-row .ex-value', '0120-000-000');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.match(await toastText(), /テスト JCB を保存しました/);
    card = (await items()).find((i) => i.type === 'card');
    assert.equal(card.fields.expiry, '2030-01');
    assert.equal(card.fields.number.replace(/\s/g, ''), '3530111333300000', 'number kept');
    assert.deepEqual(card.extra, [{ label: 'カード会社 電話', value: '0120-000-000', secret: false }]);
    assert.equal(await page.locator('.f-row:has-text("カード会社 電話") .f-value').textContent(), '0120-000-000');

    // 種類 filter
    assert.equal(await page.locator('.row').count(), 2);
    await page.click('#typeBtn');
    await page.waitForSelector('#typeMenu.open');
    assert.equal(await page.locator('#typeMenu .tp-cell[data-type="card"] .v-count').textContent(), '1');
    await page.click('#typeMenu .tp-cell[data-type="card"]');
    assert.equal(await page.locator('.row').count(), 1, 'only the card');
    assert.equal(await page.locator('#typeLabel').textContent(), 'クレジットカード');
    await page.click('#typeBtn');
    await page.click('#typeMenu .tp-cell[data-type="all"]');
    assert.equal(await page.locator('.row').count(), 2);

    // delete
    await page.click(`.row[data-id="${card.id}"]`);
    await page.click('.d-head .ibtn[title="編集"]');
    await page.click('.ed-foot .btn-text.danger');
    await page.click('.ed-confirm .btn-mini.danger');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.match(await toastText(), /テスト JCB を削除しました/);
    assert.equal((await items()).filter((i) => i.type === 'card').length, 0, 'card deleted in the service worker');
    assert.equal(await page.locator('.row').count(), 1);
  }

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

  step('settings: clipboard clearing + backup export (no theme choice)');
  await page.click('#vaultBtn');
  await page.click('#openSettings');
  await page.waitForSelector('#setSheet.open');
  assert.equal(await page.locator('[data-setting="theme"]').count(), 0, 'theme choice removed');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
  await page.click('[data-setting="clipboardClearSeconds"] [data-value="60"]');
  await page.waitForTimeout(400);
  const getSettings = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'settings/get' })).data);
  assert.equal((await getSettings()).clipboardClearSeconds, 60);
  await page.waitForTimeout(500);
  await shot('settings');
  await page.click('[data-setting="clipboardClearSeconds"] [data-value="30"]');
  await page.waitForTimeout(300);
  assert.equal((await getSettings()).clipboardClearSeconds, 30);
  await page.click('#exportOpen');
  await page.waitForSelector('.fmt[data-fmt="akari"][aria-checked="true"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportPage .btn-primary')]);
  assert.match(download.suggestedFilename(), /^akari-backup-\d{8}\.json$/);
  assert.equal(JSON.parse(await readFile(await download.path(), 'utf8')).format, 'akari-backup');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#setSheet:not(.open)', { state: 'attached' });

  step('reopen popup restores unlocked state');
  await page.reload();
  await page.waitForSelector('#app[data-phase="main"]', { timeout: 15000 });
  assert.equal(await page.locator('.row').count(), 1);

  const getAll = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items);
  const sendMsg = (type, payload) => page.evaluate(([t, p]) => chrome.runtime.sendMessage({ ...p, type: t }), [type, payload]);

  step('import a Chrome CSV through settings → インポート');
  {
    const csv = [
      'name,url,username,password,note',
      'import-alpha.test,https://import-alpha.test/login,alpha@example.com,Alpha-Pass-1!x,first note',
      ',https://import-beta.test/,beta@example.com,Beta-Pass-2!x,',
    ].join('\n') + '\n';
    await page.click('#vaultBtn');
    await page.click('#openSettings');
    await page.waitForSelector('#setSheet.open');
    await page.click('#importOpen');
    await page.waitForSelector('.src[data-id="chrome"]');
    assert.equal(await page.locator('.src').count(), 20, '19 sources + Akari backup');
    await page.click('.src[data-id="chrome"]');
    const file = { name: 'Chrome Passwords.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) };
    await page.setInputFiles('#impFile', file);
    await page.waitForSelector('.io-stats', { timeout: 15000 });
    assert.deepEqual(await page.locator('.io-stats .stat-v').allTextContents(), ['2', '0', '0', '0', '0'], 'preview counts');
    assert.deepEqual(await page.locator('.io-title').allTextContents(), ['import-alpha.test', 'import-beta.test'], 'sample titles');
    await page.click('.vault-chip:has-text("仕事")');
    await page.click('.io-foot .btn-primary');
    await page.waitForSelector('.io-result', { timeout: 15000 });
    assert.equal(await page.locator('.io-result .boot-k').textContent(), '2 件を追加 · 重複 0 · 無効 0');
    assert.match(await page.locator('.io-alert').textContent(), /Chrome Passwords\.csv」は削除してください/);
    await page.waitForTimeout(400);
    await shot('import-result');
    // the same file again: everything is a duplicate
    await page.click('.io-foot .btn-line'); // 続けて読み込む
    await page.click('.src[data-id="chrome"]');
    await page.setInputFiles('#impFile', file);
    await page.waitForSelector('.io-stats', { timeout: 15000 });
    await page.click('.io-foot .btn-primary');
    await page.waitForSelector('.io-result', { timeout: 15000 });
    assert.equal(await page.locator('.io-result .boot-k').textContent(), '0 件を追加 · 重複 2 · 無効 0');
    await page.click('.io-foot .btn-primary'); // 閉じる
    await page.waitForSelector('#setSheet:not(.open)', { state: 'attached' });
    assert.equal(await page.locator('#importPage').innerHTML(), '', 'parsed items dropped with the sheet');
    await page.waitForSelector('.row[data-id] .row-title:has-text("import-alpha.test")');
    const alpha = (await getAll()).find((i) => i.title === 'import-alpha.test');
    assert.ok(alpha, 'imported item is in the vault');
    assert.equal(alpha.vault, 'work');
    assert.equal(alpha.username, 'alpha@example.com');
    assert.equal(alpha.password, 'Alpha-Pass-1!x');
    assert.equal(alpha.note, 'first note');
    assert.equal(await page.locator('.row').count(), 3, 'list reloaded');
  }

  step('export CSV with the master password');
  {
    await page.click('#vaultBtn');
    await page.click('#openSettings');
    await page.waitForSelector('#setSheet.open');
    await page.click('#exportOpen');
    await page.click('.fmt[data-fmt="csv"]');
    assert.match(await page.locator('#exportPage .io-alert').textContent(), /暗号化されません/);
    await page.fill('#expMaster', 'not the password');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#exportPage .field-err:has-text("マスターパスワードが違います")', { timeout: 30000 });
    await page.fill('#expMaster', MASTER);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.keyboard.press('Enter')]);
    assert.match(dl.suggestedFilename(), /^akari-export-\d{8}\.csv$/);
    const text = await readFile(await dl.path(), 'utf8');
    assert.match(text, /^name,url,username,password,note,totp,vault,favorite\r?\n/);
    assert.match(text, /import-alpha\.test,https:\/\/import-alpha\.test\/login,alpha@example\.com,Alpha-Pass-1!x,first note/);
    assert.match(await page.locator('#exportPage .io-log .boot-v').textContent(), /akari-export-\d{8}\.csv · 3 件/);
    assert.equal(await page.inputValue('#expMaster'), '', 'master password cleared after the download');
    await page.waitForTimeout(300);
    await shot('export-csv');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#setSheet:not(.open)', { state: 'attached' });
  }

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

  step('vaults: add, rename, then delete moving its item back (settings → 保管庫)');
  {
    const vaults = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.vaults);
    await page.click('#vaultBtn');
    await page.click('#manageVaults');
    await page.waitForSelector('#vaultsPage:not([hidden]) .vm-row');
    await page.click('#vmAdd');
    await page.fill('#vmName', 'テスト用');
    await page.click('.vm-hue[data-hue="200"]');
    await page.click('#vmSubmit');
    await page.waitForSelector('#vaultsPage .vm-row:has-text("テスト用")');
    const made = (await vaults()).find((v) => v.name === 'テスト用');
    assert.equal(made?.hue, 200, 'created with the chosen colour');
    await page.click('#vaultsPage .vm-row:has-text("テスト用") [data-act="edit"]');
    await page.fill('#vmName', 'テスト用2');
    await page.click('#vmSubmit');
    await page.waitForSelector('#vaultsPage .vm-row:has-text("テスト用2")');
    assert.equal((await vaults()).find((v) => v.id === made.id)?.name, 'テスト用2', 'renamed in the vault');

    // An item lands in it behind this page's back (another popup, an import): the page still
    // shows it empty, so its delete must be refused instead of taking the item along.
    const item = (await getAll()).find((i) => i.url === 'https://localhost:3000');
    assert.equal((await sendMsg('vault/saveItem', { item: { id: item.id, vault: made.id } })).ok, true);
    await page.click('#vaultsPage .vm-row:has-text("テスト用2") [data-act="delete"]');
    assert.match(await page.locator('.vm-confirm').textContent(), /空の保管庫/, 'this page still thinks it is empty');
    await page.click('#vmDelete');
    await page.waitForSelector('.vm-confirm .vault-chip:has-text("個人に移す")');
    assert.match(await page.locator('#vmErr').textContent(), /中身が変わりました/, 'refused, then asked again with the real count');
    assert.equal((await getAll()).find((i) => i.id === item.id)?.vault, made.id, 'the item is still there');
    await page.click('.vm-confirm .vault-chip:has-text("個人に移す")');
    await page.click('#vmDelete');
    await page.waitForFunction((id) => !document.querySelector(`#vaultsPage .vm-row[data-vault="${id}"]`), made.id);
    assert.equal((await vaults()).some((v) => v.id === made.id), false, 'vault gone');
    assert.equal((await getAll()).find((i) => i.id === item.id)?.vault, 'personal', 'its item moved to 個人');
    await shot('vaults');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#setSheet:not(.open)', { state: 'attached' });
  }

  step('select several items and delete them in one go (選択 → Ctrl+A → del)');
  {
    for (const n of [1, 2, 3]) {
      assert.equal((await sendMsg('vault/saveItem', { item: { type: 'note', title: `まとめて削除 ${n}`, note: 'x' } })).ok, true);
    }
    const keep = (await getAll()).length - 3;
    await page.reload(); // the popup reads the vault again, the three notes included
    await page.waitForSelector('#app[data-phase="main"] .row');
    await page.fill('#search', 'まとめて削除');
    await page.waitForFunction(() => document.querySelectorAll('.row').length === 3);
    await page.locator('#list').focus();
    await page.keyboard.press('Control+a');
    await page.waitForSelector('#app[data-picking]');
    assert.equal(await page.locator('.pick-n').textContent(), '3');
    await page.keyboard.press('Delete');
    await page.click('.pick-confirm .btn-mini.danger');
    await page.waitForFunction(() => !document.getElementById('app').hasAttribute('data-picking'));
    const left = await getAll();
    assert.equal(left.length, keep, 'exactly the three are gone from the vault');
    assert.ok(!left.some((i) => i.title.startsWith('まとめて削除')));
    await shot('pick-deleted');
    await page.fill('#search', '');
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

  step('自動ロック「しない」: opens again after a (simulated) browser restart; a lock by hand drops the kept key');
  {
    await page.fill('#lockInput', MASTER);
    await page.press('#lockInput', 'Enter');
    await page.waitForSelector('#app[data-phase="main"]', { timeout: 30000 });
    await page.waitForSelector('#gate:not(.on)', { state: 'attached' });
    await page.click('#vaultBtn');
    await page.click('#openSettings');
    await page.waitForSelector('#setSheet.open');
    await page.click('[data-setting="autoLockMinutes"] [data-value="-1"]');
    await page.fill('#neverPw', MASTER);
    await page.click('#neverSubmit');
    await page.waitForSelector('#neverForm[hidden]', { state: 'attached' });
    await shot('settings-never');
    // A browser restart in miniature: storage.session emptied, the service worker stopped (its
    // memory goes with it), then a fresh popup. (chrome.runtime.reload would unload a CDP-loaded extension.)
    const cdp = await ext.context.newCDPSession(other);
    const restart = async () => {
      await page.close();
      await other.evaluate(() => chrome.storage.session.clear());
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await new Promise((r) => setTimeout(r, 500));
      page = await ext.context.newPage();
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      await page.setViewportSize({ width: 680, height: 480 });
      await page.goto(ext.url('src/popup/popup.html'));
    };
    await restart();
    await page.waitForSelector('#app[data-phase="main"]', { timeout: 15000 });
    assert.equal(await page.locator('#gate.on').count(), 0, 'no master password after the restart');
    await page.waitForSelector('.row');
    await page.click('#lockBtn');
    await page.waitForSelector('#gate.on[data-mode="lock"]');
    await restart();
    await page.waitForSelector('#gate.on[data-mode="lock"]', { timeout: 15000 });
    assert.match(await page.locator('#lockStatus').textContent(), /自動ではロックしません/, 'the lock screen says so');
  }

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
