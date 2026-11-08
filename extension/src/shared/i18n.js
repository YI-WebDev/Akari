const DICTS = { ja: {} };
let current = 'ja';
const listeners = new Set();

export const DEFAULT_LOCALE = 'ja';
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

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function browserLocale() {
  let lang = '';
  try { lang = chrome.i18n.getUILanguage(); } catch { return DEFAULT_LOCALE; }
  if (!lang) return DEFAULT_LOCALE;
  return /^ja\b/i.test(lang) ? 'ja' : 'en';
}

export function resolveLocale(pref) {
  return pref === 'ja' || pref === 'en' ? pref : browserLocale();
}

export function t(key, params = null, fallback = key) {
  const dict = DICTS[current];
  let s = dict?.[key] ?? (fallback !== key ? dict?.[fallback] : undefined) ?? DICTS.ja[key] ?? fallback;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
  return s;
}

const TRANSLATED_ATTRIBUTES = ['title', 'placeholder', 'aria-label'];

export function translateDom(root) {
  const dict = DICTS[current];
  if (!root || current === DEFAULT_LOCALE || !dict) return;
  const doc = root.ownerDocument || root;
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
    for (const a of TRANSLATED_ATTRIBUTES) {
      const v = el.getAttribute(a);
      if (v && Object.hasOwn(dict, v.trim())) el.setAttribute(a, dict[v.trim()]);
    }
  }
}
