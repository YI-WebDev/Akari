<div align="center">

# 灯 Akari

**暗いところで鍵を照らす灯り。**
パスワード・認証コード・パスキーを、ひとつの暗号化された保管庫に。Chrome・Brave の拡張機能です。

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-FF7A45?style=for-the-badge&labelColor=1A1511" />
  <img alt="No build" src="https://img.shields.io/badge/Build-none-FF7A45?style=for-the-badge&labelColor=1A1511" />
  <img alt="Offline" src="https://img.shields.io/badge/Network-offline-FF7A45?style=for-the-badge&labelColor=1A1511" />
</p>

<p>
  <a href="#特徴">特徴</a>
  ·
  <a href="#インストール">インストール</a>
  ·
  <a href="#安全性">安全性</a>
  ·
  <a href="#開発">開発</a>
  ·
  <a href="#既知の制限">既知の制限</a>
</p>

</div>

<hr />

## 特徴

| 機能 | できること |
| --- | --- |
| **パスキー** | ロック解除中はページ右上のカードで選ぶだけでサインイン。ログイン画面を開くと自動で出る |
| **自動入力** | ポップアップ・入力欄の 灯 ボタン・`Ctrl+Shift+L`。ログイン後に保存・更新を提案 |
| **パスワード作成** | ランダム（8〜48 文字）とパスフレーズ（日本語ローマ字 3〜8 語）。エントロピーを表示 |
| **認証コード** | `otpauth://` を貼り付けるか、表示中のタブの QR コードから登録 |
| **アイテム** | ログイン・メモ・カード・ID・SSH キー・銀行口座など 18 種類。番号は伏せ字で表示・コピー |
| **保管庫** | 作成・名前と色の変更・削除。削除するときは中身を移すか一緒に消すかを選ぶ |
| **インポート** | 1Password・Bitwarden・Proton Pass・Chrome など 17 のアプリ、CSV、PGP 暗号化ファイル |
| **エクスポート** | 暗号化バックアップ・CSV・Bitwarden JSON |
| **自動ロック** | 1〜60 分 / ブラウザを閉じたとき / しない |

## インストール

1. `chrome://extensions`（Brave は `brave://extensions`）で「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」で `extension/` を選ぶ
3. ツールバーの 灯 を開いてマスターパスワードを決める

ビルドは不要です（素の ES Modules）。

## 安全性

- **暗号化** — マスターパスワード → PBKDF2-SHA256（600,000 回）→ AES-256-GCM。パスワードを変えるとデータ鍵も作り直す
- **鍵の保管** — 解除中の鍵はメモリ（`storage.session`）だけ。自動ロック「しない」のときだけディスクにも置き、手動ロックで消す。どちらも Web ページ側からは読めない
- **サイトの判定** — 同梱の Public Suffix List で登録可能ドメイン単位（`bank.co.il` と `evil.co.il` は別のサイト）
- **ページ上の UI** — 閉じた Shadow DOM に作り、しばらく見えてからでないとクリックを受け付けない。マスターパスワードはページで入力させない
- **外部通信なし** — フォントまで同梱。`eval` は使えない（WebAssembly は PGP の Argon2 用だけ）

## 開発

```bash
npm install                         # テスト用の依存だけ（拡張本体には不要）
npm test                            # 単体テスト
npm run e2e                         # インストール済みの Chrome で E2E
node tests/ui/extension-smoke.mjs   # ポップアップを実際のサービスワーカーにつないで操作
node tests/ui/screenshot.mjs        # 画面のスクリーンショット（tests/ui/screenshots/）
```

アイテムの種類は `extension/src/shared/item-types.js` の定義から、検証・取り込み・書き出し・画面まで作られます。画面の文言は表示言語の切り替えに備えて `extension/src/shared/i18n.js` の `t()` を通します。

## 既知の制限

- KeePass は XML のみ（.kdbx は不可）。Argon2id で保護された Bitwarden JSON とパスワード付き ZIP は読めず、添付ファイルと Proton Pass のパスキーは取り込まない
- iframe 内の WebAuthn はブラウザ標準に任せる。ロック中はログイン画面を開いてもパスキーのカードは出ない
- 自動入力（ポップアップ・ショートカット）はトップフレームのみ。認証コードは自動入力しない
- Google Authenticator の書き出し（`otpauth-migration://`）は未対応
- クリップボードの消去は、あとから別のものをコピーしていても消す

## サードパーティ

| 名前 | ライセンス | 場所 |
| --- | --- | --- |
| [jsQR](https://github.com/cozmo/jsQR) | Apache-2.0 | `extension/src/third_party/` |
| [OpenPGP.js](https://github.com/openpgpjs/openpgpjs) | LGPL-3.0-or-later | `extension/src/third_party/openpgp.js` |
| [Public Suffix List](https://publicsuffix.org/) | MPL-2.0 | `extension/src/shared/psl-data.js` |
| JetBrains Mono / M PLUS 1 Code | SIL OFL 1.1 | `extension/src/assets/fonts/` |

どれも `scripts/` のスクリプトで再生成できます（フォントを除く）。
