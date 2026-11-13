import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVaultService, VAULT_KEY, SETTINGS_KEY, SESSION_KEY, KEEP_KEY, AUTOLOCK_ALARM,
} from '../../extension/src/background/vault-service.js';
import { createClipboardService, CLIPBOARD_ALARM } from '../../extension/src/background/clipboard.js';
import { AkariError } from '../../extension/src/shared/errors.js';
import { MSG, NEVER_LOCK } from '../../extension/src/shared/messages.js';
import { importDek, exportDek, decryptJson } from '../../extension/src/lib/crypto.js';
import { fromB64, toB64, toB64url, randomBytes } from '../../extension/src/shared/bytes.js';
import { createCredential } from '../../extension/src/lib/webauthn.js';
import { csvToObjects } from '../../extension/src/lib/import/csv.js';
import { TYPE_IDS, typeOf, hasTemplate } from '../../extension/src/shared/item-types.js';
import { createAutofillService } from '../../extension/src/background/autofill-service.js';

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
    MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_ITEMS, MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_CHANGE_PASSWORD, MSG.VAULT_EXPORT, MSG.VAULT_IMPORT,
    MSG.SETTINGS_GET, MSG.SETTINGS_SET, MSG.ACTIVITY_PING, MSG.VAULT_IMPORT_ITEMS, MSG.VAULT_EXPORT_PLAIN,
  ]) assert.equal(typeof svc.handlers[type], 'function', type);
});

test('module exports the live API names', async () => {
  const mod = await import('../../extension/src/background/vault-service.js');
  for (const name of ['isLocked', 'readData', 'mutateData', 'onUnlocked', 'getSettings', 'touchActivity', 'sanitizeItem', 'makeItem']) {
    assert.equal(typeof mod[name], 'function', name);
  }
  assert.equal(typeof mod.makeItem({ title: 'x' }).id, 'string');
});

test('install restricts storage.session and storage.local to trusted contexts (no content scripts)', () => {
  const { chrome } = makeService();
  assert.equal(chrome.storage.session.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(chrome.storage.local.accessLevel, 'TRUSTED_CONTEXTS');
});

test('settings: "ロックしない" needs the master password, opens again after a restart, and any lock drops the key', async () => {
  const { call, chrome } = await setupUnlocked();
  const restart = () => { chrome.storage.session.map.clear(); return makeService({ chrome }); };

  await assert.rejects(call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK } }), { code: 'BAD_PASSWORD' });
  await assert.rejects(call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK }, masterPassword: 'wrong' }), { code: 'BAD_PASSWORD' });
  assert.equal((await call(MSG.SETTINGS_GET)).autoLockMinutes, 15, 'unchanged without the password');
  assert.equal(chrome.storage.local.map.has(KEEP_KEY), false);

  const s = await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK }, masterPassword: PW });
  assert.equal(s.autoLockMinutes, NEVER_LOCK);
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false, 'no auto-lock alarm');
  assert.equal(typeof chrome.storage.local.map.get(KEEP_KEY)?.dek, 'string', 'key kept on this device');
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'kept' } });

  const after = restart();
  assert.equal(await after.svc.isLocked(), false, 'opens without the master password');
  assert.equal((await after.call(MSG.VAULT_GET_ALL)).items[0].title, 'kept');
  assert.ok(chrome.storage.session.map.has(SESSION_KEY), 'session restored from the kept key');
  assert.equal(await after.call(MSG.VAULT_UNLOCK, { masterPassword: 'wrong' }).catch((e) => e.code), 'BAD_PASSWORD');

  const before = chrome.storage.local.map.get(KEEP_KEY).dek;
  await after.call(MSG.VAULT_CHANGE_PASSWORD, { current: PW, next: 'another-master-password' });
  assert.notEqual(chrome.storage.local.map.get(KEEP_KEY).dek, before);
  assert.equal(await restart().svc.isLocked(), false, 'still opens after the change');

  await after.call(MSG.VAULT_LOCK);
  assert.equal(chrome.storage.local.map.has(KEEP_KEY), false);
  assert.equal(await restart().svc.isLocked(), true);
  await after.call(MSG.VAULT_UNLOCK, { masterPassword: 'another-master-password' });
  assert.equal(chrome.storage.local.map.has(KEEP_KEY), true);

  await after.call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK } });
  await after.call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: 0 } });
  assert.equal(chrome.storage.local.map.has(KEEP_KEY), false);
  assert.equal(await restart().svc.isLocked(), true, 'locked after a restart again');

  await chrome.storage.local.set({ [KEEP_KEY]: { dek: before } });
  assert.equal(await restart().svc.isLocked(), true);

  await after.call(MSG.VAULT_LOCK);
  await assert.rejects(after.call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK }, masterPassword: 'another-master-password' }), { code: 'LOCKED' });
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
  const del = await call(MSG.VAULT_DELETE_ITEM, { id: item.id });
  assert.deepEqual(del.ids, [item.id]);
  assert.deepEqual((await svc.readData()).items, []);
  assert.deepEqual((await svc.readData()).trash.map((e) => e.id), [item.id], 'deleted items wait in the trash');
  await assert.rejects(call(MSG.VAULT_DELETE_ITEM, { id: item.id }), { code: 'NOT_FOUND' });
});

test('deleteItems: the selection goes in one write; ids already gone are skipped; bad payloads write nothing', async () => {
  const { call, svc, chrome } = await setupUnlocked();
  const ids = [];
  for (const title of ['A', 'B', 'C', 'D']) ids.push((await call(MSG.VAULT_SAVE_ITEM, { item: { title } })).item.id);
  const writes = [];
  const set = chrome.storage.local.set.bind(chrome.storage.local);
  chrome.storage.local.set = async (obj) => { writes.push(Object.keys(obj)); return set(obj); };

  const res = await call(MSG.VAULT_DELETE_ITEMS, { ids: [ids[0], ids[2], 'gone'] });
  assert.equal(res.deleted, 2);
  assert.deepEqual(res.ids.sort(), [ids[0], ids[2]].sort());
  assert.deepEqual(res.trash.map((e) => e.title).sort(), ['A', 'C']);
  assert.deepEqual(writes, [['akari.vault']], 'one encrypted write for the whole selection');
  assert.deepEqual((await svc.readData()).items.map((i) => i.title), ['B', 'D']);

  for (const bad of [undefined, [], 'id', [ids[1], 7], [''], new Array(20001).fill(ids[1])]) {
    await assert.rejects(call(MSG.VAULT_DELETE_ITEMS, { ids: bad }), { code: 'INVALID' }, JSON.stringify(bad)?.slice(0, 30));
  }
  await assert.rejects(call(MSG.VAULT_DELETE_ITEMS, { ids: [ids[0], 'gone'] }), { code: 'NOT_FOUND' });
  assert.equal(writes.length, 1, 'nothing written for refused requests');
  assert.equal((await svc.readData()).items.length, 2);

  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_DELETE_ITEMS, { ids: [ids[1]] }), { code: 'LOCKED' });
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

  const before = chrome.storage.local.map.get(VAULT_KEY);
  await assert.rejects(svc.mutateData((d) => { d.items.length = 0; throw new Error('boom'); }));
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before);
  assert.equal((await svc.readData()).items.length, 3);
  assert.equal(await svc.mutateData(() => 'ok'), 'ok');
});

test('SW restart resumes from the session DEK; lock clears it', async () => {
  const first = await setupUnlocked();
  await first.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Persisted' } });
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
  assert.deepEqual(await call(MSG.SETTINGS_GET), { autoLockMinutes: 15, clipboardClearSeconds: 30, language: 'auto', theme: 'dark' });
  for (const patch of [{ autoLockMinutes: 7 }, { theme: 'terminal' }, { theme: 'soft' }, { clipboardClearSeconds: 5 }, { language: 'fr' }, { language: 1 }, { bogus: 1 }, { constructor: 1 }, null]) {
    await assert.rejects(call(MSG.SETTINGS_SET, { patch }), { code: 'INVALID' }, JSON.stringify(patch));
  }
  const s = await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: 5 } });
  assert.deepEqual(s, { autoLockMinutes: 5, clipboardClearSeconds: 30, language: 'auto', theme: 'dark' });
  assert.equal((await call(MSG.SETTINGS_SET, { patch: { language: 'en' } })).language, 'en');
  for (const theme of ['light', 'auto', 'dark']) assert.equal((await call(MSG.SETTINGS_SET, { patch: { theme } })).theme, theme);
  await call(MSG.SETTINGS_SET, { patch: { language: 'auto' } });
  assert.deepEqual(chrome.storage.local.map.get(SETTINGS_KEY), s);
  assert.deepEqual(chrome.alarms.map.get(AUTOLOCK_ALARM), { delayInMinutes: 5 });
  clock.t += 1;
  await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: 0 } });
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false);
  await call(MSG.VAULT_LOCK);
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  assert.equal(chrome.alarms.map.has(AUTOLOCK_ALARM), false, '0 = only when the browser closes');
});

