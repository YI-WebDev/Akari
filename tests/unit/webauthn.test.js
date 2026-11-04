import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  createCredential, getAssertion, buildClientDataJSON, rawSignatureToDer, AKARI_AAGUID,
} from '../../extension/src/lib/webauthn.js';
import { decode as cborDecode } from '../../extension/src/lib/cbor.js';
import { toB64url, fromB64url, sha256, concat, utf8 } from '../../extension/src/shared/bytes.js';

// passkey-service.js imports vault-service.js (chrome.storage based). The service is
// built from a factory that takes the vault, so the real module is swapped for an empty stub.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)vault-service\.js$/.test(specifier)) {
      return { url: 'data:text/javascript,export%20const%20stub%3Dtrue%3B', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { createPasskeyService } = await import('../../extension/src/background/passkey-service.js');

const RP_ID = 'example.com';
const ORIGIN = 'https://example.com';
const AAGUID_STR = 'ea7f7ba3-3d3b-42cd-8c88-2d82a9548d11';
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------
// lib/webauthn.js against an independent verifier
// ---------------------------------------------------------------------------

async function registerOnce({ rpId = RP_ID, origin = ORIGIN } = {}) {
  const challenge = toB64url(rand(32));
  const userHandle = rand(16);
  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge, origin });
  const cred = await createCredential({
    rpId, userHandle, userName: 'alice@example.com', userDisplayName: 'Alice', clientDataHash: await sha256(clientDataJSON), uv: true,
  });
  const id = toB64url(cred.credentialId);
  const response = {
    id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
    response: {
      clientDataJSON: toB64url(clientDataJSON),
      attestationObject: toB64url(cred.attestationObject),
      authenticatorData: toB64url(cred.authData),
      transports: ['internal', 'hybrid'],
      publicKey: toB64url(cred.spkiPublicKey),
      publicKeyAlgorithm: -7,
    },
  };
  return { challenge, userHandle, clientDataJSON, cred, response };
}

test('clientDataJSON is serialized in spec member order', () => {
  const json = new TextDecoder().decode(buildClientDataJSON({ type: 'webauthn.get', challenge: 'AQID', origin: ORIGIN }));
  assert.equal(json, '{"type":"webauthn.get","challenge":"AQID","origin":"https://example.com","crossOrigin":false}');
  assert.throws(() => buildClientDataJSON({ type: 'payment.get', challenge: 'AQID', origin: ORIGIN }));
});

test('createCredential: attestation verifies with @simplewebauthn/server', async () => {
  const { challenge, cred, response } = await registerOnce();
  const v = await verifyRegistrationResponse({
    response, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
  });
  assert.equal(v.verified, true);
  const info = v.registrationInfo;
  assert.equal(info.fmt, 'none');
  assert.equal(info.aaguid, AAGUID_STR);
  assert.equal(info.userVerified, true);
  assert.equal(info.credentialDeviceType, 'multiDevice');
  assert.equal(info.credentialBackedUp, true);
  assert.equal(info.credential.id, response.id);
  assert.deepEqual(new Uint8Array(info.credential.publicKey), cred.cosePublicKey);
  assert.equal(info.credential.counter, 0);

  const att = cborDecode(cred.attestationObject);
  assert.deepEqual([...att.keys()], ['fmt', 'attStmt', 'authData']);
  assert.equal(att.get('attStmt').size, 0);
  assert.equal(cred.credentialId.length, 32);
  assert.deepEqual(cred.authData.subarray(37, 53), AKARI_AAGUID);
  assert.equal(cred.authData[32], 0x5d); // UP | UV | BE | BS | AT
});

