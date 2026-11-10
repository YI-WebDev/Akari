# プライバシーポリシー / Privacy Policy

日本語が先、英語（English）はその後ろにあります。 / Japanese comes first; the English version follows below.

施行日 / Effective date: 2026-11-08

---

# 日本語

灯 Akari は、パスワード・認証コード・パスキーを保管する Chrome・Brave の拡張機能です。Akari 自身のアカウントもサーバーもありません。データはあなたのブラウザの中にだけあります。

## 結論

- Akari は、あなたのデータをどこにも送りません。開発者を含め、第三者がデータを受け取ることはありません。
- 解析ツール（アナリティクス）、広告、クラッシュ報告、外部のフォントや CDN は使っていません。

## 保存するデータと場所

すべて、あなたの端末の Chrome（Brave）のプロファイルの中に保存されます。

| データ | 保存先 | 内容 |
| --- | --- | --- |
| 保管庫 | `chrome.storage.local` | ログイン、メモ、カードなどのアイテムとパスキー。マスターパスワードから作った鍵で暗号化（PBKDF2-SHA256 600,000 回 → AES-256-GCM） |
| ゴミ箱 | 保管庫の中（暗号化済み） | 削除したアイテム。30 日間残り、その後は消える |
| ロック解除中の鍵 | `chrome.storage.session` | メモリ上だけ。ロックするか、ブラウザを閉じると消える。自動ロックを「しない」にしたときだけ、`chrome.storage.local` にも置く（手動でロックすると消える） |
| 設定 | `chrome.storage.local` | 自動ロックの時間、クリップボードを消すまでの秒数、表示言語、テーマ |
| バックアップの日付 | `chrome.storage.local`（`akari.backup`） | 最後に暗号化バックアップを書き出した日時（`lastAt`）、記録を始めた日時（`since`）、通知を止めている期限（`snoozeUntil`）。バックアップの中身は含まない |
| 画面の好み | ポップアップの `localStorage` | 一覧の絞り込み・並び順・選択中の保管庫・種類（`akari.ui`）、テーマ（`akari.theme`）、パスワード作成の設定（`akari.gen`）。パスワードやアイテムの中身は含まない |

マスターパスワードは保存しません。忘れた場合、Akari の側で復旧する方法はありません。

## 外部通信

- Akari は、ネットワークに接続するコードを持ちません。拡張機能のページの CSP は `connect-src 'self'` で、拡張機能の外へは接続できません。
- フォントやアイコンは拡張機能に同梱しています。外部のスクリプト・フォント・画像は読み込めません（CSP は `script-src 'self' 'wasm-unsafe-eval'`、`font-src 'self'`、`img-src 'self' data: blob:`）。
- ページに差し込むスクリプト（content script）が通信する相手は、同じ拡張機能のサービスワーカーだけです。

## 権限と使い道

`extension/manifest.json` に宣言している権限は次のとおりです。

| 権限 | 使い道 |
| --- | --- |
| `storage` | 保管庫・設定・バックアップの日付・ロック解除中の鍵を保存する |
| `alarms` | 自動ロックと、クリップボードを消す時刻を管理する |
| `offscreen` | クリップボードを空にするための非表示ページを一時的に開く（理由は CLIPBOARD） |
| `clipboardWrite` | パスワードや認証コードなどをコピーする |
| `activeTab` | 表示中のタブの QR コードを読み取って認証コードを登録する（ポップアップからの操作のときだけ） |
| `scripting` | ログイン画面に自動入力するとき、まだ読み込まれていない最上位のフレームに Akari のスクリプトを差し込む |
| `host_permissions`: `<all_urls>` | どのサイトのログイン画面でも、自動入力・保存の提案・パスキーを使えるようにする |

あわせて、次の content script を宣言しています。

- `http://*/*` と `https://*/*` のすべてのページ（iframe を含む）: 入力欄のボタンと、自動入力・保存の提案（`autofill.js`、`shadow-ui.js`、`i18n-page.js`）。
- `https://*/*`、`http://localhost/*`、`http://127.0.0.1/*` の最上位のページ: パスキーの作成・サインインを受け取る（`webauthn-page.js`、`webauthn-bridge.js`）。

Akari がページから読むのは、そのページの URL、ログイン・登録・住所の入力欄の様子、そして保存の提案のために入力された ID とパスワードです。サイトの照合も保存の提案も端末の中で行い、外へは出しません。キーボードショートカット `Ctrl+Shift+L`（Mac は `Command+Shift+L`）でも自動入力できます。

## クリップボード