test('settings: a retired theme value in old stored settings reads as the dark default', async () => {
  const chrome = fakeChrome();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { autoLockMinutes: 30, theme: 'soft', clipboardClearSeconds: 10 } });
  const { call } = await setupUnlocked({ chrome });
  assert.deepEqual(await call(MSG.SETTINGS_GET), { autoLockMinutes: 30, clipboardClearSeconds: 10, language: 'auto', theme: 'dark' });
  const s = await call(MSG.SETTINGS_SET, { patch: { clipboardClearSeconds: 60 } });
  assert.deepEqual(s, { autoLockMinutes: 30, clipboardClearSeconds: 60, language: 'auto', theme: 'dark' });
  assert.deepEqual(chrome.storage.local.map.get(SETTINGS_KEY), s, 'the old value is not written back');
});

test('ゴミ箱: restore puts items back (into the first vault when theirs is gone), purge and expiry delete for good', async () => {
  const { call, svc, clock } = await setupUnlocked();
  const a = (await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'A', vault: 'work' } })).item;
  const b = (await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'B' } })).item;
  const c = (await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'C' } })).item;
  await call(MSG.VAULT_DELETE_ITEMS, { ids: [a.id, b.id, c.id] });
  const all = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.trash.map((e) => e.title).sort(), ['A', 'B', 'C']);
  assert.ok(all.trash.every((e) => typeof e.deletedAt === 'number'));

  await call(MSG.VAULT_DELETE_VAULT, { id: 'work' });
  const back = await call(MSG.VAULT_RESTORE_ITEMS, { ids: [a.id] });
  assert.deepEqual(back.items.map((i) => [i.title, i.vault]), [['A', 'personal']]);
  assert.equal('deletedAt' in back.items[0], false);
  assert.deepEqual((await svc.readData()).items.map((i) => i.title), ['A']);
  await assert.rejects(call(MSG.VAULT_RESTORE_ITEMS, { ids: [a.id] }), { code: 'NOT_FOUND' });

  const purged = await call(MSG.VAULT_PURGE_ITEMS, { ids: [b.id] });
  assert.equal(purged.purged, 1);
  assert.deepEqual(purged.trash.map((e) => e.title), ['C']);
  await assert.rejects(call(MSG.VAULT_PURGE_ITEMS, {}), { code: 'INVALID' });

  clock.t += 30 * 24 * 3600 * 1000;
  assert.deepEqual((await call(MSG.VAULT_GET_ALL)).trash, []);
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'D' } });
  assert.deepEqual((await svc.readData()).trash, []);
  await assert.rejects(call(MSG.VAULT_PURGE_ITEMS, { all: true }), { code: 'NOT_FOUND' });

  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'S', password: 'secret-pw', note: 'n' } });
  const s = (await svc.readData()).items.find((i) => i.title === 'S');
  const shown = (await call(MSG.VAULT_DELETE_ITEM, { id: s.id })).trash[0];
  assert.deepEqual(Object.keys(shown).sort(), ['attachmentBytes', 'deletedAt', 'hue', 'id', 'title', 'type', 'vault']);
  await call(MSG.VAULT_PURGE_ITEMS, { all: true });

  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'E', vault: 'family' } });
  const gone = await call(MSG.VAULT_DELETE_VAULT, { id: 'family', deleteItems: true });
  assert.equal(gone.deleted, 1);
  assert.deepEqual(gone.trash.map((e) => e.title), ['E']);
  assert.equal((await call(MSG.VAULT_PURGE_ITEMS, { all: true })).purged, 1);
  assert.deepEqual((await svc.readData()).trash, []);
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

  assert.equal(await svc.isLocked(), false, 'Still unlocked, also after a SW restart (session resume with the new DEK), and writes keep working');
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
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  const data = await b.svc.readData();
  assert.deepEqual(data.items.map((i) => i.title).sort(), ['From A', 'From B']);
  assert.deepEqual(data.items.find((i) => i.id === item.id).passkeys, [pk]);
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 0, skippedAttachments: 0 }, 'Re-importing the same backup changes nothing (not newer)');

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

async function importedPasskey(over = {}) {
  const cred = await createCredential({ rpId: 'github.com', userHandle: randomBytes(16), clientDataHash: randomBytes(32) });
  return {
    credentialId: toB64url(cred.credentialId), rpId: 'github.com', userHandle: toB64url(randomBytes(16)),
    userName: 'hina', userDisplayName: 'Hina', privateKey: toB64url(cred.privateKey), createdAt: 500, ...over,
  };
}

test('vault/importItems: one write, counts added/duplicates/invalid/passkeys, private keys stay in the SW', async () => {
  const { call, svc, chrome, clock } = await setupUnlocked();
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Mine', url: 'https://github.com', username: 'hina', password: 'pw1' } });
  const pk = await importedPasskey();
  const items = [
    { type: 'login', title: 'GitHub', url: 'https://github.com/login', username: 'hina', password: 'pw1', passkeys: [] },
    { type: 'login', title: 'GitHub alt', url: 'https://github.com', username: 'hina2', password: 'pw2', passkeys: [pk, { ...pk }] },
    { type: 'note', title: 'メモ', note: '本文', passkeys: [] },
    { type: 'note', title: 'メモ', note: '本文', passkeys: [] },
    { type: 'login', title: 'bad', password: 7 },
  ];
  let writes = 0;
  const set = chrome.storage.local.set.bind(chrome.storage.local);
  chrome.storage.local.set = async (obj) => { if (VAULT_KEY in obj) writes++; return set(obj); };
  clock.t += 1000;
  assert.deepEqual(await call(MSG.VAULT_IMPORT_ITEMS, { items, vault: 'work' }), { added: 2, duplicates: 2, invalid: 1, passkeys: 1 });
  assert.equal(writes, 1, 'one mutateData write for the whole batch');

  const { items: all } = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.map((i) => i.title).sort(), ['GitHub alt', 'Mine', 'メモ']);
  const alt = all.find((i) => i.title === 'GitHub alt');
  assert.equal(alt.vault, 'work');
  assert.equal(alt.passkeys.length, 1);
  assert.ok(!('privateKey' in alt.passkeys[0]), 'getAll strips privateKey');
  const stored = (await svc.readData()).items.find((i) => i.id === alt.id);
  assert.equal(stored.passkeys[0].privateKey, pk.privateKey);
  assert.equal(stored.createdAt, clock.t, 'no createdAt in the file → now');

  assert.deepEqual(await call(MSG.VAULT_IMPORT_ITEMS, { items, vault: 'work' }), { added: 0, duplicates: 4, invalid: 1, passkeys: 0 }, 'Same file again: everything is a duplicate, passkeys are not added twice');
});

test('vault/importItems: unknown vault / bad payload → INVALID without writing; locked → LOCKED', async () => {
  const { call, svc, chrome } = await setupUnlocked();
  const before = structuredClone(chrome.storage.local.map.get(VAULT_KEY));
  await assert.rejects(call(MSG.VAULT_IMPORT_ITEMS, { items: [{ title: 'x', username: 'u' }], vault: 'nope' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_IMPORT_ITEMS, { items: 'x', vault: 'personal' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_IMPORT_ITEMS, { items: [], vault: '' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_IMPORT_ITEMS, { items: new Array(20001).fill({}), vault: 'personal' }), { code: 'INVALID' });
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before, 'no write');
  assert.equal((await svc.readData()).items.length, 0);
  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_IMPORT_ITEMS, { items: [], vault: 'personal' }), { code: 'LOCKED' });
});

test('vault/exportPlain: master password re-check (throttled), CSV and Bitwarden JSON', async () => {
  const { call, svc, clock, sleeps } = await setupUnlocked();
  clock.t = new Date(2026, 10, 3, 12, 0, 0).getTime();
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'GitHub', url: 'https://github.com', username: 'hina', password: 'pw,1', vault: 'work' } });
  await call(MSG.VAULT_IMPORT_ITEMS, {
    items: [{ type: 'login', title: 'With passkey', url: 'https://example.com', username: 'u', password: 'p', passkeys: [await importedPasskey()] }],
    vault: 'personal',
  });
  const stored = (await svc.readData()).items.find((i) => i.title === 'With passkey').passkeys[0];

  for (let i = 0; i < 5; i++) {
    await assert.rejects(call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: 'wrong-' + i }), { code: 'BAD_PASSWORD' });
  }
  await assert.rejects(call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv' }), { code: 'BAD_PASSWORD' });
  await assert.rejects(call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: 'wrong-x' }), { code: 'BAD_PASSWORD' });
  assert.deepEqual(sleeps, [1000], 'wrong passwords count toward unlock throttling');
  await assert.rejects(call(MSG.VAULT_EXPORT_PLAIN, { format: 'xml', masterPassword: PW }), { code: 'INVALID' });

  const csv = await call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: PW });
  assert.equal(csv.filename, 'akari-export-20261103.csv');
  assert.equal(csv.count, 2);
  const { records } = csvToObjects(csv.text);
  assert.deepEqual(records.map((r) => [r.name, r.password, r.vault]).sort(), [['GitHub', 'pw,1', '仕事'], ['With passkey', 'p', '個人']]);
  assert.ok(!csv.text.includes(stored.privateKey), 'no passkey private keys in CSV');

  const bw = await call(MSG.VAULT_EXPORT_PLAIN, { format: 'bitwarden', masterPassword: PW });
  assert.equal(bw.filename, 'akari-export-20261103.json');
  assert.equal(bw.count, 2);
  const json = JSON.parse(bw.text);
  assert.equal(json.encrypted, false);
  const fido = json.items.find((i) => i.name === 'With passkey').login.fido2Credentials;
  assert.equal(fido.length, 1);
  assert.equal(fido[0].keyValue, stored.privateKey, 'Bitwarden format carries the passkey private key');
  assert.equal(fido[0].credentialId, 'b64.' + stored.credentialId);

  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: PW }), { code: 'LOCKED' });
});

