// Passkey service: Akari answers navigator.credentials.create/get for https (and
// localhost) top frames. Every request is checked against the sender's origin,
// then the user approves it in the consent window (src/passkey/passkey.html).
//
// Sign-in (get) while Akari is unlocked is answered with the site's passkeys instead
// of a window: webauthn-bridge.js shows them on a card in the page, and a trusted
// click there asks for the assertion ('passkey/assert'). That is also how passkey
// autofill (mediation 'conditional') is offered. Locked: a modal request opens the
// consent window to unlock, a conditional one is left to the browser. Registration
// (create) always uses the window. The master password is never asked for in a page.
//
// User verification: in the consent window the UV flag is set only when the user
// proved the master password there ('passkey/verify', which the window also calls
// right after unlocking). The window asks for it on 'required' and 'preferred';
// 'required' without that proof is refused here, and an approval without it
// ('discouraged') gets UV=0. A choice on the page card counts as verified because
// it needs an unlocked vault, which itself took the master password.

import { register, AkariError } from './router.js';
import * as vaultService from './vault-service.js';
import { MSG } from '../shared/messages.js';
import { toB64url, fromB64url, sha256 } from '../shared/bytes.js';
import { isSecureOrigin, isValidRpId, hostnameOf, sameSite } from '../shared/domain.js';
import { createCredential, getAssertion, buildClientDataJSON, COSE_ALG_ES256 } from '../lib/webauthn.js';

// Not in shared/messages.js: sent by webauthn-bridge.js when the page aborts (AbortSignal),
// and by the consent window to prove the master password for this request.
export const PASSKEY_CANCEL = 'passkey/cancel';
export const PASSKEY_VERIFY = 'passkey/verify';
// Sent by webauthn-bridge.js when the user picks a passkey on the page card.
export const PASSKEY_ASSERT = 'passkey/assert';
export const PORT_PREFIX = 'akari-passkey:';
const WINDOW_PATH = 'src/passkey/passkey.html';

const MIN_TIMEOUT = 30_000;
const MAX_TIMEOUT = 300_000;
const MAX_CHALLENGE = 1024;
const WINDOW_W = 400;
const WINDOW_H = 520;

const fail = (code, message) => new AkariError(code, message || code);

function b64urlBytes(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw fail('INVALID', what + ' must be base64url');
  try {
    return fromB64url(value);
  } catch {
    throw fail('INVALID', what + ' must be base64url');
  }
}

const str = (v, max = 256) => (v == null ? '' : String(v).slice(0, max));

