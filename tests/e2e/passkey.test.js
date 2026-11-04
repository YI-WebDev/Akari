// Passkey registration and sign-in against a real relying party (verified by
// @simplewebauthn/server). While Akari is unlocked both happen on Akari's card in the
// page (no window); while locked, the consent window unlocks first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, extensionMessenger, MASTER, sleep } from './helpers.js';
import { startRpServer } from '../fixtures/webauthn-rp/server.js';

let ext, send, rp, page;

before(async () => {
  ext = await launch();
  ({ send } = await extensionMessenger(ext));
  assert.equal((await send('vault/setup', { masterPassword: MASTER })).ok, true);
  rp = await startRpServer({ port: 0, host: '127.0.0.1' });
  page = await ext.context.newPage();
  await page.goto(rp.url);
});
after(async () => {
  await ext?.close();
  rp?.server.closeAllConnections(); // keep-alive sockets would hold server.close() open
  await rp?.close();
});

/** Click a button on the RP page, act in the consent window, and wait for the RP status. */
async function viaConsent(button, act, expected, on = page) {
  const popup = ext.context.waitForEvent('page', { predicate: (p) => p.url().includes('/src/passkey/passkey.html'), timeout: 10000 });
  await on.click(button);
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');
  await act(win);
  await on.waitForFunction((s) => document.getElementById('status').dataset.state !== 'pending'
    && document.getElementById('status').textContent.startsWith(s), expected, { timeout: 15000 });
  return on.textContent('#status');
}

const screen = (name) => `[data-screen="${name}"]:not([hidden])`;

// Akari's card is a closed shadow root at the top right of the page (shadow-ui.js `.bar`):
// rows and × are clicked by position. Rows count only after the card has been visible ~500 ms.
const cardRow = (p, i = 0) => [p.viewportSize().width - 16 - 170, 114 + i * 44];
const cardClose = (p) => [p.viewportSize().width - 41, 37];

/** Click the first passkey on Akari's card until `settled` settles; clicks before the card is armed do nothing. */
async function pickFirst(p, settled) {
  let done = false;
  settled.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 40 && !done; i++) {
    await p.mouse.click(...cardRow(p));
    await sleep(200);
  }
  return settled;
}

/** Focus inside Akari's closed shadow root shows on the page as its host, a div right under <html>. */
const cardFocused = (p) => p.waitForFunction(() => {
  const a = document.activeElement;
  return !!a && a.tagName === 'DIV' && a.parentNode === document.documentElement;
}, null, { timeout: 10000 });

/** Press Enter on the card's focused button (save / OK) until `settled` settles; presses before it is armed do nothing. */
async function enterOnCard(p, settled) {
  let done = false;
  settled.then(() => { done = true; }, () => { done = true; });
  await cardFocused(p); // never press Enter on the page's own buttons
  for (let i = 0; i < 40 && !done; i++) {
    await p.keyboard.press('Enter');
    await sleep(200);
  }
  return settled;
}

const statusIs = (on, expected) => on.waitForFunction((s) => document.getElementById('status').dataset.state !== 'pending'
  && document.getElementById('status').textContent.startsWith(s), expected, { timeout: 15000 });

/**
 * Click a button on the RP page and answer on Akari's card: pick the first passkey (sign-in)
 * or press Enter on the focused save / OK button. No window may open.
 */
async function viaCard(button, expected, on = page, { keyboard = false } = {}) {
  let opened = false;
  const onPage = (p) => { if (p.url().includes('/src/passkey/passkey.html')) opened = true; };
  ext.context.on('page', onPage);
  try {
    await on.bringToFront();
    await on.click(button);
    if (keyboard) {
      await cardFocused(on);
      await on.keyboard.press('Enter'); // straight away: refused
    } else {
      await sleep(150);
      await on.mouse.click(...cardRow(on));
    }
    await sleep(200);
    assert.match(await on.textContent('#status'), /…$/, 'acting before the card has been visible for a moment does nothing');
    await (keyboard ? enterOnCard : pickFirst)(on, statusIs(on, expected));
  } finally {
    ext.context.off('page', onPage);
  }
  assert.equal(opened, false, 'no window while Akari is unlocked');
  return on.textContent('#status');
}

