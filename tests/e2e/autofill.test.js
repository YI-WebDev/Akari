import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { launch, extensionMessenger, serveStatic, MASTER, ROOT } from './helpers.js';
import { generateTotp } from '../../extension/src/lib/totp.js';

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

const SAVE_BAR_BUTTON_AT = [1000 - 62, 160];

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

const rectOf = (page, selector) => page.locator(selector).evaluate((e) => {
  const b = e.getBoundingClientRect();
  return { x: b.x, right: b.right, y: b.y, h: b.height, bottom: b.bottom };
});
const menuRowUnder = (r) => [r.x + 80, r.bottom + 32];

async function openSignUp(email) {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/signup.html');
  await page.fill('#email', email);
  await page.locator('#new-password').click();
  await page.waitForTimeout(1300);
  return page;
}

test('sign-up: focusing the new password suggests a strong one, fills both fields and saves on request', async () => {
  const email = 'suggest-save@example.jp';
  const page = await openSignUp(email);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#new-password')));
  await page.waitForTimeout(300);
  const password = await page.inputValue('#new-password');
  assert.equal(password.length, 20, 'the suggestion was filled without clicking the 灯 button first');
  assert.equal(await page.inputValue('#confirm-password'), password);
  assert.equal((await send('vault/getAll')).data.items.some((i) => i.username === email), false, 'nothing is saved before the user agrees');

  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const item = (await send('vault/getAll')).data.items.find((i) => i.username === email);
  assert.equal(item.password, password);
  assert.equal(item.url, site.origin);

  const count = (await send('vault/getAll')).data.items.length;
  await page.click('#submit');
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  assert.equal((await send('vault/getAll')).data.items.length, count, 'submitting the form does not offer the saved login again');
  await page.close();
});

test('sign-up: what is saved is what the form holds when the user agrees, not the first suggestion', async () => {
  const email = 'suggest-edit@example.jp';
  const page = await openSignUp(email);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#new-password')));
  await page.waitForTimeout(300);
  const suggested = await page.inputValue('#new-password');
  assert.equal(suggested.length, 20);
  const edited = suggested.replace(/[^a-zA-Z0-9]/g, '') + 'Zz9';
  await page.fill('#new-password', edited);
  await page.fill('#confirm-password', edited);
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const item = (await send('vault/getAll')).data.items.find((i) => i.username === email);
  assert.equal(item.password, edited);
  await page.close();
});

test('sign-up: typing your own password dismisses the suggestion', async () => {
  const page = await openSignUp('suggest-own@example.jp');
  const row = menuRowUnder(await rectOf(page, '#new-password'));
  await page.keyboard.type('my-own-pass-1');
  await page.waitForTimeout(300);
  await page.mouse.click(...row);
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#new-password'), 'my-own-pass-1');
  assert.equal(await page.inputValue('#confirm-password'), '');
  await page.close();
});

test('sign-up: the suggestion is not offered on a sign-in form', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/login.html');
  await page.locator('#password').click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#password')));
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#password'), '', 'a current-password field gets no generated password');
  await page.close();
});

test('sign-up: with a nickname and plainly named mail fields, the mail address is saved as the username', async () => {
  const email = 'kumamero@example.jp';
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/signup-nickname.html');
  await page.fill('#nickname', 'くまめろ');
  await page.fill('#mail', email);
  await page.fill('#mail-confirm', email);
  await page.locator('#pass').click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#pass')));
  await page.waitForTimeout(300);
  const password = await page.inputValue('#pass');
  assert.equal(password.length, 20);
  assert.equal(await page.inputValue('#pass-confirm'), password, 'two unmarked password fields are a new password and its confirmation');
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const items = (await send('vault/getAll')).data.items;
  assert.equal(items.find((i) => i.password === password)?.username, email);
  assert.equal(items.some((i) => i.username === 'くまめろ'), false);
  await page.close();
});

test('sign-up: an address typed after the password still ends up in the saved login', async () => {
  const email = 'suggest-late@example.jp';
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/signup.html');
  await page.locator('#new-password').click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#new-password')));
  await page.waitForTimeout(300);
  const password = await page.inputValue('#new-password');
  assert.equal(password.length, 20);
  await page.locator('#email').pressSequentially(email);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const item = (await send('vault/getAll')).data.items.find((i) => i.password === password);
  assert.equal(item?.username, email);
  await page.close();
});

