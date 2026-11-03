// Internal helpers shared by the CSV importers (apple, chromium, firefox, lastpass,
// nordpass, roboform, generic). Not an importer itself.

import { csvToObjects } from '../csv.js';
import { ImportError, bytesToText, fieldsToNote, makeImported, parseOtp } from '../model.js';

const has = (headers, c) => (Array.isArray(c) ? c.some((x) => headers.includes(x)) : headers.includes(c));

/**
 * Does a (lower-cased) header row look like this format?
 * `all`: columns that must exist (an array entry = any one of those names).
 * `any`: when given, at least one of these signature columns must exist too.
 */
export function fits(headers, { all = [], any = [] }) {
  return all.every((c) => has(headers, c)) && (!any.length || any.some((c) => has(headers, c)));
}

/** Decode + parse a CSV export; throws INVALID_FORMAT unless `accepts(headers)`. */
export function readCsv(file, label, accepts, hint) {
  const { headers, records } = csvToObjects(bytesToText(file.bytes));
  if (!accepts(headers)) {
    throw new ImportError('INVALID_FORMAT', `${label} の CSV ではないようです（${hint}列が見つかりません）`);
  }
  return { headers, records };
}

/**
 * Turn records into `{ items, skipped, warnings }`. `toItem(rec)` returns a partial
 * ImportedItem, or null for rows that are not items at all (folder rows). Blank
 * spreadsheet rows are ignored; rows with nothing worth keeping count as skipped.
 */
export function collect(records, toItem, warnings = []) {
  const items = [];
  let skipped = 0;
  for (const rec of records) {
    if (Object.values(rec).every((v) => !String(v).trim())) continue;
    const raw = toItem(rec);
    if (!raw) continue;
    const it = makeImported(raw);
    if (it) items.push(it); else skipped++;
  }
  return { items, skipped, warnings };
}

/** Note body followed by "label: value" lines (empty values dropped). */
export function appendFields(note, fields) {
  return [String(note ?? '').trim(), fieldsToNote(fields)].filter(Boolean).join('\n\n');
}

/** TOTP column → { totp, fields }; values we cannot use (steam://, …) go to the note instead of being lost. */
export function otpOf(value) {
  const v = String(value ?? '').trim();
  const totp = parseOtp(v);
  return { totp, fields: v && !totp ? [['ワンタイムパスワード', v]] : [] };
}