function sampleFields(type) {
  const byKind = {
    text: (fd) => fd.key + ' value', secret: (fd) => 's3cret ' + fd.key, multiline: () => 'line 1\nline 2',
    'secret-multiline': () => '-----BEGIN KEY-----\nAAAA\n-----END KEY-----', date: () => '2030-01-31', month: () => '2030-12',
    email: () => 'hina@example.jp', tel: () => '+81 90-1234-5678', url: () => 'https://example.com/x', number: () => '5432',
    select: (fd) => fd.options[0].id,
  };
  const out = {};
  for (const fd of typeOf(type).fields) out[fd.key] = fd.format === 'card' ? '4111 1111 1111 1111' : byKind[fd.kind](fd);
  return out;
}

test('saveItem: all 18 types round-trip through saveItem → getAll, also after a SW restart', async () => {
  const { call, chrome } = await setupUnlocked();
  assert.equal(TYPE_IDS.length, 18);
  const extra = [{ label: '会員サイト', value: 'https://example.com', kind: 'text', secret: false }, { label: '合言葉', value: 'yama', kind: 'hidden', secret: true }];
  const saved = new Map();
  for (const type of TYPE_IDS) {
    const item = { type, title: 'T ' + type, note: 'n', vault: 'work', extra };
    if (type === 'login') Object.assign(item, { url: 'example.com', username: 'u', password: 'p' });
    if (hasTemplate(type)) item.fields = sampleFields(type);
    const r = await call(MSG.VAULT_SAVE_ITEM, { item });
    saved.set(type, r.item);
  }
  const { items } = await call(MSG.VAULT_GET_ALL);
  assert.equal(items.length, 18);
  for (const type of TYPE_IDS) {
    const got = items.find((i) => i.type === type);
    assert.deepEqual(got, saved.get(type), type);
    assert.deepEqual([got.title, got.note, got.vault, got.extra], ['T ' + type, 'n', 'work', extra], type);
    if (hasTemplate(type)) assert.deepEqual(got.fields, sampleFields(type), type);
    else assert.ok(!('fields' in got), type);
    if (type === 'login') assert.equal(got.url, 'https://example.com');
    else for (const k of ['url', 'username', 'password', 'totp', 'passkeys', 'passwordUpdatedAt']) assert.ok(!(k in got), `${type}.${k}`);
  }
  const restarted = makeService({ chrome: fakeChrome({ local: chrome.storage.local, session: chrome.storage.session }) });
  assert.deepEqual((await restarted.call(MSG.VAULT_GET_ALL)).items, items);
});

test('saveItem: partial saves keep fields/extra, full saves replace them; bad payloads write nothing', async () => {
  const { call, chrome, clock } = await setupUnlocked();
  const extra = [{ label: 'PIN2', value: '9999', kind: 'hidden', secret: true }];
  const { item: card } = await call(MSG.VAULT_SAVE_ITEM, {
    item: { type: 'card', title: 'Visa', fields: { cardholder: 'HINA', number: '4111 1111 1111 1111', expiry: '2030-12', cvv: '123' }, extra },
  });
  clock.t += 1000;
  const { item: fav } = await call(MSG.VAULT_SAVE_ITEM, { item: { id: card.id, fav: true } });
  assert.deepEqual([fav.fav, fav.fields, fav.extra, fav.updatedAt], [true, card.fields, extra, clock.t]);

  const { item: f2 } = await call(MSG.VAULT_SAVE_ITEM, { item: { id: card.id, fields: { number: '5555555555554444' } } });
  assert.deepEqual(f2.fields, { number: '5555555555554444' }, 'fields are replaced as a whole');
  assert.deepEqual(f2.extra, extra);

  const { item: full } = await call(MSG.VAULT_SAVE_ITEM, { item: { ...f2, title: 'Visa 2', fields: { ...f2.fields, cvv: '000' }, extra: [] } });
  assert.deepEqual([full.title, full.fields, full.extra], ['Visa 2', { number: '5555555555554444', cvv: '000' }, []]);
  assert.equal(full.createdAt, card.createdAt);

  const before = structuredClone(chrome.storage.local.map.get(VAULT_KEY));
  for (const item of [
    { id: card.id, type: 'identity' }, { id: card.id, fields: { bogus: '1' } }, { id: card.id, fields: { expiry: '2030-13' } },
    { id: card.id, username: 'u' }, { id: card.id, extra: 'x' }, { type: 'wifi', fields: { security: 'WPA2' } },
    { type: 'note', fields: { a: '1' } }, { type: 'card', password: 'p' }, { id: 5, title: 'x' },
  ]) await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item }), { code: 'INVALID' }, JSON.stringify(item));
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { id: 'missing', fields: { cvv: '1' } } }), { code: 'NOT_FOUND' });
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before, 'no write');
});

test('saveItem: a legacy note (url/username/password = \'\') still saves and loses the empty login keys', async () => {
  const { call, svc } = await setupUnlocked();
  const legacy = {
    id: 'legacy-1', type: 'note', vault: 'personal', title: 'Old memo', url: '', username: '', password: '', totp: null,
    note: 'body', fav: false, hue: 10, passkeys: [], createdAt: 1, updatedAt: 1, passwordUpdatedAt: null, lastUsedAt: null,
  };
  const filled = { ...legacy, id: 'legacy-2', title: 'Router', url: 'https://router.example', username: 'admin', password: 'pw' };
  await svc.mutateData((d) => { d.items.push(structuredClone(legacy), structuredClone(filled)); });
  const { items } = await call(MSG.VAULT_GET_ALL);
  assert.equal(items.find((i) => i.id === 'legacy-1').url, '', 'read as stored');

  const { item } = await call(MSG.VAULT_SAVE_ITEM, { item: { ...items.find((i) => i.id === 'legacy-1'), fav: true } });
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'fav', 'hue', 'id', 'lastUsedAt', 'note', 'title', 'type', 'updatedAt', 'vault']);
  assert.equal(item.fav, true);

  const { item: kept } = await call(MSG.VAULT_SAVE_ITEM, { item: { ...items.find((i) => i.id === 'legacy-2'), note: 'edited' } });
  assert.deepEqual([kept.url, kept.username, kept.password, kept.note], ['https://router.example', 'admin', 'pw', 'edited']);
  assert.ok(!('totp' in kept) && !('passkeys' in kept));
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { id: 'legacy-2', password: 'new' } }), { code: 'INVALID' });
});

test('autofill over the real vault service never offers or fills non-login types', async () => {
  const { call, svc } = await setupUnlocked();
  const site = 'https://github.com/login';
  const { item: loginItem } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'GitHub', url: 'https://github.com', username: 'hina', password: 'pw' } });
  const others = [];
  for (const type of TYPE_IDS.filter((t) => t !== 'login')) {
    const item = { type, title: 'github.com', note: 'https://github.com' };
    if (hasTemplate(type)) {
      item.fields = sampleFields(type);
      for (const fd of typeOf(type).fields) if (fd.kind === 'url') item.fields[fd.key] = 'https://github.com';
    }
    others.push((await call(MSG.VAULT_SAVE_ITEM, { item })).item);
  }
  await svc.mutateData((d) => {
    d.items.push({ ...svc.makeItem({ title: 'legacy', url: 'https://github.com', username: 'old', password: 'old-pw' }), type: 'note', id: 'legacy-note' });
  });
  const tabs = { 1: { id: 1, url: site } };
  const chrome = {
    tabs: { get: async (id) => tabs[id], query: async () => [tabs[1]], sendMessage: async () => ({ filled: true }) },
    scripting: { executeScript: async () => {} },
    action: { openPopup: async () => {} },
  };
  const autofill = createAutofillService({ chrome, vault: svc, now: () => Date.now() });
  const sender = { url: site, frameId: 0, tab: tabs[1] };

  assert.deepEqual((await autofill.matches({ tabId: 1 })).items.map((i) => i.id), [loginItem.id]);
  assert.deepEqual((await autofill.pageMatches({}, sender)).items.map((i) => i.id), [loginItem.id]);
  for (const id of [...others.map((i) => i.id), 'legacy-note']) {
    await assert.rejects(autofill.fill({ tabId: 1, itemId: id }), { code: 'NOT_FOUND' }, id);
    await assert.rejects(autofill.requestFill({ itemId: id }, sender), { code: 'NOT_FOUND' }, id);
  }
  assert.equal((await autofill.offerSave({ username: 'old', password: 'old-pw' }, sender)).action, 'new');
  assert.deepEqual((await autofill.requestFill({ itemId: loginItem.id }, sender)), { username: 'hina', password: 'pw' });
});