test('sign-up: the 灯 button stays after filling and offers another password that replaces both fields', async () => {
  const page = await openSignUp('suggest-again@example.jp');
  const r = await rectOf(page, '#new-password');
  await page.mouse.click(...menuRowUnder(r));
  await page.waitForTimeout(1000);
  const first = await page.inputValue('#new-password');
  assert.equal(first.length, 20);

  await page.mouse.click(...menuRowUnder(r));
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#new-password'), first, 'with a password in the field the suggestion does not open by itself');

  await page.locator('#new-password').focus();
  await page.waitForTimeout(600);
  await page.mouse.click(r.right - 18, r.y + r.h / 2);
  await page.waitForTimeout(1000);
  await page.mouse.click(...menuRowUnder(r));
  await page.waitForTimeout(300);
  const second = await page.inputValue('#new-password');
  assert.equal(second.length, 20);
  assert.notEqual(second, first);
  assert.equal(await page.inputValue('#confirm-password'), second);
  await page.close();
});

test('sign-up: emptying the field brings the suggestion back, every time', async () => {
  const page = await openSignUp('suggest-empty@example.jp');
  const r = await rectOf(page, '#new-password');
  await page.mouse.click(...menuRowUnder(r));
  await page.waitForTimeout(1000);
  let last = await page.inputValue('#new-password');
  assert.equal(last.length, 20);

  for (let round = 0; round < 2; round++) {
    await page.locator('#new-password').focus();
    await page.waitForTimeout(600);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(1000);
    await page.mouse.click(...menuRowUnder(r));
    await page.waitForTimeout(1000);
    const next = await page.inputValue('#new-password');
    assert.equal(next.length, 20, 'round ' + round);
    assert.notEqual(next, last);
    assert.equal(await page.inputValue('#confirm-password'), next);
    last = next;
  }

  await page.locator('#email').focus();
  await page.waitForTimeout(400);
  await page.evaluate(() => { for (const id of ['new-password', 'confirm-password']) document.getElementById(id).value = ''; });
  await page.locator('#new-password').click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(r));
  await page.waitForTimeout(300);
  assert.equal((await page.inputValue('#new-password')).length, 20, 'focusing the emptied field opens the suggestion again');
  await page.close();
});

test('a password the user typed in the other field is never replaced by a suggestion', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto(site.origin + '/signup-nickname.html');
  await page.locator('#pass').click();
  await page.keyboard.type('Current-Pass-1');
  await page.locator('#pass-confirm').click();
  await page.waitForTimeout(1300);
  const r = await rectOf(page, '#pass-confirm');
  const row = [r.x + 200, r.bottom + 32];
  await page.mouse.click(...row);
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#pass-confirm'), '', 'the suggestion does not open by itself next to a typed password');
  assert.equal(await page.inputValue('#pass'), 'Current-Pass-1');

  await page.locator('#pass-confirm').focus();
  await page.waitForTimeout(600);
  await page.mouse.click(r.right - 18, r.y + r.h / 2);
  await page.waitForTimeout(1000);
  await page.mouse.click(...row);
  await page.waitForTimeout(300);
  assert.equal((await page.inputValue('#pass-confirm')).length, 20, 'asked for through the 灯 button, it fills the field it was asked on');
  assert.equal(await page.inputValue('#pass'), 'Current-Pass-1', 'and leaves the typed password alone');

  const taken = await page.inputValue('#pass-confirm');
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const passwords = (await send('vault/getAll')).data.items.map((i) => i.password);
  assert.ok(passwords.includes(taken), 'what Akari offers to save is the suggestion the user took');
  assert.ok(!passwords.includes('Current-Pass-1'), 'not the password typed in the other field');
  await page.close();
});

const ADDRESS_FIELDS = ['name', 'kana', 'zip1', 'zip2', 'pref', 'addr1', 'addr2', 'tel', 'mail'];
const valuesOf = (page, ids) => page.evaluate((list) => Object.fromEntries(list.map((id) => [id, document.getElementById(id).value])), ids);
const HOME = {
  type: 'identity', title: '自宅', vault: 'personal',
  fields: {
    lastName: '熊野', firstName: 'めろ', email: 'kumamero@example.jp', phone: '090-1234-5678',
    postalCode: '150-0001', state: '東京都', city: '渋谷区', address1: '神宮前1-2-3', address2: 'あかりビル 401',
  },
};

