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
import { toDate, toMonth, monthOf, wifiSecurity, looksSecret } from '../../extension/src/lib/import/importers/_fields.js';
import { TYPE_IDS, typeOf, personName } from '../../extension/src/shared/item-types.js';
import { toBitwardenJson } from '../../extension/src/lib/export/bitwarden.js';

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
/**
 * Every item an importer returns must survive the shared normaliser, keep only the keys of its
 * type (no url / username / password on notes and typed items) and store language-neutral data.
 */
const allValid = (out) => {
  for (const it of out.items) {
    const m = makeImported(it);
    assert.ok(m, `item "${it.title}" was dropped by makeImported`);
    assert.equal(m.type, it.type, `item "${it.title}" changed type`);
    if (it.type !== 'login') {
      for (const k of ['url', 'username', 'password', 'totp', 'passkeys']) assert.ok(!(k in it), `"${it.title}" (${it.type}) has ${k}`);
    }
    for (const [k, v] of Object.entries(m.fields || {})) {
      assert.deepEqual(m.fields[k], it.fields[k], `"${it.title}" field ${k} was dropped or changed by makeImported`);
      if (/^(birthDate|issuedOn|since|purchaseDate)$/.test(k) || (k === 'expiry' && it.type !== 'card')) assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${it.title}.${k}`);
    }
    if (it.type === 'card' && m.fields.expiry) assert.match(m.fields.expiry, /^\d{4}-\d{2}$/);
    if (it.type === 'wifi' && m.fields.security) assert.match(m.fields.security, /^(wpa3|wpa2|wpa|wep|none)$/);
    for (const e of it.extra || []) assert.equal(typeof e.secret, 'boolean', `"${it.title}" extra "${e.label}" secret flag`);
  }
};
/** The extra field labelled `label` (it must exist). */
const extra = (it, label) => {
  const e = it.extra?.find((x) => x.label === label);
  assert.ok(e, `extra "${label}" missing on "${it.title}"; got ${(it.extra || []).map((x) => x.label).join(', ')}`);
  return e;
};
const noExtra = (it, label) => assert.ok(!it.extra?.some((x) => x.label === label), `"${it.title}" should not have extra "${label}"`);
const noNoteWarnings = (out) => assert.ok(!out.warnings.some((w) => /セキュアノート/.test(w)), out.warnings.join(' / '));

// --- shared helpers (_fields.js) -----------------------------------------------------------

test('date, expiry and Wi-Fi security normalisation', () => {
  assert.equal(toDate(631152000), '1990-01-01'); // unix seconds
  assert.equal(toDate(631152000000), '1990-01-01'); // ms
  assert.equal(toDate(-315619200), '1960-01-01'); // before 1970
  assert.equal(toDate('2021-3-5'), '2021-03-05');
  assert.equal(toDate('1988/02/29'), '1988-02-29');
  assert.equal(toDate('2024-05-06T07:08:09Z'), '2024-05-06');
  assert.equal(toDate('2027年3月31日'), '2027-03-31');
  assert.equal(toDate('29/02/1988'), '1988-02-29'); // only D/M/Y fits
  assert.equal(toDate('12/31/2030'), '2030-12-31'); // only M/D/Y fits
  assert.equal(toDate('04/05/2032'), ''); // ambiguous: keep the raw text
  assert.equal(toDate('1 April 2022'), '2022-04-01');
  for (const bad of ['1991', 'Expiry', '2023-02-30', 1e300, '', null]) assert.equal(toDate(bad), '', String(bad));

  assert.equal(toMonth(202812), '2028-12'); // 1Password monthYear
  assert.equal(toMonth('2028-11'), '2028-11');
  assert.equal(toMonth('03/27'), '2027-03');
  assert.equal(toMonth('12/2029'), '2029-12');
  assert.equal(toMonth('0528'), '2028-05');
  assert.equal(toMonth('122029'), '2029-12');
  assert.equal(toMonth('2030-06-01'), '2030-06');
  assert.equal(toMonth(1893456000), '2030-01');
  for (const bad of ['202920', '13/27', 'soon', '']) assert.equal(toMonth(bad), '', bad);
  assert.equal(monthOf('4', '2029'), '2029-04');
  assert.equal(monthOf('11', '27'), '2027-11');
  assert.equal(monthOf('', '2029'), '');

  const sec = { WPA3: 'wpa3', 'WPA2 Personal': 'wpa2', wpa2p: 'wpa2', 'WPA/WPA2': 'wpa2', WPA: 'wpa', wep: 'wep', None: 'none', なし: 'none', 'enterprise-x': '' };
  for (const [raw, id] of Object.entries(sec)) assert.equal(wifiSecurity(raw), id, raw);

  for (const s of ['PIN', 'Support PIN', 'API Key', 'パスワード', '暗証番号', '合言葉', 'recovery seed']) assert.ok(looksSecret(s), s);
  for (const s of ['アカウント ID', 'Public key', '公開鍵', 'Pinterest', 'Keyboard layout']) assert.ok(!looksSecret(s), s);

  // Name parts without a full-name string of their own: family name first for CJK names only.
  assert.equal(personName('三郎', '', '田中'), '田中 三郎');
  assert.equal(personName('Hanako', 'M', 'Yamada'), 'Hanako M Yamada');
  assert.equal(personName('', '', 'Yamada'), 'Yamada');
});

// --- 1Password -----------------------------------------------------------------------------

const onePux = () => makeZip({
  'export.attributes': fx('1password/1pux/export.attributes'),
  'export.data': fx('1password/1pux/export.data'),
  'files/DOC0001__保険証.pdf': 'synthetic pdf bytes',
});

test('1Password 1pux: logins, TOTP, favourites, URLs, typed items, trash', async () => {
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
  assert.equal(shop.note, '家族共有のアカウント。'); // custom fields are extra fields now, not note lines
  assert.equal(extra(shop, 'URL').value, 'https://app.shop.example.jp');
  assert.deepEqual(extra(shop, '秘密の質問の答え'), { label: '秘密の質問の答え', value: 'ポチ', secret: true });
  assert.equal(extra(shop, 'タグ').value, '買い物, 家族');
  assert.ok(!shop.extra.some((e) => /remember|✓/.test(e.label + e.value))); // checkbox form fields are noise

  const memo = find(out, '家電メモ');
  assert.equal(memo.type, 'note');
  assert.match(memo.note, /NR-F1234/);

  const card = find(out, 'マスターカード');
  assert.equal(card.type, 'card');
  assert.deepEqual(card.fields, { cardholder: 'HANAKO YAMADA', number: '5555555555554444', expiry: '2028-12', cvv: '321' });
  assert.equal(card.note, 'ETC カード付き');
  assert.equal(extra(card, '住所').value, '丸の内 1-1, 千代田区, 東京都, 100-0005, jp');
  assert.equal(extra(card, '電話').value, '0120-000-000');
  noExtra(card, '種類'); // "mc": Akari tells the brand from the number

  const router = find(out, 'ルーター管理画面'); // archived "Password" item is still imported
  assert.equal(router.type, 'login');
  assert.equal(router.password, 'router-admin-pass');
  assert.equal(router.fav, true);

  const wifi = find(out, '自宅の Wi-Fi');
  assert.equal(wifi.type, 'wifi');
  assert.deepEqual(wifi.fields, { ssid: 'Akari-Home-5G', password: 'wifi-secret-123', security: 'wpa2' });
  assert.match(find(out, '保険証').note, /ファイル名: 保険証\.pdf/);
  assert.equal(find(out, 'GitLab').totp.secret, 'JBSWY3DPEHPK3PXP'); // bare base32 secret

  assert.deepEqual(out.warnings.filter((w) => /セキュアノート/.test(w)), ['ドキュメント 1 件をセキュアノートとして読み込みました']);
  assert.ok(out.warnings.some((w) => /添付ファイル/.test(w)));
});

test('1Password 1pux: every category with an Akari type', async () => {
  const out = await onepassword.parse({ name: 'export.data', bytes: fx('1password/types/export.data') }, {});
  allValid(out);
  assert.equal(out.items.length, 17);
  const types = Object.fromEntries(out.items.map((i) => [i.title, i.type]));
  assert.deepEqual(types, {
    社内システム: 'login', '本人（花子）': 'identity', みずほ銀行: 'bankAccount', '本番 DB': 'database', 運転免許証: 'driverLicense',
    図書館カード: 'membership', パスポート: 'passport', マイレージ: 'rewardProgram', マイナンバー: 'socialSecurity', '実家の Wi-Fi': 'wifi',
    VPS: 'server', 'クラウド API': 'apiCredential', 通院記録: 'medicalRecord', 'GitHub 用 SSH': 'sshKey', ビットコイン: 'cryptoWallet',
    写真編集ソフト: 'softwareLicense', 会社メール: 'note',
  });

  const corp = find(out, '社内システム');
  assert.equal(corp.totp.issuer, 'Corp');
  assert.equal(corp.note, '');
  assert.deepEqual(extra(corp, 'company_code'), { label: 'company_code', value: 'C-001', secret: false }); // custom login form field
  assert.deepEqual(extra(corp, '金庫の暗証番号'), { label: '金庫の暗証番号', value: '4321', secret: true });
  assert.equal(extra(corp, '入社日').value, '2015-04-01');
  assert.deepEqual(extra(corp, '予備の OTP'), { label: '予備の OTP', value: 'steam://ABCDE', secret: true });
  assert.ok(out.warnings.some((w) => /TOTP 設定 1 件はカスタムフィールド/.test(w)));

  const me = find(out, '本人（花子）');
  assert.deepEqual(me.fields, {
    firstName: '花子', middleName: 'M', lastName: '山田', birthDate: '1990-01-01', company: '灯株式会社', jobTitle: '主任',
    address1: '丸の内 1-1', city: '千代田区', state: '東京都', postalCode: '100-0005', country: 'jp', phone: '03-0000-0000',
    email: 'hanako@example.jp',
  });
  assert.equal(extra(me, '携帯').value, '090-1111-2222');
  assert.equal(extra(me, '秘密の答え').secret, true);

  assert.deepEqual(find(out, 'みずほ銀行').fields, {
    bankName: 'みずほ銀行', accountHolder: 'ヤマダ ハナコ', accountType: 'savings', routingNumber: '001', accountNumber: '1234567',
    swift: 'MHCBJPJT', pin: '9876',
  });
  const db = find(out, '本番 DB');
  assert.deepEqual(db.fields, { dbType: 'postgresql', host: 'db.example.jp', port: '5432', database: 'akari', username: 'app', password: 'db-secret' });
  assert.equal(extra(db, '接続オプション').value, 'sslmode=require');
  const dl = find(out, '運転免許証');
  assert.equal(dl.fields.expiry, '2029-03-31'); // monthYear 2029/03 → last day of the month
  assert.equal(dl.fields.issuer, '東京都公安委員会');
  assert.equal(dl.fields.licenseClass, '普通');
  assert.equal(extra(dl, '国').value, '日本');
  assert.deepEqual(find(out, '図書館カード').fields, {
    organization: '千代田区立図書館', memberName: '山田 花子', memberId: 'L-0042', since: '2015-04-01', expiry: '2026-12-31', pin: '1122',
    url: 'https://library.example.jp',
  });
  const pp = find(out, 'パスポート');
  assert.deepEqual(pp.fields, {
    fullName: 'YAMADA HANAKO', number: 'TR1234567', nationality: 'JAPAN', issuingCountry: 'JPN', birthDate: '1990-01-01',
    issuedOn: '2020-06-01', expiry: '2030-06-01', authority: 'MINISTRY OF FOREIGN AFFAIRS',
  });
  assert.equal(extra(pp, '本籍').value, 'TOKYO');
  const miles = find(out, 'マイレージ');
  assert.deepEqual(miles.fields, { company: 'ANA', memberName: 'YAMADA HANAKO', memberId: '1234567890', pin: '5555', url: 'https://www.ana.co.jp' });
  assert.equal(extra(miles, '入会').value, '2010-01');
  assert.deepEqual(find(out, 'マイナンバー').fields, { fullName: '山田 花子', number: '123456789012' });
  const wifi = find(out, '実家の Wi-Fi');
  assert.deepEqual(wifi.fields, { ssid: 'Jikka-WiFi', password: 'jikka-pass' });
  assert.equal(extra(wifi, 'セキュリティ').value, 'enterprise-x'); // not one of the options: kept as is
  assert.equal(extra(wifi, 'ベースステーションのパスワード').secret, true);
  const vps = find(out, 'VPS');
  assert.deepEqual(vps.fields, { host: 'vps.example.jp', username: 'root', password: 'root-pass', url: 'https://panel.example.jp' });
  assert.equal(extra(vps, '管理パスワード').secret, true);
  const api = find(out, 'クラウド API');
  assert.deepEqual(api.fields, { host: 'api.example.jp', keyId: 'AKIAEXAMPLE', secret: 'wJalrXUtnFEMI', expiry: '2026-12-31' });
  assert.equal(extra(api, '開始日').value, '2024-01-01');
  const med = find(out, '通院記録');
  assert.deepEqual(med.fields, { patientName: '山田 花子', provider: 'あかりクリニック', doctor: '佐藤 医師', medications: 'ビタミン剤' });
  assert.equal(extra(med, '用量').value, '1 日 1 錠');
  noExtra(med, '患者');
  const ssh = find(out, 'GitHub 用 SSH');
  assert.deepEqual(ssh.fields, {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA1pux\n-----END OPENSSH PRIVATE KEY-----',
    publicKey: 'ssh-ed25519 AAAAC3Nza1pux hanako@example', fingerprint: 'SHA256:1puxfingerprint',
  });
  assert.deepEqual(find(out, 'ビットコイン').fields, {
    recoveryPhrase: 'abandon ability able about above absent', password: 'wallet-pass', address: 'bc1qexampleaddress0000', network: 'Bitcoin',
  });
  const lic = find(out, '写真編集ソフト');
  assert.deepEqual(lic.fields, {
    version: '2024', licenseKey: 'ABCD-EFGH-IJKL', licensee: '山田 花子', email: 'hanako@example.jp', purchaseDate: '2024-02-29',
    url: 'https://soft.example.jp/download',
  });
  assert.equal(extra(lic, '発行元').value, 'Example Soft');
  assert.match(find(out, '会社メール').note, /サーバー: mail\.example\.jp\nユーザー名: hanako\nパスワード: mail-pass/);
  assert.ok(out.warnings.includes('メールアカウント 1 件をセキュアノートとして読み込みました'));
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
  assert.equal(bank.note, '暗証番号カードは金庫の中。');
  assert.equal(extra(bank, 'URL').value, 'https://m.bank.example.jp');
  assert.equal(extra(bank, '支店').value, '本店営業部');
  assert.equal(extra(bank, 'タグ').value, 'お金');

  assert.equal(find(out, '旅行の持ち物').type, 'note');
  const card = find(out, 'JCB カード');
  assert.equal(card.type, 'card');
  // Section values and the duplicated flat legacy keys (expiry_mm / expiry_yy) agree: kept once.
  assert.deepEqual(card.fields, { cardholder: 'TARO YAMADA', number: '3530111333300000', expiry: '2030-07', cvv: '999' });
  assert.deepEqual(card.extra, [{ label: '発行日', value: '2023-11-14', secret: false }]);
  const me = find(out, '本人情報');
  assert.equal(me.type, 'identity');
  assert.deepEqual(me.fields, {
    firstName: '太郎', lastName: '山田', birthDate: '1990-01-01', address1: '梅田 1-1', city: '大阪市', state: '大阪府',
    postalCode: '530-0001', country: 'jp',
  });
  noNoteWarnings(out);
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
  assert.equal(portal.note, 'VPN 接続が必要です。');
  assert.deepEqual(portal.extra, [ // the linked field has no value of its own
    { label: 'URL', value: 'https://sso.example.co.jp', secret: false },
    { label: '社員番号', value: 'E-1024', secret: false },
    { label: 'PIN', value: '8642', secret: true }, // hidden field
    { label: '管理者', value: 'true', secret: false },
  ]);

  const steam = find(out, 'Steam');
  assert.equal(steam.totp, null);
  assert.deepEqual(extra(steam, 'ワンタイムパスワード'), { label: 'ワンタイムパスワード', value: 'steam://ABCDEFGHIJ', secret: true });

  const safe = find(out, '金庫の暗証番号');
  assert.equal(safe.type, 'note');
  assert.equal(extra(safe, '場所').value, '寝室のクローゼット');
  const card = find(out, 'メインのクレジットカード');
  assert.equal(card.type, 'card');
  assert.equal(card.fav, true);
  assert.equal(card.note, '引き落としは毎月 27 日');
  assert.deepEqual(card.fields, { cardholder: 'TARO YAMADA', number: '4111111111111111', expiry: '2029-04', cvv: '123' });
  const me = find(out, '本人情報');
  assert.equal(me.type, 'identity');
  assert.deepEqual(me.fields, {
    firstName: '太郎', lastName: '山田', address1: '千代田 1-1', city: '千代田区', state: '東京都', postalCode: '100-0001',
    country: 'JP', email: 'taro@example.jp', phone: '03-1234-5678',
  });
  assert.deepEqual(extra(me, 'パスポート番号'), { label: 'パスポート番号', value: 'TK1234567', secret: true });
  assert.equal(extra(me, '敬称').value, 'Mr');
  const ssh = find(out, 'サーバー用 SSH 鍵');
  assert.equal(ssh.type, 'sshKey');
  assert.deepEqual(ssh.fields, {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAtestkey\n-----END OPENSSH PRIVATE KEY-----',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest akari@example', fingerprint: 'SHA256:testfingerprint',
  });

  noNoteWarnings(out);
  assert.ok(out.warnings.some((w) => /TOTP/.test(w)));
  assert.ok(out.warnings.some((w) => /パスキー 1 件/.test(w))); // the P-384 one
  return portal;
}

test('Bitwarden JSON: logins, notes, typed items, deleted items', async () => {
  checkBitwarden(await bitwarden.parse({ name: 'bitwarden_export.json', bytes: fx('bitwarden/export.json') }, {}));
});

test('Bitwarden JSON: cards, identities, SSH keys, bank accounts, driver\'s licenses, passports', async () => {
  const out = await bitwarden.parse({ name: 'types.json', bytes: fx('bitwarden/types.json') }, {});
  allValid(out);
  assert.equal(out.items.length, 7);
  const card = find(out, '家族カード');
  assert.deepEqual(card.fields, { cardholder: 'HANAKO YAMADA', number: '6250941006528599', expiry: '2027-11', cvv: '321' }); // 2-digit year
  assert.deepEqual(card.extra, [{ label: '暗証番号（ネット）', value: '2580', secret: true }]); // brand "Other" dropped: UnionPay by number

  const me = find(out, '花子の ID');
  assert.equal(me.note, 'メモ');
  assert.equal(me.fields.address2, '灯ビル 3F');
  assert.equal(me.fields.company, '灯株式会社');
  assert.deepEqual(extra(me, '社会保障番号'), { label: '社会保障番号', value: '123-45-6789', secret: true });
  assert.deepEqual(extra(me, '免許証番号'), { label: '免許証番号', value: 'DL-998877', secret: true });
  assert.equal(extra(me, '住所 3').value, '受付経由');
  assert.equal(extra(me, 'ユーザー名').value, 'hanako');

  const ssh = find(out, 'デプロイ鍵');
  assert.equal(ssh.fields.fingerprint, 'SHA256:deploy');
  assert.equal(extra(ssh, 'ホスト').value, 'deploy.example.jp');

  const bank = find(out, '給与口座');
  assert.equal(bank.type, 'bankAccount');
  assert.equal(bank.fav, true);
  assert.deepEqual(bank.fields, {
    bankName: 'あかり銀行', accountHolder: 'ヤマダ ハナコ', accountType: '普通', accountNumber: '7654321', routingNumber: '0123',
    branch: '045', pin: '1357', swift: 'AKARJPJT',
  });
  assert.equal(extra(bank, '銀行の電話番号').value, '0120-000-111');

  const dl = find(out, '免許証');
  assert.equal(dl.type, 'driverLicense');
  assert.deepEqual(dl.fields, {
    fullName: 'Hanako Yamada', number: 'D12345678', licenseClass: '普通', birthDate: '1990-01-15', issuedOn: '2020-06-01',
    expiry: '2028-06-01', issuer: '東京都公安委員会',
  });
  assert.equal(extra(dl, '発行州').value, 'Tokyo');
  assert.equal(extra(dl, '発行国').value, 'JP');

  const pp = find(out, '旅券');
  assert.equal(pp.type, 'passport');
  assert.deepEqual(pp.fields, {
    fullName: 'HANAKO YAMADA', number: 'TT7654321', nationality: 'JAPAN', issuingCountry: 'JPN', birthDate: '1990-01-15',
    issuedOn: '2021-03-01', expiry: '2031-03-01', authority: 'MINISTRY OF FOREIGN AFFAIRS',
  });
  assert.equal(extra(pp, '出生地').value, 'TOKYO');

  const future = find(out, '未来の種類');
  assert.equal(future.type, 'note');
  assert.equal(future.note, '新しい種類のアイテム');
  assert.deepEqual(out.warnings, ['種類の分からないアイテム 1 件をセキュアノートとして読み込みました']);
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

test('Dashlane ZIP of CSVs: credentials with TOTP, notes, payments / IDs / personal info as typed items', async () => {
  const out = await dashlane.parse({ name: 'dashlane.zip', bytes: dashlaneZip() }, {});
  allValid(out);
  assert.equal(out.items.length, 8);
  const rakuten = find(out, '楽天市場');
  assert.equal(rakuten.type, 'login');
  assert.equal(rakuten.username, 'hanako@example.jp');
  assert.equal(rakuten.password, 'Ichiba,2024!');
  assert.equal(rakuten.url, 'https://www.rakuten.co.jp');
  assert.equal(rakuten.totp.issuer, 'Rakuten');
  assert.equal(rakuten.note, 'ポイントは月末に失効\n要確認');
  assert.equal(extra(rakuten, 'ユーザー名 2').value, 'hanako');
  assert.equal(extra(rakuten, 'カテゴリ').value, '買い物');
  assert.equal(find(out, '社内 Wiki').totp.secret, 'GEZDGNBVGY3TQOJQ');
  assert.deepEqual(extra(find(out, 'Steam'), 'ワンタイムパスワード'), { label: 'ワンタイムパスワード', value: 'steam://XYZ', secret: true });
  const wifi = find(out, 'Wi-Fi のメモ');
  assert.equal(wifi.type, 'note');
  assert.match(wifi.note, /SSID: Akari-Guest/);
  const card = find(out, '三井住友カード');
  assert.equal(card.type, 'card');
  assert.deepEqual(card.fields, { cardholder: 'TARO YAMADA', number: '4980000000000000', cvv: '456', expiry: '2030-05' });
  assert.equal(card.note, '家族カード');
  assert.equal(extra(card, '国').value, 'JP');
  const bank = find(out, 'ゆうちょ銀行');
  assert.equal(bank.type, 'bankAccount');
  assert.deepEqual(bank.fields, { accountHolder: '山田 太郎', accountNumber: '1234567' });
  const pp = find(out, '山田 太郎');
  assert.equal(pp.type, 'passport');
  assert.deepEqual(pp.fields, { fullName: '山田 太郎', number: 'TK7654321', issuedOn: '2020-04-01', expiry: '2030-04-01', authority: '東京都' });
  const mail = find(out, '個人メール');
  assert.equal(mail.type, 'identity');
  assert.deepEqual(mail.fields, { email: 'taro@example.jp' });
  noNoteWarnings(out);
});

test('Dashlane: ID kinds, merged personal info, IBAN accounts, legacy typed sections', async () => {
  const ids = await dashlane.parse({ name: 'ids.csv', bytes: fx('dashlane/types/ids.csv') }, {});
  allValid(ids);
  assert.deepEqual(ids.items.map((i) => i.type), ['driverLicense', 'socialSecurity', 'socialSecurity', 'note']);
  assert.deepEqual(ids.items[0].fields, { fullName: '山田 花子', number: '301234567890', issuedOn: '2021-03-05', expiry: '2026-04-05', issuer: '東京都公安委員会' });
  assert.deepEqual(ids.items[1].fields, { fullName: 'Hanako Yamada', number: '123-45-6789' });
  assert.equal(ids.items[2].fields.number, 'AB1234567'); // national ID card
  assert.match(ids.items[3].note, /番号: 98765/); // tax numbers have no Akari type
  assert.deepEqual(ids.warnings, ['税番号 1 件をセキュアノートとして読み込みました']);

  // One "name" row: the email, phone and address rows belong to the same person.
  const info = await dashlane.parse({ name: 'personalInfo.csv', bytes: fx('dashlane/types/personalInfo.csv') }, {});
  allValid(info);
  assert.equal(info.items.length, 1);
  const me = info.items[0];
  assert.equal(me.title, 'Hanako Yamada');
  assert.deepEqual(me.fields, {
    firstName: 'Hanako', lastName: 'Yamada', birthDate: '1990-01-15', email: 'hanako@example.jp', phone: '090-1111-2222',
    address1: '丸の内 1-1', address2: '灯ビル 301', city: '千代田区', state: '東京都', postalCode: '100-0005', country: 'JP', jobTitle: 'Engineer',
  });
  assert.equal(extra(me, '敬称').value, 'Ms');
  assert.equal(extra(me, '出生地').value, 'Tokyo');

  const pay = await dashlane.parse({ name: 'payments.csv', bytes: fx('dashlane/types/payments.csv') }, {});
  allValid(pay);
  assert.deepEqual(find(pay, 'Deutsche Konto').fields, {
    bankName: 'Deutsche Bank', accountHolder: 'Hanako Yamada', iban: 'DE89 3704 0044 0532 0130 00', swift: 'DEUTDEFF',
  });
  assert.equal(find(pay, 'PayPal').type, 'note');
  assert.deepEqual(pay.warnings, ['支払い情報 1 件をセキュアノートとして読み込みました']);

  const legacy = await dashlane.parse({ name: 'dashlane.json', bytes: fx('dashlane/legacy-types.json') }, {});
  allValid(legacy);
  assert.deepEqual(find(legacy, '旧口座').fields, {
    bankName: '旧銀行', accountHolder: 'TARO YAMADA', iban: 'FR1420041010050500013M02606', swift: 'OLDBJPJT',
  });
  const pp = find(legacy, 'TARO YAMADA');
  assert.deepEqual(pp.fields, {
    fullName: 'TARO YAMADA', number: 'TK0000001', issuedOn: '2015-07-01', expiry: '2025-07-01', authority: '東京都', birthDate: '1985-12-24',
  });
  assert.ok(!pp.extra.some((e) => e.label === 'id')); // bookkeeping keys are dropped
  assert.deepEqual(find(legacy, 'Taro Yamada').fields, { firstName: 'Taro', lastName: 'Yamada', birthDate: '1985-12-24' });
  assert.equal(find(legacy, '税務情報').type, 'note');
  assert.deepEqual(legacy.warnings, ['税務情報 1 件をセキュアノートとして読み込みました']);
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
  const oldCard = find(legacy, '旧カード');
  assert.deepEqual(oldCard.fields, { cardholder: 'TARO YAMADA', number: '4111111111111111', cvv: '111', expiry: '2031-01' });
  assert.equal(extra(oldCard, 'bank').value, 'テスト銀行');
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
  assert.equal(mail.note, 'メインのメールアカウント');
  assert.deepEqual(mail.extra, [ // deleted fields and section headers are left out
    { label: 'メール', value: 'jiro@example.jp', secret: false },
    { label: '予備のサイト', value: 'https://webmail.example.jp', secret: false },
    { label: '秘密の質問', value: '初めて飼ったペットは？', secret: false },
  ]);

  const onlyEmail = find(out, 'メールだけのログイン');
  assert.equal(onlyEmail.username, 'only-email@example.jp');
  assert.equal(onlyEmail.totp.period, 60);

  assert.equal(find(out, '引っ越しメモ').type, 'note');
  const amex = find(out, 'アメックス'); // archived items are still imported
  assert.equal(amex.type, 'card');
  assert.deepEqual(amex.fields, { cardholder: 'JIRO SATO', number: '378282246310005', expiry: '2027-09', cvv: '1234' });
  assert.equal(amex.note, '海外旅行用');
  const wifi = find(out, '会社の Wi-Fi');
  assert.equal(wifi.type, 'wifi');
  assert.deepEqual(wifi.fields, { ssid: 'Akari-Office', password: 'office-wifi-pass' });
  noNoteWarnings(out);
  assert.ok(out.warnings.includes('添付ファイル 1 件は読み込まれません'));
  await rejectsWith(enpass.parse({ name: 'x.json', bytes: enc('{"records":[]}') }, {}), 'INVALID_FORMAT');
});

test('Enpass JSON: identity, bank account, passport, driving licence, database, Wi-Fi, membership templates', async () => {
  const out = await enpass.parse({ name: 'types.json', bytes: fx('enpass/types.json') }, {});
  allValid(out);
  const me = find(out, '次郎の個人情報');
  assert.deepEqual(me.fields, { // identity fields are found by their uid, whatever the UI language
    firstName: '次郎', lastName: '佐藤', birthDate: '1988-02-29', address1: '梅田 1-1', city: '大阪市', state: '大阪府', country: '日本',
    postalCode: '530-0001', phone: '06-0000-0000', company: '灯株式会社', email: 'jiro@example.jp',
  });
  assert.deepEqual(extra(me, '社会保障番号'), { label: '社会保障番号', value: '987-65-4321', secret: true });
  const bank = find(out, 'あかり銀行');
  assert.equal(bank.type, 'bankAccount');
  assert.equal(bank.fav, true);
  assert.deepEqual(bank.fields, {
    bankName: 'あかり銀行', accountHolder: 'サトウ ジロウ', pin: '2468', accountType: '普通', accountNumber: '1112223', routingNumber: '045', swift: 'AKARJPJT',
  });
  assert.equal(extra(bank, 'ログインパスワード').secret, true);
  const pp = find(out, '次郎のパスポート');
  assert.deepEqual(pp.fields, {
    fullName: 'JIRO SATO', number: 'TZ1112223', nationality: 'JAPAN', issuingCountry: 'JPN', birthDate: '1988-02-29', issuedOn: '2022-04-01', authority: '外務省',
  });
  assert.equal(extra(pp, 'Expiry date').value, '04/05/2032'); // day/month order unknown: kept as written
  assert.deepEqual(find(out, '運転免許').fields, {
    number: '620000000001', fullName: '佐藤 次郎', licenseClass: '中型', expiry: '2027-03-31', issuedOn: '2023-11-14',
  });
  assert.deepEqual(find(out, '分析用 DB').fields, {
    dbType: 'MySQL', host: 'analytics.example.jp', port: '3306', database: 'events', username: 'reader', password: 'reader-pass',
  });
  assert.deepEqual(find(out, 'カフェの Wi-Fi').fields, { ssid: 'Cafe-Akari', password: 'latte-123', security: 'wpa2' });
  assert.deepEqual(find(out, 'スポーツクラブ').fields, { organization: 'Akari Gym', memberName: 'Jiro Sato', memberId: 'G-77', since: '2023-04-01', pin: '0707' });
  assert.match(find(out, 'プロバイダー').note, /ユーザー名: isp-user/); // internet provider: no Akari type
  assert.deepEqual(out.warnings, ['コンピューター 1 件をセキュアノートとして読み込みました']);
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
  assert.equal(bank.note, '第二暗証番号は別管理');
  assert.deepEqual(bank.extra, [
    { label: '予備 URL', value: 'https://bank2.example.jp', secret: false },
    { label: '合言葉', value: 'さくら', secret: true }, // legacy field named like a secret
    { label: '秘密の質問', value: '母の旧姓は？', secret: false },
    { label: '答え', value: '鈴木', secret: true },
  ]);
  assert.ok(!bank.extra.some((e) => /TFC:Keeper|otpauth/.test(e.label + e.value)));

  const shop = find(out, 'ショッピング'); // record without $type = legacy login
  assert.equal(shop.type, 'login');
  assert.equal(shop.totp.algorithm, 'SHA256');

  const memo = find(out, '暗号化メモ');
  assert.equal(memo.type, 'note');
  assert.equal(memo.note, '鍵は玄関の植木鉢の下');
  const card = find(out, '楽天カード');
  assert.equal(card.type, 'card');
  assert.deepEqual(card.fields, { number: '5555555555554444', expiry: '2029-12', cvv: '987', cardholder: 'SABURO TANAKA', pin: '0000' });
  assert.equal(card.note, 'ポイント払い');
  const wifi = find(out, '家の Wi-Fi');
  assert.equal(wifi.type, 'wifi');
  assert.deepEqual(wifi.fields, { ssid: 'Akari-Home', password: 'home-wifi-pass' });
  noNoteWarnings(out);
});

test('Keeper JSON: record types mapped onto Akari types', async () => {
  const out = await keeper.parse({ name: 'types.json', bytes: fx('keeper/types.json') }, {});
  allValid(out);
  const types = Object.fromEntries(out.items.map((i) => [i.title, i.type]));
  assert.deepEqual(types, {
    給与口座: 'bankAccount', 三郎の連絡先: 'identity', 自宅住所: 'identity', 三郎のパスポート: 'passport', 三郎の免許: 'driverLicense',
    本番サーバー: 'server', '顧客 DB': 'database', 踏み台の鍵: 'sshKey', オフィスソフト: 'softwareLicense', 書店の会員: 'membership',
    健康保険証: 'medicalRecord', 社会保障カード: 'socialSecurity', 'ゲスト Wi-Fi': 'wifi', 出生証明書: 'note',
  });
  const bank = find(out, '給与口座');
  assert.deepEqual(bank.fields, { accountType: 'Savings', routingNumber: '0045', accountNumber: '5556667', accountHolder: 'Saburo Tanaka' });
  assert.deepEqual(extra(bank, 'パスワード'), { label: 'パスワード', value: 'net-pass', secret: true });
  const contact = find(out, '三郎の連絡先');
  assert.deepEqual(contact.fields, { firstName: '三郎', lastName: '田中', company: '灯株式会社', email: 'saburo@example.jp', phone: '090-3333-4444' });
  assert.equal(extra(contact, '電話').value, '03-5555-6666 (内線 12)');
  assert.deepEqual(find(out, '自宅住所').fields, { address1: '京都市中京区 1-2', city: '京都市', state: '京都府', postalCode: '604-0000', country: 'JP' });
  assert.deepEqual(find(out, '三郎のパスポート').fields, {
    number: 'TS2223334', fullName: 'SABURO TANAKA', birthDate: '1985-09-09', expiry: '2030-01-01', issuedOn: '2020-01-01',
  });
  assert.deepEqual(find(out, '三郎の免許').fields, { number: '600011112222', fullName: '田中 三郎', birthDate: '1985-09-09', expiry: '2028-01-01' }); // family name first
  assert.deepEqual(find(out, '本番サーバー').fields, { host: 'srv.example.jp', port: '2222', username: 'deploy', password: 'srv-pass' });
  assert.deepEqual(find(out, '顧客 DB').fields, { dbType: 'PostgreSQL', host: 'crm-db.example.jp', port: '5432', username: 'crm', password: 'crm-pass' });
  const ssh = find(out, '踏み台の鍵');
  assert.deepEqual(ssh.fields, {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEEPER\n-----END OPENSSH PRIVATE KEY-----', publicKey: 'ssh-ed25519 AAAAkeeper',
    passphrase: 'key-passphrase', host: 'bastion.example.jp', username: 'ops',
  });
  assert.equal(extra(ssh, 'ポート').value, '22');
  const lic = find(out, 'オフィスソフト');
  assert.deepEqual(lic.fields, { licenseKey: 'OFFICE-1234-5678', expiry: '2026-12-31' });
  assert.equal(extra(lic, '有効化日').value, '2024-01-01');
  assert.deepEqual(find(out, '書店の会員').fields, { memberId: 'BK-9999', memberName: '田中 三郎' });
  const med = find(out, '健康保険証');
  assert.deepEqual(med.fields, { policyNumber: 'HI-12345', patientName: '田中 三郎' }); // the insured's name
  assert.deepEqual(find(out, '社会保障カード').fields, { number: '078-05-1120', fullName: 'Saburo Tanaka' });
  const wifi = find(out, 'ゲスト Wi-Fi');
  assert.deepEqual(wifi.fields, { ssid: 'Akari-Guest', password: 'guest-pass', security: 'wpa3' });
  assert.deepEqual(extra(wifi, '管理者 PIN'), { label: '管理者 PIN', value: '8080', secret: true });
  assert.match(find(out, '出生証明書').note, /氏名: 田中 三郎\n生年月日: 1985-09-09/);
  assert.deepEqual(out.warnings, ['出生証明書 1 件をセキュアノートとして読み込みました']);
});

// --- label guesses and secrets -------------------------------------------------------------

test('label guesses never unmask a secret value or turn a word into a link', async () => {
  const fl = (label, value, sensitive = 0, type = 'text') => ({ deleted: 0, label, sensitive, type, value });
  const enpassFile = { items: [
    { category: 'computer', template_type: 'computer.apicredential', title: 'API 2 本', fields: [fl('API Key', 'AKIA-visible?', 1), fl('Secret', 'sk-1', 1)] },
    { category: 'computer', template_type: 'computer.apicredential', title: 'API 1 本', fields: [fl('API Key', 'only-key', 1)] },
    { category: 'computer', template_type: 'computer.server', title: '管理サーバー', fields: [fl('Host', 'srv.example.jp'),
      fl('Password', 'root-pass', 1, 'password'), fl('Admin Console Password', 'hunter2', 1), fl('管理画面', 'hunter3')] },
  ] };
  const en = await enpass.parse({ name: 'e.json', bytes: enc(JSON.stringify(enpassFile)) }, {});
  allValid(en);
  const two = find(en, 'API 2 本');
  assert.deepEqual(two.fields, { secret: 'sk-1' });
  assert.deepEqual(two.extra, [{ label: 'API Key', value: 'AKIA-visible?', secret: true }]);
  assert.deepEqual(find(en, 'API 1 本').fields, { secret: 'only-key' });
  const srv = find(en, '管理サーバー');
  assert.deepEqual(srv.fields, { host: 'srv.example.jp', password: 'root-pass' }); // no url: neither value is a link
  assert.deepEqual(srv.extra, [
    { label: '管理画面', value: 'hunter3', secret: false },
    { label: 'Admin Console Password', value: 'hunter2', secret: true },
  ]);

  const keeperFile = { records: [{ title: '管理サーバー', $type: 'serverCredentials', login: 'root', password: 'pw',
    custom_fields: { '$host::1': { hostName: 'k.example.jp', port: '22' }, '$url:管理画面:1': 'hunter2', '$secret:Admin Console Password:1': 'hunter3',
      '$text:Admin console URL:1': 'https://panel.example.jp' } }] };
  const kp = await keeper.parse({ name: 'k.json', bytes: enc(JSON.stringify(keeperFile)) }, {});
  allValid(kp);
  const ks = kp.items[0];
  assert.deepEqual(ks.fields, { host: 'k.example.jp', port: '22', username: 'root', password: 'pw' });
  assert.deepEqual(extra(ks, '管理画面'), { label: '管理画面', value: 'hunter2', secret: false }); // a URL field, but not a URL
  assert.deepEqual(extra(ks, 'Admin Console Password'), { label: 'Admin Console Password', value: 'hunter3', secret: true });
  assert.equal(extra(ks, 'Admin console URL').value, 'https://panel.example.jp');

  const protonFile = { vaults: { a: { items: [
    { state: 1, data: { type: 'custom', metadata: { name: 'API' }, content: { sections: [] }, extraFields: [
      { fieldName: 'API Key', type: 'hidden', data: { content: 'pk-hidden' } }, { fieldName: 'Secret', type: 'hidden', data: { content: 'sk-2' } }] } },
  ] } } };
  const pp = await protonpass.parse({ name: 'data.json', bytes: enc(JSON.stringify(protonFile)) }, {});
  allValid(pp);
  assert.deepEqual(pp.items[0].fields, { secret: 'sk-2' });
  assert.deepEqual(pp.items[0].extra, [{ label: 'API Key', value: 'pk-hidden', secret: true }]);

  const pay = 'type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,pin,country\n'
    + 'payment_card,カード,TARO,4111111111111111,123,1,2030,0000,JP\n';
  const dl = await dashlane.parse({ name: 'payments.csv', bytes: enc(pay) }, {});
  allValid(dl);
  assert.deepEqual(extra(dl.items[0], 'pin'), { label: 'pin', value: '0000', secret: true });
  const people = 'type,first_name,last_name,item_name,url\nwebsite,,,サイト,hunter2\nwebsite,,,本物,https://me.example.jp\n';
  const info = await dashlane.parse({ name: 'personalInfo.csv', bytes: enc(people) }, {});
  allValid(info);
  const word = find(info, 'サイト');
  assert.equal(word.fields.website, undefined);
  assert.equal(extra(word, 'ウェブサイト').value, 'hunter2');
  assert.equal(find(info, '本物').fields.website, 'https://me.example.jp');
  const legacy = await dashlane.parse({ name: 'd.json', bytes: enc(JSON.stringify({ PAYMENTMEANS_CREDITCARD: [
    { name: 'カード', cardNumber: '4111111111111111', owner: 'TARO', securityCode: '1', pinCode: '9999' }] })) }, {});
  assert.deepEqual(extra(legacy.items[0], 'pinCode'), { label: 'pinCode', value: '9999', secret: true });
});

// --- Akari's own Bitwarden export (akari:type) ----------------------------------------------

/** One item of each Akari type, every template field filled, plus a plain and a secret extra field. */
function everyType() {
  const value = (type, fd) => {
    if (type === 'card' && fd.key === 'number') return '4111111111111111';
    switch (fd.kind) {
      case 'secret': return `${type}-${fd.key}-s3cret`;
      case 'secret-multiline': return `${fd.key} line 1\nline 2`;
      case 'multiline': return `${fd.key} 1 行目\n2 行目`;
      case 'date': return '2030-06-01';
      case 'month': return '2030-04';
      case 'email': return `${fd.key}@example.jp`;
      case 'tel': return '090-1234-5678';
      case 'url': return `https://example.jp/${type}/${fd.key}`;
      case 'number': return '5432';
      case 'select': return fd.options[1].id;
      default: return `${type} の ${fd.key}`;
    }
  };
  return TYPE_IDS.map((type, i) => {
    const it = {
      id: `id-${type}`, type, vault: 'v1', title: `種類 ${type}`, note: type === 'note' ? 'ノート本文' : '', fav: i % 2 === 0,
      createdAt: Date.UTC(2024, 0, 1), updatedAt: Date.UTC(2024, 5, 1),
      extra: [{ label: 'メモ欄', value: `${type} のメモ`, secret: false }, { label: '合言葉', value: 'ひらけごま', secret: true }],
    };
    if (type === 'login') Object.assign(it, { url: 'https://login.example.jp/', username: 'akari', password: 'P@ss w0rd ', totp: null, passkeys: [] });
    const fields = typeOf(type).fields;
    if (fields.length) it.fields = Object.fromEntries(fields.map((fd) => [fd.key, value(type, fd)]));
    return it;
  });
}

