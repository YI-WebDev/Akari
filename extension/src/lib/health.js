// Password health (パスワード診断): which logins need a new password, and which lack a second
// factor. Pure: runs in the popup and in Node tests. Only logins with a password are judged.
//
//   weak    the password is easy to guess (strength level 0–1, the same rule as the list's red dot)
//   reused  another login has the same password
//   old     the password has not changed for OLD_AFTER_DAYS (passwordUpdatedAt, else createdAt)
//   no2fa   neither a TOTP secret nor a passkey is stored for the login
//
// weak / reused / old "need action" (a new password fixes them); no2fa is advice only, since
// many sites offer no second factor.

import { estimateStrength } from './strength.js';

export const ISSUES = Object.freeze(['weak', 'reused', 'old', 'no2fa']);
export const ACTION_ISSUES = Object.freeze(['weak', 'reused', 'old']);
export const OLD_AFTER_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const judged = (it) => it && it.type === 'login' && typeof it.password === 'string' && it.password !== '';

/** When the login's password was last set, or null when unknown. */
export function passwordSetAt(it) {
  const t = Number.isFinite(it?.passwordUpdatedAt) ? it.passwordUpdatedAt : it?.createdAt;
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * @param {object[]} items decrypted items (any type)
 * @param {{ now?: number, strength?: (pw: string) => { level: number }, oldAfterDays?: number }} [opts]
 *   `strength` lets the popup pass its cached estimator.
 * @returns {{
 *   logins: number,                     logins that have a password
 *   needsAction: number,                logins with weak, reused or old
 *   counts: Record<string, number>,     logins per issue
 *   issues: Map<string, string[]>,      item id → its issues, in ISSUES order (only items with any)
 *   reuse: Map<string, number>,         item id → how many *other* logins share its password
 * }}
 */
export function passwordHealth(items, { now = Date.now(), strength = estimateStrength, oldAfterDays = OLD_AFTER_DAYS } = {}) {
  const logins = (Array.isArray(items) ? items : []).filter(judged);
  const sharing = new Map();
  for (const it of logins) sharing.set(it.password, (sharing.get(it.password) || 0) + 1);
  const counts = Object.fromEntries(ISSUES.map((k) => [k, 0]));
  const issues = new Map();
  const reuse = new Map();
  let needsAction = 0;
  for (const it of logins) {
    const others = sharing.get(it.password) - 1;
    const setAt = passwordSetAt(it);
    const found = [];
    if (strength(it.password).level <= 1) found.push('weak');
    if (others > 0) found.push('reused');
    if (setAt != null && now - setAt >= oldAfterDays * DAY_MS) found.push('old');
    if (!it.totp?.secret && !(Array.isArray(it.passkeys) && it.passkeys.length)) found.push('no2fa');
    if (others > 0) reuse.set(it.id, others);
    if (!found.length) continue;
    issues.set(it.id, found);
    for (const k of found) counts[k]++;
    if (found.some((k) => ACTION_ISSUES.includes(k))) needsAction++;
  }
  return { logins: logins.length, needsAction, counts, issues, reuse };
}

/** The issue a login is listed under: the first of its issues (weak before reused before old …). */
export const primaryIssue = (list) => (list && list.length ? list[0] : null);

/** Whole days since the password was set (for "最後の変更から N 日"), or null. */
export function passwordAgeDays(it, now = Date.now()) {
  const t = passwordSetAt(it);
  return t == null ? null : Math.max(0, Math.floor((now - t) / DAY_MS));
}
