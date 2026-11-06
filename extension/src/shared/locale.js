// Extension pages (popup, passkey window) pick their language here, before they build any UI:
// the 言語 setting ('auto' | 'ja' | 'en'), with 'auto' following the browser.

import { registerLocale, setLocale, resolveLocale, translateDom, getLocale } from './i18n.js';
import en from './locales/en.js';

registerLocale('en', en);

/** Switch to the locale the setting stands for and translate the page's static text. */
export function useLanguage(pref, root = document.body) {
  setLocale(resolveLocale(pref));
  document.documentElement.lang = getLocale();
  translateDom(root);
}
