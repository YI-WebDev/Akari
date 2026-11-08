import { registerLocale, setLocale, resolveLocale } from '../shared/i18n.js';
import en from '../shared/locales/en.js';

registerLocale('en', en);

export function applyLanguage(pref) {
  setLocale(resolveLocale(pref));
}
