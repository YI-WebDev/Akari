// Display helpers: list grouping, Japanese relative dates, tile letters/colours.

import { hostnameOf } from '../../shared/domain.js';

const DAY = 86400000;

export const GROUPS = ['今日', '今週', '先週', '先月', 'それ以前', '未使用'];

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Index into GROUPS for a lastUsedAt timestamp (rolling weeks, like the design). */
export function groupIndex(ts, now = Date.now()) {
  if (!ts) return 5;
  if (ts >= startOfDay(now)) return 0;
  const age = now - ts;
  if (age < 7 * DAY) return 1;
  if (age < 14 * DAY) return 2;
  if (age < 61 * DAY) return 3;
  return 4;
}

export function relTime(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  const today = startOfDay(now);
  if (ts >= today) return `${Math.floor(s / 3600)}時間前`;
  const days = Math.round((today - startOfDay(ts)) / DAY);
  if (days <= 1) return '昨日';
  if (days < 14) return `${days}日前`;
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  if (days < 365) return `${Math.floor(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
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

/** Tile letter: the meaningful label of a domain-like title ("accounts.google.com" → G), else its first character. */
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

/** "www.github.com" → "github.com" for display. */
export function siteOf(url) {
  return hostnameOf(url).replace(/^www\./, '');
}

/** True when the string starts with "scheme://". "localhost:3000" and "example.com:8443/x" do not. */
export const hasScheme = (s) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || ''));

/** "example.com:8443/login" → "https://example.com:8443/login"; strings with a scheme are kept. */
export const withScheme = (s) => {
  const t = String(s || '').trim();
  return !t || hasScheme(t) ? t : 'https://' + t;
};

/** Only http(s) URLs may become links. Bare hosts (with or without :port) get https://. */
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

/* Search normalisation: NFKC + lower-case. normMap keeps, for every code unit of the
   normalised string, the original [start, end) it came from, so highlights never drift.
   A character whose NFKC form starts with a combining mark (e.g. halfwidth ﾞ) is
   normalised together with the character before it. */
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

/** [start, end) of the first match of a normalised query in the original text, or null. */
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