test('vault/importItems and exportPlain with typed items', async () => {
  const { call } = await setupUnlocked();
  const visa = { type: 'card', title: 'Visa', fields: { number: '4111 1111 1111 1111', expiry: '2030-04', cvv: '123' }, extra: [{ label: 'PIN2', value: '1', secret: true }] };
  const items = [
    visa,
    { ...visa, fields: { ...visa.fields, number: '4111111111111111' } },
    { type: 'identity', title: 'Me', fields: { lastName: '佐藤', firstName: 'ひな', email: 'hina@example.jp', website: 'example.jp' } },
    { type: 'wifi', title: 'Home', fields: { ssid: 'Home', password: 'wifi-pw', security: 'wpa3' } },
    { type: 'card', title: 'bad', url: 'https://x.example' },
  ];
  assert.deepEqual(await call(MSG.VAULT_IMPORT_ITEMS, { items, vault: 'personal' }), { added: 3, duplicates: 1, invalid: 1, passkeys: 0 });
  assert.deepEqual(await call(MSG.VAULT_IMPORT_ITEMS, { items, vault: 'personal' }), { added: 0, duplicates: 4, invalid: 1, passkeys: 0 });
  const { items: all } = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.find((i) => i.type === 'identity').fields.website, 'https://example.jp');

  const bw = JSON.parse((await call(MSG.VAULT_EXPORT_PLAIN, { format: 'bitwarden', masterPassword: PW })).text);
  assert.deepEqual(bw.items.map((i) => i.type).sort(), [2, 3, 4]);
  assert.equal(bw.items.find((i) => i.type === 3).card.number, '4111111111111111');
  const csv = csvToObjects((await call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: PW })).text).records;
  assert.equal(csv.find((r) => r.name === 'Home').note, 'ネットワーク名: Home\nパスワード: wifi-pw\nセキュリティ: WPA3');
});

test('vaults: create / rename / recolor, with names validated and nothing written on errors', async () => {
  const { call, svc, chrome } = await setupUnlocked();
  assert.deepEqual((await call(MSG.VAULT_GET_ALL)).vaults.map((v) => v.id), ['personal', 'work', 'family']);

  const made = await call(MSG.VAULT_CREATE_VAULT, { name: '  趣味  ', hue: 300 });
  assert.equal(made.vault.name, '趣味');
  assert.equal(made.vault.hue, 300);
  assert.match(made.vault.id, /^v-[A-Za-z0-9_-]{8}$/);
  assert.deepEqual(made.vaults.map((v) => v.name), ['個人', '仕事', '家族', '趣味']);
  await call(MSG.VAULT_CREATE_VAULT, { name: 'Side Project', hue: 0 });

  const before = structuredClone(chrome.storage.local.map.get(VAULT_KEY));
  for (const [payload, why] of [
    [{ name: '', hue: 10 }, 'empty'],
    [{ name: '   ', hue: 10 }, 'blank'],
    [{ name: 'あ'.repeat(41), hue: 10 }, 'too long'],
    [{ name: 'a\nb', hue: 10 }, 'control character'],
    [{ name: '趣味', hue: 10 }, 'duplicate'],
    [{ name: 'ｓｉｄｅ project', hue: 10 }, 'duplicate after NFKC + case folding'],
    [{ name: 'x', hue: 360 }, 'hue out of range'],
    [{ name: 'x', hue: '10' }, 'hue not a number'],
    [{ name: 42, hue: 10 }, 'name not a string'],
  ]) await assert.rejects(call(MSG.VAULT_CREATE_VAULT, payload), { code: 'INVALID' }, why);
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before, 'refused calls write nothing');
  await call(MSG.VAULT_CREATE_VAULT, { name: 'あ'.repeat(40), hue: 10 });
  await call(MSG.VAULT_DELETE_VAULT, { id: (await svc.readData()).vaults.at(-1).id, moveTo: null });

  const id = made.vault.id;
  assert.equal((await call(MSG.VAULT_UPDATE_VAULT, { id, name: 'ホビー' })).vault.name, 'ホビー');
  assert.equal((await call(MSG.VAULT_UPDATE_VAULT, { id, hue: 200 })).vault.hue, 200);
  assert.equal((await call(MSG.VAULT_UPDATE_VAULT, { id, name: 'ホビー', hue: 200 })).vault.name, 'ホビー', 'its own name is not a duplicate');
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { id, name: '仕事' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { id }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { id, hue: -1 }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { id: 'nope', name: 'x' }), { code: 'NOT_FOUND' });
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { name: 'x' }), { code: 'INVALID' });
  const stored = (await svc.readData()).vaults.find((v) => v.id === id);
  assert.deepEqual(stored, { id, name: 'ホビー', hue: 200 });

  while ((await svc.readData()).vaults.length < 20) await call(MSG.VAULT_CREATE_VAULT, { name: 'v' + (await svc.readData()).vaults.length, hue: 1 });
  await assert.rejects(call(MSG.VAULT_CREATE_VAULT, { name: 'one too many', hue: 1 }), { code: 'INVALID' });

  await call(MSG.VAULT_LOCK);
  await assert.rejects(call(MSG.VAULT_CREATE_VAULT, { name: 'x', hue: 1 }), { code: 'LOCKED' });
  await assert.rejects(call(MSG.VAULT_UPDATE_VAULT, { id, name: 'x' }), { code: 'LOCKED' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id, moveTo: null }), { code: 'LOCKED' });
});

test('vaults: delete moves the items to another vault, or deletes them with it; the last vault stays', async () => {
  const { call, svc, clock } = await setupUnlocked();
  const save = async (title, vault) => (await call(MSG.VAULT_SAVE_ITEM, { item: { title, vault } })).item;
  const a = await save('a', 'work');
  const b = await save('b', 'work');
  await save('c', 'family');
  await save('d', 'personal');

  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: 'work' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: 'nope' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: 7 }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: 'personal', deleteItems: true }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', deleteItems: 'yes' }), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'nope', moveTo: null }), { code: 'NOT_FOUND' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work' }), { code: 'NOT_EMPTY' });
  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: null, deleteItems: false }), { code: 'NOT_EMPTY' });
  assert.equal((await svc.readData()).vaults.length, 3, 'nothing removed by the refused calls');

  clock.t += 5000;
  const moved = await call(MSG.VAULT_DELETE_VAULT, { id: 'work', moveTo: 'personal' });
  assert.deepEqual([moved.moved, moved.deleted], [2, 0]);
  assert.deepEqual(moved.vaults.map((v) => v.id), ['personal', 'family']);
  let data = await svc.readData();
  for (const id of [a.id, b.id]) {
    const it = data.items.find((x) => x.id === id);
    assert.equal(it.vault, 'personal');
    assert.equal(it.updatedAt, clock.t, 'a moved item counts as changed');
  }

  const gone = await call(MSG.VAULT_DELETE_VAULT, { id: 'family', deleteItems: true });
  assert.deepEqual([gone.moved, gone.deleted], [0, 1]);
  data = await svc.readData();
  assert.deepEqual(data.items.map((i) => i.title).sort(), ['a', 'b', 'd']);
  assert.deepEqual(data.vaults.map((v) => v.id), ['personal']);

  await assert.rejects(call(MSG.VAULT_DELETE_VAULT, { id: 'personal', moveTo: null }), { code: 'INVALID' });
  assert.equal((await svc.readData()).items.length, 3);
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { title: 'x', vault: 'work' } }), { code: 'INVALID' }, 'a new item can only go into a vault that exists');
});

test('saveItem keeps the replaced password; vault/pendingPassword holds, confirms and discards', async () => {
  const { call, svc, clock } = await setupUnlocked();
  const { item } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Site', password: 'one' } });
  clock.t += 1000;
  await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, password: 'two' } });
  await call(MSG.VAULT_SAVE_ITEM, { item: { ...item, password: 'two', passwordHistory: [{ password: 'forged', changedAt: 1 }] } });
  let stored = (await svc.readData()).items[0];
  assert.deepEqual(stored.passwordHistory, [{ password: 'one', changedAt: clock.t }]);

  const pend = (action, password) => call(MSG.VAULT_PENDING_PASSWORD, { id: item.id, action, password });
  const res = await pend('set', 'three');
  assert.deepEqual(res.item.pendingPassword, { password: 'three', createdAt: clock.t });
  stored = (await svc.readData()).items[0];
  assert.equal(stored.password, 'two', 'autofill keeps the current password while the change is pending');
  clock.t += 1000;
  await pend('confirm');
  stored = (await svc.readData()).items[0];
  assert.equal(stored.password, 'three');
  assert.equal(stored.pendingPassword, undefined);
  assert.deepEqual(stored.passwordHistory.map((h) => h.password), ['two', 'one']);
  await assert.rejects(pend('confirm'), { code: 'NOT_FOUND' }, 'nothing pending');
  await pend('set', 'four');
  await pend('discard');
  stored = (await svc.readData()).items[0];
  assert.equal(stored.password, 'three');
  assert.equal(stored.pendingPassword, undefined);

  await assert.rejects(pend('set', 'three'), { code: 'INVALID' }, 'already current');
  await assert.rejects(pend('set', ''), { code: 'INVALID' });
  await assert.rejects(pend('replace', 'x'), { code: 'INVALID' });
  await assert.rejects(call(MSG.VAULT_PENDING_PASSWORD, { id: 'nope', action: 'discard' }), { code: 'NOT_FOUND' });
  const note = (await call(MSG.VAULT_SAVE_ITEM, { item: { type: 'note', title: 'N', note: 'n' } })).item;
  await assert.rejects(call(MSG.VAULT_PENDING_PASSWORD, { id: note.id, action: 'set', password: 'x' }), { code: 'INVALID' });
});

