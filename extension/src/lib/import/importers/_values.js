// Value normalisation shared by every importer, CSV and structured alike: dates, card expiry
// months and the Wi-Fi security option. One parser, so the same text gives the same result
// whichever export it came from. Each function returns '' when it cannot read the value with
// confidence; callers then keep the raw text (as a custom field) instead of guessing.

import { typeOf } from '../../../shared/item-types.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/;
const monthNumber = (tok) => {
  const t = tok.toLowerCase();
  return t.length >= 3 && /^[a-z]+$/.test(t) ? MONTHS.findIndex((m) => m.startsWith(t)) + 1 : 0;
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const inCalendar = ({ y, m, d }) => Number.isInteger(y) && y >= 1000 && y <= 9999 && m >= 1 && m <= 12
  && (!d || (d >= 1 && d <= daysIn(y, m)));

/** Unix time in seconds or milliseconds (negative = before 1970) → UTC parts, or null. */
function fromEpoch(n) {
  if (!Number.isFinite(n) || n === 0) return null;
  const date = new Date(Math.abs(n) < 1e11 ? n * 1000 : n);
  if (!Number.isFinite(date.getTime())) return null;
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** "January 15, 1990", "15 Jan 1990", "Sat, 01 Apr 2022 10:00:00 GMT", "December,2030" → parts, or null. */
function englishParts(s) {
  const bare = s.toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[ap]\.?m\.?)?/g, ' ') // a time of day
    .replace(/(?:\b(?:gmt|utc)\b|[+-]\d{2}:?\d{2}$)/g, ' '); // a time zone
  const tokens = bare.split(/[\s,./-]+/).filter((t) => t && !WEEKDAYS.test(t));
  const mi = tokens.findIndex((t) => monthNumber(t));
  if (mi < 0 || tokens.length > 3) return null;
  const nums = tokens.filter((_, i) => i !== mi);
  if (!nums.every((t) => /^\d+$/.test(t))) return null;
  const year = nums.find((t) => t.length === 4);
  const day = nums.find((t) => t.length <= 2);
  if (!year || nums.length !== (day ? 2 : 1)) return null;
  return { y: +year, m: monthNumber(tokens[mi]), d: day ? +day : 0 };
}

/**
 * Year / month / day (d = 0 when there is no day) of a date written any of the common ways,
 * or null when unsure. Accepted:
 * unix seconds / ms (9–13 digits), YYYY-M[-D] (also / . and a trailing time), YYYYMMDD,
 * YYYYMM or MMYYYY (a year 1900–2199), MMYY, YYYY年M月[D日] (also with a weekday after it),
 * M/YYYY and M/YY, D/M/YYYY or M/D/YYYY when only one reading is possible, English month names.
 * A number is read like its digits first, then as unix time (1Password and Proton store dates
 * near 1970 as small numbers).
 */
function dateParts(v) {
  if (v == null || typeof v === 'object' || typeof v === 'boolean') return null;
  const p = textParts(String(v).normalize('NFKC').trim());
  if (p && inCalendar(p)) return p;
  if (typeof v !== 'number') return null;
  const e = fromEpoch(v);
  return e && inCalendar(e) ? e : null;
}

// Digit-only shapes that need a guess between two readings accept only plausible years.
const plausibleYear = (p) => inCalendar(p) && p.y >= 1900 && p.y <= 2199;

function textParts(s) {
  if (!s || s.length > 64) return null;
  if (/^-?\d{9,13}(\.\d+)?$/.test(s)) return fromEpoch(Number(s));
  let m;
  let p = null;
  if ((m = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?(?:\s*[(（].*|\s+\S.*)?$/.exec(s)) // 2023年1月15日(日)
    || (m = /^(\d{4})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{1,2}))?(?:[T\s].*)?$/.exec(s))
    || (m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    p = { y: +m[1], m: +m[2], d: m[3] ? +m[3] : 0 };
  } else if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(s))) { // 202812 (1Password monthYear) or 122029
    p = [{ y: +(m[1] + m[2]), m: +m[3], d: 0 }, { y: +(m[2] + m[3]), m: +m[1], d: 0 }].find(plausibleYear) || null;
  } else if ((m = /^(\d{2})(\d{2})$/.exec(s))) { // MMYY: 0528
    p = { y: fullYear(+m[2]), m: +m[1], d: 0 };
  } else if ((m = /^(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})$/.exec(s))) { // 12/2030, 12/30
    p = { y: fullYear(+m[2]), m: +m[1], d: 0 };
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { // 31/12/2030 or 12/31/2030; 01/02/2030 is ambiguous
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) p = { y: +m[3], m: b, d: a };
    else if (b > 12 || a === b) p = { y: +m[3], m: a, d: b };
  } else if (/[a-z]{3}/i.test(s)) {
    p = englishParts(s);
  }
  return p;
}

/** → 'YYYY-MM-DD', or '' (a month without a day is not a date). */
export function toDate(v) {
  const p = dateParts(v);
  return p?.d ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : '';
}

/** → 'YYYY-MM' (a day, if present, is dropped), or ''. */
export function toMonth(v) {
  const p = dateParts(v);
  return p ? `${pad(p.y, 4)}-${pad(p.m)}` : '';
}

/** Card expiry given as separate month and year values. */
export function monthOf(month, year) {
  const [mo, y] = [String(month ?? '').trim(), String(year ?? '').trim()];
  return mo && y ? toMonth(`${mo}/${y}`) : '';
}

/** Label comparison key: NFKC, lower case, letters and digits only. */
export const normKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const WIFI_OPTIONS = typeOf('wifi').fields.find((fd) => fd.key === 'security').options;

/**
 * "WPA2-Personal", "WPA2 PSK (AES)", "WPA/WPA2", "Open", "なし" … → a wifi.security option id
 * (of `options`, the template's by default), or ''.
 */
export function wifiSecurity(v, options = WIFI_OPTIONS) {
  const n = normKey(v);
  if (!n) return '';
  const exact = options.find((o) => normKey(o.id) === n || normKey(o.label) === n);
  if (exact) return exact.id;
  const id = (x) => options.find((o) => o.id === x)?.id ?? '';
  if (/wpa3|sae/.test(n)) return id('wpa3');
  if (/wpa2|rsn/.test(n)) return id('wpa2');
  if (/wpa/.test(n)) return id('wpa');
  if (/wep/.test(n)) return id('wep');
  if (/^(open|none|off|nosecurity|noauth\w*|unsecured|オープン|無し|なし|セキュリティなし)$/.test(n)) return id('none');
  return '';
}
