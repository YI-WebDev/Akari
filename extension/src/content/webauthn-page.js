(() => {
  'use strict';

  const CC = window.CredentialsContainer;
  const PKC = window.PublicKeyCredential;
  const AttResp = window.AuthenticatorAttestationResponse;
  const AsrResp = window.AuthenticatorAssertionResponse;
  if (!CC || !PKC || !AttResp || !AsrResp || !window.isSecureContext) return;

  const nativeCreate = CC.prototype.create;
  const nativeGet = CC.prototype.get;
  const DOMExc = window.DOMException;
  const TypeErr = window.TypeError;
  const postMessage = window.postMessage.bind(window);
  const addListener = window.addEventListener.bind(window);
  const getRandomValues = window.crypto.getRandomValues.bind(window.crypto);
  const { defineProperty, create: objectCreate, getOwnPropertyDescriptor } = Object;
  const WeakSetRef = window.WeakSet;
  const { has: wsHas, add: wsAdd } = WeakSetRef.prototype;
  const setTimeoutRef = window.setTimeout.bind(window);
  const clearTimeoutRef = window.clearTimeout.bind(window);
  const removeListener = window.removeEventListener.bind(window);
  const ArrayBufferRef = window.ArrayBuffer;
  const isView = ArrayBuffer.isView;
  const btoaRef = window.btoa.bind(window);
  const atobRef = window.atob.bind(window);
  const ORIGIN = location.origin;

  const TAG = 'webauthn';
  const TO_EXT = 'page→ext';
  const TO_PAGE = 'ext→page';
  const pending = new Map();
  const BYTES_PER_FROMCHARCODE_CHUNK = 0x8000;
  const FOCUS_WAIT_MS = 3000;

  function bufferSourceToB64url(src) {
    let bytes;
    if (src instanceof ArrayBufferRef) bytes = new Uint8Array(src);
    else if (isView(src)) bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    else throw new TypeErr('Expected a BufferSource');
    let s = '';
    for (let i = 0; i < bytes.length; i += BYTES_PER_FROMCHARCODE_CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + BYTES_PER_FROMCHARCODE_CHUNK));
    return btoaRef(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBuffer(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atobRef(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  const optStr = (v) => (v === undefined ? undefined : String(v));

  function descriptors(list) {
    if (list === undefined) return undefined;
    return Array.from(list, (d) => ({
      type: String(d.type),
      id: bufferSourceToB64url(d.id),
      transports: d.transports ? Array.from(d.transports, String) : undefined,
    }));
  }

  function extensions(ext) {
    if (!ext || typeof ext !== 'object') return undefined;
    return ext.credProps === true ? { credProps: true } : {};
  }

  function serializeCreate(pk) {
    const sel = pk.authenticatorSelection;
    return {
      rp: { id: optStr(pk.rp.id), name: optStr(pk.rp.name) },
      user: { id: bufferSourceToB64url(pk.user.id), name: optStr(pk.user.name), displayName: optStr(pk.user.displayName) },
      challenge: bufferSourceToB64url(pk.challenge),
      pubKeyCredParams: Array.from(pk.pubKeyCredParams, (p) => ({ type: String(p.type), alg: Number(p.alg) })),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      excludeCredentials: descriptors(pk.excludeCredentials),
      authenticatorSelection: sel ? {
        authenticatorAttachment: optStr(sel.authenticatorAttachment),
        residentKey: optStr(sel.residentKey),
        requireResidentKey: !!sel.requireResidentKey,
        userVerification: optStr(sel.userVerification),
      } : undefined,
      attestation: optStr(pk.attestation),
      extensions: extensions(pk.extensions),
    };
  }

  function serializeGet(pk) {
    return {
      challenge: bufferSourceToB64url(pk.challenge),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      rpId: optStr(pk.rpId),
      allowCredentials: descriptors(pk.allowCredentials),
      userVerification: optStr(pk.userVerification),
      extensions: extensions(pk.extensions),
    };
  }

  function own(obj, props) {
    for (const k of Object.keys(props)) {
      defineProperty(obj, k, { value: props[k], enumerable: true, configurable: true, writable: false });
    }
    return obj;
  }

  const method = (fn) => ({ value: fn, enumerable: false, configurable: true, writable: true });

  function buildCredential(kind, json) {
    const r = json.response;
    let response;
    if (kind === 'create') {
      const authData = b64urlToBuffer(r.authenticatorData);
      const publicKey = b64urlToBuffer(r.publicKey);
      const transports = Array.from(r.transports || []);
      response = own(objectCreate(AttResp.prototype), {
        clientDataJSON: b64urlToBuffer(r.clientDataJSON),
        attestationObject: b64urlToBuffer(r.attestationObject),
      });
      defineProperty(response, 'getTransports', method(function getTransports() { return transports.slice(); }));
      defineProperty(response, 'getAuthenticatorData', method(function getAuthenticatorData() { return authData.slice(0); }));
      defineProperty(response, 'getPublicKey', method(function getPublicKey() { return publicKey.slice(0); }));
      defineProperty(response, 'getPublicKeyAlgorithm', method(function getPublicKeyAlgorithm() { return r.publicKeyAlgorithm; }));
    } else {
      response = own(objectCreate(AsrResp.prototype), {
        clientDataJSON: b64urlToBuffer(r.clientDataJSON),
        authenticatorData: b64urlToBuffer(r.authenticatorData),
        signature: b64urlToBuffer(r.signature),
        userHandle: r.userHandle ? b64urlToBuffer(r.userHandle) : null,
      });
    }

    const cred = own(objectCreate(PKC.prototype), {
      id: json.id,
      rawId: b64urlToBuffer(json.rawId),
      type: 'public-key',
      authenticatorAttachment: json.authenticatorAttachment || null,
      response,
    });
    const extResults = json.clientExtensionResults || {};
    defineProperty(cred, 'getClientExtensionResults', method(function getClientExtensionResults() {
      return JSON.parse(JSON.stringify(extResults));
    }));
    defineProperty(cred, 'toJSON', method(function toJSON() {
      const out = JSON.parse(JSON.stringify(json));
      if (out.response && out.response.userHandle == null) delete out.response.userHandle;
      return out;
    }));
    return cred;
  }

  function toError(code) {
    switch (code) {
      case 'INVALID_STATE':
        return new DOMExc('The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.', 'InvalidStateError');
      case 'SECURITY':
        return new DOMExc('The relying party ID is not a registrable domain suffix of, nor equal to the current domain.', 'SecurityError');
      case 'NOT_SUPPORTED':
        return new DOMExc('The requested operation is not supported.', 'NotSupportedError');
      case 'INVALID':
        return new TypeErr('Invalid publicKey options.');
      default:
        return new DOMExc('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', 'NotAllowedError');
    }
  }

  function whenFocused() {
    if (document.hasFocus()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { removeListener('focus', done); clearTimeoutRef(timer); resolve(); };
      const timer = setTimeoutRef(done, FOCUS_WAIT_MS);
      addListener('focus', done);
    });
  }

  const abortReason = (signal) => (signal.reason !== undefined ? signal.reason : new DOMExc('signal is aborted without reason', 'AbortError'));

  addListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || d.__akari !== TAG || d.dir !== TO_PAGE || typeof d.id !== 'string') return;
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    p.cleanup();
    if (d.ok) {
      try {
        p.resolve(buildCredential(p.kind, d.credential));
      } catch {
        p.reject(toError('NOT_ALLOWED'));
      }
    } else if (d.code === 'FALLBACK') {
      p.resolve(whenFocused().then(p.fallback));
    } else {
      p.reject(toError(d.code));
    }
  });

  function newId() {
    const b = getRandomValues(new Uint8Array(12));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  const next = { create: nativeCreate, get: nativeGet };
  const declined = new WeakSetRef();

  function viaAkari(kind, thisArg, args) {
    const options = args[0];
    const fallback = () => {
      Reflect.apply(wsAdd, declined, [options]);
      return Reflect.apply(next[kind], thisArg, args);
    };
    let payload;
    try {
      payload = kind === 'create' ? serializeCreate(options.publicKey) : serializeGet(options.publicKey);
    } catch {
      return fallback();
    }
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(abortReason(signal));

    const id = newId();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        postMessage({ __akari: TAG, dir: TO_EXT, id, action: 'cancel' }, ORIGIN);
        reject(abortReason(signal));
      };
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      pending.set(id, { kind, resolve, reject, fallback, cleanup });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      postMessage({
        __akari: TAG, dir: TO_EXT, id, action: kind, options: payload,
        mediation: options.mediation === undefined ? undefined : String(options.mediation),
      }, ORIGIN);
    });
  }

  function wrap(kind, native) {
    return new Proxy(native, {
      apply(target, thisArg, args) {
        const options = args[0];
        if (!(thisArg instanceof CC) || !options || typeof options !== 'object' || !options.publicKey
          || Reflect.apply(wsHas, declined, [options])) {
          return Reflect.apply(target, thisArg, args);
        }
        return viaAkari(kind, thisArg, args);
      },
    });
  }

  const wrapped = { create: wrap('create', nativeCreate), get: wrap('get', nativeGet) };
  const desc = (fn) => ({ value: fn, writable: true, enumerable: true, configurable: true });
  defineProperty(CC.prototype, 'create', desc(wrapped.create));
  defineProperty(CC.prototype, 'get', desc(wrapped.get));

  const container = window.navigator.credentials;
  for (const kind of ['create', 'get']) {
    const own = getOwnPropertyDescriptor(container, kind);
    if (own && !own.configurable) continue;
    const prior = own && ('value' in own ? own.value : own.get && Reflect.apply(own.get, container, []));
    if (typeof prior === 'function' && prior !== wrapped[kind]) next[kind] = prior;
    defineProperty(container, kind, {
      get: () => wrapped[kind],
      set: (fn) => { if (typeof fn === 'function' && fn !== wrapped[kind]) next[kind] = fn; },
      enumerable: true,
      configurable: true,
    });
  }
})();
