import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pbkdf2Sync, createHmac, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { makeZip } from './_zip.js';
import { makeImported } from '../../extension/src/lib/import/model.js';
import { parseImport } from '../../extension/src/lib/import/index.js';
import * as onepassword from '../../extension/src/lib/import/importers/onepassword.js';
import * as bitwarden from '../../extension/src/lib/import/importers/bitwarden.js';
import * as dashlane from '../../extension/src/lib/import/importers/dashlane.js';
import * as enpass from '../../extension/src/lib/import/importers/enpass.js';
import * as keeper from '../../extension/src/lib/import/importers/keeper.js';
import * as keepass from '../../extension/src/lib/import/importers/keepass.js';
import * as protonpass from '../../extension/src/lib/import/importers/protonpass.js';

const fx = (p) => new Uint8Array(readFileSync(new URL('../fixtures/import/' + p, import.meta.url)));
const fxText = (p) => readFileSync(new URL('../fixtures/import/' + p, import.meta.url), 'utf8');
const enc = (s) => new TextEncoder().encode(s);
const find = (out, title) => {
  const it = out.items.find((i) => i.title === title);
  assert.ok(it, `item "${title}" missing; got ${out.items.map((i) => i.title).join(', ')}`);
  return it;
};
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => {
  assert.equal(e.name, 'ImportError');
  assert.equal(e.code, code);
  if (re) assert.match(e.message, re);
  return true;
});
/** Every item an importer returns must survive the shared normaliser. */
const allValid = (out) => {
  for (const it of out.items) assert.ok(makeImported(it), `item "${it.title}" was dropped by makeImported`);
};

// --- 1Password -----------------------------------------------------------------------------

const onePux = () => makeZip({
  'export.attributes': fx('1password/1pux/export.attributes'),
  'export.data': fx('1password/1pux/export.data'),
  'files/DOC0001__保険証.pdf': 'synthetic pdf bytes',
});

