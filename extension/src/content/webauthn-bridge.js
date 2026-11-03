// Akari WebAuthn bridge (ISOLATED world, top frame). Classic script, self-contained.
// Relays requests from webauthn-page.js (MAIN world) to the service worker and
// the answers back. The service worker derives the origin from the sender, so
// nothing the page claims about its origin is trusted.
(() => {
  'use strict';

  const TAG = 'webauthn';
  const TO_EXT = 'page→ext';
  const TO_PAGE = 'ext→page';
  const ORIGIN = location.origin;
  // Codes the page maps to DOMExceptions; anything else lets the browser handle the request.
  const PASS_THROUGH = new Set(['NOT_ALLOWED', 'FALLBACK', 'INVALID_STATE', 'SECURITY', 'NOT_SUPPORTED', 'INVALID']);
  const TYPES = { create: 'passkey/create', get: 'passkey/get' };

  if (ORIGIN === 'null' || window.top !== window) return;

  const reply = (id, body) => window.postMessage({ __akari: TAG, dir: TO_PAGE, id, ...body }, ORIGIN);

  async function send(message) {
    // Throws "Extension context invalidated" after the extension reloads.
    if (!chrome.runtime?.id) throw new Error('context invalidated');
    return chrome.runtime.sendMessage(message);
  }

  async function forward(d) {
    let res;
    try {
      res = await send({ type: TYPES[d.action], options: d.options, mediation: d.mediation, requestId: d.id });
    } catch {
      reply(d.id, { ok: false, code: 'FALLBACK' });
      return;
    }
    if (res && res.ok && res.data && res.data.credential) {
      reply(d.id, { ok: true, credential: res.data.credential });
      return;
    }
    const code = res && res.error && res.error.code;
    reply(d.id, { ok: false, code: PASS_THROUGH.has(code) ? code : 'FALLBACK' });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.__akari !== TAG || d.dir !== TO_EXT) return;
    if (typeof d.id !== 'string' || d.id.length > 64) return;
    if (d.action === 'cancel') {
      send({ type: 'passkey/cancel', requestId: d.id }).catch(() => {});
      return;
    }
    if (!TYPES[d.action]) return;
    forward(d);
  });
})();
