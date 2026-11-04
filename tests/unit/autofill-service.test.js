import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AkariError } from '../../extension/src/background/router.js';
import { createAutofillService, urlMatches } from '../../extension/src/background/autofill-service.js';

const T0 = 1_700_000_000_000;

function login(over = {}) {
  return {
    id: 'i1', type: 'login', vault: 'personal', title: 'GitHub', url: 'https://github.com',
    username: 'alice', password: 'pw-alice', hue: 40, lastUsedAt: null, updatedAt: T0, ...over,
  };
}

function makeFakeVault({ locked = false, items = [] } = {}) {
  const state = { locked, data: { vaults: [], items }, touches: 0, unlockListeners: [] };
  const guard = () => { if (state.locked) throw new AkariError('LOCKED'); };
  return {
    state,
    isLocked: async () => state.locked,
    readData: async () => { guard(); return structuredClone(state.data); },
    mutateData: async (fn) => { guard(); return fn(state.data); },
    touchActivity: () => { state.touches++; },
    onUnlocked: (cb) => { state.unlockListeners.push(cb); },
    unlock: () => { state.locked = false; state.unlockListeners.forEach((cb) => cb()); },
    makeItem: (p) => ({ id: 'new-' + (state.data.items.length + 1), passkeys: [], createdAt: T0, updatedAt: T0, ...p }),
  };
}

function makeFakeChrome({ tabs = {}, active = null, sendMessage } = {}) {
  const calls = { sendMessage: [], executeScript: [], openPopup: 0 };
  return {
    calls,
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error('No tab with id: ' + id); return tabs[id]; },
      query: async () => (active ? [active] : []),
      sendMessage: async (id, msg, opts) => {
        calls.sendMessage.push({ id, msg, opts });
        return sendMessage ? sendMessage(id, msg, opts) : { filled: true };
      },
    },
    scripting: { executeScript: async (o) => { calls.executeScript.push(o); } },
    action: { openPopup: async () => { calls.openPopup++; } },
  };
}

function setup({ items = [login()], locked = false, tabs, active, sendMessage } = {}) {
  const clock = { t: T0 };
  const vault = makeFakeVault({ locked, items });
  const chrome = makeFakeChrome({ tabs: tabs || { 1: { id: 1, url: 'https://github.com/login' } }, active, sendMessage });
  const svc = createAutofillService({ chrome, vault, now: () => clock.t });
  return { svc, vault, chrome, clock };
}

/** Content-script sender: frame URL (sender.url) + top-level tab URL. */
const sender = (frameUrl, tabUrl = frameUrl, over = {}) => ({
  id: 'ext', url: frameUrl, frameId: 0, tab: { id: 1, url: tabUrl }, ...over,
});

const rejectsWith = (p, code) => assert.rejects(p, (e) => e instanceof AkariError && e.code === code);

test('urlMatches: registrable-domain matching', () => {
  assert.ok(urlMatches('https://accounts.google.com', 'https://mail.google.com/inbox'));
  assert.ok(urlMatches('github.com', 'https://github.com/login'));
  assert.ok(!urlMatches('https://alice.github.io', 'https://bob.github.io/'));
  assert.ok(!urlMatches('https://github.com', 'https://github.com.evil.io/'));
  assert.ok(!urlMatches('https://github.com', 'chrome://settings'));
  assert.ok(!urlMatches('https://github.com', 'about:blank'));
});

test('urlMatches: no https -> http downgrade, except loopback', () => {
  assert.ok(!urlMatches('https://example.com', 'http://example.com/'));
  assert.ok(urlMatches('http://example.com', 'https://example.com/'));
  assert.ok(urlMatches('http://example.com', 'http://example.com/'));
  assert.ok(urlMatches('https://localhost', 'http://localhost:8080/'));
});

