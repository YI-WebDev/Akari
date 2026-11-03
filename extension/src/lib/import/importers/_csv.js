// Internal helpers shared by the CSV importers (apple, chromium, firefox, lastpass,
// nordpass, roboform, generic). Not an importer itself.

import { csvToObjects } from '../csv.js';
import { ImportError, bytesToText, makeImported, parseOtp } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { typeOf } from '../../../shared/item-types.js';

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
  const { headers, rawHeaders, records } = csvToObjects(bytesToText(file.bytes));
  if (!accepts(headers)) {
    throw new ImportError('INVALID_FORMAT', `${label} の CSV ではないようです（${hint}列が見つかりません）`);
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

// ---- dates ----

/** Label comparison key: NFKC, lower case, letters and digits only. */
export const normKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthNumber = (tok) => {
  const t = tok.toLowerCase();
  return t.length >= 3 && /^[a-z]+$/.test(t) ? MONTHS.findIndex((m) => m.startsWith(t)) + 1 : 0;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const calendar = ({ y, m, d }) => y >= 1000 && y <= 9999 && m >= 1 && m <= 12
  && (!d || (d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate()));

/** Year / month / day (0 = absent) of a date written the common ways, or null when unsure. */
function dateParts(v) {
  const s = String(v ?? '').normalize('NFKC').trim();
  if (!s || s.length > 64) return null;
  let m = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?$/.exec(s)
    || /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T\s].*)?$/.exec(s)
    || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  let p = null;
  if (m) p = { y: +m[1], m: +m[2], d: m[3] ? +m[3] : 0 };
  else if ((m = /^(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})$/.exec(s))) p = { y: fullYear(+m[2]), m: +m[1], d: 0 }; // 12/2030, 12/30
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { // 31/12/2030 or 12/31/2030; 01/02/2030 is ambiguous
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) p = { y: +m[3], m: b, d: a };
    else if (b > 12 || a === b) p = { y: +m[3], m: a, d: b };
  } else {
    const tokens = s.split(/[\s,./-]+/).filter(Boolean);
    const mi = tokens.findIndex((t) => monthNumber(t));
    if (mi >= 0 && tokens.length <= 3) { // December,2030 · January,15,1990 · 15 January 1990
      const nums = tokens.filter((_, i) => i !== mi);
      if (nums.every((t) => /^\d+$/.test(t))) {
        const year = nums.find((t) => t.length === 4);
        const day = nums.find((t) => t.length <= 2);
        if (year && nums.length === (day ? 2 : 1)) p = { y: +year, m: monthNumber(tokens[mi]), d: day ? +day : 0 };
      }
    }
  }
  return p && calendar(p) ? p : null;
}

/** → 'YYYY-MM' (a day, if present, is dropped) or null. */
export function toMonth(v) {
  const p = dateParts(v);
  return p ? `${pad(p.y, 4)}-${pad(p.m)}` : null;
}

/** → 'YYYY-MM-DD', or null (a month without a day is not a date). */
export function toDate(v) {
  const p = dateParts(v);
  return p?.d ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : null;
}

// ---- labelled values → template fields + custom fields ----

/** "WPA2-Personal", "WPA2 PSK (AES)", "Open" … → one of the wifi.security option ids, or null. */
function wifiSecurity(options, v) {
  const n = normKey(v);
  const id = (x) => options.find((o) => o.id === x)?.id ?? null;
  const exact = options.find((o) => normKey(o.id) === n || normKey(o.label) === n);
  if (exact) return exact.id;
  if (/wpa3|sae/.test(n)) return id('wpa3');
  if (/wpa2|rsn/.test(n)) return id('wpa2');
  if (/wpa/.test(n)) return id('wpa');
  if (/wep/.test(n)) return id('wep');
  if (/^(open|none|nosecurity|noauth\w*|unsecured|オープン|無し|なし)$/.test(n)) return id('none');
  return null;
}

/** A value fitted to the field's kind (selects → option id), or null when it does not fit. */
function convert(fd, value) {
  const v = String(value ?? '');
  switch (fd.kind) {
    case 'month': return toMonth(v);
    case 'date': return toDate(v);
    case 'number': { const d = v.replace(/[\s,]/g, ''); return /^\d+$/.test(d) ? d : null; }
    case 'select': {
      if (fd.key === 'security') return wifiSecurity(fd.options, v);
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