test('getAssertion: assertion verifies with @simplewebauthn/server and node:crypto', async () => {
  const reg = await registerOnce();
  const passkey = {
    credentialId: reg.response.id, rpId: RP_ID, userHandle: toB64url(reg.userHandle),
    privateKey: toB64url(reg.cred.privateKey), publicKey: toB64url(reg.cred.cosePublicKey), alg: -7, signCount: 0,
  };
  const challenge = toB64url(rand(32));
  const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: ORIGIN });
  const clientDataHash = await sha256(clientDataJSON);
  const a = await getAssertion({ passkey, rpId: RP_ID, clientDataHash, uv: true });
  assert.equal(a.authenticatorData.length, 37);
  assert.equal(a.authenticatorData[32], 0x1d); // UP | UV | BE | BS
  assert.deepEqual(a.userHandle, reg.userHandle);

  const v = await verifyAuthenticationResponse({
    response: {
      id: passkey.credentialId, rawId: passkey.credentialId, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: toB64url(clientDataJSON),
        authenticatorData: toB64url(a.authenticatorData),
        signature: toB64url(a.signature),
        userHandle: toB64url(a.userHandle),
      },
    },
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: { id: passkey.credentialId, publicKey: reg.cred.cosePublicKey, counter: 0 },
    requireUserVerification: true,
  });
  assert.equal(v.verified, true);
  assert.equal(v.authenticationInfo.newCounter, 0);

  const key = createPublicKey({ key: Buffer.from(reg.cred.spkiPublicKey), format: 'der', type: 'spki' });
  assert.ok(nodeVerify('sha256', concat(a.authenticatorData, clientDataHash), { key, dsaEncoding: 'der' }, a.signature));

  // Negative control: a different challenge must not verify.
  await assert.rejects(verifyAuthenticationResponse({
    response: {
      id: passkey.credentialId, rawId: passkey.credentialId, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: toB64url(clientDataJSON), authenticatorData: toB64url(a.authenticatorData),
        signature: toB64url(a.signature), userHandle: toB64url(a.userHandle),
      },
    },
    expectedChallenge: toB64url(rand(32)), expectedOrigin: ORIGIN, expectedRPID: RP_ID,
    credential: { id: passkey.credentialId, publicKey: reg.cred.cosePublicKey, counter: 0 },
  }));
  await assert.rejects(getAssertion({ passkey, rpId: 'other.com', clientDataHash }));
});

test('rawSignatureToDer handles high bits and leading zeros', () => {
  const r = new Uint8Array(32).fill(0x80);
  const s = new Uint8Array(32); s[31] = 5;
  const der = rawSignatureToDer(concat(r, s));
  assert.deepEqual([...der.subarray(0, 5)], [0x30, 33 + 2 + 1 + 2, 0x02, 33, 0x00]);
  assert.deepEqual([...der.subarray(der.length - 3)], [0x02, 1, 5]);
  const zero = rawSignatureToDer(new Uint8Array(64));
  assert.deepEqual([...zero], [0x30, 6, 0x02, 1, 0, 0x02, 1, 0]);
  assert.throws(() => rawSignatureToDer(new Uint8Array(63)));
});

// ---------------------------------------------------------------------------
// background/passkey-service.js with fake chrome + vault
// ---------------------------------------------------------------------------

function makeChrome() {
  const on = { windowRemoved: [], tabRemoved: [], connect: [] };
  let nextWindowId = 100;
  const chrome = {
    created: [],
    removed: [],
    runtime: {
      id: 'akari',
      getURL: (p) => 'chrome-extension://akari/' + p,
      onConnect: { addListener: (f) => on.connect.push(f) },
    },
    windows: {
      create: async (opts) => { const w = { id: nextWindowId++, ...opts }; chrome.created.push(w); return w; },
      get: async (id) => ({ id, left: 0, top: 0, width: 1200, height: 800 }),
      remove: async (id) => { chrome.removed.push(id); },
      onRemoved: { addListener: (f) => on.windowRemoved.push(f) },
    },
    tabs: { onRemoved: { addListener: (f) => on.tabRemoved.push(f) } },
    closeWindow: (id) => on.windowRemoved.forEach((f) => f(id)),
  };
  return chrome;
}

