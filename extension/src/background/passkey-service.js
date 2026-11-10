import { register } from './router.js';
import { AkariError } from '../shared/errors.js';
import * as vaultService from './vault-service.js';
import { MSG, ERR } from '../shared/messages.js';
import { toB64url, fromB64url, sha256 } from '../shared/bytes.js';
import { isSecureOrigin, isValidRpId, hostnameOf, sameSite } from '../shared/domain.js';
import { createCredential, getAssertion, buildClientDataJSON, COSE_ALG_ES256 } from '../lib/webauthn.js';

import { PASSKEY_PORT_PREFIX as PORT_PREFIX } from '../shared/ports.js';
const WINDOW_PATH = 'src/passkey/passkey.html';

const MIN_TIMEOUT = 30_000;
const MAX_TIMEOUT = 300_000;
const MAX_CHALLENGE = 1024;
const WINDOW_W = 400;
const WINDOW_H = 520;

const RETRYABLE_IN_WINDOW_CODES = ['INVALID', 'LOCKED', 'UV_REQUIRED'];

const fail = (code, message) => new AkariError(code, message || code);

function b64urlBytes(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw fail(ERR.INVALID, what + ' must be base64url');
  try {
    return fromB64url(value);
  } catch {
    throw fail(ERR.INVALID, what + ' must be base64url');
  }
}

const str = (v, max = 256) => (v == null ? '' : String(v).slice(0, max));

function credentialList(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw fail(ERR.INVALID, 'credential list must be an array');
  return list
    .filter((d) => d && (d.type == null || d.type === 'public-key'))
    .map((d) => toB64url(b64urlBytes(d.id, 'credential id')));
}

const UV_VALUES = ['required', 'preferred', 'discouraged'];
const userVerification = (v) => (UV_VALUES.includes(v) ? v : 'preferred');

function clampTimeout(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return MAX_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, t));
}