コピーしたパスワードなどは、設定した秒数（10・30・60 秒、既定は 30 秒、「しない」も選べます）のあとに自動で消します。時間になると、非表示ページ（offscreen document）がクリップボードを空にします。そのときクリップボードにあるものは、Akari 以外でコピーした内容も含めて消えます。ブラウザの外にあるクリップボード履歴などは、Akari から消せません。

## ウェブページから見えるもの・見えないもの

- ページに出す Akari の画面（入力欄のボタン、パスキーのカード）は、閉じた Shadow DOM の中に作ります。ページのスクリプトからは中身に触れません。ページが重ねて隠していないかを確認し、しばらく見えてからでないとクリックを受け付けません。
- マスターパスワードは、ウェブページ上では入力させません。ポップアップなど拡張機能自身の画面でだけ入力します。
- ロック解除中の鍵は `chrome.storage.session` にあり、ページ側からは読めません。
- 自動入力すると、入力欄に値が入ります。入力欄の値はそのページが読めます。自動入力は、あなたが操作したとき（または、パスキーのカードで選んだとき）だけ行います。
- 登録フォームで提案する強いパスワードと、住所の欄で選ぶアイデンティティ（種類「ID」のアイテム）の住所も同じです。ページ上のメニューであなたが選ぶまで、ページの入力欄には入りません。選ぶ前に Akari のメニューへ渡るのは、そのアイテムのタイトルと氏名だけです。選んだときにページへ入るのは住所（郵便番号・都道府県・市区町村・番地・建物・国）だけで、氏名・メールアドレス・電話番号・生年月日は入れません。入る先は、いま入力している欄と、同じフォームの中でしばらく画面にはっきり見えていた住所の欄です。画面の外にある欄、ほかの要素に隠れた欄、半透明の欄には入れません。ただし、文字を背景と同じ色にするような細工までは見分けられません。

## バックアップとエクスポート

- エクスポートしたファイルは、あなたが保存先を選んで保存します。Akari はそのファイルを送信も保管もしません。
- 暗号化バックアップは、保管庫を暗号化したまま書き出します。
- CSV と JSON（Bitwarden 形式）は暗号化されない平文です。書き出すときにマスターパスワードをもう一度入力します。PGP 暗号化の書き出しも、マスターパスワードの入力とパスフレーズが必要です。
- 保存したファイルの扱い（置き場所、共有、削除）は、あなたの責任です。

## データの削除

- 拡張機能をブラウザから削除すると、Chrome が Akari の保存データ（`chrome.storage` とポップアップの `localStorage`）を削除します。
- 削除する前に、必要なら暗号化バックアップを書き出してください。Akari にはサーバーがないため、削除したデータを復旧する方法はありません。
- 書き出したファイルは、Akari では消せません。ご自身で削除してください。

## このポリシーの変更

変更するときは、このファイルを更新し、上の施行日を改めます。履歴は GitHub のコミットで確認できます。

## 連絡先

質問や指摘は、GitHub の Issue へお願いします: <https://github.com/YI-WebDev/Akari/issues>

メールアドレスは公開していません。脆弱性の報告は Issue ではなく、[`SECURITY.md`](SECURITY.md) の方法でお願いします。

---

# English

Akari is a Chrome and Brave extension that stores passwords, one-time codes, and passkeys. It has no Akari account and no server. Your data stays inside your browser.

## Summary

- Akari does not send your data anywhere. No third party, including the developer, receives it.
- Akari uses no analytics, advertising, crash reporting, or external fonts or CDNs.

## What Akari stores, and where

Everything is stored in your Chrome (or Brave) profile on your device.

| Data | Where | What it holds |
| --- | --- | --- |
| Vault | `chrome.storage.local` | Logins, notes, cards, other items, and passkeys. Encrypted with a key derived from your master password (PBKDF2-SHA256, 600,000 iterations, then AES-256-GCM) |
| Trash | Inside the vault (encrypted) | Deleted items. Kept for 30 days, then removed |
| Unlocked key | `chrome.storage.session` | In memory only. Removed when you lock or close the browser. Also written to `chrome.storage.local` only if you set auto-lock to "Never" (removed when you lock manually) |
| Settings | `chrome.storage.local` | Auto-lock time, seconds until the clipboard is cleared, display language, theme |
| Backup dates | `chrome.storage.local` (`akari.backup`) | When you last exported an encrypted backup (`lastAt`), when tracking began (`since`), and until when the reminder is snoozed (`snoozeUntil`). It does not contain the backup itself |
| UI preferences | `localStorage` of the popup | List filter, sort order, selected vault, and type (`akari.ui`); theme (`akari.theme`); password generator options (`akari.gen`). No passwords or item contents |

