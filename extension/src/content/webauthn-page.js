// Akari WebAuthn shim (MAIN world, top frame, document_start). Classic script, self-contained.
// navigator.credentials.create/get calls with `publicKey` go to Akari through the
// ISOLATED-world bridge (webauthn-bridge.js); anything else, and requests Akari
// declines with FALLBACK, run on the browser's own implementation.
(() => {
  'use strict';

  const CC = window.CredentialsContainer;
  const PKC = window.PublicKeyCredential;
  const AttResp = window.AuthenticatorAttestationResponse;
  const AsrResp = window.AuthenticatorAssertionResponse;
  if (!CC || !PKC || !AttResp || !AsrResp || !window.isSecureContext) return;

  // Capture everything we rely on before page scripts can patch it.
  const nativeCreate = CC.prototype.create;
  const nativeGet = CC.prototype.get;
  const DOMExc = window.DOMException;
  const TypeErr = window.TypeError;
  const postMessage = window.postMessage.bind(window);
  const addListener = window.addEventListener.bind(window);
  const getRandomValues = window.crypto.getRandomValues.bind(window.crypto);
  const { defineProperty, create: objectCreate } = Object;
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

  // ---------- bytes ----------

  function bufferSourceToB64url(src) {
    let bytes;
    if (src instanceof ArrayBufferRef) bytes = new Uint8Array(src);
    else if (isView(src)) bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    else throw new TypeErr('Expected a BufferSource');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoaRef(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlToBuffer(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atobRef(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // ---------- options → JSON-safe ----------

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

  // ---------- JSON → PublicKeyCredential-like object ----------

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
    // WebAuthn L3 RegistrationResponseJSON / AuthenticationResponseJSON.
    defineProperty(cred, 'toJSON', method(function toJSON() {
      const out = JSON.parse(JSON.stringify(json));
      if (out.response && out.response.userHandle == null) delete out.response.userHandle;
      return out;
    }));
    return cred;
  }

  // ---------- errors ----------

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

  // After Akari's window closes, Chrome refuses WebAuthn until the page has focus again.
  function whenFocused() {
    if (document.hasFocus()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { removeListener('focus', done); clearTimeoutRef(timer); resolve(); };
      const timer = setTimeoutRef(done, 3000);
      addListener('focus', done);
    });
  }

  const abortReason = (signal) => (signal.reason !== undefined ? signal.reason : new DOMExc('signal is aborted without reason', 'AbortError'));

  // ---------- bridge messaging ----------

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

  function viaAkari(kind, native, thisArg, args) {
    const options = args[0];
    const fallback = () => Reflect.apply(native, thisArg, args);
    let payload;
    try {
      payload = kind === 'create' ? serializeCreate(options.publicKey) : serializeGet(options.publicKey);
    } catch {
      return fallback(); // malformed options: let the browser raise the right error
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

  // Proxies keep name/length and give a native-looking toString().
  function wrap(kind, native) {
    return new Proxy(native, {
      apply(target, thisArg, args) {
        const options = args[0];
        if (!(thisArg instanceof CC) || !options || typeof options !== 'object' || !options.publicKey) {
          return Reflect.apply(target, thisArg, args);
        }
        return viaAkari(kind, target, thisArg, args);
      },
    });
  }

  const desc = (fn) => ({ value: fn, writable: true, enumerable: true, configurable: true });
  defineProperty(CC.prototype, 'create', desc(wrap('create', nativeCreate)));
  defineProperty(CC.prototype, 'get', desc(wrap('get', nativeGet)));
})();
