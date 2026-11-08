import { csvToObjects } from '../csv.js';
import { ImportError, bytesToText, makeImported, parseOtp } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { typeOf } from '../../../shared/item-types.js';
import { normKey, toDate, toMonth, wifiSecurity } from './_values.js';

const hasColumn = (headers, c) => (Array.isArray(c) ? c.some((x) => headers.includes(x)) : headers.includes(c));

export function fits(headers, { all = [], any = [] }) {
  return all.every((c) => hasColumn(headers, c)) && (!any.length || any.some((c) => hasColumn(headers, c)));
}

export function readCsv(file, accepts, notThis) {
  const { headers, rawHeaders, records } = csvToObjects(bytesToText(file.bytes));
  if (!accepts(headers)) {
    throw new ImportError('INVALID_FORMAT', notThis);
  }
  return { headers, rawHeaders, records };
}

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

export function isSecretLabel(label, { numbers = false } = {}) {
  const l = String(label ?? '').normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase();
  if (/public|公開/.test(l)) return false;
  if (SECRET_WORD.test(l) || (CODE_WORD.test(l) && !NOT_CODE.test(l))) return true;
  return numbers && NUMBER_WORD.test(l) && !NOT_NUMBER.test(l);
}

export const entry = (label, value, secret) => ({
  label: String(label ?? '').trim() || t('import.label.field', null, '項目'),
  value: String(value ?? ''),
  secret: secret ?? isSecretLabel(label),
});

export function otpOf(value) {
  const v = String(value ?? '').trim();
  const totp = parseOtp(v);
  return { totp, extra: v && !totp ? [entry(t('import.label.otp', null, 'ワンタイムパスワード'), v, true)] : [] };
}

function convertForField(fd, value) {
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

export function routeToTemplate(type, pairs, aliases = {}, { numbers = false } = {}) {
  const pairIndexesByName = new Map();
  pairs.forEach(([label, value, , key], i) => {
    if (!String(value ?? '').trim()) return;
    for (const n of new Set([normKey(label), key && normKey(key)])) {
      if (!n) continue;
      if (pairIndexesByName.has(n)) pairIndexesByName.get(n).push(i); else pairIndexesByName.set(n, [i]);
    }
  });
  const used = new Set();
  const fields = {};
  for (const fd of typeOf(type).fields) {
    const names = [fd.key, fd.label, ...(aliases[fd.key] || [])].map(normKey);
    claim: for (const n of names) {
      for (const i of pairIndexesByName.get(n) || []) {
        if (used.has(i)) continue;
        const v = convertForField(fd, pairs[i][1]);
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