async function chooseOnAddressField(file, selector, prepare) {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(site.origin + '/' + file);
  if (prepare) await prepare(page);
  await page.locator(selector).click();
  await page.waitForTimeout(2000);
  const r = await rectOf(page, selector);
  await page.mouse.click(r.x + 200, r.bottom + 32);
  await page.waitForTimeout(600);
  return page;
}

test('address form: with no identity saved there is nothing to choose', async () => {
  const page = await chooseOnAddressField('address.html', '#addr1');
  assert.deepEqual(await valuesOf(page, ADDRESS_FIELDS), { name: '', kana: '', zip1: '', zip2: '', pref: '', addr1: '', addr2: '', tel: '', mail: '' });
  await page.close();
});

test('address form: choosing a saved identity fills the address fields only, and leaves typed ones alone', async () => {
  const saved = await send('vault/saveItem', { item: HOME });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const page = await chooseOnAddressField('address.html', '#addr1', (p) => p.fill('#zip1', '999'));
  assert.deepEqual(await valuesOf(page, ADDRESS_FIELDS), {
    name: '',
    kana: '',
    zip1: '999',
    zip2: '0001',
    pref: '13',
    addr1: '渋谷区神宮前1-2-3',
    addr2: 'あかりビル 401',
    tel: '',
    mail: '',
  });
  await page.close();
});

test('address form: fields the user cannot see get nothing', async () => {
  const page = await chooseOnAddressField('address.html', '#addr1', (p) => p.evaluate(() => {
    const zip1 = document.getElementById('zip1').getBoundingClientRect();
    const cover = document.createElement('div');
    cover.style.cssText = `position:absolute;pointer-events:none;left:${zip1.left + scrollX}px;top:${zip1.top + scrollY}px;width:${zip1.width}px;height:${zip1.height}px;background:#fff`;
    document.body.append(cover);
    document.getElementById('zip2').style.clipPath = 'inset(calc(50% - 1px))';
    document.getElementById('addr2').style.filter = 'opacity(0)';
    const late = document.createElement('input');
    late.id = 'late';
    late.name = 'city';
    document.getElementById('address-form').append(late);
    late.style.marginTop = '3000px';
  }));
  assert.deepEqual(await valuesOf(page, [...ADDRESS_FIELDS, 'late']), {
    name: '',
    kana: '',
    zip1: '',
    zip2: '',
    pref: '13',
    addr1: '神宮前1-2-3',
    addr2: '',
    tel: '',
    mail: '',
    late: '',
  }, 'covered (even by something clicks pass through), clipped, filtered and off-screen fields stay empty');
  await page.close();
});

test('address form: nested field names, a name that beats its label and placeholder, and fields that are not addresses', async () => {
  const page = await chooseOnAddressField('address-tricky.html', '#addr01');
  assert.deepEqual(await valuesOf(page, ['zip', 'pref', 'addr01', 'addr02', 'kana', 'mail', 'ship']), {
    zip: '150-0001',
    pref: '13',
    addr01: '渋谷区神宮前1-2-3',
    addr02: 'あかりビル 401',
    kana: '',
    mail: '',
    ship: '渋谷区神宮前1-2-3',
  });
  await page.close();
});

test('address form: a real click (press, hold, release) still fills the fields the menu will cover', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(site.origin + '/address.html');
  const r = await rectOf(page, '#zip1');
  await page.mouse.move(r.x + 20, r.y + r.h / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(2000);
  await page.mouse.click(r.x + 100, r.bottom + 32);
  await page.waitForTimeout(600);
  const got = await valuesOf(page, ['zip1', 'zip2', 'pref', 'addr1', 'addr2']);
  assert.deepEqual(got, { zip1: '150', zip2: '0001', pref: '13', addr1: '渋谷区神宮前1-2-3', addr2: 'あかりビル 401' });
  await page.close();
});

test('address form: second address lines named street[1] or told apart only by their label get the building, not the street again', async () => {
  const page = await chooseOnAddressField('address-lines.html', '#street0');
  assert.deepEqual(await valuesOf(page, ['postcode', 'region', 'city', 'street0', 'street1', 'extra']), {
    postcode: '150-0001',
    region: '13',
    city: '渋谷区',
    street0: '神宮前1-2-3',
    street1: 'あかりビル 401',
    extra: 'あかりビル 401',
  });
  await page.close();
});