const ATT_PREFIX = 'akari.att.';
const fileB64 = (s) => toB64(new TextEncoder().encode(s));
const attKeys = (chrome) => [...chrome.storage.local.map.keys()].filter((k) => k.startsWith(ATT_PREFIX)).sort();
const keyOf = (id) => ATT_PREFIX + id;
const hasKeyField = (v) => JSON.stringify(v).includes('"key"');

async function settle(svc) {
  await new Promise((r) => setTimeout(r, 0));
  await svc.mutateData(() => {});
}

async function withItem(opts) {
  const ctx = await setupUnlocked(opts);
  const { item } = await ctx.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Doc', note: 'n' } });
  return { ...ctx, item };
}

function failVaultWrites(chrome) {
  const local = chrome.storage.local;
  const realSet = local.set.bind(local);
  local.set = async (obj) => {
    if (VAULT_KEY in obj) throw new Error('disk full');
    return realSet(obj);
  };
  return () => { local.set = realSet; };
}

test('attachments: add and get round trip; the per-file key never leaves the service worker', async () => {
  const { call, svc, chrome, clock, item } = await withItem();
  clock.t += 5000;
  const added = await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'scan.pdf', mime: 'Application/PDF', data: fileB64('hello pdf') });
  const [meta] = added.item.attachments;
  assert.deepEqual(Object.keys(meta).sort(), ['addedAt', 'id', 'mime', 'name', 'size']);
  assert.deepEqual([meta.name, meta.mime, meta.size, meta.addedAt], ['scan.pdf', 'application/pdf', 9, clock.t]);
  assert.match(meta.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(added.item.updatedAt, clock.t);

  const box = chrome.storage.local.map.get(keyOf(meta.id));
  assert.deepEqual(Object.keys(box).sort(), ['ct', 'iv', 'v']);
  assert.equal(box.v, 1);
  assert.ok(!JSON.stringify(box).includes(fileB64('hello pdf')));
  const storedItem = (await svc.readData()).items[0];
  assert.equal(fromB64(storedItem.attachments[0].key).length, 32);
  assert.equal(hasKeyField(svc.sanitizeItem(storedItem)), false);

  assert.deepEqual(await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: meta.id }),
    { name: 'scan.pdf', mime: 'application/pdf', size: 9, data: fileB64('hello pdf') });

  const second = await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'b.bin', mime: 'text/plain; charset=utf-8', data: fileB64('b') });
  assert.deepEqual(second.item.attachments.map((a) => [a.name, a.mime]), [['scan.pdf', 'application/pdf'], ['b.bin', '']]);

  const outputs = [
    added, second, await call(MSG.VAULT_GET_ALL), await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, title: 'Doc 2' } }),
    await call(MSG.VAULT_DELETE_ITEM, { id: item.id }), await call(MSG.VAULT_RESTORE_ITEMS, { ids: [item.id] }),
  ];
  for (const out of outputs) assert.equal(hasKeyField(out), false, JSON.stringify(out).slice(0, 80));
});

test('attachments: concurrent adds are applied in dispatch order and each quota check sees the earlier ones', async () => {
  const { call, chrome, item } = await withItem();
  const runs = Array.from({ length: 11 }, (_, i) => call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: `f${i}`, mime: '', data: fileB64('x'.repeat(11 - i)) }));
  const results = await Promise.allSettled(runs);
  assert.deepEqual(results.map((r) => r.status), [...Array(10).fill('fulfilled'), 'rejected']);
  assert.equal(results[10].reason.code, 'QUOTA');
  const { items } = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(items[0].attachments.map((a) => a.name), Array.from({ length: 10 }, (_, i) => `f${i}`));
  assert.equal(attKeys(chrome).length, 10);
});

test('attachments: inputs are checked before any work; failures write nothing', async () => {
  const { call, chrome, item } = await withItem();
  const add = (over) => call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a.txt', mime: 'text/plain', data: fileB64('x'), ...over });
  const before = structuredClone(chrome.storage.local.map.get(VAULT_KEY));
  for (const over of [
    { name: 5 }, { name: '' }, { name: '   ' }, { name: '\u0000\u0007' }, { name: undefined },
    { data: 5 }, { data: '***' }, { data: '' }, { itemId: '' }, { itemId: 7 }, { itemId: 'i'.repeat(101) },
  ]) await assert.rejects(add(over), { code: 'INVALID' }, JSON.stringify(over).slice(0, 60));
  for (const name of ['n'.repeat(256), ' \u0000' + '\u{1F600}'.repeat(256), 'n'.repeat(5000)]) {
    await assert.rejects(add({ name }), { code: 'QUOTA' }, name.slice(0, 20));
  }
  const tooLong = 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4);
  await assert.rejects(add({ data: tooLong }), { code: 'QUOTA' });
  await assert.rejects(add({ data: toB64(new Uint8Array(5 * 1024 * 1024 + 1)) }), { code: 'QUOTA' });
  await assert.rejects(add({ itemId: 'missing' }), { code: 'NOT_FOUND' });
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before);
  assert.deepEqual(attKeys(chrome), []);

  const odd = await add({ name: ' ..\\evil/‮txt.exe\u0000 ', mime: 'x'.repeat(101) });
  assert.deepEqual([odd.item.attachments[0].name, odd.item.attachments[0].mime], ['.._evil_txt.exe', '']);
  assert.equal((await add({ name: '\u{1F600}'.repeat(255), mime: 'image/svg+xml' })).item.attachments[1].mime, 'image/svg+xml');
  const max = await add({ data: toB64(new Uint8Array(5 * 1024 * 1024).fill(7)) });
  assert.equal(max.item.attachments[2].size, 5 * 1024 * 1024);

  await call(MSG.VAULT_LOCK);
  await assert.rejects(add({}), { code: 'LOCKED' });
  await assert.rejects(call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: odd.item.attachments[0].id }), { code: 'LOCKED' });
});

test('attachments: per-item and vault-wide limits are QUOTA; trash counts toward the total and reports its bytes', async () => {
  const { call, chrome, item } = await withItem();
  for (let i = 0; i < 10; i++) await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: `f${i}`, mime: '', data: fileB64('x' + i) });
  await assert.rejects(call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'f10', mime: '', data: fileB64('x') }), { code: 'QUOTA' });
  assert.equal(attKeys(chrome).length, 10);

  const { item: big } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Big' } });
  const mib5 = toB64(new Uint8Array(5 * 1024 * 1024));
  for (let i = 0; i < 6; i++) await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: big.id, name: `b${i}`, mime: '', data: mib5 });
  const deleted = await call(MSG.VAULT_DELETE_ITEM, { id: big.id });
  assert.equal(deleted.trash[0].attachmentBytes, 30 * 1024 * 1024);
  const { item: plain } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Plain' } });
  assert.deepEqual((await call(MSG.VAULT_DELETE_ITEM, { id: plain.id })).trash.map((e) => e.attachmentBytes), [0, 30 * 1024 * 1024]);

  const { item: other } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Other' } });
  const rest = toB64(new Uint8Array(32 * 1024 * 1024 - 30 * 1024 * 1024 - 20));
  await assert.rejects(call(MSG.VAULT_ADD_ATTACHMENT, { itemId: other.id, name: 'r', mime: '', data: mib5 }), { code: 'QUOTA' });
  await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: other.id, name: 'r', mime: '', data: rest });
  await assert.rejects(call(MSG.VAULT_ADD_ATTACHMENT, { itemId: other.id, name: 'one more byte', mime: '', data: fileB64('z') }), { code: 'QUOTA' });
  await assert.rejects(call(MSG.VAULT_ADD_ATTACHMENT, { itemId: big.id, name: 'trashed', mime: '', data: fileB64('z') }), { code: 'NOT_FOUND' });
  await call(MSG.VAULT_PURGE_ITEMS, { ids: [big.id] });
  await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: other.id, name: 'fits now', mime: '', data: mib5 });
});

test('attachments: get checks the id, the owner item, the bytes and their integrity', async () => {
  const { call, chrome, item } = await withItem();
  const { item: other } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Other' } });
  const [a] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('aaa') })).item.attachments;
  const [b] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: other.id, name: 'b', mime: '', data: fileB64('bbb') })).item.attachments;
  const get = (itemId, attachmentId) => call(MSG.VAULT_GET_ATTACHMENT, { itemId, attachmentId });
  for (const id of ['../akari.vault', 'x', a.id.toUpperCase(), 5, undefined]) await assert.rejects(get(item.id, id), { code: 'INVALID' }, String(id));
  await assert.rejects(get(item.id, b.id), { code: 'NOT_FOUND' }, 'an id from another item');
  await assert.rejects(get('missing', a.id), { code: 'NOT_FOUND' });

  chrome.storage.local.map.set(keyOf(a.id), structuredClone(chrome.storage.local.map.get(keyOf(b.id))));
  await assert.rejects(get(item.id, a.id), { code: 'INVALID' }, 'bytes of another attachment do not decrypt');
  const box = chrome.storage.local.map.get(keyOf(b.id));
  const ct = fromB64(box.ct);
  ct[0] ^= 1;
  chrome.storage.local.map.set(keyOf(b.id), { ...box, ct: toB64(ct) });
  await assert.rejects(get(other.id, b.id), { code: 'INVALID' });
  chrome.storage.local.map.set(keyOf(b.id), { v: 2, iv: box.iv, ct: box.ct });
  await assert.rejects(get(other.id, b.id), { code: 'INVALID' });
  chrome.storage.local.map.delete(keyOf(b.id));
  await assert.rejects(get(other.id, b.id), { code: 'NOT_FOUND' });
});

