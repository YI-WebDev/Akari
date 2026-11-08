import { AkariError } from './errors.js';

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
