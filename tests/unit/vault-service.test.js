import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVaultService, VAULT_KEY, SETTINGS_KEY, SESSION_KEY, AUTOLOCK_ALARM,
} from '../../extension/src/background/vault-service.js';
import { createClipboardService, CLIPBOARD_ALARM } from '../../extension/src/background/clipboard.js';
import { AkariError } from '../../extension/src/background/router.js';
import { MSG } from '../../extension/src/shared/messages.js';
import { importDek, exportDek, decryptJson } from '../../extension/src/lib/crypto.js';
import { fromB64, toB64, toB64url, randomBytes } from '../../extension/src/shared/bytes.js';

const PW = 'master-password-1';

function fakeArea() {
  const map = new Map();
  return {
    map,
    accessLevel: null,
    async get(keys) {
      const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async setAccessLevel({ accessLevel }) {
      this.accessLevel = accessLevel;
    },
  };
}

function fakeChrome({ local = fakeArea(), session = fakeArea() } = {}) {
  const alarms = new Map();
  const listeners = [];
  return {
    storage: { local, session },
    alarms: {
      map: alarms,
      async create(name, info) { alarms.set(name, info); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener: (fn) => listeners.push(fn) },
      async fire(name) {
        alarms.delete(name);
        for (const fn of listeners) await fn({ name });
      },
    },
  };
}

function makeService(opts = {}) {
  const chrome = opts.chrome || fakeChrome();
  const clock = { t: 1_000_000 };
  const sleeps = [];
  const svc = createVaultService({
    chrome,
    now: () => clock.t,
    iterations: 1000,
    sleep: async (ms) => { sleeps.push(ms); },
    ...opts.factory,
  });
  svc.install();
  // Handlers as the router would call them; errors come back as AkariError.
  const call = (type, payload = {}) => svc.handlers[type]({ type, ...payload }, {});
  return { chrome, clock, sleeps, svc, call };
}

async function setupUnlocked(opts) {
  const ctx = makeService(opts);
  await ctx.call(MSG.VAULT_SETUP, { masterPassword: PW });
  return ctx;
}

test('every §3.1 API function and handler exists', () => {
  const { svc } = makeService();
  for (const name of ['isLocked', 'readData', 'mutateData', 'onUnlocked', 'getSettings', 'touchActivity', 'sanitizeItem', 'makeItem']) {
    assert.equal(typeof svc[name], 'function', name);
  }
  for (const type of [
    MSG.VAULT_STATUS, MSG.VAULT_SETUP, MSG.VAULT_UNLOCK, MSG.VAULT_LOCK, MSG.VAULT_GET_ALL, MSG.VAULT_SAVE_ITEM,
    MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_CHANGE_PASSWORD, MSG.VAULT_EXPORT, MSG.VAULT_IMPORT,
    MSG.SETTINGS_GET, MSG.SETTINGS_SET, MSG.ACTIVITY_PING,
  ]) assert.equal(typeof svc.handlers[type], 'function', type);
});

test('module exports the live API names', async () => {
  const mod = await import('../../extension/src/background/vault-service.js');
  for (const name of ['isLocked', 'readData', 'mutateData', 'onUnlocked', 'getSettings', 'touchActivity', 'sanitizeItem', 'makeItem']) {
    assert.equal(typeof mod[name], 'function', name);
  }
  assert.equal(typeof mod.makeItem({ title: 'x' }).id, 'string');
});

test('install restricts storage.session to trusted contexts', () => {
  const { chrome } = makeService();
  assert.equal(chrome.storage.session.accessLevel, 'TRUSTED_CONTEXTS');
});

test('setup → unlocked; storage holds only ciphertext; session holds the DEK', async () => {
  const { call, chrome, svc } = makeService();
  assert.deepEqual(await call(MSG.VAULT_STATUS), { initialized: false, locked: true });
  await assert.rejects(call(MSG.VAULT_SETUP, { masterPassword: 'short' }), { code: 'INVALID' });
  let fired = 0;
  svc.onUnlocked(() => { fired++; });
  await call(MSG.VAULT_SETUP, { masterPassword: PW });
  assert.equal(fired, 1);
  assert.deepEqual(await call(MSG.VAULT_STATUS), { initialized: true, locked: false });
  const record = chrome.storage.local.map.get(VAULT_KEY);
  assert.equal(record.version, 1);
  assert.ok(!JSON.stringify(record).includes(PW));
  assert.equal(typeof chrome.storage.session.map.get(SESSION_KEY).dek, 'string');
  const all = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.vaults.map((v) => v.id), ['personal', 'work', 'family']);
  assert.deepEqual(all.items, []);
  await assert.rejects(call(MSG.VAULT_SETUP, { masterPassword: PW }), { code: 'ALREADY_INITIALIZED' });
});