test('autofill/matches: summaries only, most recently used first, site-filtered', async () => {
  const { svc } = setup({
    items: [
      login({ id: 'a', title: 'Old', lastUsedAt: T0 - 5000 }),
      login({ id: 'b', title: 'Recent', username: 'bob', lastUsedAt: T0 - 10 }),
      login({ id: 'c', title: 'Never used', username: 'carol', lastUsedAt: null, updatedAt: T0 + 5 }),
      login({ id: 'd', title: 'Other site', url: 'https://example.org' }),
      { ...login({ id: 'e' }), type: 'note' },
    ],
  });
  const res = await svc.matches({ tabId: 1 });
  assert.equal(res.url, 'https://github.com/login');
  assert.deepEqual(res.items.map((i) => i.id), ['b', 'a', 'c']);
  assert.deepEqual(Object.keys(res.items[0]).sort(), ['hue', 'id', 'title', 'username']);
  assert.ok(!JSON.stringify(res).includes('pw-alice'));
});

test('autofill/matches: tab URL comes from chrome.tabs, not the payload', async () => {
  const { svc } = setup({ tabs: { 1: { id: 1, url: 'https://evil.example/' } } });
  const res = await svc.matches({ tabId: 1, url: 'https://github.com' });
  assert.deepEqual(res.items, []);
});

test('autofill/matches: subdomain tabs match, non-web tabs and unknown tabs do not', async () => {
  const { svc } = setup({
    items: [login({ url: 'https://accounts.google.com' })],
    tabs: { 1: { id: 1, url: 'https://mail.google.com/' }, 2: { id: 2, url: 'chrome://extensions' } },
  });
  assert.equal((await svc.matches({ tabId: 1 })).items.length, 1);
  assert.deepEqual((await svc.matches({ tabId: 2 })).items, []);
  await rejectsWith(svc.matches({ tabId: 99 }), 'NOT_FOUND');
  await rejectsWith(svc.matches({}), 'INVALID');
});

test('autofill/matches: alice.github.io does not match bob.github.io', async () => {
  const { svc } = setup({
    items: [login({ url: 'https://alice.github.io' })],
    tabs: { 1: { id: 1, url: 'https://bob.github.io/' } },
  });
  assert.deepEqual((await svc.matches({ tabId: 1 })).items, []);
});

test('autofill/matches: locked -> LOCKED', async () => {
  const { svc } = setup({ locked: true });
  await rejectsWith(svc.matches({ tabId: 1 }), 'LOCKED');
});

test('autofill/fill: sends doFill to the top frame and records lastUsedAt', async () => {
  const { svc, chrome, vault, clock } = setup();
  clock.t = T0 + 1234;
  const res = await svc.fill({ tabId: 1, itemId: 'i1' });
  assert.deepEqual(res, { filled: true });
  assert.equal(chrome.calls.sendMessage.length, 1);
  const { id, msg, opts } = chrome.calls.sendMessage[0];
  assert.equal(id, 1);
  assert.deepEqual(opts, { frameId: 0 });
  assert.equal(msg.type, 'autofill/doFill');
  assert.equal(msg.username, 'alice');
  assert.equal(msg.password, 'pw-alice');
  assert.equal(msg.origin, 'https://github.com');
  assert.equal(vault.state.data.items[0].lastUsedAt, T0 + 1234);
});

test('autofill/fill: re-verifies against the current tab URL -> DOMAIN_MISMATCH', async () => {
  const { svc, chrome } = setup({ tabs: { 1: { id: 1, url: 'https://github.com.evil.io/login' } } });
  await rejectsWith(svc.fill({ tabId: 1, itemId: 'i1' }), 'DOMAIN_MISMATCH');
  assert.equal(chrome.calls.sendMessage.length, 0);
});

test('autofill/fill: unknown item, locked', async () => {
  const a = setup();
  await rejectsWith(a.svc.fill({ tabId: 1, itemId: 'nope' }), 'NOT_FOUND');
  const b = setup({ locked: true });
  await rejectsWith(b.svc.fill({ tabId: 1, itemId: 'i1' }), 'LOCKED');
  assert.equal(b.chrome.calls.sendMessage.length, 0);
});