function credentialList(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw fail('INVALID', 'credential list must be an array');
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
  /** reqId -> entry */
  const pending = new Map();
  const ports = new Set();

  const ownPageUrl = () => chrome.runtime.getURL(WINDOW_PATH);
  const touch = () => { Promise.resolve().then(() => vault.touchActivity?.()).catch(() => {}); };

  // ---------- validation of content-script requests ----------

  function callerOrigin(sender) {
    if (!sender || sender.frameId !== 0 || !sender.tab) throw fail('SECURITY', 'top frame only');
    let origin = sender.origin;
    if (origin === undefined) {
      try { origin = new URL(sender.url).origin; } catch { origin = 'null'; }
    }
    // An opaque origin ('null', e.g. a CSP-sandboxed document) must not borrow the URL's origin.
    if (!origin || origin === 'null' || !isSecureOrigin(origin)) throw fail('SECURITY', 'insecure origin');
    return origin;
  }

  function resolveRpId(requested, origin) {
    const rpId = requested == null ? hostnameOf(origin) : String(requested).toLowerCase();
    if (!isValidRpId(rpId, origin)) throw fail('SECURITY', 'rpId not valid for this origin');
    return rpId;
  }

  function parseChallenge(value) {
    const bytes = b64urlBytes(value, 'challenge');
    if (bytes.length < 1 || bytes.length > MAX_CHALLENGE) throw fail('INVALID', 'bad challenge length');
    return toB64url(bytes);
  }

  function parseCreate(options, origin) {
    if (!options || typeof options !== 'object') throw fail('INVALID', 'missing options');
    const rp = options.rp && typeof options.rp === 'object' ? options.rp : {};
    const rpId = resolveRpId(rp.id, origin);
    const user = options.user && typeof options.user === 'object' ? options.user : null;
    if (!user) throw fail('INVALID', 'missing user');
    const userHandle = b64urlBytes(user.id, 'user.id');
    if (userHandle.length < 1 || userHandle.length > 64) throw fail('INVALID', 'user.id must be 1-64 bytes');
    const challenge = parseChallenge(options.challenge);

    const params = options.pubKeyCredParams;
    if (params != null && !Array.isArray(params)) throw fail('INVALID', 'pubKeyCredParams must be an array');
    // An empty list means "ES256 and RS256" per the spec.
    const es256 = !params || params.length === 0
      || params.some((p) => p && p.type === 'public-key' && p.alg === COSE_ALG_ES256);
    if (!es256) throw fail('FALLBACK', 'ES256 not acceptable');
    if (options.authenticatorSelection?.authenticatorAttachment === 'cross-platform') throw fail('FALLBACK', 'security key requested');

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
    if (!options || typeof options !== 'object') throw fail('INVALID', 'missing options');
    return {
      rpId: resolveRpId(options.rpId, origin),
      challenge: parseChallenge(options.challenge),
      allow: credentialList(options.allowCredentials),
      userVerification: userVerification(options.userVerification),
      timeout: clampTimeout(options.timeout),
    };
  }

  // ---------- vault helpers ----------

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

  async function readIfUnlocked() {
    if (await vault.isLocked()) return null;
    try {
      return await vault.readData();
    } catch (e) {
      if (e?.code === 'LOCKED') return null;
      throw e;
    }
  }

  // ---------- pending requests ----------

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
      verifiedAt: null, // set only by a successful 'passkey/verify' for this request
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
    if (!entry) throw fail('NOT_FOUND', 'request expired');
    await entry.windowReady;
    if (entry.done) throw fail('NOT_FOUND', 'request expired');
    const fromOwnPage = typeof sender?.url === 'string' && sender.url.startsWith(ownPageUrl());
    if (!fromOwnPage || sender.tab?.windowId == null || sender.tab.windowId !== entry.windowId) {
      throw fail('FORBIDDEN', 'request belongs to another window');
    }
    return entry;
  }

  // ---------- handlers ----------

  async function handleCreate(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseCreate(msg.options, origin), origin };
    // Conditional create (silent passkey upgrade after a password sign-in) is left to the browser.
    if (msg.mediation === 'conditional') throw fail('FALLBACK', 'mediation not supported');
    // An excluded credential is reported only after the user acts in the window, so
    // pages cannot probe silently which credentials Akari holds.
    return { credential: await startRequest('create', sender, msg, req) };
  }

  async function handleGet(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseGet(msg.options, origin), origin };
    if (msg.mediation === 'silent') throw fail('FALLBACK', 'mediation not supported');
    const data = await readIfUnlocked();
    if (data) {
      const found = passkeysFor(data, req.rpId, req.allow);
      if (!found.length) throw fail('FALLBACK', 'no passkey for this site');
      touch();
      return { inline: { rpId: req.rpId, candidates: candidatesOf(data, found) } };
    }
    // Locked: whether Akari holds a passkey for this site is unknown until it is unlocked.
    if (msg.mediation === 'conditional') throw fail('FALLBACK', 'locked');
    return { credential: await startRequest('get', sender, msg, req) };
  }

  /** The user picked a passkey on the page card: sign the request the page made. */
  async function handleAssert(msg, sender) {
    const origin = callerOrigin(sender);
    const req = { ...parseGet(msg.options, origin), origin };
    if (typeof msg.credentialId !== 'string' || !msg.credentialId) throw fail('INVALID', 'credentialId required');
    if (await vault.isLocked()) throw fail('LOCKED', 'unlock first');
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

    const vaults = (data.vaults || []).map((v) => ({ id: v.id, name: v.name, hue: v.hue }));
    if (entry.kind === 'create') {
      const existing = (data.items || []).find((it) => it.type === 'login'
        && sameSite(it.url, req.origin) && (it.username || '') === req.user.name);
      return {
        ...base,
        locked: false,
        candidates: [],
        vaults,
        excluded: req.exclude.length > 0 && passkeysFor(data, req.rpId, req.exclude).length > 0,
        defaultVault: existing?.vault || vaults[0]?.id || null,
      };
    }
    const candidates = candidatesOf(data, passkeysFor(data, req.rpId, req.allow));
    return { ...base, locked: false, candidates, vaults, excluded: false, defaultVault: null };
  }

  /** What the consent window and the page card show for each passkey, most recently used first. */
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
    if (typeof msg.masterPassword !== 'string' || !msg.masterPassword) throw fail('INVALID', 'password required');
    if (typeof vault.verifyMasterPassword !== 'function') throw fail('INTERNAL', 'verifyMasterPassword unavailable');
    if (!(await vault.verifyMasterPassword(msg.masterPassword))) throw fail('BAD_PASSWORD', 'wrong master password');
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
      // A passkey with the same rpId + userHandle replaces the old one, wherever it was.
      for (const it of draft.items) {
        if (Array.isArray(it.passkeys)) {
          it.passkeys = it.passkeys.filter((p) => !(p.rpId === req.rpId && p.userHandle === req.user.id));
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
    if (!found) throw fail('INVALID', 'unknown passkey');
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
    if (entry.busy) throw fail('INVALID', 'already in progress');
    if (await vault.isLocked()) throw fail('LOCKED', 'unlock first');
    entry.busy = true;
    try {
      touch();
      if (entry.kind === 'create') {
        const data = await vault.readData();
        if (entry.req.exclude.length && passkeysFor(data, entry.req.rpId, entry.req.exclude).length) {
          finish(entry, 'INVALID_STATE'); // the user confirmed the "already saved" notice
          return {};
        }
        if (entry.req.userVerification === 'required' && entry.verifiedAt == null) throw fail('UV_REQUIRED', 'verify first');
        finish(entry, null, await approveCreate(entry, msg.vault));
      } else {
        if (entry.req.userVerification === 'required' && entry.verifiedAt == null) throw fail('UV_REQUIRED', 'verify first');
        finish(entry, null, await approveGet(entry, msg.credentialId));
      }
      return {};
    } catch (e) {
      if (['INVALID', 'LOCKED', 'UV_REQUIRED'].includes(e?.code)) throw e; // the window can retry
      finish(entry, 'NOT_ALLOWED');
      throw e;
    } finally {
      entry.busy = false;
    }
  }

  // ---------- chrome listeners ----------

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

  // The consent window keeps a port open and pings it, which keeps this worker alive.
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

  return { handleCreate, handleGet, handleAssert, handleCancel, handleRequest, handleVerify, handleRespond, pending };
}

const service = globalThis.chrome?.runtime?.id
  ? createPasskeyService({ chrome: globalThis.chrome, vault: vaultService })
  : null;

if (service) {
  register(MSG.PASSKEY_CREATE, service.handleCreate, { from: 'content' });
  register(MSG.PASSKEY_GET, service.handleGet, { from: 'content' });
  register(PASSKEY_ASSERT, service.handleAssert, { from: 'content' });
  register(PASSKEY_CANCEL, service.handleCancel, { from: 'content' });
  register(MSG.PASSKEY_REQUEST, service.handleRequest, { from: 'extension' });
  register(PASSKEY_VERIFY, service.handleVerify, { from: 'extension' });
  register(MSG.PASSKEY_RESPOND, service.handleRespond, { from: 'extension' });
}
