import { register } from './router.js';
import { AkariError } from '../shared/errors.js';
import {
  ERR, MSG, DEFAULT_SETTINGS, NEVER_LOCK, BACKUP_REMIND_DAYS, BACKUP_SNOOZE_DAYS, ATTACHMENT_LIMITS,
} from '../shared/messages.js';
import { DAY_MS } from '../shared/time.js';
import { applyLanguage } from './locale.js';
import { toB64, fromB64 } from '../shared/bytes.js';
import { PBKDF2_ITERATIONS, importDek, exportDek } from '../lib/crypto.js';
import {
  createVault, openVaultRecord, readVaultData, sealData, exportBackup, importBackup,
  mergeData, makeItem as makeItemAt, validateItem, sanitizeItem, defaultData,
  addImportedItems, stripLegacyLoginKeys, MAX_IMPORT_ITEMS, createVaultIn, updateVaultIn, deleteVaultIn,
  setLoginPassword, setPendingPassword, pruneTrash, trashItems, restoreItems, purgeTrash, liveTrash,
  isAttachmentId, attachmentStorageKey, maxAttachmentB64Length, cleanAttachmentName, cleanMime, newAttachmentKey,
  encryptAttachment, decryptAttachment, attachmentsIn, attachmentIdsIn, attachmentBytesIn,
} from '../lib/vault.js';
import { toCsv } from '../lib/export/csv.js';
import { toBitwardenJson } from '../lib/export/bitwarden.js';

import { VAULT_KEY, SETTINGS_KEY, SESSION_KEY, KEEP_KEY, BACKUP_KEY } from '../shared/storage-keys.js';

export { VAULT_KEY, SETTINGS_KEY, SESSION_KEY, KEEP_KEY, BACKUP_KEY };
export const AUTOLOCK_ALARM = 'akari-autolock';

const REARM_THROTTLE_MS = 30000;
const FREE_UNLOCK_ATTEMPTS = 5;
const MAX_UNLOCK_DELAY_MS = 30000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_IMPORT_CHARS = 60 * 1024 * 1024;
const MAX_ITEM_ID_LENGTH = 100;

const SETTING_RULES = {
  autoLockMinutes: (v) => [NEVER_LOCK, 0, 1, 5, 15, 30, 60].includes(v),
  clipboardClearSeconds: (v) => [0, 10, 30, 60].includes(v),
  language: (v) => ['auto', 'ja', 'en'].includes(v),
  theme: (v) => ['dark', 'light', 'auto'].includes(v),
};

const fail = (code, message) => new AkariError(code, message);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

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