test('autofill/fill: content script answers filled:false -> no lastUsedAt update', async () => {
  const { svc, vault } = setup({ sendMessage: async () => ({ filled: false }) });
  assert.deepEqual(await svc.fill({ tabId: 1, itemId: 'i1' }), { filled: false });
  assert.equal(vault.state.data.items[0].lastUsedAt, null);
});

test('autofill/fill: injects the content script when the tab has none, then retries once', async () => {
  let n = 0;
  const { svc, chrome } = setup({
    sendMessage: async () => {
      if (n++ === 0) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { filled: true };
    },
  });
  assert.deepEqual(await svc.fill({ tabId: 1, itemId: 'i1' }), { filled: true });
  assert.equal(chrome.calls.executeScript.length, 1);
  assert.deepEqual(chrome.calls.executeScript[0].target, { tabId: 1, frameIds: [0] });
  assert.deepEqual(chrome.calls.executeScript[0].files, ['src/content/shadow-ui.js', 'src/content/autofill.js']);
});

test('autofill/fill: unreachable tab -> filled:false, not an error', async () => {
  const { svc } = setup({ sendMessage: async () => { throw new Error('no receiver'); } });
  assert.deepEqual(await svc.fill({ tabId: 1, itemId: 'i1' }), { filled: false });
});

test('autofill/pageMatches: needs both frame and top URL to match', async () => {
  const { svc } = setup();
  const ok = await svc.pageMatches({}, sender('https://github.com/login'));
  assert.equal(ok.locked, false);
  assert.deepEqual(ok.items.map((i) => i.id), ['i1']);

  // frame from another site inside a github.com tab
  const evilFrame = await svc.pageMatches({}, sender('https://evil.example/f', 'https://github.com/login', { frameId: 3 }));
  assert.deepEqual(evilFrame.items, []);

  // github.com framed inside another site's tab
  const evilTop = await svc.pageMatches({}, sender('https://github.com/login', 'https://evil.example/', { frameId: 3 }));
  assert.deepEqual(evilTop.items, []);

  // same-site subframe is fine
  const sub = await svc.pageMatches({}, sender('https://gist.github.com/x', 'https://github.com/login', { frameId: 3 }));
  assert.equal(sub.items.length, 1);
});

test('autofill/pageMatches: locked -> locked:true and no items', async () => {
  const { svc } = setup({ locked: true });
  assert.deepEqual(await svc.pageMatches({}, sender('https://github.com/')), { locked: true, items: [] });
});

test('autofill/pageMatches: rejects non-web senders', async () => {
  const { svc } = setup();
  await rejectsWith(svc.pageMatches({}, { id: 'ext', url: 'about:blank', frameId: 0, tab: { id: 1, url: 'https://github.com/' } }), 'FORBIDDEN');
  await rejectsWith(svc.pageMatches({}, { id: 'ext', url: 'https://github.com/' }), 'FORBIDDEN');
});

test('autofill/requestFill: returns credentials only when frame and top both match', async () => {
  const { svc, vault, clock } = setup();
  clock.t = T0 + 77;
  assert.deepEqual(await svc.requestFill({ itemId: 'i1' }, sender('https://github.com/login')), {
    username: 'alice', password: 'pw-alice',
  });
  assert.equal(vault.state.data.items[0].lastUsedAt, T0 + 77);

  await rejectsWith(svc.requestFill({ itemId: 'i1' }, sender('https://evil.example/', 'https://github.com/', { frameId: 2 })), 'DOMAIN_MISMATCH');
  await rejectsWith(svc.requestFill({ itemId: 'i1' }, sender('https://github.com/', 'https://evil.example/', { frameId: 2 })), 'DOMAIN_MISMATCH');
  await rejectsWith(svc.requestFill({ itemId: 'nope' }, sender('https://github.com/')), 'NOT_FOUND');
});

test('autofill/requestFill: locked -> LOCKED', async () => {
  const { svc } = setup({ locked: true });
  await rejectsWith(svc.requestFill({ itemId: 'i1' }, sender('https://github.com/')), 'LOCKED');
});

