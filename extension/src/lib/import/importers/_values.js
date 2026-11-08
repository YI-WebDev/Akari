import { typeOf } from '../../../shared/item-types.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/;
const monthNumber = (tok) => {
  const t = tok.toLowerCase();
  return t.length >= 3 && /^[a-z]+$/.test(t) ? MONTHS.findIndex((m) => m.startsWith(t)) + 1 : 0;
};
const EPOCH_SECONDS_BELOW = 1e11;
const TIME_OF_DAY = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[ap]\.?m\.?)?/g;
const TIME_ZONE = /(?:\b(?:gmt|utc)\b|[+-]\d{2}:?\d{2}$)/g;
const EPOCH_DIGITS = /^-?\d{9,13}(\.\d+)?$/;
const JAPANESE_YMD = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日?)?(?:\s*[(（].*|\s+\S.*)?$/;
const YEAR_FIRST_SEPARATED = /^(\d{4})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{1,2}))?(?:[T\s].*)?$/;
const YYYYMMDD = /^(\d{4})(\d{2})(\d{2})$/;
const SIX_DIGITS = /^(\d{2})(\d{2})(\d{2})$/;
const MMYY = /^(\d{2})(\d{2})$/;
const MONTH_THEN_YEAR = /^(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})$/;
const DAY_MONTH_YEAR_SEPARATED = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const inCalendar = ({ y, m, d }) => Number.isInteger(y) && y >= 1000 && y <= 9999 && m >= 1 && m <= 12
  && (!d || (d >= 1 && d <= daysIn(y, m)));

function fromEpoch(n) {
  if (!Number.isFinite(n) || n === 0) return null;
  const date = new Date(Math.abs(n) < EPOCH_SECONDS_BELOW ? n * 1000 : n);
  if (!Number.isFinite(date.getTime())) return null;
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function englishParts(s) {
  const bare = s.toLowerCase()
    .replace(TIME_OF_DAY, ' ')
    .replace(TIME_ZONE, ' ');
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

function dateParts(v) {
  if (v == null || typeof v === 'object' || typeof v === 'boolean') return null;
  const p = textParts(String(v).normalize('NFKC').trim());
  if (p && inCalendar(p)) return p;
  if (typeof v !== 'number') return null;
  const e = fromEpoch(v);
  return e && inCalendar(e) ? e : null;
}

const plausibleYear = (p) => inCalendar(p) && p.y >= 1900 && p.y <= 2199;

function textParts(s) {
  if (!s || s.length > 64) return null;
  if (EPOCH_DIGITS.test(s)) return fromEpoch(Number(s));
  let m;
  let p = null;
  if ((m = JAPANESE_YMD.exec(s))
    || (m = YEAR_FIRST_SEPARATED.exec(s))
    || (m = YYYYMMDD.exec(s))) {
    p = { y: +m[1], m: +m[2], d: m[3] ? +m[3] : 0 };
  } else if ((m = SIX_DIGITS.exec(s))) {
    p = [{ y: +(m[1] + m[2]), m: +m[3], d: 0 }, { y: +(m[2] + m[3]), m: +m[1], d: 0 }].find(plausibleYear) || null;
  } else if ((m = MMYY.exec(s))) {
    p = { y: fullYear(+m[2]), m: +m[1], d: 0 };
  } else if ((m = MONTH_THEN_YEAR.exec(s))) {
    p = { y: fullYear(+m[2]), m: +m[1], d: 0 };
  } else if ((m = DAY_MONTH_YEAR_SEPARATED.exec(s))) {
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) p = { y: +m[3], m: b, d: a };
    else if (b > 12 || a === b) p = { y: +m[3], m: a, d: b };
  } else if (/[a-z]{3}/i.test(s)) {
    p = englishParts(s);
  }
  return p;
}

export function toDate(v) {
  const p = dateParts(v);
  return p?.d ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : '';
}

export function toMonth(v) {
  const p = dateParts(v);
  return p ? `${pad(p.y, 4)}-${pad(p.m)}` : '';
}

export function monthOf(month, year) {
  const [mo, y] = [String(month ?? '').trim(), String(year ?? '').trim()];
  return mo && y ? toMonth(`${mo}/${y}`) : '';
}

export const normKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const WIFI_OPTIONS = typeOf('wifi').fields.find((fd) => fd.key === 'security').options;

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
