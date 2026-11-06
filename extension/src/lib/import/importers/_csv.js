// Internal helpers shared by the CSV importers (apple, chromium, firefox, lastpass,
// nordpass, roboform, generic). Not an importer itself.

import { csvToObjects } from '../csv.js';
import { ImportError, bytesToText, makeImported, parseOtp } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { typeOf } from '../../../shared/item-types.js';
import { normKey, toDate, toMonth, wifiSecurity } from './_values.js';

const has = (headers, c) => (Array.isArray(c) ? c.some((x) => headers.includes(x)) : headers.includes(c));

/**
 * Does a (lower-cased) header row look like this format?
 * `all`: columns that must exist (an array entry = any one of those names).
 * `any`: when given, at least one of these signature columns must exist too.
 */
export function fits(headers, { all = [], any = [] }) {
  return all.every((c) => has(headers, c)) && (!any.length || any.some((c) => has(headers, c)));
}

/**
 * Decode + parse a CSV export; throws INVALID_FORMAT with `notThis` (the whole, translated
 * sentence) unless `accepts(headers)`.
 */
export function readCsv(file, accepts, notThis) {
  const { headers, rawHeaders, records } = csvToObjects(bytesToText(file.bytes));
  if (!accepts(headers)) {
    throw new ImportError('INVALID_FORMAT', notThis);
  }
  return { headers, rawHeaders, records };
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

// ---- secret-looking labels ----

const SECRET_WORD = new RegExp([
  String.raw`\bpass(?:word|code|phrase|wd)?\b`, String.raw`\bpin(?:code)?\b`, 'secret', 'token', String.raw`\bkey\b`,
  String.raw`\b(?:api|access|private|secret|license|licence|product)key\b`, String.raw`\bc(?:vv|vc)2?\b`,
  String.raw`\bssn\b`, 'credential', '暗証', 'パスワード', 'パスコード', 'パスフレーズ', '秘密', 'シークレット', 'トークン',
  'キー', '合言葉',
].join('|'));
const CODE_WORD = /\bcode\b|コード/;
const NOT_CODE = /zip|postal|post code|area|country|language|currency|郵便|市外|国/;
const NUMBER_WORD = /\bnumber\b|\bnum\b|番号/;
const NOT_NUMBER = /number of|phone|\btel\b|telephone|mobile|\bfax\b|zip|postal|電話|携帯|郵便|fax/;

/**
 * Does a field label name something secret (password, PIN, code, key, token, …)? With
 * `numbers`, "… number" / "…番号" labels count too (LastPass notes, where such labels are
 * card, account and licence numbers). Guessing wrong on the safe side only masks a value.
 */
export function isSecretLabel(label, { numbers = false } = {}) {
  const l = String(label ?? '').normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase();
  if (/public|公開/.test(l)) return false;
  if (SECRET_WORD.test(l) || (CODE_WORD.test(l) && !NOT_CODE.test(l))) return true;
  return numbers && NUMBER_WORD.test(l) && !NOT_NUMBER.test(l);
}

/** One custom-field entry. `secret` defaults to a guess from the label; no label → "項目". */
export const entry = (label, value, secret) => ({
  label: String(label ?? '').trim() || t('import.label.field', null, '項目'),
  value: String(value ?? ''),
  secret: secret ?? isSecretLabel(label),
});

/** TOTP column → { totp, extra }; values we cannot use (steam://, …) are kept as a secret custom field. */
export function otpOf(value) {
  const v = String(value ?? '').trim();
  const totp = parseOtp(v);
  return { totp, extra: v && !totp ? [entry(t('import.label.otp', null, 'ワンタイムパスワード'), v, true)] : [] };
}

// ---- labelled values → template fields + custom fields ----

/** A value fitted to the field's kind (selects → option id), or null when it does not fit. */
function convert(fd, value) {
  const v = String(value ?? '');
  switch (fd.kind) {
    case 'month': return toMonth(v) || null;
    case 'date': return toDate(v) || null;
    case 'number': { const d = v.replace(/[\s,]/g, ''); return /^\d+$/.test(d) ? d : null; }
    case 'select': {
      if (fd.key === 'security') return wifiSecurity(v, fd.options) || null;
      const n = normKey(v);
      return fd.options.find((o) => normKey(o.id) === n || normKey(o.label) === n)?.id ?? null;
    }
    default: return v;
  }
}

/**
 * Sort labelled values onto a type's template; whatever fits no key becomes a custom field.
 * pairs: [label, value, secret?, key?] — `secret` (when given) is used for leftovers instead of
 *   the guess; `key` names the template key the value belongs to, whatever its label says.
 * aliases: { [templateKey]: [label, …] } — other names a key goes by. The key itself and its
 *   Japanese label always count, and come first; the first usable value per key wins.
 * Values that do not fit their key (an unreadable date, a non-numeric port) stay custom fields as-is.
 * @returns {{ fields: Record<string, string>, extra: {label: string, value: string, secret: boolean}[] }}
 */
export function routeToTemplate(type, pairs, aliases = {}, { numbers = false } = {}) {
  const byName = new Map(); // normalised label → indexes into pairs
  pairs.forEach(([label, value, , key], i) => {
    if (!String(value ?? '').trim()) return;
    for (const n of new Set([normKey(label), key && normKey(key)])) {
      if (!n) continue;
      if (byName.has(n)) byName.get(n).push(i); else byName.set(n, [i]);
    }
  });
  const used = new Set();
  const fields = {};
  for (const fd of typeOf(type).fields) {
    const names = [fd.key, fd.label, ...(aliases[fd.key] || [])].map(normKey);
    claim: for (const n of names) {
      for (const i of byName.get(n) || []) {
        if (used.has(i)) continue;
        const v = convert(fd, pairs[i][1]);
        if (v == null || !v.trim()) continue;
        fields[fd.key] = v;
        used.add(i);
        break claim;
      }
    }
  }
  const extra = [];
  pairs.forEach(([label, value, secret], i) => {
    if (used.has(i) || !String(value ?? '').trim()) return;
    extra.push(entry(label, value, secret ?? isSecretLabel(label, { numbers })));
  });
  return { fields, extra };
}
