// Clears the clipboard some seconds after an extension page copied a secret.
// The SW has no DOM, so the actual clearing happens in an offscreen document.
// chrome.alarms may clamp delays to >= 30 s, so a setTimeout also covers short
// delays while the SW is alive; the alarm covers a SW that was shut down.

import { register, AkariError } from './router.js';
import { ERR, MSG } from '../shared/messages.js';
import { getSettings } from './vault-service.js';

export const CLIPBOARD_ALARM = 'akari-clipboard';
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const MAX_SECONDS = 3600;

export function createClipboardService({
  chrome,
  getSettings,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let tail = Promise.resolve();

  async function scheduleClear(msg = {}) {
    let seconds = msg.seconds;
    if (seconds == null) seconds = (await getSettings()).clipboardClearSeconds;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) throw new AkariError(ERR.INVALID, 'Invalid seconds');
    if (seconds === 0) return {};
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      clearNow().catch((e) => console.warn('[akari] clipboard clear failed', e?.message));
    }, seconds * 1000);
    await chrome.alarms.create(CLIPBOARD_ALARM, { when: now() + seconds * 1000 });
    return {};
  }

  async function ensureOffscreen() {
    const url = chrome.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['CLIPBOARD'],
      justification: 'クリップボードからコピーした秘密を消去する',
    });
  }

  async function doClear() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    await chrome.alarms.clear(CLIPBOARD_ALARM);
    await ensureOffscreen();
    try {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen/clearClipboard' });
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }

  // Serialized: the timer and the alarm may both fire, and there is only one offscreen document.
  function clearNow() {
    const run = tail.then(doClear);
    tail = run.catch(() => {});
    return run;
  }

  function onAlarm(alarm) {
    if (alarm?.name !== CLIPBOARD_ALARM) return undefined;
    return clearNow().catch((e) => console.warn('[akari] clipboard clear failed', e?.message));
  }

  return { scheduleClear, clearNow, onAlarm };
}

if (globalThis.chrome?.alarms) {
  const service = createClipboardService({ chrome: globalThis.chrome, getSettings });
  register(MSG.CLIPBOARD_SCHEDULE_CLEAR, (msg) => service.scheduleClear(msg), { from: 'extension' });
  globalThis.chrome.alarms.onAlarm.addListener(service.onAlarm);
}