test('attachments: saveItem keeps only the listed ids, refuses unknown ones, and deletes the dropped bytes', async () => {
  const { call, svc, chrome, item } = await withItem();
  const add = async (name) => (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name, mime: '', data: fileB64(name) })).item;
  await add('a');
  await add('b');
  const [a, b, c] = (await add('c')).attachments;

  const unchanged = (await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, title: 'renamed' } })).item;
  assert.deepEqual(unchanged.attachments.map((x) => x.name), ['a', 'b', 'c']);
  const before = structuredClone(chrome.storage.local.map.get(VAULT_KEY));
  for (const attachments of [[{ id: 'nope' }], [{ id: a.id }, { id: crypto.randomUUID() }], 'x', [null], [a.id]]) {
    await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, attachments } }), { code: 'INVALID' }, JSON.stringify(attachments));
  }
  await assert.rejects(call(MSG.VAULT_SAVE_ITEM, { item: { title: 'new', attachments: [{ id: a.id }] } }), { code: 'INVALID' });
  assert.deepEqual(chrome.storage.local.map.get(VAULT_KEY), before);

  const kept = (await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, attachments: [{ id: c.id, name: 'ignored', key: 'ignored' }, { id: a.id }] } })).item;
  assert.deepEqual(kept.attachments.map((x) => x.name), ['a', 'c'], 'stored order, stored metadata');
  assert.deepEqual(attKeys(chrome), [keyOf(a.id), keyOf(c.id)].sort());
  assert.equal(chrome.storage.local.map.has(keyOf(b.id)), false);

  const none = (await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, attachments: [] } })).item;
  assert.equal('attachments' in none, false);
  assert.equal('attachments' in (await svc.readData()).items[0], false);
  assert.deepEqual(attKeys(chrome), []);
  const fresh = (await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'new', attachments: [] } })).item;
  assert.equal('attachments' in fresh, false);
});

test('attachments: trash and restore keep the bytes; purge and the 30-day expiry delete them', async () => {
  const { call, chrome, clock, item } = await withItem();
  const { item: two } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Two' } });
  const [a] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('aaa') })).item.attachments;
  const [b] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: two.id, name: 'b', mime: '', data: fileB64('bbb') })).item.attachments;

  const trashed = await call(MSG.VAULT_DELETE_ITEMS, { ids: [item.id, two.id] });
  assert.deepEqual(trashed.trash.map((e) => e.attachmentBytes), [3, 3]);
  assert.deepEqual(attKeys(chrome), [keyOf(a.id), keyOf(b.id)].sort());
  const back = await call(MSG.VAULT_RESTORE_ITEMS, { ids: [item.id] });
  assert.deepEqual(back.items[0].attachments.map((x) => x.id), [a.id]);
  assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: a.id })).data, fileB64('aaa'));

  await call(MSG.VAULT_DELETE_ITEM, { id: item.id });
  await call(MSG.VAULT_PURGE_ITEMS, { ids: [item.id] });
  assert.deepEqual(attKeys(chrome), [keyOf(b.id)]);

  clock.t += 30 * 24 * 3600 * 1000;
  await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'any write prunes' } });
  assert.deepEqual(attKeys(chrome), []);
});

test('attachments: when sealing the vault fails the new bytes are removed; a failed delete does not fail the write', async () => {
  const { call, chrome, item } = await withItem();
  const restore = failVaultWrites(chrome);
  await assert.rejects(call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('a') }), /disk full/);
  assert.deepEqual(attKeys(chrome), []);
  restore();

  const [a] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('a') })).item.attachments;
  const local = chrome.storage.local;
  const realRemove = local.remove.bind(local);
  local.remove = async (keys) => {
    if ([keys].flat().some((k) => k.startsWith(ATT_PREFIX))) throw new Error('io');
    return realRemove(keys);
  };
  const saved = await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, attachments: [] } });
  assert.equal('attachments' in saved.item, false);
  assert.ok(chrome.storage.local.map.has(keyOf(a.id)), 'orphan left behind, write still succeeded');
});

test('attachments: Akari backup carries the encrypted bytes and restores them; missing or bad ones are skipped and counted', async () => {
  const a = await withItem();
  const add = async (itemId, name, text) => (await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId, name, mime: 'text/plain', data: fileB64(text) })).item.attachments.at(-1);
  const one = await add(a.item.id, 'one.txt', 'first');
  const two = await add(a.item.id, 'two.txt', 'second');
  const { item: gone } = await a.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Trashed' } });
  const trashed = await add(gone.id, 'trash.txt', 'trash');
  await a.call(MSG.VAULT_DELETE_ITEM, { id: gone.id });

  const { json } = await a.call(MSG.VAULT_EXPORT);
  const backup = JSON.parse(json);
  assert.deepEqual(Object.keys(backup.attachments).sort(), [one.id, two.id].sort(), 'live items only');
  assert.deepEqual(backup.attachments[one.id], a.chrome.storage.local.map.get(keyOf(one.id)));
  assert.ok(!json.includes(fileB64('first')) && !json.includes('one.txt'));

  const b = await setupUnlocked();
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  assert.deepEqual(await b.call(MSG.VAULT_GET_ATTACHMENT, { itemId: a.item.id, attachmentId: two.id }),
    { name: 'two.txt', mime: 'text/plain', size: 6, data: fileB64('second') });
  assert.deepEqual(attKeys(b.chrome), [keyOf(one.id), keyOf(two.id)].sort());
  assert.equal(attKeys(b.chrome).includes(keyOf(trashed.id)), false);
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 0, skippedAttachments: 0 });

  const broken = structuredClone(backup);
  delete broken.attachments[one.id];
  const ct = fromB64(broken.attachments[two.id].ct);
  ct[3] ^= 1;
  broken.attachments[two.id].ct = toB64(ct);
  const c = await setupUnlocked();
  assert.deepEqual(await c.call(MSG.VAULT_IMPORT, { json: JSON.stringify(broken), masterPassword: PW }), { count: 1, skippedAttachments: 2 });
  assert.equal('attachments' in (await c.svc.readData()).items[0], false);
  assert.deepEqual(attKeys(c.chrome), []);

  const swapped = structuredClone(backup);
  swapped.attachments[one.id] = backup.attachments[two.id];
  const d = await setupUnlocked();
  assert.deepEqual(await d.call(MSG.VAULT_IMPORT, { json: JSON.stringify(swapped), masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  assert.deepEqual((await d.call(MSG.VAULT_GET_ALL)).items[0].attachments.map((x) => x.id), [two.id]);

  for (const bad of [{ ...backup, attachments: [] }, { ...backup, attachments: 'x' }, { ...backup, attachments: null }]) {
    await assert.rejects(d.call(MSG.VAULT_IMPORT, { json: JSON.stringify(bad), masterPassword: PW }), { code: 'INVALID' });
  }
});

test('attachments: an old backup without attachments imports as before; incoming metadata never takes over stored bytes', async () => {
  const a = await withItem();
  const [att] = (await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: a.item.id, name: 'a', mime: '', data: fileB64('mine') })).item.attachments;
  const { json } = await a.call(MSG.VAULT_EXPORT);
  const old = JSON.parse(json);
  delete old.attachments;
  const b = await setupUnlocked();
  await b.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'B' } });
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json: JSON.stringify(old), masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  const noAtt = await setupUnlocked();
  const { json: plain } = await noAtt.call(MSG.VAULT_EXPORT);
  assert.equal('attachments' in JSON.parse(plain), false);
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json: plain, masterPassword: PW }), { count: 0, skippedAttachments: 0 });

  const forged = structuredClone(await a.svc.readData());
  forged.items[0].id = 'other-item';
  forged.items[0].attachments[0].key = toB64(randomBytes(32));
  const { createVaultRecord, exportBackup, encryptAttachment } = await import('../../extension/src/lib/vault.js');
  const forgedBox = await encryptAttachment(forged.items[0].attachments[0].key, att.id, new TextEncoder().encode('evil'));
  const forgedJson = exportBackup(await createVaultRecord(PW, forged, { iterations: 1000 }), 1, { [att.id]: forgedBox });
  const storedBox = structuredClone(a.chrome.storage.local.map.get(keyOf(att.id)));
  assert.deepEqual(await a.call(MSG.VAULT_IMPORT, { json: forgedJson, masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  assert.deepEqual(a.chrome.storage.local.map.get(keyOf(att.id)), storedBox);
  assert.equal((await a.call(MSG.VAULT_GET_ATTACHMENT, { itemId: a.item.id, attachmentId: att.id })).data, fileB64('mine'));
});

test('attachments: import respects the vault total and rolls back written bytes when sealing fails', async () => {
  const a = await withItem();
  const mib5 = toB64(new Uint8Array(5 * 1024 * 1024).fill(1));
  await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: a.item.id, name: 'big', mime: '', data: mib5 });
  await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: a.item.id, name: 'small', mime: '', data: fileB64('s') });
  const { json } = await a.call(MSG.VAULT_EXPORT);

  const b = await withItem();
  for (let i = 0; i < 6; i++) await b.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: b.item.id, name: 'f' + i, mime: '', data: mib5 });
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  const imported = (await b.call(MSG.VAULT_GET_ALL)).items.find((i) => i.id === a.item.id);
  assert.deepEqual(imported.attachments.map((x) => x.name), ['small']);
  assert.equal(attKeys(b.chrome).length, 7);

  const c = await setupUnlocked();
  failVaultWrites(c.chrome);
  await assert.rejects(c.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), /disk full/);
  assert.deepEqual(attKeys(c.chrome), []);
});

