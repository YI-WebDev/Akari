import PSL from './psl-data.js';

const EXACT = new Set();
const WILDCARD = new Set();
const EXCEPTION = new Set();
for (const rule of PSL.split('\n')) {
  if (rule.startsWith('!')) EXCEPTION.add(rule.slice(1));
  else if (rule.startsWith('*.')) WILDCARD.add(rule.slice(2));
  else EXACT.add(rule);
}

const IPV4_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;

function suffixLength(labels) {
  for (let i = 0; i < labels.length; i++) {
    const name = labels.slice(i).join('.');
    if (EXCEPTION.has(name)) return labels.length - i - 1;
    if (EXACT.has(name)) return labels.length - i;
    if (i + 1 < labels.length && WILDCARD.has(labels.slice(i + 1).join('.'))) return labels.length - i;
  }
  return 0;
}

export function hostnameOf(url) {
  if (!url) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export const isIpAddress = (host) => IPV4_ADDRESS.test(host) || host.includes(':') || host.startsWith('[');

export function isPublicSuffix(domain) {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (d === 'localhost') return false;
  const labels = d.split('.');
  return labels.length === 1 || suffixLength(labels) === labels.length;
}

export function registrableDomain(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  if (isIpAddress(h) || h === 'localhost') return h;
  const labels = h.split('.');
  const suffixLabels = suffixLength(labels);
  if (suffixLabels === 0 || suffixLabels >= labels.length) return null;
  return labels.slice(-(suffixLabels + 1)).join('.');
}

export function sameSite(itemUrl, tabUrl) {
  const a = hostnameOf(itemUrl);
  const b = hostnameOf(tabUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  if (isIpAddress(a) || isIpAddress(b)) return false;
  const ra = registrableDomain(a);
  return !!ra && ra === registrableDomain(b);
}

export function isSecureOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export function isValidRpId(rpId, originUrl) {
  const host = hostnameOf(originUrl);
  const rp = String(rpId || '').toLowerCase();
  if (!host || !rp) return false;
  if (rp === host) return !isPublicSuffix(rp);
  if (isIpAddress(host)) return false;
  if (!host.endsWith('.' + rp)) return false;
  return registrableDomain(rp) !== null;
}
