import { fromB64url } from '../../shared/bytes.js';
import { AkariError } from '../../shared/errors.js';
import { ERR } from '../../shared/messages.js';

export const invalid = (message) => new AkariError(ERR.INVALID, message);
export const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const isHue = (v) => Number.isInteger(v) && v >= 0 && v <= 359;
export const isBox = (b) => isObject(b) && typeof b.iv === 'string' && typeof b.ct === 'string';

export const clampTs = (v, fallback, nowMs) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), nowMs) : fallback);

const B64URL = /^[A-Za-z0-9_-]+$/;
function b64urlLength(v) {
  if (typeof v !== 'string' || !B64URL.test(v)) return -1;
  try {
    return fromB64url(v).length;
  } catch {
    return -1;
  }
}
export const lengthIn = (v, min, max) => {
  const n = b64urlLength(v);
  return n >= min && n <= max;
};
