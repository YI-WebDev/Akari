# Akari（灯）— Chrome 拡張のパスワードマネージャー

暗いところで鍵を照らす灯り。パスワード・認証コード（TOTP）・パスキーをひとつの暗号化された保管庫にまとめます。
画面は claude.ai/design の「Akari Designs」1a（Akari Terminal — 等幅・暖色ダーク）を再現しています。

## インストール（開発版）

1. Chrome で `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `extension/` フォルダを選ぶ
3. ツールバーの 灯 アイコンを開き、マスターパスワードを決める

ビルドは不要です（素の ES Modules）。

## できること

| 機能 | 内容 |
| --- | --- |
| アイテムの種類 | ログイン・セキュアノート・クレジットカード・ID のほか、テクノロジー（API認証情報・データベース・サーバー・ソフトウェアライセンス・SSHキー・WiFiネットワーク）、ファイナンス（銀行口座・暗号通貨ウォレット）、個人（運転免許証・医療記録・メンバーシップ・パスポート・報酬プログラム・社会保障）。番号やコードは伏せ字で表示・コピーでき、どの種類にも追加の項目を付けられる。カードや住所のフォーム自動入力はしない |
| 保管庫 | 個人 / 仕事 / 家族。検索（`/`）、↑↓ で選択、Enter でパスワードをコピー、すべて / 最近 / ★、新着 / A-Z |
| パスワード作成 | ランダム（8〜48 文字・大文字 / 数字 / 記号 / 紛らわしい文字を除外）と パスフレーズ（日本語ローマ字 1,454 語から 3〜8 語）。生成方式から計算した正確なエントロピーを表示 |
| 強度チェック | よくあるパスワード・並び・年号・単語＋数字などを減点。弱い・使い回しは赤い点と「強化する」 |
| 認証コード（TOTP） | 秘密鍵 / `otpauth://` URI の貼り付け、または表示中のタブの QR コードを読み取り。30 秒リングとコピー |
| パスキー | サイトの「パスキーを登録 / パスキーでサインイン」を Akari が引き受け、確認ウィンドウで承認。保存先の保管庫を選べる。「この端末のパスキーを使う」でブラウザ標準にも切り替え可 |
| 自動入力 | ポップアップの「このサイトで使える」→ 入力、入力欄の 灯 ボタンのメニュー、`Ctrl+Shift+L` |
| 保存の提案 | ログイン送信後に「Akari に保存しますか？ / パスワードを更新しますか？」 |
| インポート | 1Password（1pux / 1pif / zip）、Apple Passwords、Bitwarden（json / zip、パスワード保護 JSON）、Brave、Chrome、Dashlane（zip / csv）、Edge、Enpass、Firefox、Kaspersky（txt）、KeePass（xml）、Keeper、LastPass、NordPass、Proton Pass（zip / pgp / csv）、Roboform、Safari、汎用 CSV、PGP で暗号化されたこれらのファイル、Akari バックアップ。カード・ID・銀行口座・パスポートなどはそれぞれの種類として取り込み（対応する種類がないものはセキュアノート）、重複は飛ばします |
| エクスポート | Akari バックアップ（暗号化）、CSV（Chrome などで読める）、Bitwarden JSON（パスキーも含む）。平文の形式はマスターパスワードの再入力が必要で、PGP で暗号化して保存することもできます |
| 設定 | 自動ロック（1〜60 分 / ブラウザを閉じたとき）、クリップボード消去（10〜60 秒）、マスターパスワード変更 |

## 仕組みと安全性