test('autofill/offerSave: identical -> none', async () => {
  const { svc } = setup();
  const res = await svc.offerSave({ username: 'alice', password: 'pw-alice' }, sender('https://github.com/login'));
  assert.deepEqual(res, { action: 'none' });
  const pm = await svc.pageMatches({}, sender('https://github.com/'));
  assert.equal(pm.pendingSave, undefined);
});

test('autofill/offerSave: same username, new password -> update', async () => {
  const { svc } = setup();
  const res = await svc.offerSave({ username: 'Alice ', password: 'changed' }, sender('https://github.com/login'));
  assert.equal(res.action, 'update');
  assert.equal(res.itemId, 'i1');
  assert.equal(res.username, 'alice');
});

test('autofill/offerSave: unknown username or site -> new', async () => {
  const { svc } = setup();
  const a = await svc.offerSave({ username: 'mallory', password: 'x' }, sender('https://github.com/login'));
  assert.equal(a.action, 'new');
  assert.equal(a.itemId, undefined);
  const b = await svc.offerSave({ username: 'alice', password: 'pw-alice' }, sender('https://example.org/login'));
  assert.equal(b.action, 'new');
  assert.equal(b.host, 'example.org');
});

test('autofill/offerSave: password-only form matches the site\'s single login', async () => {
  const { svc } = setup();
  assert.equal((await svc.offerSave({ username: '', password: 'pw-alice' }, sender('https://github.com/'))).action, 'none');
  const upd = await svc.offerSave({ username: '', password: 'brand-new' }, sender('https://github.com/'));
  assert.equal(upd.action, 'update');
  assert.equal(upd.username, 'alice');

  const two = setup({ items: [login(), login({ id: 'i2', username: 'bob' })] });
  assert.equal((await two.svc.offerSave({ username: '', password: 'brand-new' }, sender('https://github.com/'))).action, 'new');
});

test('autofill/offerSave: a login form framed from another site is ignored', async () => {
  const { svc } = setup();
  const res = await svc.offerSave({ username: 'x', password: 'y' }, sender('https://evil.example/f', 'https://github.com/', { frameId: 4 }));
  assert.deepEqual(res, { action: 'none' });
});

test('autofill/offerSave: validation and locked', async () => {
  const { svc } = setup();
  await rejectsWith(svc.offerSave({ username: 'a', password: '' }, sender('https://github.com/')), 'INVALID');
  await rejectsWith(svc.offerSave({ username: 'a' }, sender('https://github.com/')), 'INVALID');
  const l = setup({ locked: true });
  await rejectsWith(l.svc.offerSave({ username: 'a', password: 'b' }, sender('https://github.com/')), 'LOCKED');
});

test('pending candidate is exposed without its password and survives a same-origin navigation', async () => {
  const { svc } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  // next page on the same tab and origin
  const pm = await svc.pageMatches({}, sender('https://github.com/dashboard'));
  assert.deepEqual(pm.pendingSave, { action: 'update', username: 'alice', host: 'github.com' });
  assert.ok(!JSON.stringify(pm).includes('changed'));
  // iframes never get it
  const sub = await svc.pageMatches({}, sender('https://github.com/f', 'https://github.com/', { frameId: 5 }));
  assert.equal(sub.pendingSave, undefined);
});

test('pending candidate is tied to the origin it was captured on', async () => {
  const { svc, vault } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  for (const other of ['https://gist.github.com/', 'https://evil.example/', 'http://github.com/']) {
    assert.equal((await svc.pageMatches({}, sender(other))).pendingSave, undefined, other);
    assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender(other)), { saved: false }, other);
  }
  assert.equal(vault.state.data.items[0].password, 'pw-alice');
  // not consumed by the mismatches: back on the original origin it is still there
  assert.ok((await svc.pageMatches({}, sender('https://github.com/home'))).pendingSave);
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/home')), { saved: true, action: 'update' });
  const updated = vault.state.data.items[0];
  assert.equal(updated.password, 'changed');
  assert.deepEqual(updated.passwordHistory.map((h) => h.password), ['pw-alice'], 'the replaced password is kept');
});

