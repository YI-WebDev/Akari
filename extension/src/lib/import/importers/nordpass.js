// NordPass CSV:
// name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,
// zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type[,custom_fields]
// type: password -> login; note / credit_card / identity -> secure note listing the fields;
// folder -> skipped (just a folder entry). additional_urls and custom_fields are JSON lists.

import { appendFields, collect, fits, readCsv } from './_csv.js';
import { fieldsToNote } from '../model.js';

const SHAPE = {
  all: ['name', 'url', 'username', 'password'],
  any: ['additional_urls', 'cardholdername', 'cardnumber', 'folder', 'type', 'full_name', 'custom_fields'],
};
export const accepts = (headers) => fits(headers, SHAPE);

const CARD = [
  ['cardholdername', 'カード名義'], ['cardnumber', 'カード番号'], ['cvc', 'セキュリティコード'],
  ['pin', 'PIN'], ['expirydate', '有効期限'],
];
const IDENTITY = [
  ['full_name', '氏名'], ['phone_number', '電話番号'], ['email', 'メール'],
  ['zipcode', '郵便番号'], ['country', '国'], ['state', '都道府県'], ['city', '市区町村'],
  ['address1', '住所1'], ['address2', '住所2'], ['address3', '住所3'],
];

const jsonList = (v) => {
  try {
    const j = JSON.parse(String(v ?? ''));
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

function extraUrls(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const list = jsonList(s);
  return list ? list.map(String).filter(Boolean) : [s];
}

function customFields(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const list = jsonList(s);
  if (!list) return [['カスタム項目', s]];
  return list.map((e) => (e && typeof e === 'object'
    ? [e.label ?? e.name ?? '項目', e.value ?? '']
    : ['項目', e]));
}

export async function parse(file) {
  const { records } = readCsv(file, 'NordPass', accepts, 'name, url, username, password と type や folder などの');
  const warnings = [];
  let foldered = false;
  const out = collect(records, (r) => {
    const type = String(r.type ?? '').trim().toLowerCase();
    if (type === 'folder') return null;
    if (String(r.folder ?? '').trim()) foldered = true;

    const title = r.name;
    const labelled = (cols) => cols.map(([k, label]) => [label, r[k]]);
    const tail = [
      ...(extraUrls(r.additional_urls).length ? [['追加の URL', extraUrls(r.additional_urls).join(', ')]] : []),
      ...customFields(r.custom_fields),
    ];

    const isLogin = type === 'password'
      || (!['note', 'secure_note', 'credit_card', 'identity'].includes(type)
        && !!(String(r.password ?? '').trim() || String(r.username ?? '').trim() || String(r.url ?? '').trim()));
    if (isLogin) {
      // Card / identity columns are normally empty on a login row; keep them if not.
      return {
        title,
        url: r.url,
        username: r.username,
        password: r.password,
        note: appendFields(r.note, [...labelled([...CARD, ...IDENTITY]), ...tail]),
      };
    }
    const base = [['URL', r.url], ['ユーザー名', r.username], ['パスワード', r.password]];
    return {
      type: 'note',
      title,
      note: fieldsToNote([...base, ...labelled([...CARD, ...IDENTITY]), ...tail], r.note),
    };
  }, warnings);
  if (foldered) warnings.push('フォルダーの情報は取り込まれません');
  return out;
}
