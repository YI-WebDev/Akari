import { pick } from '../csv.js';
import { t } from '../../../shared/i18n.js';
import { isTruthy } from '../model.js';
import { ITEM_TYPES, fieldLabel, hasTemplate, typeLabel } from '../../../shared/item-types.js';
import { collect, entry, otpOf, readCsv, routeToTemplate } from './_csv.js';
import { normKey } from './_values.js';

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
const TYPE_COLUMNS = new Set(['type', 'itemtype', 'アイテムタイプ', '種類', '種別', 'タイプ']);
const FOLDERISH = new Set([...TYPE_COLUMNS, 'folder', 'grouping', 'group', 'vault', 'category', 'tags', 'tag', 'reprompt', 'フォルダ', 'フォルダー', 'グループ', 'カテゴリ', 'カテゴリー', '保管庫']);

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

function typeIndex() {
  const m = new Map();
  for (const ty of ITEM_TYPES) {
    for (const name of [ty.id, ty.label, typeLabel(ty.id), ...(TYPE_NAMES[ty.id] || [])]) m.set(normKey(name), ty.id);
  }
  return m;
}

const SECRET_ROLES = ['password', 'totp'];

const ROLE_ALIASES = {
  username: SYNONYMS.username, password: SYNONYMS.password, url: SYNONYMS.url, email: SYNONYMS.email, website: SYNONYMS.url,
};

const ownValue = (rec, h) => (Object.hasOwn(rec, h) ? String(rec[h] ?? '') : '');

const normHeader = (h) => h.normalize('NFKC').toLowerCase().replace(/[\s_\-.]+/g, '');

function classifyColumns(headers) {
  const cols = Object.fromEntries(Object.keys(SYNONYMS).map((k) => [k, []]));
  const rest = [];
  for (const h of headers) {
    if (!h) continue;
    const n = normHeader(h);
    const role = Object.keys(SYNONYMS).find((k) => SYNONYMS[k].includes(n));
    if (role) cols[role].push({ h, n }); else rest.push({ h, n });
  }
  for (const [role, list] of Object.entries(cols)) {
    list.sort((a, b) => SYNONYMS[role].indexOf(a.n) - SYNONYMS[role].indexOf(b.n));
    cols[role] = list.map((c) => c.h);
  }
  return { cols, rest };
}

export const hasTypeColumn = (headers) => headers.some((h) => h && TYPE_COLUMNS.has(normHeader(h)));

let templateNames = null;
const isTemplateName = (h) => {
  templateNames ??= new Set(ITEM_TYPES.flatMap((ty) => ty.fields.flatMap((fd) => [normKey(fd.key), normKey(fd.label)])));
  return templateNames.has(normKey(h));
};

export function accepts(headers) {
  const { cols } = classifyColumns(headers);
  if (cols.password.length > 0 || (cols.url.length > 0 && cols.username.length + cols.email.length > 0)) return true;
  return hasTypeColumn(headers) && headers.some((h) => h && !TYPE_COLUMNS.has(normHeader(h)) && isTemplateName(h));
}

export async function parse(file) {
  const { headers, rawHeaders, records } = readCsv(file, accepts,
    t('Generic の CSV ではないようです（password、または url と username、または type と項目名の列が見つかりません）'));
  const { cols, rest } = classifyColumns(headers);
  const shown = new Map();
  headers.forEach((h, i) => { if (h && !shown.has(h)) shown.set(h, rawHeaders[i]); });
  const typeCols = rest.filter((c) => TYPE_COLUMNS.has(c.n)).map((c) => c.h);
  const folderish = rest.filter((c) => FOLDERISH.has(c.n) && !TYPE_COLUMNS.has(c.n)).map((c) => c.h);
  const unmapped = rest.filter((c) => !FOLDERISH.has(c.n)).map((c) => c.h);
  const typeIds = typeIndex();
  const roleOf = new Map(Object.entries(cols).flatMap(([role, list]) => list.map((h) => [h, role])));
  const nonDataHeaders = new Set([...typeCols, ...folderish]);
  const dataHeaders = [...new Set(headers)].filter((h) => h && !nonDataHeaders.has(h) && !['title', 'note', 'fav'].includes(roleOf.get(h)));
  const usedFolderish = new Set();
  const warnings = [];

  const out = collect(records, (r) => {
    for (const h of folderish) if (ownValue(r, h).trim()) usedFolderish.add(h);
    let type = 'login';
    let typeResolved = false;
    for (const h of typeCols) {
      const v = ownValue(r, h).trim();
      if (!v) continue;
      const id = typeIds.get(normKey(v));
      if (!id) usedFolderish.add(h);
      else if (!typeResolved) { type = id; typeResolved = true; }
    }

    const get = (role) => pick(r, ...cols[role]);
    const title = get('title');
    const note = get('note');
    const favRaw = String(get('fav')).trim();
    const fav = isTruthy(favRaw) || favRaw === '★';

    if (type !== 'login') {
      const pairs = dataHeaders.map((h) => [shown.get(h), ownValue(r, h), SECRET_ROLES.includes(roleOf.get(h)) ? true : undefined]);
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
    for (const h of unmapped) if (ownValue(r, h).trim()) extra.push(entry(shown.get(h), ownValue(r, h)));

    const url = get('url');
    const password = get('password');
    const isNote = !String(url).trim() && !username && !password && !totp && !!(note || extra.length);
    return { type: isNote ? 'note' : 'login', title, url, username, password, note, extra, totp, fav };
  }, warnings);
  if (usedFolderish.size) {
    warnings.push(t('次の列は Akari に対応する項目がないため取り込まれません: {columns}', { columns: [...usedFolderish].map((h) => shown.get(h)).join(', ') }));
  }
  return out;
}