test('locked → LOCKED errors (as router AkariError); unlock with wrong/right password', async () => {
  const { call, svc } = await setupUnlocked();
  await call(MSG.VAULT_LOCK);
  assert.equal(await svc.isLocked(), true);
  await assert.rejects(call(MSG.VAULT_GET_ALL), (e) => e instanceof AkariError && e.code === 'LOCKED');
  await assert.rejects(svc.readData(), (e) => e instanceof AkariError && e.code === 'LOCKED');
  await assert.rejects(svc.mutateData(() => {}), (e) => e instanceof AkariError && e.code === 'LOCKED');
  await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: 'wrong-password' }),
    (e) => e instanceof AkariError && e.code === 'BAD_PASSWORD');
  let fired = 0;
  svc.onUnlocked(() => { fired++; });
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  assert.equal(fired, 1);
  assert.equal(await svc.isLocked(), false);
});

test('unlock before setup → NOT_INITIALIZED', async () => {
  const { call } = makeService();
  await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: PW }), { code: 'NOT_INITIALIZED' });
});

test('saveItem creates/updates; passkey private keys are kept from storage, never from the popup', async () => {
  const { call, svc, clock } = await setupUnlocked();
  const { item: created } = await call(MSG.VAULT_SAVE_ITEM, {
    item: { title: 'GitHub', url: 'github.com', username: 'hina', password: 'old-pass', passkeys: [{ credentialId: 'evil', privateKey: 'EVIL' }] },
  });
  assert.equal(created.url, 'https://github.com');
  assert.deepEqual(created.passkeys, []);
  assert.equal(created.passwordUpdatedAt, clock.t);

  // Another SW service (passkey) adds a passkey with a private key.
  await svc.mutateData((d) => {
    d.items.find((i) => i.id === created.id).passkeys.push({
      credentialId: 'cred1', rpId: 'github.com', privateKey: 'PRIVATE', publicKey: 'PUB', alg: -7, signCount: 0,
    });
  });

  const { items } = await call(MSG.VAULT_GET_ALL);
  const fromPopup = items[0];
  assert.equal(fromPopup.passkeys.length, 1);
  assert.ok(!('privateKey' in fromPopup.passkeys[0]), 'getAll strips privateKey');

  clock.t += 5000;
  const { item: updated } = await call(MSG.VAULT_SAVE_ITEM, {
    item: { ...fromPopup, title: 'GitHub (work)', passkeys: [{ credentialId: 'cred1', privateKey: 'FORGED' }] },
  });
  assert.equal(updated.title, 'GitHub (work)');
  assert.equal(updated.updatedAt, clock.t);
  assert.equal(updated.passwordUpdatedAt, created.passwordUpdatedAt, 'password unchanged');
  assert.ok(!('privateKey' in updated.passkeys[0]));

  const stored = (await svc.readData()).items[0];
  assert.equal(stored.passkeys[0].privateKey, 'PRIVATE');
  assert.equal(stored.passkeys[0].publicKey, 'PUB');
  assert.equal(stored.createdAt, created.createdAt);

  clock.t += 5000;
  const { item: repw } = await call(MSG.VAULT_SAVE_ITEM, { item: { id: created.id, password: 'new-pass' } });
  assert.equal(repw.passwordUpdatedAt, clock.t);
  assert.equal(repw.title, 'GitHub (work)', 'partial update keeps other fields');

  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { id: 'missing', title: 'x' } }), { code: 'NOT_FOUND' });
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { title: 'x', vault: 'nope' } }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { url: 'javascript:alert(1)' } }), { code: 'INVALID' });
});

