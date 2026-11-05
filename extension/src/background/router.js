// Message router for the service worker. Each service module calls `register`
// at import time; sw.js calls `installRouter` once.

import { ERR } from '../shared/messages.js';
import { AkariError } from '../shared/errors.js';

const handlers = new Map();

/**
 * @param {string} type
 * @param {(msg: object, sender: chrome.runtime.MessageSender) => any} handler
 * @param {{ from: 'extension' | 'content' }} opts
 *   'extension' — only extension pages (popup, passkey window, offscreen) may call it.
 *   'content'   — only content scripts running in a tab may call it (sender.tab is set).
 */
export function register(type, handler, { from }) {
  if (handlers.has(type)) throw new Error('Duplicate handler: ' + type);
  if (from !== 'extension' && from !== 'content') throw new Error('register: bad "from" for ' + type);
  handlers.set(type, { handler, from });
}

// Extension pages opened with chrome.windows.create (the passkey window) do have
// sender.tab, so the page URL — not the presence of a tab — decides.
export function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
}

export function isContentScript(sender) {
  return sender.id === chrome.runtime.id && !!sender.tab && typeof sender.url === 'string'
    && /^https?:/.test(sender.url);
}

export function installRouter() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const entry = msg && typeof msg.type === 'string' ? handlers.get(msg.type) : null;
    if (!entry) return false;
    const allowed = entry.from === 'extension' ? isExtensionPage(sender) : isContentScript(sender);
    if (!allowed) {
      sendResponse({ ok: false, error: { code: ERR.FORBIDDEN, message: 'Sender not allowed for ' + msg.type } });
      return false;
    }
    Promise.resolve()
      .then(() => entry.handler(msg, sender))
      .then(
        (data) => sendResponse({ ok: true, data: data ?? {} }),
        (err) => {
          const code = err instanceof AkariError ? err.code : ERR.INTERNAL;
          if (code === ERR.INTERNAL) console.error('[akari]', msg.type, err);
          sendResponse({ ok: false, error: { code, message: String(err?.message || err) } });
        },
      );
    return true; // async response
  });
}