test("Bitwarden: Akari's own export of every item type imports back unchanged", async () => {
  const originals = everyType();
  assert.equal(originals.length, 18);
  const json = toBitwardenJson({ vaults: [{ id: 'v1', name: '個人' }], items: originals });
  const out = await bitwarden.parse({ name: 'bitwarden_export.json', bytes: enc(json) }, {});
  allValid(out);
  assert.deepEqual(out.warnings, []);
  for (const o of originals) {
    const it = makeImported(find(out, o.title));
    assert.equal(it.type, o.type, o.type);
    assert.deepEqual(it.fields, o.fields, `${o.type} fields`);
    assert.deepEqual(it.extra, o.extra, `${o.type} extra`); // and never the akari:type marker itself
    assert.equal(it.note, o.note, `${o.type} note`);
    assert.equal(it.fav, o.fav);
    if (o.type === 'login') for (const k of ['url', 'username', 'password']) assert.equal(it[k], o[k], k);
  }
});

test('Bitwarden: the akari:type marker is only trusted with a known type, and never kept', async () => {
  const note = (name, fields) => ({ type: 2, name, notes: '本文', secureNote: { type: 0 }, fields });
  const f = (name, value, type = 0) => ({ name, value, type, linkedId: null });
  const file = { encrypted: false, folders: [], items: [
    note('旅券', [f('akari:type', 'passport'), f('旅券番号', 'TZ1', 1), f('氏名', 'AKARI'), f('有効期限', '2031-02-03'), f('その他', 'x')]),
    note('不明な印', [f('akari:type', 'bogus'), f('氏名', 'AKARI')]),
    note('印なし', [f('氏名', 'AKARI')]),
  ] };
  const out = await bitwarden.parse({ name: 'b.json', bytes: enc(JSON.stringify(file)) }, {});
  allValid(out);
  const pp = find(out, '旅券');
  assert.equal(pp.type, 'passport');
  assert.deepEqual(pp.fields, { number: 'TZ1', fullName: 'AKARI', expiry: '2031-02-03' });
  assert.deepEqual(pp.extra, [{ label: 'その他', value: 'x', secret: false }]);
  assert.equal(pp.note, '本文');
  for (const t of ['不明な印', '印なし']) {
    const n = find(out, t);
    assert.equal(n.type, 'note');
    assert.deepEqual(n.extra, [{ label: '氏名', value: 'AKARI', secret: false }]);
  }
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
  assert.equal(cloud.note, '本番環境 & 検証環境で共通。<注意> 90 日ごとに変更');
  assert.deepEqual(cloud.extra, [
    { label: 'URL', value: 'https://console2.example.jp/', secret: false },
    { label: 'アカウント ID', value: '1234-5678-9012', secret: false },
    { label: 'Support PIN', value: '4455', secret: true }, // named like a secret
    { label: '復旧用の番号', value: 'R-0099-1188', secret: true }, // protected in memory
    { label: 'タグ', value: '仕事, 重要', secret: false },
  ]);

  assert.deepEqual(find(out, 'VPN').totp, { secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA256', digits: 8, period: 60, issuer: '', label: 'vpn-user' });
  assert.equal(find(out, 'VPN').note, '');
  const memo = find(out, '金庫のメモ');
  assert.equal(memo.type, 'note');
  assert.equal(memo.note, '暗証番号 <1234> & 鍵の場所\n2 行目');
  assert.equal(find(out, 'Web メール').totp.secret, 'JBSWY3DPEHPK3PXP');
  const steam = find(out, 'Steam'); // HOTP cannot be used; kept as an extra field
  assert.equal(steam.totp, null);
  assert.equal(steam.note, '');
  assert.equal(extra(steam, 'otp').secret, true);
  assert.match(extra(steam, 'otp').value, /^otpauth:\/\/hotp\//);
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
  assert.equal(travel.note, 'マイルは家族と合算');
  assert.equal(extra(travel, 'URL').value, 'https://m.travel.example.jp');
  assert.equal(extra(travel, 'メール').value, 'goro@example.jp');
  assert.deepEqual(extra(travel, '会員番号'), { label: '会員番号', value: 'JL-0099', secret: false });
  assert.deepEqual(extra(travel, '予備コード'), { label: '予備コード', value: 'rescue-42', secret: true }); // hidden field
  assert.deepEqual(extra(travel, 'ワンタイムパスワード'), { label: 'ワンタイムパスワード', value: 'otpauth://totp/Second?secret=GEZDGNBVGY3TQOJQ', secret: true });
  assert.equal(find(out, '病院の診察券').type, 'note');
  const card = find(out, 'デビットカード');
  assert.equal(card.type, 'card');
  assert.deepEqual(card.fields, { cardholder: 'GORO ITO', number: '4000056655665556', expiry: '2028-11', cvv: '777', pin: '2468' });
  assert.match(find(out, 'ニュースレター用').note, /エイリアス: news\.goro@passmail\.net/);
  const badge = find(out, '社員証');
  assert.equal(badge.type, 'identity');
  assert.deepEqual(badge.fields, { fullName: '伊藤 五郎', email: 'goro@work.example.jp', company: '灯株式会社' }); // full name as written
  assert.deepEqual(badge.extra, [
    { label: '社員番号', value: 'A-5050', secret: false },
    { label: '電話', value: '090-0000-0000', secret: false },
  ]);
  assert.equal(find(out, '古い形式のログイン').username, 'legacy');
  assert.deepEqual(out.warnings.filter((w) => /セキュアノート/.test(w)), ['メールエイリアス 1 件をセキュアノートとして読み込みました']);
  assert.ok(out.warnings.some((w) => /パスキー 1 件/.test(w)));
}

test('Proton Pass: SSH keys, Wi-Fi and the "custom" templates (English and Japanese field names)', async () => {
  const out = await protonpass.parse({ name: 'data.json', bytes: fx('protonpass/types.json') }, {});
  allValid(out);
  const types = Object.fromEntries(out.items.map((i) => [i.title, i.type]));
  assert.deepEqual(types, {
    '四郎の ID': 'identity', 'ビルド用 SSH': 'sshKey', 'リビングの Wi-Fi': 'wifi', 古いルーター: 'wifi', 'Stripe API': 'apiCredential',
    '翻訳 API': 'apiCredential', '社内 DB': 'database', 'Web server': 'server', 'Euro account': 'bankAccount', イーサリアム: 'cryptoWallet',
    四郎のパスポート: 'passport', 'Driver license': 'driverLicense', かかりつけ医: 'medicalRecord', Museum: 'membership',
    ポイントカード: 'rewardProgram', 'SSN card': 'socialSecurity', 画像ソフト: 'softwareLicense', ロッカー: 'note', 買い物用エイリアス: 'note',
  });
  const me = find(out, '四郎の ID');
  assert.deepEqual(me.fields, {
    fullName: '鈴木 四郎', firstName: '四郎', lastName: '鈴木', email: 'shiro@example.jp', phone: '080-4444-5555', birthDate: '1992-07-07', company: '灯株式会社',
    jobTitle: '課長', address1: '栄 1-1', address2: '5F', city: '名古屋市', state: '愛知県', postalCode: '460-0008', country: '日本',
    website: 'https://shiro.example.jp',
  });
  assert.deepEqual(extra(me, '社会保障番号'), { label: '社会保障番号', value: '111-22-3333', secret: true });
  noExtra(me, '氏名');
  const ssh = find(out, 'ビルド用 SSH');
  assert.deepEqual(ssh.fields, {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nPROTON\n-----END OPENSSH PRIVATE KEY-----', publicKey: 'ssh-ed25519 AAAAproton',
    username: 'builder', host: 'ci.example.jp',
  });
  assert.equal(extra(ssh, 'メモ用シークレット').secret, true);
  assert.deepEqual(find(out, 'リビングの Wi-Fi').fields, { ssid: 'Akari-Living', password: 'living-pass', security: 'wpa2' });
  assert.deepEqual(find(out, '古いルーター').fields, { ssid: 'Old-Router', password: 'old-pass' }); // security unspecified

  const stripe = find(out, 'Stripe API');
  // The hidden "API Key" is matched by name only, so it is never shown as the (visible) key id.
  assert.deepEqual(stripe.fields, { secret: 'sk_live_2', expiry: '2026-12-31' });
  assert.deepEqual(stripe.extra, [{ label: 'API Key', value: 'pk_live_1', secret: true }, { label: 'Permissions', value: 'read-only', secret: false }]);
  assert.deepEqual(find(out, '翻訳 API').fields, { secret: 'deepl-key-3' }); // a lone API key is the secret
  assert.deepEqual(find(out, '社内 DB').fields, { host: 'pg.example.jp', port: '5432', username: 'admin', password: 'pg-pass', dbType: 'PostgreSQL' });
  const web = find(out, 'Web server'); // fields in a section
  assert.deepEqual(web.fields, { host: 'web.example.jp', username: 'ubuntu', password: 'web-pass' });
  assert.equal(extra(web, 'IP Address').value, '203.0.113.10');
  assert.equal(extra(web, 'Operating System').value, 'Ubuntu 24.04');
  assert.deepEqual(extra(web, 'Admin Console Password'), { label: 'Admin Console Password', value: 'hunter2', secret: true });
  assert.deepEqual(find(out, 'Euro account').fields, {
    bankName: 'Euro Bank', accountType: 'Checking', iban: 'DE89370400440532013000', swift: 'EUROBANKXXX', accountHolder: 'Shiro Suzuki',
  });
  const eth = find(out, 'イーサリアム');
  assert.deepEqual(eth.fields, {
    address: '0x00000000000000000000000000000000000000AA', privateKey: '0xprivkey', recoveryPhrase: 'zoo zoo zoo wrong', network: 'Ethereum',
  });
  assert.equal(extra(eth, 'ウォレット名').value, 'メインウォレット');
  assert.deepEqual(find(out, '四郎のパスポート').fields, {
    fullName: 'SUZUKI SHIRO', number: 'TS9998887', issuingCountry: '日本', expiry: '2033-08-31', birthDate: '1992-07-07', authority: '外務省',
  });
  assert.deepEqual(find(out, 'Driver license').fields, {
    fullName: 'Shiro Suzuki', number: 'D-55', issuer: 'Aichi', expiry: '2029-07-07', birthDate: '1992-07-07', licenseClass: 'B',
  });
  const med = find(out, 'かかりつけ医');
  // Proton hides the record number and medications; Akari's fields for them are not masked, so they stay secret extras.
  assert.deepEqual(med.fields, { patientName: '鈴木 四郎', doctor: '高橋 医師', provider: 'あかり病院' });
  assert.deepEqual(med.extra, [
    { label: 'レコード番号', value: 'MR-1', secret: true },
    { label: '医療状況', value: '花粉症', secret: true },
    { label: '服用している薬', value: '抗ヒスタミン薬', secret: true },
  ]);
  const museum = find(out, 'Museum');
  assert.deepEqual(museum.fields, { organization: 'City Museum', memberId: 'M-123', memberName: 'Shiro Suzuki', expiry: '2027-03-31' });
  assert.equal(extra(museum, 'Tier/Level').value, 'Gold');
  const points = find(out, 'ポイントカード');
  assert.deepEqual(points.fields, { company: 'あかりポイント', memberId: 'P-777', expiry: '2027-01-31' });
  assert.equal(extra(points, 'ポイント残高').value, '1200');
  noExtra(points, '有効期限');
  assert.deepEqual(find(out, 'SSN card').fields, { fullName: 'Shiro Suzuki', number: '222-33-4444' });
  const soft = find(out, '画像ソフト');
  assert.deepEqual(soft.fields, { licenseKey: 'IMG-0001', product: 'ImageEditor', expiry: '2025-12-31', licensee: '鈴木 四郎' });
  assert.deepEqual(soft.extra, []);

  const locker = find(out, 'ロッカー'); // a custom item of no known template
  assert.equal(locker.note, '自分で作った項目');
  assert.deepEqual(locker.extra, [{ label: '場所', value: '駅の東口', secret: false }, { label: '暗証番号', value: '7319', secret: true }]);
  const alias = find(out, '買い物用エイリアス');
  assert.match(alias.note, /エイリアス: shop\.shiro@passmail\.net/);
  assert.equal(extra(alias, '用途').value, '通販');
  assert.deepEqual(out.warnings, ['カスタムアイテム 1 件をセキュアノートとして読み込みました', 'メールエイリアス 1 件をセキュアノートとして読み込みました']);
});

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
  assert.equal(travel.note, 'マイルは\n家族と合算');
  assert.equal(extra(travel, 'URL').value, 'https://m.travel.example.jp');
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
  assert.equal(extra(pd.items[0], 't').value, '1e+300');

  const keeperLines = { records: [{ title: 't', login: 'u', custom_fields: { 'TFC:Keeper': 'bad\n'.repeat(30000) } }] };
  const k = await fast('keeper 30k bad TOTP lines', () => keeper.parse({ name: 'k.json', bytes: enc(JSON.stringify(keeperLines)) }, {}));
  assert.equal(k.items.length, 1);
  const arr = '["v",'.repeat(20000) + '{}' + ']'.repeat(20000);
  const keeperDeep = `{"records":[{"title":"t","$type":"bankCard","custom_fields":{"$x::1":${arr},"$birthDate::1":1e300}}]}`;
  const kd = await fast('keeper 20000-deep arrays', () => keeper.parse({ name: 'k.json', bytes: enc(keeperDeep) }, {}));
  assert.equal(extra(kd.items[0], '生年月日').value, '1e+300'); // not a date: kept as written

  const pux = { accounts: [{ vaults: [{ items: [{ categoryUuid: '002', overview: { title: 't' }, details: { sections: [{ fields: [{ title: 'd', value: { date: 1e300 } }] }] } }] }] }] };
  const o = await fast('1pux date 1e300', () => onepassword.parse({ name: 'export.data', bytes: enc(JSON.stringify(pux)) }, {}));
  assert.equal(extra(o.items[0], 'd').value, '1e+300');
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
