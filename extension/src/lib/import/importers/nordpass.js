// NordPass CSV:
// name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,
// zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type[,custom_fields]
// type: password -> login; credit_card -> card; identity -> identity; note -> secure note;
// folder -> skipped (just a folder entry). additional_urls and custom_fields are JSON lists; both
// become custom fields, as does any column that has no place in the item's type.

import { t } from '../../../shared/i18n.js';
import { fieldLabel } from '../../../shared/item-types.js';
import { collect, entry, fits, readCsv, routeToTemplate } from './_csv.js';

const SHAPE = {
  all: ['name', 'url', 'username', 'password'],
  any: ['additional_urls', 'cardholdername', 'cardnumber', 'folder', 'type', 'full_name', 'custom_fields'],
};
export const accepts = (headers) => fits(headers, SHAPE);

// column, [type, template key] it fills on a card / identity row (its label comes from there), secret?
const COLUMNS = [
  ['cardholdername', ['card', 'cardholder'], false],
  ['cardnumber', ['card', 'number'], true],
  ['cvc', ['card', 'cvv'], true],
  ['pin', ['card', 'pin'], true],
  ['expirydate', ['card', 'expiry'], false],
  ['phone_number', ['identity', 'phone'], false],
  ['email', ['identity', 'email'], false],
  ['zipcode', ['identity', 'postalCode'], false],
  ['country', ['identity', 'country'], false],
  ['state', ['identity', 'state'], false],
  ['city', ['identity', 'city'], false],
  ['address1', ['identity', 'address1'], false],
  ['address2', ['identity', 'address2'], false],
  ['address3', null, false],
];

const jsonList = (v) => {
  try {
    const j = JSON.parse(String(v ?? ''));
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

const extraUrls = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const list = jsonList(s);
  return (list ? list.map(String) : [s]).filter(Boolean).map((u) => entry(t('import.label.additionalUrl', null, '追加の URL'), u, false));
};

const HIDDEN = new Set(['hidden', 'password', 'secret']);
const customFields = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const list = jsonList(s);
  if (!list) return [entry(t('import.label.custom', null, 'カスタム項目'), s, false)];
  return list.map((e) => (e && typeof e === 'object'
    ? entry(e.label ?? e.name, e.value ?? '', HIDDEN.has(String(e.type ?? '').toLowerCase()) || undefined)
    : entry('', e)));
};

export async function parse(file) {
  const { records } = readCsv(file, accepts,
    t('NordPass の CSV ではないようです（name, url, username, password と type や folder などの列が見つかりません）'));
  const warnings = [];
  let foldered = false;
  const out = collect(records, (r) => {
    const type = String(r.type ?? '').trim().toLowerCase();
    if (type === 'folder') return null;
    if (String(r.folder ?? '').trim()) foldered = true;

    const title = r.name;
    const tail = [...extraUrls(r.additional_urls), ...customFields(r.custom_fields)];
    const labelled = COLUMNS.map(([col, slot, secret]) => [
      slot ? fieldLabel(...slot) : t('import.label.address3', null, '住所3'), r[col], secret, slot?.[1],
    ]);
    const fullName = [fieldLabel('identity', 'fullName'), r.full_name, false, 'fullName'];

    const isLogin = type === 'password'
      || (!['note', 'secure_note', 'credit_card', 'identity'].includes(type)
        && !!(String(r.password ?? '').trim() || String(r.username ?? '').trim() || String(r.url ?? '').trim()));
    if (isLogin) {
      // Card / identity columns are normally empty on a login row; keep them if not.
      const extra = [...labelled, fullName]
        .filter(([, v]) => String(v ?? '').trim()).map(([l, v, s]) => entry(l, v, s));
      return {
        title,
        url: r.url,
        username: r.username,
        password: r.password,
        note: r.note,
        extra: [...extra, ...tail],
      };
    }

    const isCard = type === 'credit_card';
    const isIdentity = type === 'identity';
    const pairs = [
      [t('import.label.url', null, 'URL'), r.url, false],
      [t('import.label.username', null, 'ユーザー名'), r.username, false],
      [t('import.label.password', null, 'パスワード'), r.password, true],
      ...labelled,
      fullName, // an identity's full_name is kept as written (identity.fullName); elsewhere it is a custom field
    ];
    if (isCard || isIdentity) {
      const { fields, extra } = routeToTemplate(isCard ? 'card' : 'identity', pairs);
      return { type: isCard ? 'card' : 'identity', title, note: r.note, fields, extra: [...extra, ...tail] };
    }
    return {
      type: 'note',
      title,
      note: r.note,
      extra: [...pairs.filter(([, v]) => String(v ?? '').trim()).map(([l, v, s]) => entry(l, v, s)), ...tail],
    };
  }, warnings);
  if (foldered) warnings.push(t('フォルダーの情報は取り込まれません'));
  return out;
}
