// Generic CSV: any header row. Columns are recognised by synonym (case, spaces, "_", "-" and
// full/half width are ignored). Needs a password column, or url + username/email columns, or a
// type column plus a column named like a template field (see "type" below).
// Columns we do not recognise are not dropped: their values become custom fields labelled with
// the column name as written in the file (masked when the name looks like pin / secret / code /
// key / token), except folder-like columns such as folder/vault, which are reported in a warning.
// A row with no url, user name, password or TOTP but with a note or custom fields becomes a
// secure note.
//
// A `type` column (also 種類 / タイプ / item type …) may hold an Akari item type — its id
// ('card', 'sshKey'), its Japanese name ('クレジットカード') or an English one ('Credit Card',
// 'Wi-Fi'). Such a row becomes that type: every other column whose name is a template key (or
// the key's Japanese label) fills that key, the rest become custom fields. Other `type` values
// are organisational and reported like the other folder-like columns.

import { pick } from '../csv.js';
import { isTruthy } from '../model.js';
import { ITEM_TYPES, fieldLabel, hasTemplate, typeLabel } from '../../../shared/item-types.js';
import { collect, entry, normKey, otpOf, readCsv, routeToTemplate } from './_csv.js';

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
// Columns that may name the item type; when the value is not an Akari type they are organisational.
const TYPE_COLUMNS = new Set(['type', 'itemtype', 'アイテムタイプ', '種類', '種別', 'タイプ']);
// Organisational columns Akari has no place for.
const FOLDERISH = new Set([...TYPE_COLUMNS, 'folder', 'grouping', 'group', 'vault', 'category', 'tags', 'tag', 'reprompt', 'フォルダ', 'フォルダー', 'グループ', 'カテゴリ', 'カテゴリー', '保管庫']);

// English (and a few foreign) names for item types, besides the id and the Japanese label.
const TYPE_NAMES = {
  login: ['password'],
  note: ['notes', 'secure note', 'securenote', 'memo', 'ノート', 'メモ'],
  card: ['credit card', 'payment card', 'debit card', 'creditcard'],
  identity: ['personal info', 'personal information'],
  apiCredential: ['api credential', 'api credentials', 'api key', 'api'],
  database: [],
  server: [],
  softwareLicense: ['software license', 'software licence', 'license', 'licence'],
  sshKey: ['ssh key', 'ssh'],
  wifi: ['wi-fi', 'wifi network', 'wi-fi network', 'wi-fi password', 'wireless network'],
  bankAccount: ['bank account', 'bank'],
  cryptoWallet: ['crypto wallet', 'cryptocurrency wallet', 'wallet'],
  driverLicense: ["driver's license", 'drivers license', 'driver license', "driver's licence", 'driving licence'],
  medicalRecord: ['medical record', 'medical', 'health insurance'],
  membership: [],
  passport: [],
  rewardProgram: ['reward program', 'rewards program', 'rewards', 'loyalty'],
  socialSecurity: ['social security', 'social security number', 'ssn'],
};

/** Normalised type name → Akari type id. */
function typeIndex() {
  const m = new Map();
  for (const ty of ITEM_TYPES) {
    for (const name of [ty.id, ty.label, typeLabel(ty.id), ...(TYPE_NAMES[ty.id] || [])]) m.set(normKey(name), ty.id);
  }
  return m;
}

// Login-ish columns fill the template keys of the same name (server.username, identity.email, …).
const ROLE_ALIASES = {
  username: SYNONYMS.username, password: SYNONYMS.password, url: SYNONYMS.url, email: SYNONYMS.email, website: SYNONYMS.url,
};

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

/** Does the header row have a column that may name the item type (type / 種類 / item type …)? */
export const hasTypeColumn = (headers) => headers.some((h) => h && TYPE_COLUMNS.has(norm(h)));

// Every template key and Japanese label of every type, normalised (built on first use).
let templateNames = null;
const isTemplateName = (h) => {
  templateNames ??= new Set(ITEM_TYPES.flatMap((ty) => ty.fields.flatMap((fd) => [normKey(fd.key), normKey(fd.label)])));
  return templateNames.has(normKey(h));
};

