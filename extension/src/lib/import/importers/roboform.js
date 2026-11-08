import { pick } from '../csv.js';
import { fieldsToNote } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { collect, entry, fits, otpOf, readCsv, routeToTemplate } from './_csv.js';

const SHAPE = { all: ['name'], any: ['pwd', 'rffieldsv2', 'rf_fields', 'matchurl'] };
export const accepts = (headers) => fits(headers, SHAPE);

const IDENTITY_ALIASES = {
  fullName: ['Full Name'], firstName: ['First Name'], lastName: ['Last Name'], middleName: ['Middle Name'],
  email: ['Email', 'Email Address', 'E-mail'],
  phone: ['Phone', 'Mobile Phone', 'Cell Phone', 'Home Phone', 'Work Phone', 'Telephone'],
  birthDate: ['Birthday', 'Birth Date', 'Date of Birth'],
  company: ['Company', 'Company Name'], jobTitle: ['Job Title'],
  postalCode: ['Zip', 'Zip Code', 'Postal Code', 'Postcode'], country: ['Country'],
  state: ['State', 'Province', 'State/Province'], city: ['City'],
  address1: ['Address Line 1', 'Address 1', 'Address', 'Street', 'Street Address'], address2: ['Address Line 2', 'Address 2'],
  website: ['Website', 'Web Site', 'Home Page'],
};

const RF_GROUP_SIZE = 5;
const RF_KEY = 0;
const RF_TYPE = 3;
const RF_VALUE = 4;
const RF_HIDDEN_TYPE = 'pwd';
const RF_LOGIN_TOTP_KEY = 'totp key$';
const RF_LOGIN_USER_KEY = 'user id$';
const RF_LOGIN_PASSWORD_KEY = 'password$';

const labelOf = (key) => (!key || key === '-no-name-' ? t('import.label.field', null, '項目') : key.replace(/\$$/, ''));

function parseRfFields(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { fields: [], rest: '' };
  const parts = s.split(',');
  const fields = [];
  let i = 0;
  for (; i + RF_GROUP_SIZE <= parts.length; i += RF_GROUP_SIZE) {
    fields.push([parts[i + RF_KEY].trim(), parts[i + RF_VALUE], parts[i + RF_TYPE].trim().toLowerCase()]);
  }
  return { fields, rest: parts.slice(i).join(',').trim() };
}

export async function parse(file) {
  const { records } = readCsv(file, accepts,
    t('RoboForm の CSV ではないようです（Name, Login, Pwd, RfFieldsV2 などの列が見つかりません）'));
  const warnings = [];
  let foldered = false;
  const out = collect(records, (r) => {
    if (String(r.folder ?? '').trim()) foldered = true;
    const url = String(pick(r, 'url') ?? '').trim();
    const login = String(pick(r, 'login') ?? '').trim();
    const pwd = pick(r, 'pwd', 'password');
    const { fields, rest } = parseRfFields(r.rffieldsv2);
    const unparsed = [
      ...(rest ? [entry(t('import.label.roboformRaw', null, 'RoboForm の項目（未解析）'), rest, false)] : []),
      ...(String(r.rf_fields ?? '').trim() ? [entry(t('import.label.roboformFields', null, 'RoboForm の項目'), r.rf_fields, false)] : []),
    ];

    const hasNoLoginData = !url && !login && !pwd;
    if (hasNoLoginData) {
      const pairs = fields.map(([k, v, valueType]) => [labelOf(k), v, valueType === RF_HIDDEN_TYPE ? true : undefined]);
      const { fields: slots, extra } = routeToTemplate('identity', pairs, IDENTITY_ALIASES);
      if (Object.keys(slots).length) {
        return { type: 'identity', title: r.name, note: r.note, fields: slots, extra: [...extra, ...unparsed] };
      }
      return { type: 'note', title: r.name, note: fieldsToNote(pairs, r.note), extra: unparsed };
    }

    let username = login;
    let password = pwd;
    let totp = null;
    const extra = [];
    for (const [key, value, type] of fields) {
      const k = key.toLowerCase();
      if (k === RF_LOGIN_TOTP_KEY) {
        const o = otpOf(value);
        totp = totp || o.totp;
        extra.push(...o.extra);
      } else if (k === RF_LOGIN_USER_KEY && (!username || value === username)) {
        username = username || value;
      } else if (k === RF_LOGIN_PASSWORD_KEY && (!password || value === password)) {
        password = password || value;
      } else {
        extra.push(entry(labelOf(key), value, type === RF_HIDDEN_TYPE ? true : undefined));
      }
    }
    return {
      title: r.name,
      url: url || pick(r, 'matchurl'),
      username,
      password,
      note: r.note,
      extra: [...extra, ...unparsed],
      totp,
    };
  }, warnings);
  if (foldered) warnings.push(t('フォルダーの情報は取り込まれません'));
  return out;
}