function makeVault({ locked = false, items = [] } = {}) {
  let state = {
    vaults: [{ id: 'personal', name: '個人', hue: 55 }, { id: 'work', name: '仕事', hue: 255 }],
    items,
  };
  let isLocked = locked;
  const unlockCbs = [];
  let seq = 0;
  return {
    get data() { return state; },
    unlock() { isLocked = false; unlockCbs.forEach((f) => f()); },
    lock() { isLocked = true; },
    isLocked: async () => isLocked,
    readData: async () => {
      if (isLocked) throw Object.assign(new Error('locked'), { code: 'LOCKED' });
      return structuredClone(state);
    },
    mutateData: async (fn) => {
      if (isLocked) throw Object.assign(new Error('locked'), { code: 'LOCKED' });
      const draft = structuredClone(state);
      const r = await fn(draft);
      state = draft;
      return r;
    },
    makeItem: (p) => ({
      id: 'item-' + ++seq, type: 'login', title: '', url: '', username: '', password: '', totp: null, note: '',
      fav: false, hue: 30, passkeys: [], createdAt: 1, updatedAt: 1, passwordUpdatedAt: null, lastUsedAt: null, ...p,
    }),
    onUnlocked: (cb) => unlockCbs.push(cb),
    touchActivity: () => {},
    verifyMasterPassword: async (pw) => pw === 'pw',
  };
}

const contentSender = (over = {}) => ({
  id: 'akari', frameId: 0, origin: ORIGIN, url: ORIGIN + '/login', tab: { id: 7, windowId: 1 }, ...over,
});
const windowSender = (win) => ({
  id: 'akari', url: 'chrome-extension://akari/src/passkey/passkey.html?req=x', tab: { id: 50, windowId: win.id },
});