/**
 * A password column, or url + username/email, or a type column together with at least one
 * column named like a template field (key or Japanese label) of any item type.
 */
export function accepts(headers) {
  const { cols } = plan(headers);
  if (cols.password.length > 0 || (cols.url.length > 0 && cols.username.length + cols.email.length > 0)) return true;
  return hasTypeColumn(headers) && headers.some((h) => h && !TYPE_COLUMNS.has(norm(h)) && isTemplateName(h));
}

export async function parse(file) {
  const { headers, rawHeaders, records } = readCsv(file, 'Generic', accepts, 'password、または url と username、または type と項目名の');
  const { cols, rest } = plan(headers);
  // Headers are lower-cased to read records; labels shown to the user keep the file's spelling.
  const shown = new Map();
  headers.forEach((h, i) => { if (h && !shown.has(h)) shown.set(h, rawHeaders[i]); });
  const typeCols = rest.filter((c) => TYPE_COLUMNS.has(c.n)).map((c) => c.h);
  const folderish = rest.filter((c) => FOLDERISH.has(c.n) && !TYPE_COLUMNS.has(c.n)).map((c) => c.h);
  const unmapped = rest.filter((c) => !FOLDERISH.has(c.n)).map((c) => c.h);
  const typeIds = typeIndex();
  // Every column that carries item data (for rows of a non-login type), with the role it was recognised as.
  const roleOf = new Map(Object.entries(cols).flatMap(([role, list]) => list.map((h) => [h, role])));
  const skip = new Set([...typeCols, ...folderish]);
  const dataHeaders = [...new Set(headers)].filter((h) => h && !skip.has(h) && !['title', 'note', 'fav'].includes(roleOf.get(h)));
  const usedFolderish = new Set();
  const warnings = [];

  const out = collect(records, (r) => {
    for (const h of folderish) if (own(r, h).trim()) usedFolderish.add(h);
    let type = 'login';
    let typed = false;
    for (const h of typeCols) {
      const v = own(r, h).trim();
      if (!v) continue;
      const id = typeIds.get(normKey(v));
      if (!id) usedFolderish.add(h);
      else if (!typed) { type = id; typed = true; }
    }

    const get = (role) => pick(r, ...cols[role]);
    const title = get('title');
    const note = get('note');
    const favRaw = String(get('fav')).trim();
    const fav = isTruthy(favRaw) || favRaw === '★';

    if (type !== 'login') {
      const pairs = dataHeaders.map((h) => [shown.get(h), own(r, h), ['password', 'totp'].includes(roleOf.get(h)) ? true : undefined]);
      if (!hasTemplate(type)) {
        return { type, title, note, fav, extra: pairs.filter(([, v]) => v.trim()).map(([l, v, s]) => entry(l, v, s)) };
      }
      const { fields, extra } = routeToTemplate(type, pairs, ROLE_ALIASES);
      return { type, title, note, fav, fields, extra };
    }

    const email = String(get('email')).trim();
    let username = String(pick(r, ...cols.username)).trim();
    const extra = [];
    if (!username) username = email;
    else if (email && email !== username) extra.push(entry(fieldLabel('identity', 'email'), email, false));
    const { totp, extra: otpExtra } = otpOf(get('totp'));
    extra.push(...otpExtra);
    for (const h of unmapped) if (own(r, h).trim()) extra.push(entry(shown.get(h), own(r, h)));

    const url = get('url');
    const password = get('password');
    const isNote = !String(url).trim() && !username && !password && !totp && !!(note || extra.length);
    return { type: isNote ? 'note' : 'login', title, url, username, password, note, extra, totp, fav };
  }, warnings);
  if (usedFolderish.size) {
    warnings.push(`次の列は Akari に対応する項目がないため取り込まれません: ${[...usedFolderish].map((h) => shown.get(h)).join(', ')}`);
  }
  return out;
}
