// English for the passkey strings. Keys are the Japanese source text (or a dotted key used
// with a Japanese fallback); values are the English. Japanese needs no entry.

export default {
  // ---- passkey window: passkey.html (static text, translated by translateDom) ----
  'Akari パスキー': 'Akari passkey',
  '読み込み中': 'Loading',
  '読み込み中…': 'Loading…',
  'Akari はロックされています': 'Akari is locked',
  'マスターパスワード': 'Master password',
  '解除': 'Unlock',
  '解除 ⏎': 'Unlock ⏎',
  'キャンセル (esc)': 'Cancel (esc)',
  'キャンセル': 'Cancel',
  'ブラウザの標準の画面で続ける': 'Use the browser',
  'パスキーを保存': 'Save passkey',
  'このサイトへのサインインに使うパスキーを Akari に保存します': 'Save a passkey for signing in to this site in Akari',
  'サイト': 'Site',
  'アカウント': 'Account',
  '保存先': 'Save to',
  '保存先の保管庫': 'Vault to save to',
  'このアカウントのパスキーは、すでに Akari に保存されています。': 'A passkey for this account is already saved in Akari.',
  '本人確認のため、マスターパスワードを入力してください': 'Enter your master password to confirm it is you',
  '本人確認のためのマスターパスワード': 'Master password to confirm it is you',
  '保存する': 'Save',
  'パスキーでサインイン': 'Sign in with a passkey',
  'サインイン': 'Sign in',
  '0 件': '0 items',
  'パスキーが見つかりません': 'No passkey found',
  '— 終了 —': '— Ended —',
  'リクエストは終了しました': 'The request has ended',
  'サイト側で取り消されたか、時間切れになりました。このウィンドウは閉じてかまいません。':
    'The site cancelled it, or it timed out. You can close this window.',
  '閉じる': 'Close',

  // ---- passkey window: passkey.js ----
  'たった今': 'just now',
  '{n}分前': '{n} min ago',
  '{n}時間前': '{n} h ago',
  '{n}日前': '{n} d ago',
  'Akari をひらく': 'Open Akari',
  'パスワードを入力してください': 'Enter your password',
  'パスワードが違います': 'Wrong password',
  '確認できませんでした': 'Could not verify',
  '{site} のパスキーを保存するには、マスターパスワードを入力してください': 'Enter your master password to save a passkey for {site}',
  '{site} にサインインするには、マスターパスワードを入力してください': 'Enter your master password to sign in to {site}',
  '（名前なし）': '(no name)',
  '最終使用 {when}': 'Last used {when}',
  '未使用': 'Never used',
  '{n} 件': '{n} items',
  '{site} に使うアカウントを選んでください': 'Choose the account to use for {site}',
  '{site} のパスキーは Akari に保存されていません': 'No passkey for {site} is saved in Akari',
  'Akari から返事がありませんでした。もう一度押してください': 'Akari did not respond. Try again.',
  'アカウントを選んでください': 'Choose an account',
  '鍵を準備しています…': 'Preparing keys…',
  '保管庫を解除': 'Unlock vault',
  '本人確認': 'Verify user',
  'Akari のセットアップがまだ済んでいません': 'Akari is not set up yet',
  '解除できませんでした。もう一度入力してください': 'Could not unlock. Enter it again.',

  // ---- lib/strength.js: strength labels ----
  '弱い': 'Weak',
  '普通': 'Fair',
  '強い': 'Strong',
  '非常に強い': 'Very strong',

  // ---- lib/totp.js: errors shown in the item editor ----
  '秘密鍵に使えない文字が含まれています': 'The secret has characters that are not allowed',
  '未対応のアルゴリズムです: {name}': 'Unsupported algorithm: {name}',
  'otpauth:// から始まる URI ではありません': 'Not an otpauth:// URI',
  'カウンター方式（HOTP）には対応していません': 'Counter-based codes (HOTP) are not supported',
  '時間ベース（TOTP）の URI ではありません': 'Not a time-based (TOTP) URI',
  'URI に秘密鍵（secret）が含まれていません': 'The URI has no secret',
  '秘密鍵の形式が正しくありません': 'Invalid secret',
  '桁数は 6 または 8 のみ対応しています': 'Only 6 or 8 digits are supported',
  '更新間隔（period）は 1〜300 秒のみ対応しています': 'Only a period of 1–300 seconds is supported',

  // ---- lib/pgp.js: errors shown on the import page ----
  'PGP で暗号化されたファイルです。パスフレーズを入力してください': 'This file is PGP encrypted. Enter its passphrase.',
  'PGP のファイルとして読めませんでした': 'Could not read this as a PGP file',
  '公開鍵で暗号化されたファイルには対応していません。パスフレーズ（共通鍵）で暗号化して書き出してください':
    'Files encrypted with a public key are not supported. Export it encrypted with a passphrase (symmetric key) instead.',
  'パスフレーズで暗号化された PGP メッセージではありません': 'Not a passphrase-encrypted PGP message',
  'パスフレーズ用の鍵パケットが多すぎるファイルには対応していません': 'Files with too many passphrase key packets are not supported',
  'Argon2 の設定（計算回数・メモリー）が大きすぎるファイルには対応していません':
    'Files whose Argon2 settings (passes, memory) are too large are not supported',
  'Argon2 で暗号化されたファイルには対応していません。別の方式で暗号化して書き出してください':
    'Files encrypted with Argon2 are not supported. Export it with another encryption method.',
  'Argon2 の計算に必要なメモリーを確保できませんでした': 'Could not get enough memory for Argon2',
  'ファイルが大きすぎます（展開後 64 MB まで）': 'The file is too large (64 MB max after decompression)',
  'このファイルの暗号化方式には対応していません': "This file's encryption method is not supported",
  'パスフレーズが違うか、ファイルが壊れています': 'Wrong passphrase, or the file is damaged',
};
