import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { launchBrowser } from '../../tools/browser.mjs';
import { startServer } from '../../tools/serve.mjs';
import { encryptPgp, decryptPgp } from '../../extension/src/lib/pgp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const CHROME_CSV = [
  'name,url,username,password,note',
  'github.com,https://github.com/login,haruka.dev@example.com,v8#Lq2!mTz9@rWk4pE,',
  'booking.com,https://www.booking.com/,haruka.sato@example.com,Tabi!Kyoto#2026,',
  'linear.app,https://linear.app/login,haruka@studio-mori.jp,L1near-Issue-Board,',
  'note.com,https://note.com/login,haruka_mori,Kaku-Yomu-77!,',
  'zoom.us,https://zoom.us/signin,haruka@studio-mori.jp,Zm!Meet-0420,',
  'freee.co.jp,https://accounts.secure.freee.co.jp/,admin@studio-mori.jp,Fr33-Kaikei#2025,経理用',
].join('\r\n') + '\r\n';
const BW_PROTECTED = JSON.stringify({
  encrypted: true, passwordProtected: true, salt: 'c2FsdA==', kdfType: 0, kdfIterations: 600000,
  encKeyValidation_DO_NOT_EDIT: '2.abc|def|ghi', data: '2.abc|def|ghi',
});

async function openSheetPage(page, opener) {
  await page.click('#menuBtn');
  await page.click('#openSettings');
  await page.waitForSelector('#setSheet.open');
  await page.waitForTimeout(500);
  await page.click(opener);
}
const OUT = join(HERE, 'screenshots');
const NEW_TAB = 'chrome://newtab/';
const MOCK = join(HERE, 'mock-chrome.js');
const only = process.argv[2] || '';

await mkdir(OUT, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const errors = [];

async function open(cfg = {}, { reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 680, height: 480 }, deviceScaleFactor: 1, reducedMotion });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${cfg.name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${cfg.name}] pageerror: ${e.message}`));
  await page.addInitScript(`window.__AKARI_MOCK__=${JSON.stringify({ delay: 1, ...cfg })};`);
  await page.addInitScript({ path: MOCK });
  await page.goto(`${base}/extension/src/popup/popup.html`);
  await page.evaluate(() => document.fonts.ready);
  return { page, ctx };
}

const shot = (page, name) => page.screenshot({ path: join(OUT, `popup-${name}.png`) });
const settle = (page, ms = 1100) => page.waitForTimeout(ms);
const quiet = async (page) => {
  await page.mouse.move(2, 2);
  await page.waitForSelector('#toast:not(.on)', { state: 'attached', timeout: 9000 });
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
async function addExtra(page, key, label, value) {
  await page.click('.xf-slot');
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
  if (label) await page.keyboard.type(label);
  await page.locator('.xf-row .xf-value').last().fill(value);
}
async function view(page, id) {
  await page.click('#typeBtn');
  await page.waitForSelector('#typeMenu.open');
  await page.click(`#typeMenu .tp-cell[data-type="${id}"]`);
  await page.waitForSelector('#typeMenu:not(.open)', { state: 'attached' });
}

