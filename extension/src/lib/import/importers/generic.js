// Generic CSV: any header row. Columns are recognised by synonym (case, spaces, "_", "-" and
// full/half width are ignored). Needs a password column, or url + username/email columns.
// Columns we do not recognise are not dropped: their values go into the note as "column: value"
// lines (except folder-like columns such as folder/vault/type, which are reported in a warning).
// A row with no url, user name, password or TOTP but with a note becomes a secure note.

import { pick } from '../csv.js';
import { isTruthy } from '../model.js';
import { appendFields, collect, otpOf, readCsv } from './_csv.js';

const SYNONYMS = {
  title: ['title', 'name', 'itemname', 'sitename', 'label', 'サイト名', 'タイトル', '名前', '項目名', 'アカウント名'],
  url: ['url', 'website', 'uri', 'loginuri', 'loginurl', 'websiteurl', 'siteurl', 'weburl', 'webaddress', 'site', 'サイト', 'ウェブサイト', 'サイトurl'],
  username: ['username', 'user', 'login', 'loginusername', 'loginname', 'userid', 'ユーザー名', 'ユーザー', 'ユーザーid', 'ユーザid', 'ログインid', 'ログイン名', 'アカウント'],
  email: ['email', 'emailaddress', 'mail', 'メール', 'メールアドレス'],
  password: ['password', 'pass', 'pwd', 'passwd', 'loginpassword', 'パスワード'],
  note: ['note', 'notes', 'extra', 'comment', 'comments', 'memo', 'メモ', '備考'],
  totp: ['totp', 'otp', 'otpauth', '2fa', 'twofactor', 'twofactorauth', 'logintotp', 'otpsecret', 'totpsecret', 'ワンタイム', 'ワンタイムパスワード', '二段階認証'],
  fav: ['favorite', 'favourite', 'fav', '★', 'お気に入り'],
};
// Organisational columns Akari has no place for.
const FOLDERISH = new Set(['folder', 'grouping', 'group', 'vault', 'category', 'type', 'tags', 'tag', 'reprompt', 'フォルダ', 'フォルダー', 'グループ', 'カテゴリ', 'カテゴリー', '種類', '保管庫']);

// Own properties only: a column called "constructor" or "__proto__" must not read Object's.
const own = (rec, h) => (Object.hasOwn(rec, h) ? String(rec[h] ?? '') : '');

const norm = (h) => h.normalize('NFKC').toLowerCase().replace(/[\s_\-.]+/g, '');

/** Header row → which header(s) feed each field, in priority order, plus the unrecognised ones. */
function plan(headers) {
  const cols = Object.fromEntries(Object.keys(SYNONYMS).map((k) => [k, []]));
  const rest = [];
  for (const h of headers) {
    if (!h) continue;
    const n = norm(h);
    const role = Object.keys(SYNONYMS).find((k) => SYNONYMS[k].includes(n));
    if (role) cols[role].push({ h, n }); else rest.push({ h, n });
  }
  for (const [role, list] of Object.entries(cols)) {
    list.sort((a, b) => SYNONYMS[role].indexOf(a.n) - SYNONYMS[role].indexOf(b.n));
    cols[role] = list.map((c) => c.h);
  }
  return { cols, rest };
}

export function accepts(headers) {
  const { cols } = plan(headers);
  return cols.password.length > 0 || (cols.url.length > 0 && cols.username.length + cols.email.length > 0);
}

export async function parse(file) {
  const { headers, records } = readCsv(file, 'Generic', accepts, 'password、または url と username の');
  const { cols, rest } = plan(headers);
  const folderish = rest.filter((c) => FOLDERISH.has(c.n)).map((c) => c.h);
  const unmapped = rest.filter((c) => !FOLDERISH.has(c.n)).map((c) => c.h);
  const usedFolderish = new Set();
  const warnings = [];

  const out = collect(records, (r) => {
    for (const h of folderish) if (own(r, h).trim()) usedFolderish.add(h);
    const get = (role) => pick(r, ...cols[role]);
    const email = String(get('email')).trim();
    let username = String(pick(r, ...cols.username)).trim();
    const fields = [];
    if (!username) username = email;
    else if (email && email !== username) fields.push(['メール', email]);
    const { totp, fields: otpFields } = otpOf(get('totp'));
    fields.push(...otpFields);
    for (const h of unmapped) fields.push([h, own(r, h)]);

    const url = get('url');
    const password = get('password');
    const note = appendFields(get('note'), fields);
    const isNote = !String(url).trim() && !username && !password && !totp && !!note;
    const favRaw = String(get('fav')).trim();
    return {
      type: isNote ? 'note' : 'login',
      title: get('title'),
      url,
      username,
      password,
      note,
      totp,
      fav: isTruthy(favRaw) || favRaw === '★',
    };
  }, warnings);
  if (usedFolderish.size) {
    warnings.push(`次の列は Akari に対応する項目がないため取り込まれません: ${[...usedFolderish].join(', ')}`);
  }
  return out;
}
