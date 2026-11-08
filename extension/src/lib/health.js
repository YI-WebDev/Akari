import { estimateStrength } from './strength.js';

export const ISSUES = Object.freeze(['weak', 'reused', 'old', 'no2fa']);
export const ACTION_ISSUES = Object.freeze(['weak', 'reused', 'old']);
export const OLD_AFTER_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEAK_MAX_LEVEL = 1;

const judged = (it) => it && it.type === 'login' && typeof it.password === 'string' && it.password !== '';

export function passwordSetAt(it) {
  const t = Number.isFinite(it?.passwordUpdatedAt) ? it.passwordUpdatedAt : it?.createdAt;
  return Number.isFinite(t) && t > 0 ? t : null;
}

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
    if (strength(it.password).level <= WEAK_MAX_LEVEL) found.push('weak');
    if (others > 0) found.push('reused');
    if (setAt != null && now - setAt >= oldAfterDays * DAY_MS) found.push('old');
    const hasSecondFactor = !!it.totp?.secret || (Array.isArray(it.passkeys) && it.passkeys.length > 0);
    if (!hasSecondFactor) found.push('no2fa');
    if (others > 0) reuse.set(it.id, others);
    if (!found.length) continue;
    issues.set(it.id, found);
    for (const k of found) counts[k]++;
    if (found.some((k) => ACTION_ISSUES.includes(k))) needsAction++;
  }
  return { logins: logins.length, needsAction, counts, issues, reuse };
}

export const primaryIssue = (list) => (list && list.length ? list[0] : null);

export function passwordAgeDays(it, now = Date.now()) {
  const t = passwordSetAt(it);
  return t == null ? null : Math.max(0, Math.floor((now - t) / DAY_MS));
}
