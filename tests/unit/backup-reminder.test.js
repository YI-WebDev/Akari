import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultService, BACKUP_KEY } from '../../extension/src/background/vault-service.js';
import { MSG, ERR, BACKUP_REMIND_DAYS, BACKUP_SNOOZE_DAYS } from '../../extension/src/shared/messages.js';
import { DAY_MS } from '../../extension/src/shared/time.js';

const PW = 'master-password-1';

function fakeArea() {
  const map = new Map();
  return {
    map,
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
    async setAccessLevel() {},
  };
}

function makeService() {
  const local = fakeArea();
  const chrome = {
    storage: { local, session: fakeArea() },
    alarms: {
      async create() {},
      async clear() { return true; },
      onAlarm: { addListener() {} },
    },
  };
  const clock = { t: 1_000_000 };
  const svc = createVaultService({ chrome, now: () => clock.t, iterations: 1000, sleep: async () => {} });
  svc.install();
  const call = (type, payload = {}) => svc.handlers[type]({ type, ...payload }, {});
  return { local, clock, svc, call };
}

async function setupWithItem() {
  const ctx = makeService();
  await ctx.call(MSG.VAULT_SETUP, { masterPassword: PW });
  await ctx.call(MSG.VAULT_SAVE_ITEM, { item: { title: 'kept' } });
  return ctx;
}

const stored = (ctx) => ctx.local.map.get(BACKUP_KEY);

test('setup starts the backup clock', async () => {
  const ctx = makeService();
  await ctx.call(MSG.VAULT_SETUP, { masterPassword: PW });
  assert.deepEqual(stored(ctx), { lastAt: null, since: ctx.clock.t, snoozeUntil: null });
  assert.equal(ctx.local.map.get('akari.settings'), undefined);
});

test('missing key on an existing vault starts the clock at the first status call', async () => {
  const ctx = await setupWithItem();
  ctx.local.map.delete(BACKUP_KEY);
  ctx.clock.t += 10 * DAY_MS;
  const first = await ctx.call(MSG.BACKUP_STATUS);
  assert.deepEqual(first, { lastAt: null, days: 0, due: false });
  assert.equal(stored(ctx).since, ctx.clock.t);
  ctx.clock.t += BACKUP_REMIND_DAYS * DAY_MS;
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, true);
});

test('not due before 30 days, due after', async () => {
  const ctx = await setupWithItem();
  ctx.clock.t += BACKUP_REMIND_DAYS * DAY_MS - 1;
  assert.deepEqual(await ctx.call(MSG.BACKUP_STATUS), { lastAt: null, days: BACKUP_REMIND_DAYS - 1, due: false });
  ctx.clock.t += 1;
  assert.deepEqual(await ctx.call(MSG.BACKUP_STATUS), { lastAt: null, days: BACKUP_REMIND_DAYS, due: true });
});

test('an empty vault is never due', async () => {
  const ctx = makeService();
  await ctx.call(MSG.VAULT_SETUP, { masterPassword: PW });
  ctx.clock.t += 100 * DAY_MS;
  const s = await ctx.call(MSG.BACKUP_STATUS);
  assert.equal(s.days, 100);
  assert.equal(s.due, false);
});

test('the popup records a saved backup: the reminder starts again', async () => {
  const ctx = await setupWithItem();
  ctx.clock.t += 40 * DAY_MS;
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, true);
  assert.deepEqual(await ctx.call(MSG.BACKUP_RECORD), { lastAt: ctx.clock.t, days: 0, due: false });
  ctx.clock.t += BACKUP_REMIND_DAYS * DAY_MS;
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, true);
});

test('an export request alone does not reset the reminder (the file may still fail to be made or saved)', async () => {
  const ctx = await setupWithItem();
  ctx.clock.t += 40 * DAY_MS;
  await ctx.call(MSG.VAULT_EXPORT);
  await ctx.call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: PW });
  await ctx.call(MSG.VAULT_EXPORT_PLAIN, { format: 'bitwarden', masterPassword: PW, pgp: true });
  await assert.rejects(ctx.call(MSG.VAULT_EXPORT_PLAIN, { format: 'csv', masterPassword: 'wrong-password' }), { code: ERR.BAD_PASSWORD });
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, true);
  assert.equal(stored(ctx).lastAt, null);
});

test('snooze hides the reminder for 7 days, then it is due again', async () => {
  const ctx = await setupWithItem();
  ctx.clock.t += 40 * DAY_MS;
  const snoozed = await ctx.call(MSG.BACKUP_SNOOZE);
  assert.deepEqual(snoozed, { lastAt: null, days: 40, due: false });
  assert.equal(stored(ctx).snoozeUntil, ctx.clock.t + BACKUP_SNOOZE_DAYS * DAY_MS);
  ctx.clock.t += BACKUP_SNOOZE_DAYS * DAY_MS - 1;
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, false);
  ctx.clock.t += 1;
  assert.equal((await ctx.call(MSG.BACKUP_STATUS)).due, true);
});

test('a recorded backup clears a snooze', async () => {
  const ctx = await setupWithItem();
  ctx.clock.t += 40 * DAY_MS;
  await ctx.call(MSG.BACKUP_SNOOZE);
  await ctx.call(MSG.BACKUP_RECORD);
  assert.equal(stored(ctx).snoozeUntil, null);
});

test('locked vault answers LOCKED', async () => {
  const ctx = await setupWithItem();
  await ctx.call(MSG.VAULT_LOCK);
  await assert.rejects(ctx.call(MSG.BACKUP_STATUS), { code: ERR.LOCKED });
  await assert.rejects(ctx.call(MSG.BACKUP_SNOOZE), { code: ERR.LOCKED });
  await assert.rejects(ctx.call(MSG.BACKUP_RECORD), { code: ERR.LOCKED });
});