function createOptions(over = {}) {
  return {
    rp: { id: RP_ID, name: 'Example' },
    user: { id: toB64url(utf8('user-1')), name: 'alice@example.com', displayName: 'Alice' },
    challenge: toB64url(rand(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { credProps: true },
    ...over,
  };
}

/** A create() while locked: the consent window opens, then the user unlocks Akari in it. */
async function createInWindow(svc, chrome, vault, msg, count) {
  vault.lock();
  const p = svc.handleCreate(msg, contentSender());
  const w = await nextWindow(chrome, count);
  vault.unlock();
  return { p, ...w };
}

async function nextWindow(chrome, count) {
  for (let i = 0; i < 100 && chrome.created.length < count; i++) await new Promise((r) => setImmediate(r));
  assert.equal(chrome.created.length, count, 'consent window should open');
  const win = chrome.created[count - 1];
  return { win, reqId: new URL(win.url).searchParams.get('req') };
}

const rejectsWith = (promise, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });

test('service: request validation', async () => {
  const chrome = makeChrome();
  const svc = createPasskeyService({ chrome, vault: makeVault() });

  await rejectsWith(svc.handleCreate({ options: createOptions({ rp: { id: 'evil.com', name: 'x' } }) }, contentSender()), 'SECURITY');
  await rejectsWith(svc.handleCreate({ options: createOptions({ rp: { id: 'com', name: 'x' } }) }, contentSender()), 'SECURITY');
  await rejectsWith(svc.handleCreate({ options: createOptions({ rp: { name: 'x' } }) },
    contentSender({ origin: 'http://example.com', url: 'http://example.com/' })), 'SECURITY');
  await rejectsWith(svc.handleCreate({ options: createOptions() }, contentSender({ frameId: 3 })), 'SECURITY');
  await rejectsWith(svc.handleCreate({ options: createOptions() }, contentSender({ origin: 'null' })), 'SECURITY');
  await rejectsWith(svc.handleGet({ options: { challenge: 'AQID', rpId: 'evil.com' } }, contentSender()), 'SECURITY');
  await rejectsWith(svc.handleCreate({ options: createOptions({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }) }, contentSender()), 'FALLBACK');
  await rejectsWith(svc.handleCreate({ options: createOptions({ user: { id: toB64url(rand(65)), name: 'a' } }) }, contentSender()), 'INVALID');
  await rejectsWith(svc.handleCreate({ options: createOptions({ challenge: toB64url(rand(1025)) }) }, contentSender()), 'INVALID');
  await rejectsWith(svc.handleCreate({ options: createOptions({ challenge: undefined }) }, contentSender()), 'INVALID');
  await rejectsWith(svc.handleGet({ options: { challenge: 'AQID' }, mediation: 'conditional' }, contentSender()), 'FALLBACK');
  await rejectsWith(svc.handleCreate({ options: createOptions(), mediation: 'conditional' }, contentSender()), 'FALLBACK');
  await rejectsWith(svc.handleCreate({ options: createOptions({ authenticatorSelection: { authenticatorAttachment: 'cross-platform' } }) }, contentSender()), 'FALLBACK');
  await rejectsWith(svc.handleGet({ options: { challenge: 'AQID' } }, contentSender()), 'FALLBACK'); // unlocked, nothing stored
  assert.equal(chrome.created.length, 0, 'no window for rejected requests');
});

test('service: excludeCredentials match answers only after the user acts (card or window)', async () => {
  const chrome = makeChrome();
  const credentialId = toB64url(rand(32));
  const vault = makeVault({
    items: [{ id: 'i1', type: 'login', vault: 'personal', title: 'example', url: ORIGIN, username: 'alice@example.com',
      passkeys: [{ credentialId, rpId: RP_ID, userHandle: 'dXNlci0x', privateKey: 'x', publicKey: 'x', alg: -7 }] }],
  });
  const svc = createPasskeyService({ chrome, vault });
  const options = () => createOptions({ excludeCredentials: [{ type: 'public-key', id: credentialId }] });

  // Unlocked: the card is told (the page is not), and saving anyway is refused.
  const { inline } = await svc.handleCreate({ options: options() }, contentSender());
  assert.equal(inline.excluded, true);
  await rejectsWith(svc.handleSave({ options: options() }, contentSender()), 'INVALID_STATE');

  // Locked: confirming the "already saved" notice in the window -> InvalidStateError (no master password needed).
  let settled = false;
  const w1 = await createInWindow(svc, chrome, vault, { options: options() }, 1);
  w1.p.catch(() => {}).finally(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'no answer before the user acts');
  const info = await svc.handleRequest({ reqId: w1.reqId }, windowSender(w1.win));
  assert.equal(info.excluded, true);
  await svc.handleRespond({ reqId: w1.reqId, approve: true }, windowSender(w1.win));
  await rejectsWith(w1.p, 'INVALID_STATE');

  // Cancelling -> NotAllowedError, so a refusal reveals nothing.
  const w2 = await createInWindow(svc, chrome, vault, { options: options() }, 2);
  await svc.handleRespond({ reqId: w2.reqId, approve: false }, windowSender(w2.win));
  await rejectsWith(w2.p, 'NOT_ALLOWED');
  assert.equal(vault.data.items[0].passkeys.length, 1);
});

test('service: user verification needs the master password in this window', async () => {
  const chrome = makeChrome();
  const vault = makeVault();
  const svc = createPasskeyService({ chrome, vault });

  // 'preferred' without proof: approved with UV=0.
  const preferred = createOptions({ authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } });
  const { p: p1, ...w1 } = await createInWindow(svc, chrome, vault, { options: preferred }, 1);
  const info1 = await svc.handleRequest({ reqId: w1.reqId }, windowSender(w1.win));
  assert.equal(info1.uv, 'preferred');
  assert.equal(info1.verified, false);
  await svc.handleRespond({ reqId: w1.reqId, approve: true }, windowSender(w1.win));
  const { credential: c1 } = await p1;
  assert.equal(fromB64url(c1.response.authenticatorData)[32], 0x59); // UP | BE | BS | AT, no UV
  await assert.rejects(verifyRegistrationResponse({
    response: c1, expectedChallenge: preferred.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
  }));
  const reg1 = await verifyRegistrationResponse({
    response: c1, expectedChallenge: preferred.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
  });
  assert.equal(reg1.verified, true);
  assert.equal(reg1.registrationInfo.userVerified, false);

  // 'required': refused until verified; a wrong password does not count.
  const required = createOptions({ user: { id: toB64url(utf8('user-2')), name: 'bob', displayName: 'Bob' } });
  const { p: p2, ...w2 } = await createInWindow(svc, chrome, vault, { options: required }, 2);
  assert.equal((await svc.handleRequest({ reqId: w2.reqId }, windowSender(w2.win))).uv, 'required');
  await rejectsWith(svc.handleRespond({ reqId: w2.reqId, approve: true }, windowSender(w2.win)), 'UV_REQUIRED');
  await rejectsWith(svc.handleVerify({ reqId: w2.reqId, masterPassword: 'wrong' }, windowSender(w2.win)), 'BAD_PASSWORD');
  await rejectsWith(svc.handleVerify({ reqId: w2.reqId, masterPassword: 'pw' }, windowSender({ id: 999 })), 'FORBIDDEN');
  await rejectsWith(svc.handleRespond({ reqId: w2.reqId, approve: true }, windowSender(w2.win)), 'UV_REQUIRED');
  await svc.handleVerify({ reqId: w2.reqId, masterPassword: 'pw' }, windowSender(w2.win));
  assert.equal((await svc.handleRequest({ reqId: w2.reqId }, windowSender(w2.win))).verified, true);
  await svc.handleRespond({ reqId: w2.reqId, approve: true }, windowSender(w2.win));
  const { credential: c2 } = await p2;
  assert.equal(fromB64url(c2.response.authenticatorData)[32], 0x5d); // UP | UV | BE | BS | AT

  // Proof is per request: a later window gets no carried-over proof.
  const { p: p3, ...w3 } = await createInWindow(svc, chrome, vault,
    { options: createOptions({ user: { id: toB64url(utf8('user-3')), name: 'carol', displayName: 'Carol' } }) }, 3);
  assert.equal((await svc.handleRequest({ reqId: w3.reqId }, windowSender(w3.win))).verified, false, 'proof from an earlier request does not carry over');
  await svc.handleRespond({ reqId: w3.reqId, approve: false }, windowSender(w3.win));
  await rejectsWith(p3, 'NOT_ALLOWED');

  // A pick on the page card needs an unlocked vault, which took the master password: UV even for 'preferred' (Google).
  const getOptions = { challenge: toB64url(rand(32)), rpId: RP_ID, userVerification: 'preferred' };
  const { credential: a4 } = await svc.handleAssert({ options: getOptions, credentialId: c2.id }, contentSender());
  assert.equal(fromB64url(a4.response.authenticatorData)[32], 0x1d); // UP | UV | BE | BS
  const bobKey = vault.data.items.find((i) => i.username === 'bob').passkeys[0].publicKey;
  const auth = await verifyAuthenticationResponse({
    response: a4, expectedChallenge: getOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
    credential: { id: c2.id, publicKey: fromB64url(bobKey), counter: 0 },
    requireUserVerification: true,
  });
  assert.equal(auth.verified, true);

  // Saving on the page card is verified the same way, whatever the site asked for.
  for (const userVerification of ['preferred', 'discouraged']) {
    const o = createOptions({
      user: { id: toB64url(utf8('card-' + userVerification)), name: userVerification, displayName: '' },
      authenticatorSelection: { residentKey: 'required', userVerification },
    });
    const { credential } = await svc.handleSave({ options: o }, contentSender());
    assert.equal(fromB64url(credential.response.authenticatorData)[32], 0x5d); // UP | UV | BE | BS | AT
  }
  assert.equal(chrome.created.length, 3, 'no window for a save on the card');
});

