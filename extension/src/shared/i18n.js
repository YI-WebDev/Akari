// Minimal i18n so the UI language can become a setting later.
// Japanese is the source language: call sites pass the Japanese text as the fallback,
// and a locale dictionary (e.g. locales/en.js registered with registerLocale) overrides it.
// Stored data never contains UI text — only ids (type ids, field keys, option ids).

const DICTS = { ja: {} };
let current = 'ja';
const listeners = new Set();

export const DEFAULT_LOCALE = 'ja';
export const supportedLocales = () => Object.keys(DICTS);
export const getLocale = () => current;

export function registerLocale(id, dict) {
  DICTS[id] = { ...(DICTS[id] || {}), ...dict };
}

export function setLocale(id) {
  if (!DICTS[id] || id === current) return;
  current = id;
  for (const fn of listeners) fn(id);
}

/** @returns {() => void} unsubscribe */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate `key`, falling back to `fallback` (the Japanese source text) and then the key.
 * `{name}` placeholders are filled from `params`.
 */
export function t(key, params = null, fallback = key) {
  let s = DICTS[current]?.[key] ?? DICTS.ja[key] ?? fallback;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
  return s;
}
