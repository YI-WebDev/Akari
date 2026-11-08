(() => {
  'use strict';

  if (globalThis.__akariI18n) return;

  const EN = {
    'Akari はロックされています — ツールバーのアイコンから解除してください': 'Akari is locked — unlock it from the toolbar icon',
    'このサイトでは使えません': 'Not available on this site',
    '選択': 'Select',
    '入力': 'Fill',
    '閉じる (esc)': 'Close (esc)',
    '閉じる': 'Close',
    'パスワードを更新しますか？': 'Update the password?',
    'Akari に保存しますか？': 'Save to Akari?',
    '更新': 'Update',
    '新規': 'New',
    '保存': 'Save',
    '今回はしない': 'Not now',
    '保存しました': 'Saved',
    '保存できませんでした': 'Could not save',
    '閉じて他の方法 (esc)': 'Close and use another method (esc)',
    '閉じて他の方法': 'Close and use another method',
    'パスキーでサインイン': 'Sign in with a passkey',
    'パスキー': 'Passkey',
    '{name} でサインイン': 'Sign in as {name}',
    'サインインしました': 'Signed in',
    'サインインできませんでした': 'Could not sign in',
    'サインイン': 'Sign in',
    'パスキーを保存': 'Save passkey',
    'このアカウントのパスキーは Akari に保存済みです': 'A passkey for this account is already saved in Akari',
    '保存先の保管庫': 'Vault to save to',
    '保存先': 'Save to',
    'パスキーを保存しました': 'Passkey saved',
    'Akari が更新されました — ページを再読み込みしてください': 'Akari was updated — reload the page',
  };

  const fromBrowser = () => {
    try { return /^ja\b/i.test(chrome.i18n.getUILanguage()) ? 'ja' : 'en'; } catch { return 'ja'; }
  };
  const resolve = (pref) => (pref === 'ja' || pref === 'en' ? pref : fromBrowser());
  let lang = fromBrowser();
  let themePref = 'dark';

  try {
    chrome.runtime.sendMessage({ type: 'settings/language' })
      .then((res) => {
        if (!res?.ok) return;
        lang = resolve(res.data?.language);
        themePref = res.data?.theme;
      }, () => {});
  } catch { }

  function theme() {
    if (themePref === 'light') return 'light';
    if (themePref !== 'auto') return 'dark';
    try {
      return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  function t(text, params = null) {
    let s = lang === 'en' && Object.hasOwn(EN, text) ? EN[text] : text;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(params, k) ? String(params[k]) : m));
    return s;
  }

  globalThis.__akariI18n = Object.freeze({ t, lang: () => lang, theme });
})();