test('service: register on the page card, then sign in end to end', async () => {
  const chrome = makeChrome();
  const vault = makeVault();
  const svc = createPasskeyService({ chrome, vault });
  const options = createOptions();

  // Unlocked: no window; the card gets what to show, nothing secret.
  const { inline: info } = await svc.handleCreate({ options, requestId: 'r1' }, contentSender());
  assert.deepEqual(info, {
    rpId: RP_ID,
    rpName: 'Example',
    user: { name: 'alice@example.com', displayName: 'Alice' },
    vaults: [{ id: 'personal', name: '個人', hue: 55 }, { id: 'work', name: '仕事', hue: 255 }],
    excluded: false,
    defaultVault: 'personal',
  });
  assert.equal(svc.pending.size, 0, 'nothing waits on the card');

  // The save from the card is checked like the request itself.
  await rejectsWith(svc.handleSave({ options: createOptions({ rp: { id: 'evil.com', name: 'x' } }) }, contentSender()), 'SECURITY');
  await rejectsWith(svc.handleSave({ options }, contentSender({ frameId: 2 })), 'SECURITY');
  await rejectsWith(svc.handleSave({ options }, contentSender({ origin: 'https://other.example.org', url: 'https://other.example.org/' })), 'SECURITY');
  await rejectsWith(svc.handleSave({ options: createOptions({ challenge: undefined }) }, contentSender()), 'INVALID');
  assert.equal(vault.data.items.length, 0);

  const { credential } = await svc.handleSave({ options, vault: 'work', requestId: 'r1' }, contentSender());
  assert.deepEqual(credential.clientExtensionResults, { credProps: { rk: true } });
  assert.equal(credential.authenticatorAttachment, 'platform');
  const reg = await verifyRegistrationResponse({
    response: credential, expectedChallenge: options.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true,
  });
  assert.equal(reg.verified, true);

  const items = vault.data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].vault, 'work');
  assert.equal(items[0].username, 'alice@example.com');
  assert.equal(items[0].url, ORIGIN);
  assert.equal(items[0].passkeys.length, 1);
  assert.equal(items[0].passkeys[0].credentialId, credential.id);
  assert.equal(items[0].passkeys[0].userHandle, options.user.id);

  // Registering again for the same user replaces the passkey on the same item.
  const again = createOptions();
  assert.equal((await svc.handleCreate({ options: again }, contentSender())).inline.defaultVault, 'work', 'offered where the login is');
  const { credential: credential2 } = await svc.handleSave({ options: again, vault: 'work' }, contentSender());
  assert.equal(vault.data.items.length, 1);
  assert.equal(vault.data.items[0].passkeys.length, 1);
  assert.equal(vault.data.items[0].passkeys[0].credentialId, credential2.id);

  // Sign in while unlocked: no window, the page card lists the passkeys and signs the user's pick.
  const getOptions = { challenge: toB64url(rand(32)), rpId: RP_ID, allowCredentials: [], userVerification: 'required' };
  for (const mediation of [undefined, 'conditional']) {
    const { inline } = await svc.handleGet({ options: getOptions, mediation }, contentSender());
    assert.equal(inline.rpId, RP_ID);
    assert.equal(inline.candidates.length, 1);
    assert.equal(inline.candidates[0].credentialId, credential2.id);
    assert.equal(inline.candidates[0].userName, 'alice@example.com');
    assert.equal(inline.candidates[0].vaultName, '仕事');
    assert.ok(!JSON.stringify(inline).includes('privateKey'));
  }
  assert.equal(chrome.created.length, 0, 'no window while unlocked');
  assert.ok(!JSON.stringify(info).includes('privateKey'));
  await rejectsWith(svc.handleGet({ options: getOptions, mediation: 'silent' }, contentSender()), 'FALLBACK');

  await rejectsWith(svc.handleAssert({ options: getOptions, credentialId: 'nope' }, contentSender()), 'INVALID');
  await rejectsWith(svc.handleAssert({ options: { ...getOptions, rpId: 'evil.com' }, credentialId: credential2.id }, contentSender()), 'SECURITY');
  await rejectsWith(svc.handleAssert({ options: getOptions, credentialId: credential2.id }, contentSender({ frameId: 2 })), 'SECURITY');
  await rejectsWith(svc.handleAssert({ options: getOptions, credentialId: credential2.id },
    contentSender({ origin: 'https://other.example.org', url: 'https://other.example.org/' })), 'SECURITY');
  const { credential: assertion } = await svc.handleAssert({ options: getOptions, credentialId: credential2.id }, contentSender());
  const stored = vault.data.items[0].passkeys[0];
  const auth = await verifyAuthenticationResponse({
    response: assertion, expectedChallenge: getOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
    credential: { id: stored.credentialId, publicKey: fromB64url(stored.publicKey), counter: 0 },
    requireUserVerification: true,
  });
  assert.equal(auth.verified, true);
  assert.equal(assertion.response.userHandle, options.user.id);
  assert.ok(vault.data.items[0].passkeys[0].lastUsedAt > 0);
  assert.ok(vault.data.items[0].lastUsedAt > 0);
  assert.equal(svc.pending.size, 0);
});

