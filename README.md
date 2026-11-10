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
</p>

</div>

<hr />

## 特徴

| 機能 | できること |
| --- | --- |
| **パスキー** | ロック解除中はページ右上のカードで、選ぶだけでサインイン、ボタンひとつで保存。ログイン画面を開くと自動で出る |
| **自動入力** | ポップアップ・入力欄の 灯 ボタン・`Ctrl+Shift+L`。ログイン後に保存・更新を提案。登録フォームのパスワード欄では強いパスワードを提案し、入力するとその場で保存を提案。住所の欄では、保存した ID の住所を選んで入力 |
| **パスワード作成** | ランダム（8〜48 文字）とパスフレーズ（日本語ローマ字 3〜8 語）。エントロピーを表示 |
| **パスワード診断** | 弱い・使い回し・1 年以上変えていない・2FA なしのログインを一覧にして、その場で強化 |
| **認証コード** | `otpauth://` を貼り付けるか、表示中のタブの QR コードから登録 |
| **アイテム** | ログイン・メモ・カード・ID・SSH キー・銀行口座など 18 種類。番号は伏せ字で表示・コピー |
| **ゴミ箱** | 削除したアイテムは 30 日間残り、元に戻せる。削除の直後はトーストの「元に戻す」か `Ctrl+Z` |
| **保管庫** | 作成・名前と色の変更・削除。削除するときは中身を移すか、ゴミ箱に移すかを選ぶ |
| **インポート** | 1Password・Bitwarden・Proton Pass・Chrome など 17 のアプリ、CSV、PGP 暗号化ファイル |
| **エクスポート** | 暗号化バックアップ・CSV・JSON（Bitwarden 形式）・PGP 暗号化（中身は CSV か JSON） |
| **バックアップの通知** | 暗号化エクスポート（Akari のバックアップか PGP）から 30 日たつと、ポップアップに通知。「バックアップする」でエクスポート画面を開き、「あとで」で 7 日間隠す |
| **自動ロック** | 1〜60 分 / ブラウザを閉じたとき / しない |
| **表示言語** | 日本語・英語を設定で切り替え（自動はブラウザの言語に合わせる） |
| **テーマ** | ダーク（既定）・ライト・自動（OS に合わせる）。ページ上の入力メニューとパスキーのカードも従う |

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

## ライセンス

- Akari は MIT ライセンス（[`LICENSE`](LICENSE)）
- 同梱している第三者のコンポーネントは、それぞれのライセンスに従う（[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）
- プライバシー — Akari はどこにもデータを送らない（[`PRIVACY.md`](PRIVACY.md)）
- 脆弱性の報告は [`SECURITY.md`](SECURITY.md) へ
