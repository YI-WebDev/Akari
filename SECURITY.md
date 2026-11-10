# セキュリティポリシー / Security Policy

日本語が先、英語（English）はその後ろにあります。 / Japanese comes first; the English version follows below.

---

# 日本語

## 脆弱性の報告

脆弱性を見つけたら、**公開の Issue には書かず**、GitHub の非公開の脆弱性報告で送ってください。

<https://github.com/YI-WebDev/Akari/security/advisories/new>

報告は、リポジトリの管理者だけに届きます。修正できるまで、公開しないでください。

### 報告に書いてほしいこと

- 何が起きるか（影響）と、攻撃者に必要な条件
- 再現する手順。できれば最小の例（ページの HTML、操作の順番など）
- 確認したバージョン（`extension/manifest.json` の `version`）、Chrome または Brave のバージョン、OS
- 関係するファイルや行が分かれば、その場所
- 修正案があれば、その案

保管庫の実データ、マスターパスワード、秘密の値は報告に含めないでください。必要なら、テスト用のダミーを使ってください。

### 対応について

Akari は個人で保守しています。返信や修正の時期を約束することはできません。報告はすべて読みます。

## 対象のバージョン

| バージョン | 対象 |
| --- | --- |
| `main` ブランチの最新（現在 `0.1.0`） | 対象 |
| それ以前のコミットやバージョン | 対象外 |

修正は `main` にだけ入れます。古いバージョンへの修正の取り込みはしません。

## 対象の範囲

対象:

- `extension/` の拡張機能（ポップアップ、サービスワーカー、content script、パスキー画面、offscreen document）
- 暗号、鍵の扱い、インポート・エクスポート、自動入力、パスキー、ページ上の UI

対象外:

- 同梱したサードパーティのライブラリ（`extension/src/third_party/` の jsQR・OpenPGP.js、Public Suffix List）自体の不具合。ただし、Akari の使い方に問題があるものは対象です。元のプロジェクトにも報告してください
- 端末がすでにマルウェアに感染している、ブラウザのプロファイルを物理的に奪われているなど、Akari の外で攻撃者が端末を支配している場合
- 弱いマスターパスワードを使ったことによる推測
- 平文でエクスポートしたファイルの扱い
- `tests/` や `tools/` などの開発用ファイル

## セキュリティ設計の概要

コードで確認できる、現在の設計です。第三者による監査は受けていません。

- **暗号化** — マスターパスワードから PBKDF2-SHA256（600,000 回）で鍵を作り、その鍵でデータ鍵を AES-256-GCM で包みます。保管庫の中身は、データ鍵で AES-256-GCM により暗号化します（`extension/src/lib/crypto.js`）
- **鍵の置き場所** — ロック解除中の鍵は `chrome.storage.session` に置きます。自動ロックを「しない」にしたときだけ `chrome.storage.local` にも置き、ロックすると消します（`extension/src/background/vault-service.js`）
- **ページ上の UI** — 閉じた Shadow DOM に作ります。ページが覆っていないかを見て、しばらく見えてからでないとクリックを受け付けません（`extension/src/content/shadow-ui.js`）。マスターパスワードはページ上で入力させません
- **サイトの判定** — 同梱の Public Suffix List で、登録可能ドメイン単位に判定します（`extension/src/shared/domain.js`、`extension/src/shared/psl-data.js`）
- **メッセージの送り手の確認** — サービスワーカーは、メッセージの種類ごとに、拡張機能のページから来たものか、http(s) のページの content script から来たものかを確かめます（`extension/src/background/router.js`）
- **CSP** — 拡張機能のページは `script-src 'self' 'wasm-unsafe-eval'`、`connect-src 'self'`、`frame-ancestors 'none'`。`eval` は使えません（`extension/manifest.json`）
- **外部通信なし** — ネットワークに接続するコードを持ちません。フォントも同梱しています

詳しい説明は [`README.md`](README.md) と [`PRIVACY.md`](PRIVACY.md) にあります。

---

# English

## Reporting a vulnerability

If you find a vulnerability, **do not open a public issue.** Report it privately through GitHub's private vulnerability reporting:

<https://github.com/YI-WebDev/Akari/security/advisories/new>

Only the repository maintainers can see the report. Please do not disclose the problem publicly until a fix is available.

### What to include

- What happens (the impact) and what the attacker needs
- Steps to reproduce, ideally a minimal example (page HTML, order of actions)
- The version you tested (`version` in `extension/manifest.json`), your Chrome or Brave version, and your OS
- The affected files or lines, if you know them
- A suggested fix, if you have one

Do not include real vault data, your master password, or real secrets. Use dummy test data instead.

### What to expect

Akari is maintained by one person. I cannot promise a reply time or a fix date. Every report will be read.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest `main` (currently `0.1.0`) | Yes |
| Earlier commits and versions | No |

Fixes go into `main` only. They are not backported.

## Scope

In scope:

- The extension under `extension/` (popup, service worker, content scripts, passkey window, offscreen document)
- Cryptography, key handling, import and export, autofill, passkeys, and the in-page UI

Out of scope:

- Bugs in the bundled third-party libraries themselves (jsQR and OpenPGP.js in `extension/src/third_party/`, the Public Suffix List). Problems in how Akari uses them are in scope. Please also report library bugs upstream
- An attacker who already controls your device or has your browser profile, such as through malware or physical access
- Guessing of a weak master password
- Handling of files you exported as plaintext
- Development files such as `tests/` and `tools/`

## Security design summary

This is the current design, as it appears in the code. Akari has not had a third-party audit.

- **Encryption** — A key derived from the master password with PBKDF2-SHA256 (600,000 iterations) wraps the data key with AES-256-GCM. The vault contents are encrypted with the data key using AES-256-GCM (`extension/src/lib/crypto.js`)
- **Where the key lives** — While unlocked, the key is in `chrome.storage.session`. It is also in `chrome.storage.local` only if auto-lock is set to "Never", and locking removes it (`extension/src/background/vault-service.js`)
- **In-page UI** — Built in a closed Shadow DOM. It checks that the page has not covered it and ignores clicks until it has been visible for a short time (`extension/src/content/shadow-ui.js`). The master password is never typed into a page
- **Site matching** — By registrable domain, using the bundled Public Suffix List (`extension/src/shared/domain.js`, `extension/src/shared/psl-data.js`)
- **Sender checks** — For each message type, the service worker checks whether it came from an extension page or from a content script on an http(s) page (`extension/src/background/router.js`)
- **CSP** — Extension pages use `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`, and `frame-ancestors 'none'`. `eval` is not allowed (`extension/manifest.json`)
- **No network** — Akari has no code that connects to the network, and the fonts are bundled

See [`README.md`](README.md) and [`PRIVACY.md`](PRIVACY.md) for more.
