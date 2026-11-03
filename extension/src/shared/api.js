// Client side of the message contract, for extension pages (popup, passkey window).

export class AkariError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AkariError';
    this.code = code;
  }
}

/**
 * Send a message to the service worker and unwrap the `{ ok, data | error }` envelope.
 * @param {string} type one of MSG.*
 * @param {object} [payload]
 * @returns {Promise<any>} data
 * @throws {AkariError}
 */
export async function send(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ ...payload, type });
  } catch (e) {
    throw new AkariError('INTERNAL', e && e.message);
  }
  if (!res) throw new AkariError('INTERNAL', 'No response for ' + type);
  if (!res.ok) throw new AkariError(res.error?.code || 'INTERNAL', res.error?.message);
  return res.data;
}
