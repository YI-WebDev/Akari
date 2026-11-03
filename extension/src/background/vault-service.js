// Vault core of the service worker: lock state, encrypted storage, item CRUD,
// settings and auto-lock. Exports the SW-internal API of PLAN.md §3.1.
//
// While unlocked the raw DEK sits in chrome.storage.session (memory only, trusted
// contexts only) so a SW restart does not force a new password prompt; the
// decrypted VaultData is cached in memory and rebuilt lazily from that DEK.

import { register, AkariError } from './router.js';
import { ERR, MSG, DEFAULT_SETTINGS } from '../shared/messages.js';
import { toB64, fromB64 } from '../shared/bytes.js';
import { PBKDF2_ITERATIONS, importDek, exportDek } from '../lib/crypto.js';
import {
  createVault, openVaultRecord, readVaultData, sealData, exportBackup, importBackup,
  mergeData, makeItem as makeItemAt, validateItem, sanitizeItem, defaultData,
} from '../lib/vault.js';

export const VAULT_KEY = 'akari.vault';
export const SETTINGS_KEY = 'akari.settings';
export const SESSION_KEY = 'akari.session';
export const AUTOLOCK_ALARM = 'akari-autolock';

const REARM_THROTTLE_MS = 30000;
const FREE_UNLOCK_ATTEMPTS = 5;
const MAX_UNLOCK_DELAY_MS = 30000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_IMPORT_CHARS = 20 * 1024 * 1024;

// Only these keys are read back or stored; anything else in an old settings object
// (e.g. the retired `theme`) is dropped on the next read/write.
const SETTING_RULES = {
  autoLockMinutes: (v) => [0, 1, 5, 15, 30, 60].includes(v),
  clipboardClearSeconds: (v) => [0, 10, 30, 60].includes(v),
};

const fail = (code, message) => new AkariError(code, message);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// lib/ throws shared/api.js AkariError; the router only recognizes its own class.
function toAkari(err) {
  if (err instanceof AkariError) return err;
  if (err && typeof err.code === 'string' && ERR[err.code] === err.code) return new AkariError(err.code, err.message);
  return err;
}