test('deletePasskey and deleteItem', async () => {
  const { call, svc } = await setupUnlocked();
  const { item } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Site' } });
  await svc.mutateData((d) => {
    d.items[0].passkeys.push({ credentialId: 'a', rpId: 'x.com', privateKey: 'P1' }, { credentialId: 'b', rpId: 'x.com', privateKey: 'P2' });
  });
  await call(MSG.VAULT_DELETE_PASSKEY, { itemId: item.id, credentialId: 'a' });
  assert.deepEqual((await svc.readData()).items[0].passkeys.map((p) => p.credentialId), ['b']);
  await assert.rejects(call(MSG.VAULT_DELETE_PASSKEY, { itemId: item.id, credentialId: 'a' }), { code: 'NOT_FOUND' });
  await call(MSG.VAULT_DELETE_ITEM, { id: item.id });
  assert.deepEqual((await svc.readData()).items, []);
  await assert.rejects(call(MSG.VAULT_DELETE_ITEM, { id: item.id }), { code: 'NOT_FOUND' });
});

test('mutateData is serialized and persisted encrypted; readData returns a deep copy', async () => {
  const { svc, chrome } = await setupUnlocked();
  const order = [];
  await Promise.all([1, 2, 3].map((n) => svc.mutateData(async (d) => {
    order.push('start' + n);
    await new Promise((r) => setTimeout(r, 5));
    d.items.push(svc.makeItem({ title: 'note #' + n }));
    order.push('end' + n);
  })));
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
  const data = await svc.readData();
  assert.deepEqual(data.items.map((i) => i.title), ['note #1', 'note #2', 'note #3']);
  data.items.length = 0;
  assert.equal((await svc.readData()).items.length, 3);
  assert.ok(!JSON.stringify(chrome.storage.local.map.get(VAULT_KEY)).includes('note #1'));

  // A failing mutation writes nothing and does not block the queue.
  const before = chrome.storage.local.map.get(VAULT_KEY);
  await assert.rejects(svc.mutateData((d) => { d.items.length = 0; throw new Error('boom'); }));
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before);
  assert.equal((await svc.readData()).items.length, 3);
  assert.equal(await svc.mutateData(() => 'ok'), 'ok');
});

test('SW restart resumes from the session DEK; lock clears it', async () => {
  const first = await setupUnlocked();
  await first.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Persisted' } });
  // New service instance over the same storage = SW restarted.
  const second = makeService({ chrome: fakeChrome({ local: first.chrome.storage.local, session: first.chrome.storage.session }) });
  assert.equal(await second.svc.isLocked(), false);
  assert.equal((await second.svc.readData()).items[0].title, 'Persisted');
  await second.call(MSG.VAULT_LOCK);
  assert.equal(first.chrome.storage.session.map.has(SESSION_KEY), false);
  const third = makeService({ chrome: fakeChrome({ local: first.chrome.storage.local, session: first.chrome.storage.session }) });
  assert.equal(await third.svc.isLocked(), true);
});

test('auto-lock: alarm armed on unlock, re-armed by activity (throttled), fires lock', async () => {
  const { chrome, svc, clock, call } = await setupUnlocked();
  assert.deepEqual(chrome.alarms.map.get(AUTOLOCK_ALARM), { delayInMinutes: 15 });

  chrome.alarms.map.delete(AUTOLOCK_ALARM);
  clock.t += 10_000;
  await svc.touchActivity();
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false, 'throttled within 30 s');
  clock.t += 30_000;
  await call(MSG.ACTIVITY_PING);
  assert.deepEqual(chrome.alarms.map.get(AUTOLOCK_ALARM), { delayInMinutes: 15 });

  await chrome.alarms.fire(AUTOLOCK_ALARM);
  assert.equal(await svc.isLocked(), true);
  assert.equal(chrome.storage.session.map.has(SESSION_KEY), false);
  await assert.rejects(svc.readData(), { code: 'LOCKED' });
});

test('settings: defaults, validation, autoLockMinutes re-arms (0 = no alarm)', async () => {
  const { call, chrome, clock } = await setupUnlocked();
  assert.deepEqual(await call(MSG.SETTINGS_GET), { autoLockMinutes: 15, clipboardClearSeconds: 30 });
  for (const patch of [{ autoLockMinutes: 7 }, { theme: 'terminal' }, { clipboardClearSeconds: 5 }, { bogus: 1 }, { constructor: 1 }, null]) {
    await assert.rejects(call(MSG.SETTINGS_SET, { patch }), { code: 'INVALID' }, JSON.stringify(patch));
  }
  const s = await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: 5 } });
  assert.deepEqual(s, { autoLockMinutes: 5, clipboardClearSeconds: 30 });
  assert.deepEqual(chrome.storage.local.map.get(SETTINGS_KEY), s);
  assert.deepEqual(chrome.alarms.map.get(AUTOLOCK_ALARM), { delayInMinutes: 5 });
  clock.t += 1;
  await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: 0 } });
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false);
  await call(MSG.VAULT_LOCK);
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false, '0 = only when the browser closes');
});