export function createVaultService({
  chrome,
  now = () => Date.now(),
  iterations = PBKDF2_ITERATIONS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const local = chrome.storage.local;
  const session = chrome.storage.session;

  let cache = null;
  let sessionGeneration = 0;
  let resumeInProgress = null;
  let lockInProgress = null;
  let consecutiveBadPasswords = 0;
  let lastAutoLockArmAt = 0;
  const unlockedListeners = new Set();
  const runWrite = serialQueue();
  const runAuth = serialQueue();
  const runSettings = serialQueue();
  const runBackup = serialQueue();

  const loadRecord = async () => (await local.get(VAULT_KEY))[VAULT_KEY] ?? null;

  async function resume() {
    if (lockInProgress) await lockInProgress;
    const generationAtStart = sessionGeneration;
    let s = (await session.get(SESSION_KEY))[SESSION_KEY];
    let kept = false;
    if (!isObject(s) || typeof s.dek !== 'string') {
      if ((await getSettings()).autoLockMinutes !== NEVER_LOCK) return null;
      s = (await local.get(KEEP_KEY))[KEEP_KEY];
      if (!isObject(s) || typeof s.dek !== 'string') return null;
      kept = true;
    }
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
    if (generationAtStart !== sessionGeneration) return cache;
    if (!c) {
      await (kept ? local.remove(KEEP_KEY) : session.remove(SESSION_KEY));
      return null;
    }
    if (kept) await session.set({ [SESSION_KEY]: { dek: s.dek } });
    cache = c;
    return c;
  }

  async function ensureUnlocked() {
    if (cache) return cache;
    if (!resumeInProgress) resumeInProgress = resume().finally(() => { resumeInProgress = null; });
    const c = await resumeInProgress;
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
    sessionGeneration++;
    cache = null;
    const done = Promise.all([session.remove(SESSION_KEY), local.remove(KEEP_KEY), chrome.alarms.clear(AUTOLOCK_ALARM)]);
    const mine = done.then(() => {}, () => {});
    lockInProgress = mine;
    try {
      await done;
    } finally {
      if (lockInProgress === mine) lockInProgress = null;
    }
  }

  async function writeSessionDek(dek) {
    const raw = await exportDek(dek);
    await session.set({ [SESSION_KEY]: { dek: toB64(raw) } });
    raw.fill(0);
  }

  async function keepIfNeverLock(dek) {
    if ((await getSettings()).autoLockMinutes !== NEVER_LOCK) return;
    const generationAtStart = sessionGeneration;
    const raw = await exportDek(dek);
    await local.set({ [KEEP_KEY]: { dek: toB64(raw) } });
    raw.fill(0);
    if (generationAtStart !== sessionGeneration) await local.remove(KEEP_KEY);
  }

  async function startSession(dek, data) {
    if (lockInProgress) await lockInProgress;
    const generationAtStart = sessionGeneration;
    await writeSessionDek(dek);
    if (generationAtStart !== sessionGeneration) {
      await session.remove(SESSION_KEY);
      throw fail(ERR.LOCKED, 'Vault was locked');
    }
    sessionGeneration++;
    cache = { dek, data };
    consecutiveBadPasswords = 0;
    await keepIfNeverLock(dek);
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
    if (consecutiveBadPasswords >= FREE_UNLOCK_ATTEMPTS) {
      await sleep(Math.min(1000 * 2 ** (consecutiveBadPasswords - FREE_UNLOCK_ATTEMPTS), MAX_UNLOCK_DELAY_MS));
    }
    try {
      const opened = await openVaultRecord(record, password);
      consecutiveBadPasswords = 0;
      return opened;
    } catch (e) {
      if (e?.code === ERR.BAD_PASSWORD) consecutiveBadPasswords++;
      throw e;
    }
  }

  async function armAutoLock(force) {
    const t = now();
    if (!force && t - lastAutoLockArmAt < REARM_THROTTLE_MS) return;
    lastAutoLockArmAt = t;
    const { autoLockMinutes } = await getSettings();
    if (autoLockMinutes > 0) await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: autoLockMinutes });
    else await chrome.alarms.clear(AUTOLOCK_ALARM);
  }

  async function touchActivity() {
    if (now() - lastAutoLockArmAt < REARM_THROTTLE_MS) return;
    try {
      if (await isLocked()) return;
      await armAutoLock(false);
    } catch { }
  }

  function onAlarm(alarm) {
    if (alarm?.name === AUTOLOCK_ALARM) return lock().catch(() => {});
    return undefined;
  }

  async function readData() {
    const c = await ensureUnlocked();
    return structuredClone(c.data);
  }

  function mutateData(fn) {
    return runWrite(async () => {
      const c = await ensureUnlocked();
      const record = await loadRecord();
      if (!record) throw fail(ERR.NOT_INITIALIZED, 'Vault not set up');
      const before = attachmentIdsIn(c.data);
      const draft = structuredClone(c.data);
      const result = await fn(draft);
      pruneTrash(draft, now());
      draft.updatedAt = now();
      await local.set({ [VAULT_KEY]: await sealData(record, c.dek, draft) });
      if (cache) cache.data = draft;
      await dropUnreferenced(before, draft);
      return result;
    });
  }

  function dropUnreferenced(before, data) {
    const after = attachmentIdsIn(data);
    return removeQuietly([...before].filter((id) => !after.has(id) && isAttachmentId(id)).map(attachmentStorageKey));
  }

  async function removeQuietly(keys) {
    if (!keys.length) return;
    try {
      await local.remove(keys);
    } catch { }
  }

  function onUnlocked(cb) {
    unlockedListeners.add(cb);
    return () => unlockedListeners.delete(cb);
  }

  const makeItem = (partial) => makeItemAt(partial, now());

  async function getSettings() {
    const stored = (await local.get(SETTINGS_KEY))[SETTINGS_KEY];
    const out = { ...DEFAULT_SETTINGS };
    if (isObject(stored)) {
      for (const [key, ok] of Object.entries(SETTING_RULES)) if (ok(stored[key])) out[key] = stored[key];
    }
    return out;
  }

  async function setSettings(patch, masterPassword) {
    if (!isObject(patch)) throw fail(ERR.INVALID, 'patch must be an object');
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(SETTING_RULES, key) || !SETTING_RULES[key](value)) throw fail(ERR.INVALID, 'Invalid setting: ' + key);
    }
    if (patch.autoLockMinutes === NEVER_LOCK && (await getSettings()).autoLockMinutes !== NEVER_LOCK) {
      await ensureUnlocked();
      if (!(await verifyMasterPassword(masterPassword))) throw fail(ERR.BAD_PASSWORD, 'Wrong master password');
    }
    return runSettings(async () => {
      const current = await getSettings();
      const next = { ...current, ...patch };
      await local.set({ [SETTINGS_KEY]: next });
      if (next.language !== current.language) applyLanguage(next.language);
      if (next.autoLockMinutes !== current.autoLockMinutes) {
        if (next.autoLockMinutes !== NEVER_LOCK) await local.remove(KEEP_KEY);
        else if (cache) await keepIfNeverLock(cache.dek);
        if (!(await isLocked())) await armAutoLock(true);
      }
      return next;
    });
  }

  function setup(password) {
    checkNewPassword(password);
    return runWrite(async () => {
      if (await loadRecord()) throw fail(ERR.ALREADY_INITIALIZED, 'Vault already exists');
      const data = defaultData(now());
      const { record, dek } = await createVault(password, data, { iterations });
      await local.set({ [VAULT_KEY]: record });
      await local.set({ [BACKUP_KEY]: { lastAt: null, since: now(), snoozeUntil: null } });
      await startSession(dek, data);
      return {};
    });
  }

  const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

  async function loadBackup() {
    const stored = (await local.get(BACKUP_KEY))[BACKUP_KEY];
    if (isObject(stored) && isTime(stored.since)) {
      return {
        lastAt: isTime(stored.lastAt) ? stored.lastAt : null,
        since: stored.since,
        snoozeUntil: isTime(stored.snoozeUntil) ? stored.snoozeUntil : null,
      };
    }
    const fresh = { lastAt: null, since: now(), snoozeUntil: null };
    await local.set({ [BACKUP_KEY]: fresh });
    return fresh;
  }

  const updateBackup = (patch) => runBackup(async () => {
    const next = { ...(await loadBackup()), ...patch };
    await local.set({ [BACKUP_KEY]: next });
    return next;
  });

  const recordBackup = () => updateBackup({ lastAt: now(), snoozeUntil: null });

  async function backupStatus() {
    const c = await ensureUnlocked();
    const b = await runBackup(loadBackup);
    const t = now();
    const days = Math.max(0, Math.floor((t - (b.lastAt ?? b.since)) / DAY_MS));
    const snoozed = b.snoozeUntil !== null && b.snoozeUntil > t;
    return { lastAt: b.lastAt, days, due: c.data.items.length > 0 && days >= BACKUP_REMIND_DAYS && !snoozed };
  }

  async function snoozeBackup() {
    await ensureUnlocked();
    await updateBackup({ snoozeUntil: now() + BACKUP_SNOOZE_DAYS * DAY_MS });
    return backupStatus();
  }

  async function noteBackup() {
    await ensureUnlocked();
    await recordBackup();
    return backupStatus();
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
      await runWrite(async () => {
        const c = await ensureUnlocked();
        const generationAtStart = sessionGeneration;
        const { record: rotated, dek } = await createVault(next, c.data, { iterations });
        await local.set({ [VAULT_KEY]: rotated });
        if (generationAtStart !== sessionGeneration) return;
        await writeSessionDek(dek);
        if (generationAtStart !== sessionGeneration) {
          await session.remove(SESSION_KEY);
          return;
        }
        cache = { dek, data: c.data };
        await keepIfNeverLock(dek);
      });
      return {};
    });
  }

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
    return {
      vaults: structuredClone(c.data.vaults),
      items: c.data.items.map(sanitizeItem),
      trash: trashOut(c.data),
    };
  }

  const trashOut = (data) => liveTrash(data, now()).map((e) => ({
    id: e.id, type: e.type ?? 'login', title: e.title ?? '', vault: e.vault, hue: e.hue, deletedAt: e.deletedAt,
    attachmentBytes: attachmentBytesIn({ items: [e] }),
  }));

  async function saveItem(item) {
    const saved = await mutateData((draft) => {
      const t = now();
      const id = isObject(item) ? item.id : undefined;
      let target = typeof id === 'string' && id ? draft.items.find((i) => i.id === id) : null;
      if (typeof id === 'string' && id && !target) throw fail(ERR.NOT_FOUND, 'Item not found');
      const fields = validateItem(item, target);
      if (target) {
        const { id: _id, ...edit } = fields;
        const { password, ...rest } = edit;
        Object.assign(target, rest, { updatedAt: t });
        if (password !== undefined) {
          if (target.type === 'login' || target.type === undefined) setLoginPassword(target, password, t);
          else target.password = password;
        }
        if (Array.isArray(target.attachments) && !target.attachments.length) delete target.attachments;
        stripLegacyLoginKeys(target);
      } else {
        target = makeItemAt(fields, t);
        draft.items.push(target);
      }
      if (!draft.vaults.some((v) => v.id === target.vault)) throw fail(ERR.INVALID, 'Unknown vault');
      return sanitizeItem(target);
    });
    return { item: saved };
  }

  function checkIds(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IMPORT_ITEMS) {
      throw fail(ERR.INVALID, `ids must be a non-empty array (max ${MAX_IMPORT_ITEMS})`);
    }
    if (!ids.every((id) => typeof id === 'string' && id)) throw fail(ERR.INVALID, 'ids must be non-empty strings');
  }

  async function deleteItem(id) {
    if (typeof id !== 'string' || !id) throw fail(ERR.INVALID, 'id required');
    return mutateData((draft) => {
      if (!trashItems(draft, [id], now()).length) throw fail(ERR.NOT_FOUND, 'Item not found');
      return { ids: [id], trash: trashOut(draft) };
    });
  }

  async function deleteItems(ids) {
    checkIds(ids);
    return mutateData((draft) => {
      const moved = trashItems(draft, ids, now());
      if (!moved.length) throw fail(ERR.NOT_FOUND, 'Items not found');
      return { deleted: moved.length, ids: moved, trash: trashOut(draft) };
    });
  }

  async function restoreFromTrash(ids) {
    checkIds(ids);
    return mutateData((draft) => {
      const items = restoreItems(draft, ids, now());
      return { items: items.map(sanitizeItem), trash: trashOut(draft) };
    });
  }

  async function purgeFromTrash(ids, all) {
    if (all !== true) checkIds(ids);
    return mutateData((draft) => {
      const purged = purgeTrash(draft, all === true ? null : ids, now());
      if (!purged) throw fail(ERR.NOT_FOUND, 'Nothing to delete');
      return { purged, trash: trashOut(draft) };
    });
  }

  async function pendingPassword(id, action, password) {
    if (typeof id !== 'string' || !id) throw fail(ERR.INVALID, 'id required');
    if (!['set', 'confirm', 'discard'].includes(action)) throw fail(ERR.INVALID, 'action must be set, confirm or discard');
    return mutateData((draft) => {
      const t = now();
      const item = draft.items.find((i) => i.id === id);
      if (!item) throw fail(ERR.NOT_FOUND, 'Item not found');
      if ((item.type ?? 'login') !== 'login') throw fail(ERR.INVALID, 'Only logins have passwords');
      if (action === 'set') {
        setPendingPassword(item, password, t);
      } else if (action === 'confirm') {
        const next = item.pendingPassword?.password;
        if (!next) throw fail(ERR.NOT_FOUND, 'No pending password');
        setLoginPassword(item, next, t);
      } else {
        setPendingPassword(item, null, t);
      }
      item.updatedAt = t;
      return { item: sanitizeItem(item) };
    });
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

  async function addVault(name, hue) {
    return mutateData((draft) => {
      const vault = createVaultIn(draft, { name, hue });
      return { vault, vaults: structuredClone(draft.vaults) };
    });
  }

  async function updateVault(id, name, hue) {
    if (typeof id !== 'string' || !id) throw fail(ERR.INVALID, 'id required');
    return mutateData((draft) => {
      const vault = updateVaultIn(draft, id, { name, hue });
      return { vault, vaults: structuredClone(draft.vaults) };
    });
  }

  async function deleteVault(id, moveTo, deleteItems) {
    if (typeof id !== 'string' || !id) throw fail(ERR.INVALID, 'id required');
    if (moveTo !== null && (typeof moveTo !== 'string' || !moveTo)) throw fail(ERR.INVALID, 'moveTo must be a vault id or null');
    if (typeof deleteItems !== 'boolean') throw fail(ERR.INVALID, 'deleteItems must be a boolean');
    return mutateData((draft) => ({
      ...deleteVaultIn(draft, id, { moveTo, deleteItems }, now()),
      vaults: structuredClone(draft.vaults),
      trash: trashOut(draft),
    }));
  }

  const checkItemId = (id) => {
    if (typeof id !== 'string' || !id || id.length > MAX_ITEM_ID_LENGTH) throw fail(ERR.INVALID, 'itemId required');
  };

  function decodeAttachmentData(data) {
    if (typeof data !== 'string') throw fail(ERR.INVALID, 'data must be base64');
    if (data.length > maxAttachmentB64Length()) throw fail(ERR.QUOTA, 'File is too large');
    let bytes;
    try {
      bytes = fromB64(data);
    } catch {
      throw fail(ERR.INVALID, 'data must be base64');
    }
    if (!bytes.length) throw fail(ERR.INVALID, 'File is empty');
    if (bytes.length > ATTACHMENT_LIMITS.fileBytes) throw fail(ERR.QUOTA, 'File is too large');
    return bytes;
  }

  async function addAttachment(itemId, name, mime, data) {
    checkItemId(itemId);
    const cleanName = cleanAttachmentName(name);
    if (!cleanName) throw fail(ERR.INVALID, 'Invalid file name');
    const bytes = decodeAttachmentData(data);
    const id = crypto.randomUUID();
    const storageKey = attachmentStorageKey(id);
    let written = false;
    try {
      return await mutateData(async (draft) => {
        const item = draft.items.find((i) => i.id === itemId);
        if (!item) throw fail(ERR.NOT_FOUND, 'Item not found');
        const list = Array.isArray(item.attachments) ? item.attachments : [];
        if (list.length >= ATTACHMENT_LIMITS.perItem) throw fail(ERR.QUOTA, 'Too many attachments on this item');
        if (attachmentBytesIn(draft) + bytes.length > ATTACHMENT_LIMITS.totalBytes) throw fail(ERR.QUOTA, 'Attachment storage is full');
        const meta = { id, name: cleanName, mime: cleanMime(mime), size: bytes.length, addedAt: now(), key: newAttachmentKey() };
        const box = await encryptAttachment(meta.key, id, bytes);
        written = true;
        await local.set({ [storageKey]: box });
        item.attachments = [...list, meta];
        item.updatedAt = now();
        return { item: sanitizeItem(item) };
      });
    } catch (e) {
      if (written) await removeQuietly([storageKey]);
      throw e;
    }
  }

  async function getAttachment(itemId, attachmentId) {
    checkItemId(itemId);
    if (!isAttachmentId(attachmentId)) throw fail(ERR.INVALID, 'Invalid attachmentId');
    const c = await ensureUnlocked();
    const meta = c.data.items.find((i) => i.id === itemId)?.attachments?.find((a) => a.id === attachmentId);
    if (!meta) throw fail(ERR.NOT_FOUND, 'Attachment not found');
    const storageKey = attachmentStorageKey(attachmentId);
    const box = (await local.get(storageKey))[storageKey];
    if (box === undefined) throw fail(ERR.NOT_FOUND, 'Attachment not found');
    const bytes = await decryptAttachment(meta.key, meta.id, box);
    return { name: meta.name, mime: meta.mime, size: bytes.length, data: toB64(bytes) };
  }

  async function exportVault() {
    await ensureUnlocked();
    const { record, boxes } = await runWrite(async () => {
      const c = await ensureUnlocked();
      const ids = attachmentsIn({ items: c.data.items }).map((a) => a.id).filter(isAttachmentId);
      const keys = ids.map(attachmentStorageKey);
      const stored = keys.length ? await local.get(keys) : {};
      const out = {};
      for (const id of ids) if (stored[attachmentStorageKey(id)] !== undefined) out[id] = stored[attachmentStorageKey(id)];
      return { record: await loadRecord(), boxes: out };
    });
    const json = exportBackup(record, now(), boxes);
    return { json };
  }

  async function takeAttachments(draft, known, boxes, written) {
    pruneTrash(draft, now());
    const trashIds = attachmentIdsIn({ trash: draft.trash });
    let total = attachmentBytesIn({ trash: draft.trash });
    const accepted = new Map();
    const pending = [];
    for (const a of attachmentsIn({ items: draft.items })) {
      if (trashIds.has(a.id) || accepted.has(a.id)) continue;
      if (!known.has(a.id)) pending.push(a);
      else if (known.get(a.id) === a.key) {
        accepted.set(a.id, a);
        total += a.size;
      }
    }
    for (const a of pending) {
      if (accepted.has(a.id) || total + a.size > ATTACHMENT_LIMITS.totalBytes || !Object.hasOwn(boxes, a.id)) continue;
      try {
        if ((await decryptAttachment(a.key, a.id, boxes[a.id])).length !== a.size) continue;
      } catch {
        continue;
      }
      const storageKey = attachmentStorageKey(a.id);
      written.push(storageKey);
      await local.set({ [storageKey]: boxes[a.id] });
      accepted.set(a.id, a);
      total += a.size;
    }
    let skipped = 0;
    for (const it of draft.items) {
      if (!Array.isArray(it.attachments)) continue;
      const kept = it.attachments.filter((a) => accepted.get(a.id) === a);
      skipped += it.attachments.length - kept.length;
      if (kept.length) it.attachments = kept;
      else delete it.attachments;
    }
    return skipped;
  }

  async function importVault(json, password) {
    await ensureUnlocked();
    if (typeof json !== 'string' || !json || json.length > MAX_IMPORT_CHARS) throw fail(ERR.INVALID, 'Invalid backup');
    if (typeof password !== 'string') throw fail(ERR.INVALID, 'masterPassword must be a string');
    const incoming = await importBackup(json, password);
    const written = [];
    try {
      return await mutateData(async (draft) => {
        const known = new Map(attachmentsIn(draft).map((a) => [a.id, a.key]));
        const merged = mergeData(draft, incoming);
        draft.vaults = merged.data.vaults;
        draft.items = merged.data.items;
        const malformed = merged.ids.reduce((n, id) => n + (incoming.skippedAttachments?.get(id) ?? 0), merged.skippedAttachments);
        const skippedAttachments = malformed + await takeAttachments(draft, known, incoming.attachments, written);
        return { count: merged.count, skippedAttachments };
      });
    } catch (e) {
      await removeQuietly(written);
      throw e;
    }
  }

  async function importItems(items, vaultId) {
    await ensureUnlocked();
    if (!Array.isArray(items)) throw fail(ERR.INVALID, 'items must be an array');
    if (items.length > MAX_IMPORT_ITEMS) throw fail(ERR.INVALID, `Too many items (max ${MAX_IMPORT_ITEMS})`);
    if (typeof vaultId !== 'string' || !vaultId) throw fail(ERR.INVALID, 'vault required');
    return mutateData((draft) => addImportedItems(draft, items, vaultId, now()));
  }

  async function exportPlain(format, masterPassword) {
    if (format !== 'csv' && format !== 'bitwarden') throw fail(ERR.INVALID, 'Unknown export format');
    await ensureUnlocked();
    if (!(await verifyMasterPassword(masterPassword))) throw fail(ERR.BAD_PASSWORD, 'Wrong master password');
    const { data } = await ensureUnlocked();
    const d = new Date(now());
    const ymd = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    return format === 'csv'
      ? { text: toCsv(data), filename: `akari-export-${ymd}.csv`, count: data.items.length }
      : { text: toBitwardenJson(data), filename: `akari-export-${ymd}.json`, count: data.items.length };
  }

  async function status() {
    const initialized = !!(await loadRecord());
    return { initialized, locked: initialized ? await isLocked() : true };
  }

  const table = {
    [MSG.VAULT_STATUS]: () => status(),
    [MSG.VAULT_SETUP]: (m) => setup(m.masterPassword),
    [MSG.VAULT_UNLOCK]: (m) => unlock(m.masterPassword),
    [MSG.VAULT_LOCK]: async () => { await lock(); return {}; },
    [MSG.VAULT_GET_ALL]: () => getAll(),
    [MSG.VAULT_SAVE_ITEM]: (m) => saveItem(m.item),
    [MSG.VAULT_DELETE_ITEM]: (m) => deleteItem(m.id),
    [MSG.VAULT_DELETE_ITEMS]: (m) => deleteItems(m.ids),
    [MSG.VAULT_RESTORE_ITEMS]: (m) => restoreFromTrash(m.ids),
    [MSG.VAULT_PURGE_ITEMS]: (m) => purgeFromTrash(m.ids, m.all),
    [MSG.VAULT_DELETE_PASSKEY]: (m) => deletePasskey(m.itemId, m.credentialId),
    [MSG.VAULT_ADD_ATTACHMENT]: (m) => addAttachment(m.itemId, m.name, m.mime, m.data),
    [MSG.VAULT_GET_ATTACHMENT]: (m) => getAttachment(m.itemId, m.attachmentId),
    [MSG.VAULT_PENDING_PASSWORD]: (m) => pendingPassword(m.id, m.action, m.password),
    [MSG.VAULT_CHANGE_PASSWORD]: (m) => changePassword(m.current, m.next),
    [MSG.VAULT_EXPORT]: () => exportVault(),
    [MSG.VAULT_IMPORT]: (m) => importVault(m.json, m.masterPassword),
    [MSG.VAULT_IMPORT_ITEMS]: (m) => importItems(m.items, m.vault),
    [MSG.VAULT_EXPORT_PLAIN]: (m) => exportPlain(m.format, m.masterPassword),
    [MSG.BACKUP_STATUS]: () => backupStatus(),
    [MSG.BACKUP_SNOOZE]: () => snoozeBackup(),
    [MSG.BACKUP_RECORD]: () => noteBackup(),
    [MSG.VAULT_CREATE_VAULT]: (m) => addVault(m.name, m.hue),
    [MSG.VAULT_UPDATE_VAULT]: (m) => updateVault(m.id, m.name, m.hue),
    [MSG.VAULT_DELETE_VAULT]: (m) => deleteVault(m.id, m.moveTo ?? null, m.deleteItems ?? false),
    [MSG.SETTINGS_GET]: () => getSettings(),
    [MSG.SETTINGS_SET]: (m) => setSettings(m.patch, m.masterPassword),
    [MSG.ACTIVITY_PING]: () => ({}),
  };
  const ACTIVE = new Set([
    MSG.VAULT_GET_ALL, MSG.VAULT_SAVE_ITEM, MSG.VAULT_DELETE_ITEM, MSG.VAULT_DELETE_ITEMS, MSG.VAULT_RESTORE_ITEMS, MSG.VAULT_PURGE_ITEMS,
    MSG.VAULT_DELETE_PASSKEY, MSG.VAULT_PENDING_PASSWORD, MSG.VAULT_ADD_ATTACHMENT,
    MSG.VAULT_CHANGE_PASSWORD, MSG.VAULT_EXPORT, MSG.VAULT_IMPORT, MSG.VAULT_IMPORT_ITEMS, MSG.VAULT_EXPORT_PLAIN,
    MSG.VAULT_CREATE_VAULT, MSG.VAULT_UPDATE_VAULT, MSG.VAULT_DELETE_VAULT, MSG.SETTINGS_SET, MSG.ACTIVITY_PING,
    MSG.BACKUP_SNOOZE, MSG.BACKUP_RECORD,
  ]);
  const handlers = {};
  for (const [type, fn] of Object.entries(table)) {
    handlers[type] = async (msg, sender) => {
      const out = await fn(msg || {}, sender);
      if (ACTIVE.has(type)) await touchActivity();
      return out;
    };
  }

  function install() {
    try {
      Promise.resolve(session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {});
    } catch { }
    try {
      Promise.resolve(local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })).catch(() => {});
    } catch { }
    chrome.alarms?.onAlarm?.addListener(onAlarm);
    getSettings().then((s) => applyLanguage(s.language), () => {});
  }

  return {
    isLocked, readData, mutateData, onUnlocked, getSettings, touchActivity, sanitizeItem, makeItem,
    verifyMasterPassword, lock, install, handlers,
  };
}

const live = globalThis.chrome?.storage?.local ? createVaultService({ chrome: globalThis.chrome }) : null;
if (live) {
  live.install();
  for (const [type, handler] of Object.entries(live.handlers)) register(type, handler, { from: 'extension' });
  register(MSG.SETTINGS_LANGUAGE, async () => {
    const { language, theme } = await live.getSettings();
    return { language, theme };
  }, { from: 'content' });
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
