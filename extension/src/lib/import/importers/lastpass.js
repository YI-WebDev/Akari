// LastPass CSV: url,username,password,totp,extra,name,grouping,fav
// - secure notes have url "http://sn"; structured ones ("NoteType:Credit Card" …) keep
//   their "Key:Value" lines in `extra`, which become the Akari note as-is
// - `extra` of a normal login is its note, fav is "1" for favourites

import { isTruthy } from '../model.js';
import { appendFields, collect, fits, otpOf, readCsv } from './_csv.js';

const SHAPE = { all: ['url', 'username', 'password', 'name'], any: ['extra', 'grouping', 'fav'] };
export const accepts = (headers) => fits(headers, SHAPE);

const SECURE_NOTE_URL = 'http://sn';

/**
 * Structured notes: "NoteType:X", then "Key:Value" lines, then optionally a "Notes:" line
 * that starts free text running to the end. Rendered as "Key: Value" lines. The Language
 * line is dropped; anything that is not a Key:Value line is kept as-is.
 */
function noteFromExtra(extra) {
  const text = String(extra ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (!/^NoteType:/i.test(lines[0])) return text;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^:]+):(.*)$/.exec(lines[i]);
    if (m && m[1].trim().toLowerCase() === 'notes') {
      out.push('Notes: ' + [m[2].trim(), ...lines.slice(i + 1)].join('\n').trim());
      break;
    }
    if (!m) { if (lines[i].trim()) out.push(lines[i]); continue; }
    if (m[1].trim().toLowerCase() === 'language' || !m[2].trim()) continue;
    out.push(`${m[1].trim()}: ${m[2].trim()}`);
  }
  return out.join('\n');
}

export async function parse(file) {
  const { records } = readCsv(file, 'LastPass', accepts, 'url, username, password, name, extra の');
  const warnings = [];
  let foldered = false;
  const out = collect(records, (r) => {
    const group = String(r.grouping ?? '').trim();
    if (group && group !== '(none)') foldered = true;
    const url = String(r.url ?? '').trim();
    if (url.toLowerCase() === SECURE_NOTE_URL) {
      return { type: 'note', title: r.name, note: noteFromExtra(r.extra), fav: isTruthy(r.fav) };
    }
    const { totp, fields } = otpOf(r.totp);
    return {
      title: r.name,
      url: url === 'http://' ? '' : url,
      username: r.username,
      password: r.password,
      note: appendFields(r.extra, fields),
      totp,
      fav: isTruthy(r.fav),
    };
  }, warnings);
  if (foldered) warnings.push('フォルダー（グループ）の情報は取り込まれません');
  return out;
}
