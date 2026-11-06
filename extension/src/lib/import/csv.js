// RFC 4180 CSV parser: quoted fields, "" escapes, newlines inside quotes, CRLF/LF,
// UTF-8 BOM. The delimiter (, ; tab) is guessed from the header line.

import { ImportError } from './model.js';
import { t } from '../../shared/i18n.js';

// Real exports are far smaller; the caps keep crafted files from freezing the popup.
export const MAX_COLUMNS = 256;
export const MAX_ROWS = 50000;

export function detectDelimiter(text) {
  const nl = text.search(/\r?\n/);
  const head = nl < 0 ? text : text.slice(0, nl);
  let best = ',', n = 0;
  for (const d of [',', ';', '\t']) {
    const c = head.split(d).length;
    if (c > n) { best = d; n = c; }
  }
  return best;
}

/** @returns {string[][]} rows of fields; fully empty lines are dropped. */
export function parseCsv(input, delimiter = detectDelimiter(input)) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') {
      if (rows.length >= MAX_ROWS) throw new ImportError('UNSUPPORTED', t('CSV の行が多すぎます（{max} 行まで）', { max: MAX_ROWS.toLocaleString() }));
      rows.push(row);
    }
    row = [];
  };
  const endField = () => {
    if (row.length >= MAX_COLUMNS) throw new ImportError('UNSUPPORTED', t('CSV の列が多すぎます（{max} 列まで）', { max: MAX_COLUMNS }));
    row.push(field);
    field = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * Header row → objects keyed by lower-cased, trimmed header names.
 * `rawHeaders[i]` keeps the original spelling of `headers[i]` for display (e.g. extra-field labels).
 * @returns {{ headers: string[], rawHeaders: string[], records: Record<string, string>[] }}
 */
export function csvToObjects(input, delimiter) {
  const rows = parseCsv(input, delimiter);
  if (!rows.length) return { headers: [], rawHeaders: [], records: [] };
  const rawHeaders = rows[0].map((h) => h.trim());
  const headers = rawHeaders.map((h) => h.toLowerCase());
  const records = rows.slice(1).map((r) => {
    const o = {};
    // defineProperty keeps headers like "__proto__" or "constructor" as plain own data.
    headers.forEach((h, k) => {
      if (h && !Object.hasOwn(o, h)) {
        Object.defineProperty(o, h, { value: r[k] ?? '', enumerable: true, writable: true, configurable: true });
      }
    });
    return o;
  });
  return { headers, rawHeaders, records };
}

/** First non-empty value among candidate column names. */
export function pick(rec, ...names) {
  for (const n of names) {
    const v = rec[n];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

const needsQuote = /[",\r\n]|^\s|\s$/;

/** Serialize rows; every field quoted when needed, CRLF line endings (what spreadsheet apps expect). */
export function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return needsQuote.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n') + '\r\n';
}