const scenarios = {
  async main() {
    const { page, ctx } = await open({ name: 'main' });
    await page.waitForSelector('.row');
    await settle(page);
    await shot(page, 'main');
    expect(await page.locator('#viewCount').textContent() === '32', 'filter count');
    expect(await page.locator('.row[aria-selected="true"] .tag').textContent() === '2FA', '2FA tag on github');
    expect(await page.locator('#vaultLabel').textContent() === 'すべて', 'vault label');
    expect(await page.locator('.ticks span').count() === 30, '30 TOTP ticks');
    expect(await page.locator('.pw-col .segs span').count() === 12, '12 meter segments');
    await page.click('.pw-btns .ibtn');
    await settle(page, 700);
    await shot(page, 'revealed');
    await page.click('.pw-btns .ibtn:nth-child(2)');
    await settle(page, 500);
    await shot(page, 'copied');
    await ctx.close();
  },
  async weak() {
    const { page, ctx } = await open({ name: 'weak', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await page.click('[data-id="amazon"]');
    await settle(page, 900);
    await shot(page, 'weak');
    expect(await page.locator('.weak-text').textContent() === '短く推測されやすいパスワードです。', 'weak warning text');
    await page.click('.weak .btn-fix');
    await settle(page, 1100);
    await shot(page, 'generator');
    expect(/^akari gen --length \d+ --upper --digits --symbols$/.test(await page.locator('#genCmd').textContent()), 'CLI line');
    await page.click('#modePhrase');
    await settle(page, 700);
    await shot(page, 'generator-phrase');
    expect(/--words \d+ --dict ja-romaji/.test(await page.locator('#genCmd').textContent()), 'phrase CLI line');
    await page.click('#modeRandom');
    await settle(page, 700);
    expect(await page.locator('#genSite').isVisible(), 'warns that the site is not changed');
    expect(await page.locator('#genApply').textContent() === 'サイトで変更する', 'primary is the site change');
    expect(await page.locator('#genAkariOnly').isVisible(), 'Akari だけ更新 offered');
    await shot(page, 'generator-site');
    const opened = [];
    page.on('console', (m) => { const r = /\[mock\] tabs\.create (\S+)/.exec(m.text()); if (r) opened.push(r[1]); });
    const stored = () => page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'vault/getAll' })).data.items.find((i) => i.id === 'amazon'));
    const generated = await page.evaluate(() => document.getElementById('genChars').getAttribute('aria-label') && document.getElementById('genChars').textContent);
    await page.click('#genApply');
    await page.waitForSelector('.pend');
    await settle(page, 900);
    await shot(page, 'pending');
    let amazon = await stored();
    expect(amazon.password === 'amz2024', 'the current password stays until the change is confirmed');
    expect(amazon.pendingPassword?.password === generated, 'the new one is held');
    expect(JSON.stringify(opened) === JSON.stringify(['https://amazon.co.jp/']), 'the saved URL opens: ' + opened.join());
    expect(!(await page.locator('.weak').count()), 'the banner replaces the warning');

    await quiet(page);
    await page.click('.pend .btn-mini.primary');
    await page.waitForSelector('.pend', { state: 'detached' });
    await settle(page, 1400);
    await shot(page, 'updated');
    amazon = await stored();
    expect(amazon.password === generated && !amazon.pendingPassword, 'confirmed');
    expect(amazon.passwordHistory.map((h) => h.password).join() === 'amz2024,amazon2016,Hanako-0214', 'old password first in the history');

    await quiet(page);
    await page.locator('.sect-btn').scrollIntoViewIfNeeded();
    await page.click('.sect-btn');
    await page.locator('.hist-row').first().locator('.ibtn').first().click();
    expect(await page.locator('.hist-row').first().locator('.hist-pw').textContent() === 'amz2024', 'revealed');
    await settle(page, 400);
    await shot(page, 'history');
    await page.locator('.hist-row').first().locator('.btn-mini').click();
    await page.waitForSelector('#toast.on');
    amazon = await stored();
    expect(amazon.password === 'amz2024' && amazon.passwordHistory[0].password === generated, 'restored, the replaced one kept');

    await quiet(page);
    await page.click('.weak .btn-fix');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 600);
    await page.click('#genApply');
    await page.waitForSelector('.pend');
    await quiet(page);
    await page.click('.pend .btn-mini:has-text("取り消す")');
    await page.waitForSelector('.pend .btn-mini.danger');
    await page.click('.pend .btn-mini.danger');
    await page.waitForSelector('.pend', { state: 'detached' });
    amazon = await stored();
    expect(amazon.password === 'amz2024' && !amazon.pendingPassword, 'discarded, current unchanged');

    await quiet(page);
    await page.click('.weak .btn-fix');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 600);
    await page.click('#genAkariOnly');
    await page.waitForSelector('#genSheet:not(.open)', { state: 'attached' });
    await settle(page, 1200);
    amazon = await stored();
    expect(amazon.password !== 'amz2024' && amazon.passwordHistory[0].password === 'amz2024', 'updated now, old kept');
    await ctx.close();
  },
  async health() {
    const { page, ctx } = await open({ name: 'health', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await page.click('#vaultBtn');
    await page.waitForSelector('#vaultMenu.open');
    expect(await page.locator('#vaultMenu #openHealth, #vaultMenu #openSettings, #vaultMenu #manageVaults').count() === 0, 'vault menu: vaults only');
    await page.keyboard.press('Escape');
    await page.click('#menuBtn');
    await page.waitForSelector('#mainMenu.open');
    await settle(page, 400);
    await shot(page, 'health-menu');
    const menuCount = Number(await page.locator('#healthCount').textContent());
    await page.click('#openHealth');
    await page.waitForSelector('#healthSheet.open');
    await settle(page, 900);
    await shot(page, 'health');
    expect(await page.locator('#typeLabel').textContent() === 'すべて', 'the list view did not change');
    expect(await page.locator('.body').evaluate((el) => el.inert), 'the main view is inert behind the screen');
    const tabCount = async (k) => parseInt(await page.locator(`#hs-tab-${k} .hs-n`).textContent(), 10);
    const rows = () => page.locator('#hsList .hs-row');
    const selected = () => page.locator('#hsList .hs-row[aria-selected="true"]').getAttribute('data-id');
    const action = await tabCount('action');
    expect(await page.locator('#hs-tab-action').getAttribute('aria-selected') === 'true', '要対応 tab first');
    expect(action > 0 && action === menuCount && action === await rows().count(), `要対応 ${action} = ≡ ${menuCount} = rows`);
    expect(await page.evaluate(() => document.activeElement?.id) === 'hsList', 'the list has the keyboard');
    const second = await rows().nth(1).getAttribute('data-id');
    await page.keyboard.press('ArrowDown');
    expect(await selected() === second, '↓ selects the next login');
    expect(await page.locator('.hs-title').textContent() === await rows().nth(1).locator('.row-title').textContent(), 'pane shows it');
    await page.click('#hsList .hs-row[data-id="amazon"]');
    await settle(page, 400);
    expect(await page.locator('.hs-issues li[data-issue="weak"]').count() === 1, 'amazon: weak listed');
    expect(await page.locator('.hs-acts .btn-fix').isVisible(), '強化する offered');
    await shot(page, 'health-detail');
    await page.focus('#hs-tab-action');
    await page.keyboard.press('ArrowRight');
    await settle(page, 300);
    expect(await page.locator('#hs-tab-weak').getAttribute('aria-selected') === 'true', '→ selects 弱い');
    expect(await rows().count() === await tabCount('weak'), '弱い rows');
    await page.click('#hs-tab-no2fa');
    await settle(page, 400);
    const no2fa = await tabCount('no2fa');
    expect(no2fa === await rows().count(), `2FA なし ${no2fa} = rows`);
    await shot(page, 'health-no2fa');
    const fixed = await rows().first().getAttribute('data-id');
    await rows().first().click();
    await page.click('.hs-acts .add-2fa');
    await page.waitForSelector('#healthSheet:not(.open)', { state: 'attached' });
    await settle(page, 700);
    expect(await page.locator('#edTotp').isVisible(), 'the editor is open on the login');
    await page.fill('#edTotp', 'JBSWY3DPEHPK3PXP');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 1300);
    await page.click('#menuBtn');
    await page.click('#openHealth');
    await page.waitForSelector('#healthSheet.open');
    await settle(page, 500);
    expect(await page.locator('#hs-tab-no2fa').getAttribute('aria-selected') === 'true', 'the tab is kept');
    expect(await tabCount('no2fa') === no2fa - 1 && await page.locator(`#hsList .hs-row[data-id="${fixed}"]`).count() === 0, 'fixed login gone from 2FA なし');
    await page.keyboard.press('Escape');
    await settle(page, 400);
    expect(await page.locator('#healthSheet.open').count() === 0, 'Esc closes');
    expect(await page.evaluate(() => document.activeElement?.id) === 'menuBtn', 'focus back on ≡');
    expect(await page.locator('#hsList .hs-row').count() === 0, 'rows dropped on close');
    await page.click('#menuBtn');
    await page.click('#openHealth');
    await page.waitForSelector('#healthSheet.open');
    await page.click('#hs-tab-weak');
    await page.click('#hsList .hs-row[data-id="amazon"]');
    await page.click('.hs-acts .btn-fix');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 600);
    expect(await page.locator('#healthSheet.open').count() === 0, 'the screen closed');
    expect(await page.locator('.list .row[aria-selected="true"]').getAttribute('data-id') === 'amazon', 'amazon open in the main view');
    expect(await page.locator('#genSite').isVisible(), 'the generator changes the site password');
    await ctx.close();
  },
  async menus() {
    const { page, ctx } = await open({ name: 'menus' });
    await page.waitForSelector('.row');
    await settle(page, 600);
    await page.click('#vaultBtn');
    await settle(page, 500);
    await shot(page, 'vaultmenu');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.id) === 'vaultBtn', 'Esc returns to the vault button');
    await page.click('#menuBtn');
    await page.waitForSelector('#mainMenu.open');
    await settle(page, 500);
    await shot(page, 'mainmenu');
    expect(await page.evaluate(() => document.activeElement?.id) === 'openHealth', 'the menu opens on its first item');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.id) === 'openTrash', '↓ moves through the menu');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.id) === 'menuBtn', 'Esc returns to ≡');
    await page.click('#plusBtn');
    await settle(page, 500);
    await shot(page, 'plusmenu');
    await page.keyboard.press('g');
    await page.waitForSelector('#genSheet.open');
    await page.keyboard.press('Escape');
    await settle(page, 500);
    await page.click('#vaultBtn');
    await page.click('#vaultItems .menu-item:has-text("仕事")');
    await settle(page, 800);
    await shot(page, 'vault-work');
    expect(await page.locator('#vaultLabel').textContent() === '仕事', 'vault label after switch');
    await ctx.close();
  },
  async search() {
    const { page, ctx } = await open({ name: 'search' });
    await page.waitForSelector('.row');
    await page.keyboard.press('/');
    await page.keyboard.type('mori');
    await settle(page, 600);
    await shot(page, 'search');
    await page.fill('#search', 'zzz');
    await settle(page, 400);
    await shot(page, 'search-empty');
    await page.keyboard.press('Escape');
    await view(page, 'fav');
    await settle(page, 800);
    await shot(page, 'fav');
    expect(await page.locator('#typeLabel').textContent() === 'お気に入り', 'chip shows the view');
    await page.click('#sortBtn');
    await view(page, 'all');
    await settle(page, 800);
    await shot(page, 'az');
    await ctx.close();
  },
  async 'detail-extra'() {
    const { page, ctx } = await open({ name: 'detail-extra', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await page.click('[data-id="google"]');
    await settle(page, 900);
    await page.evaluate(() => { document.getElementById('cardScroll').scrollTop = 400; });
    await settle(page, 200);
    await shot(page, 'passkeys');
    await page.click('.pk .ibtn');
    await settle(page, 300);
    await shot(page, 'passkey-confirm');
    await page.evaluate(() => { document.getElementById('list').scrollTop = 1000; });
    await page.click('[data-id="wifi"]');
    await settle(page, 900);
    await shot(page, 'note');
    await ctx.close();
  },
  async websites() {
    const { page, ctx } = await open({
      name: 'websites',
      tabUrl: NEW_TAB,
      seedPatch: {
        google: {
          url: 'https://myaccount.google.com/u/0/security',
          extra: [
            { label: 'URL', value: 'https://myaccount.google.com/', secret: false },
            { label: 'URL', value: 'https://accounts.google.com/', secret: false },
            { label: 'URL', value: 'https://myaccount.google.com/', secret: false },
            { label: 'URL', value: 'androidapp://com.google.android.gm', secret: false },
            { label: '管理画面', value: 'https://admin.google.com/', secret: false },
            { label: '合言葉', value: 'kumo', secret: true },
          ],
        },
      },
    });
    await page.waitForSelector('.row');
    await page.click('[data-id="google"]');
    await settle(page, 900);
    const urls = page.locator('#detail .w-row .w-url');
    expect(await urls.count() === 4, 'the login URL, two more, and the app address in one box');
    expect(await page.locator('#detail .w-row a.w-url').count() === 3, 'web addresses are links');
    expect(await page.locator('#detail .w-row .w-url.plain').textContent() === 'androidapp://com.google.android.gm', 'others stay text');
    expect(await page.locator('#detail .f-row .f-label:text-is("URL")').count() === 0, 'no separate URL rows left');
    expect(await page.locator('#detail .f-row:has(.f-label:text-is("管理画面")) a.f-link').count() === 1, 'an address in another field is a link');
    const opened = [];
    page.on('console', (m) => { const r = /\[mock\] tabs\.create (\S+)/.exec(m.text()); if (r) opened.push(r[1]); });
    for (let i = 0; i < 3; i++) await page.locator('#detail .w-row a.w-url').nth(i).click();
    await settle(page, 200);
    expect(JSON.stringify(opened) === JSON.stringify([
      'https://myaccount.google.com/u/0/security', 'https://myaccount.google.com/', 'https://accounts.google.com/',
    ]), 'each opens its own address: ' + JSON.stringify(opened));
    await shot(page, 'websites');
    await ctx.close();
  },
  async editor() {
    const { page, ctx } = await open({ name: 'editor' });
    await page.waitForSelector('.row');
    await settle(page, 600);
    await page.click('.d-head .ibtn[title="編集"]');
    await settle(page, 900);
    await shot(page, 'editor');
    await page.fill('#edTitle', '');
    await page.fill('#edUrl', 'javascript:alert(1)');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 500);
    await shot(page, 'editor-invalid');
    await page.keyboard.press('Escape');
    await settle(page, 300);
    await shot(page, 'editor-discard');
    await page.click('.ed-confirm .btn-mini.danger');
    const uri = 'otpauth://totp/Example:haruka%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';
    await page.evaluate((u) => { window.__AKARI_MOCK__.qrDataUrl = u; }, await QRCode.toDataURL(uri, { margin: 4, width: 320 }));
    await page.click('#plusBtn');
    await page.click('#newLogin');
    await settle(page, 900);
    await shot(page, 'editor-new');
    await page.fill('#edUser', 'haruka@example.com');
    await page.click('.ed-totp-tools .btn-line');
    await settle(page, 1200);
    await page.click('.field .ibtn[title="パスワード生成"]');
    await settle(page, 900);
    await shot(page, 'editor-gen');
    await page.click('#genApply');
    await settle(page, 700);
    await page.evaluate(() => { document.querySelector('.ed-scroll').scrollTop = 120; });
    await settle(page, 200);
    await shot(page, 'editor-filled');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 1300);
    await shot(page, 'editor-saved');
    await ctx.close();
  },
  async 'editor-note-delete'() {
    const { page, ctx } = await open({ name: 'editor-note-delete', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await page.evaluate(() => { document.getElementById('list').scrollTop = 1000; });
    await page.click('[data-id="wifi"]');
    await settle(page, 600);
    await page.click('.d-head .ibtn[title="編集"]');
    await settle(page, 700);
    await shot(page, 'editor-note');
    await page.click('.ed-foot .btn-text.danger');
    await settle(page, 300);
    await shot(page, 'editor-delete-confirm');
    expect(/ゴミ箱に移しますか/.test(await page.locator('.ed-foot .ed-confirm').textContent()), 'the question says where it goes');
    await ctx.close();
  },
  async trash() {
    const { page, ctx } = await open({ name: 'trash', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    const rowIds = () => page.$$eval('.row', (rows) => rows.map((r) => r.dataset.id));
    const total = (await rowIds()).length;
    const del = async (id) => {
      await page.click(`.row[data-id="${id}"]`);
      await settle(page, 500);
      await page.click('.d-head .ibtn[title="編集"]');
      await settle(page, 500);
      await page.click('.ed-foot .btn-text.danger');
      await page.click('.ed-confirm .btn-mini.danger');
      await page.waitForSelector('#toast.on #toastAct:not([hidden])');
    };
    await del('wifi');
    expect(/をゴミ箱に移しました/.test(await page.locator('#toastMsg').textContent()), 'toast says it went to the trash');
    expect(!(await rowIds()).includes('wifi'), 'gone from the list');
    await settle(page, 400);
    await shot(page, 'trash-toast');
    await page.hover('#toast');
    await page.waitForTimeout(8600);
    expect(await page.locator('#toast.on').count() === 1, 'hover holds the toast');
    await page.click('#toastAct');
    await page.waitForFunction(() => !!document.querySelector('.row[data-id="wifi"]'));
    expect((await rowIds()).length === total, '元に戻す puts it back');
    expect(/を元に戻しました/.test(await page.locator('#toastMsg').textContent()), 'and says so');
    await quiet(page);

    await del('wifi');
    await page.locator('#list').focus();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !!document.querySelector('.row[data-id="wifi"]'));
    expect(await page.evaluate(() => window.__AKARI_DB__.trash.length) === 0, 'Ctrl+Z restores');
    await quiet(page);

    await del('wifi');
    await quiet(page);
    await page.click('#menuBtn');
    await page.waitForSelector('#mainMenu.open');
    expect((await page.locator('#trashCount').textContent()) === '1', 'the menu counts the trash');
    await page.click('#openTrash');
    await page.waitForSelector('#trashSheet.open .ts-row');
    await settle(page, 500);
    await shot(page, 'trash-sheet');
    expect(/あと 30 日/.test(await page.locator('.ts-left').first().textContent()), 'days left');
    expect(await page.evaluate(() => document.activeElement?.dataset.col) === 'restore', 'focus on 元に戻す');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ts-none');
    expect((await rowIds()).includes('wifi'), 'restored from the sheet');
    await shot(page, 'trash-empty');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#trashSheet:not(.open)');
    expect(await page.evaluate(() => document.activeElement?.id) === 'menuBtn', 'Esc closes and returns to ≡');

    await del('wifi');
    await quiet(page);
    await page.click('#menuBtn');
    await page.click('#openTrash');
    await page.waitForSelector('#trashSheet.open .ts-row');
    await page.click('.ts-purge');
    await page.waitForSelector('.ts-row.asking');
    await settle(page, 300);
    await shot(page, 'trash-ask');
    await page.keyboard.press('Escape');
    expect(!(await page.locator('.ts-row.asking').count()) && (await page.locator('#trashSheet.open').count()) === 1, 'Esc only cancels the question');
    await page.click('#tsEmpty');
    await page.waitForSelector('#tsAskAll:not([hidden])');
    await page.click('#tsAskAll .btn-mini.danger');
    await page.waitForSelector('.ts-none');
    expect(await page.evaluate(() => window.__AKARI_DB__.trash.length) === 0, 'emptied');
    expect(!(await rowIds()).includes('wifi'), 'and not back in the list');
    await ctx.close();
  },
  async settings() {
    const { page, ctx } = await open({ name: 'settings' });
    await page.waitForSelector('.row');
    await page.click('#menuBtn');
    await page.click('#openSettings');
    await settle(page, 900);
    await shot(page, 'settings');
    const themeChip = (v) => page.locator(`[data-setting="theme"] [data-value="${v}"]`);
    expect(await themeChip('dark').getAttribute('aria-checked') === 'true', 'dark by default');
    expect(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'drawn dark');
    await themeChip('light').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await settle(page, 400);
    await shot(page, 'settings-light');
    expect(await page.evaluate(() => window.__AKARI_DB__.settings.theme) === 'light', 'saved');
    expect(await page.evaluate(() => localStorage.getItem('akari.theme')) === 'light', 'remembered for the next open');
    await themeChip('dark').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.click('#pwToggle');
    await page.fill('#pwNext', 'kotatsu-mikan');
    await settle(page, 500);
    await shot(page, 'settings-password');
    await page.click('#pwToggle');

    const lockChip = (v) => page.locator(`[data-setting="autoLockMinutes"] [data-value="${v}"]`);
    await lockChip(-1).click();
    expect(await page.locator('#neverForm').isVisible(), 'しない opens the confirmation');
    expect(await lockChip(-1).getAttribute('aria-checked') === 'false', 'not switched before the password');
    expect(/再起動してもひらいたまま/.test(await page.locator('#neverWarn').textContent()), 'warning shown');
    await page.click('#neverSubmit');
    expect(await page.locator('#neverErr').textContent() === 'マスターパスワードを入力してください', 'empty password');
    await page.fill('#neverPw', 'wrong');
    await page.click('#neverSubmit');
    await page.waitForFunction(() => document.getElementById('neverErr').textContent === 'マスターパスワードが違います');
    await page.fill('#neverPw', 'kotatsu-mikan-2024');
    await settle(page, 300);
    await shot(page, 'settings-never');
    await page.click('#neverSubmit');
    await page.waitForSelector('#neverForm[hidden]', { state: 'attached' });
    expect(await lockChip(-1).getAttribute('aria-checked') === 'true', 'しない selected');
    expect(await page.evaluate(() => window.__AKARI_DB__.settings.autoLockMinutes) === -1, 'saved');
    await lockChip(15).click();
    await page.waitForFunction(() => window.__AKARI_DB__.settings.autoLockMinutes === 15);
    expect(await page.locator('#neverForm').isHidden(), 'other choices need no password');
    await ctx.close();
  },
  async vaults() {
    const { page, ctx } = await open({ name: 'vaults' });
    await page.waitForSelector('.row');
    await settle(page, 400);
    const allCount = () => page.locator('#viewCount').textContent().then(Number);
    const rowCount = (name) => page.locator(`#vaultsPage .vm-row:has-text("${name}") .vm-count`).textContent().then((s) => Number(s.match(/\d+/)[0]));
    const total = await allCount();
    await page.click('#menuBtn');
    await page.click('#manageVaults');
    await page.waitForSelector('#setSheet.open #vaultsPage:not([hidden]) .vm-row');
    await settle(page, 700);
    expect(await page.locator('#vaultsPage .vm-row').count() === 3, 'the three default vaults');
    expect(await page.locator('#setTitle').textContent() === '保管庫', 'page title');
    await shot(page, 'vaults');

    await page.click('#vmAdd');
    await page.fill('#vmName', ' 仕事 ');
    await page.click('#vmSubmit');
    expect(await page.locator('#vmErr').textContent() === '同じ名前の保管庫があります', 'duplicate name refused');
    await page.fill('#vmName', '趣味');
    expect(await page.locator('#vmErr').textContent() === '', 'typing clears the error');
    await page.click('.vm-hue[data-hue="300"]');
    await settle(page, 300);
    await shot(page, 'vaults-add');
    await page.press('#vmName', 'Enter');
    await page.waitForSelector('#vaultsPage .vm-row:has-text("趣味")');
    expect(await page.locator('#vaultsPage .vm-row').count() === 4, 'created');

    await page.click('#vaultsPage .vm-row:has-text("家族") [data-act="edit"]');
    expect(await page.inputValue('#vmName') === '家族', 'edit form starts from the name');
    await page.fill('#vmName', '家族・親戚');
    await page.click('#vmSubmit');
    await page.waitForSelector('#vaultsPage .vm-row:has-text("家族・親戚")');

    const work = await rowCount('仕事');
    expect(work > 0, 'work has items');
    await page.click('#vaultsPage .vm-row:has-text("仕事") [data-act="delete"]');
    await page.click('.vm-confirm .vault-chip:has-text("趣味に移す")');
    expect(/移して削除/.test(await page.locator('#vmDelete').textContent()), 'move button label');
    await settle(page, 300);
    await shot(page, 'vaults-delete');
    await page.click('#vmDelete');
    await page.waitForFunction(() => !document.querySelector('#vaultsPage .vm-row[data-vault="work"]'));
    await settle(page, 600);
    expect(await rowCount('趣味') === work, 'items moved to 趣味');
    expect(await allCount() === total, 'nothing lost');

    const family = await rowCount('家族・親戚');
    await page.click('#vaultsPage .vm-row:has-text("家族・親戚") [data-act="delete"]');
    await page.click('.vm-confirm .vault-chip.vm-purge');
    expect(new RegExp(`${family} 件ごと削除`).test(await page.locator('#vmDelete').textContent()), 'purge button label');
    await page.click('#vmDelete');
    await page.waitForFunction(() => document.querySelectorAll('#vaultsPage .vm-row').length === 2);
    await settle(page, 600);
    expect(await allCount() === total - family, 'items deleted with the vault');
    await shot(page, 'vaults-after');

    await page.keyboard.press('Escape');
    await settle(page, 500);
    await page.click('#vaultBtn');
    const menu = await page.locator('#vaultItems').textContent();
    expect(menu.includes('趣味') && !menu.includes('仕事') && !menu.includes('家族'), 'vault menu follows');
    await ctx.close();
  },
  async import() {
    const { page, ctx } = await open({ name: 'import', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#importOpen');
    await page.waitForSelector('.src');
    await settle(page, 700);
    await shot(page, 'import-sources');
    expect(await page.locator('.src').count() === 20, '19 sources + Akari backup');
    expect(await page.locator('#setTrail li.cur').textContent() === '読み込み元', 'trail on step 1');
    expect((await page.locator('.io-lead').textContent()).startsWith('別のパスワードマネージャーから移行するには'), 'lead text');
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'akari', 'first source focused');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'chrome', 'arrow keys move in a 4-column grid');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'brave', 'Home + ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.drop');
    expect(await page.locator('#impFile').getAttribute('accept') === '.csv', 'file picker accepts the source extensions');
    await settle(page, 500);
    await shot(page, 'import-file');
    await page.setInputFiles('#impFile', { name: 'Chrome Passwords.csv', mimeType: 'text/csv', buffer: Buffer.from(CHROME_CSV) });
    await page.waitForSelector('.io-stats');
    await settle(page, 700);
    await shot(page, 'import-preview');
    const stats = await page.locator('.io-stats .stat-v').allTextContents();
    expect(stats.join(',') === '6,0,0,0,0', 'preview counts: ' + stats.join(','));
    expect(await page.locator('.io-title').count() === 4, 'four sample titles');
    expect(await page.locator('.io-more').textContent() === 'ほか 2 件', 'more count');
    await page.click('.vault-chip:has-text("仕事")');
    await page.click('.io-foot .btn-primary');
    await page.waitForSelector('.io-result');
    await settle(page, 600);
    await shot(page, 'import-result');
    const result = await page.locator('.io-result .boot-k').textContent();
    expect(result === '5 件を追加 · 重複 1 · 無効 0', 'result line: ' + result);
    expect(/Chrome Passwords\.csv/.test(await page.locator('.io-alert').textContent()), 'reminder names the exported file');
    await page.keyboard.press('Escape');
    await settle(page, 600);
    expect(await page.locator('#importPage').innerText() === '', 'import page wiped on close');
    expect(await page.locator('.row[data-id^="imp-"]').count() === 5, 'list reloaded with the imported items');
    await ctx.close();
  },
  async 'import-password'() {
    const { page, ctx } = await open({ name: 'import-password' });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#importOpen');
    await page.click('.src[data-id="pgp"]');
    await page.waitForSelector('.drop');
    const armored = await encryptPgp(CHROME_CSV, 'kotatsu-mikan-2026', { filename: 'chrome.csv' });
    await page.setInputFiles('#impFile', { name: 'chrome.csv.pgp', mimeType: 'application/pgp-encrypted', buffer: Buffer.from(armored) });
    await page.waitForSelector('.io-pass:not([hidden])');
    await settle(page, 600);
    await shot(page, 'import-password');
    expect(await page.locator('label[for="impPw"]').textContent() === 'パスフレーズ', 'PGP asks for a passphrase');
    await page.fill('#impPw', 'wrong-passphrase');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.io-field.err');
    await settle(page, 500);
    await shot(page, 'import-password-wrong');
    expect(await page.locator('#importPage .field-err').textContent() === 'パスフレーズが違います', 'wrong passphrase message');
    await page.fill('#impPw', 'kotatsu-mikan-2026');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.io-stats');
    expect((await page.locator('.io-cmd-text').textContent()).includes('--from chrome'), 'detected Chrome inside the PGP file');
    await page.click('#setBack');
    await page.click('#setBack');
    await page.click('.src[data-id="bitwarden"]');
    await page.setInputFiles('#impFile', { name: 'bitwarden_encrypted_export.json', mimeType: 'application/json', buffer: Buffer.from(BW_PROTECTED) });
    await page.waitForSelector('.io-pass:not([hidden])');
    expect(await page.locator('label[for="impPw"]').textContent() === 'パスワード', 'Bitwarden asks for a password');
    await page.click('#setBack');
    await page.click('.src[data-id="bitwarden"]');
    await page.setInputFiles('#impFile', { name: 'bitwarden_export.json', mimeType: 'application/json', buffer: await readFile(join(ROOT, 'tests/fixtures/import/bitwarden/export.json')) });
    await page.waitForSelector('.io-stats');
    await settle(page, 700);
    await shot(page, 'import-preview-bitwarden');
    await ctx.close();
  },
  async 'import-drop'() {
    const { page, ctx } = await open({ name: 'import-drop' });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#importOpen');
    await page.waitForSelector('.src');
    const drop = (name, text, phase) => page.evaluate(([n, t, p]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([t], n, { type: 'text/plain' }));
      const sheet = document.getElementById('setSheet');
      const target = sheet.querySelector('.src-grid, .drop') || sheet;
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      if (p === 'over') return sheet.classList.contains('dragging');
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, [name, text, phase]);
    expect(await drop('x.csv', CHROME_CSV, 'over'), 'dragover highlights the sheet');
    await settle(page, 300);
    await shot(page, 'import-drop');
    expect(await drop('passwords.csv', CHROME_CSV, 'drop'), 'drop handled (no navigation)');
    await page.waitForSelector('.io-stats');
    expect((await page.locator('.io-cmd-text').textContent()).includes('--from chrome passwords.csv'), 'detected Chrome');
    expect(!(await page.locator('#setSheet').getAttribute('class')).includes('dragging'), 'drag highlight cleared');
    await page.click('#setBack');
    await page.waitForSelector('.drop');
    expect(await drop('again.csv', CHROME_CSV, 'drop'), 'drop on the file step');
    await page.waitForSelector('.io-stats');
    expect((await page.locator('.io-cmd-text').textContent()).includes('again.csv'), 'file step took the dropped file');
    await ctx.close();
  },
  async 'import-backup'() {
    const { page, ctx } = await open({ name: 'import-backup' });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#importOpen');
    await page.click('.src[data-id="akari"]');
    await page.waitForSelector('#impPw');
    const backup = JSON.stringify({ format: 'akari-backup', version: 1, exportedAt: new Date().toISOString(), vault: {} }, null, 2);
    await page.setInputFiles('#impFile', { name: 'akari-backup-20261101.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await page.fill('#impPw', 'wrong');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.io-field.err');
    await settle(page, 500);
    await shot(page, 'import-backup');
    expect(await page.locator('#importPage .field-err').textContent() === 'バックアップのパスワードが違います', 'backup wrong password');
    await page.fill('#impPw', 'backup-pass');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.io-log .boot-k:has-text("2 件を読み込みました")');
    await ctx.close();
  },
  async export() {
    const { page, ctx } = await open({ name: 'export' });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#exportOpen');
    await page.waitForSelector('.fmt');
    await settle(page, 700);
    await shot(page, 'export-formats');
    expect(await page.evaluate(() => document.activeElement?.dataset.fmt) === 'akari', 'checked format focused');
    const [backup] = await Promise.all([page.waitForEvent('download'), page.click('#exportPage .btn-primary')]);
    expect(/^akari-backup-\d{8}\.json$/.test(backup.suggestedFilename()), 'backup download name');
    await page.focus('.fmt[data-fmt="akari"]');
    await page.keyboard.press('ArrowDown');
    expect(await page.locator('.fmt[aria-checked="true"]').getAttribute('data-fmt') === 'csv', 'arrow selects CSV');
    await settle(page, 400);
    await shot(page, 'export-plain');
    expect(/暗号化されません/.test(await page.locator('#exportPage .io-alert').textContent()), 'plain warning');
    await page.click('#exportPage .btn-primary');
    expect(await page.locator('#exportPage .field-err').textContent() === 'マスターパスワードを入力してください', 'master password required');
    await page.fill('#expMaster', 'wrong');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#exportPage .field-err:has-text("マスターパスワードが違います")');
    await page.fill('#expMaster', 'akari-master');
    await page.click('.fmt[data-fmt="pgp"]');
    expect(await page.inputValue('#expMaster') === 'akari-master', 'the master password stays when the format changes');
    expect(await page.locator('#expInner [aria-checked="true"]').getAttribute('data-inner') === 'csv', 'CSV inside by default');
    await page.fill('#expPass', 'kotatsu-mikan-2026');
    await page.fill('#expPass2', 'kotatsu-mikan-2025');
    await page.click('#exportPage .btn-primary');
    expect(await page.locator('#exportPage .field-err').textContent() === '確認用のパスフレーズが一致しません', 'passphrase mismatch');
    await page.fill('#expPass2', 'kotatsu-mikan-2026');
    await settle(page, 300);
    await shot(page, 'export-pgp');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportPage .btn-primary')]);
    expect(/^akari-export-\d{8}\.csv\.pgp$/.test(dl.suggestedFilename()), 'pgp download name: ' + dl.suggestedFilename());
    const body = await readFile(await dl.path(), 'utf8');
    expect(body.startsWith('-----BEGIN PGP MESSAGE-----'), 'armored PGP');
    const plain = new TextDecoder().decode(await decryptPgp(new TextEncoder().encode(body), 'kotatsu-mikan-2026'));
    expect(plain.startsWith('name,url,username,password,note,totp,vault,favorite'), 'decrypts to the CSV');
    await settle(page, 400);
    await shot(page, 'export-done');
    expect(await page.inputValue('#expMaster') === '' && await page.inputValue('#expPass') === '', 'passwords cleared after download');
    await ctx.close();
  },
  async lock() {
    const { page, ctx } = await open({ name: 'lock', state: 'locked' });
    await settle(page, 1200);
    await shot(page, 'lock');
    await page.fill('#lockInput', 'wrong');
    await page.keyboard.press('Enter');
    await settle(page, 1300);
    await shot(page, 'lock-error');
    await page.fill('#lockInput', 'correct horse');
    await page.keyboard.press('Enter');
    await settle(page, 350);
    await shot(page, 'unlocking-derive');
    expect(await page.locator('.boot-line[data-state="run"]').count() === 1, 'derive line runs while vault/unlock is pending');
    await settle(page, 950);
    await shot(page, 'unlocking');
    const lines = await page.locator('.boot-line .boot-k').allTextContents();
    expect(lines.join('|') === '鍵を導出|保管庫を復号|アイテムを読込', 'boot log lines: ' + lines.join('|'));
    expect(/^32 件$/.test(await page.locator('.boot-line:nth-child(3) .boot-v').textContent()), 'item count line');
    await settle(page, 1800);
    await shot(page, 'unlocked');
    await ctx.close();
  },
  async setup() {
    const { page, ctx } = await open({ name: 'setup', state: 'setup' });
    await settle(page, 1000);
    await page.fill('#setupPw', 'Hoshi-Kumo-Yama-27!');
    await page.fill('#setupPw2', 'Hoshi-Kumo-Yama-27!');
    await settle(page, 600);
    await shot(page, 'setup');
    await page.click('#setupSubmit');
    await settle(page, 1500);
    await shot(page, 'setup-boot');
    await settle(page, 2200);
    await shot(page, 'empty');
    await ctx.close();
  },
  async autofill() {
    const { page, ctx } = await open({ name: 'autofill' });
    await page.waitForSelector('.af-btn');
    await settle(page, 600);
    await page.click('.af-btn');
    await settle(page, 300);
    await shot(page, 'autofill-run');
    await settle(page, 850);
    await shot(page, 'autofill');
    await ctx.close();
  },
  async 'site-search'() {
    const { page, ctx } = await open({ name: 'site-search' });
    await page.waitForSelector('.row');
    await settle(page);
    await shot(page, 'site-search');
    expect(await page.inputValue('#search') === 'github.com', 'search starts with the tab site');
    expect(await page.locator('.af-btn').count() === 1, 'autofill card kept with the site query');
    expect(await page.locator('.row').count() === 1, 'only the github login listed');
    expect(!(await page.locator('#searchClear').isHidden()), 'clear button shown');
    await page.keyboard.press('Escape');
    await settle(page, 400);
    expect(await page.inputValue('#search') === '', 'Esc clears the site query');
    expect(await page.locator('.row').count() > 1, 'whole list after Esc');
    await ctx.close();

    const sub = await open({ name: 'site-search-sub', tabUrl: 'https://mail.google.com/mail/u/0/' });
    await sub.page.waitForSelector('.row');
    expect(await sub.page.inputValue('#search') === 'google.com', 'registrable domain: ' + await sub.page.inputValue('#search'));
    expect(await sub.page.locator('.row[data-id="google"]').count() === 1, 'google login listed');
    await sub.ctx.close();

    const none = await open({ name: 'site-search-none', tabUrl: 'https://kotatsu-mikan.example/' });
    await none.page.waitForSelector('.row');
    await settle(none.page, 300);
    expect(await none.page.inputValue('#search') === '', 'no prefill without a match');
    expect(await none.page.locator('.row').count() > 1, 'whole list without a match');
    await none.ctx.close();
  },
  async pick() {
    const { page, ctx } = await open({ name: 'pick', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await settle(page, 600);
    const ids = await page.$$eval('.row', (rows) => rows.map((r) => r.dataset.id));
    const total = ids.length;
    const picked = () => page.$$eval('.row[aria-selected="true"]', (rows) => rows.map((r) => r.dataset.id));
    const paneN = async () => Number(await page.locator('.pick-n').textContent());

    await page.click('#pickBtn');
    await page.waitForSelector('#app[data-picking] .row-check');
    expect(await page.getAttribute('#pickBtn', 'aria-pressed') === 'true', 'button pressed');
    expect(await page.locator('#list[aria-multiselectable]').count() === 1, 'listbox is multi-select');
    expect(await paneN() === 0 && (await page.locator('.pick-foot .btn-mini.danger').isDisabled()), 'nothing to delete yet');
    await settle(page, 500);
    await shot(page, 'pick-empty');

    await page.click(`.row[data-id="${ids[0]}"]`);
    await page.click(`.row[data-id="${ids[3]}"]`, { modifiers: ['Shift'] });
    await page.click(`.row[data-id="${ids[1]}"]`);
    expect(JSON.stringify(await picked()) === JSON.stringify([ids[0], ids[2], ids[3]]), 'range then toggle: ' + (await picked()).join());
    expect(await paneN() === 3, 'pane count');
    expect(await page.locator('.detail .pick-item').count() === 3, 'pane lists the checked items');
    await page.keyboard.press('Enter');
    await settle(page, 300);
    expect(!(await page.locator('#toast.on').count()), 'Enter copied something in selection mode');
    await settle(page, 400);
    await shot(page, 'pick');

    await page.keyboard.press('Delete');
    await page.waitForSelector('.pick-confirm');
    await settle(page, 300);
    await shot(page, 'pick-confirm');
    await page.keyboard.press('Escape');
    expect(!(await page.locator('.pick-confirm').count()) && (await paneN()) === 3, 'Esc leaves only the question');

    await page.click('.pick-foot .btn-mini.danger');
    await page.click('.pick-confirm .btn-mini.danger');
    await page.waitForSelector('#toast.on');
    await page.waitForFunction(() => !document.getElementById('app').hasAttribute('data-picking'));
    expect(/3 件をゴミ箱に移しました/.test(await page.locator('#toast').textContent()), 'toast');
    expect(await page.locator('#toastAct').isVisible() && (await page.locator('#toastAct').textContent()) === '元に戻す', 'the toast offers 元に戻す');
    const left = await page.$$eval('.row', (rows) => rows.map((r) => r.dataset.id));
    expect(left.length === total - 3 && ![ids[0], ids[2], ids[3]].some((id) => left.includes(id)) && left.includes(ids[1]), 'the three are gone');
    expect(await page.locator('.row[aria-selected="true"]').count() === 1 && !(await page.locator('.row-check').count()), 'back to the normal list');
    await settle(page, 900);
    await shot(page, 'pick-deleted');
    await quiet(page);

    await page.locator('#list').focus();
    await page.keyboard.press('Control+a');
    await page.waitForSelector('#app[data-picking]');
    expect(await paneN() === total - 3 && (await picked()).length === total - 3, 'Ctrl+A checks every row');
    await page.click('.pick-head .btn-line:nth-of-type(2)');
    expect((await picked()).length === 0, 'none');
    await page.keyboard.press('Control+a');
    await view(page, 'fav');
    await settle(page, 300);
    const favRows = await page.locator('.row').count();
    expect((await picked()).length === favRows && (await paneN()) === favRows, 'only visible rows stay checked');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('app').hasAttribute('data-picking'));
    expect(!(await page.locator('.row-check').count()), 'checks gone after Esc');

    await view(page, 'all');
    await settle(page, 300);
    const first = await page.$eval('.row', (r) => r.dataset.id);
    await page.click(`.row[data-id="${first}"]`, { modifiers: ['Control'] });
    await page.waitForSelector('#app[data-picking]');
    expect(JSON.stringify(await picked()) === JSON.stringify([first]), 'Ctrl+click picks one');
    await page.click('.pick-foot .btn-mini:not(.danger)');
    await page.waitForFunction(() => !document.getElementById('app').hasAttribute('data-picking'));
    await ctx.close();
  },
  async 'keys-ime-search'() {
    const { page, ctx } = await open({ name: 'keys-ime-search' });
    await page.waitForSelector('.row');
    await settle(page, 400);
    const fire = (key, isComposing) => page.evaluate(([k, c]) => {
      document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: k, isComposing: c, keyCode: c ? 229 : 0, bubbles: true }));
    }, [key, isComposing]);
    await page.focus('#search');
    await page.fill('#search', 'ｇｉｔ');
    await settle(page, 300);
    const rows = await page.locator('.row').count();
    const mark = await page.locator('.row .row-title mark').first().textContent();
    if (rows !== 1 || mark !== 'git') throw new Error(`NFKC search: rows=${rows} mark=${mark}`);
    await fire('Enter', true);
    await fire('Escape', true);
    await settle(page, 200);
    if (await page.locator('#toast.on').count()) throw new Error('Enter during IME composition copied');
    if (await page.inputValue('#search') !== 'ｇｉｔ') throw new Error('Esc during IME composition cleared the query');
    await fire('Escape', false);
    await settle(page, 200);
    if (await page.inputValue('#search') !== '') throw new Error('Esc did not clear the query');
    await page.fill('#search', 'ｽﾀｼﾞｵ');
    await page.fill('#search', 'STUDIO-MORI');
    await settle(page, 300);
    await shot(page, 'search-nfkc');
    await ctx.close();
  },
  async 'types-list'() {
    const { page, ctx } = await open({ name: 'types-list', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    await page.evaluate(() => { document.getElementById('list').scrollTop = 170; });
    await settle(page, 600);
    await shot(page, 'types-list');
    const row = (id) => page.locator(`.row[data-id="${id}"]`);
    expect(await row('card-jcb').locator('.tag').textContent() === 'CARD', 'CARD tag on the card row');
    expect(await row('card-jcb').locator('.row-user').textContent() === 'JCB · •••• 2302 · 08/29', 'card subtitle');
    expect(await row('ssh-deploy').locator('.tag').textContent() === 'SSH', 'SSH tag');
    expect((await row('github').locator('.tag').allTextContents()).join() === '2FA', 'logins keep only the 2FA tag');
    expect(await row('figma').locator('.tag').count() === 0, 'login without TOTP: no tag');
    expect(await row('wifi').locator('.row-user').textContent() === 'セキュアノート', 'a note shows its type, never its text');
    expect(await row('card-jcb').locator('.row-weak').count() === 0, 'no weak dot outside logins');
    await page.fill('#search', 'StudioMori-5G');
    await settle(page, 300);
    expect((await page.locator('.row').evaluateAll((r) => r.map((x) => x.dataset.id))).join() === 'wifi-office', 'ssid is searchable');
    for (const secret of ['kinoko-takenoko', '3540618291742302', 'Pg!Mori-Prod', 'BEGIN OPENSSH', '7KQ2-M9XP']) {
      await page.fill('#search', secret);
      await settle(page, 150);
      expect(await page.locator('.row').count() === 0, 'secret value matched the search: ' + secret);
    }
    await page.fill('#search', '1234-5678-9012');
    await settle(page, 200);
    expect(await page.locator('.row[data-id="aws"]').count() === 1, 'non-secret extra fields are searchable');
    await page.keyboard.press('Escape');
    await page.click('#typeBtn');
    await page.waitForSelector('#typeMenu.open');
    await settle(page, 500);
    await shot(page, 'type-menu');
    expect(await page.locator('#typeMenu .tp-cell').count() === 21, 'すべて / 最近 / お気に入り + 18 types');
    expect(await page.locator('#typeMenu .tp-group').count() === 4, 'four groups');
    expect(await page.locator('#typeMenu .tp-cell[data-type="card"] .v-count').textContent() === '2', 'card count');
    expect(await page.locator('#typeMenu .tp-cell[data-type="fav"] .v-count').textContent() === '4', 'favourites count');
    expect(await page.evaluate(() => document.activeElement?.dataset.type) === 'all', 'すべて focused');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.type) === 'login', '↓ goes to the nearest cell below');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.dataset.type) === 'card', '→ steps through the grid');
    await page.keyboard.press('Enter');
    await settle(page, 800);
    await shot(page, 'type-filter-card');
    expect((await page.locator('.row').evaluateAll((r) => r.map((x) => x.dataset.id))).sort().join() === 'card-jcb,card-visa-old', 'only cards');
    expect(await page.locator('#typeLabel').textContent() === 'クレジットカード', 'chip shows the type');
    expect(await page.locator('#viewCount').textContent() === '2', 'the chip counts the type');
    expect(await page.locator('#typeBtn.on').count() === 1, 'accent while filtered');
    expect(await page.locator('#list .row').count() === 2, 'two cards listed');
    expect(await page.locator('.af').count() === 0, 'no autofill card while filtering cards');
    await view(page, 'fav');
    await settle(page, 400);
    expect(await page.locator('#typeLabel').textContent() === 'お気に入り' && (await page.locator('.row').count()) === 4, 'お気に入り replaces クレジットカード');
    await view(page, 'card');
    await page.click('#vaultBtn');
    await page.click('#vaultItems .menu-item:has-text("家族")');
    await settle(page, 600);
    await shot(page, 'type-filter-empty');
    expect((await page.locator('.empty').textContent()).includes('クレジットカードはありません'), 'empty type message');
    await page.click('.empty-act .btn-line');
    await page.waitForSelector('.ed-form[data-type="card"]');
    expect(await page.locator('.vault-chip[aria-checked="true"]').textContent() === '家族', 'new card goes to the current vault');
    await page.click('.ed-foot .btn-line');
    await page.click('#vaultBtn');
    await page.click('#vaultItems .menu-item:has-text("すべての保管庫")');
    await view(page, 'all');
    await settle(page, 600);
    expect(await page.locator('#viewCount').textContent() === '32', 'cleared');
    await ctx.close();
  },
  async 'plus-types'() {
    const { page, ctx } = await open({ name: 'plus-types' });
    await page.waitForSelector('.row');
    await settle(page, 500);
    await page.click('#plusBtn');
    await settle(page, 500);
    const focused = () => page.evaluate(() => document.activeElement?.dataset.type || document.activeElement?.id);
    expect(await page.locator('#plusMenu [data-type]').count() === 18, '18 types in the ＋ menu');
    expect(await page.locator('#plusMenu .pm-main [data-type]:visible').count() === 4, '基本 types in the first panel');
    expect(await page.evaluate(() => document.activeElement?.id) === 'newLogin', 'ログイン focused first');
    for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']) await page.keyboard.press(k);
    expect(await focused() === 'newOther', '↓ walks the list to その他');
    expect(await page.locator('#plusMenu .tp-arg').textContent() === 'new --help', 'command line follows focus');
    await page.keyboard.press('ArrowRight');
    await settle(page, 300);
    expect(await page.locator('#newOther').getAttribute('aria-expanded') === 'true', 'その他 expanded');
    expect(await focused() === 'apiCredential', '→ opens その他 on its first type');
    await page.keyboard.press('ArrowDown');
    expect(await focused() === 'server', '↓ keeps the column in the 2-column grid');
    expect(await page.locator('#plusMenu .tp-arg').textContent() === 'new server', 'command line follows focus');
    await shot(page, 'plusmenu-other');
    await page.keyboard.press('n');
    expect(await page.locator('.ed-form').count() === 0, 'N does nothing on the その他 panel');
    await page.keyboard.press('Escape');
    await settle(page, 200);
    expect(await page.locator('#plusMenu.open').count() === 1, 'Esc on その他 goes back instead of closing');
    expect(await focused() === 'newOther', 'back on その他');
    await shot(page, 'plusmenu-keys');
    await page.keyboard.press('n');
    await page.waitForSelector('.ed-form[data-type="note"]');
    await page.click('.ed-foot .btn-line');
    await page.click('#plusBtn');
    await page.click('#newOther');
    await page.click('#plusMenu [data-type="passport"]');
    await page.waitForSelector('.ed-form[data-type="passport"]');
    expect(await page.locator('.ed-heading').textContent() === '新規パスポート', 'heading');
    await page.fill('#edF-expiry', '2031/2/30');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 400);
    expect(await page.locator('.ed-row:has(#edF-expiry) .field-err').textContent() === '日付は YYYY-MM-DD の形式で入力してください', 'impossible date rejected');
    expect(await page.locator('.ed-row:has(#edTitle) .field-err').textContent() === '', 'no title error once something is typed');
    await shot(page, 'editor-passport-invalid');
    await page.fill('#edF-expiry', '2031年2月28日');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const saved = await page.evaluate(() => window.__AKARI_DB__.items.at(-1));
    expect(saved.type === 'passport' && saved.title === 'パスポート' && saved.fields.expiry === '2031-02-28', 'stored ISO date + type name as title');
    await ctx.close();
  },
  async 'detail-types'() {
    const { page, ctx } = await open({ name: 'detail-types', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    const pick = async (id) => { await page.click(`.row[data-id="${id}"]`); await settle(page, 900); };
    const reveal = (sel) => page.click(`${sel} .ibtn[aria-pressed]`);
    await pick('card-jcb');
    await shot(page, 'detail-card');
    expect(await page.locator('.card-num').textContent() === '•••• •••• •••• 2302', 'card number masked with the last 4');
    expect(await page.locator('.cardline .cl-brand').textContent() === 'JCB', 'brand on the card line');
    expect(await page.locator('.f-sub').textContent() === 'JCB', 'brand next to the label');
    expect(/08\/29$/.test(await page.locator('.cardline .cl-exp').textContent()), 'expiry MM/YY');
    expect(await page.locator('.cardline .cl-cvv').textContent() === 'CVV•••', 'CVV masked on the card face');
    await reveal('.f-row:has-text("セキュリティコード")');
    await settle(page, 700);
    expect(await page.locator('.cardline .cl-cvv-v').textContent() === '418', 'revealed on the face with its row');
    await reveal('.f-row:has(.card-num)');
    await settle(page, 800);
    await shot(page, 'detail-card-revealed');
    expect(await page.locator('.card-num').textContent() === '3540 6182 9174 2302', 'grouped in 4s');
    await page.click('.f-row:has(.card-num) .ibtn[title="コピー"]');
    await settle(page, 300);
    expect(await page.locator('#toastMsg').textContent() === 'カード番号をコピーしました', 'copy toast');
    expect(/自動で消去/.test(await page.locator('#toastSub').textContent()), 'secret copy schedules the clipboard clear');
    expect(await page.evaluate(() => navigator.clipboard.readText()) === '3540618291742302', 'digits only on the clipboard');
    await page.click('.f-row:has-text("名義") .ibtn[title="コピー"]');
    await settle(page, 300);
    expect(await page.locator('#toastSub').textContent() === '', 'non-secret copy: no clear');
    await pick('card-visa-old');
    expect(await page.locator('.cardline .exp-tag.over').count() === 1, 'expired card marked');
    await pick('identity-home');
    await shot(page, 'detail-identity');
    expect(await page.locator('.f-row:has-text("生年月日") .f-value').textContent() === '1992/04/18', 'date shown YYYY/MM/DD');
    expect(await page.locator('.box.tpl .f-row .f-label').first().textContent() === '氏名', 'rows follow the template order (氏名 first)');
    expect(await page.locator('.row[data-id="identity-home"] .row-user').textContent() === '佐藤 遥 · haruka.sato@example.com', 'identity subtitle');
    await page.evaluate(() => { document.getElementById('cardScroll').scrollTop = 600; });
    await quiet(page);
    await shot(page, 'detail-identity-address');
    await pick('ssh-deploy');
    await shot(page, 'detail-ssh');
    expect(!(await page.locator('.ml-box.secret').textContent()).includes('BEGIN'), 'private key masked');
    await reveal('.f-row:has(.ml-box.secret)');
    await settle(page, 700);
    await shot(page, 'detail-ssh-revealed');
    expect((await page.locator('.ml-box.secret').textContent()).startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n'), 'revealed with line breaks');
    await pick('wifi-office');
    await shot(page, 'detail-wifi');
    expect(await page.locator('.f-row:has-text("セキュリティ") .f-value').textContent() === 'WPA3', 'select shown by its label');
    await reveal('.f-row:has-text("パスワード")');
    await settle(page, 800);
    await shot(page, 'detail-wifi-revealed');
    await pick('bank-mufg');
    await shot(page, 'detail-bank');
    await reveal('.f-row:has-text("口座番号")');
    await settle(page, 800);
    await shot(page, 'detail-bank-revealed');
    expect(await page.locator('.f-row:has-text("口座番号") .pw-text').textContent() === '1234567', 'account number revealed');
    await pick('passport');
    await shot(page, 'detail-passport');
    expect(/^あと \d+ 日$/.test(await page.locator('.exp-tag.soon').textContent()), 'expiry soon');
    await pick('aws');
    await page.evaluate(() => { document.getElementById('cardScroll').scrollTop = 400; });
    await settle(page, 200);
    await shot(page, 'detail-login-extra');
    expect(await page.locator('.f-row:has-text("MFA 復旧コード") .pw-text').textContent() === '••••••••••••••', 'secret extra masked');
    await pick('wifi-office');
    await page.keyboard.press('Enter');
    await settle(page, 300);
    expect(await page.locator('#toastMsg').textContent() === 'パスワードをコピーしました', 'Enter copies the Wi-Fi password');
    await pick('card-jcb');
    await reveal('.f-row:has(.card-num)');
    await settle(page, 700);
    await page.click('#lockBtn');
    await page.waitForSelector('#gate.on');
    expect(!(await page.locator('#app').innerText()).includes('3540'), 'revealed card number gone after lock');
    expect(await page.locator('#detail').evaluate((d) => d.childElementCount) === 0, 'detail cleared');
    await ctx.close();
  },
  async 'editor-types'() {
    const { page, ctx } = await open({ name: 'editor-types', tabUrl: NEW_TAB });
    await page.waitForSelector('.row');
    const dbItem = (id) => page.evaluate((i) => window.__AKARI_DB__.items.find((x) => x.id === i), id);
    await page.click('.row[data-id="card-jcb"]');
    await settle(page, 600);
    await page.click('.d-head .ibtn[title="編集"]');
    await settle(page, 900);
    await shot(page, 'editor-card');
    expect(await page.inputValue('#edF-expiry') === '08/2029', 'month edited as MM/YYYY');
    expect(await page.locator('.ed-brand').textContent() === 'JCB', 'live brand');
    await page.fill('#edF-expiry', '1/30');
    await page.locator('#edF-expiry').blur();
    expect(await page.inputValue('#edF-expiry') === '01/2030', 'typed MM/YY normalised to MM/YYYY on blur');
    await page.fill('#edF-number', '4980 12');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 400);
    await shot(page, 'editor-card-invalid');
    expect(await page.locator('.ed-row:has(#edF-number) .field-err').textContent() === 'カード番号は 8〜19 桁の数字で入力してください', 'too short card number');
    await page.fill('#edF-number', '3540 6182 9174 2302');
    await page.evaluate(() => { document.querySelector('.ed-scroll').scrollTop = 400; });
    await settle(page, 200);
    await shot(page, 'editor-card-extra');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const card = await dbItem('card-jcb');
    expect(card.fields.expiry === '2030-01' && card.fields.number === '3540618291742302', 'stored ISO month + digits');
    expect(card.extra.length === 2, 'extras kept');
    await page.click('#plusBtn');
    await page.click('#newOther');
    await page.click('#plusMenu [data-type="database"]');
    await page.waitForSelector('.ed-form[data-type="database"]');
    await page.fill('#edF-dbType', 'MySQL 8.4');
    await page.fill('#edF-host', 'mysql.studio-mori.internal');
    await page.fill('#edF-port', '３３０６');
    await page.fill('#edF-database', 'shop');
    await page.fill('#edF-username', 'shop_app');
    await page.click('.ed-row:has(#edF-password) .ibtn[title="パスワード生成"]');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 500);
    await page.click('#genApply');
    await settle(page, 400);
    await addExtra(page, '1', '文字コード', 'utf8mb4');
    await addExtra(page, '2', 'root パスワード', 'R00t!Shop-2026');
    await page.evaluate(() => { document.querySelector('.ed-scroll').scrollTop = 250; });
    await quiet(page);
    await shot(page, 'editor-database');
    expect(await page.locator('.ed-scroll .ed-head .tile').textContent() === 'S', 'tile from the derived title (shop)');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    await settle(page, 900);
    await shot(page, 'editor-database-saved');
    const db = await page.evaluate(() => window.__AKARI_DB__.items.at(-1));
    expect(db.type === 'database' && db.title === 'shop' && db.fields.port === '3306' && db.fields.password.length >= 8, 'stored fields');
    expect(JSON.stringify(db.extra) === JSON.stringify([{ label: '文字コード', value: 'utf8mb4', kind: 'text', secret: false }, { label: 'root パスワード', value: 'R00t!Shop-2026', kind: 'hidden', secret: true }]), 'stored extra');
    expect(await page.locator('.row[aria-selected="true"] .tag').textContent() === 'DB', 'new row selected with its tag');
    await page.click('.row[data-id="github"]');
    await settle(page, 500);
    await page.click('.d-head .ibtn[title="編集"]');
    await addExtra(page, '1', '', 'value without a name');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 300);
    expect(await page.locator('.xf-row .field-err:not(:empty)').textContent() === '項目名を入力してください', 'extra needs a label');
    await page.fill('.xf-row .xf-label', 'リカバリーコード');
    await page.click('.xf-row .xf-kind');
    await page.keyboard.press('2');
    await settle(page, 200);
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const gh = await dbItem('github');
    expect(gh.extra?.[0]?.label === 'リカバリーコード' && gh.extra[0].secret === true && gh.totp?.secret, 'login extra saved, TOTP kept');
    await ctx.close();
  },
  async 'editor-roundtrip'() {
    const OLD_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----\n';
    const { page, ctx } = await open({
      name: 'editor-roundtrip',
      tabUrl: NEW_TAB,
      seedPatch: {
        'card-visa-old': {
          fields: { expiry: '1999-05', cvv: '12345', number: '4980-1234-5678-9011' },
          extra: [{ label: '', value: 'imported without a name', secret: false }, { label: '鍵', value: 'line 1\nline 2\n\n', secret: true }],
        },
        passport: { fields: { issuedOn: '1066-10-14' } },
        'wifi-office': { fields: { security: '' } },
      },
    });
    await page.waitForSelector('.row');
    const dbItem = (id) => page.evaluate((i) => window.__AKARI_DB__.items.find((x) => x.id === i), id);
    const editTitle = async (id, title) => {
      await page.click(`.row[data-id="${id}"]`);
      await settle(page, 400);
      await page.click('.d-head .ibtn[title="編集"]');
      await page.waitForSelector('#edTitle');
      await page.fill('#edTitle', title);
      await page.click('.ed-foot .btn-primary');
      await page.waitForSelector('#editor[hidden]', { state: 'attached' });
      return dbItem(id);
    };
    await page.click('.row[data-id="card-visa-old"]');
    await settle(page, 400);
    await page.click('.d-head .ibtn[title="編集"]');
    await page.waitForSelector('#edTitle');
    expect(await page.inputValue('#edF-expiry') === '05/1999', '1999-05 is shown as 05/1999');
    await page.click('.ed-foot .btn-line');
    const card = await editTitle('card-visa-old', '三井住友カード（1999）');
    expect(card.title === '三井住友カード（1999）', 'title saved');
    expect(card.fields.expiry === '1999-05', 'month not shifted a century: ' + card.fields.expiry);
    expect(card.fields.cvv === '12345' && card.fields.number === '4980-1234-5678-9011', 'untouched values not re-validated or regrouped');
    expect(card.extra[0].value === 'imported without a name' && card.extra[1].value === 'line 1\nline 2\n\n', 'extras keep their text and trailing newlines');
    const ssh = await editTitle('ssh-deploy', 'デプロイ鍵');
    expect(ssh.fields.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n'), 'private key keeps its final newline');
    const pass = await editTitle('passport', 'パスポート（旧）');
    expect(pass.fields.issuedOn === '1066-10-14', 'an old date is kept');
    const wifi = await editTitle('wifi-office', 'オフィス');
    expect(wifi.fields.security === '', 'an empty select stays empty');
    await page.click('.row[data-id="ssh-deploy"]');
    await page.click('.d-head .ibtn[title="編集"]');
    await page.fill('#edF-privateKey', OLD_KEY);
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    expect((await dbItem('ssh-deploy')).fields.privateKey === OLD_KEY, 'typed key saved with its final newline');
    await page.click('.row[data-id="passport"]');
    await page.click('.d-head .ibtn[title="編集"]');
    await page.fill('#edF-issuedOn', '0999-12-31');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 300);
    expect(await page.locator('.ed-row:has(#edF-issuedOn) .field-err').textContent() !== '', 'year 999 refused');
    await page.fill('#edF-issuedOn', '1000-01-01');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    expect((await dbItem('passport')).fields.issuedOn === '1000-01-01', 'year 1000 accepted');
    await page.click('.row[data-id="card-jcb"]');
    await page.click('.d-head .ibtn[title="編集"]');
    await page.fill('#edF-cvv', '1234567');
    await page.fill('#edF-expiry', '07/2101');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const jcb = await dbItem('card-jcb');
    expect(jcb.fields.cvv === '1234567' && jcb.fields.expiry === '2101-07', 'any CVV; MM/YYYY kept as typed');
    await page.click('.d-head .ibtn[title="編集"]');
    await addExtra(page, '1', '', 'no name');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 300);
    expect(await page.locator('.xf-row .field-err:not(:empty)').last().textContent() === '項目名を入力してください', 'new extra needs a name');
    await ctx.close();
  },
  async light() {
    const { page, ctx } = await open({ name: 'light', theme: 'light', tabUrl: 'https://www.amazon.co.jp/ap/signin' });
    await page.waitForSelector('.row');
    expect(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light from the setting');
    await settle(page, 900);
    await shot(page, 'light-main');
    await page.click('[data-id="amazon"]');
    await settle(page, 700);
    await shot(page, 'light-weak');
    await page.click('#menuBtn');
    await settle(page, 400);
    await shot(page, 'light-menu');
    await page.click('#openHealth');
    await settle(page, 700);
    await shot(page, 'light-health');
    await page.keyboard.press('Escape');
    await page.click('#plusBtn');
    await settle(page, 500);
    await page.keyboard.press('g');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 800);
    await shot(page, 'light-generator');
    await page.keyboard.press('Escape');
    await page.click('#lockBtn');
    await page.waitForSelector('#gate.on');
    await settle(page, 600);
    await shot(page, 'light-lock');
    await ctx.close();
  },
  async 'lock-search'() {
    const { page, ctx } = await open({ name: 'lock-search', state: 'locked', tabUrl: NEW_TAB });
    await page.waitForSelector('#gate.on');
    await page.fill('#lockInput', 'akari-master');
    await page.click('#lockReveal');
    expect(await page.locator('#lockInput').getAttribute('type') === 'text', 'the eye shows the password');
    expect(await page.locator('#lockReveal').getAttribute('aria-pressed') === 'true', 'and says it is pressed');
    expect(await page.evaluate(() => document.activeElement?.id) === 'lockInput', 'focus stays in the field');
    const capsKey = (on) => page.evaluate((v) => document.getElementById('lockInput')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, modifierCapsLock: v })), on);
    await capsKey(true);
    await settle(page, 200);
    await shot(page, 'lock-caps');
    expect(/Caps Lock/.test(await page.locator('#lockCaps').textContent()), 'Caps Lock warning');
    await capsKey(false);
    expect(!(await page.locator('#lockCaps').textContent()), 'gone when Caps Lock is off');
    await page.click('#lockReveal');
    expect(await page.locator('#lockInput').getAttribute('type') === 'password', 'and hides it again');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.row');

    const ids = () => page.$$eval('.row', (rows) => rows.map((r) => r.dataset.id));
    await page.click('#search');
    await page.keyboard.type('has:totp');
    await settle(page, 300);
    const totp = await ids();
    expect(totp.length > 0 && (await page.evaluate((list) => list.every((id) => !!window.__AKARI_DB__.items.find((x) => x.id === id)?.totp?.secret), totp)), 'has:totp');
    await page.fill('#search', '');
    await page.keyboard.type('type:card');
    await settle(page, 300);
    expect((await page.evaluate((list) => list.every((id) => window.__AKARI_DB__.items.find((x) => x.id === id)?.type === 'card'), await ids())), 'type:card');
    await page.fill('#search', '');
    await page.keyboard.type('amzn');
    await settle(page, 300);
    expect((await ids()).includes('amazon') && /近いもの/.test(await page.locator('.group').first().textContent()), 'loose match, labelled');
    await shot(page, 'search-loose');
    await ctx.close();
  },
  async backup() {
    const DAY = 86400000;
    const note = (page) => page.locator('#backupNote .bk');
    const frame = (page) => page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round).join(','); };
      return { card: r('#card'), list: r('.col-list'), app: r('#app') };
    });
    const quietPage = await open({ name: 'backup-quiet' });
    await quietPage.page.waitForSelector('.row');
    await settle(quietPage.page, 500);
    const quietFrame = await frame(quietPage.page);
    expect(await note(quietPage.page).count() === 0, 'nothing shows when a backup is not due');
    expect(await quietPage.page.locator('#backupNote').getAttribute('role') === 'status', 'the slot is a polite status region');
    await quietPage.ctx.close();

    const { page, ctx } = await open({ name: 'backup', backup: { lastAt: Date.now() - 45 * DAY } });
    await page.waitForSelector('#backupNote .bk');
    await settle(page, 700);
    await shot(page, 'backup');
    expect(/最後のバックアップは 45 日前です/.test(await note(page).locator('.bk-title').textContent()), 'days since the last backup');
    expect(/このブラウザの中だけ/.test(await note(page).locator('.bk-why').textContent()), 'says why');
    expect(JSON.stringify(await frame(page)) === JSON.stringify(quietFrame), 'the 680x480 frame and the detail pane do not move');
    const fits = await page.evaluate(() => {
      const b = document.querySelector('#backupNote .bk').getBoundingClientRect();
      const l = document.querySelector('.col-list').getBoundingClientRect();
      return b.left >= l.left && b.right <= l.right && b.bottom <= l.bottom;
    });
    expect(fits, 'the notice stays inside the list column');
    await page.focus('#list');
    const focused = () => page.evaluate(() => document.activeElement?.textContent);
    for (let n = 0; n < 6 && await focused() !== 'バックアップする'; n++) await page.keyboard.press('Tab');
    expect(await focused() === 'バックアップする', 'keyboard reaches バックアップする');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent) === 'あとで', 'keyboard reaches あとで');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#backupNote:empty', { state: 'attached' });
    expect(await page.evaluate(() => window.__AKARI_DB__.backup.snoozes) === 1, 'あとで calls backup/snooze');
    expect(/7 日後/.test(await page.locator('#toastMsg').textContent()), 'says when it comes back');
    expect(await page.evaluate(() => document.activeElement?.id) === 'list', 'focus returns to the list');
    expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'backup/status' })).data.due) === false, 'not due while snoozed');
    await ctx.close();

    const first = await open({ name: 'backup-never', backup: { lastAt: null, since: Date.now() - 40 * DAY } });
    await first.page.waitForSelector('#backupNote .bk');
    await settle(first.page, 600);
    await shot(first.page, 'backup-never');
    expect(/まだバックアップを書き出していません/.test(await note(first.page).locator('.bk-title').textContent()), 'no backup yet');
    await first.page.click('#backupNote .btn-primary');
    await first.page.waitForSelector('#setSheet.open .fmt');
    await settle(first.page, 600);
    expect(await first.page.locator('.fmt[aria-checked="true"]').getAttribute('data-fmt') === 'akari', 'opens the export page on the Akari backup');
    await shot(first.page, 'backup-export');
    await first.page.click('.fmt[data-fmt="csv"]');
    await first.page.fill('#expMaster', 'akari-master');
    await Promise.all([first.page.waitForEvent('download'), first.page.click('#exportPage .btn-primary')]);
    await settle(first.page, 500);
    expect(await note(first.page).count() === 1, 'a plain export is not a backup');
    await first.page.click('.fmt[data-fmt="pgp"]');
    await first.page.fill('#expMaster', 'akari-master');
    await first.page.fill('#expPass', 'kotatsu-mikan-2026');
    await first.page.fill('#expPass2', 'kotatsu-mikan-2026');
    await Promise.all([first.page.waitForEvent('download'), first.page.click('#exportPage .btn-primary')]);
    await first.page.waitForSelector('#backupNote:empty', { state: 'attached' });
    expect(await first.page.evaluate(() => window.__AKARI_DB__.backup.lastAt) != null, 'a PGP export restarts the clock');
    await first.ctx.close();

    const done = await open({ name: 'backup-done', backup: { lastAt: Date.now() - 31 * DAY } });
    await done.page.waitForSelector('#backupNote .bk');
    await openSheetPage(done.page, '#exportOpen');
    await done.page.waitForSelector('.fmt');
    await Promise.all([done.page.waitForEvent('download'), done.page.click('#exportPage .btn-primary')]);
    await done.page.waitForSelector('#backupNote:empty', { state: 'attached' });
    await done.page.keyboard.press('Escape');
    await settle(done.page, 600);
    await shot(done.page, 'backup-cleared');
    expect(await note(done.page).count() === 0, 'a finished Akari backup clears it');
    await done.ctx.close();

    const light = await open({ name: 'backup-light', theme: 'light', backup: { lastAt: Date.now() - 45 * DAY } });
    await light.page.waitForSelector('#backupNote .bk');
    expect(await light.page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'light theme');
    await settle(light.page, 700);
    await shot(light.page, 'backup-light');
    await light.ctx.close();
  },
  async reduced() {
    const { page, ctx } = await open({ name: 'reduced' }, { reducedMotion: 'reduce' });
    await page.waitForSelector('.row');
    await settle(page, 300);
    await shot(page, 'reduced-motion');
    await ctx.close();
  },
};

