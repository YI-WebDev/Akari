// The service worker's language: what it writes in the user's language (the default vault
// names of a new vault, field labels in exports and in imported items) follows the 言語 setting.

import { registerLocale, setLocale, resolveLocale } from '../shared/i18n.js';
import en from '../shared/locales/en.js';

registerLocale('en', en);

/** @param {'auto' | 'ja' | 'en' | undefined} pref the 言語 setting */
export function applyLanguage(pref) {
  setLocale(resolveLocale(pref));
}
