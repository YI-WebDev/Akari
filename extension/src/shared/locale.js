import { registerLocale, setLocale, resolveLocale, translateDom, getLocale } from './i18n.js';
import en from './locales/en.js';

registerLocale('en', en);

export function useLanguage(pref, root = document.body) {
  setLocale(resolveLocale(pref));
  document.documentElement.lang = getLocale();
  translateDom(root);
}
