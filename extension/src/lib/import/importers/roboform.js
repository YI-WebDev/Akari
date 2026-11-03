// RoboForm CSV: Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2
// RfFieldsV2 is one comma-separated list of 5-part groups: key,?,?,type,value ("pwd" = hidden
// value, "-no-name-" = unnamed). "User ID$" / "Password$" / "TOTP KEY$" are the login's own
// fields; the rest are custom fields of the login. Rows without url or credentials are Safenotes
// (secure notes) or, when their fields include a name, e-mail, address, … , Identities (identity
// items; fields with no slot in the template become custom fields).
//
// Only "First Name$", "Last Name$" and "Email$" are confirmed identity keys (from a real export);
// the other names in IDENTITY_ALIASES are the usual RoboForm / form-autofill names.

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

const labelOf = (key) => (!key || key === '-no-name-' ? t('import.label.field', null, '項目') : key.replace(/\$$/, ''));

/** @returns {{ fields: [string, string, string][], rest: string }} [key, value, type] */
function parseRfFields(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { fields: [], rest: '' };
  const parts = s.split(',');
  const fields = [];
  let i = 0;
  for (; i + 5 <= parts.length; i += 5) {
    fields.push([parts[i].trim(), parts[i + 4], parts[i + 3].trim().toLowerCase()]);
  }
  return { fields, rest: parts.slice(i).join(',').trim() };
}

export async function parse(file) {
  const { records } = readCsv(file, 'RoboForm', accepts, 'Name, Login, Pwd, RfFieldsV2 などの');
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

    if (!url && !login && !pwd) {
      const pairs = fields.map(([k, v, t]) => [labelOf(k), v, t === 'pwd' ? true : undefined]);
      const { fields: slots, extra } = routeToTemplate('identity', pairs, IDENTITY_ALIASES);
      if (Object.keys(slots).length) {
        return { type: 'identity', title: r.name, note: r.note, fields: slots, extra: [...extra, ...unparsed] };
      }
      // Safenote (or a form we cannot place): the text stays a secure note.
      return { type: 'note', title: r.name, note: fieldsToNote(pairs, r.note), extra: unparsed };
    }

    let username = login;
    let password = pwd;
    let totp = null;
    const extra = [];
    for (const [key, value, type] of fields) {
      const k = key.toLowerCase();
      if (k === 'totp key$') {
        const o = otpOf(value);
        totp = totp || o.totp;
        extra.push(...o.extra);
      } else if (k === 'user id$' && (!username || value === username)) {
        username = username || value;
      } else if (k === 'password$' && (!password || value === password)) {
        password = password || value;
      } else {
        extra.push(entry(labelOf(key), value, type === 'pwd' ? true : undefined));
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
  if (foldered) warnings.push('フォルダーの情報は取り込まれません');
  return out;
}