test('attachments: still readable after the master password changes', async () => {
  const { call, item } = await withItem();
  const [att] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('kept') })).item.attachments;
  await call(MSG.VAULT_CHANGE_PASSWORD, { current: PW, next: 'brand-new-password' });
  await call(MSG.VAULT_LOCK);
  await call(MSG.VAULT_UNLOCK, { masterPassword: 'brand-new-password' });
  assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: att.id })).data, fileB64('kept'));
});

test('attachments: a backup entry with malformed metadata is dropped and counted, the item and its other files are imported', async () => {
  const a = await withItem();
  const [good] = (await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: a.item.id, name: 'good.txt', mime: '', data: fileB64('good') })).item.attachments;
  const { json } = await a.call(MSG.VAULT_EXPORT);
  const boxes = JSON.parse(json).attachments;
  const data = await a.svc.readData();
  const stored = data.items[0].attachments[0];
  data.items[0].attachments.push({ ...stored, id: crypto.randomUUID(), size: 64 * 1024 * 1024 }, { ...stored, id: 'not-an-id' });
  const { createVaultRecord, exportBackup } = await import('../../extension/src/lib/vault.js');
  const forged = exportBackup(await createVaultRecord(PW, data, { iterations: 1000 }), 1, boxes);

  const b = await setupUnlocked();
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json: forged, masterPassword: PW }), { count: 1, skippedAttachments: 2 });
  const [item] = (await b.call(MSG.VAULT_GET_ALL)).items;
  assert.deepEqual([item.title, item.attachments.map((x) => x.id)], ['Doc', [good.id]]);
  assert.equal((await b.call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: good.id })).data, fileB64('good'));
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json: forged, masterPassword: PW }), { count: 0, skippedAttachments: 0 },
    'items that are not merged count nothing');
});

async function twoProfiles() {
  const p1 = await withItem();
  const p2 = await setupUnlocked();
  await p2.call(MSG.VAULT_IMPORT, { json: (await p1.call(MSG.VAULT_EXPORT)).json, masterPassword: PW });
  p1.clock.t += 1e9;
  const x = p1.item.id;
  const addTo = async (p, name) => (await p.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: x, name, mime: '', data: fileB64(name) })).item.attachments.at(-1);
  return { p1, p2, x, addTo };
}

test('attachments: importing a newer version of an item keeps the files only this vault has', async () => {
  const { p1, p2, x, addTo } = await twoProfiles();
  const f = await addTo(p2, 'only-here');
  await p1.call(MSG.VAULT_SAVE_ITEM, { item: { id: x, password: 'changed later' } });
  const { json } = await p1.call(MSG.VAULT_EXPORT);
  assert.deepEqual(await p2.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  const item = (await p2.svc.readData()).items.find((i) => i.id === x);
  assert.equal(item.password, 'changed later');
  assert.deepEqual(item.attachments.map((a) => a.id), [f.id]);
  assert.ok(p2.chrome.storage.local.map.has(keyOf(f.id)));
  assert.equal((await p2.call(MSG.VAULT_GET_ATTACHMENT, { itemId: x, attachmentId: f.id })).data, fileB64('only-here'));
});

test('attachments: a newer incoming item adds its new files after the stored ones', async () => {
  const p1 = await withItem();
  const x = p1.item.id;
  const g = (await p1.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: x, name: 'g', mime: '', data: fileB64('g') })).item.attachments[0];
  const p2 = await setupUnlocked();
  await p2.call(MSG.VAULT_IMPORT, { json: (await p1.call(MSG.VAULT_EXPORT)).json, masterPassword: PW });
  p1.clock.t += 1e9;
  const f = (await p2.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: x, name: 'f', mime: '', data: fileB64('f') })).item.attachments.at(-1);
  const h = (await p1.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: x, name: 'h', mime: '', data: fileB64('h') })).item.attachments.at(-1);
  const { json } = await p1.call(MSG.VAULT_EXPORT);
  assert.deepEqual(await p2.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  const item = (await p2.call(MSG.VAULT_GET_ALL)).items.find((i) => i.id === x);
  assert.deepEqual(item.attachments.map((a) => a.id), [g.id, f.id, h.id]);
  for (const [a, text] of [[g, 'g'], [f, 'f'], [h, 'h']]) {
    assert.equal((await p2.call(MSG.VAULT_GET_ATTACHMENT, { itemId: x, attachmentId: a.id })).data, fileB64(text), text);
  }
});

test('attachments: an incoming entry reusing a stored id with another key never replaces the stored file', async () => {
  const { p1, p2, x, addTo } = await twoProfiles();
  const f = await addTo(p2, 'mine');
  const data = await p1.svc.readData();
  const item = data.items.find((i) => i.id === x);
  item.updatedAt = p1.clock.t;
  item.attachments = [{ ...f, key: toB64(randomBytes(32)) }];
  const { createVaultRecord, exportBackup, encryptAttachment } = await import('../../extension/src/lib/vault.js');
  const box = await encryptAttachment(item.attachments[0].key, f.id, new TextEncoder().encode('evil'));
  const json = exportBackup(await createVaultRecord(PW, data, { iterations: 1000 }), 1, { [f.id]: box });
  const storedBox = structuredClone(p2.chrome.storage.local.map.get(keyOf(f.id)));
  assert.deepEqual(await p2.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  assert.deepEqual(p2.chrome.storage.local.map.get(keyOf(f.id)), storedBox);
  assert.equal((await p2.call(MSG.VAULT_GET_ATTACHMENT, { itemId: x, attachmentId: f.id })).data, fileB64('mine'));
});

test('attachments: stored files plus new incoming ones stay within the per-item limit, the extra ones are counted', async () => {
  const { p1, p2, x, addTo } = await twoProfiles();
  const stored = [];
  for (let i = 0; i < 9; i++) stored.push(await addTo(p2, 'stored' + i));
  const incoming = [];
  for (let i = 0; i < 3; i++) incoming.push(await addTo(p1, 'incoming' + i));
  const { json } = await p1.call(MSG.VAULT_EXPORT);
  assert.deepEqual(await p2.call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 2 });
  const item = (await p2.call(MSG.VAULT_GET_ALL)).items.find((i) => i.id === x);
  assert.deepEqual(item.attachments.map((a) => a.id), [...stored, incoming[0]].map((a) => a.id));
  assert.equal(attKeys(p2.chrome).length, 10);
});

test('attachments: importing an item that is in the trash keeps the files of the trashed copy', async () => {
  const { call, chrome, item } = await withItem();
  const add = async (name) => (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name, mime: '', data: fileB64(name) })).item.attachments.at(-1);
  const g = await add('g');
  const { json } = await call(MSG.VAULT_EXPORT);
  const f = await add('f');
  await call(MSG.VAULT_DELETE_ITEM, { id: item.id });
  assert.deepEqual(await call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  const all = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.items.find((i) => i.id === item.id).attachments.map((a) => a.id), [g.id, f.id]);
  assert.equal(all.trash.some((e) => e.id === item.id), false);
  assert.ok(chrome.storage.local.map.has(keyOf(f.id)));
  for (const [a, text] of [[g, 'g'], [f, 'f']]) {
    assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: a.id })).data, fileB64(text), text);
  }
});

test('attachments: an incoming copy without files does not erase the files of the trashed copy', async () => {
  const { call, chrome, item } = await withItem();
  const { json } = await call(MSG.VAULT_EXPORT);
  const [f] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'f', mime: '', data: fileB64('f') })).item.attachments;
  await call(MSG.VAULT_DELETE_ITEM, { id: item.id });
  assert.deepEqual(await call(MSG.VAULT_IMPORT, { json, masterPassword: PW }), { count: 1, skippedAttachments: 0 });
  const all = await call(MSG.VAULT_GET_ALL);
  assert.deepEqual(all.items.find((i) => i.id === item.id).attachments.map((a) => a.id), [f.id]);
  assert.deepEqual(all.trash, []);
  assert.ok(chrome.storage.local.map.has(keyOf(f.id)));
  assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: f.id })).data, fileB64('f'));
});

