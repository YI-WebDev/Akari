import { DEFAULT_SETTINGS, NEVER_LOCK } from '../../shared/messages.js';
import { isObject } from './common.js';

export const SETTING_RULES = Object.freeze({
  autoLockMinutes: (v) => [NEVER_LOCK, 0, 1, 5, 15, 30, 60].includes(v),
  clipboardClearSeconds: (v) => [0, 10, 30, 60].includes(v),
  language: (v) => ['auto', 'ja', 'en'].includes(v),
  theme: (v) => ['dark', 'light', 'auto'].includes(v),
});

export function cleanSettings(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (isObject(stored)) {
    for (const [key, ok] of Object.entries(SETTING_RULES)) if (ok(stored[key])) out[key] = stored[key];
  }
  return out;
}