/** Promise chain that runs jobs one at a time; a failing job does not block later ones. */
function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH || pw.length > MAX_PASSWORD_LENGTH) {
    throw fail(ERR.INVALID, `Master password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
  }
}

/**
 * @param {object} opts
 * @param {typeof chrome} opts.chrome  real or fake chrome namespace
 * @param {() => number} [opts.now]
 * @param {number} [opts.iterations]   PBKDF2 iterations for new/rewrapped records (tests use fewer)
 * @param {(ms: number) => Promise<void>} [opts.sleep]  unlock throttling delay
 */
export function createVaultService({
  chrome,
  now = () => Date.now(),
  iterations = PBKDF2_ITERATIONS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const local = chrome.storage.local;
  const session = chrome.storage.session;

  let cache = null; // { dek: CryptoKey, data: VaultData } while unlocked
  let gen = 0; // bumped on lock/unlock; invalidates in-flight session resumes
  let resuming = null;
  let locking = null;
  let failures = 0; // consecutive bad passwords (memory only)
  let lastArm = 0;
  const unlockedListeners = new Set();
  const runWrite = serialQueue(); // everything that writes akari.vault
  const runAuth = serialQueue(); // password checks, so throttling cannot be bypassed in parallel
  const runSettings = serialQueue();

  const loadRecord = async () => (await local.get(VAULT_KEY))[VAULT_KEY] ?? null;

  // ---- lock state ---------------------------------------------------------

  async function resume() {
    if (locking) await locking;
    const g = gen;
    const s = (await session.get(SESSION_KEY))[SESSION_KEY];
    if (!isObject(s) || typeof s.dek !== 'string') return null;
    const record = await loadRecord();
    let c = null;
    if (record) {
      try {
        const dek = await importDek(fromB64(s.dek));
        c = { dek, data: await readVaultData(record, dek) };
      } catch {
        c = null;
      }
    }
    if (g !== gen) return cache;
    if (!c) {
      await session.remove(SESSION_KEY);
      return null;
    }
    cache = c;
    return c;
  }

  async function ensureUnlocked() {
    if (cache) return cache;
    if (!resuming) resuming = resume().finally(() => { resuming = null; });
    const c = await resuming;
    if (!c) throw fail(ERR.LOCKED, 'Vault is locked');
    return c;
  }

  async function isLocked() {
    try {
      await ensureUnlocked();
      return false;
    } catch (e) {
      if (e?.code === ERR.LOCKED) return true;
      throw e;
    }
  }

  async function lock() {
    gen++;
    cache = null;
    const done = Promise.all([session.remove(SESSION_KEY), chrome.alarms.clear(AUTOLOCK_ALARM)]);
    const mine = done.then(() => {}, () => {});
    locking = mine;
    try {
      await done;
    } finally {
      if (locking === mine) locking = null;
    }
  }

  async function writeSessionDek(dek) {
    const raw = await exportDek(dek);
    await session.set({ [SESSION_KEY]: { dek: toB64(raw) } });
    raw.fill(0);
  }

  async function startSession(dek, data) {
    if (locking) await locking;
    const g = gen;
    await writeSessionDek(dek);
    if (g !== gen) { // locked while we were unlocking
      await session.remove(SESSION_KEY);
      throw fail(ERR.LOCKED, 'Vault was locked');
    }
    gen++;
    cache = { dek, data };
    failures = 0;
    await armAutoLock(true);
    for (const cb of unlockedListeners) {
      try {
        Promise.resolve(cb()).catch((e) => console.error('[akari] onUnlocked listener failed', e));
      } catch (e) {
        console.error('[akari] onUnlocked listener failed', e);
      }
    }
  }

  async function verifyPassword(record, password) {
    if (failures >= FREE_UNLOCK_ATTEMPTS) {
      await sleep(Math.min(1000 * 2 ** (failures - FREE_UNLOCK_ATTEMPTS), MAX_UNLOCK_DELAY_MS));
    }
    try {
      const opened = await openVaultRecord(record, password);
      failures = 0;
      return opened;
    } catch (e) {
      if (e?.code === ERR.BAD_PASSWORD) failures++;
      throw toAkari(e);
    }
  }

  // ---- auto-lock ----------------------------------------------------------

  async function armAutoLock(force) {
    const t = now();
    if (!force && t - lastArm < REARM_THROTTLE_MS) return;
    lastArm = t;
    const { autoLockMinutes } = await getSettings();
    // 0 = lock only when the browser closes (storage.session is cleared then).
    if (autoLockMinutes > 0) await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: autoLockMinutes });
    else await chrome.alarms.clear(AUTOLOCK_ALARM);
  }

  async function touchActivity() {
    if (now() - lastArm < REARM_THROTTLE_MS) return;
    try {
      if (await isLocked()) return;
      await armAutoLock(false);
    } catch { /* best effort */ }
  }

  function onAlarm(alarm) {
    if (alarm?.name === AUTOLOCK_ALARM) return lock().catch(() => {});
    return undefined;
  }

  // ---- data ---------------------------------------------------------------

  async function readData() {
    const c = await ensureUnlocked();
    return structuredClone(c.data);
  }

  function mutateData(fn) {
    return runWrite(async () => {
      const c = await ensureUnlocked();
      const record = await loadRecord();
      if (!record) throw fail(ERR.NOT_INITIALIZED, 'Vault not set up');
      const draft = structuredClone(c.data);
      const result = await fn(draft);
      draft.updatedAt = now();
      await local.set({ [VAULT_KEY]: await sealData(record, c.dek, draft) });
      if (cache) cache.data = draft; // same DEK even if re-unlocked meanwhile
      return result;
    }).catch((e) => { throw toAkari(e); });
  }

  function onUnlocked(cb) {
    unlockedListeners.add(cb);
    return () => unlockedListeners.delete(cb);
  }

  const makeItem = (partial) => makeItemAt(partial, now());

  // ---- settings -----------------------------------------------------------

  async function getSettings() {
    const stored = (await local.get(SETTINGS_KEY))[SETTINGS_KEY];
    const out = { ...DEFAULT_SETTINGS };
    if (isObject(stored)) {
      for (const [key, ok] of Object.entries(SETTING_RULES)) if (ok(stored[key])) out[key] = stored[key];
    }
    return out;
  }

  function setSettings(patch) {
    if (!isObject(patch)) throw fail(ERR.INVALID, 'patch must be an object');
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(SETTING_RULES, key) || !SETTING_RULES[key](value)) throw fail(ERR.INVALID, 'Invalid setting: ' + key);
    }
    return runSettings(async () => {
      const current = await getSettings();
      const next = { ...current, ...patch };
      await local.set({ [SETTINGS_KEY]: next });
      if (next.autoLockMinutes !== current.autoLockMinutes && !(await isLocked())) await armAutoLock(true);
      return next;
    });
  }

  // ---- operations ---------------------------------------------------------

  function setup(password) {
    checkNewPassword(password);
    return runWrite(async () => {
      if (await loadRecord()) throw fail(ERR.ALREADY_INITIALIZED, 'Vault already exists');
      const data = defaultData(now());
      const { record, dek } = await createVault(password, data, { iterations });
      await local.set({ [VAULT_KEY]: record });
      await startSession(dek, data);
      return {};
    });
  }

  function unlock(password) {
    if (typeof password !== 'string') throw fail(ERR.INVALID, 'masterPassword must be a string');
    return runAuth(async () => {
      const record = await loadRecord();
      if (!record) throw fail(ERR.NOT_INITIALIZED, 'Vault not set up');
      const { dek, data } = await verifyPassword(record, password);
      await startSession(dek, data);
      return {};
    });
  }

  async function changePassword(current, next) {
    if (typeof current !== 'string') throw fail(ERR.INVALID, 'current must be a string');
    checkNewPassword(next);
    await ensureUnlocked();
    return runAuth(async () => {
      const record = await loadRecord();
      if (!record) throw fail(ERR.NOT_INITIALIZED, 'Vault not set up');
      await verifyPassword(record, current);
      // Rotate everything: new salt, new DEK, data re-encrypted under it.
      await runWrite(async () => {
        const c = await ensureUnlocked();
        const g = gen;
        const { record: rotated, dek } = await createVault(next, c.data, { iterations });
        await local.set({ [VAULT_KEY]: rotated });
        if (g !== gen) return; // locked meanwhile; the new record stands
        await writeSessionDek(dek);
        if (g !== gen) {
          await session.remove(SESSION_KEY);
          return;
        }
        cache = { dek, data: c.data };
      });
      return {};
    });
  }

  /**
   * SW-internal user-verification re-prompt (passkeys). Works locked or unlocked;
   * a wrong password counts toward unlock throttling.
   */
  function verifyMasterPassword(password) {
    if (typeof password !== 'string' || !password) return Promise.resolve(false);
    return runAuth(async () => {
      const record = await loadRecord();
      if (!record) return false;
      try {
        await verifyPassword(record, password);
        return true;
      } catch (e) {
        if (e?.code === ERR.BAD_PASSWORD) return false;
        throw e;
      }
    });
  }

  async function getAll() {
    const c = await ensureUnlocked();
    return { vaults: structuredClone(c.data.vaults), items: c.data.items.map(sanitizeItem) };
  }

  async function saveItem(item) {
    const fields = validateItem(item);
    const saved = await mutateData((draft) => {
      const t = now();
      let target;
      if (fields.id) {
        target = draft.items.find((i) => i.id === fields.id);
        if (!target) throw fail(ERR.NOT_FOUND, 'Item not found');
        const { id, ...edit } = fields; // eslint-disable-line no-unused-vars
        const passwordChanged = 'password' in edit && edit.password !== target.password;
        // passkeys, createdAt and lastUsedAt always stay as stored: popup copies lack privateKey.
        Object.assign(target, edit, { updatedAt: t });
        if (passwordChanged) target.passwordUpdatedAt = t;
      } else {
        target = makeItemAt({ ...fields, passkeys: [] }, t);
        draft.items.push(target);
      }
      if (!draft.vaults.some((v) => v.id === target.vault)) throw fail(ERR.INVALID, 'Unknown vault');
      return sanitizeItem(target);
    });
    return { item: saved };
  }

  async function deleteItem(id) {
    if (typeof id !== 'string' || !id) throw fail(ERR.INVALID, 'id required');
    await mutateData((draft) => {
      const idx = draft.items.findIndex((i) => i.id === id);
      if (idx < 0) throw fail(ERR.NOT_FOUND, 'Item not found');
      draft.items.splice(idx, 1);
    });
    return {};
  }

  async function deletePasskey(itemId, credentialId) {
    if (typeof itemId !== 'string' || typeof credentialId !== 'string') throw fail(ERR.INVALID, 'itemId and credentialId required');
    await mutateData((draft) => {
      const item = draft.items.find((i) => i.id === itemId);
      const before = item?.passkeys?.length ?? 0;
      if (!item || !before) throw fail(ERR.NOT_FOUND, 'Passkey not found');
      item.passkeys = item.passkeys.filter((pk) => pk.credentialId !== credentialId);
      if (item.passkeys.length === before) throw fail(ERR.NOT_FOUND, 'Passkey not found');
      item.updatedAt = now();
    });
    return {};
  }

  async function exportVault() {
    await ensureUnlocked();
    const record = await runWrite(loadRecord);
    return { json: exportBackup(record, now()) };
  }

  async function importVault(json, password) {
    await ensureUnlocked();
    if (typeof json !== 'string' || !json || json.length > MAX_IMPORT_CHARS) throw fail(ERR.INVALID, 'Invalid backup');
    if (typeof password !== 'string') throw fail(ERR.INVALID, 'masterPassword must be a string');
    const incoming = await importBackup(json, password);
    const count = await mutateData((draft) => {
      const merged = mergeData(draft, incoming);
      draft.vaults = merged.data.vaults;
      draft.items = merged.data.items;
      return merged.count;
    });
    return { count };
  }

  async function status() {
    const initialized = !!(await loadRecord());
    return { initialized, locked: initialized ? await isLocked() : true };
  }

  // ---- message handlers (all from: 'extension') ---------------------------

  const table = {
    [MSG.VAULT_STATUS]: () => status(),
    [MSG.VAULT_SETUP]: (m) => setup(m.masterPassword),
    [MSG.VAULT_UNLOCK]: (m) => unlock(m.masterPassword),
    [MSG.VAULT_LOCK]: async () => { await lock(); return {}; },
    [MSG.VAULT_GET_ALL]: () => getAll(),
    [MSG.VAULT_SAVE_ITEM]: (m) => saveItem(m.item),
    [MSG.VAULT_DELETE_ITEM]: (m) => deleteItem(m.id),
    [MSG.VAULT_DELETE_PASSKEY]: (m) => deletePasskey(m.itemId, m.credentialId),
    [MSG.VAULT_CHANGE_PASSWORD]: (m) => changePassword(m.current, m.next),
    [MSG.VAULT_EXPORT]: () => exportVault(),
    [MSG.VAULT_IMPORT]: (m) => importVault(m.json, m.masterPassword),
    [MSG.SETTINGS_GET]: () => getSettings(),
    [MSG.SETTINGS_SET]: (m) => setSettings(m.patch),
    [MSG.ACTIVITY_PING]: () => ({}),
  };
  // A successful call of these counts as user activity (re-arms auto-lock).
  const ACTIVE = new Set([
    MSG.VAULT_GET_ALL, MSG.VAULT_SAVE_ITEM, MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_PASSKEY,
    MSG.VAULT_CHANGE_PASSWORD, MSG.VAULT_EXPORT, MSG.VAULT_IMPORT, MSG.SETTINGS_SET, MSG.ACTIVITY_PING,
  ]);
  const handlers = {};
  for (const [type, fn] of Object.entries(table)) {
    handlers[type] = async (msg, sender) => {
      try {
        const out = await fn(msg || {}, sender);
        if (ACTIVE.has(type)) await touchActivity();
        return out;
      } catch (e) {
        throw toAkari(e);
      }
    };
  }

  function install() {
    try {
      Promise.resolve(session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {});
    } catch { /* older Chrome: TRUSTED_CONTEXTS is the default anyway */ }
    chrome.alarms?.onAlarm?.addListener(onAlarm);
  }

  return {
    isLocked, readData, mutateData, onUnlocked, getSettings, touchActivity, sanitizeItem, makeItem,
    verifyMasterPassword, lock, install, handlers,
  };
}

// ---- live instance (service worker) -----------------------------------------

const live = globalThis.chrome?.storage?.local ? createVaultService({ chrome: globalThis.chrome }) : null;
if (live) {
  live.install();
  for (const [type, handler] of Object.entries(live.handlers)) register(type, handler, { from: 'extension' });
}

function svc() {
  if (!live) throw new AkariError(ERR.INTERNAL, 'chrome APIs unavailable');
  return live;
}

export async function isLocked() { return svc().isLocked(); }
export async function readData() { return svc().readData(); }
export async function mutateData(fn) { return svc().mutateData(fn); }
export function onUnlocked(cb) { return svc().onUnlocked(cb); }
export async function getSettings() { return svc().getSettings(); }
export async function verifyMasterPassword(password) { return svc().verifyMasterPassword(password); }
export async function touchActivity() { if (live) await live.touchActivity(); }
export function makeItem(partial) { return makeItemAt(partial, Date.now()); }
export { sanitizeItem };
