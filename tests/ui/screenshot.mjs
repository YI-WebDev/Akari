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
  'github.com,https://github.com/login,haruka.dev@gmail.com,v8#Lq2!mTz9@rWk4pE,',
  'booking.com,https://www.booking.com/,haruka.sato@gmail.com,Tabi!Kyoto#2026,',
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