export function createPasskeyService({ chrome, vault }) {
  const pending = new Map();
  const ports = new Set();

  const ownPageUrl = () => chrome.runtime.getURL(WINDOW_PATH);
  const touch = () => { Promise.resolve().then(() => vault.touchActivity?.()).catch(() => {}); };

  function callerOrigin(sender) {
    if (!sender || sender.frameId !== 0 || !sender.tab) throw fail(ERR.SECURITY, 'top frame only');
    let origin = sender.origin;
    if (origin === undefined) {
      try { origin = new URL(sender.url).origin; } catch { origin = 'null'; }
    }
    if (!origin || origin === 'null' || !isSecureOrigin(origin)) throw fail(ERR.SECURITY, 'insecure origin');
    return origin;
  }

  function resolveRpId(requested, origin) {
    const rpId = requested == null ? hostnameOf(origin) : String(requested).toLowerCase();
    if (!isValidRpId(rpId, origin)) throw fail(ERR.SECURITY, 'rpId not valid for this origin');
    return rpId;
  }

  function parseChallenge(value) {
    const bytes = b64urlBytes(value, 'challenge');
    if (bytes.length < 1 || bytes.length > MAX_CHALLENGE) throw fail(ERR.INVALID, 'bad challenge length');
    return toB64url(bytes);
  }

  function parseCreate(options, origin) {
    if (!options || typeof options !== 'object') throw fail(ERR.INVALID, 'missing options');
    const rp = options.rp && typeof options.rp === 'object' ? options.rp : {};
    const rpId = resolveRpId(rp.id, origin);
    const user = options.user && typeof options.user === 'object' ? options.user : null;
    if (!user) throw fail(ERR.INVALID, 'missing user');
    const userHandle = b64urlBytes(user.id, 'user.id');
    if (userHandle.length < 1 || userHandle.length > 64) throw fail(ERR.INVALID, 'user.id must be 1-64 bytes');
    const challenge = parseChallenge(options.challenge);

    const params = options.pubKeyCredParams;
    if (params != null && !Array.isArray(params)) throw fail(ERR.INVALID, 'pubKeyCredParams must be an array');
    const acceptsEs256 = !params || params.length === 0
      || params.some((p) => p && p.type === 'public-key' && p.alg === COSE_ALG_ES256);
    if (!acceptsEs256) throw fail(ERR.FALLBACK, 'ES256 not acceptable');
    if (options.authenticatorSelection?.authenticatorAttachment === 'cross-platform') throw fail(ERR.FALLBACK, 'security key requested');

    return {
      rpId,
      rpName: str(rp.name) || rpId,
      user: { id: toB64url(userHandle), name: str(user.name), displayName: str(user.displayName) },
      challenge,
      exclude: credentialList(options.excludeCredentials),
      credProps: options.extensions?.credProps === true,
      userVerification: userVerification(options.authenticatorSelection?.userVerification),
      timeout: clampTimeout(options.timeout),
    };
  }

  function parseGet(options, origin) {
    if (!options || typeof options !== 'object') throw fail(ERR.INVALID, 'missing options');
    return {
      rpId: resolveRpId(options.rpId, origin),
      challenge: parseChallenge(options.challenge),
      allow: credentialList(options.allowCredentials),
      userVerification: userVerification(options.userVerification),
      timeout: clampTimeout(options.timeout),
    };
  }

  function passkeysFor(data, rpId, allow = []) {
    const out = [];
    for (const item of data.items || []) {
      for (const pk of item.passkeys || []) {
        if (pk.rpId !== rpId) continue;
        if (allow.length && !allow.includes(pk.credentialId)) continue;
        out.push({ item, pk });
      }
    }
    return out;
  }

  const hasExcludedPasskey = (data, req) => req.exclude.length > 0 && passkeysFor(data, req.rpId, req.exclude).length > 0;
  const needsUnprovenVerification = (entry) => entry.req.userVerification === 'required' && entry.verifiedAt == null;

  async function readIfUnlocked() {
    if (await vault.isLocked()) return null;
    try {
      return await vault.readData();
    } catch (e) {
      if (e?.code === 'LOCKED') return null;
      throw e;
    }
  }

  function finish(entry, error, value) {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    pending.delete(entry.reqId);
    if (error) entry.reject(fail(error));
    else entry.resolve(value);
    if (entry.windowId != null) {
      Promise.resolve().then(() => chrome.windows.remove(entry.windowId)).catch(() => {});
    }
  }

  async function windowBounds(sender) {
    try {
      const w = await chrome.windows.get(sender.tab.windowId);
      if (typeof w?.left !== 'number' || typeof w?.width !== 'number') return {};
      return {
        left: Math.max(0, Math.round(w.left + (w.width - WINDOW_W) / 2)),
        top: Math.max(0, Math.round((w.top || 0) + 80)),
      };
    } catch {
      return {};
    }
  }

  function startRequest(kind, sender, msg, req) {
    const tabId = sender.tab.id;
    for (const other of pending.values()) {
      if (other.tabId === tabId) finish(other, 'NOT_ALLOWED');
    }
    const reqId = toB64url(crypto.getRandomValues(new Uint8Array(16)));
    const entry = {
      reqId, kind, tabId, req,
      origin: req.origin,
      requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : null,
      windowId: null, done: false, busy: false,
      verifiedAt: null,
    };
    const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    pending.set(reqId, entry);
    entry.timer = setTimeout(() => finish(entry, 'NOT_ALLOWED'), req.timeout);
    entry.windowReady = (async () => {
      try {
        const win = await chrome.windows.create({
          url: ownPageUrl() + '?req=' + encodeURIComponent(reqId),
          type: 'popup', width: WINDOW_W, height: WINDOW_H, focused: true,
          ...(await windowBounds(sender)),
        });
        entry.windowId = win.id;
        if (entry.done) Promise.resolve().then(() => chrome.windows.remove(win.id)).catch(() => {});
      } catch {
        finish(entry, 'NOT_ALLOWED');
      }
    })();
    return promise;
  }

  async function entryForWindow(msg, sender) {
    const entry = typeof msg?.reqId === 'string' ? pending.get(msg.reqId) : null;
    if (!entry) throw fail(ERR.NOT_FOUND, 'request expired');
    await entry.windowReady;
    if (entry.done) throw fail(ERR.NOT_FOUND, 'request expired');
    const fromOwnPage = typeof sender?.url === 'string' && sender.url.startsWith(ownPageUrl());
    if (!fromOwnPage || sender.tab?.windowId == null || sender.tab.windowId !== entry.windowId) {
      throw fail(ERR.FORBIDDEN, 'request belongs to another window');
    }
    return entry;
  }

  async function handleCreate(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseCreate(msg.options, origin), origin };
    if (msg.mediation === 'conditional') throw fail(ERR.FALLBACK, 'mediation not supported');
    const data = await readIfUnlocked();
    if (data) {
      touch();
      return { inline: createInfo(data, req) };
    }
    return { credential: await startRequest('create', sender, msg, req) };
  }

  async function handleGet(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseGet(msg.options, origin), origin };
    if (msg.mediation === 'silent') throw fail(ERR.FALLBACK, 'mediation not supported');
    const data = await readIfUnlocked();
    if (data) {
      const found = passkeysFor(data, req.rpId, req.allow);
      if (!found.length) throw fail(ERR.FALLBACK, 'no passkey for this site');
      touch();
      return { inline: { rpId: req.rpId, candidates: candidatesOf(data, found) } };
    }
    if (msg.mediation === 'conditional') throw fail(ERR.FALLBACK, 'locked');
    return { credential: await startRequest('get', sender, msg, req) };
  }

  async function handleSave(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseCreate(msg.options, origin), origin };
    if (await vault.isLocked()) throw fail(ERR.LOCKED, 'unlock first');
    const data = await vault.readData();
    if (hasExcludedPasskey(data, req)) throw fail(ERR.INVALID_STATE, 'already saved');
    touch();
    return { credential: await approveCreate({ req, verifiedAt: Date.now() }, msg.vault) };
  }

  async function handleAssert(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseGet(msg.options, origin), origin };
    if (typeof msg.credentialId !== 'string' || !msg.credentialId) throw fail(ERR.INVALID, 'credentialId required');
    if (await vault.isLocked()) throw fail(ERR.LOCKED, 'unlock first');
    touch();
    return { credential: await approveGet({ req, verifiedAt: Date.now() }, msg.credentialId) };
  }

  function handleCancel(msg, sender) {
    for (const entry of pending.values()) {
      if (entry.tabId === sender?.tab?.id && entry.requestId && entry.requestId === msg.requestId) {
        finish(entry, 'NOT_ALLOWED');
      }
    }
    return {};
  }

  async function handleRequest(msg, sender) {
    const entry = await entryForWindow(msg, sender);
    const { req } = entry;
    const base = {
      kind: entry.kind,
      origin: req.origin,
      rpId: req.rpId,
      rpName: req.rpName || req.rpId,
      user: entry.kind === 'create' ? { name: req.user.name, displayName: req.user.displayName } : null,
      uv: req.userVerification,
      verified: entry.verifiedAt != null,
    };
    const data = await readIfUnlocked();
    if (!data) return { ...base, locked: true, candidates: [], vaults: [], excluded: false, defaultVault: null };
    touch();

    if (entry.kind === 'create') {
      const { vaults, excluded, defaultVault } = createInfo(data, req);
      return { ...base, locked: false, candidates: [], vaults, excluded, defaultVault };
    }
    const candidates = candidatesOf(data, passkeysFor(data, req.rpId, req.allow));
    return { ...base, locked: false, candidates, vaults: vaultsOf(data), excluded: false, defaultVault: null };
  }

  const vaultsOf = (data) => (data.vaults || []).map((v) => ({ id: v.id, name: v.name, hue: v.hue }));

  function createInfo(data, req) {
    const vaults = vaultsOf(data);
    const existing = (data.items || []).find((it) => it.type === 'login'
      && sameSite(it.url, req.origin) && (it.username || '') === req.user.name);
    return {
      rpId: req.rpId,
      rpName: req.rpName || req.rpId,
      user: { name: req.user.name, displayName: req.user.displayName },
      vaults,
      excluded: req.exclude.length > 0 && passkeysFor(data, req.rpId, req.exclude).length > 0,
      defaultVault: existing?.vault || vaults[0]?.id || null,
    };
  }

  function candidatesOf(data, found) {
    const vaultName = new Map((data.vaults || []).map((v) => [v.id, v.name]));
    return found
      .map(({ item, pk }) => ({
        credentialId: pk.credentialId,
        userName: pk.userName || '',
        userDisplayName: pk.userDisplayName || '',
        createdAt: pk.createdAt ?? null,
        lastUsedAt: pk.lastUsedAt ?? null,
        itemTitle: item.title || '',
        vault: item.vault,
        vaultName: vaultName.get(item.vault) || '',
      }))
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0));
  }

  async function handleVerify(msg, sender) {
    const entry = await entryForWindow(msg, sender);
    if (typeof msg.masterPassword !== 'string' || !msg.masterPassword) throw fail(ERR.INVALID, 'password required');
    if (typeof vault.verifyMasterPassword !== 'function') throw fail(ERR.INTERNAL, 'verifyMasterPassword unavailable');
    if (!(await vault.verifyMasterPassword(msg.masterPassword))) throw fail(ERR.BAD_PASSWORD, 'wrong master password');
    if (!entry.done) entry.verifiedAt = Date.now();
    return {};
  }

  async function approveCreate(entry, chosenVault) {
    const { req } = entry;
    const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge: req.challenge, origin: req.origin });
    const cred = await createCredential({
      rpId: req.rpId,
      userHandle: fromB64url(req.user.id),
      userName: req.user.name,
      userDisplayName: req.user.displayName,
      clientDataHash: await sha256(clientDataJSON),
      uv: entry.verifiedAt != null,
    });
    const credentialId = toB64url(cred.credentialId);
    const now = Date.now();

    await vault.mutateData(async (draft) => {
      draft.items ||= [];
      const vaultIds = (draft.vaults || []).map((v) => v.id);
      const vaultId = vaultIds.includes(chosenVault) ? chosenVault : (vaultIds[0] || 'personal');
      const isReplacedPasskey = (p) => p.rpId === req.rpId && p.userHandle === req.user.id;
      for (const it of draft.items) {
        if (Array.isArray(it.passkeys)) {
          it.passkeys = it.passkeys.filter((p) => !isReplacedPasskey(p));
        }
      }
      let item = draft.items.find((it) => it.type === 'login' && it.vault === vaultId
        && sameSite(it.url, req.origin) && (it.username || '') === req.user.name);
      if (!item) {
        item = vault.makeItem({ type: 'login', title: req.rpId, url: req.origin, username: req.user.name, vault: vaultId });
        draft.items.push(item);
      }
      item.passkeys = Array.isArray(item.passkeys) ? item.passkeys : [];
      item.passkeys.push({
        credentialId,
        rpId: req.rpId,
        userHandle: req.user.id,
        userName: req.user.name,
        userDisplayName: req.user.displayName,
        privateKey: toB64url(cred.privateKey),
        publicKey: toB64url(cred.cosePublicKey),
        alg: COSE_ALG_ES256,
        signCount: 0,
        createdAt: now,
        lastUsedAt: null,
      });
      item.updatedAt = now;
    });

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: toB64url(clientDataJSON),
        attestationObject: toB64url(cred.attestationObject),
        authenticatorData: toB64url(cred.authData),
        transports: ['internal', 'hybrid'],
        publicKey: toB64url(cred.spkiPublicKey),
        publicKeyAlgorithm: COSE_ALG_ES256,
      },
      clientExtensionResults: req.credProps ? { credProps: { rk: true } } : {},
    };
  }

  async function approveGet(entry, credentialId) {
    const { req } = entry;
    const data = await vault.readData();
    const found = passkeysFor(data, req.rpId, req.allow).find(({ pk }) => pk.credentialId === credentialId);
    if (!found) throw fail(ERR.INVALID, 'unknown passkey');
    const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge: req.challenge, origin: req.origin });
    const assertion = await getAssertion({
      passkey: found.pk, rpId: req.rpId, clientDataHash: await sha256(clientDataJSON), uv: entry.verifiedAt != null,
    });
    const now = Date.now();
    await vault.mutateData(async (draft) => {
      for (const it of draft.items || []) {
        const pk = (it.passkeys || []).find((p) => p.credentialId === credentialId && p.rpId === req.rpId);
        if (pk) { pk.lastUsedAt = now; it.lastUsedAt = now; }
      }
    });
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: toB64url(clientDataJSON),
        authenticatorData: toB64url(assertion.authenticatorData),
        signature: toB64url(assertion.signature),
        userHandle: toB64url(assertion.userHandle),
      },
      clientExtensionResults: {},
    };
  }

  async function handleRespond(msg, sender) {
    const entry = await entryForWindow(msg, sender);
    if (msg.fallback) { finish(entry, 'FALLBACK'); return {}; }
    if (!msg.approve) { finish(entry, 'NOT_ALLOWED'); return {}; }
    if (entry.busy) throw fail(ERR.INVALID, 'already in progress');
    if (await vault.isLocked()) throw fail(ERR.LOCKED, 'unlock first');
    entry.busy = true;
    try {
      touch();
      if (entry.kind === 'create') {
        const data = await vault.readData();
        if (hasExcludedPasskey(data, entry.req)) {
          finish(entry, 'INVALID_STATE');
          return {};
        }
        if (needsUnprovenVerification(entry)) throw fail(ERR.UV_REQUIRED, 'verify first');
        finish(entry, null, await approveCreate(entry, msg.vault));
      } else {
        if (needsUnprovenVerification(entry)) throw fail(ERR.UV_REQUIRED, 'verify first');
        finish(entry, null, await approveGet(entry, msg.credentialId));
      }
      return {};
    } catch (e) {
      if (RETRYABLE_IN_WINDOW_CODES.includes(e?.code)) throw e;
      finish(entry, 'NOT_ALLOWED');
      throw e;
    } finally {
      entry.busy = false;
    }
  }

  chrome.windows.onRemoved.addListener((windowId) => {
    for (const entry of pending.values()) {
      if (entry.windowId === windowId) finish(entry, 'NOT_ALLOWED');
    }
  });

  chrome.tabs?.onRemoved?.addListener((tabId) => {
    for (const entry of pending.values()) {
      if (entry.tabId === tabId) finish(entry, 'NOT_ALLOWED');
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(PORT_PREFIX)) return;
    if (!port.sender?.url?.startsWith(ownPageUrl())) { port.disconnect(); return; }
    ports.add(port);
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => ports.delete(port));
  });

  vault.onUnlocked?.(() => {
    for (const port of ports) {
      try { port.postMessage({ type: 'refresh' }); } catch { ports.delete(port); }
    }
  });

  return { handleCreate, handleGet, handleAssert, handleSave, handleCancel, handleRequest, handleVerify, handleRespond, pending };
}

const service = globalThis.chrome?.runtime?.id
  ? createPasskeyService({ chrome: globalThis.chrome, vault: vaultService })
  : null;

if (service) {
  register(MSG.PASSKEY_CREATE, service.handleCreate, { from: 'content' });
  register(MSG.PASSKEY_GET, service.handleGet, { from: 'content' });
  register(MSG.PASSKEY_ASSERT, service.handleAssert, { from: 'content' });
  register(MSG.PASSKEY_SAVE, service.handleSave, { from: 'content' });
  register(MSG.PASSKEY_CANCEL, service.handleCancel, { from: 'content' });
  register(MSG.PASSKEY_REQUEST, service.handleRequest, { from: 'extension' });
  register(MSG.PASSKEY_VERIFY, service.handleVerify, { from: 'extension' });
  register(MSG.PASSKEY_RESPOND, service.handleRespond, { from: 'extension' });
}