test('settings: the retired theme key in old stored settings is dropped silently', async () => {
  const chrome = fakeChrome();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { autoLockMinutes: 30, theme: 'soft', clipboardClearSeconds: 10 } });
  const { call } = await setupUnlocked({ chrome });
  assert.deepEqual(await call(MSG.SETTINGS_GET), { autoLockMinutes: 30, clipboardClearSeconds: 10 });
  const s = await call(MSG.SETTINGS_SET, { patch: { clipboardClearSeconds: 60 } });
  assert.deepEqual(s, { autoLockMinutes: 30, clipboardClearSeconds: 60 });
  assert.deepEqual(chrome.storage.local.map.get(SETTINGS_KEY), s, 'theme is not written back');
});

test('unlock throttling: increasing delay after 5 consecutive failures, reset on success', async () => {
  const { call, sleeps } = await setupUnlocked();
  await call(MSG.VAULT_LOCK);
  for (let i = 0; i < 8; i++) {
    await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: 'wrong-' + i }), { code: 'BAD_PASSWORD' });
  }
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  assert.equal(sleeps.length, 4);
  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: 'wrong' }), { code: 'BAD_PASSWORD' });
  assert.equal(sleeps.length, 4, 'counter reset after success');
});

test('changePassword rotates salt and DEK, re-encrypts data, keeps the session usable', async () => {
  const { call, chrome, svc } = await setupUnlocked();
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Keep me' } });
  const before = chrome.storage.local.map.get(VAULT_KEY);
  const oldDek = await importDek(fromB64(chrome.storage.session.map.get(SESSION_KEY).dek));
  await assert.rejects(call(MSG.VAULT_CHANGE_PASSWORD, { current: 'wrong-password', next: 'next-password-2' }), { code: 'BAD_PASSWORD' });
  await assert.rejects(call(MSG.VAULT_CHANGE_PASSWORD, { current: PW, next: 'short' }), { code: 'INVALID' });
  await call(MSG.VAULT_CHANGE_PASSWORD, { current: PW, next: 'next-password-2' });

  const after = chrome.storage.local.map.get(VAULT_KEY);
  assert.notEqual(after.kdf.salt, before.kdf.salt);
  assert.notDeepEqual(after.wrappedKey, before.wrappedKey);
  assert.notDeepEqual(after.data, before.data);
  assert.notEqual(chrome.storage.session.map.get(SESSION_KEY).dek, toB64(await exportDek(oldDek)), 'session DEK replaced');
  await assert.rejects(decryptJson(oldDek, after.data), { code: 'INVALID' }, 'old DEK no longer opens the vault');

  // Still unlocked, also after a SW restart (session resume with the new DEK), and writes keep working.
  assert.equal(await svc.isLocked(), false);
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'After change' } });
  const restarted = makeService({ chrome: fakeChrome({ local: chrome.storage.local, session: chrome.storage.session }) });
  assert.deepEqual((await restarted.svc.readData()).items.map((i) => i.title), ['Keep me', 'After change']);

  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: PW }), { code: 'BAD_PASSWORD' });
  await call(MSG.VAULT_UNLOCK, { masterPassword: 'next-password-2' });
  assert.deepEqual((await svc.readData()).items.map((i) => i.title), ['Keep me', 'After change']);
});

test('verifyMasterPassword works locked or unlocked and counts toward throttling', async () => {
  const fresh = makeService();
  assert.equal(await fresh.svc.verifyMasterPassword(PW), false, 'no vault yet');

  const { call, svc, sleeps } = await setupUnlocked();
  assert.equal(await svc.verifyMasterPassword(PW), true);
  assert.equal(await svc.verifyMasterPassword('wrong-password'), false);
  assert.equal(await svc.verifyMasterPassword(''), false);
  assert.equal(await svc.isLocked(), false, 'verification does not change lock state');
  await call(MSG.VAULT_LOCK);
  assert.equal(await svc.verifyMasterPassword(PW), true);
  assert.equal(await svc.isLocked(), true, 'verification does not unlock');

  for (let i = 0; i < 5; i++) assert.equal(await svc.verifyMasterPassword('wrong-' + i), false);
  await assert.rejects(call(MSG.VAULT_UNLOCK, { masterPassword: 'wrong-x' }), { code: 'BAD_PASSWORD' });
  assert.deepEqual(sleeps, [1000], 'shared failure counter with unlock');

  const mod = await import('../../extension/src/background/vault-service.js');
  assert.equal(typeof mod.verifyMasterPassword, 'function');
});