test('attachments: only { v, iv, ct } of an imported box is stored and exported again; an iv of the wrong length is rejected', async () => {
  const a = await withItem();
  const add = async (name) => (await a.call(MSG.VAULT_ADD_ATTACHMENT, { itemId: a.item.id, name, mime: '', data: fileB64(name) })).item.attachments.at(-1);
  const padded = await add('padded');
  const spaced = await add('spaced');
  const backup = JSON.parse((await a.call(MSG.VAULT_EXPORT)).json);
  backup.attachments[padded.id].pad = 'x'.repeat(10000);
  backup.attachments[spaced.id].iv = ' ' + backup.attachments[spaced.id].iv;

  const b = await setupUnlocked();
  assert.deepEqual(await b.call(MSG.VAULT_IMPORT, { json: JSON.stringify(backup), masterPassword: PW }), { count: 1, skippedAttachments: 1 });
  assert.deepEqual(Object.keys(b.chrome.storage.local.map.get(keyOf(padded.id))).sort(), ['ct', 'iv', 'v']);
  assert.equal(b.chrome.storage.local.map.has(keyOf(spaced.id)), false);
  assert.equal((await b.call(MSG.VAULT_GET_ATTACHMENT, { itemId: a.item.id, attachmentId: padded.id })).data, fileB64('padded'));
  const again = (await b.call(MSG.VAULT_EXPORT)).json;
  assert.equal(again.includes('"pad"'), false);
  assert.deepEqual(Object.keys(JSON.parse(again).attachments[padded.id]).sort(), ['ct', 'iv', 'v']);
});

test('attachments: expired trash does not count toward the vault total when adding, and its bytes are removed', async () => {
  const { call, chrome, clock, item } = await withItem();
  const { item: old } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Old' } });
  const mib5 = toB64(new Uint8Array(5 * 1024 * 1024));
  const oldIds = [];
  for (let i = 0; i < 6; i++) oldIds.push((await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: old.id, name: 'o' + i, mime: '', data: mib5 })).item.attachments.at(-1).id);
  await call(MSG.VAULT_DELETE_ITEM, { id: old.id });
  clock.t += 31 * 24 * 3600 * 1000;
  const added = await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'new', mime: '', data: mib5 });
  assert.equal(added.item.attachments.length, 1);
  assert.deepEqual(attKeys(chrome), [keyOf(added.item.attachments[0].id)]);
  for (const id of oldIds) assert.equal(chrome.storage.local.map.has(keyOf(id)), false);
});

test('attachments: unlocking sweeps bytes that nothing references and leaves everything else alone', async () => {
  const { call, svc, chrome, item } = await withItem();
  const local = chrome.storage.local;
  const { item: gone } = await call(MSG.VAULT_SAVE_ITEM, { item: { title: 'Trashed' } });
  const [kept] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'kept', mime: '', data: fileB64('kept') })).item.attachments;
  const [inTrash] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: gone.id, name: 't', mime: '', data: fileB64('t') })).item.attachments;
  await call(MSG.VAULT_DELETE_ITEM, { id: gone.id });
  const [orphan] = (await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'orphan', mime: '', data: fileB64('o') })).item.attachments.slice(-1);
  const realRemove = local.remove.bind(local);
  local.remove = async () => { throw new Error('io'); };
  await call(MSG.VAULT_SAVE_ITEM, { item: { id: item.id, attachments: [{ id: kept.id }] } });
  local.remove = realRemove;
  local.map.set(ATT_PREFIX + 'not-a-uuid', { keep: true });
  local.map.set('akari.other', 1);
  assert.ok(local.map.has(keyOf(orphan.id)), 'orphan left by the failed remove');

  await call(MSG.VAULT_LOCK);
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await settle(svc);
  assert.deepEqual(attKeys(chrome), [ATT_PREFIX + 'not-a-uuid', keyOf(kept.id), keyOf(inTrash.id)].sort());
  assert.ok(local.map.has('akari.other'));
  assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: kept.id })).data, fileB64('kept'));

  const stray = crypto.randomUUID();
  local.map.set(keyOf(stray), { v: 1, iv: 'x', ct: 'y' });
  const restarted = makeService({ chrome });
  await restarted.call(MSG.VAULT_GET_ALL);
  await settle(restarted.svc);
  assert.ok(local.map.has(keyOf(stray)), 'a restart in the same browser session does not sweep again');
  await restarted.call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await settle(restarted.svc);
  assert.equal(local.map.has(keyOf(stray)), false, 'an explicit unlock always sweeps');
});

test('attachments: the sweep uses storage.local.getKeys when present instead of reading every value', async () => {
  const { call, svc, chrome, item } = await withItem();
  const local = chrome.storage.local;
  const realGet = local.get.bind(local);
  const reads = [];
  local.getKeys = async () => [...local.map.keys()];
  local.get = async (keys) => { reads.push(keys); return realGet(keys); };
  const stray = crypto.randomUUID();
  local.map.set(keyOf(stray), { v: 1, iv: 'x', ct: 'y' });
  await call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'a', mime: '', data: fileB64('a') });
  await call(MSG.VAULT_LOCK);
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await settle(svc);
  assert.equal(local.map.has(keyOf(stray)), false);
  assert.equal(attKeys(chrome).length, 1);
  assert.equal(reads.some((k) => k == null), false, 'no get(null)');
});

test('attachments: a sweep never deletes the bytes of an add that is still waiting to seal', async () => {
  const { call, svc, chrome, item } = await withItem();
  const local = chrome.storage.local;
  const realSet = local.set.bind(local);
  let release;
  const gate = new Promise((r) => { release = r; });
  local.set = async (obj) => {
    if (VAULT_KEY in obj) await gate;
    return realSet(obj);
  };
  const adding = call(MSG.VAULT_ADD_ATTACHMENT, { itemId: item.id, name: 'slow', mime: '', data: fileB64('slow') });
  while (!attKeys(chrome).length) await new Promise((r) => setTimeout(r, 1));
  await call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(attKeys(chrome).length, 1, 'bytes written, not yet sealed, still there');
  release();
  local.set = realSet;
  const [att] = (await adding).item.attachments;
  await settle(svc);
  assert.deepEqual(attKeys(chrome), [keyOf(att.id)]);
  assert.equal((await call(MSG.VAULT_GET_ATTACHMENT, { itemId: item.id, attachmentId: att.id })).data, fileB64('slow'));
});

test('attachments: a failing remove during the sweep does not fail the unlock', async () => {
  const { call, svc, chrome } = await withItem();
  const local = chrome.storage.local;
  const stray = crypto.randomUUID();
  local.map.set(keyOf(stray), { v: 1, iv: 'x', ct: 'y' });
  await call(MSG.VAULT_LOCK);
  local.remove = async () => { throw new Error('io'); };
  assert.deepEqual(await call(MSG.VAULT_UNLOCK, { masterPassword: PW }), {});
  await settle(svc);
  assert.equal(await svc.isLocked(), false);
  assert.ok(local.map.has(keyOf(stray)));
});

test('attachments: a reopened service worker sweeps at most once per browser session', async () => {
  const { call, svc, chrome } = await withItem();
  const local = chrome.storage.local;
  const realGet = local.get.bind(local);
  let listings = 0;
  local.get = async (keys) => {
    if (keys == null) listings++;
    return realGet(keys);
  };
  await settle(svc);
  const stray = crypto.randomUUID();
  local.map.set(keyOf(stray), { v: 1, iv: 'x', ct: 'y' });
  for (let i = 0; i < 3; i++) {
    const w = makeService({ chrome });
    await w.call(MSG.VAULT_GET_ALL);
    await settle(w.svc);
  }
  assert.equal(listings, 0, 'restarts in the same session neither list nor read storage');
  assert.ok(local.map.has(keyOf(stray)));

  await call(MSG.SETTINGS_SET, { patch: { autoLockMinutes: NEVER_LOCK }, masterPassword: PW });
  chrome.storage.session.map.clear();
  const fresh = makeService({ chrome });
  assert.equal(await fresh.svc.isLocked(), false, 'reopens from the kept key');
  await settle(fresh.svc);
  assert.equal(listings, 1, 'the first reopen of a new browser session sweeps once');
  assert.equal(local.map.has(keyOf(stray)), false);
  for (let i = 0; i < 2; i++) {
    const w = makeService({ chrome });
    await w.call(MSG.VAULT_GET_ALL);
    await settle(w.svc);
  }
  assert.equal(listings, 1);
  await fresh.call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await settle(fresh.svc);
  assert.equal(listings, 2, 'an explicit unlock sweeps');
});

test('attachments: with storage.local.getKeys, restarts in the same session do not call it again', async () => {
  const { svc, chrome } = await withItem();
  const local = chrome.storage.local;
  let listings = 0;
  local.getKeys = async () => {
    listings++;
    return [...local.map.keys()];
  };
  await settle(svc);
  for (let i = 0; i < 3; i++) {
    const w = makeService({ chrome });
    await w.call(MSG.VAULT_GET_ALL);
    await settle(w.svc);
  }
  assert.equal(listings, 0);
  chrome.storage.session.map.clear();
  const again = makeService({ chrome });
  await again.call(MSG.VAULT_UNLOCK, { masterPassword: PW });
  await settle(again.svc);
  assert.equal(listings, 1);
});