Akari does not store your master password. If you forget it, Akari has no way to recover your data.

## Network access

- Akari contains no code that connects to the network. The CSP for extension pages sets `connect-src 'self'`, so they cannot connect outside the extension.
- Fonts and icons are bundled. External scripts, fonts, and images cannot load (CSP: `script-src 'self' 'wasm-unsafe-eval'`, `font-src 'self'`, `img-src 'self' data: blob:`).
- The content scripts that run in web pages talk only to the extension's own service worker.

## Permissions and what they are for

Permissions declared in `extension/manifest.json`:

| Permission | Use |
| --- | --- |
| `storage` | Store the vault, settings, backup dates, and the unlocked key |
| `alarms` | Schedule auto-lock and the time to clear the clipboard |
| `offscreen` | Briefly open a hidden page that empties the clipboard (reason: CLIPBOARD) |
| `clipboardWrite` | Copy passwords, one-time codes, and other values |
| `activeTab` | Read a QR code on the current tab to add a one-time code (only when you start it from the popup) |
| `scripting` | When autofilling, inject Akari's scripts into a top-level frame that has not loaded them yet |
| `host_permissions`: `<all_urls>` | Offer autofill, save prompts, and passkeys on the login page of any site |

It also declares these content scripts:

- All `http://*/*` and `https://*/*` pages, including iframes: the field button, autofill, and save prompts (`autofill.js`, `shadow-ui.js`, `i18n-page.js`).
- Top-level pages on `https://*/*`, `http://localhost/*`, and `http://127.0.0.1/*`: receive passkey create and sign-in requests (`webauthn-page.js`, `webauthn-bridge.js`).

From a page, Akari reads its URL, the layout of its login, sign-up, and address fields, and the username and password you enter so it can offer to save them. Matching and save prompts happen on your device, and nothing leaves it. You can also autofill with the shortcut `Ctrl+Shift+L` (`Command+Shift+L` on Mac).

## Clipboard

Copied passwords and similar values are cleared after the number of seconds you choose (10, 30, or 60; the default is 30; you can also turn it off). When the time comes, a hidden page (an offscreen document) empties the clipboard. Whatever is on the clipboard at that moment is cleared, including content you copied from other apps. Akari cannot clear things outside the browser, such as an operating system's clipboard history.

## What web pages can and cannot see

- The Akari UI shown inside a page (the field button and the passkey card) is built in a closed Shadow DOM. Scripts on the page cannot reach its contents. Akari checks that the page has not covered or hidden it, and it ignores clicks until the UI has been visible for a short time.
- Akari never asks you to type the master password on a web page. You enter it only on the extension's own screens, such as the popup.
- The unlocked key lives in `chrome.storage.session`, which pages cannot read.
- When Akari autofills, the values appear in the page's fields, and the page can read the contents of its own fields. Akari fills only when you ask it to, or when you pick an entry on the passkey card.
- The same holds for the strong password suggested on sign-up forms and for the address of an identity (an item of the type "Identity") offered on address fields. Nothing enters the page's fields until you choose it in Akari's menu on the page. Before you choose, only the item's title and name reach that menu. When you choose, only the address (postal code, state or prefecture, city, street, building, country) goes to the page; the name, email address, phone number, and date of birth do not. It goes into the field you are in and into address fields of the same form that have been plainly visible on screen for a moment. Fields outside the screen, covered by other elements, or translucent get nothing. Akari cannot tell, however, when a page uses tricks such as giving a field's text the same colour as its background.

## Backups and exports

- Exported files are saved where you choose. Akari neither uploads nor keeps them.
- An encrypted backup keeps the vault encrypted.
- CSV and JSON (Bitwarden format) exports are plaintext. Akari asks for your master password again before it writes them. A PGP-encrypted export also needs your master password, plus a passphrase.
- You are responsible for where you keep, share, and delete exported files.

## Deleting your data

- When you remove the extension from the browser, Chrome deletes Akari's stored data (`chrome.storage` and the popup's `localStorage`).
- If you may need your data later, export an encrypted backup first. Akari has no server, so deleted data cannot be recovered.
- Akari cannot delete files you exported. Delete them yourself.

## Changes to this policy

When this policy changes, this file is updated and the effective date above is revised. The history is in the GitHub commits.

## Contact

Please send questions and concerns as a GitHub issue: <https://github.com/YI-WebDev/Akari/issues>

There is no public email address. Report vulnerabilities by the method in [`SECURITY.md`](SECURITY.md), not in an issue.