test('export/import: backup opens with its own password and merges by id', async () => {
  const a = await setupUnlocked();
  const { item } = await a.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'From A', password: 'pa' } });
  const pk = {
    credentialId: toB64url(randomBytes(32)), rpId: 'a.com', userHandle: toB64url(randomBytes(16)), userName: 'hina',
    userDisplayName: 'Hina', privateKey: toB64url(randomBytes(138)), publicKey: toB64url(randomBytes(77)),
    alg: -7, signCount: 0, createdAt: 1000, lastUsedAt: null,
  };
  await a.svc.mutateData((d) => { d.items[0].passkeys.push(pk); });
  const { json } = await a.call(MSG.VAULT_EXPORT);
  assert.ok(!json.includes('From A'));
  assert.equal(JSON.parse(json).format, 'akari-backup');

  const b = makeService();
  await b.call(MSG.VAULT_SETUP, { masterPassword: 'other-password-b' });
  await b.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'From B' } });
  await assert.rejects(b.call(MSG.VAULT_IMPORT, { json, masterPassword: 'other-password-b' }), { code: 'BAD_PASSWORD' });
  await assert.rejects(b.call(MSG.VAULT_IMPORT, { json: '{"x":1}', masterPassword: PW }), { code: 'INVALID' });
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1 });
  const data = await b.svc.readData();
  assert.deepEqual(data.items.map((i) => i.title).sort(), ['From A', 'From B']);
  assert.deepEqual(data.items.find((i) => i.id === item.id).passkeys, [pk]);
  // Re-importing the same backup changes nothing (not newer).
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 0 });

  await b.call(MSG.VAULT_LOCK);
  await assert.rejects(b.call(MSG.VAULT_EXPORT), { code: 'LOCKED' });
  await assert.rejects(b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { code: 'LOCKED' });
});

test('clipboard/scheduleClear: default from settings, 0 = no-op, alarm + timer clear via offscreen', async () => {
  const calls = [];
  let contexts = [];
  const chrome = fakeChrome();
  chrome.runtime = {
    getURL: (p) => 'chrome-extension://id/' + p,
    async getContexts() { return contexts; },
    async sendMessage(msg) { calls.push(['send', msg]); return { ok: true }; },
  };
  chrome.offscreen = {
    async createDocument(opts) { calls.push(['create', opts]); contexts = [{}]; },
    async closeDocument() { calls.push(['close']); contexts = []; },
  };
  const timers = [];
  let settings = { clipboardClearSeconds: 30 };
  const clip = createClipboardService({
    chrome,
    getSettings: async () => settings,
    now: () => 1000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });

  await clip.scheduleClear({});
  assert.deepEqual(chrome.alarms.map.get(CLIPBOARD_ALARM), { when: 31000 });
  assert.equal(timers[0].ms, 30000);
  await clip.scheduleClear({ seconds: 10 });
  assert.deepEqual(chrome.alarms.map.get(CLIPBOARD_ALARM), { when: 11000 });
  await assert.rejects(clip.scheduleClear({ seconds: -1 }), { code: 'INVALID' });

  await clip.onAlarm({ name: CLIPBOARD_ALARM });
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'send', 'close']);
  assert.deepEqual(calls[0][1].reasons, ['CLIPBOARD']);
  assert.equal(calls[0][1].url, 'src/offscreen/offscreen.html');
  assert.deepEqual(calls[1][1], { target: 'offscreen', type: 'offscreen/clearClipboard' });
  assert.equal(chrome.alarms.map.has(CLIPBOARD_ALARM), false);

  settings = { clipboardClearSeconds: 0 };
  calls.length = 0;
  await clip.scheduleClear({});
  assert.equal(chrome.alarms.map.has(CLIPBOARD_ALARM), false);
  assert.equal(calls.length, 0);
});