test('a change on the site that matches the pending password settles it through the save prompt', async () => {
  const { svc, vault } = setup();
  vault.state.data.items[0].pendingPassword = { password: 'new-from-akari', createdAt: 1 };
  await svc.offerSave({ username: 'alice', password: 'new-from-akari' }, sender('https://github.com/settings'));
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/settings')), { saved: true, action: 'update' });
  const it = vault.state.data.items[0];
  assert.equal(it.password, 'new-from-akari');
  assert.equal(it.pendingPassword, undefined);
  assert.equal(it.passwordHistory[0].password, 'pw-alice');
});

test('pending candidate is dropped when the vault locks (seen on access) or unlocks', async () => {
  const a = setup();
  await a.svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  a.vault.state.locked = true;
  assert.deepEqual(await a.svc.pageMatches({}, sender('https://github.com/')), { locked: true, items: [] });
  a.vault.state.locked = false;
  assert.equal((await a.svc.pageMatches({}, sender('https://github.com/'))).pendingSave, undefined);
  assert.deepEqual(await a.svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: false });

  // a lock + unlock cycle nobody observed is caught by the unlock hook
  const b = setup();
  await b.svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  b.vault.state.locked = true;
  b.vault.unlock();
  assert.equal((await b.svc.pageMatches({}, sender('https://github.com/'))).pendingSave, undefined);
  assert.equal(b.vault.state.data.items[0].password, 'pw-alice');
});

test('pending candidate is per tab', async () => {
  const { svc } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  const other = sender('https://github.com/', 'https://github.com/', { tab: { id: 2, url: 'https://github.com/' } });
  assert.equal((await svc.pageMatches({}, other)).pendingSave, undefined);
});

test('pending candidate expires after 2 minutes', async () => {
  const { svc, clock, vault } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  clock.t += 119_000;
  assert.ok((await svc.pageMatches({}, sender('https://github.com/'))).pendingSave);
  clock.t += 2_000;
  assert.equal((await svc.pageMatches({}, sender('https://github.com/'))).pendingSave, undefined);
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: false });
  assert.equal(vault.state.data.items[0].password, 'pw-alice');
});

test('autofill/confirmSave: new login is created in the personal vault', async () => {
  const { svc, vault } = setup();
  await svc.offerSave({ username: 'mallory', password: 's3cret' }, sender('https://login.example.org/auth?next=1'));
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://login.example.org/home')), { saved: true, action: 'new' });
  const created = vault.state.data.items.at(-1);
  assert.equal(created.type, 'login');
  assert.equal(created.title, 'login.example.org');
  assert.equal(created.url, 'https://login.example.org');
  assert.equal(created.username, 'mallory');
  assert.equal(created.password, 's3cret');
  assert.equal(created.vault, 'personal');
  // cleared
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://example.org/')), { saved: false });
  assert.equal(vault.state.data.items.length, 2);
});

test('autofill/confirmSave: update changes the password and passwordUpdatedAt only', async () => {
  const { svc, vault, clock } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  clock.t = T0 + 5000;
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: true, action: 'update' });
  const it = vault.state.data.items[0];
  assert.equal(vault.state.data.items.length, 1);
  assert.equal(it.password, 'changed');
  assert.equal(it.passwordUpdatedAt, T0 + 5000);
  assert.equal(it.username, 'alice');
});

test('autofill/confirmSave: dismiss clears the candidate without saving', async () => {
  const { svc, vault } = setup();
  await svc.offerSave({ username: 'mallory', password: 's3cret' }, sender('https://github.com/login'));
  assert.deepEqual(await svc.confirmSave({ decision: 'dismiss' }, sender('https://github.com/')), { saved: false });
  assert.equal(vault.state.data.items.length, 1);
  assert.equal((await svc.pageMatches({}, sender('https://github.com/'))).pendingSave, undefined);
});

test('autofill/confirmSave: locked -> LOCKED and the candidate (with its password) is dropped', async () => {
  const { svc, vault } = setup();
  await svc.offerSave({ username: 'mallory', password: 's3cret' }, sender('https://github.com/login'));
  vault.state.locked = true;
  await rejectsWith(svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), 'LOCKED');
  vault.state.locked = false;
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: false });
  assert.equal(vault.state.data.items.length, 1);
});