test('service: locked vault opens the window, which lists after unlock', async () => {
  const chrome = makeChrome();
  const credentialId = toB64url(rand(32));
  const vault = makeVault({
    locked: true,
    items: [{ id: 'i1', type: 'login', vault: 'personal', title: 'example', url: ORIGIN, username: 'bob',
      passkeys: [{ credentialId, rpId: RP_ID, userHandle: 'Ym9i', userName: 'bob', userDisplayName: 'Bob',
        privateKey: 'secret', publicKey: 'x', alg: -7, createdAt: 5, lastUsedAt: null }] }],
  });
  const svc = createPasskeyService({ chrome, vault });
  // While locked nothing is known about this site's passkeys: autofill stays with the browser,
  // and the page card cannot sign.
  await rejectsWith(svc.handleGet({ options: { challenge: 'AQID' }, mediation: 'conditional' }, contentSender()), 'FALLBACK');
  await rejectsWith(svc.handleAssert({ options: { challenge: 'AQID' }, credentialId }, contentSender()), 'LOCKED');
  await rejectsWith(svc.handleSave({ options: createOptions() }, contentSender()), 'LOCKED');
  assert.equal(chrome.created.length, 0);
  const pGet = svc.handleGet({ options: { challenge: 'AQID' } }, contentSender());
  const { win, reqId } = await nextWindow(chrome, 1);
  const before = await svc.handleRequest({ reqId }, windowSender(win));
  assert.equal(before.locked, true);
  assert.deepEqual(before.candidates, []);
  await rejectsWith(svc.handleRespond({ reqId, approve: true, credentialId }, windowSender(win)), 'LOCKED');
  vault.unlock();
  const after = await svc.handleRequest({ reqId }, windowSender(win));
  assert.equal(after.locked, false);
  assert.equal(after.candidates.length, 1);
  assert.equal(after.candidates[0].itemTitle, 'example');
  assert.ok(!JSON.stringify(after).includes('secret'));
  await svc.handleRespond({ reqId, fallback: true }, windowSender(win));
  await rejectsWith(pGet, 'FALLBACK');
});