- **暗号化**: マスターパスワード → PBKDF2-SHA256（600,000 回）→ 鍵暗号鍵。ランダムなデータ鍵（AES-256-GCM）を包んで保存し、保管庫全体をデータ鍵で暗号化。マスターパスワードを変えるとデータ鍵も作り直します。
- **ロック中 / 解除中**: 解除中のデータ鍵は `chrome.storage.session`（メモリのみ・拡張自身のページとサービスワーカーだけが読める）に置き、自動ロックかブラウザ終了で消えます。
- **信頼境界**: 復号済みデータはサービスワーカーと拡張ページだけが扱います。ページ側のスクリプトには「そのタブのサイトに一致する 1 件」しか渡しません。サイトの判定は公式の Public Suffix List（同梱）による登録可能ドメイン単位で、`bank.co.il` と `evil.co.il` のように別の持ち主のドメインは一致しません。
- **パスキー**: ES256、attestation `none`、`signCount` 0（同期型パスキーと同じ）。`clientDataJSON` はブラウザが報告した送信元オリジンから作り、`rpId` は公開サフィックスでない親ドメインまでに制限。サイトが本人確認（`userVerification: required`）を求めるときは、確認ウィンドウでマスターパスワードを入力したときだけ UV を立てます。秘密鍵はサービスワーカーの外に出ません。
- **自動入力の保護**: ページ読み込み時に勝手に入力しません。インラインメニューは 500 ms 以上はっきり見えている状態でないとクリックを受け付けず、透明化やおとり要素によるクリックジャッキングを拒否します。
- **外部通信なし**: フォントを含むすべてのリソースを同梱しています。拡張ページで許可しているのは自分のスクリプトと WebAssembly（PGP の Argon2 用）だけで、JavaScript の `eval` は使えません。
- **インポートとエクスポート**: 読み込むファイルはポップアップの中だけで解析し、取り込んだあとは中身をメモリから消します。平文で書き出すときはマスターパスワードを確かめ直します。

## 既知の制限

- インポート: KeePass は XML 書き出しのみ（.kdbx は不可）。Bitwarden の Argon2id で保護された JSON、パスワード付き ZIP、公開鍵で暗号化された PGP は読めません。添付ファイルと Proton Pass のパスキーは取り込みません。フォルダーは保管庫に分けず、選んだ 1 つの保管庫に入ります。

- パスキーの「自動入力 UI（conditional mediation）」と iframe 内の WebAuthn はブラウザ標準に任せています。
- 自動入力はポップアップ / ショートカットではトップフレームのみ。TOTP の自動入力はしません。
- 認証コードの `otpauth-migration://`（Google Authenticator のエクスポート）は未対応です。
- クリップボード消去は、その後に別のものをコピーしていても上書きします（読み取り権限を求めないため）。
- 同梱フォント（JetBrains Mono・M PLUS 1 Code）が約 3 MB あります（使う文字の分だけ読み込まれます）。

## 開発

```bash
npm install            # テスト用の開発依存だけ（拡張本体には不要）
npm test               # 単体テスト（暗号・保管庫・TOTP の RFC テストベクタ・パスキーの独立検証 など）
npm run e2e            # インストール済み Chrome に拡張を読み込んで実操作（保管庫・自動入力・パスキー）
node tests/ui/extension-smoke.mjs   # ポップアップを実際のサービスワーカーにつないで操作
node tests/ui/screenshot.mjs        # 画面のスクリーンショット（tests/ui/screenshots/）
```

E2E は Chrome 137 以降で `--load-extension` が使えないため、CDP の `Extensions.loadUnpacked` で読み込みます（`tests/e2e/helpers.js`）。

アイテムの種類と項目は `extension/src/shared/item-types.js` の定義から、検証・取り込み・書き出し・画面がすべて作られます。表示言語は将来切り替えられるようにする予定のため、新しい画面の文言は `extension/src/shared/i18n.js` の `t()` を通し、保存するデータには言語に依存しない ID と ISO 形式の日付だけを入れます。

## サードパーティ

- [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0）— `extension/src/third_party/`（`scripts/build-jsqr.mjs` で再生成）
- [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)（LGPL-3.0-or-later）— `extension/src/third_party/openpgp.js`（`scripts/build-openpgp.mjs` で再生成）
- [Public Suffix List](https://publicsuffix.org/)（MPL-2.0）— `extension/src/shared/psl-data.js`（`scripts/build-psl.mjs` で再生成）
- JetBrains Mono / M PLUS 1 Code（SIL OFL 1.1）— `extension/src/assets/fonts/`