test('autofill/confirmSave: update of an item deleted meanwhile saves it as new', async () => {
  const { svc, vault } = setup();
  await svc.offerSave({ username: 'alice', password: 'changed' }, sender('https://github.com/login'));
  vault.state.data.items.length = 0;
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: true, action: 'update' });
  assert.equal(vault.state.data.items.length, 1);
  assert.equal(vault.state.data.items[0].password, 'changed');
});

test('autofill/confirmSave: validation, top frame only, forgetTab', async () => {
  const { svc } = setup();
  await svc.offerSave({ username: 'mallory', password: 's3cret' }, sender('https://github.com/login'));
  await rejectsWith(svc.confirmSave({ decision: 'maybe' }, sender('https://github.com/')), 'INVALID');
  await rejectsWith(svc.confirmSave({ decision: 'save' }, sender('https://github.com/f', 'https://github.com/', { frameId: 2 })), 'FORBIDDEN');
  svc.forgetTab(1);
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://github.com/')), { saved: false });
});

test('shortcut: locked opens the popup, errors are swallowed', async () => {
  const { svc, chrome } = setup({ locked: true, active: { id: 1, url: 'https://github.com/' } });
  await svc.onCommand('autofill');
  assert.equal(chrome.calls.openPopup, 1);
  chrome.action.openPopup = async () => { throw new Error('No active browser window'); };
  await svc.onCommand('autofill');
});

test('shortcut: fills the most recently used match; ignores other commands', async () => {
  const { svc, chrome } = setup({
    items: [
      login({ id: 'old', username: 'old', password: 'pw-old', lastUsedAt: T0 - 9999 }),
      login({ id: 'new', username: 'new', password: 'pw-new', lastUsedAt: T0 - 1 }),
    ],
    active: { id: 1, url: 'https://github.com/login' },
  });
  await svc.onCommand('something-else');
  assert.equal(chrome.calls.sendMessage.length, 0);
  await svc.onCommand('autofill');
  assert.equal(chrome.calls.sendMessage.length, 1);
  assert.equal(chrome.calls.sendMessage[0].msg.username, 'new');
});

test('shortcut: nothing to fill on non-matching or non-web tabs', async () => {
  const a = setup({ active: { id: 1, url: 'https://example.org/' } });
  await a.svc.onCommand('autofill');
  assert.equal(a.chrome.calls.sendMessage.length, 0);
  const b = setup({ active: { id: 1, url: 'chrome://newtab/' } });
  await b.svc.onCommand('autofill');
  assert.equal(b.chrome.calls.sendMessage.length, 0);
});

// Signing in with a login Akari already has must not end in "Akari に保存しますか？".
const twoLogins = () => setup({ items: [login(), login({ id: 'i2', username: 'bob', password: 'pw-bob' })] });

test('autofill/offerSave: two-step login — the username step is remembered for the password page', async () => {
  const { svc, clock } = twoLogins();
  // page 1 (username only), page 2 (password only, a new document on the same site)
  assert.deepEqual(svc.noteUsername({ username: ' bob ' }, sender('https://github.com/login')), {});
  assert.deepEqual(await svc.offerSave({ username: '', password: 'pw-bob' }, sender('https://github.com/session')), { action: 'none' });
  const upd = await svc.offerSave({ username: '', password: 'new-bob' }, sender('https://github.com/session'));
  assert.deepEqual([upd.action, upd.itemId, upd.username], ['update', 'i2', 'bob']);
  // another site, another tab, or ten minutes later: not used
  const elsewhere = await svc.offerSave({ username: '', password: 'pw-x' }, sender('https://example.org/'));
  assert.deepEqual([elsewhere.action, elsewhere.username], ['new', '']);
  const tab2 = await svc.offerSave({ username: '', password: 'new-bob' },
    sender('https://github.com/', 'https://github.com/', { tab: { id: 2, url: 'https://github.com/' } }));
  assert.equal(tab2.action, 'new');
  clock.t += 10 * 60 * 1000 + 1;
  assert.equal((await svc.offerSave({ username: '', password: 'new-bob' }, sender('https://github.com/session'))).action, 'new');
});

