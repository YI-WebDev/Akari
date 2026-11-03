// RoboForm CSV: Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2
// RfFieldsV2 is one comma-separated list of 5-part groups: key,?,?,type,value ("pwd" = hidden
// value, "-no-name-" = unnamed). "User ID$" / "Password$" / "TOTP KEY$" are the login's own
// fields; the rest are extra fields and end up in the note. Rows without url or credentials
// (Safenotes, Identities) become secure notes.

import { pick } from '../csv.js';
import { appendFields, collect, fits, otpOf, readCsv } from './_csv.js';
import { fieldsToNote } from '../model.js';

const SHAPE = { all: ['name'], any: ['pwd', 'rffieldsv2', 'rf_fields', 'matchurl'] };
export const accepts = (headers) => fits(headers, SHAPE);

const labelOf = (key) => (!key || key === '-no-name-' ? '項目' : key.replace(/\$$/, ''));

/** @returns {{ fields: [string, string][], rest: string }} */
function parseRfFields(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { fields: [], rest: '' };
  const parts = s.split(',');
  const fields = [];
  let i = 0;
  for (; i + 5 <= parts.length; i += 5) {
    const key = parts[i].trim();
    fields.push([key, parts[i + 4]]);
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
      ...(rest ? [['RoboForm の項目（未解析）', rest]] : []),
      ...(String(r.rf_fields ?? '').trim() ? [['RoboForm の項目', r.rf_fields]] : []),
    ];

    if (!url && !login && !pwd) {
      const labelled = fields.map(([k, v]) => [labelOf(k), v]);
      return { type: 'note', title: r.name, note: fieldsToNote([...labelled, ...unparsed], r.note) };
    }

    let username = login;
    let password = pwd;
    let totp = null;
    const extra = [];
    for (const [key, value] of fields) {
      const k = key.toLowerCase();
      if (k === 'totp key$') {
        const o = otpOf(value);
        totp = totp || o.totp;
        extra.push(...o.fields);
      } else if (k === 'user id$' && (!username || value === username)) {
        username = username || value;
      } else if (k === 'password$' && (!password || value === password)) {
        password = password || value;
      } else {
        extra.push([labelOf(key), value]);
      }
    }
    return {
      title: r.name,
      url: url || pick(r, 'matchurl'),
      username,
      password,
      note: appendFields(r.note, [...extra, ...unparsed]),
      totp,
    };
  }, warnings);
  if (foldered) warnings.push('フォルダーの情報は取り込まれません');
  return out;
}
