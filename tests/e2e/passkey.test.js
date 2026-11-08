import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';
import { launch, extensionMessenger, MASTER, sleep } from './helpers.js';
import { startRpServer } from '../fixtures/webauthn-rp/server.js';
import * as protonpass from '../../extension/src/lib/import/importers/protonpass.js';
import { protonPasskeyEntry } from '../unit/_proton-passkey.js';

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
  rp?.server.closeAllConnections();
  await rp?.close();
});

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

const cardRow = (p, i = 0) => [p.viewportSize().width - 16 - 170, 114 + i * 44];
const cardClose = (p) => [p.viewportSize().width - 41, 37];

async function pickFirst(p, settled) {
  let done = false;
  settled.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 40 && !done; i++) {
    await p.mouse.click(...cardRow(p));
    await sleep(200);
  }
  return settled;
}

const cardFocused = (p) => p.waitForFunction(() => {
  const a = document.activeElement;
  return !!a && a.tagName === 'DIV' && a.parentNode === document.documentElement;
}, null, { timeout: 10000 });

async function enterOnCard(p, settled) {
  let done = false;
  settled.then(() => { done = true; }, () => { done = true; });
  await cardFocused(p);
  for (let i = 0; i < 40 && !done; i++) {
    await p.keyboard.press('Enter');
    await sleep(200);
  }
  return settled;
}

const statusIs = (on, expected) => on.waitForFunction((s) => document.getElementById('status').dataset.state !== 'pending'
  && document.getElementById('status').textContent.startsWith(s), expected, { timeout: 15000 });

async function viaCard(button, expected, on = page, { keyboard = false } = {}) {
  let opened = false;
  const onPage = (p) => { if (p.url().includes('/src/passkey/passkey.html')) opened = true; };
  ext.context.on('page', onPage);
  try {
    await on.bringToFront();
    await on.click(button);
    if (keyboard) {
      await cardFocused(on);
      await on.keyboard.press('Enter');
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
    await other.addInitScript(installOtherManager, '__early');
    await other.goto(page.url());
    await other.bringToFront();
    assert.equal(await other.evaluate(() => navigator.credentials.get === CredentialsContainer.prototype.get), true);

    assert.equal(await viaCard('#login', 'signed-in', other), 'signed-in');
    assert.deepEqual(await other.evaluate(() => window.__early), [], 'Akari answered before the other manager');

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

    await other.evaluate(installOtherManager, '__late');
    assert.equal(await conditionalClosed(), 'AbortError');
    assert.deepEqual(await other.evaluate(() => [window.__early, window.__late]), [['conditional'], ['conditional']]);

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

test('saving on the card sets UV whether the site prefers or discourages it', async () => {
  await page.bringToFront();
  for (const uv of ['preferred', 'discouraged']) {
    assert.equal(await enterOnCard(page, createFlags(uv)), 0x04, uv);
    await sleep(1400);
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
  await win.locator(`${screen('create')} #createPrimary`).click();
  assert.equal(await flags, 0x04);
});

test('a passkey imported from Proton Pass signs in on the card', async () => {
  const jwk = await crypto.subtle.exportKey('jwk',
    (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey);
  const credentialId = randomBytes(32);
  const userHandle = randomBytes(16);
  const entry = protonPasskeyEntry({ key: jwk, credentialId, rpId: 'localhost', userHandle, userName: 'proton-user' });
  const json = { vaults: { s: { name: 'Proton', items: [{
    itemId: 'i1', state: 1, createTime: 1700000000, modifyTime: 1700000000,
    data: { type: 'login', metadata: { name: 'Proton RP', note: '' }, extraFields: [],
      content: { itemEmail: '', itemUsername: 'proton-user', password: '', urls: [rp.url], totpUri: '', passkeys: [entry] } },
  }] } } };
  const parsed = await protonpass.parse({ name: 'data.json', bytes: new TextEncoder().encode(JSON.stringify(json)) }, {});
  assert.deepEqual(parsed.warnings, []);
  const vaults = (await send('vault/getAll')).data.vaults;
  const res = await send('vault/importItems', { items: parsed.items, vault: vaults[0].id });
  assert.equal(res.ok, true);
  assert.equal(res.data.passkeys, 1);

  await page.bringToFront();
  const assertion = page.evaluate(async (id) => {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: Uint8Array.from(atob(id), (c) => c.charCodeAt(0)) }],
    } });
    const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const r = cred.response;
    return { id: cred.id, authData: b64(r.authenticatorData), clientDataJSON: b64(r.clientDataJSON), signature: b64(r.signature), userHandle: b64(r.userHandle) };
  }, credentialId.toString('base64'));
  const a = await pickFirst(page, assertion);
  assert.equal(a.id, credentialId.toString('base64url'));
  assert.equal(a.userHandle, userHandle.toString('base64'));
  const signed = Buffer.concat([Buffer.from(a.authData, 'base64'), createHash('sha256').update(Buffer.from(a.clientDataJSON, 'base64')).digest()]);
  const sitesKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.equal(nodeVerify('sha256', signed, { key: sitesKey, dsaEncoding: 'der' }, Buffer.from(a.signature, 'base64')), true);
});
