import { invalid, isObject, clampTs } from './common.js';
import { FIELD_CAPS } from './items.js';

export const PASSWORD_HISTORY_MAX = 10;
const passwordOk = (v) => typeof v === 'string' && v.length >= 1 && v.length <= FIELD_CAPS.password;

function normalizeHistory(list, nowMs) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list) {
    if (out.length >= PASSWORD_HISTORY_MAX) break;
    if (!isObject(h) || !passwordOk(h.password) || out.some((x) => x.password === h.password)) continue;
    out.push({ password: h.password, changedAt: clampTs(h.changedAt, nowMs, nowMs) });
  }
  return out;
}

function normalizePending(p, nowMs) {
  return isObject(p) && passwordOk(p.password)
    ? { password: p.password, createdAt: clampTs(p.createdAt, nowMs, nowMs) }
    : null;
}

export function passwordKeys(raw, current, nowMs) {
  const history = normalizeHistory(raw.passwordHistory, nowMs).filter((h) => h.password !== current);
  const pending = normalizePending(raw.pendingPassword, nowMs);
  return {
    ...(history.length && { passwordHistory: history }),
    ...(pending && pending.password !== current && { pendingPassword: pending }),
  };
}

export function mergedHistory(incoming, existing) {
  const seen = new Set([incoming.password]);
  const replaced = existing.password && existing.password !== incoming.password
    ? [{ password: existing.password, changedAt: incoming.passwordUpdatedAt || incoming.updatedAt || 0 }] : [];
  return [...(incoming.passwordHistory || []), ...replaced, ...(existing.passwordHistory || [])]
    .filter((h) => isObject(h) && typeof h.password === 'string' && h.password && !seen.has(h.password) && seen.add(h.password))
    .sort((a, b) => (b.changedAt || 0) - (a.changedAt || 0))
    .slice(0, PASSWORD_HISTORY_MAX);
}

export function setLoginPassword(item, next, nowMs) {
  const prev = typeof item.password === 'string' ? item.password : '';
  if (item.pendingPassword?.password === next) delete item.pendingPassword;
  if (next === prev) return false;
  const rest = (Array.isArray(item.passwordHistory) ? item.passwordHistory : []).filter((h) => h.password !== prev && h.password !== next);
  const history = prev ? [{ password: prev, changedAt: nowMs }, ...rest] : rest;
  if (history.length) item.passwordHistory = history.slice(0, PASSWORD_HISTORY_MAX);
  else delete item.passwordHistory;
  item.password = next;
  item.passwordUpdatedAt = nowMs;
  return true;
}

export function setPendingPassword(item, password, nowMs) {
  if (password == null) {
    delete item.pendingPassword;
    return;
  }
  if (!passwordOk(password)) throw invalid('Invalid password');
  if (password === item.password) throw invalid('Already the current password');
  item.pendingPassword = { password, createdAt: nowMs };
}
