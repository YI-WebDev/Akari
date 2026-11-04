// Screenshots of the real popup (extension/src/popup/popup.html) driven by the chrome mock.
// Output: tests/ui/screenshots/popup-*.png. Usage: node tests/ui/screenshot.mjs [filter]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { launchBrowser } from '../../tools/browser.mjs';
import { startServer } from '../../tools/serve.mjs';
import { encryptPgp, decryptPgp } from '../../extension/src/lib/pgp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// A Chrome password export: the first row is already in the seed vault (github), so it is a duplicate.
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

/** Settings sheet → インポート / エクスポート page. */
async function openSheetPage(page, opener) {
  await page.click('#vaultBtn');
  await page.click('#openSettings');
  await page.waitForSelector('#setSheet.open');
  await page.waitForTimeout(500);
  await page.click(opener);
}
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
/** Let an earlier toast finish so it does not cover the next screenshot. */
const quiet = (page) => page.waitForSelector('#toast:not(.on)', { state: 'attached', timeout: 5000 });
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const scenarios = {
  async main() {
    const { page, ctx } = await open({ name: 'main' });
    await page.waitForSelector('.row');
    await settle(page);
    await shot(page, 'main');
    expect(await page.locator('#filters [data-filter="all"] .count').textContent() === '32', 'filter count');
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
    await page.click('#pwToggle');

    // 自動ロック「しない」: asks for the master password first and says what it means
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
    const allCount = () => page.locator('#filters [data-filter="all"] .count').textContent().then(Number);
    const rowCount = (name) => page.locator(`#vaultsPage .vm-row:has-text("${name}") .vm-count`).textContent().then((s) => Number(s.match(/\d+/)[0]));
    const total = await allCount();
    await page.click('#vaultBtn');
    await page.click('#manageVaults');
    await page.waitForSelector('#setSheet.open #vaultsPage:not([hidden]) .vm-row');
    await settle(page, 700);
    expect(await page.locator('#vaultsPage .vm-row').count() === 3, 'the three default vaults');
    expect(await page.locator('#setTitle').textContent() === '保管庫', 'page title');
    await shot(page, 'vaults');

    // add: a duplicate name is refused, then 趣味 in purple
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

    // rename 家族
    await page.click('#vaultsPage .vm-row:has-text("家族") [data-act="edit"]');
    expect(await page.inputValue('#vmName') === '家族', 'edit form starts from the name');
    await page.fill('#vmName', '家族・親戚');
    await page.click('#vmSubmit');
    await page.waitForSelector('#vaultsPage .vm-row:has-text("家族・親戚")');

    // delete 仕事, moving its items to 趣味
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

    // delete 家族・親戚 together with its items
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
    const { page, ctx } = await open({ name: 'import' });
    await page.waitForSelector('.row');
    await openSheetPage(page, '#importOpen');
    await page.waitForSelector('.src');
    await settle(page, 700);
    await shot(page, 'import-sources');
    expect(await page.locator('.src').count() === 20, '19 sources + Akari backup');
    expect(await page.locator('#setTrail li.cur').textContent() === '読み込み元', 'trail on step 1');
    expect((await page.locator('.io-lead').textContent()).startsWith('別のパスワードマネージャーから移行するには'), 'lead text');
    // keyboard: the grid is one tab stop, arrows move inside it
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'akari', 'first source focused');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'chrome', 'arrow keys move in a 4-column grid');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.id) === 'brave', 'Home + ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter'); // Chrome
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
    // Bitwarden's password-protected JSON asks for a パスワード instead
    await page.click('#setBack');
    await page.click('#setBack');
    await page.click('.src[data-id="bitwarden"]');
    await page.setInputFiles('#impFile', { name: 'bitwarden_encrypted_export.json', mimeType: 'application/json', buffer: Buffer.from(BW_PROTECTED) });
    await page.waitForSelector('.io-pass:not([hidden])');
    expect(await page.locator('label[for="impPw"]').textContent() === 'パスワード', 'Bitwarden asks for a password');
    // Bitwarden export with cards / identities / passkeys → notes + warnings
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
    // dropped on the source list: the format is detected (Chrome CSV) and parsed
    expect(await drop('passwords.csv', CHROME_CSV, 'drop'), 'drop handled (no navigation)');
    await page.waitForSelector('.io-stats');
    expect((await page.locator('.io-cmd-text').textContent()).includes('--from chrome passwords.csv'), 'detected Chrome');
    expect(!(await page.locator('#setSheet').getAttribute('class')).includes('dragging'), 'drag highlight cleared');
    // dropped on the file step of a chosen source
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
    await page.keyboard.press('ArrowDown'); // CSV
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
    await page.click('#expPgp');
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
  async 'types-list'() {
    const { page, ctx } = await open({ name: 'types-list' });
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
    // search: non-secret field values match, secret values never do
    await page.fill('#search', 'StudioMori-5G');
    await settle(page, 300);
    expect((await page.locator('.row').evaluateAll((r) => r.map((x) => x.dataset.id))).join() === 'wifi-office', 'ssid is searchable');
    for (const secret of ['kinoko-takenoko', '3540618291742302', 'Pg!Mori-Prod', 'BEGIN OPENSSH', '7KQ2-M9XP']) {
      await page.fill('#search', secret);
      await settle(page, 150);
      expect(await page.locator('.row').count() === 0, 'secret value matched the search: ' + secret);
    }
    await page.fill('#search', '1234-5678-9012'); // a non-secret extra field (aws アカウント ID)
    await settle(page, 200);
    expect(await page.locator('.row[data-id="aws"]').count() === 1, 'non-secret extra fields are searchable');
    await page.keyboard.press('Escape');
    // 種類 menu: grouped, with counts, keyboard reachable
    await page.click('#typeBtn');
    await page.waitForSelector('#typeMenu.open');
    await settle(page, 500);
    await shot(page, 'type-menu');
    expect(await page.locator('#typeMenu .tp-cell').count() === 19, 'すべての種類 + 18 types');
    expect(await page.locator('#typeMenu .tp-group').count() === 4, 'four groups');
    expect(await page.locator('#typeMenu .tp-cell[data-type="card"] .v-count').textContent() === '2', 'card count');
    expect(await page.evaluate(() => document.activeElement?.dataset.type) === 'all', 'すべての種類 focused');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.dataset.type) === 'card', '↓ goes to the nearest cell below');
    await page.keyboard.press('Enter');
    await settle(page, 800);
    await shot(page, 'type-filter-card');
    expect((await page.locator('.row').evaluateAll((r) => r.map((x) => x.dataset.id))).sort().join() === 'card-jcb,card-visa-old', 'only cards');
    expect(await page.locator('#typeLabel').textContent() === 'クレジットカード', 'chip shows the type');
    expect(await page.locator('#filters [data-filter="all"] .count').textContent() === '2', 'counts follow the type');
    expect(await page.locator('#stCount').textContent() === '2 件', 'status count');
    expect(await page.locator('.af').count() === 0, 'no autofill card while filtering cards');
    await page.click('#filters [data-filter="fav"]');
    await settle(page, 400);
    expect(await page.locator('.row').count() === 1, '★ and 種類 combine');
    await page.click('#filters [data-filter="all"]');
    // no cards in 家族: the empty state offers a new card in that vault
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
    await page.click('#typeClear');
    await settle(page, 600);
    expect(await page.locator('#filters [data-filter="all"] .count').textContent() === '32', 'cleared');
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
    await page.keyboard.press('n'); // N: secure note
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
    const { page, ctx } = await open({ name: 'detail-types' });
    await page.waitForSelector('.row');
    const pick = async (id) => { await page.click(`.row[data-id="${id}"]`); await settle(page, 900); };
    const reveal = (sel) => page.click(`${sel} .ibtn[aria-pressed]`);
    await pick('card-jcb');
    await shot(page, 'detail-card');
    expect(await page.locator('.card-num').textContent() === '•••• •••• •••• 2302', 'card number masked with the last 4');
    expect(await page.locator('.cardline .cl-brand').textContent() === 'JCB', 'brand on the card line');
    expect(await page.locator('.f-sub').textContent() === 'JCB', 'brand next to the label');
    expect(/08\/29$/.test(await page.locator('.cardline .cl-exp').textContent()), 'expiry MM/YY');
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
    // ⏎ copies a templated item's first secret
    await pick('wifi-office');
    await page.keyboard.press('Enter');
    await settle(page, 300);
    expect(await page.locator('#toastMsg').textContent() === 'パスワードをコピーしました', 'Enter copies the Wi-Fi password');
    // lock wipes revealed values
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
    const { page, ctx } = await open({ name: 'editor-types' });
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
    // a new database with extra fields
    await page.click('#plusBtn');
    await page.click('#newOther');
    await page.click('#plusMenu [data-type="database"]');
    await page.waitForSelector('.ed-form[data-type="database"]');
    await page.fill('#edF-dbType', 'MySQL 8.4');
    await page.fill('#edF-host', 'mysql.studio-mori.internal');
    await page.fill('#edF-port', '３３０６'); // full-width digits from an IME
    await page.fill('#edF-database', 'shop');
    await page.fill('#edF-username', 'shop_app');
    await page.click('.ed-row:has(#edF-password) .ibtn[title="パスワード生成"]');
    await page.waitForSelector('#genSheet.open');
    await settle(page, 500);
    await page.click('#genApply');
    await settle(page, 400);
    await page.click('.ex-head .btn-line');
    await page.fill('.ex-row:nth-child(1) .ex-label', '文字コード');
    await page.fill('.ex-row:nth-child(1) .ex-value', 'utf8mb4');
    await page.click('.ex-head .btn-line');
    await page.fill('.ex-row:nth-child(2) .ex-label', 'root パスワード');
    await page.fill('.ex-row:nth-child(2) .ex-value', 'R00t!Shop-2026');
    await page.click('.ex-row:nth-child(2) .ex-secret');
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
    expect(JSON.stringify(db.extra) === JSON.stringify([{ label: '文字コード', value: 'utf8mb4', secret: false }, { label: 'root パスワード', value: 'R00t!Shop-2026', secret: true }]), 'stored extra');
    expect(await page.locator('.row[aria-selected="true"] .tag').textContent() === 'DB', 'new row selected with its tag');
    // extra fields on a login, and an extra without a name is refused
    await page.click('.row[data-id="github"]');
    await settle(page, 500);
    await page.click('.d-head .ibtn[title="編集"]');
    await page.click('.ex-head .btn-line');
    await page.fill('.ex-row .ex-value', 'value without a name');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 300);
    expect(await page.locator('.ex-row .field-err').textContent() === '項目名を入力してください', 'extra needs a label');
    await page.fill('.ex-row .ex-label', 'リカバリーコード');
    await page.click('.ex-row .ex-secret');
    await page.click('.ed-foot .btn-primary');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    const gh = await dbItem('github');
    expect(gh.extra?.[0]?.label === 'リカバリーコード' && gh.extra[0].secret === true && gh.totp?.secret, 'login extra saved, TOTP kept');
    await ctx.close();
  },
  async 'editor-roundtrip'() {
    // stored values the editor would format or validate differently are saved untouched
    const OLD_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----\n';
    const { page, ctx } = await open({
      name: 'editor-roundtrip',
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
    // typed values: SW rules (years 1000–9999, any CVV), whitespace kept for secrets
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
    // a row the user adds still needs a name
    await page.click('.d-head .ibtn[title="編集"]');
    await page.click('.ex-head .btn-line');
    await page.fill('.ex-row:last-child .ex-value', 'no name');
    await page.click('.ed-foot .btn-primary');
    await settle(page, 300);
    expect(await page.locator('.ex-row:last-child .field-err').textContent() === '項目名を入力してください', 'new extra needs a name');
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