test('save a passkey on the card in the page (unlocked: no window, verified)', async () => {
  assert.equal(await viaCard('#register', 'registered', page, { keyboard: true }), 'registered');
  assert.match(await page.textContent('#log'), /"userVerified": true/);

  const all = await send('vault/getAll');
  const withKey = all.data.items.filter((i) => i.passkeys?.length);
  assert.equal(withKey.length, 1);
  assert.equal(withKey[0].passkeys[0].rpId, 'localhost');
  assert.ok(!('privateKey' in withKey[0].passkeys[0]), 'private key must not reach extension pages');
});

test('sign in on the card in the page (unlocked: no window, verified)', async () => {
  assert.equal(await viaCard('#login', 'signed-in'), 'signed-in');
  assert.match(await page.textContent('#log'), /"userVerified": true/);
});

test('discoverable sign-in on the card', async () => {
  assert.equal(await viaCard('#login-discoverable', 'signed-in'), 'signed-in');
});

test('a choice on the card is verified even when the site only prefers it (Google)', async () => {
  // Google signs in without a password only when UV is set ("This key can only be used with a password").
  const flags = page.evaluate(async () => {
    const cred = await navigator.credentials.get({
      publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'preferred' },
    });
    return new Uint8Array(cred.response.authenticatorData)[32];
  });
  assert.equal((await pickFirst(page, flags)) & 0x04, 0x04);
});

test('passkey autofill: the card appears without a click and answers the waiting request', async () => {
  const result = page.evaluate(() => navigator.credentials.get({
    mediation: 'conditional',
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname },
  }).then((c) => c.type, (e) => e.name));
  assert.equal(await pickFirst(page, result), 'public-key');
});

test('locked: the window unlocks (wrong password first), and unlocking counts as user verification', async () => {
  assert.equal((await send('vault/lock')).ok, true);
  const status = await viaConsent('#login', async (win) => {
    const pw = win.locator(`${screen('locked')} #pw`);
    await pw.fill('not the master password');
    await pw.press('Enter');
    await win.locator(`${screen('locked')} #pwHint`).filter({ hasText: 'パスワードが違います' }).waitFor();
    await pw.fill(MASTER);
    await pw.press('Enter');
    await win.locator(screen('get')).waitFor();
    assert.equal(await win.locator(`${screen('get')} .uv`).isVisible(), false, 'no second prompt after unlocking here');
    await win.locator(`${screen('get')} [data-act="primary"]`).click();
  }, 'signed-in');
  assert.equal(status, 'signed-in');
  assert.match(await page.textContent('#log'), /"userVerified": true/);
});

test('approve in the window is disarmed right after it appears or regains focus', async () => {
  assert.equal((await send('vault/lock')).ok, true);
  const status = await viaConsent('#login-discoverable', async (win) => {
    await win.locator(`${screen('locked')} #pw`).fill(MASTER);
    await win.locator(`${screen('locked')} #pw`).press('Enter');
    await win.locator(screen('get')).waitFor();
    // Regaining focus re-arms the delay: approve is disabled and Enter does nothing.
    const disarmed = await win.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      const btn = document.querySelector('[data-screen="get"]:not([hidden]) [data-act="primary"]');
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return btn.disabled;
    });
    assert.equal(disarmed, true);
    await sleep(300);
    assert.equal(await page.textContent('#status'), 'signing in…', 'Enter during the delay must not approve');
    await win.locator(`${screen('get')} [data-act="primary"]`).click();
  }, 'signed-in');
  assert.equal(status, 'signed-in');
});

test('cancel in the window → NotAllowedError', async () => {
  assert.equal((await send('vault/lock')).ok, true);
  const status = await viaConsent('#login', async (win) => {
    await win.locator(`${screen('locked')} #pw`).fill(MASTER);
    await win.locator(`${screen('locked')} #pw`).press('Enter');
    await win.locator(`${screen('get')} [data-act="cancel"]`).click();
  }, 'error');
  assert.match(status, /NotAllowedError/);
});

test('registering again for the same account → InvalidStateError after the user confirms on the card', async () => {
  await page.bringToFront();
  await page.click('#register');
  await sleep(1000);
  assert.equal(await page.textContent('#status'), 'registering…', 'no answer before the user acts');
  await enterOnCard(page, statusIs(page, 'error'));
  assert.match(await page.textContent('#status'), /InvalidStateError/);
});

