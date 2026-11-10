import { DAY_MS } from '../../shared/time.js';
import { hostnameOf } from '../../shared/domain.js';
import { t } from '../../shared/i18n.js';


export const GROUPS = ['今日', '今週', '先週', '先月', 'それ以前', '未使用'];
export const groupName = (g) => t(GROUPS[g]);

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupIndex(ts, now = Date.now()) {
  const [TODAY, THIS_WEEK, LAST_WEEK, LAST_MONTH, OLDER, NEVER_USED] = GROUPS.keys();
  if (!ts) return NEVER_USED;
  if (ts >= startOfDay(now)) return TODAY;
  const age = now - ts;
  if (age < 7 * DAY_MS) return THIS_WEEK;
  if (age < 14 * DAY_MS) return LAST_WEEK;
  if (age < 61 * DAY_MS) return LAST_MONTH;
  return OLDER;
}

export function relTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return t('たった今');
  if (s < 3600) return t('{n}分前', { n: Math.floor(s / 60) });
  const today = startOfDay(now);
  if (ts >= today) return t('{n}時間前', { n: Math.floor(s / 3600) });
  const days = Math.round((today - startOfDay(ts)) / DAY_MS);
  if (days <= 1) return t('昨日');
  if (days < 14) return t('{n}日前', { n: days });
  if (days < 30) return t('{n}週間前', { n: Math.floor(days / 7) });
  if (days < 365) return t('{n}か月前', { n: Math.floor(days / 30) });
  return t('{n}年前', { n: Math.floor(days / 365) });
}

export function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

export function yyyymmdd(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

const SKIP_LABELS = new Set(['www', 'accounts', 'account', 'jp', 'en', 'm', 'login', 'app', 'my', 'secure', 'signin', 'auth', 'id', 'mail']);

export function letterOf(title) {
  const t = String(title || '').trim().replace(/^@/, '');
  if (!t) return '?';
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) {
    const p = t.split('.');
    const core = p.length > 2 && (SKIP_LABELS.has(p[0].toLowerCase()) || p[0].includes('-')) ? p[1] : p[0];
    return (core[0] || '?').toUpperCase();
  }
  return Array.from(t)[0].toUpperCase();
}

export function hueOf(item) {
  if (Number.isFinite(item?.hue)) return item.hue;
  let h = 0;
  for (const c of String(item?.title || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 360;
}

export const vaultColor = (hue) => `oklch(var(--vault-l) var(--vault-c) ${hue})`;

export function siteOf(url) {
  return hostnameOf(url).replace(/^www\./, '');
}

export const hasScheme = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || ''));

export const withScheme = (s) => {
  const t = String(s || '').trim();
  return !t || hasScheme(t) ? t : 'https://' + t;
};

export function safeHttpUrl(url) {
  const s = withScheme(url);
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.href : '';
  } catch {
    return '';
  }
}

export const normQuery = (q) => String(q || '').normalize('NFKC').toLowerCase().trim();

export function normMap(text) {
  const s = String(text || '');
  const clusters = [];
  let pos = 0;
  for (const ch of s) {
    if (clusters.length && /^\p{M}/u.test(ch.normalize('NFKC'))) clusters[clusters.length - 1].text += ch;
    else clusters.push({ start: pos, text: ch });
    pos += ch.length;
  }
  let norm = '';
  const starts = [];
  const ends = [];
  for (const c of clusters) {
    const n = c.text.normalize('NFKC').toLowerCase();
    for (let k = 0; k < n.length; k++) {
      starts.push(c.start);
      ends.push(c.start + c.text.length);
    }
    norm += n;
  }
  return { norm, starts, ends };
}

export function matchRange(map, q) {
  if (!q) return null;
  const i = map.norm.indexOf(q);
  if (i < 0) return null;
  return [map.starts[i], map.ends[i + q.length - 1]];
}

export function formatCode(code) {
  const c = String(code || '');
  if (c.length === 6) return c.slice(0, 3) + ' ' + c.slice(3);
  if (c.length === 8) return c.slice(0, 4) + ' ' + c.slice(4);
  return c;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function formatIsoDate(value, kind = 'date', { fullYear = false } = {}) {
  const v = String(value || '');
  let m;
  if (kind === 'month' && (m = /^(\d{4})-(\d{2})$/.exec(v))) return `${m[2]}/${fullYear ? m[1] : m[1].slice(2)}`;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) return `${m[1]}/${m[2]}/${m[3]}`;
  return v;
}

const nfkc = (s) => String(s ?? '').normalize('NFKC').trim();

export function parseDateInput(s) {
  const v = nfkc(s);
  if (!v) return '';
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(v) || /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1000 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

export function parseMonthInput(s) {
  const v = nfkc(s);
  if (!v) return '';
  let m;
  let y;
  let mo;
  if ((m = /^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/.exec(v))) { mo = +m[1]; y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; }
  else if ((m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(v))) { y = +m[1]; mo = +m[2]; }
  else if ((m = /^(\d{2})(\d{2})$/.exec(v))) { mo = +m[1]; y = 2000 + +m[2]; }
  else return null;
  if (mo < 1 || mo > 12 || y < 1000 || y > 9999) return null;
  return `${y}-${pad2(mo)}`;
}

export function daysUntil(value, now = Date.now()) {
  const v = String(value || '');
  let m;
  let end;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) end = new Date(+m[1], +m[2] - 1, +m[3]);
  else if ((m = /^(\d{4})-(\d{2})$/.exec(v))) end = new Date(+m[1], +m[2], 0);
  else return null;
  return Math.round((end.getTime() - startOfDay(now)) / DAY_MS);
}

export const digitsOnly = (s) => nfkc(s).replace(/\D/g, '');

export const groupDigits = (s) => digitsOnly(s).replace(/(\d{4})(?=\d)/g, '$1 ');