test('sign-up: when Akari locks after the suggestion opened, the password is not put into the form', async () => {
  const page = await openSignUp('suggest-locked@example.jp');
  const r = await rectOf(page, '#new-password');
  assert.equal((await send('vault/lock')).ok, true);
  try {
    await page.mouse.click(...menuRowUnder(r));
    await page.waitForTimeout(600);
    assert.equal(await page.inputValue('#new-password'), '', 'a password that cannot be offered for saving stays out of the form');
    assert.equal(await page.inputValue('#confirm-password'), '');
  } finally {
    assert.equal((await send('vault/unlock', { masterPassword: MASTER })).ok, true);
  }
  await page.close();
});

const loopback = () => 'http://127.0.0.1:' + new URL(site.origin).port;
const loginsAt = async (origin) => (await send('vault/getAll')).data.items.filter((i) => i.type === 'login' && String(i.url).startsWith(origin));

async function takeSuggestion(url, selector, prepare) {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(url);
  if (prepare) await prepare(page);
  await page.locator(selector).click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(await rectOf(page, selector)));
  await page.waitForTimeout(300);
  const password = await page.inputValue(selector);
  assert.equal(password.length, 20);
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  return { page, password };
}

test('password change: a suggestion taken there updates the only saved login', async () => {
  const origin = loopback();
  assert.deepEqual(await loginsAt(origin), [], 'this origin starts without logins');
  const only = await send('vault/saveItem', {
    item: { type: 'login', title: '127.0.0.1', url: origin + '/', username: 'only@example.jp', password: 'Only-Pass-1', vault: 'personal' },
  });
  assert.equal(only.ok, true);
  const { page, password } = await takeSuggestion(origin + '/change-password.html', '#new', (p) => p.fill('#current', 'Only-Pass-1'));
  assert.equal(await page.inputValue('#current'), 'Only-Pass-1');
  assert.equal(await page.inputValue('#confirm'), password);
  const logins = await loginsAt(origin);
  assert.deepEqual(logins.map((i) => [i.username, i.password]), [['only@example.jp', password]], 'updated, not saved as a second login');
  await page.close();
});

test('password reset: with only new-password fields on the page, a suggestion still updates the only saved login', async () => {
  const origin = loopback();
  const { page, password } = await takeSuggestion(origin + '/reset-password.html', '#new');
  assert.deepEqual((await loginsAt(origin)).map((i) => [i.username, i.password]), [['only@example.jp', password]]);
  await page.close();
});

test('sign-up: a suggestion taken before any username is typed is saved as a new login, not over the only saved one', async () => {
  const origin = loopback();
  const before = await loginsAt(origin);
  assert.deepEqual(before.map((i) => i.username), ['only@example.jp'], 'the site has exactly one saved login');
  const { page, password } = await takeSuggestion(origin + '/signup.html', '#new-password');
  const after = await loginsAt(origin);
  assert.equal(after.find((i) => i.username === 'only@example.jp').password, before[0].password, 'the saved login keeps its password');
  assert.equal(after.find((i) => i.password === password)?.username, '', 'the suggestion is its own login');
  assert.equal(after.length, 2);
  await page.close();
});

test('saving after sign-in: a filled field before the password is the username, not an empty mail field after it', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/login-newsletter.html');
  await page.fill('#contract', 'K-20261110');
  await page.fill('#pw', 'Contract-Pass-7');
  await page.click('#submit');
  await page.waitForSelector('#status[data-state="submitted"]');
  await page.waitForTimeout(1300);
  await page.mouse.click(...SAVE_BAR_BUTTON_AT);
  await page.waitForTimeout(500);
  const item = (await send('vault/getAll')).data.items.find((i) => i.password === 'Contract-Pass-7');
  assert.equal(item?.username, 'K-20261110');
  await page.close();
});

const CODE_SECRET = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 };
const nearbyCodes = async () => Promise.all([0, -30000].map((shift) => generateTotp(CODE_SECRET, Date.now() + shift)));