test('1Password 1pux: logins, TOTP, favourites, URLs, conversions, trash', async () => {
  const out = await onepassword.parse({ name: 'export.1pux', bytes: onePux() }, { source: '1password' });
  allValid(out);
  assert.equal(out.items.length, 7);
  assert.equal(out.skipped, 1); // the trashed login
  assert.ok(!out.items.some((i) => i.title === 'ゴミ箱のログイン'));

  const shop = find(out, '通販サイト');
  assert.equal(shop.type, 'login');
  assert.equal(shop.username, 'hanako@example.jp');
  assert.equal(shop.password, 'Momiji#2023');
  assert.equal(shop.url, 'https://shop.example.jp/login');
  assert.equal(shop.fav, true);
  assert.equal(shop.createdAt, 1700000000000);
  assert.equal(shop.updatedAt, 1710000000000);
  assert.deepEqual(shop.totp, { secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 8, period: 30, issuer: 'Shop', label: 'hanako' });
  assert.match(shop.note, /^家族共有のアカウント。/);
  assert.match(shop.note, /URL: https:\/\/app\.shop\.example\.jp/);
  assert.match(shop.note, /秘密の質問の答え: ポチ/);
  assert.match(shop.note, /タグ: 買い物, 家族/);
  assert.doesNotMatch(shop.note, /remember/); // checkbox form fields are noise

  const memo = find(out, '家電メモ');
  assert.equal(memo.type, 'note');
  assert.match(memo.note, /NR-F1234/);

  const card = find(out, 'マスターカード');
  assert.equal(card.type, 'note');
  assert.match(card.note, /番号: 5555555555554444/);
  assert.match(card.note, /有効期限: 2028\/12/);
  assert.match(card.note, /住所: 丸の内 1-1, 千代田区/);
  assert.match(card.note, /ETC カード付き$/);

  const router = find(out, 'ルーター管理画面'); // archived "Password" item is still imported
  assert.equal(router.type, 'login');
  assert.equal(router.password, 'router-admin-pass');
  assert.equal(router.fav, true);

  assert.match(find(out, '自宅の Wi-Fi').note, /Wi-Fi パスワード: wifi-secret-123/);
  assert.match(find(out, '保険証').note, /ファイル名: 保険証\.pdf/);
  assert.equal(find(out, 'GitLab').totp.secret, 'JBSWY3DPEHPK3PXP'); // bare base32 secret

  assert.ok(out.warnings.includes('クレジットカード 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.includes('Wi-Fi 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.includes('ドキュメント 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.some((w) => /添付ファイル/.test(w)));
});

test('1Password: .zip holding export.data and a bare export.data are read as 1pux', async () => {
  const a = await onepassword.parse({ name: 'export.zip', bytes: onePux() }, {});
  const b = await onepassword.parse({ name: 'export.data', bytes: fx('1password/1pux/export.data') }, {});
  assert.equal(a.items.length, 7);
  assert.deepEqual(b.items.map((i) => i.title), a.items.map((i) => i.title));
  await rejectsWith(onepassword.parse({ name: 'x.zip', bytes: makeZip({ 'other.txt': 'x' }) }, {}), 'INVALID_FORMAT');
});

test('1Password 1pif: records, TOTP, favourites, trashed and system records', async () => {
  const out = await onepassword.parse({ name: 'data.1pif', bytes: fx('1password/export.1pif') }, {});
  allValid(out);
  assert.deepEqual(out.items.map((i) => i.title), ['ネットバンク', '旅行の持ち物', 'JCB カード', '本人情報']);
  assert.equal(out.skipped, 1); // trashed; the folder record is not an item

  const bank = find(out, 'ネットバンク');
  assert.equal(bank.type, 'login');
  assert.equal(bank.username, '0012345');
  assert.equal(bank.password, 'Ginkou*Pass9');
  assert.equal(bank.url, 'https://bank.example.jp/login');
  assert.equal(bank.fav, true);
  assert.equal(bank.totp.issuer, 'Bank');
  assert.match(bank.note, /URL: https:\/\/m\.bank\.example\.jp/);
  assert.match(bank.note, /支店: 本店営業部/);
  assert.match(bank.note, /タグ: お金/);

  assert.equal(find(out, '旅行の持ち物').type, 'note');
  const card = find(out, 'JCB カード');
  assert.equal(card.type, 'note');
  assert.match(card.note, /有効期限: 2030\/07/);
  assert.match(card.note, /expiry_mm: 7/); // flat legacy key kept
  assert.equal(card.note.match(/3530111333300000/g).length, 1); // section duplicate not repeated
  assert.match(find(out, '本人情報').note, /生年月日: 1990-01-01/);
  assert.ok(out.warnings.includes('クレジットカード 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.includes('個人情報 1 件をセキュアノートとして読み込みました'));
});

// --- Bitwarden -----------------------------------------------------------------------------

const P256_PKCS8 = 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUNGd8JJzMSEFfmjUow94J0D3gQHQEevbG2U_6nMP2gihRANCAARe3luLVPXhUQDY7RNcFHuQf1ddqaywJbqg4jWYJ_t2zko1MpnR_pYojMcC6My2Xl9jT31vNNH29mgyQhOHVTmA';

function checkBitwarden(out) {
  allValid(out);
  assert.equal(out.items.length, 6);
  assert.equal(out.skipped, 1); // deletedDate
  const portal = find(out, '社内ポータル');
  assert.equal(portal.type, 'login');
  assert.equal(portal.url, 'https://portal.example.co.jp/login');
  assert.equal(portal.username, 'taro.yamada');
  assert.equal(portal.password, 'Sakura-2024!');
  assert.equal(portal.fav, true);
  assert.equal(portal.createdAt, Date.UTC(2024, 0, 15, 1, 2, 3));
  assert.equal(portal.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(portal.totp.issuer, 'Example');
  assert.match(portal.note, /^VPN 接続が必要です。/);
  assert.match(portal.note, /URL: https:\/\/sso\.example\.co\.jp/);
  assert.match(portal.note, /社員番号: E-1024/);
  assert.match(portal.note, /PIN: 8642/);
  assert.match(portal.note, /管理者: true/);
  assert.doesNotMatch(portal.note, /ユーザー名の参照/); // linked field has no value of its own

  const steam = find(out, 'Steam');
  assert.equal(steam.totp, null);
  assert.match(steam.note, /TOTP: steam:\/\/ABCDEFGHIJ/);

  assert.equal(find(out, '金庫の暗証番号').type, 'note');
  assert.match(find(out, '金庫の暗証番号').note, /場所: 寝室のクローゼット/);
  const card = find(out, 'メインのクレジットカード');
  assert.equal(card.type, 'note');
  assert.equal(card.fav, true);
  assert.match(card.note, /カード番号: 4111111111111111\n有効期限: 04\/2029/);
  assert.match(find(out, '本人情報').note, /パスポート番号: TK1234567/);
  assert.match(find(out, 'サーバー用 SSH 鍵').note, /秘密鍵: -----BEGIN OPENSSH PRIVATE KEY-----/);

  for (const w of ['クレジットカード 1 件をセキュアノートとして読み込みました', '個人情報 1 件をセキュアノートとして読み込みました',
    'SSH キー 1 件をセキュアノートとして読み込みました']) assert.ok(out.warnings.includes(w), w);
  assert.ok(out.warnings.some((w) => /TOTP/.test(w)));
  assert.ok(out.warnings.some((w) => /パスキー 1 件/.test(w))); // the P-384 one
  return portal;
}

test('Bitwarden JSON: logins, notes, converted kinds, deleted items', async () => {
  checkBitwarden(await bitwarden.parse({ name: 'bitwarden_export.json', bytes: fx('bitwarden/export.json') }, {}));
});

test('Bitwarden passkeys: ES256 only; private key imports into WebCrypto as P-256 PKCS8', async () => {
  const out = await bitwarden.parse({ name: 'bitwarden_export.json', bytes: fx('bitwarden/export.json') }, {});
  const [pk, ...rest] = find(out, '社内ポータル').passkeys;
  assert.equal(rest.length, 0);
  // GUID credential id → its 16 raw bytes, b64url.
  assert.equal(pk.credentialId, Buffer.from('6f94caa66bda417a9c1720798334db13', 'hex').toString('base64url'));
  assert.equal(pk.rpId, 'portal.example.co.jp');
  assert.equal(pk.userHandle, 'dXNlci0xMDI0');
  assert.equal(pk.userName, 'taro.yamada');
  assert.equal(pk.userDisplayName, '山田 太郎');
  assert.equal(pk.privateKey, P256_PKCS8);
  assert.equal(pk.createdAt, Date.UTC(2024, 2, 1, 9));
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(pk.privateKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  assert.equal(key.algorithm.namedCurve, 'P-256');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc('challenge'));
  assert.equal(sig.byteLength, 64);
});

test('Bitwarden ZIP: data.json is read, attachments are reported', async () => {
  const zip = makeZip({
    'data.json': fx('bitwarden/export.json'),
    'attachments/a0000000-0000-4000-8000-000000000001/recovery.txt': 'codes',
  });
  const out = await bitwarden.parse({ name: 'bitwarden_export.zip', bytes: zip }, {});
  checkBitwarden(out);
  assert.ok(out.warnings.includes('添付ファイル 1 件は読み込まれません'));
});

/** Independent implementation (node:crypto) of Bitwarden's password-protected export. */
function bitwardenProtect(plainText, password, { iterations = 5000, kdfType = 0 } = {}) {
  const salt = randomBytes(16).toString('base64');
  const key = pbkdf2Sync(password, salt, iterations, 32, 'sha256'); // the salt string itself is the salt
  const expand = (info) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
  const encKey = expand('enc'), macKey = expand('mac');
  const encString = (text) => {
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', encKey, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, ct])).digest();
    return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
  };
  return JSON.stringify({
    encrypted: true,
    passwordProtected: true,
    salt,
    kdfType,
    kdfIterations: iterations,
    kdfMemory: null,
    kdfParallelism: null,
    encKeyValidation_DO_NOT_EDIT: encString(randomUUID()),
    data: encString(plainText),
  });
}

test('Bitwarden password-protected JSON: encrypt → decrypt round trip, wrong / missing password', async () => {
  const file = { name: 'bitwarden_encrypted_export.json', bytes: enc(bitwardenProtect(fxText('bitwarden/export.json'), 'あかり-Export-1')) };
  const portal = checkBitwarden(await bitwarden.parse(file, { password: 'あかり-Export-1' }));
  assert.equal(portal.passkeys.length, 1);
  await rejectsWith(bitwarden.parse(file, { password: 'wrong' }), 'BAD_PASSWORD');
  await rejectsWith(bitwarden.parse(file, {}), 'NEEDS_PASSWORD');

  // Tampering with the payload is reported as a broken file, not as a wrong password.
  const j = JSON.parse(new TextDecoder().decode(file.bytes));
  const [iv, ct, mac] = j.data.slice(2).split('|');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 1;
  j.data = `2.${iv}|${flipped.toString('base64')}|${mac}`;
  await rejectsWith(bitwarden.parse({ name: 'x.json', bytes: enc(JSON.stringify(j)) }, { password: 'あかり-Export-1' }), 'INVALID_FORMAT');
});

test('Bitwarden: Argon2id and account-restricted encrypted exports are rejected clearly', async () => {
  const argon = { name: 'x.json', bytes: enc(bitwardenProtect('{}', 'pw', { kdfType: 1 })) };
  await rejectsWith(bitwarden.parse(argon, { password: 'pw' }), 'UNSUPPORTED', /Argon2id/);
  const account = { encrypted: true, encKeyValidation_DO_NOT_EDIT: '2.AAAA|AAAA|AAAA', folders: [], items: [] };
  await rejectsWith(bitwarden.parse({ name: 'x.json', bytes: enc(JSON.stringify(account)) }, { password: 'pw' }), 'UNSUPPORTED');
  await rejectsWith(bitwarden.parse({ name: 'x.json', bytes: enc('{"hello":1}') }, {}), 'INVALID_FORMAT');
  await rejectsWith(bitwarden.parse({ name: 'x.json', bytes: enc('not json') }, {}), 'INVALID_FORMAT');
});

// --- Dashlane ------------------------------------------------------------------------------

const dashlaneZip = () => {
  const files = {};
  for (const f of ['credentials', 'securenotes', 'payments', 'ids', 'personalInfo']) files[f + '.csv'] = fx(`dashlane/zip/${f}.csv`);
  return makeZip(files);
};

test('Dashlane ZIP of CSVs: credentials with TOTP, notes, payments / IDs / personal info as notes', async () => {
  const out = await dashlane.parse({ name: 'dashlane.zip', bytes: dashlaneZip() }, {});
  allValid(out);
  assert.equal(out.items.length, 8);
  const rakuten = find(out, '楽天市場');
  assert.equal(rakuten.type, 'login');
  assert.equal(rakuten.username, 'hanako@example.jp');
  assert.equal(rakuten.password, 'Ichiba,2024!');
  assert.equal(rakuten.url, 'https://www.rakuten.co.jp');
  assert.equal(rakuten.totp.issuer, 'Rakuten');
  assert.match(rakuten.note, /^ポイントは月末に失効\n要確認/);
  assert.match(rakuten.note, /ユーザー名 2: hanako/);
  assert.match(rakuten.note, /カテゴリ: 買い物/);
  assert.equal(find(out, '社内 Wiki').totp.secret, 'GEZDGNBVGY3TQOJQ');
  assert.match(find(out, 'Steam').note, /TOTP: steam:\/\/XYZ/);
  const wifi = find(out, 'Wi-Fi のメモ');
  assert.equal(wifi.type, 'note');
  assert.match(wifi.note, /SSID: Akari-Guest/);
  assert.match(find(out, '三井住友カード').note, /カード番号: 4980000000000000/);
  assert.match(find(out, 'ゆうちょ銀行').note, /口座番号: 1234567/);
  assert.match(find(out, '山田 太郎').note, /番号: TK7654321/);
  assert.match(find(out, '個人メール').note, /メール: taro@example\.jp/);
  for (const w of ['クレジットカード 1 件をセキュアノートとして読み込みました', '銀行口座 1 件をセキュアノートとして読み込みました',
    '身分証明書 1 件をセキュアノートとして読み込みました', '個人情報 1 件をセキュアノートとして読み込みました']) assert.ok(out.warnings.includes(w), w);
});

test('Dashlane single credentials.csv and legacy JSON', async () => {
  const csv = await dashlane.parse({ name: 'credentials.csv', bytes: fx('dashlane/zip/credentials.csv') }, {});
  assert.deepEqual(csv.items.map((i) => i.title), ['楽天市場', '社内 Wiki', 'Steam']);
  assert.ok(csv.items.every((i) => i.type === 'login'));

  const legacy = await dashlane.parse({ name: 'dashlane.json', bytes: fx('dashlane/legacy.json') }, {});
  allValid(legacy);
  const old = find(legacy, '旧サイト');
  assert.equal(old.username, 'taro@example.jp');
  assert.equal(old.url, 'old.example.jp');
  assert.equal(find(legacy, '旧メモ').note, '古いメモの本文');
  assert.match(find(legacy, '旧カード').note, /cardNumber: 4111111111111111/);
  const legacyZip = await dashlane.parse({ name: 'd.zip', bytes: makeZip({ 'export.json': fx('dashlane/legacy.json') }) }, {});
  assert.equal(legacyZip.items.length, 3);
  await rejectsWith(dashlane.parse({ name: 'd.zip', bytes: makeZip({ 'readme.txt': 'x' }) }, {}), 'INVALID_FORMAT');
});

// --- Enpass --------------------------------------------------------------------------------

test('Enpass JSON: login fields, TOTP, favourites, trashed, archived, conversions', async () => {
  const out = await enpass.parse({ name: 'enpass.json', bytes: fx('enpass/export.json') }, {});
  allValid(out);
  assert.equal(out.items.length, 5);
  assert.equal(out.skipped, 1); // trashed
  const mail = find(out, 'メール');
  assert.equal(mail.type, 'login');
  assert.equal(mail.username, 'jiro');
  assert.equal(mail.password, 'Fuji-San-3776');
  assert.equal(mail.url, 'https://mail.example.jp');
  assert.equal(mail.fav, true);
  assert.equal(mail.totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(mail.createdAt, 1700000000000);
  assert.equal(mail.updatedAt, 1710000000000);
  assert.match(mail.note, /^メインのメールアカウント/);
  assert.match(mail.note, /メール: jiro@example\.jp/);
  assert.match(mail.note, /予備のサイト: https:\/\/webmail\.example\.jp/);
  assert.match(mail.note, /秘密の質問: 初めて飼ったペットは？/);
  assert.doesNotMatch(mail.note, /消したはずの値|追加情報/); // deleted fields and section headers

  const onlyEmail = find(out, 'メールだけのログイン');
  assert.equal(onlyEmail.username, 'only-email@example.jp');
  assert.equal(onlyEmail.totp.period, 60);

  assert.equal(find(out, '引っ越しメモ').type, 'note');
  const amex = find(out, 'アメックス'); // archived items are still imported
  assert.equal(amex.type, 'note');
  assert.match(amex.note, /カード番号: 378282246310005\nCVC: 1234/);
  assert.match(find(out, '会社の Wi-Fi').note, /パスワード: office-wifi-pass/);
  assert.ok(out.warnings.includes('クレジットカード 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.includes('添付ファイル 1 件は読み込まれません'));
  await rejectsWith(enpass.parse({ name: 'x.json', bytes: enc('{"records":[]}') }, {}), 'INVALID_FORMAT');
});

// --- Keeper --------------------------------------------------------------------------------

test('Keeper JSON: logins with TOTP (legacy and v3), notes, converted record types', async () => {
  const out = await keeper.parse({ name: 'keeper.json', bytes: fx('keeper/export.json') }, {});
  allValid(out);
  assert.equal(out.items.length, 5);
  const bank = find(out, '銀行オンライン');
  assert.equal(bank.type, 'login');
  assert.equal(bank.username, 'saburo');
  assert.equal(bank.password, 'Kyoto-1994!');
  assert.equal(bank.url, 'https://bank.example.jp');
  assert.equal(bank.totp.issuer, 'Bank');
  assert.match(bank.note, /^第二暗証番号は別管理/);
  assert.match(bank.note, /予備 URL: https:\/\/bank2\.example\.jp/);
  assert.match(bank.note, /合言葉: さくら/);
  assert.match(bank.note, /秘密の質問: 母の旧姓は？\n答え: 鈴木/);
  assert.doesNotMatch(bank.note, /TFC:Keeper|otpauth/);

  const shop = find(out, 'ショッピング'); // record without $type = legacy login
  assert.equal(shop.type, 'login');
  assert.equal(shop.totp.algorithm, 'SHA256');

  const memo = find(out, '暗号化メモ');
  assert.equal(memo.type, 'note');
  assert.equal(memo.note, '鍵は玄関の植木鉢の下');
  const card = find(out, '楽天カード');
  assert.equal(card.type, 'note');
  assert.match(card.note, /カード番号: 5555555555554444\n有効期限: 12\/2029\nセキュリティコード: 987/);
  assert.match(card.note, /ポイント払い$/);
  assert.match(find(out, '家の Wi-Fi').note, /SSID: Akari-Home/);
  assert.ok(out.warnings.includes('クレジットカード 1 件をセキュアノートとして読み込みました'));
  assert.ok(out.warnings.includes('Wi-Fi 1 件をセキュアノートとして読み込みました'));
});

// --- KeePass -------------------------------------------------------------------------------

test('XML reader: entities, CDATA, comments, attributes, self-closing, errors', () => {
  const doc = keepass.parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "v">]><!-- c --><a k="1 &gt; 0" j=\'&quot;q&quot;\'><b/>x&#x3042;&#12354;&amp;<c><![CDATA[<raw> & ]]></c></a>');
  const a = doc.children[0];
  assert.equal(a.name, 'a');
  assert.deepEqual(a.attrs, { k: '1 > 0', j: '"q"' });
  assert.equal(a.children[0].name, 'b');
  assert.equal(a.text, 'xああ&');
  assert.equal(a.children[1].text, '<raw> & ');
  assert.throws(() => keepass.parseXml('<a><b></a>'), { code: 'INVALID_FORMAT' });
  assert.throws(() => keepass.parseXml('<a>'), { code: 'INVALID_FORMAT' });
});

test('KeePass XML: entries, TOTP variants, history and recycle bin skipped', async () => {
  const out = await keepass.parse({ name: 'export.xml', bytes: fx('keepass/export.xml') }, {});
  allValid(out);
  assert.deepEqual(out.items.map((i) => i.title), ['クラウド管理画面', 'VPN', '金庫のメモ', 'Web メール', 'Steam']);
  assert.equal(out.skipped, 2); // two entries in the recycle bin (one in a sub-group)

  const cloud = find(out, 'クラウド管理画面');
  assert.equal(cloud.type, 'login');
  assert.equal(cloud.username, 'admin@example.jp');
  assert.equal(cloud.password, '  Tsuki&Hoshi<7>  ');
  assert.equal(cloud.url, 'https://console.example.jp/');
  assert.equal(cloud.totp.issuer, 'Console');
  assert.equal(cloud.createdAt, Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.equal(cloud.updatedAt, Date.UTC(2024, 4, 6, 7, 8, 9));
  assert.match(cloud.note, /^本番環境 & 検証環境で共通。<注意> 90 日ごとに変更/);
  assert.match(cloud.note, /URL: https:\/\/console2\.example\.jp\//);
  assert.match(cloud.note, /アカウント ID: 1234-5678-9012/);
  assert.match(cloud.note, /タグ: 仕事, 重要/);
  assert.doesNotMatch(cloud.note, /otpauth/);

  assert.deepEqual(find(out, 'VPN').totp, { secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA256', digits: 8, period: 60, issuer: '', label: 'vpn-user' });
  assert.equal(find(out, 'VPN').note, '');
  const memo = find(out, '金庫のメモ');
  assert.equal(memo.type, 'note');
  assert.equal(memo.note, '暗証番号 <1234> & 鍵の場所\n2 行目');
  assert.equal(find(out, 'Web メール').totp.secret, 'JBSWY3DPEHPK3PXP');
  const steam = find(out, 'Steam'); // HOTP cannot be used; kept in the note
  assert.equal(steam.totp, null);
  assert.match(steam.note, /otp: otpauth:\/\/hotp\//);
  assert.ok(out.warnings.includes('添付ファイル 1 件は読み込まれません'));
  assert.ok(out.warnings.some((w) => /TOTP/.test(w)));
});

test('KeePass XML: rejects other XML and KDBX-protected values', async () => {
  await rejectsWith(keepass.parse({ name: 'x.xml', bytes: enc('<?xml version="1.0"?><root/>') }, {}), 'INVALID_FORMAT');
  const prot = '<KeePassFile><Root><Group><Entry><String><Key>Password</Key><Value Protected="True">AbCd</Value></String></Entry></Group></Root></KeePassFile>';
  await rejectsWith(keepass.parse({ name: 'x.xml', bytes: enc(prot) }, {}), 'UNSUPPORTED');
  await rejectsWith(keepass.parse({ name: 'x.xml', bytes: enc('<KeePassFile><Root>') }, {}), 'INVALID_FORMAT');
});

// --- Proton Pass ---------------------------------------------------------------------------

function checkProton(out) {
  allValid(out);
  assert.equal(out.items.length, 6);
  assert.equal(out.skipped, 1); // state 2 = trashed
  const travel = find(out, '旅行予約サイト');
  assert.equal(travel.type, 'login');
  assert.equal(travel.username, 'goro');
  assert.equal(travel.password, 'Tabi-Suki-88');
  assert.equal(travel.url, 'https://travel.example.jp/login');
  assert.equal(travel.fav, true);
  assert.equal(travel.createdAt, 1700000000000);
  assert.equal(travel.totp.issuer, 'Travel');
  assert.match(travel.note, /^マイルは家族と合算/);
  assert.match(travel.note, /URL: https:\/\/m\.travel\.example\.jp/);
  assert.match(travel.note, /メール: goro@example\.jp/);
  assert.match(travel.note, /会員番号: JL-0099/);
  assert.match(travel.note, /予備コード: rescue-42/);
  assert.match(travel.note, /TOTP: otpauth:\/\/totp\/Second/);
  assert.equal(find(out, '病院の診察券').type, 'note');
  assert.match(find(out, 'デビットカード').note, /カード番号: 4000056655665556\nセキュリティコード: 777\n有効期限: 2028-11\nPIN: 2468/);
  assert.match(find(out, 'ニュースレター用').note, /エイリアス: news\.goro@passmail\.net/);
  assert.match(find(out, '社員証').note, /社員番号: A-5050\n電話: 090-0000-0000/);
  assert.equal(find(out, '古い形式のログイン').username, 'legacy');
  for (const w of ['クレジットカード 1 件をセキュアノートとして読み込みました', 'メールエイリアス 1 件をセキュアノートとして読み込みました',
    '個人情報 1 件をセキュアノートとして読み込みました']) assert.ok(out.warnings.includes(w), w);
  assert.ok(out.warnings.some((w) => /パスキー 1 件/.test(w)));
}

test('Proton Pass ZIP and bare data.json', async () => {
  const zip = makeZip({ 'Proton Pass/data.json': fx('protonpass/data.json'), 'Proton Pass/files/abc.bin': 'x' });
  const out = await protonpass.parse({ name: 'Proton Pass_export.zip', bytes: zip }, {});
  checkProton(out);
  assert.ok(out.warnings.includes('添付ファイル 1 件は読み込まれません'));
  checkProton(await protonpass.parse({ name: 'data.json', bytes: fx('protonpass/data.json') }, {}));
});

test('Proton Pass CSV', async () => {
  const out = await protonpass.parse({ name: 'Proton Pass_export.csv', bytes: fx('protonpass/export.csv') }, {});
  allValid(out);
  assert.equal(out.items.length, 5);
  const travel = find(out, '旅行予約サイト');
  assert.equal(travel.password, 'Tabi,Suki-88');
  assert.equal(travel.url, 'https://travel.example.jp/login');
  assert.match(travel.note, /^マイルは\n家族と合算/);
  assert.match(travel.note, /URL: https:\/\/m\.travel\.example\.jp/);
  assert.equal(travel.createdAt, Date.UTC(2023, 10, 14, 22, 13, 20));
  assert.equal(find(out, 'メールのみ').username, 'only@example.jp');
  assert.equal(find(out, 'メールのみ').totp.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(find(out, '病院の診察券').type, 'note');
  assert.match(find(out, 'ニュースレター用').note, /エイリアス: news\.goro@passmail\.net/);
  assert.ok(out.warnings.includes('クレジットカード 1 件をセキュアノートとして読み込みました'));
});

test('Proton Pass: encrypted data.json is unsupported; zipped data.pgp needs a passphrase', async () => {
  await rejectsWith(protonpass.parse({ name: 'data.json', bytes: enc('{"encrypted":true,"vaults":{}}') }, {}), 'UNSUPPORTED');
  await rejectsWith(protonpass.parse({ name: 'x.zip', bytes: makeZip({ 'Proton Pass/data.pgp': 'x' }) }, {}), 'NEEDS_PASSWORD');
  await rejectsWith(protonpass.parse({ name: 'x.csv', bytes: enc('a,b\n1,2\n') }, {}), 'INVALID_FORMAT');
});

// --- hostile inputs: must finish quickly or be refused with an ImportError -----------------

/** Run `fn`; it must settle within `ms` and either succeed or throw an ImportError. */
async function fast(label, fn, ms = 200) {
  const t = performance.now();
  let out;
  try {
    out = await fn();
  } catch (e) {
    assert.equal(e.name, 'ImportError', `${label}: ${e.name}: ${e.message}`);
    out = e;
  }
  const took = performance.now() - t;
  assert.ok(took < ms, `${label} took ${Math.round(took)} ms`);
  return out;
}

test('Proton Pass CSV: URL cell full of whitespace / commas is split in linear time', async () => {
  const csv = (cell) => ({ name: 'p.csv', bytes: enc(`type,name,url\nlogin,a,"${cell}"\n`) });
  const out = await fast('80 KB of spaces', () => protonpass.parse(csv('https://a.example' + ' '.repeat(80000) + 'x'), {}));
  assert.equal(out.items.length, 1);
  await fast('commas + spaces', () => protonpass.parse(csv((', ' + ' '.repeat(40)).repeat(2000)), {}));
  await fast('commas + scheme-like runs', () => protonpass.parse(csv((',' + 'a'.repeat(40)).repeat(2000)), {}));
  await fast('newlines + spaces', () => protonpass.parse(csv(('\n' + ' '.repeat(40)).repeat(2000)), {}));
});

test('Proton Pass / Keeper / 1Password: many bad TOTPs, deep nesting and absurd dates', async () => {
  const bad = Array.from({ length: 30000 }, () => ({ type: 'totp', data: { totpUri: 'bad' } }));
  const proton = { vaults: { a: { items: [{ state: 1, data: { type: 'login', metadata: { name: 'n' }, content: { password: 'p' }, extraFields: bad } }] } } };
  const p = await fast('proton 30k bad TOTP fields', () => protonpass.parse({ name: 'x.json', bytes: enc(JSON.stringify(proton)) }, {}));
  assert.equal(p.items.length, 1);

  const deep = '{"x":'.repeat(20000) + '"v"' + '}'.repeat(20000);
  const stamp = '{"fieldName":"t","type":"timestamp","data":{"timestamp":1e300}}';
  const protonDeep = `{"vaults":{"a":{"items":[{"state":1,"data":{"type":"identity","metadata":{"name":"n"},"extraFields":[${stamp}],"content":${deep}}}]}}}`;
  const pd = await fast('proton 20000-deep content', () => protonpass.parse({ name: 'x.json', bytes: enc(protonDeep) }, {}));
  assert.match(pd.items[0].note, /t: 1e\+300/);

  const keeperLines = { records: [{ title: 't', login: 'u', custom_fields: { 'TFC:Keeper': 'bad\n'.repeat(30000) } }] };
  const k = await fast('keeper 30k bad TOTP lines', () => keeper.parse({ name: 'k.json', bytes: enc(JSON.stringify(keeperLines)) }, {}));
  assert.equal(k.items.length, 1);
  const arr = '["v",'.repeat(20000) + '{}' + ']'.repeat(20000);
  const keeperDeep = `{"records":[{"title":"t","$type":"bankCard","custom_fields":{"$x::1":${arr},"$birthDate::1":1e300}}]}`;
  const kd = await fast('keeper 20000-deep arrays', () => keeper.parse({ name: 'k.json', bytes: enc(keeperDeep) }, {}));
  assert.match(kd.items[0].note, /生年月日: 1e\+300/);

  const pux = { accounts: [{ vaults: [{ items: [{ categoryUuid: '002', overview: { title: 't' }, details: { sections: [{ fields: [{ title: 'd', value: { date: 1e300 } }] }] } }] }] }] };
  const o = await fast('1pux date 1e300', () => onepassword.parse({ name: 'export.data', bytes: enc(JSON.stringify(pux)) }, {}));
  assert.match(o.items[0].note, /d: 1e\+300/);
});

test('Bitwarden: absurd PBKDF2 iteration counts are refused before deriving', async () => {
  const j = { encrypted: true, passwordProtected: true, salt: 's', kdfType: 0, kdfIterations: 50_000_000, encKeyValidation_DO_NOT_EDIT: '2.A|A|A', data: '2.A|A|A' };
  const e = await fast('50M iterations', () => bitwarden.parse({ name: 'b.json', bytes: enc(JSON.stringify(j)) }, { password: 'p' }));
  assert.equal(e.code, 'INVALID_FORMAT');
});

test('KeePass XML: nesting depth, node count and size are capped; formatting text is dropped', async () => {
  const deep = '<KeePassFile><Root>' + '<Group><Name>g</Name>'.repeat(20000) + '</Group>'.repeat(20000) + '</Root></KeePassFile>';
  const e1 = await fast('20000-deep groups', () => keepass.parse({ name: 'x.xml', bytes: enc(deep) }, {}));
  assert.equal(e1.code, 'UNSUPPORTED');
  // Moderate nesting still imports.
  const ok = '<KeePassFile><Root>' + '<Group>'.repeat(100) + '<Entry><String><Key>Password</Key><Value>p</Value></String></Entry>' + '</Group>'.repeat(100) + '</Root></KeePassFile>';
  assert.equal((await keepass.parse({ name: 'x.xml', bytes: enc(ok) }, {})).items.length, 1);

  const many = '<KeePassFile><Root>' + '<a/>'.repeat(1_000_001) + '</Root></KeePassFile>';
  const e2 = await fast('1M+ elements', () => keepass.parse({ name: 'x.xml', bytes: enc(many) }, {}), 1000);
  assert.equal(e2.code, 'UNSUPPORTED');
  assert.match(e2.message, /大きすぎます/);

  const e3 = await fast('> 64 MiB', () => keepass.parse({ name: 'x.xml', bytes: new Uint8Array(keepass.MAX_XML_CHARS + 1) }, {}));
  assert.equal(e3.code, 'UNSUPPORTED');
  assert.throws(() => keepass.parseXml(' '.repeat(keepass.MAX_XML_CHARS + 1)), { code: 'UNSUPPORTED' });

  await fast('entity-like runs', () => keepass.parse({ name: 'x.xml', bytes: enc('<KeePassFile><Root><Group><Entry><String><Key>Notes</Key><Value>' + '&#'.repeat(50000) + '&' + 'a'.repeat(200000) + '</Value></String></Entry></Group></Root></KeePassFile>') }, {}));
  await fast('1 MB of tag whitespace', () => keepass.parse({ name: 'x.xml', bytes: enc('<KeePassFile' + ' '.repeat(1e6) + 'a="1"><Root></Root></KeePassFile>') }, {}));

  // Indentation between elements is not kept; whitespace-only values are.
  const doc = keepass.parseXml('<a>\r\n  <b>  </b>\n  <c>x\r\ny</c>\n</a>');
  assert.equal(doc.children[0].text, '');
  assert.equal(doc.children[0].children[0].text, '  ');
  assert.equal(doc.children[0].children[1].text, 'x\ny');
});

// --- through the shared entry point --------------------------------------------------------

test('parseImport runs every structured importer end to end', async () => {
  const cases = [
    ['1password', { name: 'export.1pux', bytes: onePux() }, 7, 1],
    ['1password', { name: 'data.1pif', bytes: fx('1password/export.1pif') }, 4, 1],
    ['bitwarden', { name: 'bitwarden.json', bytes: fx('bitwarden/export.json') }, 6, 1],
    ['dashlane', { name: 'dashlane.zip', bytes: dashlaneZip() }, 8, 0],
    ['enpass', { name: 'enpass.json', bytes: fx('enpass/export.json') }, 5, 1],
    ['keeper', { name: 'keeper.json', bytes: fx('keeper/export.json') }, 5, 0],
    ['keepass', { name: 'keepass.xml', bytes: fx('keepass/export.xml') }, 5, 2],
    ['protonpass', { name: 'proton.csv', bytes: fx('protonpass/export.csv') }, 5, 0],
  ];
  for (const [source, file, count, skipped] of cases) {
    const out = await parseImport({ source, file });
    assert.equal(out.source, source);
    assert.equal(out.items.length, count, `${source} ${file.name}`);
    assert.equal(out.skipped, skipped, `${source} ${file.name}`);
  }
});