test('the credential object looks native to the page', async () => {
  const checks = JSON.parse((await page.textContent('#checks')) || '{}');
  for (const [k, v] of Object.entries(checks)) assert.notEqual(v, false, `check ${k} failed`);
});

// Another passkey manager the way Proton Pass installs itself: keep the get() that is there
// as its fallback, then set its own on navigator.credentials (which hides the prototype).
function installOtherManager(log) {
  const prior = navigator.credentials.get.bind(navigator.credentials);
  window[log] = [];
  navigator.credentials.get = function (o) {
    window[log].push(o?.mediation || 'modal');
    return prior(o);
  };
}

test('with another passkey manager on the page, Akari is asked first and passes on what the user closes', async () => {
  const other = await ext.context.newPage();
  try {
    await other.addInitScript(installOtherManager, '__early'); // around document_start, like an extension
    await other.goto(page.url());
    await other.bringToFront();
    assert.equal(await other.evaluate(() => navigator.credentials.get === CredentialsContainer.prototype.get), true);

    assert.equal(await viaCard('#login', 'signed-in', other), 'signed-in');
    assert.deepEqual(await other.evaluate(() => window.__early), [], 'Akari answered before the other manager');

    // Passkey autofill: closing Akari's card hands the request to the other manager once, then the browser.
    const conditionalClosed = async () => {
      await other.evaluate(() => {
        window.__ac = new AbortController();
        window.__p = navigator.credentials.get({
          mediation: 'conditional', signal: window.__ac.signal,
          publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname },
        }).then(() => 'resolved', (e) => e.name);
      });
      await sleep(600);
      await other.mouse.click(...cardClose(other));
      await sleep(400);
      return other.evaluate(() => { window.__ac.abort(); return window.__p; });
    };
    assert.equal(await conditionalClosed(), 'AbortError');
    assert.deepEqual(await other.evaluate(() => window.__early), ['conditional']);

    // A manager installed after Akari (it captures Akari's get as its fallback): no loop.
    await other.evaluate(installOtherManager, '__late');
    assert.equal(await conditionalClosed(), 'AbortError');
    assert.deepEqual(await other.evaluate(() => [window.__early, window.__late]), [['conditional'], ['conditional']]);

    // The page giving up closes the card; nothing is passed on.
    const aborted = await other.evaluate(async () => {
      const ac = new AbortController();
      const p = navigator.credentials.get({
        signal: ac.signal, publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname },
      }).then(() => 'resolved', (e) => e.name);
      await new Promise((r) => setTimeout(r, 400));
      ac.abort();
      return p;
    });
    assert.equal(aborted, 'AbortError');
    assert.deepEqual(await other.evaluate(() => window.__late), ['conditional'], 'an abort is not passed on');
  } finally {
    await other.close();
  }
});

/** A create() made by the page itself; resolves to the UV bit of the new credential. */
function createFlags(userVerification) {
  return page.evaluate(async (uv) => {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: 'Test RP' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `uv-${uv}@example.com`, displayName: `UV ${uv}` },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: uv },
      },
    });
    return new Uint8Array(cred.response.getAuthenticatorData())[32] & 0x04;
  }, userVerification);
}

// Last: these add passkeys the RP server does not know.
test('saving on the card sets UV whether the site prefers or discourages it', async () => {
  await page.bringToFront();
  for (const uv of ['preferred', 'discouraged']) {
    assert.equal(await enterOnCard(page, createFlags(uv)), 0x04, uv);
    await sleep(1400); // the "saved" card closes
  }
});

test('locked: saving opens the window, and unlocking there counts as user verification', async () => {
  assert.equal((await send('vault/lock')).ok, true);
  const popup = ext.context.waitForEvent('page', { predicate: (p) => p.url().includes('/src/passkey/passkey.html'), timeout: 10000 });
  const flags = createFlags('required');
  const win = await popup;
  await win.waitForLoadState('domcontentloaded');
  await win.locator(`${screen('locked')} #pw`).fill(MASTER);
  await win.locator(`${screen('locked')} #pw`).press('Enter');
  await win.locator(screen('create')).waitFor();
  assert.equal(await win.locator(`${screen('create')} .uv`).isVisible(), false, 'no second prompt after unlocking here');
  await win.locator(`${screen('create')} #createPrimary`).click(); // auto-waits for the arming delay
  assert.equal(await flags, 0x04);
});
