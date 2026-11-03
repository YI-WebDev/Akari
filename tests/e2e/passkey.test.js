// Passkey registration and sign-in against a real relying party (verified by
// @simplewebauthn/server), through the extension's consent window.
// The RP asks for userVerification 'required', so every approval re-prompts for
// the master password (or uses the unlock done in the same window).
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

test('register a passkey (master password re-prompt for UV)', async () => {
  const status = await viaConsent('#register', async (win) => {
    await win.locator(`${screen('create')} .uv-pw`).fill(MASTER);
    await win.locator(`${screen('create')} #createPrimary`).click(); // auto-waits for the arming delay
  }, 'registered');
  assert.equal(status, 'registered');
  assert.match(await page.textContent('#log'), /"userVerified": true/);

  const all = await send('vault/getAll');
  const withKey = all.data.items.filter((i) => i.passkeys?.length);
  assert.equal(withKey.length, 1);
  assert.equal(withKey[0].passkeys[0].rpId, 'localhost');
  assert.ok(!('privateKey' in withKey[0].passkeys[0]), 'private key must not reach extension pages');
});

test('sign in with the passkey (username flow, wrong password first)', async () => {
  const status = await viaConsent('#login', async (win) => {
    const pw = win.locator(`${screen('get')} .uv-pw`);
    await pw.fill('not the master password');
    await win.locator(`${screen('get')} [data-act="primary"]`).click();
    await win.locator(`${screen('get')} .uv .hint`).filter({ hasText: 'パスワードが違います' }).waitFor();
    await pw.fill(MASTER);
    await pw.press('Enter');
  }, 'signed-in');
  assert.equal(status, 'signed-in');
});

test('approve is disarmed right after the window appears or regains focus', async () => {
  const status = await viaConsent('#login-discoverable', async (win) => {
    await win.locator(`${screen('get')} .uv-pw`).fill(MASTER);
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

test('unlocking in the consent window counts as user verification', async () => {
  assert.equal((await send('vault/lock')).ok, true);
  const status = await viaConsent('#login', async (win) => {
    await win.locator(`${screen('locked')} #pw`).fill(MASTER);
    await win.locator(`${screen('locked')} #pw`).press('Enter');
    await win.locator(screen('get')).waitFor();
    assert.equal(await win.locator(`${screen('get')} .uv`).isVisible(), false, 'no second prompt after unlocking here');
    await win.locator(`${screen('get')} [data-act="primary"]`).click();
  }, 'signed-in');
  assert.equal(status, 'signed-in');
  assert.match(await page.textContent('#log'), /"userVerified": true/);
});

test('cancel → NotAllowedError', async () => {
  const status = await viaConsent('#login', async (win) => {
    await win.locator(`${screen('get')} [data-act="cancel"]`).click();
  }, 'error');
  assert.match(status, /NotAllowedError/);
});

test('registering again for the same account → InvalidStateError after the user confirms', async () => {
  const status = await viaConsent('#register', async (win) => {
    await win.locator(`${screen('create')} #excludedNotice`).waitFor();
    assert.equal(await page.textContent('#status'), 'registering…', 'no answer before the user acts');
    await win.locator(`${screen('create')} #createPrimary`).click();
  }, 'error');
  assert.match(status, /InvalidStateError/);
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

test('with another passkey manager on the page, Akari is asked first and passes on what it declines', async () => {
  const other = await ext.context.newPage();
  try {
    await other.addInitScript(installOtherManager, '__early'); // around document_start, like an extension
    await other.goto(page.url());
    await other.bringToFront();
    assert.equal(await other.evaluate(() => navigator.credentials.get === CredentialsContainer.prototype.get), true);

    const status = await viaConsent('#login', async (win) => {
      await win.locator(`${screen('get')} .uv-pw`).fill(MASTER);
      await win.locator(`${screen('get')} [data-act="primary"]`).click();
    }, 'signed-in', other);
    assert.equal(status, 'signed-in');
    assert.deepEqual(await other.evaluate(() => window.__early), [], 'Akari answered before the other manager');

    // Akari declines conditional mediation: the other manager gets it once, then the browser.
    const conditional = () => other.evaluate(async () => {
      const ac = new AbortController();
      const p = navigator.credentials.get({
        mediation: 'conditional', signal: ac.signal,
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname },
      }).then(() => 'resolved', (e) => e.name);
      await new Promise((r) => setTimeout(r, 800));
      ac.abort();
      return p;
    });
    assert.equal(await conditional(), 'AbortError');
    assert.deepEqual(await other.evaluate(() => window.__early), ['conditional']);

    // A manager installed after Akari (it captures Akari's get as its fallback): no loop.
    await other.evaluate(installOtherManager, '__late');
    assert.equal(await conditional(), 'AbortError');
    assert.deepEqual(await other.evaluate(() => [window.__early, window.__late]), [['conditional'], ['conditional']]);
    const cancelled = await viaConsent('#login', async (win) => {
      await win.locator(`${screen('get')} [data-act="cancel"]`).click();
    }, 'error', other);
    assert.match(cancelled, /NotAllowedError/);
    assert.deepEqual(await other.evaluate(() => window.__late), ['conditional'], 'a cancel in Akari is not passed on');
  } finally {
    await other.close();
  }
});
