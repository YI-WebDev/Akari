import { ERR } from '../shared/messages.js';
import { AkariError } from '../shared/errors.js';

const handlers = new Map();

export function register(type, handler, { from }) {
  if (handlers.has(type)) throw new Error('Duplicate handler: ' + type);
  if (from !== 'extension' && from !== 'content') throw new Error('register: bad "from" for ' + type);
  handlers.set(type, { handler, from });
}

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
    return true;
  });
}