test('service: cancellation paths', async (t) => {
  const chrome = makeChrome();
  const svc = createPasskeyService({ chrome, vault: makeVault({ locked: true }) }); // locked: requests open the window

  // Closing the window.
  const p1 = svc.handleCreate({ options: createOptions() }, contentSender());
  const w1 = await nextWindow(chrome, 1);
  chrome.closeWindow(w1.win.id);
  await rejectsWith(p1, 'NOT_ALLOWED');

  // Cancel button.
  const p2 = svc.handleCreate({ options: createOptions() }, contentSender());
  const w2 = await nextWindow(chrome, 2);
  await svc.handleRespond({ reqId: w2.reqId, approve: false }, windowSender(w2.win));
  await rejectsWith(p2, 'NOT_ALLOWED');
  await rejectsWith(svc.handleRequest({ reqId: w2.reqId }, windowSender(w2.win)), 'NOT_FOUND');

  // A second request from the same tab replaces the first.
  const p3 = svc.handleCreate({ options: createOptions() }, contentSender());
  await nextWindow(chrome, 3);
  const p4 = svc.handleCreate({ options: createOptions(), requestId: 'abc' }, contentSender());
  await rejectsWith(p3, 'NOT_ALLOWED');
  await nextWindow(chrome, 4);

  // AbortSignal from the page (via the bridge).
  svc.handleCancel({ requestId: 'abc' }, contentSender({ tab: { id: 8 } })); // other tab: ignored
  assert.equal(svc.pending.size, 1);
  svc.handleCancel({ requestId: 'abc' }, contentSender());
  await rejectsWith(p4, 'NOT_ALLOWED');

  // Timeout is clamped to at least 30 s.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p5 = svc.handleCreate({ options: createOptions({ timeout: 1000 }) }, contentSender());
  await nextWindow(chrome, 5);
  t.mock.timers.tick(29_000);
  assert.equal(svc.pending.size, 1);
  t.mock.timers.tick(1_000);
  await rejectsWith(p5, 'NOT_ALLOWED');
  assert.equal(svc.pending.size, 0);
});

test('service: localhost over http is allowed', async () => {
  const chrome = makeChrome();
  const svc = createPasskeyService({ chrome, vault: makeVault() });
  const sender = contentSender({ origin: 'http://localhost:8787', url: 'http://localhost:8787/' });
  const options = createOptions({ rp: { name: 'Local' } });
  const { inline } = await svc.handleCreate({ options }, sender);
  assert.equal(inline.rpId, 'localhost');
  const { credential } = await svc.handleSave({ options }, sender);
  const clientData = JSON.parse(new TextDecoder().decode(fromB64url(credential.response.clientDataJSON)));
  assert.equal(clientData.origin, 'http://localhost:8787');
  assert.equal(clientData.type, 'webauthn.create');
});
