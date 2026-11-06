// UI language. Japanese is the source language: call sites pass the Japanese text, either as
// the key itself — t('保存済み'), t('{n} 件', { n }) — or as the fallback of a dotted key —
// t('type.login', null, 'ログイン'). A locale dictionary (shared/locales/en.js) maps either
// form to its translation; Japanese needs no dictionary.
// Stored data never contains UI text — only ids (type ids, field keys, option ids).

const DICTS = { ja: {} };
let current = 'ja';
const listeners = new Set();

export const DEFAULT_LOCALE = 'ja';
/** The choices of the 言語 setting: 'auto' follows the browser's UI language. */
export const LANGUAGE_CHOICES = Object.freeze(['auto', 'ja', 'en']);
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

/** The browser's UI language as one of ours: Japanese for ja-*, English otherwise.
 *  Without chrome.i18n (unit tests, a page outside the extension) it is the source language. */
export function browserLocale() {
  let lang = '';
  try { lang = chrome.i18n.getUILanguage(); } catch { return DEFAULT_LOCALE; }
  if (!lang) return DEFAULT_LOCALE;
  return /^ja\b/i.test(lang) ? 'ja' : 'en';
}

/** The locale a 言語 setting ('auto' | 'ja' | 'en') stands for. */
export function resolveLocale(pref) {
  return pref === 'ja' || pref === 'en' ? pref : browserLocale();
}

/**
 * Translate `key`, falling back to `fallback` (the Japanese source text) and then the key.
 * `{name}` placeholders are filled from `params`.
 */
export function t(key, params = null, fallback = key) {
  const dict = DICTS[current];
  let s = dict?.[key] ?? (fallback !== key ? dict?.[fallback] : undefined) ?? DICTS.ja[key] ?? fallback;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
  return s;
}

const ATTRS = ['title', 'placeholder', 'aria-label'];

/**
 * Translate the static Japanese text of a page in place: text nodes and the title /
 * placeholder / aria-label attributes whose (trimmed) text is in the current dictionary.
 * Runs once at load; text built later goes through t().
 */
export function translateDom(root) {
  const dict = DICTS[current];
  if (!root || current === DEFAULT_LOCALE || !dict) return;
  const doc = root.ownerDocument || root;
  // an element whose text means something else here than elsewhere names its own key
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = dict[el.dataset.i18n];
    if (v != null) el.textContent = v;
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue;
    const text = raw.trim();
    if (!text || !Object.hasOwn(dict, text)) continue;
    n.nodeValue = raw.replace(text, dict[text]);
  }
  for (const el of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && Object.hasOwn(dict, v.trim())) el.setAttribute(a, dict[v.trim()]);
    }
  }
}