const FEATURE_VARIANTS = [
  { tag: 'ja-dark', lang: 'ja', theme: 'dark' },
  { tag: 'ja-light', lang: 'ja', theme: 'light' },
  { tag: 'en-dark', lang: 'en', theme: 'dark' },
  { tag: 'en-light', lang: 'en', theme: 'light' },
];
const openFeature = (name, v, extra = {}) => open({ name, featureSeed: true, tabUrl: NEW_TAB, theme: v.theme, lang: v.lang, ...extra });
async function pickItem(page, q, id) {
  await page.fill('#search', q);
  await page.waitForTimeout(300);
  await page.click(`.row[data-id="${id}"]`);
  await page.waitForTimeout(700);
}
async function editItem(page) {
  await page.click('.d-head .d-acts .ibtn >> nth=0');
  await page.waitForSelector('.ed-form .xf-box');
  await page.waitForTimeout(700);
}
async function scrollEditorTo(page, sel, { end = false } = {}) {
  await page.evaluate(([s, atEnd]) => {
    const sc = document.querySelector('.ed-scroll');
    const el = document.querySelector(s);
    if (!el) throw new Error('missing ' + s);
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = atEnd ? top + el.offsetHeight - sc.clientHeight + 12 : top - 8;
  }, [sel, end]);
  await page.waitForTimeout(250);
}
async function detailToEnd(page) {
  await page.evaluate(() => { const sc = document.getElementById('cardScroll'); sc.scrollTop = sc.scrollHeight; });
  await page.waitForTimeout(300);
}
const fakeFile = (name, size, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.alloc(size, 7) });
async function dropOnAttachments(page, list) {
  return page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.size).fill(7)], f.name, { type: f.type }));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('.at-box').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, list);
}
async function dragOverAttachments(page, on) {
  await page.evaluate((enter) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'drag.txt', { type: 'text/plain' }));
    document.querySelector('.at-slot').dispatchEvent(new DragEvent(enter ? 'dragover' : 'dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, on);
  await page.waitForTimeout(250);
}

function featureScenarios() {
  const out = {};
  for (const v of FEATURE_VARIANTS) {
    const ja = v.lang === 'ja';
    out[`fields-${v.tag}`] = async () => {
      const { page, ctx } = await openFeature(`fields-${v.tag}`, v);
      const fshot = (n) => shot(page, `fields-${v.tag}-${n}`);
      await pickItem(page, 'cloudflare', 'fields-login');
      await detailToEnd(page);
      await fshot('detail-login');
      expect(await page.locator('#detail .xf-totp-row').count() === 1, 'custom TOTP row in the detail');
      expect(await page.locator('#detail .f-label:text-is("サポート PIN")').count() === 1, 'a legacy field without kind is shown');

      await editItem(page);
      await scrollEditorTo(page, '.xf-box');
      await fshot('editor');
      expect(await page.locator('.ed-scroll > .box').evaluateAll((els) => els.map((e) => e.classList.contains('xf-box') ? 'x' : e.classList.contains('at-box') ? 'a' : 'b').join('')) === 'bxab',
        'section order: fields, custom fields, attachments, vault/note');

      await page.click('.xf-slot');
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(250);
      await fshot('chooser');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      expect(await page.locator('.xf-chooser').count() === 0, 'Esc closes the chooser');
      expect(await page.locator('#editor:not([hidden])').count() === 1 && await page.locator('.ed-foot .ed-confirm').count() === 0, 'Esc leaves the editor open and asks nothing');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('xf-slot')), 'focus returns to the slot');

      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.press('4');
      await page.waitForTimeout(300);
      await page.locator('.xf-row .xf-label').last().fill(ja ? '更新日' : 'Renewal');
      await page.locator('.xf-row .xf-value').last().fill('2026-02-30');
      await page.click('.xf-slot');
      await page.waitForTimeout(200);
      await page.keyboard.press('3');
      await page.waitForTimeout(200);
      await page.locator('.xf-row .xf-label').last().fill('VPN');
      await page.locator('.xf-row .xf-value').last().fill('not-a-secret!');
      await page.click('.ed-foot .btn-primary');
      await page.waitForTimeout(400);
      await scrollEditorTo(page, '.xf-row:nth-last-child(2)');
      await fshot('invalid');
      expect(await page.locator('.xf-row .field-err:not(:empty)').count() === 2, 'two invalid rows');
      expect(await page.locator('#editor:not([hidden])').count() === 1, 'invalid rows keep the editor open');

      await page.fill('.xf-row:nth-last-child(2) input.xf-value', '2026/3/1');
      await page.locator('.xf-row:nth-last-child(2) input.xf-value').blur();
      expect(await page.inputValue('.xf-row:nth-last-child(2) input.xf-value') === '2026-03-01', 'date normalized on blur');
      await page.fill('.xf-row:last-child input.xf-value', 'otpauth://totp/VPN:me?secret=KRSXG5CTMVRXEZLU&issuer=VPN');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      await scrollEditorTo(page, '.xf-row:nth-last-child(2)');
      await fshot('new-rows');
      await page.click('.xf-row:first-child .xf-kind');
      await page.waitForTimeout(250);
      await scrollEditorTo(page, '.xf-box');
      await fshot('kind-chooser');
      await page.click('.xf-row:first-child .xf-kind', { delay: 120 });
      await page.waitForTimeout(250);
      expect(await page.locator('.xf-chooser').count() === 0, 'a second click on the kind button closes its chooser');
      expect(await page.evaluate(() => document.activeElement === document.querySelector('.xf-row:first-child .xf-kind')), 'focus stays on the kind button after closing');
      await page.click('.xf-row:first-child .xf-kind', { delay: 120 });
      await page.waitForTimeout(250);
      expect(await page.locator('.xf-chooser').count() === 1, 'a third click opens the chooser again');
      await page.keyboard.press('2');
      await page.waitForTimeout(200);
      await scrollEditorTo(page, '.xf-box');
      await fshot('editor-filled');
      await page.click('.ed-foot .btn-primary');
      await page.waitForSelector('#editor[hidden]', { state: 'attached' });
      const ex = await page.evaluate(() => window.__AKARI_DB__.items.find((x) => x.id === 'fields-login').extra);
      expect(ex[0].kind === 'hidden' && ex[0].secret === true && ex[0].value === '9f2c4a7e81b3d605', 'text -> hidden keeps the value');
      expect(ex[2].value === 'JBSWY3DPEHPK3PXP' && ex[2].kind === 'totp', 'untouched TOTP round-trips');
      expect(ex.some((x) => x.kind === 'date' && x.value === '2026-03-01'), 'new date saved');
      expect(ex.some((x) => x.kind === 'totp' && x.value.startsWith('otpauth://')), 'new TOTP saved as URI');
      await page.waitForTimeout(600);
      await detailToEnd(page);
      await fshot('detail-saved');

      await pickItem(page, 'ルネサンス', 'fields-member');
      await detailToEnd(page);
      await fshot('detail-member');
      expect(await page.locator('#detail .xf-totp-row').count() === 1, 'otpauth URI field shows a live code');
      await ctx.close();
    };

    out[`attach-${v.tag}`] = async () => {
      const { page, ctx } = await openFeature(`attach-${v.tag}`, v);
      const ashot = (n) => shot(page, `attach-${v.tag}-${n}`);
      await pickItem(page, '確定申告', 'att-docs');
      await ashot('detail');
      expect(await page.locator('#detail .at-dbox .at-ditem').count() === 4, 'four files listed');
      expect(await page.locator('#detail > .box + .sect + div > .at-dbox').count() === 1, 'files sit right under the field box');
      await page.click('.at-dbox .at-btn[aria-expanded]');
      await page.waitForSelector('.at-img');
      await page.waitForTimeout(400);
      await page.evaluate(() => { document.getElementById('cardScroll').scrollTop = 140; });
      await page.waitForTimeout(200);
      await ashot('detail-preview');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.at-dbox .at-ditem:nth-child(3) .at-btn:not([aria-expanded])')]);
      const got = await readFile(await dl.path(), 'utf8');
      expect(got.startsWith('e-Tax'), 'downloaded the stored bytes');
      await quiet(page);

      await editItem(page);
      await scrollEditorTo(page, '.at-box');
      await ashot('editor-stored');
      await page.click('.at-box .at-item:nth-child(2) .ibtn');
      await page.locator('.at-input').setInputFiles([fakeFile('鍵の控え.txt', 1200, 'text/plain'), fakeFile('scan-2025-11.png', 2.4 * 1024 * 1024, 'image/png')]);
      expect(await dropOnAttachments(page, [{ name: 'big-video.mov', size: 6 * 1024 * 1024, type: 'video/quicktime' }, { name: 'empty.txt', size: 0, type: 'text/plain' }]), 'the attachments box takes the drop');
      await page.waitForTimeout(300);
      expect(await page.locator('.at-err:not(:empty)').count() === 1, 'too big / empty files are refused with a reason');
      await scrollEditorTo(page, '.at-box', { end: true });
      await ashot('editor-mixed');
      await dragOverAttachments(page, true);
      await ashot('editor-dragging');
      await dragOverAttachments(page, false);

      await page.keyboard.press('Escape');
      await page.waitForSelector('.ed-foot .ed-confirm');
      expect(/ファイル|file/.test(await page.locator('.ed-foot .ed-confirm').textContent()), 'discard question mentions queued files');
      await page.click('.ed-foot .ed-confirm .btn-mini:not(.danger)');

      await page.evaluate(() => { window.__AKARI_MOCK__.uploadDelay = 1500; window.__AKARI_MOCK__.failUpload = 'scan'; });
      await page.click('.ed-foot .btn-primary');
      await page.waitForSelector('.ed-foot-note[data-kind="run"]:not([hidden])');
      await page.waitForTimeout(500);
      await scrollEditorTo(page, '.at-box', { end: true });
      await ashot('editor-saving');
      await page.keyboard.press('Escape');
      expect(await page.locator('.ed-foot .ed-confirm').count() === 0 && await page.locator('#editor:not([hidden])').count() === 1, 'Esc cannot close the editor while files are being saved');
      await page.waitForSelector('.ed-foot-note[data-kind="err"]:not([hidden])', { timeout: 15000 });
      await page.waitForTimeout(500);
      await scrollEditorTo(page, '.at-box', { end: true });
      await ashot('editor-failed');
      expect(await page.locator('#editor:not([hidden])').count() === 1, 'a failed file keeps the editor open');
      expect(await page.locator('.at-item.queued').count() === 1, 'the failed file stays queued');
      expect(await page.locator('.at-item.removed').count() === 0, 'the removed file is gone after the save');
      expect(await page.evaluate(() => (window.__AKARI_DB__.items.find((x) => x.id === 'att-docs').attachments || []).length) === 4, 'item saved: 4 - 1 removed + 1 added');
      const footLines = await page.locator('.ed-foot-note').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(footLines === 1, 'the foot line stays on one line');
      expect(await page.evaluate(() => document.activeElement?.matches('.ed-foot .btn-primary')), 'focus on 保存 after a partial failure');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.ed-foot .ed-confirm');
      expect(/外して閉じ|Close without/.test(await page.locator('.ed-foot .ed-confirm').textContent()), 'nothing to discard but the files: the question says the item is saved');
      await page.click('.ed-foot .ed-confirm .btn-mini:not(.danger)');
      await page.waitForSelector('.ed-foot-note[data-kind="err"]:not([hidden])');

      await page.evaluate(() => { window.__AKARI_MOCK__.failUpload = null; window.__AKARI_MOCK__.uploadDelay = 100; });
      await page.click('.ed-foot .btn-primary');
      await page.waitForSelector('#editor[hidden]', { state: 'attached', timeout: 15000 });
      await page.waitForTimeout(600);
      await ashot('editor-retried');
      expect(await page.locator('#detail .at-dbox .at-ditem').count() === 5, 'five files after the retry');
      await ctx.close();
    };
  }

  out['attach-limits'] = async () => {
    for (const v of [FEATURE_VARIANTS[0], FEATURE_VARIANTS[3]]) {
      const { page, ctx } = await openFeature(`attach-limits-${v.tag}`, v);
      const ashot = (n) => shot(page, `attach-${v.tag}-${n}`);
      await pickItem(page, '家の書類', 'att-full');
      await ashot('detail-ten');
      await editItem(page);
      await page.evaluate(() => { const s = document.querySelector('.ed-scroll'); s.scrollTop = s.scrollHeight; });
      await page.waitForTimeout(200);
      await dropOnAttachments(page, [{ name: 'page-11.txt', size: 100, type: 'text/plain' }]);
      await page.waitForTimeout(300);
      await ashot('editor-full');
      expect(await page.locator('.at-input').getAttribute('aria-disabled') === 'true', 'input aria-disabled at the limit');
      expect(await page.locator('.at-slot').evaluate((el) => getComputedStyle(el).opacity) === '1', 'the limit message keeps full opacity');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      if (await page.locator('.ed-foot .ed-confirm').count()) await page.click('.ed-foot .ed-confirm .btn-mini.danger');
      await page.waitForSelector('#editor[hidden]', { state: 'attached' });

      await page.click('#plusBtn');
      await page.click('#newNote');
      await page.waitForSelector('.at-box');
      await page.waitForTimeout(600);
      await scrollEditorTo(page, '.at-box');
      await ashot('editor-new-empty');
      await page.locator('.at-input').setInputFiles([fakeFile('レシート.pdf', 88 * 1024, 'application/pdf')]);
      await page.fill('#edTitle', v.lang === 'ja' ? '領収書' : 'Receipt');
      await scrollEditorTo(page, '.at-box');
      await ashot('editor-new-queued');
      await page.click('.ed-foot .btn-primary');
      await page.waitForSelector('#editor[hidden]', { state: 'attached', timeout: 15000 });
      const made = await page.evaluate(() => window.__AKARI_DB__.items.at(-1));
      expect(made.type === 'note' && made.attachments?.length === 1 && made.attachments[0].name === 'レシート.pdf', 'a new item gets its file after the first save');
      await ctx.close();
    }
  };

  out['fields-edge'] = async () => {
    for (const v of [FEATURE_VARIANTS[0], FEATURE_VARIANTS[3]]) {
      const { page, ctx } = await openFeature(`fields-edge-${v.tag}`, v);
      const fshot = (n) => shot(page, `fields-${v.tag}-${n}`);
      await page.click('#plusBtn');
      await page.click('#newNote');
      await page.waitForSelector('.xf-box');
      await page.waitForTimeout(600);
      await scrollEditorTo(page, '.xf-box');
      await fshot('empty');
      await page.evaluate(() => { const sc = document.querySelector('.ed-scroll'); sc.scrollTop = sc.scrollHeight; });
      await page.click('.xf-slot');
      await page.waitForTimeout(300);
      await fshot('chooser-bottom');
      await page.keyboard.press('1');
      await page.waitForTimeout(200);
      await page.locator('.xf-row .xf-label').last().fill(v.lang === 'en' ? 'A very long field name that keeps going' : 'とても長い項目名がここに入ってもはみ出さない');
      await page.locator('.xf-row .xf-value').last().fill('line one\nline two\nline three');
      for (let i = 0; i < 99; i++) await page.evaluate(() => document.querySelector('.xf-slot').click() || document.querySelector('.xf-opt').click());
      await page.waitForTimeout(300);
      const n = await page.locator('.xf-row').count();
      expect(n === 100, `limit stops at 100 (got ${n})`);
      expect(await page.locator('.xf-slot[aria-disabled="true"]').count() === 1, 'slot marked disabled at the limit');
      expect(await page.locator('.xf-slot').evaluate((el) => getComputedStyle(el).opacity) === '1', 'the limit message keeps full opacity');
      expect(await page.evaluate(() => document.documentElement.scrollWidth) <= 680, 'the frame does not widen');
      await page.evaluate(() => { const sc = document.querySelector('.ed-scroll'); sc.scrollTop = sc.scrollHeight; });
      await page.waitForTimeout(200);
      await fshot('limit');
      await ctx.close();
    }
  };
  return out;
}
Object.assign(scenarios, featureScenarios());

try {
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !name.includes(only)) continue;
    try {
      await fn();
      console.log('ok  ', name);
    } catch (e) {
      console.log('FAIL', name, e.message.split('\n').slice(0, 10).join('\n     '));
      errors.push(`[${name}] ${e.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (errors.length) {
  console.log('\nconsole errors:');
  for (const e of errors) console.log('  ' + e);
  process.exitCode = 1;
}
