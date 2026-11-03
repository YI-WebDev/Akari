// Screenshots of the real popup (extension/src/popup/popup.html) driven by the chrome mock.
// Output: tests/ui/screenshots/popup-*.png. Usage: node tests/ui/screenshot.mjs [filter]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import QRCode from 'qrcode';
import { launchBrowser } from '../../tools/browser.mjs';
import { startServer } from '../../tools/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screenshots');
const MOCK = join(HERE, 'mock-chrome.js');
const only = process.argv[2] || '';

await mkdir(OUT, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchBrowser();
const errors = [];

async function open(cfg = {}, { reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 430 }, deviceScaleFactor: 1, reducedMotion });
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
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const scenarios = {
  async main() {
    const { page, ctx } = await open({ name: 'main' });
    await page.waitForSelector('.row');
    await settle(page);
    await shot(page, 'main');
    expect(await page.locator('#filters [data-filter="all"] .count').textContent() === '15', 'filter count');
    expect(await page.locator('.row[aria-selected="true"] .tag').textContent() === '2FA', '2FA tag on github');
    expect(/^vault: すべて$/.test(await page.locator('#stVault').textContent()), 'status vault');
    expect(await page.locator('.ticks span').count() === 30, '30 TOTP ticks');
    expect(await page.locator('.pw-col .segs span').count() === 12, '12 meter segments');
    // reveal + copy
    await page.click('.pw-btns .ibtn');
    await settle(page, 700);
    await shot(page, 'revealed');
    await page.click('.pw-btns .ibtn:nth-child(2)');
    await settle(page, 500);
    await shot(page, 'copied');
    await ctx.close();
  },
  async weak() {
    const { page, ctx } = await open({ name: 'weak' });
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
    await page.click('#genApply');
    await settle(page, 1400);
    await shot(page, 'updated');
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
    await page.click('#plusBtn');
    await settle(page, 500);
    await shot(page, 'plusmenu');
    await page.keyboard.press('g'); // the menu's G shortcut
    await page.waitForSelector('#genSheet.open');
    await page.keyboard.press('Escape');
    await settle(page, 500);
    await page.click('#vaultBtn');
    await page.click('#vaultItems .menu-item:has-text("仕事")');
    await settle(page, 800);
    await shot(page, 'vault-work');
    expect(await page.locator('#stVault').textContent() === 'vault: 仕事', 'status vault after switch');
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
    await page.click('#filters [data-filter="fav"]');
    await settle(page, 800);
    await shot(page, 'fav');
    await page.click('#sortBtn');
    await page.click('#filters [data-filter="all"]');
    await settle(page, 800);
    await shot(page, 'az');
    await ctx.close();
  },
  async 'detail-extra'() {
    const { page, ctx } = await open({ name: 'detail-extra' });
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
    // new login with a QR on the "tab"
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
    const { page, ctx } = await open({ name: 'editor-note-delete' });
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
    await ctx.close();
  },
  async settings() {
    const { page, ctx } = await open({ name: 'settings' });
    await page.waitForSelector('.row');
    await page.click('#vaultBtn');
    await page.click('#openSettings');
    await settle(page, 900);
    await shot(page, 'settings');
    expect(await page.locator('[data-setting="theme"]').count() === 0, 'no theme setting');
    await page.click('#pwToggle');
    await page.fill('#pwNext', 'kotatsu-mikan');
    await settle(page, 500);
    await shot(page, 'settings-password');
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
    expect(/^15 件$/.test(await page.locator('.boot-line:nth-child(3) .boot-v').textContent()), 'item count line');
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
  async 'keys-ime-search'() {
    const { page, ctx } = await open({ name: 'keys-ime-search' });
    await page.waitForSelector('.row');
    await settle(page, 400);
    const fire = (key, isComposing) => page.evaluate(([k, c]) => {
      document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: k, isComposing: c, keyCode: c ? 229 : 0, bubbles: true }));
    }, [key, isComposing]);
    await page.focus('#search');
    await page.fill('#search', 'ｇｉｔ'); // fullwidth: NFKC → "git"
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
    await page.fill('#search', 'ｽﾀｼﾞｵ'); // no hit, but must not throw
    await page.fill('#search', 'STUDIO-MORI');
    await settle(page, 300);
    await shot(page, 'search-nfkc');
    await ctx.close();
  },
  async reduced() {
    const { page, ctx } = await open({ name: 'reduced' }, { reducedMotion: 'reduce' });
    await page.waitForSelector('.row');
    await settle(page, 300);
    await shot(page, 'reduced-motion');
    await ctx.close();
  },
};

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
