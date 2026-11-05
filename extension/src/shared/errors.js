// The one error class every context throws and catches (service worker, lib/, extension pages).
// `code` is one of ERR (shared/messages.js) or a WebAuthn code the page maps to a DOMException.

export class AkariError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AkariError';
    this.code = code;
  }
}