test('autofill/offerSave: a login Akari filled into the tab is not offered again', async () => {
  // inline menu (requestFill)
  const a = twoLogins();
  await a.svc.requestFill({ itemId: 'i2' }, sender('https://github.com/login'));
  assert.deepEqual(await a.svc.offerSave({ username: '', password: 'pw-bob' }, sender('https://github.com/session')), { action: 'none' });
  const changed = await a.svc.offerSave({ username: '', password: 'edited-after-fill' }, sender('https://github.com/session'));
  assert.deepEqual([changed.action, changed.itemId], ['update', 'i2'], 'a changed password updates the login that was filled');
  // popup / shortcut (fill)
  const b = twoLogins();
  assert.deepEqual(await b.svc.fill({ tabId: 1, itemId: 'i2' }), { filled: true });
  assert.deepEqual(await b.svc.offerSave({ username: 'bob', password: 'pw-bob' }, sender('https://github.com/login')), { action: 'none' });
  // a different account typed by hand after the fill is still offered
  const other = await b.svc.offerSave({ username: 'carol', password: 'pw-carol' }, sender('https://github.com/login'));
  assert.deepEqual([other.action, other.username], ['new', 'carol']);
});

test('autofill/offerSave: a password-only form with a saved password of this site counts as saved', async () => {
  const { svc } = twoLogins();
  assert.deepEqual(await svc.offerSave({ username: '', password: 'pw-bob' }, sender('https://github.com/')), { action: 'none' });
  assert.equal((await svc.offerSave({ username: '', password: 'nobody-has-this' }, sender('https://github.com/'))).action, 'new');
});

test('autofill/offerSave: an email and its local part are the same account', async () => {
  const { svc } = setup({ items: [login({ username: 'Yi@Example.com', password: 'pw-yi' })] });
  assert.deepEqual(await svc.offerSave({ username: 'yi', password: 'pw-yi' }, sender('https://github.com/login')), { action: 'none' });
  const upd = await svc.offerSave({ username: 'yi', password: 'pw-yi-2' }, sender('https://github.com/login'));
  assert.deepEqual([upd.action, upd.username], ['update', 'Yi@Example.com']);
  const other = await svc.offerSave({ username: 'yi@other.example', password: 'pw-yi' }, sender('https://github.com/login'));
  assert.equal(other.action, 'new', 'two different emails are two accounts');
});

test('autofill/noteUsername: validation, web pages only, same-site frames only', async () => {
  const { svc } = twoLogins();
  assert.throws(() => svc.noteUsername({ username: '  ' }, sender('https://github.com/')), (e) => e.code === 'INVALID');
  assert.throws(() => svc.noteUsername({ username: 'x'.repeat(5000) }, sender('https://github.com/')), (e) => e.code === 'INVALID');
  assert.throws(() => svc.noteUsername({ username: 'bob' }, { id: 'ext', url: 'chrome://settings', tab: { id: 1, url: 'chrome://settings' } }),
    (e) => e.code === 'FORBIDDEN');
  svc.noteUsername({ username: 'bob' }, sender('https://evil.example/f', 'https://github.com/', { frameId: 3 }));
  assert.equal((await svc.offerSave({ username: '', password: 'new-bob' }, sender('https://github.com/'))).action, 'new', 'a framed other site is not kept');
});

test('autofill/confirmSave: a new login goes to the first vault when 個人 is gone', async () => {
  const { svc, vault } = setup();
  vault.state.data.vaults = [{ id: 'v-hobby', name: '趣味', hue: 300 }];
  await svc.offerSave({ username: 'mallory', password: 's3cret' }, sender('https://example.org/login'));
  assert.deepEqual(await svc.confirmSave({ decision: 'save' }, sender('https://example.org/')), { saved: true, action: 'new' });
  assert.equal(vault.state.data.items.at(-1).vault, 'v-hobby');
});