test('two-factor: right after Akari filled the login, the code is filled without a click', async () => {
  const saved = await send('vault/saveItem', { item: {
    type: 'login', title: 'localhost 2FA', url: site.origin + '/', username: 'totp-user@example.jp', password: 'Totp-Pass-1',
    totp: CODE_SECRET, vault: 'personal',
  } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/login.html');
  await page.bringToFront();
  const filled = await send('autofill/fill', { tabId: await tabIdOf(site.origin + '/login.html'), itemId: saved.data.item.id });
  assert.deepEqual(filled, { ok: true, data: { filled: true } });
  await page.goto(site.origin + '/two-factor.html');
  await page.waitForFunction(() => document.querySelector('#code').value.length === 6, null, { timeout: 5000 });
  const code = await page.inputValue('#code');
  assert.ok((await nearbyCodes()).includes(code), 'the field that had the focus holds the current code: ' + code);

  await page.fill('#code', '');
  await page.locator('#submit').focus();
  await page.locator('#code').click();
  await page.waitForTimeout(800);
  assert.equal(await page.inputValue('#code'), '', 'only once: after that the user chooses');
  await page.close();
});

test('two-factor: without a fill just before, the code is in the menu and filled on choice, into split boxes too', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(site.origin + '/two-factor.html');
  await page.locator('#code').click();
  await page.waitForTimeout(1300);
  assert.equal(await page.inputValue('#code'), '', 'nothing by itself');
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#code')));
  await page.waitForTimeout(500);
  assert.ok((await nearbyCodes()).includes(await page.inputValue('#code')));

  await page.goto(site.origin + '/two-factor-split.html');
  await page.locator('#d1').click();
  await page.waitForTimeout(1300);
  const r = await rectOf(page, '#d1');
  await page.mouse.click(r.x + 100, r.bottom + 32);
  await page.waitForTimeout(500);
  const digits = await valuesOf(page, ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
  assert.ok((await nearbyCodes()).includes(Object.values(digits).join('')), 'one digit in each box: ' + JSON.stringify(digits));
  await page.close();
});

test('two-factor: a code is offered on fields that ask for one, and not on fields that only look alike', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(site.origin + '/two-factor-fields.html');
  const chooseUnder = async (selector) => {
    await page.locator(selector).click();
    await page.waitForTimeout(1300);
    await page.mouse.click(...menuRowUnder(await rectOf(page, selector)));
    await page.waitForTimeout(500);
    return page.inputValue(selector);
  };
  for (const selector of ['#app_totp', '#verify']) {
    assert.match(await chooseUnder(selector), /^\d{6}$/, selector + ' asks for a code');
  }
  for (const selector of ['#hotpepper', '#sms', '#cvc']) {
    assert.equal(await chooseUnder(selector), '', selector + ' does not ask for an authenticator code');
  }
  await page.close();
});

test('two-factor: on a site without a saved code, nothing is offered', async () => {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(loopback() + '/two-factor.html');
  await page.locator('#code').click();
  await page.waitForTimeout(1300);
  await page.mouse.click(...menuRowUnder(await rectOf(page, '#code')));
  await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#code'), '');
  await page.close();
});

const DEFAULT_MAIL = 'akari.default@example.jp';
const OFFERED_FIELDS = ['#mail', '#mail2', '#contact', '#loginid'];
const NOT_OFFERED_FIELDS = ['#friend', '#find', '#to', '#dest', '#code', '#server', '#member', '#sender', '#q', '#tel'];
const MENU_ROW_HEIGHT = 42;

async function openPage(url) {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(url);
  return page;
}

const akariHosts = (target) => target.evaluate(() => [...document.documentElement.children]
  .filter((n) => n.tagName === 'DIV' && n.style.zIndex === '2147483647').length);

const menuCovers = (page, [x, y]) => page.evaluate(([px, py]) => {
  const top = document.elementFromPoint(px, py);
  return !!top && top.parentElement === document.documentElement && top.style.zIndex === '2147483647';
}, [x, y]);

const rowUnder = (r, row = 0) => [r.x + 80, r.bottom + 32 + row * MENU_ROW_HEIGHT];

async function focusField(page, selector) {
  await page.locator(selector).click();
  await page.waitForTimeout(1500);
  return rectOf(page, selector);
}

async function chooseUnderField(page, selector, row = 0) {
  const r = await focusField(page, selector);
  await page.mouse.click(...rowUnder(r, row));
  await page.waitForTimeout(600);
  return page.inputValue(selector);
}

async function forgetMailAddresses() {
  const identities = (await send('vault/getAll')).data.items.filter((i) => i.type === 'identity').map((i) => i.id);
  if (identities.length) assert.equal((await send('vault/deleteItems', { ids: identities })).ok, true);
  assert.deepEqual((await send('vault/setDefaultEmail', { email: '' })).data, { defaultEmail: '' });
}

test('mail field: with no default address and no identity there is nothing to choose', async () => {
  await forgetMailAddresses();
  const page = await openPage(site.origin + '/email-fields.html');
  const r = await focusField(page, '#mail');
  assert.equal(await akariHosts(page), 0, 'neither the button nor a menu is put on the page');
  await page.mouse.click(...rowUnder(r));
  await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#mail'), '');
  await page.close();
});

test('mail field: the default address is offered on focus, and one click puts it into that field only', async () => {
  assert.deepEqual((await send('vault/setDefaultEmail', { email: ` ${DEFAULT_MAIL} ` })).data, { defaultEmail: DEFAULT_MAIL });
  const page = await openPage(site.origin + '/email-fields.html');
  const r = await focusField(page, '#mail');
  assert.equal(await akariHosts(page), 1);
  assert.equal(await menuCovers(page, rowUnder(r)), true, 'the menu opened by itself');
  await page.mouse.click(...rowUnder(r));
  await page.waitForTimeout(600);
  const ids = [...OFFERED_FIELDS, ...NOT_OFFERED_FIELDS].map((s) => s.slice(1));
  assert.deepEqual(await valuesOf(page, ids), Object.fromEntries(ids.map((id) => [id, id === 'mail' ? DEFAULT_MAIL : ''])));
  await page.close();
});

test('mail field: fields that ask for your address by name, placeholder or input mode get the offer', async () => {
  const page = await openPage(site.origin + '/email-fields.html');
  for (const selector of OFFERED_FIELDS.slice(1)) assert.equal(await chooseUnderField(page, selector), DEFAULT_MAIL, selector);
  await page.close();
});

test('mail field: fields for another person, a recipient, a code, mail settings, a name or a search get neither the button nor the menu', async () => {
  const page = await openPage(site.origin + '/email-fields.html');
  await focusField(page, '#mail');
  assert.equal(await akariHosts(page), 1, 'the page is one where Akari does make the offer');
  for (const selector of NOT_OFFERED_FIELDS) {
    await page.locator(selector).click();
    await page.waitForTimeout(900);
    assert.equal(await akariHosts(page), 0, selector);
  }
  await page.close();
});

test('mail field: typing your own address closes the offer, and emptying the field brings it back', async () => {
  const page = await openPage(site.origin + '/email-fields.html');
  const r = await focusField(page, '#mail');
  assert.equal(await menuCovers(page, rowUnder(r)), true);
  await page.keyboard.type('me@');
  await page.waitForTimeout(300);
  assert.equal(await menuCovers(page, rowUnder(r)), false, 'closed while the field holds text');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(1500);
  assert.equal(await menuCovers(page, rowUnder(r)), true, 'back once the field is empty');
  await page.mouse.click(...rowUnder(r));
  await page.waitForTimeout(600);
  assert.equal(await page.inputValue('#mail'), DEFAULT_MAIL);
  await page.close();
});

test('mail field: addresses saved in identities are listed under the default', async () => {
  assert.equal((await send('vault/saveItem', { item: HOME })).ok, true);
  const page = await openPage(site.origin + '/email-fields.html');
  assert.equal(await chooseUnderField(page, '#mail', 1), HOME.fields.email);
  await page.close();
});

test('mail field: a sign-up form and a sign-in form with no saved login offer the default', async () => {
  const signUp = await openPage(site.origin + '/signup.html');
  assert.equal(await chooseUnderField(signUp, '#email'), DEFAULT_MAIL);
  await signUp.close();

  const known = (await loginsAt(loopback())).map((i) => i.id);
  if (known.length) assert.equal((await send('vault/deleteItems', { ids: known })).ok, true);
  const fresh = await openPage(loopback() + '/login.html');
  assert.equal(await chooseUnderField(fresh, '#username'), DEFAULT_MAIL);
  assert.equal(await fresh.inputValue('#password'), '');
  await fresh.close();
});

test('mail field: a sign-in form with saved logins keeps its button and offers those logins, not the mail menu', async () => {
  assert.equal((await send('vault/saveItem', { item: { type: 'login', title: 'Fixture', url: site.origin, username: 'saved-user', password: 'Saved-Pass-1', vault: 'personal' } })).ok, true);
  const usernames = (await loginsAt(site.origin)).map((i) => i.username);
  const page = await openPage(site.origin + '/login.html');
  const r = await focusField(page, '#username');
  assert.equal(await akariHosts(page), 1, 'the button is there');
  assert.equal(await menuCovers(page, rowUnder(r)), false, 'no menu opens by itself');
  await page.mouse.click(r.right - 18, r.y + r.h / 2);
  await page.waitForTimeout(900);
  assert.equal(await menuCovers(page, rowUnder(r)), true, 'the button opens the list of logins');
  await page.mouse.click(...rowUnder(r));
  await page.waitForTimeout(600);
  const filledUser = await page.inputValue('#username');
  assert.ok(usernames.includes(filledUser) && filledUser !== DEFAULT_MAIL, `a saved login was filled, got ${JSON.stringify(filledUser)}`);
  assert.notEqual(await page.inputValue('#password'), '');
  await page.close();
});

test('mail field: a form inside a frame gets neither the button nor the menu', async () => {
  const page = await openPage(site.origin + '/email-frame.html');
  const frame = page.frame({ url: /email-fields\.html/ });
  const mail = page.frameLocator('#embedded').locator('#mail');
  await mail.click();
  await page.waitForTimeout(1500);
  assert.equal(await akariHosts(frame), 0, 'nothing inside the frame');
  assert.equal(await akariHosts(page), 0, 'nothing in the page around it');
  const box = await mail.boundingBox();
  await page.mouse.click(box.x + 80, box.y + box.height + 32);
  await page.waitForTimeout(600);
  assert.equal(await mail.inputValue(), '');
  await page.close();
});

test('mail field: nothing is offered while Akari is locked, and the offer is back after unlocking', async () => {
  const page = await openPage(site.origin + '/email-fields.html');
  assert.equal((await send('vault/lock')).ok, true);
  try {
    const r = await focusField(page, '#mail');
    assert.equal(await akariHosts(page), 0, 'neither the button nor a menu while locked');
    await page.mouse.click(...rowUnder(r));
    await page.waitForTimeout(400);
    assert.equal(await page.inputValue('#mail'), '');
  } finally {
    assert.equal((await send('vault/unlock', { masterPassword: MASTER })).ok, true);
  }
  assert.equal(await chooseUnderField(page, '#mail2'), DEFAULT_MAIL);
  await page.close();
});

test('in-page menu: fonts supplied by the page never learn what the menu draws', async () => {
  const letters = [...'abcdefghijklmnopqrstuvwxyz0123456789@._+-自宅'];
  const families = ['ui-monospace', 'Cascadia Mono', 'Consolas', 'BIZ UDGothic', 'Courier New', 'MS Gothic', 'Meiryo', 'Yu Gothic UI', 'monospace'];
  const hex = (c) => c.codePointAt(0).toString(16).padStart(4, '0');
  const faces = families.flatMap((family) => letters.map((c) =>
    `@font-face { font-family: "${family}"; src: url(/leak?c=${hex(c)}); unicode-range: U+${hex(c)}; }`)).join('\n');
  const leaked = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/leak') {
      leaked.add(String.fromCodePoint(parseInt(url.searchParams.get('c'), 16)));
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><style>${faces}</style><body><input id="mail" type="email" autofocus></body>`);
  });
  await new Promise((r) => server.listen(0, r));
  try {
    assert.equal((await send('vault/setDefaultEmail', { email: 'zq@xy.jp' })).ok, true);
    const page = await openPage(`http://localhost:${server.address().port}/`);
    await page.waitForTimeout(2500);
    const r = await rectOf(page, '#mail');
    assert.equal(await menuCovers(page, rowUnder(r)), true, 'the menu is drawn, with the addresses in it');
    assert.deepEqual([...leaked].sort(), [], 'no font was fetched for a character the menu shows');
    await page.mouse.click(...rowUnder(r));
    await page.waitForTimeout(600);
    assert.equal(await page.inputValue('#mail'), 'zq@xy.jp');
    await page.close();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    assert.equal((await send('vault/setDefaultEmail', { email: DEFAULT_MAIL })).ok, true);
  }
});

test('mail field: an address removed after the menu opened is not put into the form', async () => {
  const page = await openPage(site.origin + '/email-fields.html');
  const r = await focusField(page, '#mail');
  assert.equal(await menuCovers(page, rowUnder(r)), true);
  assert.deepEqual((await send('vault/setDefaultEmail', { email: '' })).data, { defaultEmail: '' });
  await page.mouse.click(...rowUnder(r));
  await page.waitForTimeout(600);
  assert.equal(await page.inputValue('#mail'), '');
  await page.close();
});
